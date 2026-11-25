// Очередь, состояние и решения человека в базе сверки с SIGNAL (миграция 20270228_signal_integration): перевёрнутые пробы рецензентов.
//   • С-15 / С-24: signal_state_write не перезаписывает решение человека (отвязку, подтверждение) расчётом, начатым до него, —
//     по версии состояния и нормализованной ссылке элемента; элемент без этих полей работает по-прежнему; состояние accepted допустимо;
//   • С-18: confirm / unlink снимают строку очереди, только если окно видело её ревизию (либо это плановая пересверка); правка,
//     которую окно не видело, остаётся в очереди; жёсткое противоречие по номеру — SG409 hard_conflict в базе, ничего не меняется;
//   • С-27: confirm требует наблюдения папки в последнем обходе;
//   • С-46: одна нормализация ссылки в SQL и в JS (String.trim + U+FEFF) — ссылку с неразрывным пробелом / переводом строки на конце
//     можно отвязать и заменить;
//   • С-53 / С-54: отказ действует, пока тот же контекст договора И тот же вид папки (node_key); при переоткрытии прежнее решение
//     переносится в prev_*;
//   • С-16: signal_enqueue_missed ставит в очередь договоры, пропущенные триггером;
//   • С-6 / С-2: синоним не должен совпадать с названием или кодом другого объекта (в том числе после переименования);
//     сотрудник видит и удаляет только свои синонимы.
// Нужны зависимости сервера и PostgreSQL (бинарники или Docker). Данные вымышлены.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { startSignalDb, signalDbSkip, uuid } from './lib/signal-db.mjs'

describe('База сверки с SIGNAL: состояние, очередь и решения человека', { skip: signalDbSkip, timeout: 600000 }, () => {
  let db
  let seed
  const q = (text) => db.sql(text)
  const j = (text) => db.sqlJson(text)
  const gen = () => Math.max(1, Number(q('select generation from osp_private.signal_meta')))
  const queueRev = (c) => { const r = q(`select dirty_revision from osp_private.signal_queue where contract_id = '${c}'`); return r === '' ? null : Number(r) }
  const stateRow = (c) => q(`select coalesce((select state || ':' || coalesce(reason, '') || '|' || state_version || '|' || coalesce(node_id::text, '-') from osp_private.signal_contracts where contract_id = '${c}'), '-')`)
  const linkOf = (c) => q(`select coalesce(signal_link, '<NULL>') from public.contracts where id = '${c}'`)
  const write = (c, over = {}, lease = null) => j(`select osp_private.signal_state_write(${lease ? `'${lease}'` : 'null'}, '${JSON.stringify([{ contractId: c, revision: queueRev(c), generation: gen(),
    state: 'suggested', reason: null, nodeId: null, fingerprint: 'f', ctxKey: 'ctx', candidates: [], ...over }]).replace(/'/g, "''")}'::jsonb)`)
  const url = (n) => `https://signal.example.invalid/folder/${n}`
  const confirmSql = (c, node, ver, key, over = {}) => `select osp_private.signal_confirm('${c}', '${node}', '${over.url || url(node)}', ${over.replace ?? false}, ${over.alias ? `'${over.alias}'` : 'null'}, ${over.aliasKey ? `'${over.aliasKey}'` : 'null'}, 'fp', ${over.link ? `'${over.link}'` : 'null'}, ${ver}, '${key}'${over.rev === undefined ? '' : `, ${over.rev === null ? 'null' : over.rev}`})`
  const unlinkSql = (c, link, ver, key, rev) => `select osp_private.signal_unlink('${c}', 'ctx', '${link}', ${ver}, '${key}'${rev === undefined ? '' : `, ${rev === null ? 'null' : rev}`})`

  before(async () => {
    db = await startSignalDb()
    seed = db.seed
  })
  after(async () => { await db?.stop() })

  it('С-15 / С-24: расчёт, начатый до «Отвязать» или «Подтвердить», не перезаписывает решение человека — stale по версии состояния и по ссылке; без полей — прежнее поведение; accepted допустимо', () => {
    const o = seed.object({ code: 'СТА' })
    const ed = seed.user({ contracts: 'edit', objectIds: [o], objectScoped: true })
    const src = seed.source({ objectIds: [o] })
    const snap = seed.snapshot(src.id, { name: 'R', children: [{ name: 'N1' }, { name: 'N2' }] }, { generation: gen() })
    const n1 = snap.ids['R / N1']
    const n2 = snap.ids['R / N2']
    const L = `${url(n1)}\u00a0`
    const c = seed.contract({ number: 'Старый-1', objectId: o, signalLink: L })
    q(`delete from osp_private.signal_queue where contract_id = '${c}'`)
    // «сверено» по введённой ссылке (расчёт с версией 0 и ссылкой L)
    assert.deepEqual(write(c, { revision: null, state: 'verified', reason: 'existing_url', nodeId: n1, stateVersion: 0, signalLink: L }), { written: 1, acked: 0, stale: 0 })
    const v1 = Number(stateRow(c).split('|')[1])
    // /match загрузил договор (версия v1, ссылка L), а вторая вкладка отвязала: строки очереди нет — прежний код писал «сверено» поверх.
    db.asJson(ed, unlinkSql(c, L.trim(), v1, 'u1'))
    assert.equal(linkOf(c), '<NULL>')
    assert.match(stateRow(c), /^none:unlinked\|2\|-$/)
    assert.deepEqual(write(c, { revision: null, state: 'verified', reason: 'existing_url', nodeId: n1, stateVersion: v1, signalLink: L }), { written: 0, acked: 0, stale: 1 }, 'С-24')
    assert.match(stateRow(c), /^none:unlinked\|2\|-$/, 'отвязка не затёрта')
    // Версия верна, но ссылку договора успели сменить (правка карточки) — тоже устарело.
    assert.deepEqual(write(c, { revision: null, state: 'none', reason: 'none', stateVersion: 2, signalLink: L }), { written: 0, acked: 0, stale: 1 }, 'ссылка договора уже другая')
    // Свежий расчёт проходит; null вместо ссылки (ссылки нет) — тоже «как видел расчёт».
    assert.deepEqual(write(c, { revision: null, state: 'none', reason: 'none', stateVersion: 2, signalLink: null }), { written: 1, acked: 0, stale: 0 })
    // Нормализация: ссылка с неразрывным пробелом и перевод строки на конце — одно и то же (С-46).
    q(`update public.contracts set signal_link = '${url(n2)}' || chr(10) where id = '${c}'`)
    q(`delete from osp_private.signal_queue where contract_id = '${c}'`)
    assert.deepEqual(write(c, { revision: null, state: 'verified', reason: 'existing_url', nodeId: n2, stateVersion: Number(stateRow(c).split('|')[1]), signalLink: ` ${url(n2)}\u00a0\r\n` }), { written: 1, acked: 0, stale: 0 })
    // Элемент без stateVersion / signalLink — прежнее поведение (работа signalJobs до фазы сервера).
    assert.deepEqual(write(c, { revision: null, state: 'verified', reason: 'existing_url', nodeId: n2 }), { written: 1, acked: 0, stale: 0 })
    // Договор без состояния: устаревший по ссылке результат не оставляет пустой строки состояния.
    const fresh = seed.contract({ number: 'Старый-2', objectId: o, signalLink: url(n1) })
    q(`delete from osp_private.signal_queue where contract_id = '${fresh}'`)
    assert.deepEqual(write(fresh, { revision: null, state: 'none', reason: 'none', stateVersion: 0, signalLink: null }), { written: 0, acked: 0, stale: 1 })
    assert.equal(q(`select count(*) from osp_private.signal_contracts where contract_id = '${fresh}'`), '0', 'ни следа состояния при stale')
    // Подтверждение человека опередило расчёт предложений: результат со старой версией не заменяет открытых кандидатов.
    const sug = seed.contract({ number: 'Старый-3', objectId: o })
    assert.equal(write(sug, { candidates: [{ nodeId: n1, score: 70, reasons: [], flags: [] }, { nodeId: n2, score: 40, reasons: [], flags: [] }], stateVersion: 0, signalLink: null }).written, 1)
    const vs = Number(stateRow(sug).split('|')[1])
    db.asJson(ed, confirmSql(sug, n1, vs, 'c-sug'))
    assert.equal(q(`select count(*) from osp_private.signal_candidates where contract_id = '${sug}' and status = 'open'`), '0')
    assert.equal(write(sug, { revision: null, candidates: [{ nodeId: n2, score: 40, reasons: [], flags: [] }], stateVersion: vs, signalLink: null }).stale, 1)
    assert.match(stateRow(sug), /^verified:confirmed\|/)
    assert.equal(q(`select count(*) from osp_private.signal_candidates where contract_id = '${sug}'`), '0', 'кандидаты старого расчёта не вернулись')
    // accepted: допустимое состояние и в записи результата, и в таблице; неизвестное — по-прежнему отказ.
    const acc = seed.contract({ number: 'Старый-4', objectId: o, signalLink: url(n1) })
    q(`delete from osp_private.signal_queue where contract_id = '${acc}'`)
    assert.equal(write(acc, { revision: null, state: 'accepted', reason: 'number_not_found', nodeId: n1, stateVersion: 0, signalLink: url(n1) }).written, 1)
    assert.match(stateRow(acc), /^accepted:number_not_found\|/)
    assert.equal(db.sqlError(`select osp_private.signal_state_write(null, '${JSON.stringify([{ contractId: acc, revision: null, generation: gen(), state: 'approved' }])}'::jsonb)`).message, 'invalid')
    assert.equal(db.asJson(ed, 'select osp_private.signal_marks(null, 1000)').items.find((i) => i.id === acc).state, 'accepted')
    assert.match(q("select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'osp_private.signal_contracts'::regclass and contype = 'c'"), /accepted/)
  })

  it('С-18: confirm и unlink снимают строку очереди, только если окно видело её ревизию (или это плановая пересверка); правка реквизитов, которую окно не видело, остаётся в очереди', () => {
    const o = seed.object({ code: 'СТБ' })
    const ed = seed.user({ contracts: 'edit', objectIds: [o], objectScoped: true })
    const src = seed.source({ objectIds: [o] })
    const snap = seed.snapshot(src.id, { name: 'RQ', children: [{ name: 'Папка 1' }, { name: 'Папка 2' }] }, { generation: gen() })
    const f1 = snap.ids['RQ / Папка 1']
    const f2 = snap.ids['RQ / Папка 2']
    const view = (c) => db.asJson(ed, `select osp_private.signal_contract_view('${c}')`)
    const recheck = (c) => q(`select recheck_only from osp_private.signal_queue where contract_id = '${c}'`)
    const edit = (c) => q(`update public.contracts set contract_number = 'Старый-' || floor(random() * 1e9)::text where id = '${c}'`)

    // а) окно видело ревизию — подтверждение её снимает; состояние обработано, «ожидает» нет.
    const a = seed.contract({ number: 'Старый-10', objectId: o })
    const wa = view(a)
    assert.ok(wa.revision > 0 && wa.pending === true, 'договор в очереди: окно видит ревизию')
    db.asJson(ed, confirmSql(a, f1, wa.stateVersion, 'ka', { rev: wa.revision }))
    assert.equal(queueRev(a), null)
    assert.equal(view(a).pending, false)
    // б) правку реквизитов сделали после того, как окно открылось: подтверждение её не стирает, «ожидает» остаётся.
    const b = seed.contract({ number: 'Старый-11', objectId: o })
    q(`delete from osp_private.signal_queue where contract_id = '${b}'`)
    const wb = view(b)
    assert.equal(wb.revision, null, 'окно открылось, когда очереди не было')
    edit(b)
    const rb = queueRev(b)
    assert.ok(rb > 0 && recheck(b) === 'f')
    db.asJson(ed, confirmSql(b, f1, wb.stateVersion, 'kb', { rev: 0 }))
    assert.equal(queueRev(b) > 0, true, 'правка, которую окно не видело (revision окна = 0, строки не было), осталась в очереди')
    assert.equal(recheck(b), 'f')
    assert.equal(view(b).pending, true)
    assert.equal(view(b).state, 'verified', 'решение человека состоялось, «ожидает» — про правку')
    // в) устаревшая ревизия окна и настоящая правка в очереди — не снимается; плановая пересверка — снимается (реквизиты не менялись).
    const c = seed.contract({ number: 'Старый-12', objectId: o })
    const wc = view(c)
    edit(c)
    db.asJson(ed, confirmSql(c, f1, wc.stateVersion, 'kc', { rev: wc.revision }))
    assert.equal(queueRev(c) > 0, true, 'ревизия окна устарела (правка в очереди новее)')
    const d = seed.contract({ number: 'Старый-13', objectId: o })
    q(`delete from osp_private.signal_queue where contract_id = '${d}'`)
    q(`select osp_private.signal_enqueue_all()`)
    assert.equal(recheck(d), 't')
    const wd = view(d)
    db.asJson(ed, confirmSql(d, f1, wd.stateVersion, 'kd', { rev: 0 }))
    assert.equal(queueRev(d), null, 'плановая пересверка решением человека учтена')
    // г) отказ в базе и снятие связи — то же правило; старый вызов без ревизии работает (DEFAULT NULL).
    const e = seed.contract({ number: 'Старый-14', objectId: o })
    q(`delete from osp_private.signal_queue where contract_id = '${e}'`)
    db.asJson(ed, confirmSql(e, f1, view(e).stateVersion, 'ke'))
    const link = linkOf(e)
    edit(e)
    const re = queueRev(e)
    db.asJson(ed, unlinkSql(e, link, view(e).stateVersion, 'ue', 0))
    assert.equal(queueRev(e) > 0, true, 'unlink: правка, которую окно не видело, осталась в очереди')
    assert.equal(linkOf(e), '<NULL>')
    assert.ok(re > 0)
    const g = seed.contract({ number: 'Старый-15', objectId: o, signalLink: url(f2) })
    const wg = view(g)
    db.asJson(ed, unlinkSql(g, url(f2), wg.stateVersion, 'ug', wg.revision))
    assert.equal(queueRev(g), null, 'unlink с ревизией окна — очередь снята')
    // Прежний вызов без ревизии (10 аргументов) работает как раньше: строка очереди снимается.
    const h = seed.contract({ number: 'Старый-16', objectId: o })
    assert.ok(queueRev(h) > 0)
    assert.equal(db.asJson(ed, confirmSql(h, f1, 0, 'kold')).stateVersion, 1)
    assert.equal(queueRev(h), null, 'ревизия не передана — прежнее поведение')
  })

  it('С-18: жёсткое противоречие по номеру — SG409 hard_conflict в базе и ничего не меняется; С-27: папка, которую не видели в последнем обходе, подтвердить нельзя', () => {
    const o = seed.object({ code: 'СТВ' })
    const o2 = seed.object({ code: 'СТГ' })
    const ed = seed.user({ contracts: 'edit', objectIds: [o, o2], objectScoped: true })
    const admin = seed.admin()
    const src = seed.source({ objectIds: [o, o2] })
    const snap = seed.snapshot(src.id, { name: 'RH', children: [
      { name: 'Договоры СТВ', numberKeys: [], children: [
        { name: 'Два номера СТВ-ДП-26-001 и СТВ-ДП-26-002', numberKeys: ['СТВ|2026|1', 'СТВ|2026|2'] },
        { name: 'Папка с номером 3', numberKeys: ['СТВ|2026|3'], children: [{ name: 'Вложенная без номера' }, { name: 'Ещё вложенная', children: [{ name: 'Глубже без номера' }] }] },
        { name: 'Папка с номером 1', numberKeys: ['СТВ|2026|1'], children: [{ name: 'Приложения без номера' }] },
        { name: 'Папка без номеров', children: [{ name: 'Подпапка' }] },
        { name: 'Ненаблюдаемая' }] },
      { name: 'Чужой СТГ', numberKeys: ['СТВ|2026|9'], children: [{ name: 'Под чужим' }] }] }, { generation: gen() })
    const id = (p) => snap.ids[`RH / ${p}`]
    db.asJson(admin, `select osp_private.signal_binding_set(${src.id}, '${id('Договоры СТВ')}', '${o}')`)
    db.asJson(admin, `select osp_private.signal_binding_set(${src.id}, '${id('Чужой СТГ')}', '${o2}')`)
    // Папка «Под чужим» объекта СТГ относится к другому объекту — граница обрывает цепочку выше.
    const dp = seed.contract({ number: 'СТВ-ДП-26-001', objectId: o })
    const info = (c) => `${linkOf(c)}|${stateRow(c)}|${queueRev(c)}|${q(`select count(*) from public.contract_audit_log where contract_id = '${c}' and event_type = 'signal_link'`)}`
    const tryConfirm = (c, node, key) => {
      const before = info(c)
      const e = db.asError(ed, confirmSql(c, node, Number(stateRow(c) === '-' ? 0 : stateRow(c).split('|')[1]), key))
      return { e, same: info(c) === before }
    }
    // Два разных номера в имени — противоречие для любого договора.
    let r = tryConfirm(dp, id('Договоры СТВ / Два номера СТВ-ДП-26-001 и СТВ-ДП-26-002'), 'k1')
    assert.deepEqual([r.e?.code, r.e?.message, r.same], ['SG409', 'hard_conflict', true], 'ambiguous')
    // У ДП с номером по схеме: ближайший уровень цепочки с номерами — чужой номер → противоречие; свой — можно.
    r = tryConfirm(dp, id('Договоры СТВ / Папка с номером 3'), 'k2')
    assert.deepEqual([r.e?.code, r.e?.message, r.same], ['SG409', 'hard_conflict', true], 'в самой папке чужой номер')
    r = tryConfirm(dp, id('Договоры СТВ / Папка с номером 3 / Вложенная без номера'), 'k3')
    assert.deepEqual([r.e?.message, r.same], ['hard_conflict', true], 'папка без номера, ближайший уровень выше — чужой номер')
    r = tryConfirm(dp, id('Договоры СТВ / Папка с номером 3 / Ещё вложенная / Глубже без номера'), 'k4')
    assert.deepEqual([r.e?.message, r.same], ['hard_conflict', true], 'ближайший уровень с номерами — через два звена')
    // Свой номер на ближайшем уровне, номеров нет вовсе, граница объекта — подтверждается.
    assert.equal(db.asJson(ed, confirmSql(dp, id('Договоры СТВ / Папка с номером 1 / Приложения без номера'), 0, 'k5')).reason, 'confirmed')
    const dp2 = seed.contract({ number: 'СТВ-ДП-26-004', objectId: o })
    assert.equal(db.asJson(ed, confirmSql(dp2, id('Договоры СТВ / Папка без номеров / Подпапка'), 0, 'k6')).reason, 'confirmed', 'номеров в цепочке нет — решение человека и есть признак')
    // ДС и договор старого вида — номер в SQL не проверяется (решает сопоставитель).
    const ds = seed.contract({ number: 'ДС-1', objectId: o, recordType: 'ds_vor', parent: dp })
    assert.equal(db.asJson(ed, confirmSql(ds, id('Договоры СТВ / Папка с номером 3'), 0, 'k7')).reason, 'confirmed')
    const old = seed.contract({ number: 'Старый-5/2020', objectId: o })
    assert.equal(db.asJson(ed, confirmSql(old, id('Договоры СТВ / Папка с номером 3'), 0, 'k8')).reason, 'confirmed')
    // Папка ДС рядом с ДП (kind_mismatch — мягкое, решает сопоставитель): по номерам SQL противоречия нет — подтверждение проходит.
    const dpDs = seed.contract({ number: 'СТВ-ДП-26-001', objectId: o, deleted: false })
    q(`update public.contracts set contract_number = 'СТВ-ДП-26-011' where id = '${dpDs}'`)
    q(`update osp_private.signal_nodes set number_keys = array['СТВ|2026|11'], name = 'ДС-1 к СТВ-ДП-26-011' where node_id = '${id('Договоры СТВ / Папка без номеров')}'`)
    assert.equal(db.asJson(ed, confirmSql(dpDs, id('Договоры СТВ / Папка без номеров'), 0, 'k-ds')).reason, 'confirmed', 'ДП подтверждает папку «ДС-1 к <свой номер>»')
    q(`update osp_private.signal_nodes set number_keys = '{}', name = 'Папка без номеров' where node_id = '${id('Договоры СТВ / Папка без номеров')}'`)
    // С-27: узла в последнем обходе нет — отказ без последствий.
    const dp3 = seed.contract({ number: 'СТВ-ДП-26-007', objectId: o })
    q(`update osp_private.signal_nodes set seen_gen = 0 where node_id = '${id('Договоры СТВ / Ненаблюдаемая')}'`)
    r = tryConfirm(dp3, id('Договоры СТВ / Ненаблюдаемая'), 'k9')
    assert.deepEqual([r.e?.code, r.e?.message, r.same], ['SG422', 'node_unavailable', true], 'С-27')
    assert.equal(db.asError(ed, confirmSql(dp3, id('Договоры СТВ / Папка без номеров'), 0, 'k10', { url: url('x') })), null, 'контроль: наблюдаемая папка подтверждается')
  })

  it('С-46: ссылка с неразрывным пробелом, \\r\\n или \\t на конце отвязывается и заменяется; нормализация SQL = String.trim() + U+FEFF на всех пробельных символах', () => {
    const chars = ['\t', '\n', '\u000b', '\f', '\r', ' ', '\u00a0', '\u1680', '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008',
      '\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff']
    const js = (s) => s.trim().replace(/^\ufeff+|\ufeff+$/g, '')
    for (const ch of chars) {
      for (const text of [`${ch}x`, `x${ch}`, `${ch}${ch}x y${ch}${ch}`, `x${ch}y`]) {
        const sqlText = `convert_from(decode('${Buffer.from(text, 'utf8').toString('hex')}', 'hex'), 'UTF8')`
        // trim и BOM могут чередоваться (\ufeff внутри пробелов): сравниваем с циклической обрезкой до неподвижной точки.
        let want = text
        for (let i = 0; i < 4; i += 1) want = js(want)
        assert.equal(q(`select osp_private.signal_norm_link(${sqlText})`), want, `U+${ch.codePointAt(0).toString(16)} в ${JSON.stringify(text)}`)
      }
    }
    assert.equal(q("select coalesce(osp_private.signal_norm_link(null), '<пусто>') = ''"), 't')
    assert.equal(q("select osp_private.signal_norm_link('  ' || chr(160) || chr(65279) || chr(10)) = ''"), 't')
    // Сквозной сценарий: в карточке договора ссылка оканчивается неразрывным пробелом, клиент режет trim — «Отвязать» проходит.
    const o = seed.object({ code: 'СТД' })
    const ed = seed.user({ contracts: 'edit', objectIds: [o], objectScoped: true })
    const src = seed.source({ objectIds: [o] })
    const snap = seed.snapshot(src.id, { name: 'RN', children: [{ name: 'Папка' }] }, { generation: gen() })
    const f = snap.ids['RN / Папка']
    for (const [i, tail] of ['\u00a0', '\r\n', '\t', '\ufeff', ' \u2028'].entries()) {
      const c = seed.contract({ number: `Старый-2${i}`, objectId: o, signalLink: `${url(f)}${tail}` })
      const w = db.asJson(ed, `select osp_private.signal_contract_view('${c}')`)
      assert.equal(w.signalLink, `${url(f)}${tail}`, 'окно отдаёт ссылку как в базе')
      // клиент: trim() + U+FEFF; база сравнивает после той же нормализации
      const sent = js(w.signalLink)
      const u = db.asJson(ed, unlinkSql(c, sent, w.stateVersion, `u${i}`))
      assert.equal(u.reason, 'unlinked')
      assert.equal(linkOf(c), '<NULL>')
      // замена: подтверждение при ссылке с хвостом и ожидаемой ссылкой без него
      const c2 = seed.contract({ number: `Старый-3${i}`, objectId: o, signalLink: `${url(f)}${tail}` })
      const v2 = db.asJson(ed, `select osp_private.signal_contract_view('${c2}')`)
      const same = db.asJson(ed, confirmSql(c2, f, v2.stateVersion, `c${i}`, { link: sent }))
      assert.equal(same.signalLink, url(f), 'тот же адрес без хвоста: не «замена», ссылка нормализована')
      assert.equal(q(`select description from public.contract_audit_log where contract_id = '${c2}' and event_type = 'signal_link'`), 'Signal: связь подтверждена')
    }
    // Пустая после нормализации ожидаемая ссылка для unlink — invalid.
    const e0 = seed.contract({ number: 'Старый-40', objectId: o, signalLink: url(f) })
    assert.equal(db.asError(ed, unlinkSql(e0, ' \u00a0', 0, 'ux')).message, 'invalid')
  })

  it('С-53 / С-54: отказ действует, пока тот же контекст И тот же вид папки; смена контекста или вида переоткрывает пару, прежнее решение уходит в prev_*, а не теряется', () => {
    const o = seed.object({ code: 'СТЕ' })
    const ed = seed.user({ contracts: 'edit', objectIds: [o], objectScoped: true })
    const src = seed.source({ objectIds: [o] })
    const snap = seed.snapshot(src.id, { name: 'RK', children: [{ name: 'Папка К1' }, { name: 'Папка К2' }] }, { generation: gen() })
    const k1 = snap.ids['RK / Папка К1']
    const k2 = snap.ids['RK / Папка К2']
    const c = seed.contract({ number: 'Старый-50', objectId: o })
    q(`delete from osp_private.signal_queue where contract_id = '${c}'`)
    const cand = (n, score, extra = {}) => ({ nodeId: n, score, reasons: ['number'], flags: [], ...extra })
    const pair = (n) => q(`select status || '|' || coalesce(ctx_key, '-') || '|' || coalesce(node_key, '-') || '|' || coalesce(prev_status, '-') || '|' || coalesce(prev_note, '-') || '|' || (prev_decided_by is not null)::text || '|' || (prev_decided_at is not null)::text
      from osp_private.signal_candidates where contract_id = '${c}' and node_id = '${n}'`)
    assert.equal(write(c, { revision: null, ctxKey: 'ctx-1', candidates: [cand(k1, 80, { nodeKey: 'nk-a' }), cand(k2, 50, { nodeKey: 'nk-b' })] }).written, 1)
    assert.equal(pair(k1), 'open|ctx-1|nk-a|-|-|false|false')
    const ver = () => Number(stateRow(c).split('|')[1])
    // Отказ: ctx_key и вид папки (node_key) запоминаются.
    const rej = db.asJson(ed, `select osp_private.signal_reject('${c}', '${k1}', 'не наша', 'ctx-1', ${ver()}, 'r1', 'nk-a')`)
    assert.deepEqual([rej.state, rej.reason], ['suggested', null])
    assert.equal(pair(k1), 'rejected|ctx-1|nk-a|-|-|false|false')
    // Старый вызов без вида папки (6 аргументов) работает; вид остаётся прежним (null → не затирает).
    assert.equal(db.asJson(ed, `select osp_private.signal_reject('${c}', '${k2}', null, 'ctx-1', ${ver()}, 'r2')`).state, 'none')
    assert.equal(pair(k2), 'rejected|ctx-1|nk-b|-|-|false|false', 'вид, записанный расчётом, сохранён')
    // Матчер получает решённые пары вместе с видом папки.
    const loaded = j(`select osp_private.signal_match_load(array['${c}']::uuid[])`).contracts[0].candidates
    assert.deepEqual(loaded.map((x) => `${x.status}:${x.ctxKey}:${x.nodeKey}`).sort(), ['rejected:ctx-1:nk-a', 'rejected:ctx-1:nk-b'])
    // Тот же контекст и тот же вид — пара остаётся отклонённой (расчёт её не предлагает; если предложит — не переоткрывает).
    assert.equal(write(c, { revision: null, ctxKey: 'ctx-1', candidates: [cand(k1, 90, { nodeKey: 'nk-a' })] }).written, 1)
    assert.equal(pair(k1), 'rejected|ctx-1|nk-a|-|-|false|false')
    // Папку переименовали в точный номер (вид изменился), контекст тот же: пара открыта, прежний отказ сохранён в prev_*.
    assert.equal(write(c, { revision: null, ctxKey: 'ctx-1', candidates: [cand(k1, 95, { nodeKey: 'nk-a2' })] }).written, 1)
    assert.equal(pair(k1), 'open|ctx-1|nk-a2|rejected|не наша|true|true', 'С-53: вид сменился — снова предложена; С-54: прежнее решение в prev_*')
    // Контекст договора сменился — вторая пара открывается так же, причина отказа не теряется (у неё её не было — null).
    assert.equal(write(c, { revision: null, ctxKey: 'ctx-2', candidates: [cand(k2, 60, { nodeKey: 'nk-b' })] }).written, 1)
    assert.equal(pair(k2), 'open|ctx-2|nk-b|rejected|-|true|true')
    // В окне открытая пара показывает, что её уже отклоняли.
    const w = db.asJson(ed, `select osp_private.signal_contract_view('${c}')`)
    assert.deepEqual(w.candidates.map((x) => x.prevStatus), ['rejected'])
    // «Отвязать» запоминает вид папки; та же пара после смены вида возвращается с prev_status = unlinked.
    const u = seed.contract({ number: 'Старый-51', objectId: o, signalLink: url(k1) })
    q(`delete from osp_private.signal_queue where contract_id = '${u}'`)
    assert.equal(write(u, { revision: null, state: 'verified', reason: 'existing_url', nodeId: k1, ctxKey: 'cx', stateVersion: 0, signalLink: url(k1) }).written, 1)
    db.asJson(ed, unlinkSql(u, url(k1), 1, 'ul-1', null).replace("'ctx', ", "'cx', ").replace(/\)$/, ", 'nk-u')"))
    assert.equal(q(`select status || '|' || ctx_key || '|' || node_key from osp_private.signal_candidates where contract_id = '${u}' and node_id = '${k1}'`), 'unlinked|cx|nk-u')
    const wr = j(`select osp_private.signal_state_write(null, '${JSON.stringify([{ contractId: u, revision: null, generation: gen(), state: 'suggested', ctxKey: 'cx', candidates: [cand(k1, 70, { nodeKey: 'nk-u2' })] }])}'::jsonb)`)
    assert.equal(wr.written, 1)
    assert.equal(q(`select status || '|' || prev_status from osp_private.signal_candidates where contract_id = '${u}' and node_id = '${k1}'`), 'open|unlinked')
  })

  it('С-16: signal_enqueue_missed ставит правкой договоры без состояния и с updated_at новее состояния, у которых нет строки очереди; удалённых и уже стоящих в очереди — нет', () => {
    const o = seed.object({ code: 'СТЖ' })
    const a = seed.contract({ number: 'Старый-60', objectId: o })
    const b = seed.contract({ number: 'Старый-61', objectId: o })
    const c = seed.contract({ number: 'Старый-62', objectId: o })
    const gone = seed.contract({ number: 'Старый-63', objectId: o, deleted: true })
    q('delete from osp_private.signal_queue')
    // a обработан и актуален; b правили позже состояния (триггер «пропустил» постановку — строки нет); c состояния не имеет; gone удалён.
    q(`insert into osp_private.signal_contracts (contract_id, state, updated_at) values ('${a}', 'none', now() + interval '1 hour'), ('${b}', 'none', now() - interval '1 hour')`)
    q(`update public.contracts set updated_at = now() where id in ('${a}', '${b}', '${c}', '${gone}')`)
    q('delete from osp_private.signal_queue')
    const missed = Number(q('select osp_private.signal_enqueue_missed()'))
    assert.ok(missed >= 2)
    assert.equal(queueRev(a), null, 'состояние новее правки — не пропущен')
    assert.ok(queueRev(b) > 0 && queueRev(c) > 0)
    assert.equal(q(`select recheck_only from osp_private.signal_queue where contract_id = '${b}'`), 'f', 'настоящая правка, а не плановая пересверка')
    assert.equal(queueRev(gone), null)
    const rev = queueRev(b)
    assert.equal(Number(q('select osp_private.signal_enqueue_missed()')), 0, 'уже в очереди — повтор ничего не делает')
    assert.equal(queueRev(b), rev)
    // Лимит за вызов.
    q('delete from osp_private.signal_queue')
    assert.equal(Number(q('select osp_private.signal_enqueue_missed(1)')), 1)
    // Очередь занята в другой сессии — тихо 0, не ждёт и не падает.
    q('delete from osp_private.signal_queue')
    assert.equal(q('select osp_private.signal_enqueue_missed()') >= '0', true)
  })

  it('С-6 / С-2: синоним не должен совпадать с названием или кодом другого объекта (создание, подтверждение с синонимом); после переименования сопоставитель такой синоним не получает, список помечает conflict; сотрудник видит и удаляет только свои', () => {
    const A = seed.object({ name: 'Тест: ЖК Альфа', code: 'СТЗ' })
    const B = seed.object({ name: 'Тест: ЖК Бета', code: 'СТИ' })
    const edA = seed.user({ contracts: 'edit', objectIds: [A], objectScoped: true })
    const edA2 = seed.user({ contracts: 'edit', objectIds: [A], objectScoped: true })
    const edB = seed.user({ contracts: 'edit', objectIds: [B], objectScoped: true })
    const admin = seed.admin()
    const create = (uid, obj, text, key) => db.asError(uid, `select osp_private.signal_alias_create('${obj}', '${text}', '${key}')`)
    // Название и код другого объекта (в нормализации сопоставителя) — alias_taken; своё — можно.
    assert.equal(create(edA, A, 'Тест: ЖК Бета', 'тест: жк бета')?.message, 'alias_taken', 'название другого объекта')
    assert.equal(create(edA, A, 'Кавычки «Тест: ЖК Бета»', 'тест: жк бета')?.message, 'alias_taken', 'нормализация: кавычки и регистр')
    assert.equal(create(edA, A, 'СТИ', 'сти')?.message, 'alias_taken', 'код другого объекта')
    assert.equal(create(edA, A, 'Тест: ЖК Альфа 2', 'тест: жк альфа 2'), null)
    assert.equal(create(edA, A, 'Тест: ЖК Альфа', 'тест: жк альфа'), null, 'название своего объекта — не чужое')
    // Подтверждение с «запомнить название» — то же правило в базе.
    const src = seed.source({ objectIds: [A] })
    const snap = seed.snapshot(src.id, { name: 'RA', children: [{ name: 'Папка' }] }, { generation: gen() })
    const c = seed.contract({ number: 'Старый-70', objectId: A })
    const before = `${linkOf(c)}|${stateRow(c)}`
    assert.equal(db.asError(edA, confirmSql(c, snap.ids['RA / Папка'], 0, 'ka1', { alias: 'ЖК Бета?', aliasKey: 'тест: жк бета' }))?.message, 'alias_taken')
    assert.equal(`${linkOf(c)}|${stateRow(c)}`, before, 'подтверждение откатилось целиком')
    // Объект Б переименовали в название, которое уже занято синонимом объекта А: триггер объектов не отказывает.
    q(`update public.objects set name = 'Тест: ЖК Альфа 2' where id = '${B}'`)
    const loaded = j(`select osp_private.signal_match_load('{}'::uuid[])`).objects
    const aliasesOf = (id) => loaded.find((x) => x.id === id).aliases.map((x) => x.key).sort()
    assert.deepEqual(aliasesOf(A), ['тест: жк альфа'], 'синоним, совпавший с названием другого объекта, сопоставителю не отдаётся')
    // Список: администратору — все, помечены conflict; сотруднику — только его собственные в его охвате.
    const all = db.asJson(admin, 'select osp_private.signal_alias_list()').items
    assert.deepEqual(all.map((x) => [x.text, x.conflict]).sort(), [['Тест: ЖК Альфа', false], ['Тест: ЖК Альфа 2', true]].sort())
    assert.ok(all.every((x) => typeof x.mine === 'boolean'))
    db.asJson(edB, `select osp_private.signal_alias_create('${B}', 'Бета Плюс', 'бета плюс')`)
    db.asJson(edA2, `select osp_private.signal_alias_create('${A}', 'Чужой автор', 'чужой автор')`)
    const mine = db.asJson(edA, 'select osp_private.signal_alias_list()').items
    assert.deepEqual(mine.map((x) => x.text).sort(), ['Тест: ЖК Альфа', 'Тест: ЖК Альфа 2'], 'только свои: чужого автора и другого объекта нет')
    assert.ok(mine.every((x) => x.mine === true))
    assert.deepEqual(db.asJson(edB, 'select osp_private.signal_alias_list()').items.map((x) => x.text), ['Бета Плюс'])
    assert.equal(db.asJson(admin, 'select osp_private.signal_alias_list()').items.length, 4)
    // Свой синоним сотрудник удаляет; чужой — нет.
    const own = mine.find((x) => x.text === 'Тест: ЖК Альфа 2')
    const foreign = db.asJson(admin, 'select osp_private.signal_alias_list()').items.find((x) => x.text === 'Чужой автор')
    assert.deepEqual(db.asJson(edA, `select osp_private.signal_alias_delete(${own.id})`), { ok: true })
    assert.equal(db.asError(edA, `select osp_private.signal_alias_delete(${foreign.id})`).code, 'SG403')
    // Просмотр — не правка: списка нет.
    assert.equal(db.asError(seed.user({ contracts: 'view', objectIds: [A] }), 'select osp_private.signal_alias_list()').code, 'SG403')
    // Код объекта сменили на ключ синонима другого объекта.
    q(`update public.objects set contract_code = 'БЕТАПЛЮС' where id = '${A}'`)
    assert.deepEqual(db.asJson(edB, 'select osp_private.signal_alias_list()').items.map((x) => x.conflict), [false], 'ключ «бета плюс» с кодом «БЕТАПЛЮС» разный (пробел)')
    q(`update public.objects set contract_code = 'БЕТА' where id = '${A}'`)
    q(`insert into osp_private.signal_aliases (object_id, alias_text, alias_key) values ('${B}', 'Бета', 'бета')`)
    assert.equal(db.asJson(admin, 'select osp_private.signal_alias_list()').items.find((x) => x.text === 'Бета').conflict, true, 'ключ синонима равен коду другого объекта')
    assert.ok(!j(`select osp_private.signal_match_load('{}'::uuid[])`).objects.find((x) => x.id === B).aliases.some((x) => x.key === 'бета'))
  })

  it('идемпотентность и версии не сломаны: повтор ключа возвращает тот же ответ после изменений в очереди', () => {
    const o = seed.object({ code: 'СТК' })
    const ed = seed.user({ contracts: 'edit', objectIds: [o], objectScoped: true })
    const src = seed.source({ objectIds: [o] })
    const snap = seed.snapshot(src.id, { name: 'RI', children: [{ name: 'Папка И' }] }, { generation: gen() })
    const f = snap.ids['RI / Папка И']
    const c = seed.contract({ number: 'Старый-80', objectId: o })
    const first = db.asJson(ed, confirmSql(c, f, 0, 'same', { rev: queueRev(c) }))
    q(`update public.contracts set contract_number = 'Старый-81' where id = '${c}'`)
    assert.deepEqual(db.asJson(ed, confirmSql(c, f, 0, 'same', { rev: queueRev(c) })), first)
    assert.equal(q(`select count(*) from public.contract_audit_log where contract_id = '${c}' and event_type = 'signal_link'`), '1')
    assert.ok(uuid('a', 1))
  })
})
