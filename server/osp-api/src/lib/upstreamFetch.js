// Адрес PostgREST за шлюзом (OSP_PGRST_URL) и способ к нему ходить — один для обоих путей: шлюз /api/db
// (src/routes/dbGateway.js) и внутренний клиент данных маршрутов (src/app.js: /api/ready, файлы, служебные чтения).
//
//   http://хост:порт       — по сети (разработка, прежний сервер, тесты);
//   unix:/путь/к/сокету    — по сокету в общем томе (сервер corp, deploy/docker/compose.yml).
//
// Зачем сокет. osp-api подключён и к общей сети сервера (вход через Keycloak ходит на auth.su10.ru). Имя osp-postgrest
// в общей сети мог бы взять соседний контейнер — и получал бы внутренние токены шлюза вместе с телами запросов. У
// сокета имени в сети нет: до PostgREST доходит только тот, у кого есть том.
import http from 'node:http'
import { Readable } from 'node:stream'

const UNIX_PREFIX = 'unix:'
// Имя хоста в адресах запросов по сокету: только для построителя запросов, в сеть не уходит.
export const UNIX_BASE = 'http://osp-postgrest.sock'

// → { base, socketPath } | null (не задано). Неверный вид — исключение до запуска службы.
export function parseUpstream(raw) {
  const v = String(raw || '').trim()
  if (!v) return null
  if (v.startsWith(UNIX_PREFIX)) {
    const socketPath = v.slice(UNIX_PREFIX.length)
    if (!/^\/[A-Za-z0-9._/-]{1,200}$/.test(socketPath) || socketPath.includes('..')) {
      throw new Error('OSP_PGRST_URL: сокет — unix:/абсолютный/путь')
    }
    return { base: UNIX_BASE, socketPath }
  }
  let u
  try { u = new URL(v) } catch { throw new Error('OSP_PGRST_URL: не адрес') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('OSP_PGRST_URL: только http(s):// или unix:/путь')
  return { base: v.replace(/\/+$/, ''), socketPath: null }
}

// fetch по unix-сокету: тот же ответ (Response, тело потоком), что у глобального fetch, — шлюзу и построителю запросов
// всё равно, как дошёл запрос.
export function unixSocketFetch(socketPath) {
  return (input, init = {}) => new Promise((resolve, reject) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = String(init.method || 'GET').toUpperCase()
    const headers = {}
    new Headers(init.headers).forEach((value, key) => { headers[key] = value })
    headers.host = 'osp-postgrest'
    let body = init.body
    if (body != null && !(typeof body === 'string' || body instanceof Uint8Array)) body = String(body)
    if (body != null && headers['content-length'] === undefined) headers['content-length'] = String(Buffer.byteLength(body))
    const req = http.request({ socketPath, method, path: url.pathname + url.search, headers, signal: init.signal }, (res) => {
      const out = new Headers()
      for (const [key, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) for (const one of value) out.append(key, one)
        else if (value != null) out.set(key, String(value))
      }
      const status = res.statusCode || 502
      const noBody = method === 'HEAD' || status === 204 || status === 205 || status === 304
      if (noBody) res.resume()
      resolve(new Response(noBody ? null : Readable.toWeb(res), { status, statusText: res.statusMessage || '', headers: out }))
    })
    req.on('error', reject)
    req.end(body ?? undefined)
  })
}

// → fetch для этого адреса: по сети — глобальный fetch, по сокету — свой.
export function upstreamFetch(parsed, fallback = fetch) {
  return parsed?.socketPath ? unixSocketFetch(parsed.socketPath) : fallback
}
