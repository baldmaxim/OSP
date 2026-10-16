// Материалы ВОР: сложение строк ВОР по наименованию и единице (подвкладки «Материалы» / «Работы» карточки
// тендера и их выгрузка) и позиции для расценки снабжением на сайте (страница расценки, миграция 20261020).
import { normName, supplyKey } from './supplyRateHelpers.js'

// task 260: КОД «Р» / «Р-…» → работа, «мат.» и прочее → материал (как в «Анализе КП» и БСМ).
export const isWorkItem = (it) => {
  const c = (it.code || '').trim().toUpperCase()
  return c.startsWith('Р')
}

// task 260 / 398: строки одного вида (materials | works), сложенные по наименованию + ед. изм. без регистра.
// ratesMap (supplyKey → цена за единицу) — для материалов добавляет «стоимость от снабжения» (Σ объём × цена).
// Разделы и разделители документов (_isDocDivider) не участвуют.
export function aggregateEstimate(items, type, ratesMap = null) {
  const withSupply = type === 'materials' && !!ratesMap
  const map = new Map()
  for (const it of items) {
    if (it.is_section || it._isDocDivider) continue
    const work = isWorkItem(it)
    if (type === 'works' && !work) continue
    if (type === 'materials' && work) continue
    const name = (it.cost_name || '').trim()
    if (!name) continue
    const unit = (it.unit || '').trim()
    const key = `${name.toLowerCase()}∣${unit.toLowerCase()}`
    const vol = type === 'works' ? it.work_volume : it.material_consumption
    const cur = map.get(key) || { name, unit, total: 0, count: 0, supplyCost: 0 }
    cur.total += Number(vol) || 0
    cur.count += 1
    if (withSupply) {
      const price = ratesMap.get(supplyKey(it.estimate_name, name))
      if (price != null) cur.supplyCost += (Number(it.material_consumption) || 0) * Number(price)
    }
    map.set(key, cur)
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'))
}

// Объём: число или null (пусто, не число). Ноль — это ноль.
const volumeOf = (v) => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const sumVolumes = (a, b) => (a == null ? b : b == null ? a : a + b)

// Позиции для расценки из строк { name, unit, volume } (лист «Материалы» файла или сложенный ВОР карточки).
// Группировка — строго по ключу цены (normName): так сопоставляет цены карточка, и одна позиция = одна цена.
// Разные ед. изм. у одного наименования — одна позиция с units: [{ unit, volume }], unit и volume пусты:
// цена одна на все строки, а сумму вводить нельзя (метры со штуками не складываются).
export function buildSupplyPositions(rows) {
  const groups = new Map()
  for (const r of rows) {
    const name = String(r.name ?? '').replace(/\s+/g, ' ').trim()
    if (!name) continue
    const key = normName(name)
    if (!key) continue
    const unit = String(r.unit ?? '').replace(/\s+/g, ' ').trim()
    const g = groups.get(key) || { name, units: new Map() }
    const unitKey = unit.toLowerCase()
    const u = g.units.get(unitKey) || { unit, volume: null }
    u.volume = sumVolumes(u.volume, volumeOf(r.volume))
    g.units.set(unitKey, u)
    groups.set(key, g)
  }
  let order = 0
  return [...groups.values()].map((g) => {
    order += 1
    const units = [...g.units.values()]
    if (units.length === 1) return { name: g.name, unit: units[0].unit || null, volume: roundVolume(units[0].volume), order }
    return { name: g.name, unit: null, volume: null, order, units: units.map((u) => ({ unit: u.unit || null, volume: roundVolume(u.volume) })) }
  })
}

// Объёмы в базе ВОР — до 4 знаков; сложение float даёт хвосты (0.1 + 0.2).
function roundVolume(v) {
  return v == null ? null : Math.round(v * 10000) / 10000
}

// Позиции материалов ВОР карточки по документам: Map(estimate_name → позиции).
export function positionsFromEstimate(items) {
  const byDoc = new Map()
  for (const it of items) {
    if (it.is_section || isWorkItem(it)) continue
    const doc = it.estimate_name || 'Основная смета'
    if (!byDoc.has(doc)) byDoc.set(doc, [])
    byDoc.get(doc).push({ name: it.cost_name, unit: it.unit, volume: it.material_consumption })
  }
  const out = new Map()
  for (const [doc, rows] of [...byDoc.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru'))) {
    out.set(doc, buildSupplyPositions(rows))
  }
  return out
}
