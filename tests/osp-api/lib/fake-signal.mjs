// Поддельный SIGNAL на 127.0.0.1 для тестов клиента, адаптера и синхронизации (живого SIGNAL тесты не трогают).
//
//   const fake = await startFakeSignal()
//   const project = fake.addProject({ name: 'Проект А' })
//   const { ids } = fake.build(project, { name: 'Объект 1', items: 3, children: [{ name: 'Договоры', items: 2 }] })
//   fake.fail('/items', { status: 429, headers: { 'retry-after': '2' }, times: 2 })
//   …
//   await fake.close()
//
// Только синтетика: названия вымышленные, uuid вида …-4000-8000-…, идентификатор и секрет клиента — тестовые.
// Что умеет:
//   • токен: POST /public/v1/auth/token { clientId, clientSecret, scopes } → { token, expiresIn }; неверный секрет —
//     422 "CredentialError", неизвестное право — 422 "ScopeError"; revokeTokens() — следующий запрос получит 401;
//   • проекты (Skip/Take), дерево проекта одним ответом (объект или массив корней), элементы папки постранично,
//     поиск элементов (POST — чтение);
//   • управляемое дерево между прогонами: addFolder, removeFolder (с поддеревом), moveFolder, renameFolder, setItems,
//     addItems, denyProject (403 на дерево), removeProject;
//   • сбои: fail(совпадение, { status, headers, body, times, delayMs, hang }) — 429 с Retry-After, 401/403/5xx/550/450,
//     перенаправление (status 307 + location), большое тело (bigBody — потоком, bigDeclared — объявленный размер);
//   • requests — журнал всех запросов; violations — запросы с методом или путём вне разрешённого набора
//     (чтение + токен): тест ждёт, что список пуст; leakNext — в ответах «следующий» адрес на чужой хост.
import http from 'node:http'
import { Buffer } from 'node:buffer'

export const CLIENT_ID = 'sig-client-test-0001'
export const CLIENT_SECRET = 'sig-Secret-Value-For-Tests-0001'
export const SCOPES = ['project:list', 'docs:folder:read', 'docs:item:list']
export const EVIL_URL = 'https://evil.example.invalid/next'

const hex = (n, w) => Number(n).toString(16).padStart(w, '0')
const KIND = { project: 1, folder: 2, item: 3, misc: 4 }
// Синтетические идентификаторы: стабильные для одних и тех же (вид, номер).
export const fakeId = (kind, n) => `${hex(KIND[kind] || KIND.misc, 8)}-0000-4000-8000-${hex(n, 12)}`

const ALLOWED = [
  ['POST', /^\/public\/v1\/auth\/token$/],
  ['GET', /^\/public\/v1\/projects$/],
  ['GET', /^\/public\/v1\/projects\/[0-9a-f-]{36}\/folders\/tree$/],
  ['GET', /^\/public\/v1\/items$/],
  ['POST', /^\/public\/v1\/items\/search$/],
]

const readBody = (req) => new Promise((resolve) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
})

export async function startFakeSignal({ clientId = CLIENT_ID, clientSecret = CLIENT_SECRET, expiresIn = 3600 } = {}) {
  const state = {
    clientId, clientSecret, expiresIn,
    tokenSeq: 0,
    tokens: new Set(),
    lastToken: null,
    projects: [], // { id, name, code, rootId }
    folders: new Map(), // projectId → Map(folderId → { id, name, parentId, modified, type })
    items: new Map(), // folderId → [item]
    denied: new Set(),
    treeShape: 'object', // 'object' — один корень, 'array' — массив корней
    leakNext: false,
    delayMs: 0,
    itemsDelayMs: 0,
    faults: [],
    counters: { project: 0, folder: 0, item: 0 },
    clock: 0,
  }
  const requests = []
  const violations = []
  const timers = new Set()
  const sockets = new Set()

  const stamp = () => new Date(Date.UTC(2026, 0, 1) + (state.clock++) * 60_000).toISOString()
  const nextId = (kind) => fakeId(kind, ++state.counters[kind])

  const wait = (ms) => new Promise((resolve) => { const t = setTimeout(() => { timers.delete(t); resolve() }, ms); timers.add(t) })
  const json = (res, status, obj, headers = {}) => {
    const text = JSON.stringify(obj)
    res.writeHead(status, { 'content-type': 'application/json', ...(state.leakNext ? { link: `<${EVIL_URL}>; rel="next"` } : {}), ...headers })
    res.end(text)
  }

  function renderFolder(projectId, folder) {
    const map = state.folders.get(projectId)
    const children = [...map.values()].filter((f) => f.parentId === folder.id).map((f) => renderFolder(projectId, f))
    return {
      id: folder.id, name: folder.name, modified: folder.modified, type: folder.type, color: null,
      permissions: { read: true }, children, ...(state.leakNext ? { next: EVIL_URL } : {}),
    }
  }

  function descendants(projectId, id) {
    const map = state.folders.get(projectId)
    const out = [id]
    for (let i = 0; i < out.length; i++) for (const f of map.values()) if (f.parentId === out[i]) out.push(f.id)
    return out
  }
  const folderProject = (folderId) => state.projects.find((p) => state.folders.get(p.id)?.has(folderId))?.id || null

  const itemJson = (it) => ({
    id: it.id, folderId: it.folderId, name: it.name, type: it.type, modified: it.modified, added: it.added, deleted: it.deleted,
    topVersionNumber: it.topVersionNumber, topVersionId: fakeId('misc', 1), topItemVersionId: fakeId('misc', 2),
    link: it.type === 'Link' ? EVIL_URL : null,
  })

  async function applyFault(req, res, f) {
    if (f.delayMs) await wait(f.delayMs)
    if (f.hang) { await wait(60_000); return true }
    if (f.bigDeclared) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(f.bigDeclared) })
      res.write('[', () => { const t = setTimeout(() => { timers.delete(t); res.destroy() }, 200); timers.add(t) })
      return true
    }
    if (f.bigBody) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('[')
      const piece = `"${'x'.repeat(1000)}",`
      for (let sent = 1; sent < f.bigBody; sent += piece.length) {
        if (res.destroyed) return true
        if (!res.write(piece)) await new Promise((r) => res.once('drain', r))
      }
      res.end('"end"]')
      return true
    }
    if (f.status) {
      const headers = { 'content-type': 'application/json', ...(f.headers || {}) }
      const body = typeof f.body === 'function' ? f.body(req, fake) : f.body
      res.writeHead(f.status, headers)
      res.end(body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body)))
      return true
    }
    return false
  }

  const matches = (m, req) => (typeof m === 'string' ? `${req.path}?${req.rawQuery}`.includes(m)
    : m instanceof RegExp ? m.test(`${req.path}?${req.rawQuery}`) : typeof m === 'function' ? m(req) : true)

  async function handle(request, res) {
    const url = new URL(request.url, 'http://fake')
    const raw = await readBody(request)
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
    const req = {
      method: request.method, path: url.pathname, rawQuery: url.search.slice(1),
      query: Object.fromEntries(url.searchParams), headers: request.headers, body,
    }
    requests.push(req)

    if (!ALLOWED.some(([m, re]) => m === req.method && re.test(req.path))) {
      violations.push({ method: req.method, path: req.path })
      return json(res, ALLOWED.some(([, re]) => re.test(req.path)) ? 405 : 404, { message: 'not allowed' })
    }
    for (const f of state.faults) {
      if (f.times > 0 && matches(f.match, req)) {
        f.times -= 1
        if (await applyFault(request, res, f)) return
      }
    }
    if (state.delayMs) await wait(state.delayMs)

    if (req.path === '/public/v1/auth/token') {
      if (!body || typeof body !== 'object' || Object.keys(body).sort().join() !== 'clientId,clientSecret,scopes' || !Array.isArray(body.scopes)) {
        return json(res, 400, { message: 'bad body' })
      }
      if (body.clientId !== state.clientId || body.clientSecret !== state.clientSecret) return json(res, 422, 'CredentialError')
      if (body.scopes.some((s) => !SCOPES.includes(s))) return json(res, 422, 'ScopeError')
      const token = `eyJfake.${hex(++state.tokenSeq, 6)}.${'t'.repeat(24)}-signal-token`
      state.tokens.add(token)
      state.lastToken = token
      return json(res, 200, { token, expiresIn: state.expiresIn })
    }

    const auth = String(req.headers.authorization || '')
    if (!auth.startsWith('Bearer ') || !state.tokens.has(auth.slice(7))) return json(res, 401, { message: 'unauthorized' })

    const skip = Number(req.query.Skip ?? 0)
    const take = Number(req.query.Take ?? 100)
    if (!Number.isInteger(skip) || skip < 0 || !Number.isInteger(take) || take < 1 || take > 200) return json(res, 400, { message: 'bad page' })

    if (req.path === '/public/v1/projects') return json(res, 200, state.projects.slice(skip, skip + take).map(({ id, name, code }) => ({ id, name, code })))

    const tree = /^\/public\/v1\/projects\/([0-9a-f-]{36})\/folders\/tree$/.exec(req.path)
    if (tree) {
      const project = state.projects.find((p) => p.id === tree[1])
      if (!project) return json(res, 404, { message: 'no project' })
      if (state.denied.has(project.id)) return json(res, 403, { message: 'forbidden' })
      const root = state.folders.get(project.id).get(project.rootId)
      const rendered = renderFolder(project.id, root)
      return json(res, 200, state.treeShape === 'array' ? [rendered] : rendered)
    }

    if (req.path === '/public/v1/items') {
      if (state.itemsDelayMs) await wait(state.itemsDelayMs)
      const folderId = req.query.folderId
      if (!folderProject(folderId)) return json(res, 404, { message: 'no folder' })
      const all = (state.items.get(folderId) || []).filter((it) => (req.query.deleted === 'true' ? it.deleted : !it.deleted))
      return json(res, 200, all.slice(skip, skip + take).map(itemJson))
    }

    if (req.path === '/public/v1/items/search') {
      const folderId = body?.folderId
      const projectId = folderProject(folderId)
      if (!projectId) return json(res, 404, { message: 'no folder' })
      const from = body.modifiedFrom ? Date.parse(body.modifiedFrom) : -Infinity
      const all = descendants(projectId, folderId).flatMap((id) => state.items.get(id) || [])
        .filter((it) => !it.deleted && Date.parse(it.modified) >= from)
      return json(res, 200, all.slice(skip, skip + take).map(itemJson))
    }
    return json(res, 404, {})
  }

  const server = http.createServer((req, res) => { handle(req, res).catch((err) => { try { json(res, 500, { message: String(err?.message || err) }) } catch { /* ответ уже закрыт */ } }) })
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const fake = {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    requests,
    violations,
    clientId,
    clientSecret,
    get lastToken() { return state.lastToken },

    // Число запросов, у которых путь+запрос содержит строку (или подходит под регулярное выражение).
    count: (m, method) => requests.filter((r) => (!method || r.method === method) && matches(m, r)).length,
    paths: () => requests.map((r) => `${r.method} ${r.path}`),
    resetRequests: () => { requests.length = 0 },

    fail(match, spec) { state.faults.push({ match, times: 1, ...spec }); return spec },
    clearFaults: () => { state.faults.length = 0 },
    revokeTokens: () => state.tokens.clear(),
    set treeShape(v) { state.treeShape = v },
    set leakNext(v) { state.leakNext = Boolean(v) },
    set delayMs(v) { state.delayMs = Number(v) || 0 },
    set itemsDelayMs(v) { state.itemsDelayMs = Number(v) || 0 },
    set expiresIn(v) { state.expiresIn = Number(v) },

    addProject({ id = nextId('project'), name = 'Проект', code = null } = {}) {
      const rootId = nextId('folder')
      state.projects.push({ id, name, code, rootId })
      state.folders.set(id, new Map([[rootId, { id: rootId, name: 'Документы', parentId: null, modified: stamp(), type: 'System' }]]))
      return id
    },
    removeProject(id) {
      state.projects = state.projects.filter((p) => p.id !== id)
      state.folders.delete(id)
    },
    denyProject: (id) => state.denied.add(id),
    allowProject: (id) => state.denied.delete(id),
    rootOf: (projectId) => state.projects.find((p) => p.id === projectId)?.rootId,

    addFolder(projectId, { id = nextId('folder'), name, parentId } = {}) {
      const map = state.folders.get(projectId)
      const parent = parentId || state.projects.find((p) => p.id === projectId).rootId
      if (!map.has(parent)) throw new Error('fake-signal: нет родителя')
      map.set(id, { id, name, parentId: parent, modified: stamp(), type: 'Regular' })
      return id
    },
    removeFolder(projectId, id) {
      for (const f of descendants(projectId, id)) { state.folders.get(projectId).delete(f); state.items.delete(f) }
    },
    moveFolder(projectId, id, newParentId) {
      const f = state.folders.get(projectId).get(id)
      f.parentId = newParentId
      f.modified = stamp()
    },
    renameFolder(projectId, id, name) {
      const f = state.folders.get(projectId).get(id)
      f.name = name
      f.modified = stamp()
    },
    setItems(folderId, items) { state.items.set(folderId, items.map((it) => ({ ...it, folderId }))) },
    addItems(folderId, n, { prefix = 'Файл', type = 'File', deleted = false } = {}) {
      const list = state.items.get(folderId) || []
      for (let i = 0; i < n; i++) {
        const id = nextId('item')
        list.push({ id, folderId, name: `${prefix} ${list.length + 1}.pdf`, type, modified: stamp(), added: stamp(), deleted, topVersionNumber: 1 })
      }
      state.items.set(folderId, list)
      return list.slice(-n).map((it) => it.id)
    },
    // spec: { name, items?: число, children?: [spec] } под корнем проекта; ключ ids — путь из названий через « / ».
    build(projectId, spec) {
      const ids = {}
      const walk = (node, parentId, prefix) => {
        const path = prefix ? `${prefix} / ${node.name}` : node.name
        const id = this.addFolder(projectId, { name: node.name, parentId })
        ids[path] = id
        if (node.items) this.addItems(id, node.items)
        for (const child of node.children || []) walk(child, id, path)
      }
      for (const top of Array.isArray(spec) ? spec : [spec]) walk(top, undefined, '')
      return { ids }
    },
    folderIds: (projectId) => [...state.folders.get(projectId).keys()],

    async close() {
      for (const t of timers) clearTimeout(t)
      for (const s of sockets) s.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
  return fake
}
