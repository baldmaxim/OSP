// Проверка цен файла по реестру СУ-10 (реестр расценок → «Расценки от снабжения СУ-10» → «Проверить по файлу»). Только решения,
// без запросов — tests/tender/supply-registry-check.test.mjs.
//
// Файл распознаётся тем же разбором, что проверки реестра КП и договорных расценок (utils/bidImport, и незаполненный ВОР — с ценами
// реестра по его позициям). Позиции реестра для строки файла ищутся так же, как в тендерах на материалы строке счёта ищутся позиции ВОР
// (окно «Счета и КП», utils/supplyDocMatch): то же наименование, слова и числа с раскрытыми сокращениями, текст целиком, артикул
// (в том числе «арт.» в наименовании), вид материала, разные размеры — не та позиция; упаковка, бухта, длина изделия, км и м, т и кг
// пересчитываются на единицу (docPack). В сравнение сами идут те же позиции, что строка счёта закрыла бы сама (autoChosen: лучшая,
// почти такая же вторая, тот же артикул или материал под другой записью); остальные похожие — «возможные», человек включает их
// галочкой, а не найденную позицию — поиском по реестру, как «Найти позицию ВОР» в окне счетов.
//
// Замер 25.11.2026 на всём реестре прода (26 тыс. строк, 18,4 тыс. наименований с ед. изм.; мерка — медиана аналогов расходится с
// ценой строки больше чем в 3 раза): строки самого реестра, чьё наименование убрано из поиска, — 78,4 % строк с аналогами, расхождений
// 4,5 % («похоже от 0,6», как в проверке КП, — 78,8 % и 4,4 %, но «дальше чем в 1,5 раза» 24,3 % против 20,9 %); строки КП подрядчиков
// (материалы) — 64,5 % и 13,9 % при 12,8 % у того же наименования: ниже не опуститься, цены КП и снабжения разные. Пересчёт
// единиц на итог почти не влияет (строк с ним — 10–18 %). Меняете выбор — повторите замер на копии.
//
// Цены реестра считаются с НДС: так их ставит расценка снабжением (цена документа приводится к цене с НДС); у загруженных из Excel —
// как в файле загрузки (ставку загрузка не спрашивает).
import { normName } from './supplyRateHelpers.js'
import { canonUnit, nameParts } from './supplySimilarity.js'
import { autoChosen, groupUnitOk, itemCandidates, linePack, matchIndex } from './supplyDocMatch.js'
import { unitPriceWithVat } from './supplierDoc.js'
import { DEFAULT_TOLERANCE, VERDICT_TEXT, deviation, median, round2, verdictOf } from './kpRateCheck.js'

export { VERDICT_TEXT }
// Сколько кандидатов у строки файла (среди них — «возможные»): в реестре одно и то же часто записано по-разному.
export const CANDIDATES_MAX = 40
// Сколько групп в другой ед. изм. показывать у строки.
const OTHER_UNIT_MAX = 3

// ── Указатель реестра ───────────────────────────────────────────────────────────────────────────────
// Группа — одно наименование (ключ normName) в одной ед. изм., как группы позиций ВОР в расценке снабжением: { key, k, name, unit,
// units, parts, targets, rows }. targets пуст: объёмов ВОР у реестра нет (количество строки не поднимает похожесть). Строки без цены
// и без наименования в указатель не идут.
export function supplyCheckIndex(rows) {
  const byKey = new Map()
  let rowCount = 0
  for (const r of rows || []) {
    if (!(Number(r.price) > 0)) continue
    const k = normName(r.item_name)
    if (!k) continue
    const key = `${k}|${canonUnit(r.unit) || ''}`
    let g = byKey.get(key)
    if (!g) {
      g = { key, k, name: r.item_name, unit: r.unit || null, units: null, parts: nameParts(r.item_name), targets: [], rows: [] }
      byKey.set(key, g)
    }
    g.rows.push(r)
    rowCount += 1
  }
  const groups = [...byKey.values()]
  return { groups, byKey, ix: matchIndex(groups), rowCount }
}

// ── Строки файла ────────────────────────────────────────────────────────────────────────────────────
// В реестре СУ-10 — цены материалов: строки листа «Работы» не проверяются, у строки с двумя ценами (материалы и работы) берётся
// цена материалов, а если есть только цена работ — строка не проверяется. Ответ: { items, works } — works: сколько строк работ.
const hasPart = (p) => !!p && (p.price != null || p.sum != null)
export function materialLines(list) {
  const items = []
  let works = 0
  for (const it of list || []) {
    if (it.kindHint === 'work') { works += 1; continue }
    if (it.parts) {
      const p = it.parts.material
      if (hasPart(p)) items.push({ ...it, price: p.price, priceVat: p.priceVat, sum: p.sum, sumVat: p.sumVat, kindHint: 'material', parts: null })
      else if (hasPart(it.parts.work)) works += 1
      else items.push({ ...it, parts: null })
      continue
    }
    items.push(it)
  }
  return { items, works }
}

// Кандидаты строки файла (itemCandidates с пересчётом единиц), лучшие первыми.
export function lineCandidates(item, index) {
  if (item.delivery) return []
  return itemCandidates(item, index.groups, index.ix, CANDIDATES_MAX, { packs: true })
}

// Позиция, которую человек нашёл поиском по реестру и добавил строке: та же ед. изм. или пересчёт, как у кандидата.
export function pickedCandidate(item, group) {
  const pack = group.units ? null : linePack(item, group)
  return { group, score: null, exact: normName(item.name) === group.k, code: false, article: false, apart: false, manual: true, pack,
    unitOk: pack != null || groupUnitOk(item.unit, group) }
}

// Самая ранняя дата расценки для «за N месяцев» (0 — за всё время): today — «ГГГГ-ММ-ДД» (по Москве), ответ — миллисекунды полуночи
// того дня по Москве или null. Дата расценки в реестре — полночь дня по Москве.
export function periodStart(months, today) {
  if (!months) return null
  const [y, m, d] = today.split('-').map(Number)
  const shifted = new Date(Date.UTC(y, m - 1 - months, 1))
  const last = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate()
  shifted.setUTCDate(Math.min(d, last))
  return Date.parse(`${shifted.toISOString().slice(0, 10)}T00:00:00+03:00`)
}
const inPeriod = (row, since) => since == null || (!!row.rate_date && Date.parse(row.rate_date) >= since)
const newestFirst = (a, b) => String(b.row.rate_date || '').localeCompare(String(a.row.rate_date || '')) || a.price - b.price

// ── Строки проверки ─────────────────────────────────────────────────────────────────────────────────
// Строки файла → [{ i, item, price, entries, possibleCount, otherUnit, older, stats, dev, verdict }]. entries — позиции реестра строки
// по порядку кандидатов: { key, group, c, points, auto, manual, on, factor }; points — цены расценок за единицу строки файла
// ({ row, price }, свежие первыми); factor — сколько единиц позиции реестра в единице строки (1 — та же). auto — пошла бы сама, как в
// окне счетов; manual — найдена человеком поиском. otherUnit — позиции в другой ед. изм. без пересчёта (в сравнение не идут), older —
// сколько позиций только со старыми ценами (раньше периода).
// found — Map индекс строки → lineCandidates; picked — Map индекс → [группы, найденные поиском]; choices — Map `${i}|${key}` → учитывать;
// vat — НДС файла (как в окне снабжения), since — periodStart.
export function checkSupplyLines(items, found, { vat = null, tolerance = DEFAULT_TOLERANCE, since = null, choices = null, picked = null } = {}) {
  return (items || []).map((item, i) => {
    const raw = item.delivery ? null : unitPriceWithVat(item, vat)
    const price = raw != null && raw > 0 ? round2(raw) : null
    const cands = item.delivery ? [] : [...(found?.get(i) || [])]
    for (const g of picked?.get(i) || []) if (!cands.some((c) => c.group.key === g.key)) cands.push(pickedCandidate(item, g))
    const chosen = new Set(autoChosen(cands.filter((c) => !c.manual)))
    const entries = []
    const otherUnit = []
    let older = 0
    for (const c of cands) {
      const rows = c.group.rows.filter((r) => inPeriod(r, since))
      if (!rows.length) { older += 1; continue }
      if (!c.unitOk) {
        if (otherUnit.length < OTHER_UNIT_MAX) otherUnit.push({ group: c.group, c, rows })
        continue
      }
      const factor = c.pack || 1
      const points = rows.map((row) => ({ row, price: round2(Number(row.price) * factor) })).sort(newestFirst)
      const auto = chosen.has(c)
      const key = c.group.key
      entries.push({ key, group: c.group, c, points, auto, manual: !!c.manual, factor, on: choices?.get(`${i}|${key}`) ?? (auto || !!c.manual) })
    }
    const stats = pointStats(entries.filter((e) => e.on))
    return {
      i, item, price, entries, possibleCount: entries.filter((e) => !e.auto && !e.manual).length, otherUnit, older, stats,
      dev: deviation(price, stats),
      verdict: item.delivery ? 'delivery' : verdictOf(price, stats, tolerance),
    }
  })
}

// Цены включённых позиций: { n, min, max, median, names, exact, newest } или null; names — сколько позиций реестра, exact — сколько
// цен у того же наименования, newest — самая свежая расценка { row, price }.
export function pointStats(entries) {
  const points = entries.flatMap((e) => e.points)
  const prices = points.map((p) => p.price).filter((p) => p > 0).sort((a, b) => a - b)
  if (!prices.length) return null
  return {
    n: prices.length,
    min: prices[0],
    max: prices[prices.length - 1],
    median: round2(median(prices)),
    names: entries.filter((e) => e.points.length).length,
    exact: entries.filter((e) => e.c.exact).reduce((s, e) => s + e.points.length, 0),
    newest: [...points].sort(newestFirst)[0],
  }
}

// Итоги проверки: счётчики по итогам и суммы по строкам, где есть и цена, и количество, и цены реестра.
export function supplyCheckSummary(lines) {
  const out = { total: 0, ok: 0, high: 0, low: 0, none: 0, noprice: 0, withStats: 0, fileSum: 0, medianSum: 0 }
  for (const l of lines) {
    if (l.verdict === 'delivery') continue
    out.total += 1
    out[l.verdict] = (out[l.verdict] || 0) + 1
    if (l.stats) out.withStats += 1
    if (l.price != null && l.stats && l.item.qty > 0) {
      out.fileSum += l.price * l.item.qty
      out.medianSum += l.stats.median * l.item.qty
    }
  }
  out.fileSum = round2(out.fileSum)
  out.medianSum = round2(out.medianSum)
  return out
}

// ── Выгрузка в Excel ────────────────────────────────────────────────────────────────────────────────
const MSK_DAY = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' })
const mskDay = (iso) => {
  const t = Date.parse(iso || '')
  return Number.isFinite(t) ? MSK_DAY.format(new Date(t)) : ''
}
export const SUPPLY_CHECK_EXPORT_HEADERS = [
  '№', 'Наименование в файле', 'Ед. изм.', 'Кол-во', 'Цена в файле с НДС, ₽', 'Цен в реестре', 'Позиций реестра', 'Мин., ₽', 'Медиана, ₽',
  'Макс., ₽', 'Отклонение от медианы, %', 'Сумма в файле, ₽', 'Сумма по медиане, ₽', 'Итог', 'Ближайшая расценка', 'Ед. изм. расценки',
  'Цена расценки, ₽', 'Цена за ед. файла, ₽', 'Источник', 'Объект', 'Тендер', 'Дата расценки',
]
export function supplyCheckExportRows(lines) {
  return lines.filter((l) => l.verdict !== 'delivery').map((l, n) => {
    const best = l.entries.find((e) => e.on && e.points.length) || null
    const p = best?.points[0]
    const r = p?.row
    const qty = l.item.qty
    return [
      n + 1, l.item.name, l.item.unit || '', qty ?? '', l.price ?? '', l.stats?.n ?? 0, l.stats?.names ?? 0,
      l.stats?.min ?? '', l.stats?.median ?? '', l.stats?.max ?? '', l.dev ?? '',
      l.price != null && qty > 0 ? round2(l.price * qty) : '', l.stats && qty > 0 ? round2(l.stats.median * qty) : '',
      l.verdict === 'noprice' && l.stats ? 'цены в файле нет' : VERDICT_TEXT[l.verdict] || '',
      r?.item_name || '', r?.unit || '', r ? Number(r.price) : '', p?.price ?? '', r?.source_name || (r ? 'СУ-10' : ''), r?.object_name || '',
      r?.tender_desc || '', mskDay(r?.rate_date),
    ]
  })
}
