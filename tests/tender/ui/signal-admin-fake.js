// Надстройка над signal-fake.js (P5a) для «Администрирование» → «Signal»: администраторская часть состояния сервера (корни, прогоны,
// синонимы, папки без объекта) и маршруты 9, 11–17 (раздел 7 спецификации) из памяти страницы. Подключается из
// signal-stand-main.jsx после seed.js; без ?signal=… ничего не делает.
//   sigAdmin=0     — вошедший не администратор: status без админских полей и isAdmin: false, админские маршруты — 403;
//   sigConn=off    — подключение не настроено (connection: 'not_configured', обход — 409 not_configured);
//   sigSources=none — корней нет;
//   sigBusy=1      — «Синхронизировать» отвечает 409 busy (обход уже идёт, хотя журнал этого не показывает);
//   sigUnassigned=many — у многообъектного корня 75 папок без объекта (страницы по 50).
// Состояние — window.__signalAdmin: { sources, runs, aliases, unassigned, bindings, finishRun(status?) } — тесты читают и правят.
// Корни: 1 — «Альфа → Договора подряда» (один объект), 2 — «Бета → Корпуса» (два объекта, есть папки без объекта),
// 3 — «Гамма → Архив» (выключен, без объектов, с ошибкой). Все названия вымышленные.
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

  const sources = params.get('sigSources') === 'none' ? [] : [
    { id: 1, projectName: 'Альфа', rootPath: 'Договора подряда', enabled: true, ready: true, objectIds: ['obj-1'],
      lastOkAt: '2026-11-23T02:12:00.000Z', lastNightOkAt: '2026-11-23T02:12:00.000Z', lastError: null, folders: 412, items: 1300 },
    { id: 2, projectName: 'Бета', rootPath: 'Корпуса', enabled: true, ready: true, objectIds: ['obj-1', 'obj-2'],
      lastOkAt: '2026-11-23T05:00:00.000Z', lastNightOkAt: '2026-11-22T02:15:00.000Z', lastError: null, folders: 88, items: 640 },
    { id: 3, projectName: 'Гамма', rootPath: 'Архив', enabled: false, ready: false, objectIds: [],
      lastOkAt: null, lastNightOkAt: null, lastError: 'root_missing', folders: 0, items: 0 },
  ]
  const run = (id, over) => ({ id, kind: 'night', mode: 'full', status: 'ok', reason: null, initiator: 'schedule', startedAt: '2026-11-23T02:00:00.000Z',
    finishedAt: '2026-11-23T02:12:00.000Z', stats: {}, ...over })
  const runs = [
    run(12, { kind: 'day', mode: 'known', status: 'held', reason: 'shrink', startedAt: '2026-11-23T08:00:00.000Z', finishedAt: '2026-11-23T08:09:00.000Z',
      stats: { roots: [{ id: 1, folders: 30, items: 600 }, { id: 2, folders: 20, items: 400 }] } }),
    run(11, { stats: { roots: [{ id: 1, folders: 412, items: 1300 }, { id: 2, folders: 88, items: 640 }] } }),
    run(10, { kind: 'manual', status: 'failed', reason: 'auth', initiator: 'admin', startedAt: '2026-11-22T10:00:00.000Z', finishedAt: '2026-11-22T10:00:05.000Z' }),
    run(9, { kind: 'manual', initiator: 'cli', startedAt: '2026-11-21T12:00:00.000Z', finishedAt: '2026-11-21T12:20:00.000Z',
      stats: { roots: [{ id: 1, folders: 400, items: 1250 }] } }),
  ]
  const aliases = [{ id: 'al-1', text: 'Северный кв. 1', objectId: 'obj-1', objectName: objectName('obj-1'), author: 'Иванов И. И.', createdAt: '2026-11-20T09:30:00.000Z' }]
  const many = params.get('sigUnassigned') === 'many'
  const unassigned = { 2: Array.from({ length: many ? 75 : 3 }, (_, i) => ({ nodeId: uuid(5000 + i), path: `Бета / Корпуса / Паркинг ${i + 1}`, items: 12 + i })) }
  const bindings = []
  const admin = window.__signalAdmin = {
    sources, runs, aliases, unassigned, bindings, nextSourceId: 4,
    // Завершить идущий обход (как будто служба закончила): status — 'ok' | 'failed'.
    finishRun(status = 'ok') {
      const r = runs.find((x) => x.status === 'running')
      if (r) Object.assign(r, { status, reason: status === 'ok' ? null : 'http', finishedAt: new Date().toISOString() })
    },
  }
  const pub = (s) => ({ id: s.id, projectName: s.projectName, rootPath: s.rootPath, enabled: s.enabled, ready: s.ready, objects: pubObjects(s.objectIds),
    lastOkAt: s.lastOkAt, lastNightOkAt: s.lastNightOkAt, lastError: s.lastError, folders: s.folders, items: s.items })

  const wrap = (method, sample, fn) => {
    const r = api.routes.find((x) => x.method === method && x.re.test(sample))
    if (!r) return
    const orig = r.run
    r.run = (ctx) => fn(ctx, orig)
  }
  const route = (method, re, run) => api.routes.unshift({ method, re, run })
  const guarded = (run) => (ctx) => (ADMIN ? run(ctx) : fail(403, 'forbidden', 'Недостаточно прав'))

  wrap('GET', '/api/signal/status', async (ctx, orig) => {
    const res = await orig(ctx)
    const d = await res.json()
    if (!d.enabled) return json(res.status, d)
    if (!ADMIN) return json(200, { ...d, isAdmin: false })
    return json(200, { ...d, isAdmin: true, connection: NOT_CONFIGURED ? 'not_configured' : 'configured', dayMode: 'known', sources: sources.map(pub), lastRuns: runs.slice(0, 5) })
  })

  route('GET', /^\/api\/signal\/runs$/, guarded(({ query }) => ok({ items: runs.slice(0, Math.min(20, Number(query.get('limit') || 20))) })))
  route('GET', /^\/api\/signal\/aliases$/, guarded(() => ok({ items: aliases })))
  route('DELETE', /^\/api\/signal\/aliases\/([^/]+)$/, guarded(({ match }) => {
    const i = aliases.findIndex((a) => a.id === decodeURIComponent(match[1]))
    if (i < 0) return fail(404, 'not_found', 'Название не найдено')
    aliases.splice(i, 1)
    return ok({ ok: true })
  }))

  route('POST', /^\/api\/signal\/sources$/, guarded(({ body }) => {
    const url = String(body.url || '')
    if (!Array.isArray(body.objectIds) || body.objectIds.length > 20 || url.length > 2000) return fail(422, 'invalid', 'Неверный запрос')
    if (!/^https:\/\/signal\.su10\.ru\//.test(url)) return fail(422, 'unsupported_url', 'Ссылка не распознана: нужна ссылка на папку в Signal')
    if (/overlap/.test(url)) return fail(409, 'overlap', 'Эта папка пересекается с уже добавленным корнем')
    if (/missing/.test(url)) return fail(422, 'not_found', 'Папки нет в дереве проекта Signal')
    const s = { id: admin.nextSourceId++, projectName: 'Дельта', rootPath: 'Новые договоры', enabled: true, ready: false, objectIds: [...body.objectIds],
      lastOkAt: null, lastNightOkAt: null, lastError: null, folders: 0, items: 0 }
    sources.push(s)
    return ok({ id: s.id, projectName: s.projectName, rootPath: s.rootPath })
  }))
  route('PATCH', /^\/api\/signal\/sources\/([^/]+)$/, guarded(({ match, body }) => {
    const s = sources.find((x) => String(x.id) === decodeURIComponent(match[1]))
    if (!s) return fail(404, 'not_found', 'Корень не найден')
    if (typeof body.enabled === 'boolean') { s.enabled = body.enabled; if (!body.enabled) s.ready = false }
    if (Array.isArray(body.objectIds)) {
      s.objectIds = [...body.objectIds]
      for (let i = bindings.length - 1; i >= 0; i--) if (bindings[i].sourceId === s.id && !s.objectIds.includes(bindings[i].objectId)) bindings.splice(i, 1)
    }
    return ok({ ok: true })
  }))
  route('POST', /^\/api\/signal\/sync$/, guarded(() => {
    if (NOT_CONFIGURED || params.get('sigSyncNc') === '1') return fail(409, 'not_configured', 'Подключение к Signal не настроено')
    if (params.get('sigBusy') === '1' || runs.some((r) => r.status === 'running')) return fail(409, 'busy', 'Обход уже идёт')
    const id = Math.max(...runs.map((r) => r.id)) + 1
    runs.unshift(run(id, { kind: 'manual', status: 'running', initiator: 'admin', startedAt: new Date().toISOString(), finishedAt: null }))
    return json(202, { runId: id })
  }))
  route('GET', /^\/api\/signal\/unassigned$/, guarded(({ query }) => {
    const list = unassigned[query.get('sourceId')] || []
    const from = Number(query.get('after') || 0)
    const limit = Math.min(100, Number(query.get('limit') || 50))
    const items = list.slice(from, from + limit)
    return ok({ items, next: from + limit < list.length ? String(from + limit) : null })
  }))
  route('POST', /^\/api\/signal\/bindings$/, guarded(({ body }) => {
    const s = sources.find((x) => x.id === body.sourceId || String(x.id) === String(body.sourceId))
    if (!s) return fail(404, 'not_found', 'Корень не найден')
    if (body.objectId && !s.objectIds.includes(body.objectId)) return fail(422, 'invalid', 'Объект не относится к корню')
    const list = unassigned[s.id] || []
    const i = list.findIndex((n) => n.nodeId === body.nodeId)
    if (i < 0) return fail(404, 'not_found', 'Папка не найдена')
    list.splice(i, 1)
    bindings.push({ sourceId: s.id, nodeId: body.nodeId, objectId: body.objectId })
    return ok({ ok: true })
  }))
}
