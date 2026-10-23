// Файл ВОР тендера (из «ВОРов и РД») → позиции для расценки подрядчиком в кабинете (миграция 20261102).
//
// Книга, которую отдел рассылает подрядчикам: «Главный лист» (особые условия — показываются подрядчику; анкету
// отсюда не читаем — её поля ведёт администратор), «Материалы» и «Работы» — уникальные позиции с объёмом, где подрядчик ставит цену за
// единицу, и «КП» — полный ВОР: разделы, работы и материалы под ними; суммы листа «КП» считаются от цен листов
// «Материалы» и «Работы». Подрядчик лист «КП» не правит — на сайте он показывается для понимания структуры.
//
// Шапки ищутся по словам (как у расценки снабжением): «Наименование» + «Объём / Кол-во / Расход» (+ «Ед. изм.»);
// у «КП» — ещё «КОД». Нет отдельного листа «Материалы» или «Работы» — позиции этого вида складываются из «КП».
// Объём материала в «КП» — «Общий расход» (объём работы × коэффициент), работы — «Объём по виду работ».
//
// Цена подрядчика одна на позицию тендера: вид (материал / работа) + наименование (normName) + ед. изм.
// (normUnit). Так же их хранит база (tender_bid_rates: kind, item_key, unit_key).
import * as XLSX from 'xlsx'
import { detectMaterialsColumns, parseMaterialsSheet, parseVolume } from './vorMaterialsSheet.js'
import { normName } from './supplyRateHelpers.js'
import { normUnit } from './supplySimilarity.js'

export const BID_KINDS = ['material', 'work']
export const BID_KIND_LABEL = { material: 'Материалы', work: 'Работы' }

// Ключи позиции — те же, что пишет bid_rates_save.
export const bidItemKey = (name) => normName(String(name ?? '').replace(/\s+/g, ' ').trim())
export const bidUnitKey = (unit) => normUnit(unit)
export const bidKey = (kind, name, unit) => `${kind}|${bidItemKey(name)}|${bidUnitKey(unit)}`
export const rateKey = (r) => `${r.kind}|${r.item_key}|${r.unit_key || ''}`

const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()
const READ_OPTIONS = { type: 'array', cellFormula: false, cellStyles: false, bookVBA: false, cellHTML: false }
// \b в JS — граница только латинских слов: для кириллицы — явная проверка, что дальше не буква.
const TOTAL_ROW = /^(итого|всего)(?![а-яё])/

// ── Листы ────────────────────────────────────────────────────────────────────────────────────────────
export function findBidSheets(names) {
  const list = names || []
  const find = (re) => list.find((n) => re.test(norm(n))) || null
  return {
    materials: find(/^материал/),
    works: find(/^работ/),
    kp: find(/^кп(?![а-яё])/) || find(/^вор(?![а-яё])/),
    main: find(/^главн/),
  }
}

// ── Лист «КП»: структура ─────────────────────────────────────────────────────────────────────────────
function kpHeaderKind(text) {
  const t = norm(text)
  if (!t) return null
  if (/^№|п\/п/.test(t)) return { field: 'num', rank: 1 }
  if (/^код(?![а-яё])/.test(t)) return { field: 'code', rank: 1 }
  if (/наименован/.test(t)) return { field: 'name', rank: 1 }
  if (/^ед\.?(\s|$)|ед\.?\s*изм|единиц/.test(t)) return { field: 'unit', rank: 1 }
  if (/цена|стоимост|расценк|сумм/.test(t)) return null
  if (/расход/.test(t)) return { field: 'consumption', rank: 1 }
  if (/объ[её]м|кол-?во|количеств/.test(t)) return { field: 'volume', rank: 1 }
  return null
}

const sheetRange = (ws) => (ws?.['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null)
const cellValue = (ws, r, c) => {
  if (c == null) return ''
  const cell = ws[XLSX.utils.encode_cell({ r, c })]
  return cell ? (cell.v ?? '') : ''
}

export const HEADER_SCAN_ROWS = 40

// Шапка «КП»: { headerRow (1-based), columns: { num, code, name, unit, volume, consumption } } | null.
export function detectKpColumns(ws) {
  const range = sheetRange(ws)
  if (!range) return null
  const lastRow = Math.min(range.e.r, range.s.r + HEADER_SCAN_ROWS - 1)
  for (let r = range.s.r; r <= lastRow; r++) {
    const found = {}
    for (let c = range.s.c; c <= range.e.c; c++) {
      const kind = kpHeaderKind(cellValue(ws, r, c))
      if (kind && found[kind.field] == null) found[kind.field] = c
    }
    if (found.code != null && found.name != null && (found.volume != null || found.consumption != null)) {
      return {
        headerRow: r + 1,
        columns: {
          num: found.num ?? null, code: found.code, name: found.name, unit: found.unit ?? null,
          volume: found.volume ?? null, consumption: found.consumption ?? null,
        },
      }
    }
  }
  return null
}

// Код строки «КП»: работа («Р», «Р-…», «Работа», «раб.»), материал или оборудование («мат.», «Мат», «Обор.»).
export function kpRowKind(code) {
  const c = norm(code)
  if (!c) return null
  if (/^р(?![а-яё])|^раб/.test(c)) return 'work'
  if (/^мат|^обор/.test(c)) return 'material'
  return 'other'
}

const positive = (v) => (v != null && v > 0 ? v : null)

// «Общий расход» у материалов — коэффициент (1; 1,02; 1,2), а не количество: так в ВОР прежнего вида, где
// количество материала стоит в «Объёме». Признак — почти у всех материалов с обоими числами расход ≤ 3 и меньше объёма.
export function consumptionIsFactor(pairs) {
  const both = pairs.filter((p) => p.volume > 0 && p.consumption > 0)
  if (both.length < 3) return false
  const factors = both.filter((p) => p.consumption <= 3 && p.volume >= p.consumption).length
  return factors / both.length >= 0.8
}

// Строки «КП» по шапке: [{ type: 'section' | 'work' | 'material', num, code, name, unit, volume, row }].
// Таблица кончается первой строкой «Итого / Всего» после позиций: дальше — условия и анкета, это не ВОР.
export function parseKpSheet(ws, det = detectKpColumns(ws)) {
  const range = sheetRange(ws)
  const out = { rows: [], skipped: 0, consumptionFactor: false }
  if (!range || !det) return out
  const col = det.columns
  let items = 0
  for (let r = det.headerRow; r <= range.e.r; r++) {
    const name = clean(cellValue(ws, r, col.name))
    if (!name) continue
    if (TOTAL_ROW.test(name.toLowerCase())) {
      if (items > 0) break
      out.skipped += 1
      continue
    }
    // Строка номеров колонок под шапкой (1 | 2 | 3 …) и повтор шапки.
    if (/^\d+$/.test(name) || kpHeaderKind(name)?.field === 'name') { out.skipped += 1; continue }
    const code = clean(cellValue(ws, r, col.code))
    const unit = clean(cellValue(ws, r, col.unit))
    const volume = parseVolume(cellValue(ws, r, col.volume))
    const consumption = parseVolume(cellValue(ws, r, col.consumption))
    const num = clean(cellValue(ws, r, col.num))
    let type = kpRowKind(code)
    if (type === 'other') { out.skipped += 1; continue }
    if (!type) {
      // Без кода: с ед. изм. и объёмом — материал (так в части ВОР записаны материалы), иначе раздел.
      type = unit && positive(consumption ?? volume) ? 'material' : 'section'
    }
    if (type === 'section') {
      out.rows.push({ type, num, code: '', name, unit: '', volume: null, row: r + 1 })
      continue
    }
    out.rows.push({ type, num, code, name, unit, volume: type === 'work' ? (volume ?? consumption) : null, raw: { volume, consumption }, row: r + 1 })
    items += 1
  }
  const materials = out.rows.filter((r) => r.type === 'material')
  out.consumptionFactor = consumptionIsFactor(materials.map((r) => r.raw))
  for (const r of materials) {
    r.volume = out.consumptionFactor ? (r.raw.volume ?? null) : (positive(r.raw.consumption) ?? r.raw.volume)
  }
  for (const r of out.rows) delete r.raw
  return out
}

// ── «Главный лист»: особые условия ───────────────────────────────────────────────────────────────────
// Блок «Особые условия, которые …» (ГУ 5 %, гарантия 60 мес., шаблон договора…): заголовок ищется по тексту, условия —
// строки под ним (первая непустая ячейка строки, от колонки заголовка вправо) до пустой строки или следующего блока
// («Квалификационная и контактная информация»). Анкету отсюда не читаем — её поля ведёт администратор.
const CONDITIONS_HEAD = /^особые\s+услови/
const NEXT_BLOCK = /квалификац|контактн[а-я]*\s+информац/
export const CONDITIONS_MAX = 30

export function readMainConditions(ws) {
  const range = sheetRange(ws)
  if (!range) return []
  const lastRow = Math.min(range.e.r, range.s.r + 300)
  for (let r = range.s.r; r <= lastRow; r++) {
    for (let c = range.s.c; c <= Math.min(range.e.c, range.s.c + 30); c++) {
      if (!CONDITIONS_HEAD.test(norm(cellValue(ws, r, c)))) continue
      const out = []
      for (let rr = r + 1; rr <= Math.min(range.e.r, r + 100) && out.length < CONDITIONS_MAX; rr++) {
        let text = ''
        for (let cc = c; cc <= Math.min(range.e.c, c + 6) && !text; cc++) {
          const v = clean(cellValue(ws, rr, cc))
          if (v && !/^\d+[.)]?$/.test(v)) text = v
        }
        if (!text) { if (out.length) break; continue }
        if (NEXT_BLOCK.test(text.toLowerCase())) break
        out.push(text)
      }
      return out
    }
  }
  return []
}

// ── Позиции ──────────────────────────────────────────────────────────────────────────────────────────
// Строки одного вида → уникальные позиции { kind, key, itemKey, unitKey, name, unit, volume, rows }: тот же ключ —
// объёмы складываются.
export function buildBidPositions(kind, rows) {
  const map = new Map()
  for (const r of rows) {
    const name = clean(r.name)
    if (!name || !bidItemKey(name)) continue
    const unit = clean(r.unit)
    const key = bidKey(kind, name, unit)
    const p = map.get(key) || { kind, key, itemKey: bidItemKey(name), unitKey: bidUnitKey(unit), name, unit: unit || null, volume: null, rows: 0 }
    const v = r.volume == null || r.volume === '' ? null : Number(r.volume)
    if (v != null && Number.isFinite(v)) p.volume = Math.round(((p.volume ?? 0) + v) * 10000) / 10000
    p.rows += 1
    map.set(key, p)
  }
  return [...map.values()]
}

// Лист «Материалы» / «Работы» → строки { name, unit, volume } (шапка — как у расценки снабжением).
function readListSheet(ws) {
  const map = detectMaterialsColumns(ws)
  if (!map) return null
  return parseMaterialsSheet(ws, map).rows
}

// Книга → { materials, works, structure, conditions, sheets: { materials, works, kp, main }, sources: { material, work } }
// | { error: 'broken' | 'no_positions', sheetNames }. sources — откуда взяты позиции вида: 'sheet' | 'kp'.
export function readBidWorkbook(wb) {
  const names = wb?.SheetNames || []
  const sheets = findBidSheets(names)
  let kp = null
  let kpSheet = sheets.kp
  if (kpSheet && wb.Sheets[kpSheet]) kp = parseKpSheet(wb.Sheets[kpSheet])
  // Листа «КП» нет (или в нём нет шапки с «КОД») — первый лист с такой шапкой, кроме списков.
  if (!kp?.rows.length) {
    for (const n of names) {
      if (n === sheets.materials || n === sheets.works || n === sheets.main || !wb.Sheets[n]) continue
      const det = detectKpColumns(wb.Sheets[n])
      if (!det) continue
      const parsed = parseKpSheet(wb.Sheets[n], det)
      if (parsed.rows.some((r) => r.type !== 'section')) { kp = parsed; kpSheet = n; break }
    }
  }
  const structure = kp?.rows.length ? kp.rows : []
  const fromKp = (type) => structure.filter((r) => r.type === type)
  const sources = {}
  const list = (kind, sheetName, type) => {
    const rows = sheetName && wb.Sheets[sheetName] ? readListSheet(wb.Sheets[sheetName]) : null
    if (rows?.length) { sources[kind] = 'sheet'; return buildBidPositions(kind, rows) }
    const own = fromKp(type)
    sources[kind] = own.length ? 'kp' : null
    return buildBidPositions(kind, own)
  }
  const materials = list('material', sheets.materials, 'material')
  const works = list('work', sheets.works, 'work')
  if (!materials.length && !works.length) return { error: 'no_positions', sheetNames: names }
  const conditions = sheets.main && wb.Sheets[sheets.main] ? readMainConditions(wb.Sheets[sheets.main]) : []
  return { materials, works, structure, conditions, sheets: { ...sheets, kp: kpSheet || null }, sources }
}

// Байты файла → разбор. Читаются только нужные листы: прочие соседи бывают тяжёлыми.
export function readBidFileBytes(bytes) {
  let names
  try {
    names = XLSX.read(bytes, { type: 'array', bookSheets: true }).SheetNames || []
  } catch (e) {
    return { error: 'broken', message: String(e?.message || e) }
  }
  const s = findBidSheets(names)
  // «КП» не нашли по имени — читаем все листы: шапку с «КОД» ищет readBidWorkbook.
  const wanted = s.kp ? [s.materials, s.works, s.kp, s.main].filter(Boolean) : names
  try {
    const wb = XLSX.read(bytes, { ...READ_OPTIONS, sheets: wanted })
    return readBidWorkbook({ SheetNames: names, Sheets: wb.Sheets })
  } catch (e) {
    return { error: 'broken', message: String(e?.message || e), sheetNames: names }
  }
}

// ── Несколько файлов ВОР тендера → одна расценка ────────────────────────────────────────────────────────
// files: [{ id, name, parsed }] (parsed — ответ readBidFileBytes без ошибки). Позиции с одним ключом из разных
// файлов — одна позиция (цена одна на тендер), объёмы складываются, docs — в каких ВОР встречается.
export function mergeBidFiles(files) {
  const byKey = new Map()
  for (const f of files) {
    for (const p of [...(f.parsed.materials || []), ...(f.parsed.works || [])]) {
      const cur = byKey.get(p.key)
      if (!cur) {
        byKey.set(p.key, { ...p, docs: [f.name], volumes: { [f.name]: p.volume } })
        continue
      }
      if (p.volume != null) cur.volume = Math.round(((cur.volume ?? 0) + p.volume) * 10000) / 10000
      if (!cur.docs.includes(f.name)) cur.docs.push(f.name)
      cur.volumes[f.name] = p.volume
    }
  }
  const all = [...byKey.values()]
  return {
    materials: all.filter((p) => p.kind === 'material'),
    works: all.filter((p) => p.kind === 'work'),
  }
}

// ── Суммы ────────────────────────────────────────────────────────────────────────────────────────────
export const roundMoney2 = (n) => Math.round(n * 100) / 100

// Сумма позиции: цена × объём; нет цены или объёма — null.
export function lineTotal(price, volume) {
  const p = Number(price)
  const v = Number(volume)
  if (price == null || volume == null || !Number.isFinite(p) || !Number.isFinite(v)) return null
  return roundMoney2(p * v)
}

// Уровень раздела «КП»: без номера — 0 (заголовок системы), «1» — 1, «1.2» — 2.
export const sectionLevel = (num) => {
  const n = String(num ?? '').trim().replace(/\.$/, '')
  return n ? n.split('.').length : 0
}

// Структура «КП» с ценами: строки + суммы работ и материалов по каждому разделу и всему ВОР.
// prices — Map(bidKey → цена за единицу). Раздел копит суммы своих строк до следующего раздела того же или более
// высокого уровня; вложенные разделы входят в суммы старших.
export function priceStructure(rows, prices) {
  const out = []
  const totals = { materials: 0, works: 0, priced: 0, items: 0 }
  const open = []
  for (const r of rows) {
    if (r.type === 'section') {
      const level = sectionLevel(r.num)
      while (open.length && open[open.length - 1].level >= level) open.pop()
      const section = { ...r, level, materials: 0, works: 0 }
      open.push(section)
      out.push(section)
      continue
    }
    const kind = r.type === 'work' ? 'work' : 'material'
    const price = prices.get(bidKey(kind, r.name, r.unit))
    const total = price == null ? null : lineTotal(price, r.volume)
    totals.items += 1
    if (price != null) totals.priced += 1
    if (total != null) {
      const field = kind === 'work' ? 'works' : 'materials'
      totals[field] += total
      for (const s of open) s[field] += total
    }
    out.push({ ...r, kind, price: price ?? null, total })
  }
  for (const s of out) {
    if (s.type !== 'section') continue
    s.materials = roundMoney2(s.materials)
    s.works = roundMoney2(s.works)
  }
  totals.materials = roundMoney2(totals.materials)
  totals.works = roundMoney2(totals.works)
  return { rows: out, totals }
}
