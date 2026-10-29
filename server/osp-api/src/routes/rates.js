// GET /api/rates/{kp,supply,larix,health} — перенос Edge Function `rates-api` (supabase/functions/rates-api):
// реестр расценок смежным отделам, по ключу, только чтение. У kp и supply параметры, колонки, ответ и коды — как
// у функции; larix — договорные расценки из Larix.CPM (вкладка «Договорные расценки (Larix)»), только своя база.
//
// Ключ — заголовок X-API-Key или параметр ?key= (ради Excel/Power Query). Ключи выпускает администратор портала
// («Администрирование» → «Доступ к API», src/lib/apiKeys.js): в базе — отпечаток, права (ресурсы) и срок. Прежние
// ключи — строка RATES_API_KEYS через запятую: запись «ключ:kp+larix» открывает только перечисленные ресурсы,
// запись без «:» — kp и supply, как было до larix; они тоже видны в списке администратора, там их можно отозвать.
// Каждый вызов известного ключа пишется в журнал (ресурс, код, строк, время, адрес) — после ответа. Адрес с ?key=
// не логируется (app.js пишет в журнал только шаблон маршрута). Инструкция для потребителя — docs/RATES_API.md.
import { access } from '../lib/access.js'
import { dbUnavailable, DB_UNAVAILABLE, DB_UNAVAILABLE_TEXT } from '../lib/db.js'
import { RESOURCE_CODES, REFUSALS } from '../lib/apiKeys.js'
import { OPEN_ROUTES } from '../open-routes.js'

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'x-api-key, content-type',
}

const DEFAULT_LIMIT = 500
const MAX_LIMIT = 1000

// Колонки перечислены явно: `*` вынес бы наружу всё, что когда-либо добавят в представление.
export const KP_COLS = [
  'id', 'object_id', 'object_name', 'counterparty_id', 'counterparty_name',
  'tender_id', 'tender_desc', 'item_type', 'item_name', 'unit', 'price', 'proposal_date',
].join(', ')

export const SUPPLY_COLS = [
  'id', 'object_id', 'object_name', 'tender_id', 'tender_desc',
  'item_name', 'unit', 'price', 'rate_date',
].join(', ')

// Договорные расценки Larix — те же колонки, что у вкладки (плюс repeats). Строки — закрытая таблица
// osp_private.larix_rates: представление вкладки отдаёт их только вошедшему с правом раздела, у ключа
// пользователя нет. Поэтому чтение служебное (READ ONLY), право — ключ на маршруте, отбор — в SQL ниже.
export const LARIX_COLS = [
  'id', 'item_name', 'unit', 'price_material', 'price_work', 'vat_rate', 'materials_used', 'comment',
  'project_id', 'project_name', 'contractor_id', 'contractor_name', 'contract_id', 'contract_number',
  'contract_date', 'contract_state', 'object_type', 'osp_contract_id', 'repeats',
]
// bigint и numeric драйвер отдаёт строками, date — объектом Date по поясу процесса: в ответе — числа и «ГГГГ-ММ-ДД».
const LARIX_NUMBERS = new Set(['id', 'price_material', 'price_work', 'vat_rate', 'project_id', 'contractor_id', 'contract_id'])
const LARIX_SELECT = LARIX_COLS.map((c) => (c === 'contract_date' ? 'r.contract_date::text as contract_date' : `r.${c}`)).join(', ')

export const RESOURCES = RESOURCE_CODES
// Ключ без перечня ресурсов — то, что ключи открывали до larix.
const LEGACY_RESOURCES = ['kp', 'supply']

// RATES_API_KEYS → [{ key, resources }]. Запись с неизвестным ресурсом не принимается (в журнал — номер записи,
// без ключа): опечатка не должна ни открыть лишнего, ни уронить службу вместе с порталом.
export function parseRatesKeys(entries, log) {
  const out = []
  entries.forEach((entry, i) => {
    const at = entry.lastIndexOf(':')
    const scope = at > 0 ? entry.slice(at + 1).trim().toLowerCase() : ''
    if (!scope || !/^[a-z+]+$/.test(scope)) {
      out.push({ key: entry, resources: LEGACY_RESOURCES })
      return
    }
    const resources = [...new Set(scope.split('+').filter(Boolean))]
    const unknown = resources.filter((r) => !RESOURCES.includes(r))
    if (unknown.length || resources.length === 0) {
      log?.error({ entry: i + 1, unknown }, 'RATES_API_KEYS: запись пропущена — неизвестный ресурс')
      return
    }
    out.push({ key: entry.slice(0, at).trim(), resources: RESOURCES.filter((r) => resources.includes(r)) })
  })
  return out.filter((k) => k.key)
}

function clampInt(raw, def, min, max) {
  const n = Number(raw)
  if (raw === null || !Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

export function toCsv(rows) {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0])
  const esc = (v) => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  // «;» — Excel с русской локалью открывает без мастера импорта; BOM добавляется при отдаче.
  return [headers.join(';'), ...rows.map((r) => headers.map((h) => esc(r[h])).join(';'))].join('\n')
}

// Ключ из запроса: заголовок или ?key=.
function providedKey(request) {
  const params = new URL(request.url, 'http://localhost').searchParams
  return String(request.headers['x-api-key'] || params.get('key') || '').trim()
}

// Ресурс вызова для журнала — только из известных: в адрес можно написать что угодно.
function callResource(request) {
  const segments = new URL(request.url, 'http://localhost').pathname.split('/').filter(Boolean)
  const last = segments[segments.length - 1] || ''
  if (last === 'rates' || last === 'health') return 'health'
  return RESOURCES.includes(last) ? last : 'other'
}

class BadParam extends Error {}

// Номера Larix (проект, подрядчик, договор): «33» или «33,34».
function idList(p, name) {
  const raw = (p.get(name) || '').trim()
  if (!raw) return null
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (!ids.every((s) => /^\d{1,18}$/.test(s))) throw new BadParam(`Параметр ${name} — номера Larix через запятую`)
  return ids
}

function isoDate(p, name) {
  const raw = (p.get(name) || '').trim()
  if (!raw) return null
  // 2026-02-30 — не дата (иначе база ответила бы ошибкой 500).
  const d = new Date(`${raw}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    throw new BadParam(`Параметр ${name} — дата ГГГГ-ММ-ДД`)
  }
  return raw
}

function priceParam(p, name) {
  const n = Number(p.get(name))
  return p.get(name) !== null && p.get(name).trim() !== '' && Number.isFinite(n) ? n : null
}

// Условия отбора договорных расценок — как у вкладки: type — подвкладка «Материалы» / «Работы» (есть цена этого
// вида, фильтр цены — по ней), без type — цена в пределах по любой из двух.
export function larixWhere(p) {
  const where = []
  const args = []
  const arg = (v) => { args.push(v); return `$${args.length}` }
  const search = (p.get('search') || '').trim()
  if (search) where.push(`r.item_name ilike ${arg(`%${search.replace(/[\\%_]/g, '\\$&')}%`)}`)
  for (const [name, column] of [['project', 'project_id'], ['contractor', 'contractor_id'], ['contract', 'contract_id']]) {
    const ids = idList(p, name)
    if (ids) where.push(`r.${column} = any(${arg(ids)}::bigint[])`)
  }
  const states = p.getAll('state').map((s) => s.trim()).filter(Boolean)
  if (states.length) where.push(`r.contract_state = any(${arg(states)}::text[])`)
  const dateFrom = isoDate(p, 'date_from')
  if (dateFrom) where.push(`r.contract_date >= ${arg(dateFrom)}::date`)
  const dateTo = isoDate(p, 'date_to')
  if (dateTo) where.push(`r.contract_date <= ${arg(dateTo)}::date`)
  const min = priceParam(p, 'price_min')
  const max = priceParam(p, 'price_max')
  const range = (c) => [min !== null ? `${c} >= ${arg(min)}` : null, max !== null ? `${c} <= ${arg(max)}` : null].filter(Boolean)
  const type = (p.get('type') || '').trim()
  const column = type === 'material' ? 'r.price_material' : type === 'work' ? 'r.price_work' : null
  if (column) {
    where.push(`${column} is not null`, ...range(column))
  } else if (min !== null || max !== null) {
    where.push(`((${range('r.price_material').join(' and ')}) or (${range('r.price_work').join(' and ')}))`)
  }
  return { sql: where.length ? `where ${where.join(' and ')}` : '', args }
}

export function registerRates(app, { config, getServiceClient, limiters, db, gatewayOn, apiKeys }) {
  app.decorateRequest('ratesKey', null)
  // Вызов для журнала ключа: { key, reason?, rows? } — пишется после ответа (onResponse маршрута).
  app.decorateRequest('apiCall', null)

  // Проверка ключа объявлена на маршруте (lib/access.js) и выполняется до обработчика. Заголовки CORS —
  // и на отказе: Excel и браузер должны увидеть текст ошибки.
  const checkKey = async (request, reply) => {
    reply.headers(CORS_HEADERS)
    const provided = providedKey(request)
    let found = null
    if (provided) {
      try {
        found = await apiKeys.resolve(provided)
      } catch (err) {
        // База не ответила, а ключа нет в настройках сервера: это не «неверный ключ» — клиент может повторить.
        request.log.error({ code: err?.code || err?.name }, 'rates-api key lookup')
        reply.code(503).send({ error: DB_UNAVAILABLE_TEXT, code: DB_UNAVAILABLE })
        return false
      }
    }
    if (!found) {
      reply.code(401).send({ error: 'Неверный или отсутствующий ключ доступа (X-API-Key)' })
      return false
    }
    request.apiCall = { key: found.key }
    if (!found.ok) {
      request.apiCall.reason = found.reason
      reply.code(401).send({ error: REFUSALS[found.reason], code: `OSP_API_KEY_${found.reason.toUpperCase()}` })
      return false
    }
    if (!limiters.ratesRate.take(found.key.limitKey)) {
      request.apiCall.reason = 'rate_limit'
      reply.code(429).send({ error: 'Слишком много запросов — не чаще 60 в минуту на ключ' })
      return false
    }
    request.ratesKey = found.key
    return true
  }

  const logCall = async (request, reply) => {
    const call = request.apiCall
    if (!call?.key?.id) return
    apiKeys.logCall({
      keyId: call.key.id, resource: callResource(request), status: reply.statusCode, rows: call.rows ?? null,
      ms: reply.elapsedTime, ip: request.ip, reason: call.reason || null,
    })
  }

  const preflight = async (request, reply) => reply.headers(CORS_HEADERS).type('text/plain; charset=utf-8').send('ok')

  const handler = async (request, reply) => {
    const url = new URL(request.url, 'http://localhost')
    const p = url.searchParams
    const key = request.ratesKey.limitKey
    const refuse = (status, reason, error) => {
      request.apiCall.reason = reason
      return reply.code(status).send({ error })
    }

    const segments = url.pathname.split('/').filter(Boolean)
    const resource = segments[segments.length - 1] || ''
    const allowed = request.ratesKey.resources
    if (resource === 'health' || resource === 'rates') {
      return { ok: true, resources: allowed }
    }
    if (!RESOURCES.includes(resource)) {
      return refuse(404, 'unknown_resource', `Неизвестный ресурс «${resource}». Доступны: ${RESOURCES.join(', ')}`)
    }
    if (!allowed.includes(resource)) {
      return refuse(403, 'forbidden_resource', `Этому ключу ресурс «${resource}» не открыт. Открыты: ${allowed.join(', ')}`)
    }

    const limit = clampInt(p.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT)
    const offset = clampInt(p.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)
    const csv = (p.get('format') || '').toLowerCase() === 'csv'
    const sendCsv = (name, rows) => reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${name}.csv"`)
      .send('﻿' + toCsv(rows))

    if (resource === 'larix') {
      // Расценки Larix загружаются только в свою базу (LARIX_SYNC_TARGETS=db).
      if (!db) return reply.code(503).send({ error: 'Договорные расценки Larix есть только в базе нового портала: не задан OSP_DB_URL' })
      let filter
      try {
        filter = larixWhere(p)
      } catch (err) {
        if (err instanceof BadParam) return refuse(400, 'bad_param', err.message)
        throw err
      }
      const release = limiters.ratesKey.acquire(key)
      if (!release) return refuse(429, 'busy', 'Предыдущие запросы этого ключа ещё выполняются — повторите позже')
      try {
        const { rows, loadedAt } = await db.read(null, async (tx) => {
          const page = await tx.query(
            `select ${LARIX_SELECT} from osp_private.larix_rates r ${filter.sql} order by r.item_name, r.id limit ${limit} offset ${offset}`,
            filter.args)
          const run = await tx.query(`select finished_at from public.larix_sync_runs where status = 'ok' order by id desc limit 1`)
          return { rows: page.rows, loadedAt: run.rows[0]?.finished_at ?? null }
        })
        for (const r of rows) for (const c of LARIX_NUMBERS) if (r[c] !== null) r[c] = Number(r[c])
        request.apiCall.rows = rows.length
        // Подсчёт — отдельной транзакцией: не уложился — строки всё равно отдаются, count: null.
        let count = null
        try {
          count = await db.read(null, async (tx) =>
            (await tx.query(`select count(*)::int as n from osp_private.larix_rates r ${filter.sql}`, filter.args)).rows[0].n)
        } catch (err) {
          if (dbUnavailable(err)) throw err
          count = null
        }
        if (csv) return sendCsv('larix_rates_registry', rows)
        return { rows, limit, offset, count, has_more: rows.length === limit, loaded_at: loadedAt ? new Date(loadedAt).toISOString() : null }
      } catch (err) {
        if (dbUnavailable(err)) throw err
        request.log.error({ msg: String(err?.message || err), code: err?.code }, 'rates-api larix')
        // 42P01 — таблицы нет: не применены миграции договорных расценок.
        if (err?.code === '42P01') {
          return reply.code(503).send({ error: 'Договорные расценки Larix недоступны — не применены миграции 20261018 / 20261021' })
        }
        return reply.code(500).send({ error: 'Не удалось прочитать договорные расценки Larix' })
      } finally {
        release()
      }
    }

    // Служебный ключ: у запроса нет пользователя, а представления закрыты для анонима. При шлюзе данные — в
    // своей базе (служебный клиент — свой PostgREST), Supabase не нужен.
    if (!gatewayOn && (!config.supabaseUrl || !config.supabaseServiceKey)) {
      return reply.code(500).send({ error: 'Функция не настроена: нет SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' })
    }
    const supabase = getServiceClient()

    const isKp = resource === 'kp'
    const view = isKp ? 'kp_rates_registry' : 'supply_rates_registry'
    const dateCol = isKp ? 'proposal_date' : 'rate_date'

    const applyFilters = (q) => {
      let out = q
      const search = (p.get('search') || '').trim()
      if (search) out = out.ilike('item_name', `%${search}%`)
      if (isKp) {
        const type = (p.get('type') || '').trim()
        if (type === 'material' || type === 'work') out = out.eq('item_type', type)
        const cp = (p.get('counterparty') || '').trim()
        if (cp) out = out.eq('counterparty_id', cp)
      }
      const objectId = (p.get('object') || '').trim()
      if (objectId) out = out.eq('object_id', objectId)
      const tenderId = (p.get('tender') || '').trim()
      if (tenderId) out = out.eq('tender_id', tenderId)
      const priceMin = Number(p.get('price_min'))
      if (p.get('price_min') !== null && Number.isFinite(priceMin)) out = out.gte('price', priceMin)
      const priceMax = Number(p.get('price_max'))
      if (p.get('price_max') !== null && Number.isFinite(priceMax)) out = out.lte('price', priceMax)
      const dateFrom = (p.get('date_from') || '').trim()
      if (dateFrom) out = out.gte(dateCol, dateFrom)
      const dateTo = (p.get('date_to') || '').trim()
      if (dateTo) out = out.lte(dateCol, dateTo)
      return out
    }

    const release = limiters.ratesKey.acquire(key)
    if (!release) return refuse(429, 'busy', 'Предыдущие запросы этого ключа ещё выполняются — повторите позже')
    try {
      const { data, error } = await applyFilters(supabase.from(view).select(isKp ? KP_COLS : SUPPLY_COLS))
        .order('item_name', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + limit - 1)
      if (error) throw error
      const rows = data || []
      request.apiCall.rows = rows.length

      // Подсчёт по дедуп-представлению дорогой и может упереться в таймаут — строки отдаём всё
      // равно, count: null, обход страницами идёт по has_more.
      let count = null
      try {
        const res = await applyFilters(supabase.from(view).select('id', { count: 'exact', head: true }))
        if (!res.error) count = res.count ?? null
      } catch {
        count = null
      }

      if (csv) return sendCsv(view, rows)
      return { rows, limit, offset, count, has_more: rows.length === limit }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err?.message || err)
      request.log.error({ msg: message }, 'rates-api')
      // 42P01 — представления нет: не применены миграции реестра расценок.
      const missingView = message.includes('42P01') || message.includes('does not exist')
      return reply.code(missingView ? 503 : 500).send({
        error: missingView ? `Представление ${view} недоступно — не применены миграции реестра расценок` : message,
      })
    } finally {
      release()
    }
  }

  const reason = (method, url) => OPEN_ROUTES.find((r) => r.method === method && r.url === url).reason
  for (const url of ['/api/rates', '/api/rates/*']) {
    app.route({ method: 'GET', url, config: { access: access.apiKey({ reason: reason('GET', url), check: checkKey }) }, onResponse: logCall, handler })
    app.route({ method: 'OPTIONS', url, config: { access: access.open(reason('OPTIONS', url)) }, handler: preflight })
  }
}
