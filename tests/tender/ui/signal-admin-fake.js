// Надстройка над signal-fake.js (P5a) для «Администрирование» → «Signal»: администраторская часть состояния сервера (корни, прогоны,
// синонимы, дерево папок и привязки) и маршруты 9, 11–17 (раздел 7 спецификации) + новые маршруты волны исправлений (раздел 5.2:
// /tree, /bindings, /bindings/preview, /aliases для сотрудника) из памяти страницы. Подключается из signal-stand-main.jsx после
// seed.js; без ?signal=… ничего не делает.
//   sigAdmin=0     — вошедший не администратор: status без админских полей и isAdmin: false, админские маршруты — 403;
//   sigConn=off    — подключение не настроено (connection: 'not_configured', обход — 409 not_configured);
//   sigSources=none — корней нет;
//   sigBusy=1      — «Синхронизировать» отвечает 409 busy (обход уже идёт, хотя журнал этого не показывает);
//   sigUnassigned=many — у многообъектного корня 75 верхних папок без объекта (страницы по 50; «Дельты» в нём нет);
//   sigStuck=1     — прогон 13 «идёт», но процесс упал: heartbeat 11:10 МСК, status.running.stuck = true (С-48, оповещение run_stuck);
//   sigHeld=0      — отложенного прогона нет (прогон 12 завершён успешно); по умолчанию прогон 12 отложен, status.held = { runId: 12,
//                    generation: 7 } и есть оповещение run_held (С-50);
//   sigFailed=1    — корень «Бета» не обходится с 22.11.2026 05:15 (status: failed, failedSince, lastError: root_unavailable;
//                    оповещение root_failed);
//   sigProblems=1  — у корня «Альфа» 3 проблемных подпапки (problems: список { nodeId, code } — вариант «число» см. sigProblems=n);
//                    sigProblems=n — то же, но problems — число (сервер может отдать и так);
//   sigBound=1     — дерево корня 2 уже размечено: корп.14 → объект 1, корп.22 → объект 2 (Дельта остаётся без объекта);
//   sigPreviewFail=1 — проверка привязки (/bindings/preview) отвечает 503; sigBindFail=1 — привязка (/bindings) отвечает 409;
//   signalStale=1  — (signal-fake.js) status.stale = true: полоса «Данные Signal обновлялись …» и оповещение data_stale;
//   sigDisabled=<причина> — при signal=off администратору status отдаёт { enabled: false, disabledReason, configErrors } (В-8):
//                    config_invalid | not_enabled | no_schema | db_error (configErrors — имена переменных);
//   sigAliasMore=1 — ещё синонимы: свои у сотрудника (al-2 — объект 1, al-3 — объект 2) и чужой (al-4, объект 1); sigAliasConflict=1 —
//                    al-4 помечен conflict: true (С-6). Сотруднику с правкой GET /aliases отдаёт только его (mine), DELETE — только его.
// Состояние — window.__signalAdmin: { sources, runs, aliases, nodes, nodeOf(id), bindings(), finishRun(status?) } — тесты читают и правят.
// Корни: 1 — «Альфа → Договора подряда» (один объект), 2 — «Бета → Корпуса» (два объекта: ЖК и БЦ; дерево папок и привязки),
// 3 — «Гамма → Архив» (выключен, без объектов, с ошибкой). Все названия вымышленные.
// Дерево корня 2 (Дельта — как в сценарии судьи «Дельта / корп.14 / корп.22», номера договоров объекта лежат в папках «Договоры»):
//   Дельта (без объекта) ─ корп.14 ─ Договоры (номера объекта 1)
//                        ├ корп.22 ─ Договоры (номера объекта 2) ─ Приложения
//                        └ Общие документы
//   Паркинг 1, Паркинг 2 (верхние папки без объекта).
const params = new URLSearchParams(window.location.search)
const api = window.__signal

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } })
const ok = (data) => json(200, data)
const fail = (status, code, error) => json(status, { error, code })
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

if (api && params.get('signal')) {
  const ADMIN = params.get('sigAdmin') !== '0'
  const NOT_CONFIGURED = params.get('sigConn') === 'off'
  const objectName = (id) => (window.__fakeDb?.objects || []).find((o) => o.id === id)?.name || 'Объект'
  const pubObjects = (ids) => ids.map((id) => ({ id, name: objectName(id) }))
  const PAGE = 50

  const sources = params.get('sigSources') === 'none' ? [] : [
    { id: 1, projectName: 'Альфа', rootPath: 'Договора подряда', enabled: true, ready: true, objectIds: ['obj-1'], status: 'ok', failedSince: null,
      lastOkAt: '2026-11-23T02:12:00.000Z', lastNightOkAt: '2026-11-23T02:12:00.000Z', lastError: null, folders: 412, items: 1300, problems: [] },
    { id: 2, projectName: 'Бета', rootPath: 'Корпуса', enabled: true, ready: true, objectIds: ['obj-1', 'obj-2'], status: 'ok', failedSince: null,
      lastOkAt: '2026-11-23T05:00:00.000Z', lastNightOkAt: '2026-11-22T02:15:00.000Z', lastError: null, folders: 88, items: 640, problems: [] },
    { id: 3, projectName: 'Гамма', rootPath: 'Архив', enabled: false, ready: false, objectIds: [], status: 'never', failedSince: null,
      lastOkAt: null, lastNightOkAt: null, lastError: 'root_missing', folders: 0, items: 0, problems: [] },
  ]
  if (params.get('sigFailed') === '1' && sources[1]) Object.assign(sources[1], { status: 'failed', failedSince: '2026-11-22T02:15:00.000Z', lastError: 'root_unavailable' })
  if (params.get('sigProblems') && sources[0]) {
    sources[0].problems = params.get('sigProblems') === 'n'
      ? 3
      : [{ nodeId: uuid(9001), code: 'forbidden' }, { nodeId: uuid(9002), code: 'forbidden' }, { nodeId: uuid(9003), code: 'not_found' }]
  }

  const run = (id, over) => ({ id, kind: 'night', mode: 'full', status: 'ok', reason: null, initiator: 'schedule', startedAt: '2026-11-23T02:00:00.000Z',
    finishedAt: '2026-11-23T02:12:00.000Z', stats: {}, ...over })
  const HELD_OFF = params.get('sigHeld') === '0'
  const runs = [
    run(12, HELD_OFF
      ? { kind: 'day', mode: 'known', startedAt: '2026-11-23T08:00:00.000Z', finishedAt: '2026-11-23T08:09:00.000Z', stats: { roots: [{ id: 1, folders: 30, items: 600 }] } }
      : { kind: 'day', mode: 'known', status: 'held', reason: 'shrink', startedAt: '2026-11-23T08:00:00.000Z', finishedAt: '2026-11-23T08:09:00.000Z',
        stats: { roots: [{ id: 1, folders: 30, items: 600 }, { id: 2, folders: 20, items: 400 }] } }),
    run(11, { stats: { roots: [{ id: 1, folders: 412, items: 1300 }, { id: 2, folders: 88, items: 640 }] } }),
    run(10, { kind: 'manual', status: 'failed', reason: 'auth', initiator: 'admin', startedAt: '2026-11-22T10:00:00.000Z', finishedAt: '2026-11-22T10:00:05.000Z' }),
    run(9, { kind: 'manual', initiator: 'cli', startedAt: '2026-11-21T12:00:00.000Z', finishedAt: '2026-11-21T12:20:00.000Z',
      stats: { roots: [{ id: 1, folders: 400, items: 1250 }] } }),
  ]
  // Упавший процесс: строка «идёт», а heartbeat остановился в 11:10 МСК (08:10 UTC).
  if (params.get('sigStuck') === '1') {
    runs.unshift(run(13, { kind: 'day', mode: 'known', status: 'running', initiator: 'schedule', startedAt: '2026-11-23T08:05:00.000Z', finishedAt: null,
      heartbeatAt: '2026-11-23T08:10:00.000Z', stuck: true }))
  }

  const MORE = params.get('sigAliasMore') === '1'
  const aliases = [
    { id: 'al-1', text: 'Северный кв. 1', objectId: 'obj-1', author: 'Иванов И. И.', createdAt: '2026-11-20T09:30:00.000Z', mine: false },
    ...(MORE ? [
      { id: 'al-2', text: 'СК-1', objectId: 'obj-1', author: 'Тест', createdAt: '2026-11-21T09:30:00.000Z', mine: true },
      { id: 'al-3', text: 'Нурлы-2', objectId: 'obj-2', author: 'Тест', createdAt: '2026-11-21T10:30:00.000Z', mine: true },
      { id: 'al-4', text: 'Нурлы корп. А', objectId: 'obj-1', author: 'Петров П. П.', createdAt: '2026-11-22T09:30:00.000Z', mine: false,
        conflict: params.get('sigAliasConflict') === '1' },
    ] : []),
  ]
  const pubAlias = (a) => ({ id: a.id, text: a.text, objectId: a.objectId, objectName: objectName(a.objectId), author: a.author, createdAt: a.createdAt, ...(a.conflict ? { conflict: true } : {}) })

  // ── Дерево папок корня 2 ──────────────────────────────────────────────────────────────────────────────────────────────────
  // code — объект, чьи номера договоров лежат внутри папки (по ним предупреждает проверка привязки); bind — своя привязка.
  const many = params.get('sigUnassigned') === 'many'
  const nodes = []
  const add = (n, parent, name, items, extra = {}) => { const node = { id: uuid(n), parent: parent ? uuid(parent) : null, name, items, ...extra }; nodes.push(node); return node }
  if (many) {
    for (let i = 0; i < 75; i++) add(5000 + i, null, `Паркинг ${i + 1}`, 12 + i)
  } else {
    add(6000, null, 'Дельта', 4)
    add(6001, 6000, 'корп.14', 6)
    add(6011, 6001, 'Договоры', 10, { code: 'obj-1' })
    add(6002, 6000, 'корп.22', 5)
    add(6021, 6002, 'Договоры', 8, { code: 'obj-2' })
    add(6022, 6021, 'Приложения', 2)
    add(6003, 6000, 'Общие документы', 3)
    add(5000, null, 'Паркинг 1', 12)
    add(5001, null, 'Паркинг 2', 13)
  }
  if (params.get('sigBound') === '1') {
    for (const [id, obj] of [[6001, 'obj-1'], [6002, 'obj-2']]) { const n = nodes.find((x) => x.id === uuid(id)); if (n) Object.assign(n, { bind: obj, boundAt: '2026-11-22T09:00:00.000Z' }) }
  }
  const ROOT_PATH = 'Бета / Корпуса'
  const byId = (id) => nodes.find((n) => n.id === id)
  const parentOf = (n) => (n.parent ? byId(n.parent) : null)
  const chain = (n) => (n ? [...chain(parentOf(n)), n.name] : [])
  const pathOf = (n) => `${ROOT_PATH} / ${chain(n).join(' / ')}`
  const depthOf = (n) => (n.parent ? 1 + depthOf(parentOf(n)) : 1)
  const childrenOf = (n) => nodes.filter((x) => x.parent === (n ? n.id : null)).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  const effective = (n) => { for (let x = n; x; x = parentOf(x)) if (x.bind) return x.bind; return null }
  const pubNode = (n) => {
    const obj = effective(n)
    return { nodeId: n.id, name: n.name, path: pathOf(n), depth: depthOf(n), objectId: obj, objectName: obj ? objectName(obj) : null, bound: !!n.bind,
      boundObjectId: n.bind || null, hasChildren: childrenOf(n).length > 0, items: n.items }
  }
  // Папки поддерева, кроме частей под чужими явными привязками (как signal_binding_preview).
  const subtree = (n, skipBound = true) => [n, ...childrenOf(n).filter((c) => !(skipBound && c.bind)).flatMap((c) => subtree(c, skipBound))]
  const admin = window.__signalAdmin = {
    sources, runs, aliases, nodes, nextSourceId: 4,
    nodeOf: (id) => byId(id),
    bindings: () => nodes.filter((n) => n.bind).map((n) => ({ nodeId: n.id, objectId: n.bind })),
    // Завершить идущий обход (как будто служба закончила): status — 'ok' | 'failed'.
    finishRun(status = 'ok') {
      const r = runs.find((x) => x.status === 'running')
      if (r) Object.assign(r, { status, reason: status === 'ok' ? null : 'http', finishedAt: new Date().toISOString(), stuck: false })
    },
  }
  const pub = (s) => ({ id: s.id, projectName: s.projectName, rootPath: s.rootPath, enabled: s.enabled, ready: s.ready, objects: pubObjects(s.objectIds),
    lastOkAt: s.lastOkAt, lastNightOkAt: s.lastNightOkAt, lastError: s.lastError, folders: s.folders, items: s.items,
    status: s.status, failedSince: s.failedSince, problems: s.problems })
  const pubRun = (r) => ({ ...r, heartbeatAt: undefined, stuck: undefined }) // служебные поля стенда в журнал не уходят

  const runningOf = () => {
    const r = runs.find((x) => x.status === 'running')
    return r ? { runId: r.id, startedAt: r.startedAt, heartbeatAt: r.heartbeatAt || new Date().toISOString(), stuck: !!r.stuck } : null
  }
  const heldOf = () => {
    const r = runs.find((x) => x.status === 'held')
    return r ? { runId: r.id, generation: api.generation } : null
  }
  const alertsOf = (stale, dataAt) => {
    const out = sources.filter((s) => s.status === 'failed').map((s) => ({ kind: 'root_failed', sourceId: s.id, since: s.failedSince }))
    const held = runs.find((x) => x.status === 'held')
    if (held) out.push({ kind: 'run_held', since: held.finishedAt })
    const running = runningOf()
    if (running?.stuck) out.push({ kind: 'run_stuck', since: running.heartbeatAt })
    if (stale) out.push({ kind: 'data_stale', since: dataAt })
    return out
  }

  const wrap = (method, sample, fn) => {
    const r = api.routes.find((x) => x.method === method && x.re.test(sample))
    if (!r) return
    const orig = r.run
    r.run = (ctx) => fn(ctx, orig)
  }
  const route = (method, re, run) => api.routes.unshift({ method, re, run })
  const guarded = (run) => (ctx) => (ADMIN ? run(ctx) : fail(403, 'forbidden', 'Недостаточно прав'))
  const DISABLED_REASON = params.get('sigDisabled')

  wrap('GET', '/api/signal/status', async (ctx, orig) => {
    const res = await orig(ctx)
    const d = await res.json()
    if (!d.enabled) {
      if (ADMIN && DISABLED_REASON) {
        const configErrors = DISABLED_REASON === 'config_invalid' ? ['SIGNAL_URL_FORMATS', 'SIGNAL_UI_FOLDER_URL'] : []
        return json(200, { ...d, disabledReason: DISABLED_REASON, configErrors })
      }
      return json(res.status, d)
    }
    if (!ADMIN) return json(200, { ...d, isAdmin: false })
    return json(200, {
      ...d, isAdmin: true, connection: NOT_CONFIGURED ? 'not_configured' : 'configured', dayMode: 'known', sources: sources.map(pub),
      lastRuns: runs.slice(0, 5).map(pubRun), running: runningOf(), held: heldOf(), alerts: alertsOf(d.stale === true, d.dataAt),
    })
  })

  route('GET', /^\/api\/signal\/runs$/, guarded(({ query }) => ok({ items: runs.slice(0, Math.min(20, Number(query.get('limit') || 20))).map(pubRun) })))

  // Синонимы: администратор — все (с conflict), сотрудник с правкой — только свои (С-2).
  route('GET', /^\/api\/signal\/aliases$/, () => {
    if (ADMIN) return ok({ items: aliases.map(pubAlias) })
    if (params.get('signalEdit') === '0') return fail(403, 'forbidden', 'Недостаточно прав')
    return ok({ items: aliases.filter((a) => a.mine).map(pubAlias) })
  })
  route('DELETE', /^\/api\/signal\/aliases\/([^/]+)$/, ({ match }) => {
    const i = aliases.findIndex((a) => a.id === decodeURIComponent(match[1]))
    if (i < 0) return fail(404, 'not_found', 'Название не найдено')
    if (!ADMIN && !aliases[i].mine) return fail(403, 'forbidden', 'Недостаточно прав')
    aliases.splice(i, 1)
    return ok({ ok: true })
  })

  route('POST', /^\/api\/signal\/sources$/, guarded(({ body }) => {
    const url = String(body.url || '')
    if (!Array.isArray(body.objectIds) || body.objectIds.length > 20 || url.length > 2000) return fail(422, 'invalid', 'Неверный запрос')
    if (!/^https:\/\/signal\.su10\.ru\//.test(url)) return fail(422, 'unsupported_url', 'Ссылка не распознана: нужна ссылка на папку в Signal')
    if (/overlap/.test(url)) return fail(409, 'overlap', 'Эта папка пересекается с уже добавленным корнем')
    if (/missing/.test(url)) return fail(422, 'not_found', 'Папки нет в дереве проекта Signal')
    const s = { id: admin.nextSourceId++, projectName: 'Дельта', rootPath: 'Новые договоры', enabled: true, ready: false, objectIds: [...body.objectIds],
      status: 'never', failedSince: null, lastOkAt: null, lastNightOkAt: null, lastError: null, folders: 0, items: 0, problems: [] }
    sources.push(s)
    return ok({ id: s.id, projectName: s.projectName, rootPath: s.rootPath })
  }))
  route('PATCH', /^\/api\/signal\/sources\/([^/]+)$/, guarded(({ match, body }) => {
    const s = sources.find((x) => String(x.id) === decodeURIComponent(match[1]))
    if (!s) return fail(404, 'not_found', 'Корень не найден')
    if (typeof body.enabled === 'boolean') { s.enabled = body.enabled; if (!body.enabled) s.ready = false }
    if (Array.isArray(body.objectIds)) {
      s.objectIds = [...body.objectIds]
      if (s.id === 2) for (const n of nodes) if (n.bind && !s.objectIds.includes(n.bind)) delete n.bind
    }
    return ok({ ok: true })
  }))
  route('POST', /^\/api\/signal\/sync$/, guarded(() => {
    if (NOT_CONFIGURED || params.get('sigSyncNc') === '1') return fail(409, 'not_configured', 'Подключение к Signal не настроено')
    // Зависший прогон сервер закрывает как stale и запускает новый; живой — отказ 409 busy.
    const dead = runs.find((r) => r.status === 'running' && r.stuck)
    if (dead) Object.assign(dead, { status: 'failed', reason: 'stale', finishedAt: new Date().toISOString(), stuck: false })
    else if (params.get('sigBusy') === '1' || runs.some((r) => r.status === 'running')) return fail(409, 'busy', 'Обход уже идёт')
    const id = Math.max(...runs.map((r) => r.id)) + 1
    runs.unshift(run(id, { kind: 'manual', status: 'running', initiator: 'admin', startedAt: new Date().toISOString(), finishedAt: null, heartbeatAt: new Date().toISOString() }))
    return json(202, { runId: id })
  }))

  // Верхние папки без объекта (корень 2) — постранично.
  route('GET', /^\/api\/signal\/unassigned$/, guarded(({ query }) => {
    const list = Number(query.get('sourceId')) === 2 ? childrenOf(null).filter((n) => !effective(n)) : []
    const from = Number(query.get('after') || 0)
    const limit = Math.min(100, Number(query.get('limit') || 50))
    const items = list.slice(from, from + limit).map((n) => ({ nodeId: n.id, path: pathOf(n), items: n.items }))
    return ok({ items, next: from + limit < list.length ? String(from + limit) : null })
  }))

  // Дерево: без q — дети parentId (корень — верхние папки), с q — поиск по названию и пути; страницы по 50, курсор — смещение.
  route('GET', /^\/api\/signal\/tree$/, guarded(({ query }) => {
    if (Number(query.get('sourceId')) !== 2) return ok({ items: [], next: null })
    const q = String(query.get('q') || '').trim().toLowerCase()
    const parentId = query.get('parentId')
    let list
    if (q) {
      if (q.length > 100) return fail(422, 'invalid', 'Неверный запрос')
      list = nodes.filter((n) => n.name.toLowerCase().includes(q) || pathOf(n).toLowerCase().includes(q)).sort((a, b) => pathOf(a).localeCompare(pathOf(b), 'ru'))
    } else if (parentId) {
      const p = byId(parentId)
      if (!p) return fail(404, 'not_found', 'Папка не найдена')
      list = childrenOf(p)
    } else list = childrenOf(null)
    const from = Number(query.get('after') || 0)
    return ok({ items: list.slice(from, from + PAGE).map(pubNode), next: from + PAGE < list.length ? String(from + PAGE) : null })
  }))

  route('GET', /^\/api\/signal\/bindings$/, guarded(({ query }) => {
    const s = sources.find((x) => String(x.id) === query.get('sourceId'))
    if (!s) return fail(404, 'not_found', 'Корень не найден')
    const items = s.id === 2
      ? nodes.filter((n) => n.bind).sort((a, b) => pathOf(a).localeCompare(pathOf(b), 'ru'))
        .map((n) => ({ nodeId: n.id, path: pathOf(n), objectId: n.bind, objectName: objectName(n.bind), createdAt: n.boundAt || '2026-11-23T09:00:00.000Z', observed: true }))
      : []
    return ok({ rootObjects: pubObjects(s.objectIds), items })
  }))
  route('POST', /^\/api\/signal\/bindings\/preview$/, guarded(({ body }) => {
    const s = sources.find((x) => x.id === body.sourceId || String(x.id) === String(body.sourceId))
    const n = byId(body.nodeId)
    if (!s || !n || s.id !== 2) return fail(404, 'not_found', 'Папка не найдена')
    if (!s.objectIds.includes(body.objectId)) return fail(422, 'invalid', 'Объект не относится к корню')
    if (params.get('sigPreviewFail') === '1') return fail(503, 'signal_unavailable', 'Проверка привязки временно недоступна')
    const inside = subtree(n)
    const foreign = new Map()
    for (const x of inside) if (x.code && x.code !== body.objectId) foreign.set(x.code, (foreign.get(x.code) || 0) + 1)
    return ok({
      warnings: [...foreign].map(([objectId, folders]) => ({ objectId, objectName: objectName(objectId), folders })),
      affected: { folders: inside.length, items: inside.reduce((sum, x) => sum + x.items, 0) },
    })
  }))
  // Привязка и «Снять» (objectId: null).
  route('POST', /^\/api\/signal\/bindings$/, guarded(({ body }) => {
    const s = sources.find((x) => x.id === body.sourceId || String(x.id) === String(body.sourceId))
    if (!s) return fail(404, 'not_found', 'Корень не найден')
    if (body.objectId && !s.objectIds.includes(body.objectId)) return fail(422, 'invalid', 'Объект не относится к корню')
    const n = byId(body.nodeId)
    if (!n || s.id !== 2) return fail(404, 'not_found', 'Папка не найдена')
    if (params.get('sigBindFail') === '1' && body.objectId) return fail(409, 'busy', 'Корень сейчас обновляется — повторите привязку позже')
    if (body.objectId) Object.assign(n, { bind: body.objectId, boundAt: new Date().toISOString() })
    else delete n.bind
    return ok({ ok: true })
  }))
}
