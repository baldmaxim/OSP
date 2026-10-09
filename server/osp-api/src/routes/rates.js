// GET /api/rates/{kp,supply,health} — перенос Edge Function `rates-api` (supabase/functions/rates-api):
// реестр расценок смежному отделу, по ключу, только чтение. Параметры, колонки, ответ и коды — те же.
//
// Ключ — заголовок X-API-Key или параметр ?key= (ради Excel/Power Query). Ключи — RATES_API_KEYS,
// через запятую. Адрес с ?key= не логируется (app.js пишет в журнал только шаблон маршрута).
import { safeEqual } from '../lib/keys.js'

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

function keyAllowed(config, request, params) {
  if (config.ratesApiKeys.length === 0) return false
  const provided = String(request.headers['x-api-key'] || params.get('key') || '').trim()
  if (!provided) return false
  return config.ratesApiKeys.some((k) => safeEqual(k, provided))
}

export function registerRates(app, { config, getServiceClient }) {
  const handler = async (request, reply) => {
    reply.headers(CORS_HEADERS)
    if (request.method === 'OPTIONS') return reply.type('text/plain; charset=utf-8').send('ok')

    const url = new URL(request.url, 'http://localhost')
    const p = url.searchParams
    if (!keyAllowed(config, request, p)) {
      return reply.code(401).send({ error: 'Неверный или отсутствующий ключ доступа (X-API-Key)' })
    }

    const segments = url.pathname.split('/').filter(Boolean)
    const resource = segments[segments.length - 1] || ''
    if (resource === 'health' || resource === 'rates') {
      return { ok: true, resources: ['kp', 'supply'] }
    }
    if (resource !== 'kp' && resource !== 'supply') {
      return reply.code(404).send({ error: `Неизвестный ресурс «${resource}». Доступны: kp, supply` })
    }

    // Служебный ключ: у запроса нет пользователя, а представления закрыты для анонима.
    if (!config.supabaseUrl || !config.supabaseServiceKey) {
      return reply.code(500).send({ error: 'Функция не настроена: нет SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' })
    }
    const supabase = getServiceClient()

    const limit = clampInt(p.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT)
    const offset = clampInt(p.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)
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

    try {
      const { data, error } = await applyFilters(supabase.from(view).select(isKp ? KP_COLS : SUPPLY_COLS))
        .order('item_name', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + limit - 1)
      if (error) throw error
      const rows = data || []

      // Подсчёт по дедуп-представлению дорогой и может упереться в таймаут — строки отдаём всё
      // равно, count: null, обход страницами идёт по has_more.
      let count = null
      try {
        const res = await applyFilters(supabase.from(view).select('id', { count: 'exact', head: true }))
        if (!res.error) count = res.count ?? null
      } catch {
        count = null
      }

      if ((p.get('format') || '').toLowerCase() === 'csv') {
        return reply
          .type('text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="${view}.csv"`)
          .send('﻿' + toCsv(rows))
      }
      return { rows, limit, offset, count, has_more: rows.length === limit }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err?.message || err)
      request.log.error({ msg: message }, 'rates-api')
      // 42P01 — представления нет: не применены миграции реестра расценок.
      const missingView = message.includes('42P01') || message.includes('does not exist')
      return reply.code(missingView ? 503 : 500).send({
        error: missingView ? `Представление ${view} недоступно — не применены миграции реестра расценок` : message,
      })
    }
  }

  for (const url of ['/api/rates', '/api/rates/*']) {
    app.get(url, handler)
    app.options(url, handler)
  }
}
