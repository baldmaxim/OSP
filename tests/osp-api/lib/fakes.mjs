// Подделки для тестов osp-api: HTTP-сервер «как Supabase» (Auth + PostgREST) и «как S3».
// supabase-js в osp-api настоящий — проверяются и сами запросы (фильтры, токен, ключ), а не только
// логика маршрутов. Персональных данных нет: пользователи и строки синтетические.
import http from 'node:http'

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

const eqParam = (url, col) => {
  const v = url.searchParams.get(col)
  return v && v.startsWith('eq.') ? v.slice(3) : null
}

function pick(row, select) {
  if (!select || select === '*') return row
  const out = {}
  for (const c of select.split(',').map((s) => s.trim())) out[c] = row[c] ?? null
  return out
}

// state:
//   users       { <token>: { id } }              — /auth/v1/user
//   roles       { <userId>: { role, counterparty_id, is_approved, is_blocked, full_name } } — user_roles
//               (RLS: только своя строка)
//   docs        { <s3_key>: { row: {id, owner_type, owner_id, …}, visibleTo: 'all' | [userId] } } —
//               s3_documents: чтение по s3_key / id, вставка (дубль id или s3_key — 23505), удаление с
//               возвратом строк; onInsert(row) — вызывается перед вставкой (гонка повторов)
//   can         { <userId>: 'all' | ['раздел:view', 'раздел:edit', …] } — rpc osp_can; noOspCan — функции
//               нет (PGRST202, Р2a не применена)
//   myContracts { <userId>: [contractId] }       — rpc is_my_contract
//   views       { kp_rates_registry: [...], supply_rates_registry: [...] }
//   viewTotal   число для Content-Range при count=exact; countFails — подсчёт падает;
//   missingView — представления нет (42P01)
export async function startFakeSupabase(state) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake')
    const body = await readBody(req)
    const auth = req.headers.authorization || ''
    const token = auth.replace(/^Bearer\s+/i, '')
    requests.push({ method: req.method, path: url.pathname, params: url.searchParams, auth, apikey: req.headers.apikey, prefer: req.headers.prefer || '', body })
    const send = (status, obj, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(obj === undefined ? '' : JSON.stringify(obj))
    }

    if (url.pathname === '/auth/v1/health') {
      return req.headers.apikey ? send(200, { name: 'GoTrue' }) : send(401, { message: 'no apikey' })
    }
    if (url.pathname === '/auth/v1/user') {
      const u = state.users[token]
      return u ? send(200, { id: u.id, aud: 'authenticated', role: 'authenticated' })
        : send(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' })
    }
    const uid = state.users[token]?.id || null // «кто спрашивает» для RLS

    if (url.pathname === '/rest/v1/user_roles') {
      const want = eqParam(url, 'user_id')
      const row = want && want === uid ? state.roles[uid] : undefined
      return send(200, row ? [pick({ user_id: uid, ...row }, url.searchParams.get('select'))] : [])
    }
    if (url.pathname === '/rest/v1/s3_documents') {
      const select = url.searchParams.get('select')
      const byKey = eqParam(url, 's3_key')
      const byId = eqParam(url, 'id')
      const visible = (d) => d.visibleTo === 'all' || Boolean(uid && d.visibleTo.includes(uid))
      const found = Object.entries(state.docs)
        .filter(([key, d]) => visible(d) && (byKey === null || key === byKey) && (byId === null || d.row.id === byId))
        .map(([key, d]) => ({ key, row: { s3_key: key, ...d.row } }))
      // .single() просит один объект (Accept: application/vnd.pgrst.object+json), иначе — массив.
      const wantsObject = (req.headers.accept || '').includes('vnd.pgrst.object')
      const reply = (rows, status = 200) => {
        if (!wantsObject) return send(status, rows)
        return rows.length === 1 ? send(status, rows[0]) : send(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' })
      }
      if (req.method === 'GET') return reply(found.map((f) => pick(f.row, select)))
      if (req.method === 'POST') {
        const input = JSON.parse(body || '{}')
        const rows = Array.isArray(input) ? input : [input]
        for (const r of rows) state.onInsert?.(r)
        for (const r of rows) {
          if (state.docs[r.s3_key] || Object.values(state.docs).some((d) => d.row.id === r.id)) {
            return send(409, { code: '23505', details: null, hint: null, message: 'duplicate key value violates unique constraint "s3_documents_pkey"' })
          }
        }
        const created = rows.map((r) => {
          const row = { doc_category: 'general', created_at: new Date().toISOString(), ...r }
          const { s3_key: key, ...rest } = row
          state.docs[key] = { row: rest, visibleTo: 'all' }
          return row
        })
        return reply(created.map((r) => pick(r, select)), 201)
      }
      if (req.method === 'DELETE') {
        for (const f of found) delete state.docs[f.key]
        return reply(found.map((f) => pick(f.row, select)))
      }
    }
    if (url.pathname === '/rest/v1/rpc/osp_can') {
      if (state.noOspCan) {
        return send(404, { code: 'PGRST202', details: null, hint: null, message: 'Could not find the function public.osp_can(p_kind, p_section) in the schema cache' })
      }
      const { p_section: section, p_kind: kind } = JSON.parse(body || '{}')
      const grants = uid ? state.can?.[uid] : null
      return send(200, grants === 'all' || Boolean(grants?.includes(`${section}:${kind}`)))
    }
    if (url.pathname === '/rest/v1/rpc/is_my_contract') {
      const { contract_uuid: id } = JSON.parse(body || '{}')
      return send(200, Boolean(uid && state.myContracts[uid]?.includes(id)))
    }
    // Таблицы владельцев файлов: { owners: { tenders: { <id>: 'all' | [userId] } } } — «видна ли строка».
    const ownerTable = url.pathname.replace('/rest/v1/', '')
    if (state.owners && Object.hasOwn(state.owners, ownerTable)) {
      const id = eqParam(url, 'id')
      const vis = state.owners[ownerTable][id]
      const visible = vis && (vis === 'all' || (uid && vis.includes(uid)))
      return send(200, visible ? [{ id }] : [])
    }
    const view = url.pathname.replace('/rest/v1/', '')
    if (state.views && Object.hasOwn(state.views, view)) {
      if (state.missingView) {
        return send(404, { code: '42P01', details: null, hint: null, message: `relation "public.${view}" does not exist` })
      }
      if (req.method === 'HEAD') {
        if (state.countFails) return send(500, { code: '57014', message: 'canceling statement due to statement timeout' })
        return send(200, undefined, { 'content-range': `*/${state.viewTotal ?? 0}` })
      }
      if (state.viewDelayMs) await new Promise((r) => setTimeout(r, state.viewDelayMs))
      const select = url.searchParams.get('select')
      const offset = Number(url.searchParams.get('offset') || 0)
      const limit = Number(url.searchParams.get('limit') || 1e9)
      return send(200, state.views[view].slice(offset, offset + limit).map((r) => pick(r, select.replace(/\s+/g, ''))))
    }
    send(404, { message: `fake: нет ${url.pathname}` })
  })
  const port = await listen(server)
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reset: () => { requests.length = 0 },
    close: () => new Promise((r) => server.close(r)),
  }
}

// «S3» (path-style: /<bucket>/<key>): запоминает запросы; PUT сохраняет размер объекта, HEAD отвечает
// им или 404, DELETE удаляет. failDelete — удаление в хранилище падает (500).
export async function startFakeS3() {
  const requests = []
  const objects = new Map()
  const fake = { failDelete: false }
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req)
    const objectPath = decodeURIComponent(new URL(req.url, 'http://fake').pathname)
    requests.push({ method: req.method, path: objectPath, auth: req.headers.authorization || '' })
    if (req.method === 'PUT') {
      objects.set(objectPath, Buffer.byteLength(body))
      res.writeHead(200)
      return res.end()
    }
    if (req.method === 'HEAD') {
      if (!objects.has(objectPath)) { res.writeHead(404); return res.end() }
      res.writeHead(200, { 'content-length': String(objects.get(objectPath)), 'last-modified': new Date().toUTCString(), etag: '"fake"' })
      return res.end()
    }
    if (req.method === 'DELETE') {
      if (fake.failDelete) { res.writeHead(500); return res.end() }
      objects.delete(objectPath)
      res.writeHead(204)
      return res.end()
    }
    res.writeHead(200)
    res.end()
  })
  const port = await listen(server)
  return Object.assign(fake, { url: `http://127.0.0.1:${port}`, requests, objects, close: () => new Promise((r) => server.close(r)) })
}
