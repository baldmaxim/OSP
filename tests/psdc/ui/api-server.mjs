// HTTP-прокси для UI-стенда ПСДЦ: принимает вызовы подменённого клиента Supabase
// и исполняет их в тестовом PostgreSQL от имени пользователя (роль authenticated,
// RLS и права действуют как в проде). Поддерживает RPC и несколько простых
// табличных чтений, которые делают компоненты ПСДЦ.
import http from 'node:http'
import { sqlJson } from '../lib/pg.mjs'

const TABLES = {
  psdc_batches: { columns: ['id', 'title', 'created_by_name', 'created_at'] },
  contracts: {
    columns: ['id', 'display_id', 'record_type', 'contract_number', 'parent_contract_id', 'root_contract_id', 'status', 'deleted_at', 'object_id'],
    embeds: { 'counterparties(name)': "(SELECT jsonb_build_object('name', cp.name) FROM counterparties cp WHERE cp.id = t.counterparty_id)" },
  },
  s3_documents: { columns: ['id', 's3_key', 'file_name'] },
}

const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Недопустимый идентификатор ${s}`)
  return s
}

function buildTableQuery(q) {
  const spec = TABLES[q.table]
  if (!spec) throw new Error(`Таблица ${q.table} не поддержана стендом`)
  const parts = []
  for (const raw of q.select.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (spec.embeds?.[raw]) parts.push(`'${raw.split('(')[0]}', ${spec.embeds[raw]}`)
    else if (spec.columns.includes(raw)) parts.push(`'${raw}', t.${ident(raw)}`)
    else throw new Error(`Колонка ${raw} не поддержана стендом`)
  }
  const where = (q.filters || []).map((f) => {
    const col = `t.${ident(f.column)}`
    if (f.op === 'is' && f.value === null) return `${col} IS NULL`
    if (f.op === 'eq') return `${col}::text = ${sqlJson(String(f.value))} #>> '{}'`
    throw new Error(`Фильтр ${f.op} не поддержан стендом`)
  })
  const order = (q.order || []).map((o) => `t.${ident(o.column)} ${o.ascending === false ? 'DESC' : 'ASC'}`)
  const limit = q.range ? `LIMIT ${q.range[1] - q.range[0] + 1} OFFSET ${q.range[0]}` : q.limit ? `LIMIT ${Number(q.limit)}` : ''
  return `SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
    SELECT jsonb_build_object(${parts.join(', ')}) AS x FROM public.${ident(q.table)} t
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ${order.length ? `ORDER BY ${order.join(', ')}` : ''} ${limit}) s;`
}

export function startApiServer(db, { port }) {
  const signatures = new Map()
  const out = db.exec(`SELECT json_agg(json_build_object('name', p.proname, 'args', p.proargnames, 'types', (SELECT array_agg(format_type(t, NULL) ORDER BY o) FROM unnest(p.proargtypes) WITH ORDINALITY u(t, o))))
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'psdc\\_%';`)
  for (const fn of JSON.parse(out.trim())) signatures.set(fn.name, fn)

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    if (req.method === 'OPTIONS') { res.end(); return }
    let body = ''
    for await (const chunk of req) body += chunk
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    }
    try {
      const { uid, fn, args, query } = JSON.parse(body || '{}')
      let sql
      if (fn) {
        const sig = signatures.get(fn)
        if (!sig) throw new Error(`Функция ${fn} не найдена`)
        const j = sqlJson(args || {})
        const params = (sig.args || []).map((name, i) => {
          const type = sig.types[i]
          if (type === 'jsonb') return `${name} => (${j} -> '${name}')`
          if (type === 'uuid[]') return `${name} => ARRAY(SELECT jsonb_array_elements_text(${j} -> '${name}'))::uuid[]`
          return `${name} => (${j} ->> '${name}')::${type}`
        })
        sql = `SELECT COALESCE(to_jsonb(public.${ident(fn)}(${params.join(', ')})), 'null'::jsonb);`
      } else {
        sql = buildTableQuery(query)
      }
      const res1 = db.tryAsUser(uid, sql)
      if (!res1.ok) {
        const message = (/ERROR:\s+([^\n]+)/.exec(res1.error) || [])[1] || res1.error
        send(400, { message })
        return
      }
      send(200, JSON.parse(res1.out || 'null'))
    } catch (e) {
      send(400, { message: e.message })
    }
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}
