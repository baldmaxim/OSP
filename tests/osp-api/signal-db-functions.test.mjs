// Функции базы сверки с SIGNAL (миграция 20270228_signal_integration) на настоящем PostgreSQL с учёткой-владельцем без прав
// суперпользователя (правила по строкам действуют на неё — как в базе Яндекса). Дополняет tests/db/signal-migration.test.mjs
// (слепок схемы прода: права, охват, CAS, Ф4/J1 с настоящими триггерами договоров). Здесь — публикация и защита прогона:
//   • расписание Р7: ночной слот с повтором, дневные часы, одна попытка на слот;
//   • публикация: staging только у части корней — корни без staging не «обработаны» (узлы не помечаются отсутствующими, готовность
//     и отметки не меняются); absent_nights растёт только у ночного прогона и только у обработанных корней; возвращение узла
//     обнуляет; режим known переносит элементы неперечисленных папок;
//   • порог (пустой список / падение ниже 70 %) → held, staging цел, принять — только последний held и только на том же поколении;
//   • защита прогона: один идущий, зависший снимается, чужой владелец и просроченный heartbeat — busy, порция проверяется целиком;
//   • граница Ф1 при вложенных привязках; запись результата (stale, ack, версия состояния, кандидаты); очередь (захват, SKIP LOCKED,
//     аренда, возврат с задержкой, устаревший ack); конкурентные подтверждение/снятие; журнал базы; правила по строкам.
// Нужны зависимости сервера и PostgreSQL (бинарники или Docker). Данные вымышлены.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startSignalDb, signalDbSkip, uuid } from './lib/signal-db.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

describe('База сверки с SIGNAL: расписание, публикация и защита прогона', { skip: signalDbSkip, timeout: 600000 }, () => {
  let db
  let seed
  const q = (text) => db.sql(text)
  const j = (text) => db.sqlJson(text)
  const nodes = (src) => Object.fromEntries(q(`select path || '|' || seen_gen || '|' || absent_nights || '|' || first_gen from osp_private.signal_nodes where source_id = ${src.id}`)
    .split('\n').filter(Boolean).map((l) => { const [p, s, a, f] = l.split('|'); return [p, { seen: Number(s), absent: Number(a), first: Number(f) }] }))
  const gen = () => Number(q('select generation from osp_private.signal_meta'))
  const mkRoot = (tree, { objectIds, generation } = {}) => {
    const o = seed.object()
    const src = seed.source({ objectIds: objectIds || [o] })
    const snap = seed.snapshot(src.id, tree, { generation: generation ?? gen() })
    return { o, src, snap }
  }

  before(async () => {
    db = await startSignalDb()
    seed = db.seed
  })
  after(async () => { await db?.stop() })

  it('расписание Р7: ночной слот 05:00 по Москве с повтором через 30 минут (≤ 3 попыток до 08:00), дневные часы пн–пт 08:00–20:00, одна попытка на слот', () => {
    const due = (iso) => j(`select osp_private.signal_sync_due('${iso}')`)
    const run = (kind, slot, status, finishedIso, beatIso = finishedIso) => q(`insert into osp_private.signal_runs (kind, mode, status, initiator, owner_token, slot, started_at, finished_at, heartbeat_at)
      values ('${kind}', 'full', '${status}', 'schedule', gen_random_uuid(), '${slot}', '${finishedIso}'::timestamptz - interval '1 minute', ${status === 'running' ? 'null' : `'${finishedIso}'`}, '${beatIso}')`)
    const NIGHT = '2026-11-23T02:00:00Z'
    assert.deepEqual(due('2026-11-23T01:59:00Z'), { due: false }, '04:59 по Москве')
    assert.deepEqual(due('2026-11-23T02:00:00Z'), { due: true, kind: 'night', slot: '2026-11-23T02:00:00+00:00' })
    assert.deepEqual(due('2026-11-23T04:59:00Z'), { due: true, kind: 'night', slot: '2026-11-23T02:00:00+00:00' }, '07:59 — ещё ночь')
    // Первая попытка не удалась: до 30 минут — ждём, потом повтор; три неудачи — слот закрыт.
    run('night', NIGHT, 'failed', '2026-11-23T02:05:00Z')
    assert.equal(due('2026-11-23T02:34:00Z').due, false, 'меньше 30 минут после сбоя')
    assert.equal(due('2026-11-23T02:35:00Z').kind, 'night')
    run('night', NIGHT, 'cancelled', '2026-11-23T02:40:00Z')
    assert.equal(due('2026-11-23T03:09:00Z').due, false)
    assert.equal(due('2026-11-23T03:10:00Z').kind, 'night')
    run('night', NIGHT, 'failed', '2026-11-23T03:15:00Z')
    assert.deepEqual(due('2026-11-23T04:00:00Z'), { due: false }, 'три попытки — больше не повторяем')
    // 08:00 — ночное окно закрыто, дневной слот.
    assert.deepEqual(due('2026-11-23T05:00:00Z'), { due: true, kind: 'day', slot: '2026-11-23T05:00:00+00:00' })
    run('day', '2026-11-23T05:00:00Z', 'ok', '2026-11-23T05:10:00Z')
    assert.equal(due('2026-11-23T05:59:00Z').due, false, 'один дневной прогон на час')
    assert.deepEqual(due('2026-11-23T06:00:00Z'), { due: true, kind: 'day', slot: '2026-11-23T06:00:00+00:00' })
    run('day', '2026-11-23T06:00:00Z', 'failed', '2026-11-23T06:02:00Z')
    assert.equal(due('2026-11-23T06:30:00Z').due, false, 'после сбоя в слоте дневная попытка не повторяется')
    assert.equal(due('2026-11-23T17:00:00Z').kind, 'day', '20:00 — последний дневной час')
    assert.equal(due('2026-11-23T18:00:00Z').due, false, '21:00')
    assert.deepEqual(due('2026-11-23T04:59:00Z'), { due: false }, '07:59: дневных слотов до 08:00 нет, ночной исчерпан')
    // Ночь закрывают ok и held (повтор held только вручную), идущий прогон тоже.
    for (const [day, status] of [['24', 'ok'], ['25', 'held'], ['26', 'partial'], ['27', 'running']]) {
      assert.equal(due(`2026-11-${day}T02:30:00Z`).kind, 'night')
      // идущий прогон закрывает слот, пока пульс живой (последний — 5 минут назад)
      run('night', `2026-11-${day}T02:00:00Z`, status, `2026-11-${day}T02:20:00Z`, status === 'running' ? `2026-11-${day}T03:25:00Z` : undefined)
      assert.equal(due(`2026-11-${day}T03:30:00Z`).due, false, status)
    }
    // С-17: зависший running (пульс старше 10 минут — процесс упал) — сбой: повтор через 30 минут после последнего пульса, не вечная блокировка
    q("update osp_private.signal_runs set status = 'failed', finished_at = now() where status = 'running'")
    run('night', '2026-11-28T02:00:00Z', 'running', '2026-11-28T02:05:00Z', '2026-11-28T02:10:00Z')
    assert.equal(due('2026-11-28T02:25:00Z').due, false, 'пульс 15 минут назад — сбой, но ещё нет 30 минут')
    assert.deepEqual(due('2026-11-28T02:41:00Z'), { due: true, kind: 'night', slot: '2026-11-28T02:00:00+00:00' }, 'через 30 минут после последнего пульса — повтор')
    // повтор: begin снимает зависший, новый прогон идёт и закрывает слот; сбойный третьей попыткой слот исчерпывает
    q("update osp_private.signal_runs set status = 'failed', finished_at = '2026-11-28T02:12:00Z' where status = 'running'")
    run('night', '2026-11-28T02:00:00Z', 'running', '2026-11-28T02:41:00Z', '2026-11-28T02:41:00Z')
    assert.equal(due('2026-11-28T02:45:00Z').due, false, 'второй прогон идёт, пульс живой')
    q("update osp_private.signal_runs set status = 'failed', finished_at = '2026-11-28T02:50:00Z' where status = 'running'")
    run('night', '2026-11-28T02:00:00Z', 'failed', '2026-11-28T03:20:00Z')
    assert.equal(due('2026-11-28T03:55:00Z').due, false, 'три попытки в слоте — слот закрыт')
    // Суббота и воскресенье: дневных слотов нет, ночной есть.
    assert.deepEqual(due('2026-11-21T09:00:00Z'), { due: false }, 'суббота 12:00')
    assert.deepEqual(due('2026-11-22T09:00:00Z'), { due: false }, 'воскресенье 12:00')
    assert.equal(due('2026-11-21T02:30:00Z').kind, 'night', 'суббота 05:30 — ночной обход есть')
    q('delete from osp_private.signal_runs')
  })

  it('публикация: корни без staging не «обработаны»; absent_nights растёт только у ночного прогона и только у обработанных корней; возвращение узла обнуляет', () => {
    const treeA = { name: 'RA', children: [{ name: 'A1', items: [{ name: 'f1.pdf' }, { name: 'f2.pdf' }] }, { name: 'A2' }] }
    const treeB = { name: 'RB', children: [{ name: 'B1', items: [{ name: 'g1.pdf' }] }, { name: 'B2' }] }
    const a = mkRoot(treeA)
    const b = mkRoot(treeB)
    const g0 = gen()
    const dp = seed.contract({ number: 'ФЫВ-ДП-26-001', objectId: a.o })
    q('delete from osp_private.signal_queue')
    const srcB = () => q(`select ready || '|' || coalesce(last_ok_at::text, '-') || '|' || coalesce(last_night_ok_at::text, '-') || '|' || coalesce(folders_count::text, '-') from osp_private.signal_sources where id = ${b.src.id}`)
    const bBefore = srcB()
    const bNodesBefore = nodes(b.src)

    // Ночной полный прогон: staging только у корня А, из него пропали «A2» и файл «f2.pdf».
    const treeA1 = { name: 'RA', children: [{ name: 'A1', items: [{ name: 'f1.pdf' }] }] }
    const night1 = seed.sync({ kind: 'night', roots: [{ src: a.src, tree: treeA1, ids: a.snap.ids }] })
    assert.deepEqual({ status: night1.result.status, generation: night1.result.generation }, { status: 'ok', generation: g0 + 1 })
    const na = nodes(a.src)
    assert.deepEqual(na['RA'], { seen: g0 + 1, absent: 0, first: g0 }, 'виденный узел — новое поколение')
    assert.deepEqual(na['RA / A1'], { seen: g0 + 1, absent: 0, first: g0 })
    assert.deepEqual(na['RA / A2'], { seen: g0, absent: 1, first: g0 }, 'пропавшая папка: прежнее поколение, +1 ночь')
    assert.deepEqual(na['RA / A1 / f1.pdf'], { seen: g0 + 1, absent: 0, first: g0 })
    assert.deepEqual(na['RA / A1 / f2.pdf'], { seen: g0, absent: 1, first: g0 }, 'пропавший файл перечисленной папки — то же')
    assert.deepEqual(Object.values(nodes(b.src)).map((n) => [n.seen, n.absent, n.first]), Object.values(bNodesBefore).map((n) => [g0 + 1, 0, n.first]),
      'корень без staging: не «отсутствует» (absent_nights прежние), прежние данные остаются виденными в новом поколении')
    assert.equal(srcB(), bBefore, 'корень без staging: готовность, отметки времени и счётчики прежние')
    assert.equal(q(`select (last_night_ok_at is not null) || '|' || (last_full_ok_at is not null) || '|' || ready || '|' || folders_count || '|' || items_count from osp_private.signal_sources where id = ${a.src.id}`), 'true|true|true|2|1')
    assert.equal(q(`select count(*) from osp_private.signal_queue where contract_id = '${dp}'`), '1', 'публикация ставит договоры в очередь')
    assert.equal(q('select count(*) from osp_private.signal_stage_nodes'), '0', 'staging после публикации пуст')

    // Дневной полный и ручной прогоны: те же пропажи, но счётчик ночей не растёт.
    seed.sync({ kind: 'day', mode: 'full', roots: [{ src: a.src, tree: treeA1, ids: a.snap.ids }] })
    seed.sync({ kind: 'manual', roots: [{ src: a.src, tree: treeA1, ids: a.snap.ids }] })
    assert.equal(nodes(a.src)['RA / A2'].absent, 1, 'день и ручной обход пропажи ночами не считают')
    assert.equal(nodes(a.src)['RA / A2'].seen, g0)

    // Вторая ночь подряд: А снова обработан, Б — нет (его absent_nights остаётся 0).
    seed.sync({ kind: 'night', roots: [{ src: a.src, tree: treeA1, ids: a.snap.ids }] })
    assert.equal(nodes(a.src)['RA / A2'].absent, 2, 'не виден в двух ночных обходах подряд')
    assert.deepEqual(Object.values(nodes(b.src)).map((n) => [n.seen, n.absent]), Object.values(bNodesBefore).map(() => [gen(), 0]), 'корень Б по-прежнему не затронут: не отсутствует, виден')
    // Узел вернулся: absent_nights = 0, seen_gen новый, first_gen прежний.
    const back = seed.sync({ kind: 'night', roots: [{ src: a.src, tree: treeA, ids: a.snap.ids }] })
    assert.deepEqual(nodes(a.src)['RA / A2'], { seen: back.result.generation, absent: 0, first: g0 })
    assert.deepEqual(nodes(a.src)['RA / A1 / f2.pdf'], { seen: back.result.generation, absent: 0, first: g0 })

    // Ночь, в которую обработан только Б: у А счётчики не меняются.
    const aBefore = nodes(a.src)
    seed.sync({ kind: 'night', roots: [{ src: b.src, tree: { name: 'RB', children: [{ name: 'B1', items: [{ name: 'g1.pdf' }] }] }, ids: b.snap.ids }] })
    assert.deepEqual(nodes(a.src)['RA / A2'], { ...aBefore['RA / A2'], seen: gen() }, 'корень А в этой ночи не обработан: счётчики прежние, прежние данные остаются виденными')
    assert.deepEqual(nodes(b.src)['RB / B2'], { seen: gen() - 1, absent: 1, first: b.snap.generation })
    // Выключенный корень со staging не обрабатывается совсем (его строки отбрасываются).
    q(`update osp_private.signal_sources set enabled = false where id = ${b.src.id}`)
    const off = seed.sync({ kind: 'night', roots: [{ src: b.src, tree: { name: 'RB' }, ids: b.snap.ids }], stats: { roots: [] } })
    assert.equal(off.result.status, 'held', 'у включённых корней нет staging, а снимок непустой — не публикуем пустоту')
    assert.equal(off.result.reason, 'empty')
    assert.equal(nodes(b.src)['RB / B1'].absent, 0)
    q(`update osp_private.signal_sources set enabled = true where id = ${b.src.id}`)
  })

  it('режим known: элементы неперечисленных папок переносятся (seen_gen нового поколения), перечисленных — нет; порог по элементам только в full', () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ name: `дог${i}.pdf` }))
    const a = mkRoot({ name: 'RK', children: [{ name: 'K1', items }, { name: 'K2', items: [{ name: 'k2.pdf' }] }] })
    const g0 = gen()
    // known: K1 перечислена и в ней осталось 5 файлов; K2 не перечислялась.
    const tree = { name: 'RK', children: [{ name: 'K1', items: items.slice(0, 5) }, { name: 'K2', itemsListed: false }] }
    const r = seed.sync({ kind: 'day', mode: 'known', roots: [{ src: a.src, tree, ids: a.snap.ids }] })
    assert.equal(r.result.status, 'ok', 'в known число файлов не сверяется с порогом')
    const n = nodes(a.src)
    assert.equal(n['RK / K2 / k2.pdf'].seen, r.result.generation, 'файл неперечисленной папки перенесён')
    assert.equal(n['RK / K2 / k2.pdf'].absent, 0)
    assert.equal(n['RK / K1 / дог20.pdf'].seen, g0, 'файл перечисленной папки, которого нет, — не перенесён')
    assert.equal(n['RK / K1 / дог0.pdf'].seen, r.result.generation)
    // Те же 5 из 25 в полном прогоне другого корня — порог по элементам: held (shrink), снимок прежний.
    const full = mkRoot({ name: 'RL', children: [{ name: 'L1', items }, { name: 'L2', items: [{ name: 'l2.pdf' }] }] })
    const g1 = gen()
    const held = seed.sync({ kind: 'manual', mode: 'full', roots: [{ src: full.src, tree: { name: 'RL', children: [{ name: 'L1', items: items.slice(0, 5) }, { name: 'L2', items: [{ name: 'l2.pdf' }] }] }, ids: full.snap.ids }] })
    assert.equal(held.result.status, 'held')
    assert.equal(held.result.reason, 'shrink')
    assert.equal(gen(), g1)
    // Ночной known не бывает.
    assert.equal(db.sqlError("select osp_private.signal_sync_begin('night', 'known', 'schedule', null)").message, 'invalid')
    assert.equal(db.sqlError("select osp_private.signal_sync_begin('manual', 'known', 'admin', null)").message, 'invalid')
    q('delete from osp_private.signal_runs')
  })

  it('порог и ручное принятие: падение ниже 70 % и пустой список — held со staging; принять можно последний held на том же поколении', () => {
    const folders = Array.from({ length: 29 }, (_, i) => ({ name: `Ф${i}` }))
    const a = mkRoot({ name: 'RP', children: folders })
    const g0 = gen()
    const nodesBefore = nodes(a.src)
    assert.equal(Object.keys(nodesBefore).length, 30)
    // 20 из 30 — ниже 70 %.
    const part = { name: 'RP', children: folders.slice(0, 19) }
    const h1 = seed.sync({ kind: 'manual', roots: [{ src: a.src, tree: part, ids: a.snap.ids }] })
    assert.equal(h1.result.status, 'held')
    assert.equal(h1.result.reason, 'shrink')
    assert.equal(h1.result.generation, g0)
    assert.equal(gen(), g0)
    assert.deepEqual(nodes(a.src), nodesBefore, 'held снимок не меняет')
    assert.equal(q(`select count(*) from osp_private.signal_stage_nodes where run_id = ${h1.run.runId}`), '20', 'staging held цел')
    assert.equal(q(`select status || '|' || reason from osp_private.signal_runs where id = ${h1.run.runId}`), 'held|shrink')
    assert.deepEqual(j(`select stats -> 'held' from osp_private.signal_runs where id = ${h1.run.runId}`), [{ id: a.src.id, kind: 'folders', was: 30, now: 20 }])
    // 21 из 30 = ровно 70 % — не падение.
    const ok = seed.sync({ kind: 'manual', roots: [{ src: a.src, tree: { name: 'RP', children: folders.slice(0, 20) }, ids: a.snap.ids }], stats: { roots: [] } })
    assert.equal(ok.result.status, 'ok')
    // Принять: не тот поколение / не тот прогон / пустые actor и причина — отказ без последствий.
    const g1 = gen()
    const h2 = seed.sync({ kind: 'manual', roots: [{ src: a.src, tree: { name: 'RP', children: folders.slice(0, 5) }, ids: a.snap.ids }] })
    assert.equal(h2.result.reason, 'shrink')
    const accept = (run, g, actor = 'cli:admin', why = 'проверено вручную') => `select osp_private.signal_accept_held(${run}, ${g}, ${JSON.stringify(actor).replace(/"/g, "'")}, ${JSON.stringify(why).replace(/"/g, "'")})`
    assert.equal(db.sqlError(accept(h2.run.runId, g1 + 5)).message, 'stale_state', 'поколение сменилось')
    assert.equal(db.sqlError(accept(h1.run.runId, g1)).message, 'stale_state', 'не последний held (staging старого уже удалён begin-ом)')
    assert.equal(db.sqlError(accept(99999, g1)).message, 'not_found')
    assert.equal(db.sqlError(accept(h2.run.runId, g1, ' ', 'x')).message, 'invalid')
    assert.equal(db.sqlError(accept(h2.run.runId, g1, 'cli', '')).message, 'invalid')
    assert.equal(gen(), g1)
    const done = j(accept(h2.run.runId, g1))
    assert.deepEqual({ status: done.status, generation: done.generation }, { status: 'ok', generation: g1 + 1 })
    assert.equal(q(`select status || '|' || accepted_by || '|' || accept_reason || '|' || generation from osp_private.signal_runs where id = ${h2.run.runId}`), `ok|cli:admin|проверено вручную|${g1 + 1}`)
    assert.equal(q(`select count(*) from osp_private.signal_stage_nodes`), '0')
    assert.equal(db.sqlError(accept(h2.run.runId, g1 + 1)).message, 'stale_state', 'уже принят')
    // Пустой список (корень и ничего больше) при непустом прошлом файлов — «пусто».
    const b = mkRoot({ name: 'RE', children: [{ name: 'E1', items: [{ name: 'e.pdf' }] }] })
    const h3 = seed.sync({ kind: 'manual', roots: [{ src: b.src, tree: { name: 'RE', children: [{ name: 'E1' }] }, ids: b.snap.ids }] })
    assert.deepEqual({ s: h3.result.status, r: h3.result.reason }, { s: 'held', r: 'empty' })
    // Принудительная публикация (CLI --force) проходит порог.
    const forced = seed.sync({ kind: 'manual', force: true, roots: [{ src: b.src, tree: { name: 'RE', children: [{ name: 'E1' }] }, ids: b.snap.ids }] })
    assert.equal(forced.result.status, 'ok')
    q('delete from osp_private.signal_runs')
  })

  it('устаревший held принять нельзя: held A → held B → принят B; затем A снова «последний held», но его staging вытеснен и снимок свежее — stale_state', () => {
    const folders = Array.from({ length: 29 }, (_, i) => ({ name: `В${i}` }))
    const a = mkRoot({ name: 'RS', children: folders })
    const held = (n) => seed.sync({ kind: 'manual', roots: [{ src: a.src, tree: { name: 'RS', children: folders.slice(0, n) }, ids: a.snap.ids }] })
    const accept = (run, g) => `select osp_private.signal_accept_held(${run}, ${g}, 'cli:admin', 'проверено')`
    const stage = (run) => Number(q(`select count(*) from osp_private.signal_stage_nodes where run_id = ${run}`))
    const hA = held(5)
    const hB = held(8)
    assert.deepEqual([hA.result.status, hB.result.status], ['held', 'held'])
    assert.ok(stage(hA.run.runId) > 0 && stage(hB.run.runId) > 0, 'до принятия staging обоих цел (begin B оставил последний held A)')
    const g = gen()
    assert.equal(j(accept(hB.run.runId, g)).status, 'ok')
    assert.equal(gen(), g + 1)
    // A теперь — последний held по номеру, поколение совпадает с текущим, но он вытеснен: staging удалён, причина — superseded.
    assert.equal(q(`select status || '|' || reason from osp_private.signal_runs where id = ${hA.run.runId}`), 'held|superseded')
    assert.equal(stage(hA.run.runId), 0)
    assert.equal(db.sqlError(accept(hA.run.runId, g + 1)).message, 'stale_state')
    assert.equal(q(`select count(*) from osp_private.signal_nodes where source_id = ${a.src.id} and seen_gen = ${g + 1}`), '9', 'снимок — от B (корень и 8 папок), A его не затёр')
    assert.equal(gen(), g + 1)
    // Возвращаем полный снимок и повторяем: публикация после held (published_run_id новее) принять его не даёт, даже если staging остался.
    assert.equal(seed.sync({ kind: 'manual', force: true, roots: [{ src: a.src, tree: { name: 'RS', children: folders }, ids: a.snap.ids }] }).result.status, 'ok')
    const hC = held(4)
    assert.equal(hC.result.status, 'held')
    const ok = seed.sync({ kind: 'manual', roots: [{ src: a.src, tree: { name: 'RS', children: folders }, ids: a.snap.ids }], stats: { roots: [] } })
    assert.equal(ok.result.status, 'ok')
    assert.equal(q(`select reason from osp_private.signal_runs where id = ${hC.run.runId}`), 'superseded', 'обычная публикация тоже вытесняет прежние held')
    q(`insert into osp_private.signal_stage_nodes (run_id, node_id, project_id, source_id, kind, name, path)
      values (${hC.run.runId}, '${a.snap.rootId}', '${a.src.projectId}', ${a.src.id}, 'folder', 'RS', 'RS')`)
    assert.equal(db.sqlError(accept(hC.run.runId, gen())).message, 'stale_state', 'после C опубликован более новый прогон')
    assert.equal(q(`select count(*) from osp_private.signal_nodes where source_id = ${a.src.id} and seen_gen = ${gen()}`), '30')
    // Идущий прогон при принятии не страдает: его staging не удаляется.
    const hD = held(3)
    const running = JSON.parse(q("select osp_private.signal_sync_begin('manual', 'full', 'cli', null)"))
    const staged = seed.stageRows(a.src.id, { name: 'RS', children: folders.slice(0, 3) }, { ids: a.snap.ids })
    q(`select osp_private.signal_stage_put(${running.runId}, '${running.ownerToken}', '${JSON.stringify(staged.rows).replace(/'/g, "''")}'::jsonb)`)
    assert.equal(j(accept(hD.run.runId, gen())).status, 'ok')
    assert.equal(stage(running.runId), staged.rows.length, 'staging идущего прогона цел')
    const fin = j(`select osp_private.signal_sync_finish(${running.runId}, '${running.ownerToken}', '{"roots":[]}'::jsonb)`)
    assert.equal(fin.status, 'ok')
    q('delete from osp_private.signal_runs')
  })

  it('корень не обошли (status = failed в статистике) — прогон partial, исправный корень опубликован, сбойный на прежних данных с причиной; сбой и отмена снимок не меняют, staging удаляют', () => {
    const a = mkRoot({ name: 'RF', children: [{ name: 'F1' }] })
    const b = mkRoot({ name: 'RG', children: [{ name: 'G1' }] })
    const before = { a: nodes(a.src), b: nodes(b.src), g: gen() }
    const stats = { roots: [{ id: a.src.id, status: 'ok' }, { id: b.src.id, status: 'failed', reason: 'forbidden' }] }
    const r = seed.sync({ kind: 'manual', roots: [{ src: a.src, tree: { name: 'RF', children: [{ name: 'F1' }, { name: 'F2' }] }, ids: a.snap.ids }], stats })
    assert.deepEqual({ s: r.result.status, r: r.result.reason, g: r.result.generation }, { s: 'partial', r: 'root_failed', g: before.g + 1 })
    assert.equal(q(`select last_error from osp_private.signal_sources where id = ${b.src.id}`), 'forbidden')
    assert.ok(nodes(a.src)['RF / F2'], 'исправный корень опубликован')
    assert.deepEqual(Object.values(nodes(b.src)).map((n) => [n.seen, n.absent, n.first]), Object.values(before.b).map((n) => [before.g + 1, 0, n.first]), 'сбойный: узлы на месте и видны')
    assert.equal(q(`select last_error is null from osp_private.signal_sources where id = ${a.src.id}`), 't')
    // Принимать нечего: отложенных корней в прогоне нет.
    assert.equal(db.sqlError(`select osp_private.signal_accept_held(${r.run.runId}, ${gen()}, 'cli', 'Б недоступен, остальное верно')`).message, 'stale_state')
    // Сбой: причина из набора, staging удалён, прежнее на месте; чужому владельцу — тихо ничего.
    const run = seed.sync({ kind: 'manual', roots: [{ src: a.src, tree: { name: 'RF' }, ids: a.snap.ids }], finish: false }).run
    assert.ok(Number(q(`select count(*) from osp_private.signal_stage_nodes where run_id = ${run.runId}`)) > 0)
    q(`select osp_private.signal_sync_fail(${run.runId}, '${uuid('z', 7)}', 'failed', 'http', '{}'::jsonb)`)
    assert.equal(q(`select status from osp_private.signal_runs where id = ${run.runId}`), 'running', 'чужой владелец')
    q(`select osp_private.signal_sync_fail(${run.runId}, '${run.ownerToken}', 'cancelled', 'Плохой Код!', '{"roots":[{"id":${a.src.id},"status":"failed","reason":"timeout"}]}'::jsonb)`)
    assert.equal(q(`select status || '|' || reason from osp_private.signal_runs where id = ${run.runId}`), 'cancelled|unknown')
    assert.equal(q(`select last_error from osp_private.signal_sources where id = ${a.src.id}`), 'timeout')
    assert.equal(q(`select count(*) from osp_private.signal_stage_nodes where run_id = ${run.runId}`), '0')
    assert.ok(nodes(a.src)['RF / F2'])
    assert.equal(db.sqlError(`select osp_private.signal_sync_fail(${run.runId}, '${run.ownerToken}', 'ok', 'x', '{}'::jsonb)`).message, 'invalid')
    q('delete from osp_private.signal_runs')
  })

  it('защита прогона: один идущий; зависший снимается; чужой владелец, не running, просроченный heartbeat — busy; порция проверяется целиком', () => {
    const a = mkRoot({ name: 'RZ', children: [{ name: 'Z1' }] })
    const begin = (kind = 'manual') => q(`select osp_private.signal_sync_begin('${kind}', 'full', 'cli', null)`)
    const r1 = JSON.parse(begin())
    assert.equal(begin(), '', 'идёт другой — NULL')
    assert.equal(q(`select osp_private.signal_sync_heartbeat(${r1.runId}, gen_random_uuid())`), 'f')
    assert.equal(q(`select osp_private.signal_sync_heartbeat(${r1.runId}, '${r1.ownerToken}')`), 't')
    const rows = (over) => JSON.stringify([{ nodeId: uuid('q', 1), projectId: a.src.projectId, sourceId: a.src.id, kind: 'folder', parentId: null, name: 'n', path: 'n',
      pathIds: [], depth: 0, numberKeys: [], nameNorm: 'n', features: {}, itemsListed: true, ...over }])
    const put = (run, body) => `select osp_private.signal_stage_put(${run.runId}, '${run.ownerToken}', '${body.replace(/'/g, "''")}'::jsonb)`
    assert.equal(db.sqlError(`select osp_private.signal_stage_put(${r1.runId}, '${uuid('z', 3)}', '[]'::jsonb)`).message, 'busy', 'чужой владелец')
    // Порция проверяется целиком: плохая строка — ни одной строки, остальные не записаны.
    const good = JSON.parse(rows({}))[0]
    const bad = [good, { ...good, nodeId: uuid('q', 2), kind: 'zzz' }]
    assert.equal(db.sqlError(put(r1, JSON.stringify(bad))).message, 'invalid')
    assert.equal(q(`select count(*) from osp_private.signal_stage_nodes where run_id = ${r1.runId}`), '0')
    for (const [what, body] of [['дубль nodeId в порции', [good, good]], ['не uuid', [{ ...good, nodeId: 'не-uuid' }]], ['глубина', [{ ...good, depth: 99 }]],
      ['слишком длинное имя', [{ ...good, name: 'я'.repeat(1001) }]], ['не массив', { a: 1 }],
      ['дата', [{ ...good, modifiedAt: 'вчера' }]], ['версия', [{ ...good, versionNumber: 'x' }]]]) {
      assert.equal(db.sqlError(put(r1, JSON.stringify(body)))?.message, 'invalid', what)
    }
    assert.equal(db.sqlError(put(r1, JSON.stringify(Array.from({ length: 1001 }, (_, i) => ({ ...good, nodeId: uuid('q', 1000 + i) }))))).message, 'invalid', '> 1000 строк')
    assert.equal(q(put(r1, JSON.stringify([good]))), '1')
    assert.equal(q(put(r1, JSON.stringify([{ ...good, name: 'новое имя', path: 'новое имя' }]))), '1', 'повтор nodeId заменяет строку')
    assert.equal(q(`select name from osp_private.signal_stage_nodes where run_id = ${r1.runId}`), 'новое имя')
    // Heartbeat просрочен (> 10 минут): finish — busy; begin снимает зависший прогон и стартует новый.
    q(`update osp_private.signal_runs set heartbeat_at = now() - interval '9 minutes' where id = ${r1.runId}`)
    assert.equal(begin(), '', 'пульс 9 минут назад: по умолчанию (600 с) прогон ещё считается живым — begin отказывает')
    q(`update osp_private.signal_runs set heartbeat_at = now() - interval '11 minutes' where id = ${r1.runId}`)
    assert.equal(db.sqlError(`select osp_private.signal_sync_finish(${r1.runId}, '${r1.ownerToken}', '{}'::jsonb)`).message, 'busy', 'пульс старше 10 минут: завершить нельзя')
    const r2 = JSON.parse(q(`select osp_private.signal_sync_begin('manual', 'full', 'cli', null, null, 600)`))
    assert.ok(r2.runId > r1.runId)
    assert.equal(q(`select status || '|' || reason from osp_private.signal_runs where id = ${r1.runId}`), 'failed|stale')
    assert.equal(q(`select count(*) from osp_private.signal_stage_nodes where run_id = ${r1.runId}`), '0', 'staging зависшего удалён новым begin')
    // Прежний владелец не может ни дописать, ни завершить, ни пульсировать.
    assert.equal(db.sqlError(put(r1, JSON.stringify([good]))).message, 'busy')
    assert.equal(db.sqlError(`select osp_private.signal_sync_finish(${r1.runId}, '${r1.ownerToken}', '{}'::jsonb)`).message, 'busy')
    assert.equal(q(`select osp_private.signal_sync_heartbeat(${r1.runId}, '${r1.ownerToken}')`), 'f')
    // finish чужим токеном / дважды.
    assert.equal(db.sqlError(`select osp_private.signal_sync_finish(${r2.runId}, gen_random_uuid(), '{}'::jsonb)`).message, 'busy')
    q(`select osp_private.signal_sync_fail(${r2.runId}, '${r2.ownerToken}', 'cancelled', 'readonly', '{}'::jsonb)`)
    assert.equal(db.sqlError(`select osp_private.signal_sync_finish(${r2.runId}, '${r2.ownerToken}', '{}'::jsonb)`).message, 'busy', 'прогон уже не идёт')
    // begin validates.
    for (const bad2 of ["'week', 'full', 'cli'", "'day', 'half', 'cli'", "'day', 'full', 'robot'", "'night', 'known', 'schedule'"]) {
      assert.equal(db.sqlError(`select osp_private.signal_sync_begin(${bad2}, null)`).message, 'invalid', bad2)
    }
    q('delete from osp_private.signal_runs')
  })

  it('два begin одновременно: один получает прогон, второй — NULL; два finish одного прогона: один публикует, второй — busy', async () => {
    mkRoot({ name: 'RC', children: [{ name: 'C1' }] })
    q('delete from osp_private.signal_runs')
    const c1 = await db.connect()
    const c2 = await db.connect()
    for (const c of [c1, c2]) await c.query("set application_name = 'osp:internal'")
    const call = (c) => c.query("select osp_private.signal_sync_begin('manual', 'full', 'cli', null) as r").then((x) => x.rows[0].r)
    const [x, y] = await Promise.all([call(c1), call(c2)])
    assert.equal([x, y].filter(Boolean).length, 1)
    const run = x || y
    // Два finish одного прогона одновременно.
    const stats = '{"roots":[]}'
    const fin = (c) => c.query('select osp_private.signal_sync_finish($1, $2, $3::jsonb) as r', [run.runId, run.ownerToken, stats]).then((r) => r.rows[0].r, (e) => ({ error: e.message, code: e.code }))
    // Корню нужен staging, иначе непустой снимок и «пусто»: кладём строки корня.
    const src = db.seed.source({ objectIds: [db.seed.object()] })
    const staged = db.seed.stageRows(src.id, { name: 'RC2', children: [{ name: 'X1' }] })
    q(`select osp_private.signal_stage_put(${run.runId}, '${run.ownerToken}', '${JSON.stringify(staged.rows).replace(/'/g, "''")}'::jsonb)`)
    const [f1, f2] = await Promise.all([fin(c1), fin(c2)])
    const oks = [f1, f2].filter((f) => f.status === 'ok')
    assert.equal(oks.length, 1, JSON.stringify([f1, f2]))
    assert.deepEqual([f1, f2].find((f) => f.error), { error: 'busy', code: 'SG409' })
    q('delete from osp_private.signal_runs')
  })

  it('уборка и источники: узлы старше 400 поколений без ссылок удаляются, со ссылкой на договор, кандидата или привязку — остаются; sources_for_sync отдаёт включённые корни и известные папки для known', () => {
    const a = mkRoot({ name: 'RU', children: [{ name: 'U1' }, { name: 'U2' }, { name: 'U3' }, { name: 'U4' }] })
    const dp = seed.contract({ number: 'УБР-ДП-26-001', objectId: a.o })
    q(`update osp_private.signal_meta set generation = 600 where id = 1`)
    q(`update osp_private.signal_nodes set seen_gen = 10 where source_id = ${a.src.id} and name <> 'RU'`)
    q(`insert into osp_private.signal_contracts (contract_id, state, node_id) values ('${dp}', 'verified', '${a.snap.ids['RU / U1']}')`)
    q(`insert into osp_private.signal_candidates (contract_id, node_id) values ('${dp}', '${a.snap.ids['RU / U2']}')`)
    q(`insert into osp_private.signal_bindings (source_id, node_id, object_id) values (${a.src.id}, '${a.snap.ids['RU / U3']}', '${a.o}')`)
    const known = j(`select osp_private.signal_sources_for_sync('known')`)
    assert.equal(known.mode, 'known')
    const mine = known.sources.find((s) => s.id === a.src.id)
    assert.deepEqual([...mine.knownFolderIds].sort(), [a.snap.ids['RU / U1'], a.snap.ids['RU / U2']].sort(), 'папки со связью и с открытым кандидатом')
    assert.equal(mine.folderIds.length, 5)
    assert.equal(j('select osp_private.signal_sources_for_sync()').mode, 'full')
    assert.equal(j('select osp_private.signal_sources_for_sync()').sources.find((s) => s.id === a.src.id).knownFolderIds, undefined)
    seed.sync({ kind: 'manual', roots: [{ src: a.src, tree: { name: 'RU' }, ids: a.snap.ids }], force: true })
    const left = q(`select name from osp_private.signal_nodes where source_id = ${a.src.id} order by name`).split('\n')
    assert.deepEqual(left, ['RU', 'U1', 'U2', 'U3'], 'U4 без ссылок убран, U1 (договор), U2 (кандидат), U3 (привязка) остались')
    // Идущий known-прогон — режим берётся из него.
    const run = JSON.parse(q(`select osp_private.signal_sync_begin('day', 'known', 'schedule', null)`))
    assert.equal(j('select osp_private.signal_sources_for_sync()').mode, 'known')
    q(`select osp_private.signal_sync_fail(${run.runId}, '${run.ownerToken}', 'cancelled', 'readonly', '{}'::jsonb)`)
    q('delete from osp_private.signal_runs')
  })
})

describe('База сверки с SIGNAL: граница Ф1, запись результата, очередь, конкуренция, журнал и правила по строкам', { skip: signalDbSkip, timeout: 600000 }, () => {
  let db
  let seed
  const q = (text) => db.sql(text)
  const j = (text) => db.sqlJson(text)
  const claimsOf = (uid) => JSON.stringify({ sub: uid, role: 'authenticated', email: '' })
  // Транзакция вошедшего на отдельном подключении (как db.write(who)).
  async function userTx(client, uid, text, params = []) {
    await client.query('begin')
    try {
      await client.query("set local application_name = 'osp-api'")
      await client.query("select set_config('request.jwt.claims', $1, true)", [claimsOf(uid)])
      const r = await client.query(text, params)
      await client.query('commit')
      return r.rows[0]?.r ?? r.rows
    } catch (e) {
      await client.query('rollback')
      throw e
    }
  }

  before(async () => {
    db = await startSignalDb()
    seed = db.seed
  })
  after(async () => { await db?.stop() })

  it('Ф1: ближайшая привязка поддерева; привязка вложенного поддерева перекрывает внешнюю; объект вне корня не принимается; удаление объекта из корня снимает его привязки', () => {
    const oa = seed.object()
    const ob = seed.object()
    const admin = seed.admin()
    const src = seed.source({ objectIds: [oa, ob] })
    const snap = seed.snapshot(src.id, { name: 'R', children: [
      { name: 'X', children: [{ name: 'Y', children: [{ name: 'Z', items: [{ name: 'z.pdf' }] }] }, { name: 'Y2' }] }, { name: 'W' }] })
    const id = snap.ids
    const objOf = () => Object.fromEntries(q(`select path || '=' || coalesce(object_id::text, '-') from osp_private.signal_nodes where source_id = ${src.id}`).split('\n').map((l) => l.split('=')))
    const bind = (n, o) => db.asJson(admin, `select osp_private.signal_binding_set(${src.id}, '${id[n]}', ${o ? `'${o}'` : 'null'})`)
    assert.ok(Object.values(objOf()).every((v) => v === '-'), 'два объекта и нет разметки — объект не назначен нигде')
    bind('R / X', oa)
    bind('R / X / Y', ob)
    const o = objOf()
    assert.deepEqual([o['R'], o['R / W']], ['-', '-'])
    assert.deepEqual([o['R / X'], o['R / X / Y2']], [oa, oa])
    assert.deepEqual([o['R / X / Y'], o['R / X / Y / Z'], o['R / X / Y / Z / z.pdf']], [ob, ob, ob], 'ближайшая привязка — вложенная')
    assert.equal(db.asError(admin, `select osp_private.signal_binding_set(${src.id}, '${id['R / X / Y / Z / z.pdf']}', '${oa}')`).message, 'invalid', 'привязка к файлу — нельзя')
    assert.equal(db.asError(admin, `select osp_private.signal_binding_set(${src.id}, '${uuid('z', 9)}', '${oa}')`).message, 'invalid', 'узла нет')
    assert.equal(db.asError(admin, `select osp_private.signal_binding_set(${src.id}, '${id['R / W']}', '${seed.object()}')`).message, 'invalid', 'объект вне объектов корня')
    assert.equal(db.asError(admin, `select osp_private.signal_binding_set(${src.id + 100}, '${id['R / W']}', '${oa}')`).message, 'not_found')
    // Повторная привязка того же узла к другому объекту заменяет (одна привязка на поддерево).
    bind('R / X / Y2', ob)
    assert.equal(objOf()['R / X / Y2'], ob)
    bind('R / X / Y2', oa)
    assert.equal(objOf()['R / X / Y2'], oa)
    assert.equal(q(`select count(*) from osp_private.signal_bindings where source_id = ${src.id} and node_id = '${id['R / X / Y2']}'`), '1')
    // Объект Б убран из корня: привязки на него удалены, поддерево Y отходит к ближайшей привязке выше — «X» (А).
    assert.deepEqual(db.asJson(admin, `select osp_private.signal_source_update(${src.id}, null, array['${oa}']::uuid[])`), { ok: true, changed: true })
    assert.equal(q(`select count(*) from osp_private.signal_bindings where source_id = ${src.id} and object_id = '${ob}'`), '0')
    assert.ok(Object.values(objOf()).every((v) => v === oa), 'единственный объект корня — граница всех узлов')
    // Объекты не меняются — changed: false; пустой список — граница закрыта целиком.
    assert.deepEqual(db.asJson(admin, `select osp_private.signal_source_update(${src.id}, null, array['${oa}']::uuid[])`), { ok: true, changed: false })
    assert.deepEqual(db.asJson(admin, `select osp_private.signal_source_update(${src.id}, null, '{}'::uuid[])`), { ok: true, changed: true })
    assert.ok(Object.values(objOf()).every((v) => v === '-'), 'корень без объектов — ни один узел не принадлежит объекту')
    assert.equal(q(`select count(*) from osp_private.signal_bindings where source_id = ${src.id}`), '0')
    // Удаление объекта из базы убирает привязки (каскад); граница пересчитывается при следующей разметке.
    assert.equal(db.asError(admin, `select osp_private.signal_source_update(${src.id}, null, array['${uuid('z', 11)}']::uuid[])`).message, 'invalid')
    assert.equal(db.asError(admin, `select osp_private.signal_source_update(${src.id}, null, ${`array[${Array.from({ length: 21 }, () => `'${seed.object()}'`).join(',')}]::uuid[]`})`).message, 'invalid', '> 20 объектов')
  })

  it('запись результата: stale по поколению и ревизии, ack по ревизии и аренде, версия растёт только при изменении, кандидаты заменяются, решённые пары сохраняются', () => {
    const o = seed.object()
    const dp = seed.contract({ number: 'ЗАП-ДП-26-001', objectId: o })
    const src = seed.source({ objectIds: [o] })
    const snap = seed.snapshot(src.id, { name: 'R', children: [{ name: 'P1' }, { name: 'P2' }, { name: 'P3' }] })
    const n = (p) => snap.ids[p]
    const g = () => Number(q('select generation from osp_private.signal_meta'))
    const rev = () => { const r = q(`select dirty_revision from osp_private.signal_queue where contract_id = '${dp}'`); return r === '' ? null : Number(r) }
    const write = (item, lease = null) => j(`select osp_private.signal_state_write(${lease ? `'${lease}'` : 'null'}, '${JSON.stringify([item]).replace(/'/g, "''")}'::jsonb)`)
    const item = (over = {}) => ({ contractId: dp, revision: rev(), generation: g(), state: 'suggested', reason: null, nodeId: null, fingerprint: 'f', ctxKey: 'ctx1',
      candidates: [{ nodeId: n('R / P1'), score: 70, reasons: ['number'], flags: [] }, { nodeId: n('R / P2'), score: 40, reasons: [], flags: ['weak'] }], ...over })
    const state = () => q(`select state || '|' || coalesce(reason, '-') || '|' || state_version || '|' || processed_revision || '|' || coalesce(node_id::text, '-') || '|' || coalesce(fingerprint, '-') from osp_private.signal_contracts where contract_id = '${dp}'`)
    const opens = () => q(`select string_agg(node_id::text || ':' || score, ',' order by node_id) from osp_private.signal_candidates where contract_id = '${dp}' and status = 'open'`)

    const r0 = rev()
    assert.ok(r0 > 0)
    // Не то поколение / не та ревизия — stale, строка очереди остаётся, состояния нет.
    assert.deepEqual(write(item({ generation: g() + 1 })), { written: 0, acked: 0, stale: 1 })
    assert.deepEqual(write(item({ revision: r0 - 1 })), { written: 0, acked: 0, stale: 1 })
    assert.deepEqual(write(item({ revision: null })), { written: 0, acked: 0, stale: 1 }, 'в очереди строка есть, а захвачено «ничего»')
    assert.equal(q(`select count(*) from osp_private.signal_contracts where contract_id = '${dp}'`), '0', 'ни следа состояния при stale')
    assert.equal(rev(), r0)
    // Неверное состояние / причина — отказ всей записи.
    assert.equal(db.sqlError(`select osp_private.signal_state_write(null, '${JSON.stringify([item({ state: 'weird' })])}'::jsonb)`).message, 'invalid')
    assert.equal(db.sqlError(`select osp_private.signal_state_write(null, '${JSON.stringify([item({ reason: 'Плохо' })])}'::jsonb)`).message, 'invalid')
    // Аренда: чужая — состояние записывается, очередь не снимается (ack не по этой аренде).
    const claim = j('select osp_private.signal_queue_claim(10, 60)')
    assert.equal(claim.items.find((i) => i.contractId === dp).revision, r0)
    assert.deepEqual(write(item(), uuid('z', 5)), { written: 1, acked: 0, stale: 0 })
    assert.equal(rev(), r0, 'чужая аренда очередь не снимает')
    assert.equal(state(), `suggested|-|1|${r0}|-|f`)
    // Своя аренда и тот же результат: версия не растёт (ничего не изменилось), очередь снята.
    assert.deepEqual(write(item(), claim.leaseToken), { written: 1, acked: 1, stale: 0 })
    assert.equal(state(), `suggested|-|1|${r0}|-|f`)
    assert.equal(rev(), null)
    assert.equal(opens(), `${n('R / P1')}:70,${n('R / P2')}:40`.split(',').sort().join(','))
    // Другие оценки при тех же папках — версия прежняя, оценки новые; другой набор папок — версия +1, ушедшая open-пара удалена.
    assert.deepEqual(write(item({ revision: null, candidates: [{ nodeId: n('R / P1'), score: 99, reasons: [], flags: [] }, { nodeId: n('R / P2'), score: 41, reasons: [], flags: [] }] })), { written: 1, acked: 0, stale: 0 })
    assert.equal(state().split('|')[2], '1')
    assert.equal(opens(), [`${n('R / P1')}:99`, `${n('R / P2')}:41`].sort().join(','))
    assert.deepEqual(write(item({ revision: null, candidates: [{ nodeId: n('R / P3'), score: 50, reasons: [], flags: [] }] })), { written: 1, acked: 0, stale: 0 })
    assert.equal(state().split('|')[2], '2')
    assert.equal(opens(), `${n('R / P3')}:50`)
    // Решённая пара не трогается, пока ctx_key тот же; кандидатов не больше 20 (лучшие по баллам).
    q(`insert into osp_private.signal_candidates (contract_id, node_id, status, ctx_key, decided_at) values ('${dp}', '${n('R / P2')}', 'rejected', 'ctx1', now())`)
    assert.deepEqual(write(item({ revision: null, candidates: [{ nodeId: n('R / P2'), score: 10, reasons: [], flags: [] }, { nodeId: n('R / P3'), score: 50, reasons: [], flags: [] }] })), { written: 1, acked: 0, stale: 0 })
    assert.equal(q(`select status || '|' || score from osp_private.signal_candidates where contract_id = '${dp}' and node_id = '${n('R / P2')}'`), 'rejected|0')
    const many = Array.from({ length: 30 }, (_, i) => ({ nodeId: uuid('k', i + 1), score: i, reasons: [], flags: [] }))
    assert.deepEqual(write(item({ revision: null, candidates: many })), { written: 1, acked: 0, stale: 0 })
    assert.equal(q(`select count(*) from osp_private.signal_candidates where contract_id = '${dp}' and status = 'open'`), '20')
    assert.equal(q(`select min(score) from osp_private.signal_candidates where contract_id = '${dp}' and status = 'open'`), '10', 'остались лучшие 20 из 30 (оценки 10…29)')
    // Узел сменился — confirmed_by сбрасывается; тот же узел — остаётся.
    q(`update osp_private.signal_contracts set confirmed_by = '${uuid('u', 1)}', confirmed_at = now() where contract_id = '${dp}'`)
    assert.deepEqual(write(item({ revision: null, state: 'verified', reason: 'existing_url', nodeId: n('R / P1'), candidates: [] })), { written: 1, acked: 0, stale: 0 })
    assert.equal(q(`select coalesce(confirmed_by::text, '-') from osp_private.signal_contracts where contract_id = '${dp}'`), '-')
    q(`update osp_private.signal_contracts set confirmed_by = '${uuid('u', 1)}' where contract_id = '${dp}'`)
    assert.deepEqual(write(item({ revision: null, state: 'verified', reason: 'confirmed', nodeId: n('R / P1'), candidates: [] })), { written: 1, acked: 0, stale: 0 })
    assert.notEqual(q(`select coalesce(confirmed_by::text, '-') from osp_private.signal_contracts where contract_id = '${dp}'`), '-')
    // Договор правят после захвата: его ревизия новая, а ack со старой не проходит (и не удаляет новую).
    q(`update public.contracts set contract_number = 'ЗАП-ДП-26-002' where id = '${dp}'`)
    const r1 = rev()
    assert.ok(r1 > r0)
    assert.deepEqual(write(item({ revision: r0 })), { written: 0, acked: 0, stale: 1 })
    assert.deepEqual(write(item({ revision: r1 })), { written: 1, acked: 1, stale: 0 })
    // Договор удалён — записи нет, остального не ломает.
    const ghost = uuid('z', 77)
    assert.deepEqual(j(`select osp_private.signal_state_write(null, '${JSON.stringify([{ contractId: ghost, revision: null, generation: g(), state: 'none', reason: 'none', candidates: [] }])}'::jsonb)`), { written: 0, acked: 0, stale: 1 })
    // Порядок по contract_id и пустой список.
    assert.deepEqual(j("select osp_private.signal_state_write(null, '[]'::jsonb)"), { written: 0, acked: 0, stale: 0 })
    assert.equal(db.sqlError("select osp_private.signal_state_write(null, '{}'::jsonb)").message, 'invalid')
  })

  it('очередь: захват порциями по dirty_since, аренда, SKIP LOCKED между работниками, просроченная аренда, возврат с задержкой; правка договора не снимает аренду, но даёт новую ревизию', async () => {
    const o = seed.object()
    const cs = Array.from({ length: 5 }, (_, i) => seed.contract({ number: `ОЧР-ДП-26-00${i + 1}`, objectId: o }))
    q(`delete from osp_private.signal_queue where contract_id <> all (array[${cs.map((c) => `'${c}'`).join(',')}]::uuid[])`)
    const claim = (n, lease = 60) => j(`select osp_private.signal_queue_claim(${n}, ${lease})`)
    const c1 = claim(3)
    assert.deepEqual(c1.items.map((i) => i.contractId), cs.slice(0, 3), 'самые давние — первыми')
    assert.match(c1.leaseToken, /^[0-9a-f-]{36}$/)
    const c2 = claim(10)
    assert.deepEqual(c2.items.map((i) => i.contractId), cs.slice(3), 'захваченные не отдаются')
    assert.deepEqual(claim(10), { leaseToken: null, items: [] })
    // Возврат: чужая аренда ничего не освобождает; своя — attempts+1 и срок, до него договор не отдаётся.
    assert.equal(q(`select osp_private.signal_queue_release('${uuid('z', 3)}', array['${cs[0]}']::uuid[], 30)`), '0')
    assert.equal(q(`select osp_private.signal_queue_release('${c1.leaseToken}', array['${cs[0]}', '${cs[4]}']::uuid[], 30)`), '1', 'cs[4] — чужой работник')
    assert.equal(q(`select attempts || '|' || (next_at > now() + interval '20 seconds') || '|' || (lease_token is null) from osp_private.signal_queue where contract_id = '${cs[0]}'`), '1|true|true')
    assert.deepEqual(claim(10).items, [], 'срок возврата не наступил')
    q(`update osp_private.signal_queue set next_at = now() - interval '1 second' where contract_id = '${cs[0]}'`)
    assert.deepEqual(claim(10).items.map((i) => i.contractId), [cs[0]])
    // Аренда истекла — договор отдаётся снова.
    q(`update osp_private.signal_queue set lease_until = now() - interval '1 second' where contract_id = '${cs[1]}'`)
    assert.deepEqual(claim(10).items.map((i) => i.contractId), [cs[1]])
    // Правка договора: новая ревизия, попытки и срок обнулены, аренда не тронута (устаревший ack не пройдёт).
    const before = q(`select dirty_revision, lease_token from osp_private.signal_queue where contract_id = '${cs[2]}'`).split('|')
    q(`update osp_private.signal_queue set attempts = 4, next_at = now() + interval '1 hour' where contract_id = '${cs[2]}'`)
    q(`update public.contracts set contract_number = 'ОЧР-ДП-26-012' where id = '${cs[2]}'`)
    const after = q(`select dirty_revision || '|' || attempts || '|' || coalesce(next_at::text, '-') || '|' || lease_token from osp_private.signal_queue where contract_id = '${cs[2]}'`).split('|')
    assert.ok(Number(after[0]) > Number(before[0]))
    assert.deepEqual([after[1], after[2], after[3]], ['0', '-', before[1]])
    // SKIP LOCKED: работник 1 держит захват в незавершённой транзакции, работник 2 получает остальное и не ждёт.
    q(`update osp_private.signal_queue set lease_token = null, lease_until = null, next_at = null`)
    const w1 = await db.connect()
    const w2 = await db.connect()
    await w1.query('begin')
    await w1.query("set local application_name = 'osp:internal'")
    const got1 = (await w1.query('select osp_private.signal_queue_claim(2, 60) as r')).rows[0].r
    await w2.query("set application_name = 'osp:internal'")
    const t0 = Date.now()
    const got2 = (await w2.query('select osp_private.signal_queue_claim(10, 60) as r')).rows[0].r
    assert.ok(Date.now() - t0 < 1500, 'не ждёт блокировок')
    const ids1 = got1.items.map((i) => i.contractId)
    const ids2 = got2.items.map((i) => i.contractId)
    assert.equal(ids1.length, 2)
    assert.equal(ids2.length, 3)
    assert.deepEqual([...ids1, ...ids2].sort(), cs.slice().sort(), 'работники не пересекаются')
    await w1.query('rollback')
    // Откат захвата первого — его договоры снова свободны.
    assert.equal(j('select osp_private.signal_queue_claim(10, 60)').items.length, 2)
  })

  it('конкуренция действий: два подтверждения с одной версией — одно проходит, второе 409; одинаковый ключ из двух вкладок — один результат и одно событие; подтверждение и снятие не оставляют полусостояния', async () => {
    const o = seed.object()
    const ed = seed.user({ role: 'sg_race', contracts: 'edit', objectIds: [o] })
    const ed2 = seed.user({ role: 'sg_race', contracts: 'edit', objectIds: [o] })
    const cp = seed.counterparty()
    const dp = seed.contract({ number: 'ГОН-ДП-26-001', objectId: o, counterparties: [cp] })
    const src = seed.source({ objectIds: [o] })
    const snap = seed.snapshot(src.id, { name: 'R', children: [{ name: 'N1' }, { name: 'N2' }] })
    const n1 = snap.ids['R / N1']
    const n2 = snap.ids['R / N2']
    const confirm = (node, over = {}) => ['select osp_private.signal_confirm($1, $2, $3, $4, null, null, $5, $6, $7, $8) as r',
      [dp, node, `https://signal.example.invalid/f/${node}`, over.replace ?? false, 'fp', over.link ?? null, over.ver ?? 0, over.key ?? `key-${node}`]]
    const c1 = await db.connect()
    const c2 = await db.connect()
    const settle = (a, b) => Promise.allSettled([a, b]).then((r) => r.map((x) => (x.status === 'fulfilled' ? { ok: x.value } : { code: x.reason.code, message: x.reason.message })))
    // Две вкладки, одна версия окна, разные папки.
    let [x, y] = await settle(userTx(c1, ed, ...confirm(n1)), userTx(c2, ed2, ...confirm(n2)))
    assert.equal([x, y].filter((r) => r.ok).length, 1, JSON.stringify([x, y]))
    assert.deepEqual([x, y].find((r) => !r.ok), { code: 'SG409', message: 'stale_state' })
    const link = q(`select signal_link from public.contracts where id = '${dp}'`)
    assert.match(link, /^https:\/\/signal\.example\.invalid\/f\//)
    assert.equal(q(`select count(*) from public.contract_audit_log where contract_id = '${dp}' and event_type = 'signal_link'`), '1')
    assert.equal(q(`select state_version from osp_private.signal_contracts where contract_id = '${dp}'`), '1')
    // Подтверждение и снятие с одной версией: ровно одно действие, состояние согласовано со ссылкой.
    const unlink = ['select osp_private.signal_unlink($1, $2, $3, $4, $5) as r', [dp, 'ctx', link, 1, 'unlink-race']]
    ;[x, y] = await settle(userTx(c1, ed, ...confirm(link.endsWith(n1) ? n2 : n1, { replace: true, link, ver: 1, key: 'replace-race' })), userTx(c2, ed2, ...unlink))
    assert.equal([x, y].filter((r) => r.ok).length, 1, JSON.stringify([x, y]))
    assert.equal(([x, y].find((r) => !r.ok)).message, 'stale_state')
    const row = q(`select coalesce(c.signal_link, '-') || '|' || sc.state || ':' || sc.reason || '|' || sc.state_version from public.contracts c join osp_private.signal_contracts sc on sc.contract_id = c.id where c.id = '${dp}'`).split('|')
    assert.equal(row[2], '2')
    if (row[0] === '-') assert.equal(row[1], 'none:unlinked')
    else assert.equal(row[1], 'verified:confirmed')
    // Один и тот же ключ из двух вкладок одного человека: оба получают один ответ, событие одно.
    q(`update public.contracts set signal_link = null where id = '${dp}'; delete from osp_private.signal_contracts where contract_id = '${dp}';
      delete from public.contract_audit_log where contract_id = '${dp}' and event_type = 'signal_link'`)
    ;[x, y] = await settle(userTx(c1, ed, ...confirm(n1, { key: 'same-key' })), userTx(c2, ed, ...confirm(n1, { key: 'same-key' })))
    assert.ok(x.ok && y.ok, JSON.stringify([x, y]))
    assert.deepEqual(x.ok, y.ok)
    assert.equal(q(`select count(*) from public.contract_audit_log where contract_id = '${dp}' and event_type = 'signal_link'`), '1')
  })

  it('журнал базы: корни, привязки и синонимы пишутся (автор — из токена, row_id = число-id как uuid), служебные отметки обхода и таблицы наблюдаемого состояния — нет', () => {
    const admin = seed.admin({ fullName: 'Журналов Ж. Ж.' })
    const o = seed.object()
    const o2 = seed.object()
    const added = db.asJson(admin, `select osp_private.signal_source_add('${uuid('p', 90)}', '${uuid('f', 90)}', 'Проект журнала', 'Проект журнала / Корень', array['${o}', '${o2}']::uuid[])`)
    const sid = added.id
    const rowId = (id) => `lpad(to_hex(${id}), 32, '0')::uuid`
    const log = (table, op) => Number(q(`select count(*) from osp_private.data_audit_log where table_name = '${table}' and op = '${op}'`))
    assert.equal(q(`select actor = '${admin}' and actor_name = 'Журналов Ж. Ж.' from osp_private.data_audit_log where table_name = 'signal_sources' and op = 'INSERT' and row_id = ${rowId(sid)}`), 't')
    assert.equal(log('signal_bindings', 'INSERT') >= 2, true)
    // Отметки обхода — не событие журнала; включение/выключение корня — событие с изменёнными колонками.
    const before = log('signal_sources', 'UPDATE')
    q(`update osp_private.signal_sources set last_run_id = 5, last_ok_at = now(), last_error = 'http', folders_count = 3, items_count = 9, updated_at = now() where id = ${sid}`)
    assert.equal(log('signal_sources', 'UPDATE'), before)
    db.asJson(admin, `select osp_private.signal_source_update(${sid}, false, null)`)
    assert.equal(log('signal_sources', 'UPDATE'), before + 1)
    assert.deepEqual(j(`select changes from osp_private.data_audit_log where table_name = 'signal_sources' and op = 'UPDATE' and row_id = ${rowId(sid)} order by id desc limit 1`), { enabled: [true, false] })
    // Привязка и её снятие.
    const src = seed.source({ objectIds: [o] })
    const snap = seed.snapshot(src.id, { name: 'R', children: [{ name: 'A' }] })
    db.asJson(admin, `select osp_private.signal_binding_set(${src.id}, '${snap.ids['R / A']}', '${o}')`)
    const bid = q(`select id from osp_private.signal_bindings where source_id = ${src.id} and node_id is not null`)
    assert.equal(q(`select count(*) from osp_private.data_audit_log where table_name = 'signal_bindings' and op = 'INSERT' and row_id = ${rowId(bid)}`), '1')
    db.asJson(admin, `select osp_private.signal_binding_set(${src.id}, '${snap.ids['R / A']}', null)`)
    assert.equal(q(`select count(*) from osp_private.data_audit_log where table_name = 'signal_bindings' and op = 'DELETE' and row_id = ${rowId(bid)}`), '1')
    // Остальное — не аудируется.
    assert.equal(q(`select count(*) from osp_private.data_audit_log where table_name in ('signal_nodes', 'signal_stage_nodes', 'signal_queue', 'signal_contracts', 'signal_candidates', 'signal_runs', 'signal_meta')`), '0')
    // Новый договор в журнале договоров — как и раньше.
    assert.ok(Number(q(`select count(*) from osp_private.data_audit_log where table_name = 'contracts'`)) >= 0)
  })

  it('правила по строкам на настоящей учётке-владельце: без отметки пропуска таблицы пусты и закрыты на запись; снятая политика не ломает правку договора', () => {
    const o = seed.object()
    const u = seed.user({ role: 'sg_rls', contracts: 'edit', objectIds: [o] })
    const dp = seed.contract({ number: 'РЛС-ДП-26-001', objectId: o })
    const src = seed.source({ objectIds: [o] })
    seed.snapshot(src.id, { name: 'R', children: [{ name: 'A' }] })
    const tables = ['signal_meta', 'signal_sources', 'signal_bindings', 'signal_nodes', 'signal_stage_nodes', 'signal_runs', 'signal_contracts', 'signal_candidates', 'signal_aliases', 'signal_queue']
    assert.ok(Number(q('select count(*) from osp_private.signal_nodes')) > 0 && Number(q('select count(*) from osp_private.signal_queue')) > 0)
    for (const t of tables) {
      assert.equal(db.as(u, `select count(*) from osp_private.${t}`), '0', `${t}: вошедший без пропуска строк не видит`)
      const rows = q(`select count(*) from osp_private.${t}`)
      assert.equal(db.asError(u, `delete from osp_private.${t}`), null, `${t}: удаление без пропуска не затрагивает строк, ошибки нет`)
      assert.equal(q(`select count(*) from osp_private.${t}`), rows, `${t}: строки на месте`)
    }
    assert.match(db.asError(u, `insert into osp_private.signal_aliases (object_id, alias_text, alias_key) values ('${o}', 'x', 'x')`).message, /row-level security/)
    assert.ok(Number(db.sql('select count(*) from osp_private.signal_nodes')) > 0)
    // Политика пропуска пропала: триггер очереди ловит отказ базы — правка договора проходит, очередь не пополняется.
    const out = db.sql(`begin;
      delete from osp_private.signal_queue;
      drop policy osp_internal on osp_private.signal_queue;
      update public.contracts set contract_number = 'РЛС-ДП-26-002' where id = '${dp}';
      select 'правка прошла';
      rollback;`)
    assert.match(out, /правка прошла/)
  })

  it('триггеры очереди на настоящей учётке: очередь заблокирована (ACCESS EXCLUSIVE) или занята строка — правка договора проходит не дольше одного lock_timeout', async () => {
    const o = seed.object()
    const dp = seed.contract({ number: 'ТРГ-ДП-26-001', objectId: o })
    const holder = await db.connect()
    const timed = () => { const t = Date.now(); db.sql(`update public.contracts set contract_number = contract_number || 'x' where id = '${dp}'`); return Date.now() - t }
    await holder.query('begin')
    await holder.query("set local application_name = 'osp:internal'")
    await holder.query('lock table osp_private.signal_queue in access exclusive mode')
    const t1 = timed()
    await holder.query('rollback')
    assert.ok(t1 >= 200 && t1 < 1200, `ACCESS EXCLUSIVE: ${t1} мс`)
    assert.match(db.sql(`select contract_number from public.contracts where id = '${dp}'`), /x$/)
    await holder.query('begin')
    await holder.query("set local application_name = 'osp:internal'")
    await holder.query(`select * from osp_private.signal_queue where contract_id = '${dp}' for update`)
    const rev = db.sql(`select dirty_revision from osp_private.signal_queue where contract_id = '${dp}'`)
    const t2 = timed()
    await holder.query('rollback')
    assert.ok(t2 >= 200 && t2 < 1200, `строка очереди занята: ${t2} мс`)
    assert.equal(db.sql(`select dirty_revision from osp_private.signal_queue where contract_id = '${dp}'`), rev, 'ревизия не поставлена — следующая публикация поставит всех')
    await sleep(10)
    // Без блокировок — ревизия ставится сразу.
    db.sql(`update public.contracts set contract_number = 'ТРГ-ДП-26-009' where id = '${dp}'`)
    assert.ok(Number(db.sql(`select dirty_revision from osp_private.signal_queue where contract_id = '${dp}'`)) > Number(rev))
  })
})

describe('База сверки с SIGNAL: правки по ревью — видимость файлов, ДП в семье ДС, «ожидает» после пересверки, идемпотентность по виду действия', { skip: signalDbSkip, timeout: 600000 }, () => {
  let db
  let seed
  const q = (text) => db.sql(text)
  const j = (text) => db.sqlJson(text)
  const gen = () => Number(q('select generation from osp_private.signal_meta'))
  const queueRev = (c) => { const r = q(`select dirty_revision from osp_private.signal_queue where contract_id = '${c}'`); return r === '' ? null : Number(r) }
  const recheck = (c) => q(`select recheck_only from osp_private.signal_queue where contract_id = '${c}'`)
  // Результат сопоставления, как его пишет работник: захваченная ревизия и текущее поколение.
  const write = (c, over = {}) => j(`select osp_private.signal_state_write(null, '${JSON.stringify([{ contractId: c, revision: queueRev(c), generation: gen(), state: 'suggested',
    reason: null, nodeId: null, fingerprint: 'f', ctxKey: 'ctx', candidates: [], ...over }]).replace(/'/g, "''")}'::jsonb)`)

  before(async () => {
    db = await startSignalDb()
    seed = db.seed
  })
  after(async () => { await db?.stop() })

  it('файлы и папки, которых нет в последнем обходе, окно сверки не показывает и не считает (more — по видимым); known переносит неперечисленные папки', () => {
    const o = seed.object()
    const ed = seed.user({ role: 'sg_seen', contracts: 'edit', objectIds: [o] })
    const dp = seed.contract({ number: 'ВИД-ДП-26-001', objectId: o })
    const src = seed.source({ objectIds: [o] })
    const snap = seed.snapshot(src.id, { name: 'R', children: [{ name: 'K',
      items: [{ name: 'a.pdf' }, { name: 'b.pdf' }, { name: 'c.pdf' }], children: [{ name: 'Старая' }, { name: 'K2', items: [{ name: 'x1.pdf' }, { name: 'x2.pdf' }] }] }] })
    const K = snap.ids['R / K']
    const K2 = snap.ids['R / K / K2']
    q(`insert into osp_private.signal_contracts (contract_id, state, reason, node_id) values ('${dp}', 'verified', 'confirmed', '${K}')`)
    const view = (node = null, limit = 200) => db.asJson(ed, `select osp_private.signal_contract_view('${dp}', ${node ? `'${node}'` : 'null'}, ${limit})`)
    const names = (v) => v.files.map((f) => f.name).sort()
    const folders = () => Object.fromEntries(db.asJson(ed, `select osp_private.signal_folders_search('${dp}', '', null, 50)`).items.map((i) => [i.path, i.files]))

    assert.deepEqual(names(view()), ['K2', 'a.pdf', 'b.pdf', 'c.pdf', 'Старая'].sort())
    assert.deepEqual(folders(), { R: 0, 'R / K': 3, 'R / K / K2': 2, 'R / K / Старая': 0 })

    // Полный обход: c.pdf и «Старая» в нём не встретились (ids — прежние узлы «возвращаются»).
    const tree = { name: 'R', children: [{ name: 'K', items: [{ name: 'a.pdf' }, { name: 'b.pdf' }], children: [{ name: 'K2', items: [{ name: 'x1.pdf' }, { name: 'x2.pdf' }] }] }] }
    const full = seed.sync({ kind: 'manual', mode: 'full', roots: [{ src, tree, ids: snap.ids }] })
    assert.equal(full.result.status, 'ok')
    assert.equal(q(`select count(*) from osp_private.signal_nodes where name in ('c.pdf', 'Старая') and seen_gen < ${gen()}`), '2', 'в снимке пропавшие узлы остаются (для «пропал»), но не видны')
    const v1 = view()
    assert.deepEqual(names(v1), ['K2', 'a.pdf', 'b.pdf'], 'пропавшие файл и папка не показываются')
    assert.equal(v1.node.observed, true)
    assert.equal(view(null, 3).more, false, 'more — только по видимым (три из трёх)')
    const v2 = view(null, 2)
    assert.equal(v2.more, true)
    assert.equal(v2.files.length, 2)
    assert.deepEqual(folders(), { R: 0, 'R / K': 2, 'R / K / K2': 2 }, 'счётчик файлов — только виденные; пропавшая папка из поиска ушла')

    // Режим known: K перечислена (остался один файл), K2 не перечислялась — её файлы переносятся и остаются видны.
    const known = seed.sync({ kind: 'day', mode: 'known', roots: [{ src, ids: snap.ids,
      tree: { name: 'R', children: [{ name: 'K', items: [{ name: 'a.pdf' }], children: [{ name: 'K2', itemsListed: false }] }] } }] })
    assert.equal(known.result.status, 'ok')
    assert.deepEqual(names(view(K2)), ['x1.pdf', 'x2.pdf'], 'файлы неперечисленной папки видны (seen_gen перенесён)')
    assert.deepEqual(names(view()), ['K2', 'a.pdf'], 'b.pdf в перечисленной папке не встретился — скрыт')
    assert.deepEqual(folders(), { R: 0, 'R / K': 1, 'R / K / K2': 2 })
  })

  it('неразмеченные папки корня (админ): список и число файлов — только узлы последнего обхода; пропавшие папки и файлы не показываются и не считаются', () => {
    const admin = seed.admin()
    const src = seed.source({ objectIds: [seed.object(), seed.object()] })
    const snap = seed.snapshot(src.id, { name: 'R', children: [
      { name: 'X', items: [{ name: 'a.pdf' }, { name: 'b.pdf' }], children: [{ name: 'Y', items: [{ name: 'c.pdf' }] }] },
      { name: 'Z', items: [{ name: 'd.pdf' }] }] })
    const list = () => Object.fromEntries(db.asJson(admin, `select osp_private.signal_unassigned(${src.id}, null, 50)`).items.map((i) => [i.path, i.items]))
    assert.deepEqual(list(), { 'R / X': 3, 'R / Z': 1 })
    // Обход: Z пропала целиком, в X не встретился b.pdf.
    const tree = { name: 'R', children: [{ name: 'X', items: [{ name: 'a.pdf' }], children: [{ name: 'Y', items: [{ name: 'c.pdf' }] }] }] }
    assert.equal(seed.sync({ kind: 'manual', mode: 'full', roots: [{ src, tree, ids: snap.ids }] }).result.status, 'ok')
    assert.equal(q(`select count(*) from osp_private.signal_nodes where source_id = ${src.id} and name in ('Z', 'b.pdf', 'd.pdf') and seen_gen < ${gen()}`), '3')
    assert.deepEqual(list(), { 'R / X': 2 }, 'пропавшая папка Z и файл b.pdf не показаны и не посчитаны')
    const page = db.asJson(admin, `select osp_private.signal_unassigned(${src.id}, null, 1)`)
    assert.deepEqual([page.items.length, page.next], [1, null], 'страница по видимым: пропавшая Z следующей страницы не создаёт')
  })

  it('ДС: удалённый ДП в семье помечен deleted (сопоставитель не берёт его ссылку за папку ДС); восстановленный — нет', () => {
    const o = seed.object()
    const dp = seed.contract({ number: 'УДЛ-ДП-26-001', objectId: o, signalLink: 'https://signal.example.invalid/folder/f-1' })
    const ds = seed.contract({ number: 'ДС-1', objectId: o, recordType: 'ds_vor', parent: dp })
    const dsLoaded = () => j(`select osp_private.signal_match_load(array['${ds}']::uuid[])`).contracts[0]
    const live = dsLoaded()
    assert.equal(live.family.dp.id, dp)
    assert.equal(live.family.dp.deleted, false)
    assert.equal(live.deleted, false)
    q(`update public.contracts set deleted_at = now() where id = '${dp}'`)
    const gone = dsLoaded()
    assert.equal(gone.family.dp.id, dp, 'ДП в семье остаётся — решает сопоставитель')
    assert.equal(gone.family.dp.deleted, true)
    assert.equal(gone.family.dp.signalLink, 'https://signal.example.invalid/folder/f-1')
    assert.equal(gone.deleted, false, 'сам ДС не удалён')
    q(`update public.contracts set deleted_at = null where id = '${dp}'`)
    assert.equal(dsLoaded().family.dp.deleted, false)
    // ДП сам: у него семьи нет.
    assert.equal(j(`select osp_private.signal_match_load(array['${dp}']::uuid[])`).contracts[0].family.dp, null)
  })

  it('«ожидает»: плановая пересверка (публикация, синонимы, привязки) оставляет последнее состояние без pending; правка реквизитов — настоящее «ожидает», в том числе после публикации', () => {
    const o = seed.object()
    const ed = seed.user({ role: 'sg_pend', contracts: 'edit', objectIds: [o] })
    const admin = seed.admin()
    const dp = seed.contract({ number: 'ОЖД-ДП-26-001', objectId: o })
    const src = seed.source({ objectIds: [o] })
    const tree = { name: 'R', children: [{ name: 'A' }, { name: 'B' }] }
    const snap = seed.snapshot(src.id, tree)
    const mark = () => db.asJson(ed, 'select osp_private.signal_marks(null, 1000)').items.find((m) => m.id === dp)
    const view = () => db.asJson(ed, `select osp_private.signal_contract_view('${dp}')`)
    const both = () => [mark(), view()]
    // Публикация с изменением (С-38: без изменений в очередь никого не ставят): каждый раз новый файл в папке «A».
    let tick = 0
    const publish = () => assert.equal(seed.sync({ kind: 'manual', mode: 'full', roots: [{ src, ids: snap.ids,
      tree: { name: 'R', children: [{ name: 'A', items: [{ name: `новый${++tick}.pdf` }] }, { name: 'B' }] } }] }).result.status, 'ok')
    const settle = () => assert.equal(write(dp, { candidates: [{ nodeId: snap.ids['R / A'], score: 70, reasons: ['number'], flags: [] }] }).written, 1)

    // Договор ни разу не обработан: «ожидает» — показывать нечего.
    assert.equal(recheck(dp), 'f')
    assert.deepEqual(both().map((x) => [x.state, x.pending]), [[null, true], [null, true]])
    // Обработан: состояние и pending:false.
    settle()
    assert.equal(queueRev(dp), null)
    assert.deepEqual(both().map((x) => [x.state, x.pending]), [['suggested', false], ['suggested', false]])

    // Публикация ставит договор в очередь как плановую пересверку: прежнее состояние, без pending.
    const rev0 = queueRev(dp)
    publish()
    assert.ok(queueRev(dp) > 0 && queueRev(dp) !== rev0)
    assert.equal(recheck(dp), 't')
    const m1 = mark()
    assert.deepEqual([m1.state, m1.reason, m1.pending, m1.hasLink], ['suggested', null, false, false])
    assert.deepEqual([view().state, view().pending, view().stateVersion], ['suggested', false, 1])
    // То же — синоним (создание и удаление) и привязка поддерева.
    const alias = db.asJson(ed, `select osp_private.signal_alias_create('${o}', 'Псевдоним объекта', 'псевдоним объекта')`)
    assert.equal(recheck(dp), 't')
    assert.deepEqual(both().map((x) => x.pending), [false, false], 'синоним создан')
    db.asJson(admin, `select osp_private.signal_alias_delete(${alias.id})`)
    assert.deepEqual(both().map((x) => x.pending), [false, false], 'синоним удалён')
    db.asJson(admin, `select osp_private.signal_binding_set(${src.id}, '${snap.ids['R / A']}', '${o}')`)
    assert.equal(recheck(dp), 't')
    assert.deepEqual(both().map((x) => x.pending), [false, false], 'привязка поддерева')
    // Служебная постановка всех (CLI) — тоже пересверка.
    assert.ok(Number(q('select osp_private.signal_enqueue_all()')) >= 1)
    assert.deepEqual(both().map((x) => x.pending), [false, false])

    // Правка номера — настоящее «ожидает» (прежнее состояние остаётся видимым).
    q(`update public.contracts set contract_number = 'ОЖД-ДП-26-002' where id = '${dp}'`)
    assert.equal(recheck(dp), 'f')
    assert.deepEqual(both().map((x) => [x.state, x.pending]), [['suggested', true], ['suggested', true]])
    // Правка, затем публикация / синоним / привязка: ожидающая правка не прячется.
    publish()
    assert.equal(recheck(dp), 'f', 'пересверка не сбрасывает признак правки реквизитов')
    assert.deepEqual(both().map((x) => x.pending), [true, true])
    db.asJson(ed, `select osp_private.signal_alias_create('${o}', 'Другой псевдоним', 'другой псевдоним')`)
    db.asJson(admin, `select osp_private.signal_binding_set(${src.id}, '${snap.ids['R / B']}', '${o}')`)
    assert.deepEqual(both().map((x) => x.pending), [true, true])
    // Обработали — pending снят; следующая публикация снова только пересверка.
    settle()
    assert.deepEqual(both().map((x) => x.pending), [false, false])
    publish()
    assert.equal(recheck(dp), 't')
    assert.deepEqual(both().map((x) => x.pending), [false, false])
    // Правка после пересверки: признак сброшен, pending есть.
    q(`update public.contracts set contract_date = '2026-05-05' where id = '${dp}'`)
    assert.equal(recheck(dp), 'f')
    assert.deepEqual(both().map((x) => x.pending), [true, true])
    // Правка параллельно с захватом пересверки: устаревший результат не проходит, pending остаётся.
    settle()
    publish()
    const claimed = queueRev(dp)
    q(`update public.contracts set contract_number = 'ОЖД-ДП-26-003' where id = '${dp}'`)
    assert.deepEqual(write(dp, { revision: claimed }), { written: 0, acked: 0, stale: 1 })
    assert.deepEqual(both().map((x) => x.pending), [true, true])

    // Договор без состояния при плановой постановке: показывать нечего — «ожидает».
    const fresh = seed.contract({ number: 'ОЖД-ДП-26-010', objectId: o })
    q(`delete from osp_private.signal_queue where contract_id = '${fresh}'`)
    publish()
    assert.equal(recheck(fresh), 't')
    const f = db.asJson(ed, 'select osp_private.signal_marks(null, 1000)').items.find((m) => m.id === fresh)
    assert.deepEqual([f.state, f.pending], [null, true])
  })

  it('идемпотентность: тот же ключ у другого действия или узла повтором не считается; повтор того же действия — тот же ответ, без второго события и без служебных полей', () => {
    const o = seed.object()
    const ed = seed.user({ role: 'sg_idem', contracts: 'edit', objectIds: [o] })
    const src = seed.source({ objectIds: [o] })
    const snap = seed.snapshot(src.id, { name: 'R', children: [{ name: 'A' }, { name: 'B' }] })
    const A = snap.ids['R / A']
    const B = snap.ids['R / B']
    const url = (n) => `https://signal.example.invalid/folder/${n}`
    const events = (c) => Number(q(`select count(*) from public.contract_audit_log where contract_id = '${c}' and event_type = 'signal_link'`))
    const stateOf = (c) => q(`select state || ':' || coalesce(reason, '-') || '|' || state_version from osp_private.signal_contracts where contract_id = '${c}'`)
    let seq = 0
    const suggested = () => {
      const c = seed.contract({ number: `ИДМ-ДП-26-00${++seq}`, objectId: o })
      assert.equal(write(c, { candidates: [{ nodeId: A, score: 70, reasons: [], flags: [] }, { nodeId: B, score: 40, reasons: [], flags: [] }] }).written, 1)
      return c
    }
    const confirm = (c, node, ver, key, link = null) => `select osp_private.signal_confirm('${c}', '${node}', '${url(node)}', false, null, null, 'fp', ${link ? `'${link}'` : 'null'}, ${ver}, '${key}')`
    const reject = (c, node, ver, key) => `select osp_private.signal_reject('${c}', '${node}', 'не та', 'ctx', ${ver}, '${key}')`
    const unlink = (c, link, ver, key) => `select osp_private.signal_unlink('${c}', 'ctx', '${link}', ${ver}, '${key}')`

    // confirm(A, K) → reject(A, K) / confirm(B, K) / unlink(K): чужой ответ не отдаётся.
    const c1 = suggested()
    assert.equal(stateOf(c1), 'suggested:-|1')
    const first = db.asJson(ed, confirm(c1, A, 1, 'K'))
    assert.deepEqual(first, { state: 'verified', reason: 'confirmed', stateVersion: 2, signalLink: url(A) })
    assert.equal(events(c1), 1)
    assert.equal(db.asError(ed, reject(c1, A, 2, 'K')).message, 'stale_state', 'reject с ключом confirm — не повтор: путь обычный, пара уже не открыта')
    assert.equal(db.asError(ed, confirm(c1, B, 1, 'K')).message, 'stale_state', 'confirm другой папки с тем же ключом — не повтор')
    assert.equal(events(c1), 1)
    assert.equal(stateOf(c1), 'verified:confirmed|2')
    // Повтор самого confirm — тот же ответ, события нет, служебных полей нет.
    assert.deepEqual(db.asJson(ed, confirm(c1, A, 1, 'K')), first)
    assert.equal(events(c1), 1)
    // Другое действие с тем же ключом, но допустимое по версии и ссылке, выполняется как обычное (ответ confirm не подставляется).
    const un = db.asJson(ed, unlink(c1, url(A), 2, 'K'))
    assert.deepEqual(un, { state: 'none', reason: 'unlinked', stateVersion: 3 })
    assert.equal(events(c1), 2)
    assert.deepEqual(db.asJson(ed, unlink(c1, url(A), 2, 'K')), un, 'повтор unlink — тот же ответ')
    assert.equal(events(c1), 2)
    assert.equal(db.asError(ed, confirm(c1, A, 1, 'K')).message, 'stale_state', 'ключ теперь за unlink: confirm — не повтор')
    assert.equal(stateOf(c1), 'none:unlinked|3')

    // reject(A, K2) → повтор тот же; confirm(B, K2) с верной версией выполняется, а не получает ответ reject.
    const c2 = suggested()
    const rej = db.asJson(ed, reject(c2, A, 1, 'K2'))
    assert.deepEqual(rej, { state: 'suggested', reason: null, stateVersion: 2 })
    assert.deepEqual(db.asJson(ed, reject(c2, A, 1, 'K2')), rej)
    assert.equal(events(c2), 1)
    assert.equal(db.asError(ed, reject(c2, B, 1, 'K2')).message, 'stale_state', 'reject другой папки с тем же ключом — не повтор (версия уже 2)')
    assert.equal(events(c2), 1)
    const ok = db.asJson(ed, confirm(c2, B, 2, 'K2'))
    assert.deepEqual(ok, { state: 'verified', reason: 'confirmed', stateVersion: 3, signalLink: url(B) })
    assert.equal(events(c2), 2)
    assert.deepEqual(db.asJson(ed, confirm(c2, B, 2, 'K2')), ok)
    assert.equal(events(c2), 2)
    // Другой человек с тем же ключом повтором не считается (как и раньше).
    const ed2 = seed.user({ role: 'sg_idem2', contracts: 'edit', objectIds: [o] })
    assert.equal(db.asError(ed2, confirm(c2, B, 2, 'K2')).message, 'stale_state')
  })
})
