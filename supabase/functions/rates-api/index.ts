// Edge Function `rates-api` — выдача реестра расценок смежному отделу.
//
// Назначение: тендерный отдел (работает с заказчиками) считает свои расценки на
// основании нашей базы КП подрядчиков. Отдаём им данные машинно, по ключу,
// только на чтение — вместо пересылки выгрузок в Excel.
//
// ПОЧЕМУ ОТДЕЛЬНАЯ ФУНКЦИЯ, А НЕ ПРЯМОЙ ДОСТУП К БАЗЕ.
// У Supabase есть готовый REST, но чтобы им воспользоваться, потребителю нужен
// ключ проекта — а он открывает не реестр расценок, а вообще всё, до чего
// дотягиваются политики доступа. Здесь же наружу выставлены ровно два
// представления и только операция чтения.
//
// Эндпоинты (GET):
//   /rates-api/kp      — расценки из КП подрядчиков (kp_rates_registry)
//   /rates-api/supply  — расценки снабжения СУ-10 (supply_rates_registry)
//   /rates-api/health  — проверка доступности и ключа
//
// Параметры (все необязательны):
//   search   — подстрока в наименовании
//   type     — material | work (только для /kp)
//   object   — id объекта
//   tender   — id тендера
//   date_from, date_to — дата расценки (YYYY-MM-DD)
//   price_min, price_max
//   limit    — размер страницы, 1..1000 (по умолчанию 500)
//   offset   — смещение (по умолчанию 0)
//   format   — json (по умолчанию) | csv
//
// Ответ JSON: { rows: [...], limit, offset, count, has_more }
// `count` — общее число строк под фильтры; если подсчёт не уложился в таймаут,
// приходит null, а постраничный обход по has_more продолжает работать.
//
// Авторизация: ключ в заголовке `X-API-Key` либо в параметре `?key=`.
// Параметр поддержан ради Excel/Power Query: там заголовки задаются неудобно, а
// ссылку вставляют целиком. Ключи лежат в секрете функции RATES_API_KEYS
// (несколько — через запятую), сравниваются в постоянном времени.
//
// ДЕПЛОЙ: функция вызывается без пользовательского JWT, поэтому её нужно
// разворачивать с отключённой проверкой токена:
//   supabase secrets set RATES_API_KEYS=<ключ1>,<ключ2>
//   supabase functions deploy rates-api --no-verify-jwt
import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'x-api-key, content-type',
}

const DEFAULT_LIMIT = 500
const MAX_LIMIT = 1000

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  })
}

// Сравнение секретов без раннего выхода: обычное === выдаёт длину совпадающего
// префикса через время ответа.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function checkKey(req: Request, url: URL): boolean {
  const configured = (Deno.env.get('RATES_API_KEYS') || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
  if (configured.length === 0) return false
  const provided = (req.headers.get('x-api-key') || url.searchParams.get('key') || '').trim()
  if (!provided) return false
  return configured.some((k) => safeEqual(k, provided))
}

// Колонки перечислены явно: `*` вынес бы наружу всё, что когда-либо добавят в
// представление, включая то, что делиться не планировали.
const KP_COLS = [
  'id', 'object_id', 'object_name', 'counterparty_id', 'counterparty_name',
  'tender_id', 'tender_desc', 'item_type', 'item_name', 'unit', 'price', 'proposal_date',
].join(', ')

const SUPPLY_COLS = [
  'id', 'object_id', 'object_name', 'tender_id', 'tender_desc',
  'item_name', 'unit', 'price', 'rate_date',
].join(', ')

function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0])
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  // Разделитель — точка с запятой: Excel с русской локалью читает такой файл без
  // мастера импорта. BOM добавляем на отдаче, иначе кириллица приходит крякозябрами.
  return [headers.join(';'), ...rows.map((r) => headers.map((h) => esc(r[h])).join(';'))].join('\n')
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'GET') return jsonResponse({ error: 'Только GET' }, 405)

  const url = new URL(req.url)
  if (!checkKey(req, url)) {
    return jsonResponse({ error: 'Неверный или отсутствующий ключ доступа (X-API-Key)' }, 401)
  }

  // Путь приходит как /rates-api/<resource>; берём последний непустой сегмент.
  const segments = url.pathname.split('/').filter(Boolean)
  const resource = segments[segments.length - 1] || ''

  if (resource === 'health' || resource === 'rates-api') {
    return jsonResponse({ ok: true, resources: ['kp', 'supply'] })
  }
  if (resource !== 'kp' && resource !== 'supply') {
    return jsonResponse({ error: `Неизвестный ресурс «${resource}». Доступны: kp, supply` }, 404)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  // Служебный ключ: у запроса нет пользователя, а данные читаются из
  // представлений, закрытых политиками для анонимного доступа.
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: 'Функция не настроена: нет SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }, 500)
  }
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  const p = url.searchParams
  const limit = clampInt(p.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT)
  const offset = clampInt(p.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)
  const isKp = resource === 'kp'
  const view = isKp ? 'kp_rates_registry' : 'supply_rates_registry'
  const dateCol = isKp ? 'proposal_date' : 'rate_date'

  const applyFilters = (q: ReturnType<typeof supabase.from>) => {
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
    if (Number.isFinite(priceMin)) out = out.gte('price', priceMin)
    const priceMax = Number(p.get('price_max'))
    if (Number.isFinite(priceMax)) out = out.lte('price', priceMax)
    const dateFrom = (p.get('date_from') || '').trim()
    if (dateFrom) out = out.gte(dateCol, dateFrom)
    const dateTo = (p.get('date_to') || '').trim()
    if (dateTo) out = out.lte(dateCol, dateTo)
    return out
  }

  try {
    let dataQuery = supabase.from(view).select(isKp ? KP_COLS : SUPPLY_COLS)
    dataQuery = applyFilters(dataQuery)
    const { data, error } = await dataQuery
      .order('item_name', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1)
    if (error) throw error

    const rows = data || []

    // Подсчёт по дедуплицирующему представлению дорогой и на большой выборке
    // упирается в таймаут. Он не должен мешать отдать сами строки: не вышло —
    // возвращаем count: null, обход страницами идёт по has_more.
    let count: number | null = null
    try {
      let countQuery = supabase.from(view).select('id', { count: 'exact', head: true })
      countQuery = applyFilters(countQuery)
      const res = await countQuery
      if (!res.error) count = res.count ?? null
    } catch {
      count = null
    }

    if ((p.get('format') || '').toLowerCase() === 'csv') {
      return new Response('﻿' + toCsv(rows as Record<string, unknown>[]), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${view}.csv"`,
          ...CORS_HEADERS,
        },
      })
    }

    return jsonResponse({
      rows,
      limit,
      offset,
      count,
      has_more: rows.length === limit,
    })
  } catch (err) {
    console.error('rates-api:', err)
    const message = err instanceof Error ? err.message : String(err)
    // 42P01 — представления нет: не применены миграции реестра расценок.
    const missingView = message.includes('42P01') || message.includes('does not exist')
    return jsonResponse({
      error: missingView
        ? `Представление ${view} недоступно — не применены миграции реестра расценок`
        : message,
    }, missingView ? 503 : 500)
  }
})
