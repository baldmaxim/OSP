// Проверка расценок по файлу (реестр расценок → «Расценки от подрядчиков (КП)» → «Проверить по файлу»): строки
// файла подрядчика или поставщика против расценок реестра. Только решения, без запросов — tests/tender/kp-rate-check.test.mjs.
//
// Файл распознаётся тем же разбором, что «Цены из счёта / КП» расценки снабжением и «Цены из файла» кабинета
// подрядчика (utils/bidImport: заполненный ВОР — листы «Материалы» / «Работы», иначе таблица «наименование + цена /
// сумма», PDF — по словам и линиям). Похожие расценки реестра для каждой строки отдаёт база (kp_rates_lookup: до 60
// строк по сочетаниям букв), окончательную похожесть считает этот модуль тем же расчётом, что сопоставление
// документа поставщика с позициями ВОР (utils/supplyDocMatch: то же наименование, слова и числа, текст целиком,
// артикул; разные размеры — не аналог). Аналог — то же наименование или похожесть от AUTO_MIN; в сравнении цен — только
// аналоги с той же ед. изм. (шт. = штук, м = м.п.).
import { normName } from './supplyRateHelpers.js'
import { nameParts } from './supplySimilarity.js'
import { AUTO_MIN, itemCandidates, matchIndex } from './supplyDocMatch.js'
import { unitPriceWithVat } from './supplierDoc.js'

// Допуск отклонения от медианы реестра, %: в пределах — «в рынке».
export const TOLERANCE_STEPS = [10, 15, 20, 30]
export const DEFAULT_TOLERANCE = 15
// Сколько наименований за один вызов kp_rates_lookup (база: до 300; ~30 мс на наименование).
export const LOOKUP_CHUNK = 25
// Сколько аналогов показывать у строки сразу.
export const VISIBLE_ANALOGS = 5

// Строки реестра (ответ kp_rates_lookup) одной строки файла → группы для сопоставления: строка реестра — своя
// группа (у каждой своя цена, подрядчик и тендер).
export function registryGroups(rows) {
  return (rows || []).map((r) => ({
    key: r.id, k: normName(r.item_name), name: r.item_name, unit: r.unit || null, units: null,
    parts: nameParts(r.item_name), targets: [r], row: r,
  }))
}

const median = (sorted) => {
  const n = sorted.length
  if (!n) return null
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
}
const round2 = (x) => Math.round(x * 100) / 100

// Цены аналогов (кандидаты сопоставления: { group: { row }, exact, … }): { n, min, max, median, exact } (exact —
// сколько с тем же наименованием) или null.
export function priceStats(analogs) {
  const prices = analogs.map((a) => Number(a.group.row.price)).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b)
  if (!prices.length) return null
  return {
    n: prices.length,
    min: prices[0],
    max: prices[prices.length - 1],
    median: round2(median(prices)),
    exact: analogs.filter((a) => a.exact).length,
  }
}

// Отклонение цены файла от медианы реестра, % (со знаком; округлено до десятых) или null.
export function deviation(price, stats) {
  if (!(price > 0) || !stats?.median) return null
  return Math.round(((price - stats.median) / stats.median) * 1000) / 10
}

// Итог строки: none — аналогов с той же ед. изм. нет; ok — в пределах допуска; high — дороже; low — дешевле;
// noprice — в строке файла нет цены.
export function verdictOf(price, stats, tolerance = DEFAULT_TOLERANCE) {
  if (!(price > 0)) return 'noprice'
  const d = deviation(price, stats)
  if (d == null) return 'none'
  if (d > tolerance) return 'high'
  if (d < -tolerance) return 'low'
  return 'ok'
}

export const VERDICT_TEXT = {
  ok: 'в рынке',
  high: 'дороже реестра',
  low: 'дешевле реестра',
  none: 'нет аналогов',
  noprice: 'нет цены',
}

// Строки файла и найденные расценки → строки проверки:
//   [{ i, item, price, candidates, analogs, otherUnit, stats, dev, verdict }]
// items — строки файла (доставка — не позиция: без проверки); rowsByIdx — Map индекс строки → строки реестра;
// vat — НДС документа (как в окне снабжения: { mode, rate, force }) — цена файла приводится к цене с НДС, как в реестре.
export function checkLines(items, rowsByIdx, { vat = null, tolerance = DEFAULT_TOLERANCE } = {}) {
  return (items || []).map((item, i) => {
    const price = item.delivery ? null : unitPriceWithVat(item, vat)
    const groups = registryGroups(rowsByIdx.get(i) || [])
    const candidates = item.delivery || !groups.length ? [] : itemCandidates(item, groups, matchIndex(groups), groups.length)
    const close = candidates.filter((c) => c.exact || c.score >= AUTO_MIN)
    const analogs = close.filter((c) => c.unitOk)
    const otherUnit = close.filter((c) => !c.unitOk)
    const stats = priceStats(analogs)
    const p = price != null && price > 0 ? round2(price) : null
    return {
      i, item, price: p, candidates, analogs, otherUnit, stats,
      dev: deviation(p, stats),
      verdict: item.delivery ? 'delivery' : verdictOf(p, stats, tolerance),
    }
  })
}

// Итоги проверки по видам итога.
export function checkSummary(lines) {
  const out = { total: 0, ok: 0, high: 0, low: 0, none: 0, noprice: 0 }
  for (const l of lines) {
    if (l.verdict === 'delivery') continue
    out.total += 1
    out[l.verdict] = (out[l.verdict] || 0) + 1
  }
  return out
}

// Разбить список на порции (вызовы kp_rates_lookup).
export function chunks(list, size = LOOKUP_CHUNK) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

// Вид расценки строки для поиска и добавления: лист «Материалы» / «Работы» файла, иначе выбранный в окне (all — оба).
export const lineKind = (item, kind) => item.kindHint || (kind === 'all' ? null : kind)

// Строки выгрузки проверки в Excel (шапка — CHECK_EXPORT_HEADERS).
export const CHECK_EXPORT_HEADERS = [
  '№', 'Наименование в файле', 'Ед. изм.', 'Кол-во', 'Цена в файле с НДС, ₽', 'Аналогов в реестре', 'Мин., ₽', 'Медиана, ₽',
  'Макс., ₽', 'Отклонение от медианы, %', 'Итог', 'Ближайший аналог', 'Подрядчик', 'Тендер', 'Дата расценки', 'Цена аналога, ₽',
]
export function checkExportRows(lines) {
  return lines.filter((l) => l.verdict !== 'delivery').map((l, n) => {
    const best = l.analogs[0]?.group.row || null
    return [
      n + 1, l.item.name, l.item.unit || '', l.item.qty ?? '', l.price ?? '', l.stats?.n ?? 0,
      l.stats?.min ?? '', l.stats?.median ?? '', l.stats?.max ?? '', l.dev ?? '', VERDICT_TEXT[l.verdict] || '',
      best?.item_name || '', best?.counterparty_name || '', best?.tender_desc || '', best?.proposal_date || '',
      best?.price != null ? Number(best.price) : '',
    ]
  })
}
