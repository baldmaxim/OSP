// Очередь сверки договоров с Signal (server/osp-api/src/lib/signalJobs.js, раздел 4.4 спецификации) на настоящей базе:
//   • такт берёт порцию (захват с лизингом), сопоставляет по снимку, записывает результат и подтверждает строку очереди;
//   • ошибка — договоры возвращаются с нарастающей паузой, правка во время расчёта — запись отброшена, строка остаётся;
//   • результат не зависит от разбивки на порции и групп запросов; усечённая выборка узлов — запрос по каждому договору;
//   • барьер записи и выключенная возможность пропускают такт целиком; Signal модуль не знает вообще;
//   • смена номера, объекта, сторон, ссылки и ДП сбрасывает «сверено» через очередь; подтверждение человека переживает пересчёт;
//   • возможность («есть схема нужной версии») включается и выключается проверкой; таймеры стартуют и останавливаются.
// Нужны зависимости сервера (npm ci --prefix server/osp-api) и PostgreSQL (бинарники или Docker).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startSignalDb, signalDbSkip, SERVER } from './lib/signal-db.mjs'
import { seedScenario, one } from './lib/signal-scenario.mjs'
import { FOLDER_FORMAT, ITEM_FORMAT } from './lib/signal-app.mjs'

const lit = (v) => `'${String(v).replace(/'/g, "''")}'`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('Очередь сверки с Signal (signalJobs.js)', { skip: signalDbSkip, timeout: 900000 }, () => {
  let db
  let sdb
  let s
  let C
  let F
  let createSignalJobs
  let warnings
  const log = { info() {}, warn: (o, msg) => warnings.push({ ...o, msg }) }
  const config = { urlFormats: [FOLDER_FORMAT, ITEM_FORMAT] }
  const make = (extra = {}, db2 = sdb) => createSignalJobs({ db: db2, log, ...extra, config: { ...config, ...(extra.config || {}) } })
  const stateOf = (id) => one(db, `select coalesce((select state || ':' || coalesce(reason, '') || ':' || state_version from osp_private.signal_contracts where contract_id = ${lit(id)}), '-')`)
  const queueLen = () => Number(one(db, 'select count(*) from osp_private.signal_queue'))
  const clearAll = () => {
    db.sql('delete from osp_private.signal_candidates')
    db.sql('delete from osp_private.signal_contracts')
    db.sql('select osp_private.signal_enqueue_all()')
  }
  // Обёртка базы: перехватывает запросы функций (до и после) — для сбоев, гонок и подсчёта запросов.
  const tap = (hook) => {
    const wrap = (tx) => ({
      mark: tx.mark,
      query: async (text, values) => {
        const name = /osp_private\.(signal_\w+)/.exec(text)?.[1] || null
        await hook.before?.(name, values)
        const res = await tx.query(text, values)
        await hook.after?.(name, res)
        return res
      },
    })
    return { read: (who, fn, o) => sdb.read(who, (tx) => fn(wrap(tx)), o), write: (who, fn, o) => sdb.write(who, (tx) => fn(wrap(tx)), o) }
  }

  before(async () => {
    db = await startSignalDb()
    sdb = await db.serverDb()
    s = await seedScenario(db)
    C = s.contracts
    F = s.folders
    ;({ createSignalJobs } = await import(path.join(SERVER, 'src', 'lib', 'signalJobs.js')))
  })
  after(async () => { await db?.stop() })

  it('такт: порция из очереди, состояния по снимку, очередь пуста; повторный такт — ничего; в модуле нет ни Signal, ни сети', async () => {
    warnings = []
    const jobs = make()
    assert.equal(queueLen(), 6)
    assert.deepEqual(await jobs.tick(), { portions: 1, contracts: 6 })
    assert.equal(queueLen(), 0)
    assert.match(stateOf(C.c1), /^suggested:candidates:1$/)
    assert.match(stateOf(C.c2), /^verified:existing_url:1$/)
    assert.match(stateOf(C.c3), /^none:none:1$/)
    assert.match(stateOf(C.c4), /^conflict:number_mismatch:1$/)
    assert.match(stateOf(C.ds1), /^suggested:candidates:1$/)
    assert.deepEqual(await jobs.tick(), { portions: 0, contracts: 0 })
    assert.deepEqual(warnings, [])
    // Очередь не знает Signal: ни клиента, ни адаптера, ни fetch, ни переменных SIGNAL_*.
    const src = fs.readFileSync(path.join(SERVER, 'src', 'lib', 'signalJobs.js'), 'utf8')
    const code = src.replace(/^\s*\/\/.*$/gm, '')
    assert.ok(!/signalClient|signalApi|signalSync|fetch\(|process\.env|node:https?|node:net/.test(code), 'signalJobs.js не обращается к Signal и к окружению')
    assert.ok(!/update\s+public\.contracts|set\s+signal_link/i.test(code), 'ссылку очередь не пишет')
  })

  it('порции: 450 договоров — порции по 200 за такт, maxPortions ограничивает такт; запись — по 200 договоров', async () => {
    db.sql(`insert into public.contracts (contract_number, object_id, status)
      select 'АЛФ-ДП-26-' || lpad((300 + i)::text, 3, '0'), ${lit(s.A)}, 'in_work' from generate_series(1, 450) i`)
    assert.equal(queueLen(), 450)
    const jobs = make({ config: { maxPortions: 1 } })
    assert.deepEqual(await jobs.tick(), { portions: 1, contracts: 200 })
    assert.equal(queueLen(), 250)
    assert.deepEqual(await make().tick(), { portions: 2, contracts: 250 })
    assert.equal(queueLen(), 0)
    assert.equal(one(db, `select count(*) from osp_private.signal_contracts`), '456')
  })

  it('захват: строка под чужим лизингом не берётся, лизинг истёк — берётся; захват порции — без пересечений', async () => {
    const id = db.seed.contract({ number: 'АЛФ-ДП-26-001', objectId: s.A, counterparties: [s.cpR], signalLink: s.urlOf(F.f1) })
    db.sql(`update osp_private.signal_queue set lease_token = gen_random_uuid(), lease_until = now() + interval '1 hour' where contract_id = ${lit(id)}`)
    assert.deepEqual(await make().tick(), { portions: 0, contracts: 0 }, 'чужой лизинг уважается')
    db.sql(`update osp_private.signal_queue set lease_until = now() - interval '1 second' where contract_id = ${lit(id)}`)
    assert.deepEqual(await make().tick(), { portions: 1, contracts: 1 })
    assert.match(stateOf(id), /^verified:existing_url/)
    // Два работника одновременно: каждый договор — у одного.
    for (let i = 0; i < 30; i++) db.seed.contract({ number: `АЛФ-ДП-26-8${String(i).padStart(2, '0')}`, objectId: s.A })
    const a = make({ config: { batch: 10, maxPortions: 1 } })
    const b = make({ config: { batch: 10, maxPortions: 1 } })
    const [ra, rb] = await Promise.all([a.tick(), b.tick()])
    assert.equal(ra.contracts + rb.contracts, 20, 'порции не пересеклись')
    assert.equal(queueLen(), 10)
    await make().tick()
    assert.equal(queueLen(), 0)
  })

  it('ошибка порции: договоры возвращены с паузой, нарастающей по неудачам; после паузы — обработаны; запись состояния не частичная', async () => {
    warnings = []
    const id = db.seed.contract({ number: 'АЛФ-ДП-26-002', objectId: s.A, counterparties: [s.cpR], signalLink: s.urlOf(F.f2) })
    let broken = true
    const jobs = make({}, tap({ before: (name) => { if (broken && name === 'signal_state_write') throw Object.assign(new Error('сбой записи'), { code: 'XX000' }) } }))
    const first = await jobs.tick()
    assert.equal(first.error, 'XX000')
    assert.equal(one(db, `select attempts || '|' || (lease_token is null) || '|' || (next_at > now() + interval '20 seconds' and next_at < now() + interval '40 seconds') from osp_private.signal_queue where contract_id = ${lit(id)}`), '1|true|true')
    assert.equal(stateOf(id), '-', 'ничего не записано')
    assert.deepEqual(await jobs.tick(), { portions: 0, contracts: 0 }, 'пауза не истекла — строка не берётся')
    db.sql(`update osp_private.signal_queue set next_at = now() - interval '1 second' where contract_id = ${lit(id)}`)
    const second = await jobs.tick()
    assert.equal(second.error, 'XX000')
    assert.equal(one(db, `select attempts || '|' || (next_at > now() + interval '100 seconds' and next_at < now() + interval '140 seconds') from osp_private.signal_queue where contract_id = ${lit(id)}`), '2|true', 'вторая неудача — пауза 120 с')
    assert.equal(warnings.filter((w) => /не обработана/.test(w.msg)).length, 2)
    assert.ok(!JSON.stringify(warnings).includes(s.urlOf(F.f2)), 'в журнале нет ссылок договора')
    broken = false
    db.sql(`update osp_private.signal_queue set next_at = now() - interval '1 second' where contract_id = ${lit(id)}`)
    assert.deepEqual(await jobs.tick(), { portions: 1, contracts: 1 })
    assert.match(stateOf(id), /^verified:existing_url/)
    assert.equal(queueLen(), 0)
  })

  it('правка договора во время расчёта: запись отброшена, строка остаётся и обрабатывается следующим тактом по новым данным', async () => {
    const id = db.seed.contract({ number: 'АЛФ-ДП-26-004', objectId: s.A, counterparties: [s.cpR] })
    let bumped = false
    const jobs = make({}, tap({
      before: (name) => {
        if (name === 'signal_state_write' && !bumped) {
          bumped = true
          db.sql(`update public.contracts set contract_number = 'АЛФ-ДП-26-009' where id = ${lit(id)}`)
        }
      },
    }))
    assert.deepEqual(await jobs.tick(), { portions: 1, contracts: 1 })
    assert.equal(stateOf(id), '-', 'результат по старому номеру не записан')
    assert.equal(queueLen(), 1, 'строка осталась в очереди')
    assert.equal(one(db, `select lease_token is null from osp_private.signal_queue where contract_id = ${lit(id)}`), 't', 'возвращена сразу, а не по сроку лизинга')
    db.sql(`update osp_private.signal_queue set next_at = now() - interval '1 second' where contract_id = ${lit(id)}`)
    await jobs.tick()
    assert.match(stateOf(id), /^none:none:/, 'номер 009 — папки нет')
    assert.equal(queueLen(), 0)
  })

  it('снимок сменился между запросами узлов: расчёт повторён целиком, запись — по новому поколению', async () => {
    const id = db.seed.contract({ number: 'АЛФ-ДП-26-002', objectId: s.A, counterparties: [s.cpR], signalLink: s.urlOf(F.f2) })
    let calls = 0
    const gen0 = Number(one(db, 'select generation from osp_private.signal_meta'))
    const jobs = make({}, tap({
      after: (name) => {
        if (name !== 'signal_match_nodes') return
        calls += 1
        if (calls === 1) db.sql('update osp_private.signal_meta set generation = generation + 1 where id = 1')
      },
    }))
    assert.deepEqual(await jobs.tick(), { portions: 1, contracts: 1 })
    assert.ok(calls >= 4, `запросов узлов: ${calls}`)
    assert.equal(Number(one(db, `select checked_gen from osp_private.signal_contracts where contract_id = ${lit(id)}`)), gen0 + 1)
    // Узлы старого поколения «не видны в последнем обходе»: по ссылке — не наблюдается, не «папки нет».
    assert.match(stateOf(id), /^unverified:not_observed/)
    db.sql(`update osp_private.signal_nodes set seen_gen = (select generation from osp_private.signal_meta)`)
    db.sql('select osp_private.signal_enqueue_all()')
    await make().tick()
    assert.match(stateOf(id), /^verified:existing_url/)
  })

  it('результат не зависит от разбивки на порции и групп запросов; усечённая выборка — запрос по каждому договору', async () => {
    const run = async (extra) => {
      clearAll()
      const jobs = make(extra)
      let guard = 0
      while (queueLen() && guard++ < 200) await jobs.tick()
      return db.sql(`select c.id || '|' || sc.state || '|' || coalesce(sc.reason, '') || '|' || coalesce(sc.node_id::text, '') || '|' || sc.fingerprint || '|' ||
          coalesce((select string_agg(k.node_id::text || ':' || k.score || ':' || array_to_string(k.reasons, ','), ';' order by k.node_id) from osp_private.signal_candidates k where k.contract_id = c.id), '')
        from osp_private.signal_contracts sc join public.contracts c on c.id = sc.contract_id order by c.id`)
    }
    const base = await run({})
    assert.ok(base.split('\n').length > 400)
    assert.equal(await run({ config: { batch: 7 } }), base, 'порции по 7')
    assert.equal(await run({ config: { groupContracts: 1 } }), base, 'по группе на договор')
    assert.equal(await run({ config: { groupTerms: 3, groupKeys: 2 } }), base, 'мелкие группы запросов')
    assert.equal(await run({ config: { nodesLimit: 4 } }), base, 'выборка узлов усечена: запрос по каждому договору отдельно')
    // Предел меньше, чем нужно одному договору: список предложений неполный — это в журнале, расчёт не падает.
    warnings = []
    const tiny = await run({ config: { nodesLimit: 2 } })
    assert.equal(tiny.split('\n').length, base.split('\n').length, 'все договоры обработаны')
    assert.ok(warnings.some((w) => /усечена/.test(w.msg)))
  })

  it('барьер записи и выключенная возможность пропускают такт целиком: ни захвата, ни записи', async () => {
    clearAll()
    const readOnly = make({ isReadOnly: () => true })
    assert.deepEqual(await readOnly.tick(), { skipped: 'read_only' })
    const off = make({ isActive: () => false })
    assert.deepEqual(await off.tick(), { skipped: 'inactive' })
    assert.equal(one(db, 'select count(*) from osp_private.signal_queue where lease_token is not null'), '0', 'ничего не захвачено')
    assert.equal(one(db, 'select count(*) from osp_private.signal_contracts'), '0')
    // Барьер включился посреди такта: следующая порция не берётся.
    let ro = false
    const mid = make({ isReadOnly: () => ro, config: { batch: 100, maxPortions: 5 } }, tap({ after: (name) => { if (name === 'signal_state_write') ro = true } }))
    const r = await mid.tick()
    assert.equal(r.portions, 1)
    assert.ok(queueLen() > 0)
    await make().tick()
    assert.equal(queueLen(), 0)
  })

  it('инвалидация: смена номера, объекта, сторон, ссылки и ДП пересчитывает договор и его ДС (сброс «сверено» — через очередь)', async () => {
    const cp2 = db.seed.counterparty({ name: 'ООО Ландыш' })
    const dp = db.seed.contract({ number: 'АЛФ-ДП-26-002', objectId: s.A, counterparties: [s.cpR], signalLink: s.urlOf(F.f2) })
    const ds = db.seed.contract({ number: 'ДС-1', objectId: s.A, counterparties: [s.cpR], recordType: 'ds_vor', parent: dp, signalLink: s.urlOf(F.fds1) })
    await make().tick()
    assert.match(stateOf(dp), /^verified:existing_url/)
    assert.match(stateOf(ds), /^verified:existing_url/)
    const change = async (sql, expectDp, expectDs) => {
      db.sql(sql)
      assert.ok(queueLen() >= 1, 'правка поставила договор в очередь')
      await make().tick()
      assert.match(stateOf(dp), expectDp, sql)
      if (expectDs) assert.match(stateOf(ds), expectDs, sql)
    }
    await change(`update public.contracts set contract_number = 'АЛФ-ДП-26-077' where id = ${lit(dp)}`, /^conflict:number_mismatch/, /^unverified:family_unknown/)
    await change(`update public.contracts set contract_number = 'АЛФ-ДП-26-002' where id = ${lit(dp)}`, /^verified:existing_url/, /^verified:existing_url/)
    await change(`update public.contracts set signal_link = ${lit(s.urlOf(F.f4))} where id = ${lit(dp)}`, /^conflict:number_mismatch/)
    await change(`update public.contracts set signal_link = ${lit(s.urlOf(F.f2))} where id = ${lit(dp)}`, /^verified:existing_url/)
    await change(`update public.contracts set object_id = ${lit(s.B)} where id = ${lit(dp)}`, /^unverified:outside_roots/)
    await change(`update public.contracts set object_id = ${lit(s.A)} where id = ${lit(dp)}`, /^verified:existing_url/)
    // Стороны: смена контрагента — договор пересчитан (без ссылки: предложение по названию стороны).
    const bare = db.seed.contract({ number: '№555', objectId: s.A, counterparties: [cp2] })
    await make().tick()
    assert.match(stateOf(bare), /^none:none/)
    db.sql(`update public.contract_counterparties set counterparty_id = ${lit(s.cpR)} where contract_id = ${lit(bare)}`)
    assert.equal(one(db, `select count(*) from osp_private.signal_queue where contract_id = ${lit(bare)}`), '1', 'смена сторон поставила договор в очередь')
    await make().tick()
    assert.match(stateOf(bare), /^suggested:candidates/, 'сторона договора теперь названа в папках объекта')
    // Объект переименован — договоры объекта пересчитываются (названия объекта — в признаках предложений).
    db.sql(`update public.objects set name = 'Тест: ЖК Альфа Новый' where id = ${lit(s.A)}`)
    assert.ok(queueLen() > 0)
    await make().tick()
    db.sql(`update public.objects set name = 'Тест: ЖК Альфа' where id = ${lit(s.A)}`)
    await make().tick()
  })

  it('подтверждение человека переживает пересчёт: узел тот же — причина «подтверждено»; другая ссылка — прежнее подтверждение сброшено', async () => {
    const id = db.seed.contract({ number: 'АЛФ-ДП-26-002', objectId: s.A, counterparties: [s.cpR] })
    await make().tick()
    const uid = s.users.editor
    // Подтверждение, как делает маршрут: функция базы от имени сотрудника.
    const v = Number(one(db, `select state_version from osp_private.signal_contracts where contract_id = ${lit(id)}`))
    db.as(uid, `select osp_private.signal_confirm(${lit(id)}, ${lit(F.f2)}, ${lit(s.urlOf(F.f2))}, false, null, null, 'fp', null, ${v}, ${lit(crypto.randomUUID())})`)
    assert.match(stateOf(id), /^verified:confirmed/)
    db.sql('select osp_private.signal_enqueue_all()')
    await make().tick()
    assert.match(stateOf(id), /^verified:confirmed/, 'пересчёт тем же узлом не меняет причину и версию')
    const ver = one(db, `select state_version from osp_private.signal_contracts where contract_id = ${lit(id)}`)
    db.sql('select osp_private.signal_enqueue_all()')
    await make().tick()
    assert.equal(one(db, `select state_version from osp_private.signal_contracts where contract_id = ${lit(id)}`), ver, 'версия не растёт без изменений')
    // Ссылка правится мимо окна сверки: другая папка — подтверждение человека больше не действует.
    db.sql(`update public.contracts set signal_link = ${lit(s.urlOf(F.k1))} where id = ${lit(id)}`)
    await make().tick()
    assert.match(stateOf(id), /^verified:existing_url/)
    assert.equal(one(db, `select confirmed_by is null from osp_private.signal_contracts where contract_id = ${lit(id)}`), 't')
  })

  it('удалённый договор — «нет ссылки», без предложений и без обращения к снимку; договор, удалённый совсем, из очереди уходит каскадом', async () => {
    const id = db.seed.contract({ number: 'АЛФ-ДП-26-001', objectId: s.A, counterparties: [s.cpR] })
    await make().tick()
    assert.match(stateOf(id), /^suggested/)
    db.sql(`update public.contracts set deleted_at = now() where id = ${lit(id)}`)
    await make().tick()
    assert.match(stateOf(id), /^none:none/)
    assert.equal(one(db, `select count(*) from osp_private.signal_candidates where contract_id = ${lit(id)} and status = 'open'`), '0')
    const gone = db.seed.contract({ number: 'АЛФ-ДП-26-123', objectId: s.A })
    db.sql(`delete from public.contracts where id = ${lit(gone)}`)
    assert.equal(one(db, `select count(*) from osp_private.signal_queue where contract_id = ${lit(gone)}`), '0')
    assert.deepEqual(await make().tick(), { portions: 0, contracts: 0 })
  })

  it('таймер: start() запускает такты сам, stop() дожидается идущего такта и закрывает дверь; повторный start — ничего', async () => {
    db.seed.contract({ number: 'АЛФ-ДП-26-001', objectId: s.A, counterparties: [s.cpR] })
    assert.ok(queueLen() > 0)
    const jobs = make({ config: { jobsTickMs: 40, firstDelayMs: 10 } })
    jobs.start()
    jobs.start()
    for (let i = 0; i < 100 && queueLen(); i++) await sleep(50)
    assert.equal(queueLen(), 0, 'очередь разобрана таймером')
    await jobs.stop()
    assert.deepEqual(await jobs.tick(), { skipped: 'stopped' })
    jobs.start()
    db.seed.contract({ number: 'АЛФ-ДП-26-001', objectId: s.A })
    await sleep(200)
    assert.equal(queueLen(), 1, 'после stop() очередь больше не разбирается')
    await make().tick()
  })
})

