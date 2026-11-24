// Приложение osp-api с входом по токену для тестов сверки с Signal (пакет P4): настоящая база (tests/osp-api/lib/signal-db.mjs),
// настоящий buildApp, поддельный SIGNAL (tests/osp-api/lib/fake-signal.mjs) — по желанию. Таймеры очереди и обхода выключены
// (config.signal.timers = false): такт запускает тест сам — app.signal.jobs.tick(), app.signal.sync.runNow().
//
//   const h = await startSignalApp(db, { fake })           // fake — поддельный SIGNAL: клиент настроен
//   const res = await h.call(userId, 'GET', '/api/signal/status')
//   await h.tick()                                         // такт очереди до опустошения
//   await h.close()
//
// Пользователи — только синтетические (db.seed.*); токены подписаны так же, как токены Supabase Auth.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SERVER } from './signal-db.mjs'
import { SECRET, userToken, projectKey } from './tokens.mjs'
import { CLIENT_ID, CLIENT_SECRET } from './fake-signal.mjs'

export const SUPABASE_URL = 'http://127.0.0.1:9'
export const HOST = 'https://signal.example.test'
export const FOLDER_FORMAT = `${HOST}/projects/{projectId}/folders/{folderId}`
export const ITEM_FORMAT = `${HOST}/projects/{projectId}/files/{itemId}`
export const folderUrl = (projectId, folderId) => `${HOST}/projects/${projectId}/folders/${folderId}`
export const itemUrl = (projectId, itemId) => `${HOST}/projects/${projectId}/files/${itemId}`

export function signalConfig({ fake = null, uiFolderUrl = FOLDER_FORMAT, uiFileUrl = ITEM_FORMAT, urlFormats = [FOLDER_FORMAT, ITEM_FORMAT], ...rest } = {}) {
  return {
    sync: true,
    baseUrl: fake ? fake.url : 'https://api.sgnl.pro',
    hosts: [],
    clientId: fake ? CLIENT_ID : '',
    clientSecret: fake ? CLIENT_SECRET : '',
    urlFormats, uiFolderUrl, uiFileUrl,
    timers: false,
    ...rest,
  }
}

export async function startSignalApp(db, { fake = null, signal = {}, withSignal = true, readOnly = false, logs = null, userStatusTtlMs = 0, limits = null } = {}) {
  const { buildApp, defaultDeps } = await import(path.join(SERVER, 'src', 'app.js'))
  const { DEFAULT_LIMITS } = await import(path.join(SERVER, 'src', 'lib', 'limits.js'))
  const tmp = readOnly ? fs.mkdtempSync(path.join(os.tmpdir(), 'signal-ro-')) : null
  const readOnlyFile = tmp ? path.join(tmp, 'db-readonly') : ''
  const config = {
    host: '127.0.0.1', port: 0,
    supabaseUrl: SUPABASE_URL, supabaseAnonKey: projectKey('anon'), supabaseServiceKey: 'service-test-key', supabaseJwtSecret: SECRET,
    s3: {}, anthropicApiKey: '', ratesApiKeys: [],
    db: { url: db.url, caFile: '', poolMax: 4, secondLockRole: '' }, userStatusTtlMs,
    ...(readOnly ? { dbGateway: { upstream: 'http://127.0.0.1:9', secret: 'g'.repeat(40), dbRole: 'portal_owner', readOnlyFile } } : {}),
    ...(withSignal ? { signal: signalConfig({ fake, ...signal }) } : {}),
  }
  const app = buildApp({
    config,
    deps: { ...defaultDeps, signalClient: { allowLoopback: true } },
    logger: logs ? { level: 'info', stream: { write: (line) => logs.push(line) } } : false,
    // Ручной обход — раз в минуту на пользователя: тестам, которые запускают его много раз, предел расширяется явно.
    ...(limits ? { limits: { ...DEFAULT_LIMITS, ...limits } } : {}),
  })
  await app.ready()

  const headers = (uid) => (uid ? { authorization: `Bearer ${userToken(SUPABASE_URL, uid)}` } : {})
  const call = (uid, method, url, payload) => app.inject({
    method, url, headers: headers(uid),
    ...(payload !== undefined ? { payload } : method === 'GET' ? {} : { payload: {} }),
  })
  return {
    app, call, headers,
    get: (uid, url) => call(uid, 'GET', url),
    post: (uid, url, payload = {}) => call(uid, 'POST', url, payload),
    async tick() {
      let total = 0
      for (let i = 0; i < 50; i++) {
        const r = await app.signal.jobs.tick()
        if (!r.contracts) return { ...r, total }
        total += r.contracts
      }
      return { total }
    },
    setReadOnly(value) {
      if (!readOnlyFile) throw new Error('startSignalApp: readOnly не включён')
      if (value) fs.writeFileSync(readOnlyFile, '1')
      else fs.rmSync(readOnlyFile, { force: true })
    },
    async close() {
      await app.close()
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
    },
  }
}

// Снимок «Альфа»: корень с корпусами и папками договоров; числовые ключи и нормализованное имя считает prepareNode — как обход.
export async function nodeTree(spec) {
  const { prepareNode } = await import(path.join(SERVER, 'src', 'lib', 'signalMatch.js'))
  const walk = (node, parentPath) => {
    const nodePath = parentPath ? `${parentPath} / ${node.name}` : node.name
    const p = prepareNode({ name: node.name, path: nodePath, kind: node.kind || 'folder' })
    return {
      ...node, numberKeys: p.numberKeys, nameNorm: p.nameNorm, features: p.features,
      children: (node.children || []).map((c) => walk(c, nodePath)),
      items: (node.items || []).map((c) => walk({ ...c, kind: 'item' }, nodePath)),
    }
  }
  return walk(spec, '')
}
