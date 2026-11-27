// Цены сметы КП / ПЗ, изменённые администратором (миграция 20270308; просьба пользователя 27.11.2026: «в будущем возможно
// изменение объёмов, общей цены… нужна возможность для админа подгрузки документа, чтобы сопоставлять позиции и менять их
// цену, чтобы она в дальнейшем рассчитывалась и на позиции внутри, уменьшенной / увеличенной; сопоставление — как в тендерах
// на материалы; вручную — отдельным режимом»). Модуль чистый — tests/tender/kp-estimate.test.mjs.
//
// Действующая цена (effectivePrices):
//   • у позиции своя цена (kp_estimate_prices.unit_price) — стоимость = цена × «Кол-во (ГП)»; у позиции без кол-ва — своя
//     сумма (total). Своя цена закреплена: какую ввёл администратор (или документ), такая и стоит — группы выше её не
//     пересчитывают;
//   • у группы, раздела, укрупнённой позиции новая сумма (total) — она тоже закреплена, а её состав пересчитывается
//     пропорционально (уменьшается или увеличивается): закреплённое внутри остаётся как есть, остаток суммы делится на
//     позиции без своей цены одним множителем = (сумма − закреплённое) / (состав − закреплённое); множители вложенных групп
//     без своей суммы проходят насквозь;
//   • закреплённое внутри больше заданной суммы или пересчитывать нечего — множитель 0 / 1, сумма группы — какая вышла
//     (entry.target — заданная, entry.unreached — не достигнута).
// Без изменений — цена из файла (стоимость / «Кол-во (ГП)»), как раньше.
//
// Документ цен и сопоставление его строк с позициями — utils/kpEstimatePriceDoc.js (грузится только окном документа).
import { isPosition, originalQty, rowTotal, unitPrice } from './kpEstimate.js'

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
export const MONEY_EPS = 0.005

// ── Действующие цены ────────────────────────────────────────────────────────────────────────────────
// tree — buildTree; prices — Map row_id → запись kp_estimate_prices. Ответ — Map row_id → { unit, total, base, baseUnit,
// materials, works, factor, own, scaled, changed }: unit — цена за единицу (позиция), total — стоимость по «Кол-ву (ГП)»,
// base / baseUnit — из файла, factor — множитель предков (1 — не пересчитана группой), own — своя запись цены строки.
// Изменений нет — пустая Map (вызывающий берёт цены файла).
export function effectivePrices(tree, prices) {
  const out = new Map()
  if (!tree || !prices || !prices.size) return out
  const eff = new Map() // стоимость строки до множителей предков
  const pinned = new Map() // закреплённая часть eff (своя цена позиции, своя сумма группы) — предки её не пересчитывают
  const base = new Map()
  const factor = new Map() // множитель группы со своей суммой — для незакреплённого состава
  const target = new Map()
  const fixed = new Set() // позиции со своей ценой (в том числе 0 ₽)
  for (let i = tree.rows.length - 1; i >= 0; i--) {
    const r = tree.rows[i]
    const p = prices.get(r.id)
    const ch = tree.children.get(r.id)
    if (!ch) {
      const b = isPosition(r) ? rowTotal(r) : (num(r.kp?.total) || 0)
      const qty = originalQty(r)
      base.set(r.id, b)
      // Позиция — своей ценой × «Кол-во (ГП)»; без кол-ва — своей суммой (цены за единицу у неё нет).
      let own = null
      if (p && isPosition(r) && num(p.unit_price) !== null && qty) own = num(p.unit_price) * qty
      else if (p && isPosition(r) && num(p.unit_price) === null && num(p.total) !== null) own = num(p.total)
      eff.set(r.id, own ?? b)
      pinned.set(r.id, own === null ? 0 : own)
      if (own !== null) fixed.add(r.id)
      continue
    }
    let inner = 0
    let innerPinned = 0
    let b = 0
    for (const c of ch) { inner += eff.get(c) || 0; innerPinned += pinned.get(c) || 0; b += base.get(c) || 0 }
    base.set(r.id, b)
    const total = p ? num(p.total) : null
    if (total === null) {
      eff.set(r.id, inner)
      pinned.set(r.id, innerPinned)
      continue
    }
    target.set(r.id, total)
    const free = inner - innerPinned
    const f = Math.abs(free) > 1e-9 ? Math.max(0, (total - innerPinned) / free) : 1
    factor.set(r.id, f)
    const reached = innerPinned + free * f
    eff.set(r.id, reached)
    pinned.set(r.id, reached)
  }
  // Сверху вниз: scale — множитель незакреплённого состава строки от групп выше (группа со своей суммой его обрывает: что выше
  // неё, внутрь не проходит — она сама закреплена).
  const scale = new Map()
  for (const r of tree.rows) {
    const parent = tree.parentOf.get(r.id)
    let up = 1
    if (parent) up = target.has(parent) ? factor.get(parent) : scale.get(parent) * (factor.get(parent) ?? 1)
    scale.set(r.id, up)
    const p = prices.get(r.id) || null
    const e = eff.get(r.id) || 0
    const pin = pinned.get(r.id) || 0
    const own = target.has(r.id) || fixed.has(r.id)
    const total = own ? e : pin + (e - pin) * up
    const b = base.get(r.id) || 0
    const entry = { total, base: b, factor: own && !tree.children.has(r.id) ? 1 : up, own: p, scaled: !own && Math.abs(up - 1) > 1e-12, changed: Math.abs(total - b) > MONEY_EPS }
    if (target.has(r.id)) {
      entry.target = target.get(r.id)
      entry.unreached = Math.abs(e - entry.target) > MONEY_EPS
      entry.scaled = false
    }
    if (!tree.children.has(r.id) && isPosition(r)) {
      const qty = originalQty(r)
      const baseUnit = unitPrice(r)
      const ownUnit = p ? num(p.unit_price) : null
      entry.baseUnit = baseUnit
      entry.unit = qty ? total / qty : (ownUnit ?? baseUnit) * entry.factor
      // Материалы / работы: своя разбивка записи цены, иначе доля из файла.
      const mOwn = p ? num(p.unit_materials) : null
      const wOwn = p ? num(p.unit_works) : null
      if (mOwn !== null || wOwn !== null) {
        const sum = (mOwn || 0) + (wOwn || 0)
        entry.materials = sum ? total * ((mOwn || 0) / sum) : 0
        entry.works = sum ? total * ((wOwn || 0) / sum) : 0
      } else {
        const m = num(r.kp?.materials) || 0
        const w = num(r.kp?.works) || 0
        entry.materials = m + w ? total * (m / (m + w)) : null
        entry.works = m + w ? total * (w / (m + w)) : null
      }
      entry.changed = entry.changed || (ownUnit !== null && Math.abs(entry.unit - baseUnit) > MONEY_EPS)
    }
    out.set(r.id, entry)
  }
  return out
}

// Цена позиции за единицу: действующая (с изменениями), иначе из файла.
export const priceOf = (effective, row) => effective?.get(row?.id)?.unit ?? unitPrice(row)

// Изменение в процентах: 12,5 / −3,1 (null — не с чем сравнить).
export function changePct(next, prev) {
  if (prev === null || prev === undefined || !Number.isFinite(prev) || Math.abs(prev) < 1e-9 || next === null || next === undefined) return null
  return Math.round(((next - prev) / Math.abs(prev)) * 1000) / 10
}

const factorText = (f) => f.toLocaleString('ru-RU', { maximumFractionDigits: 4 })
// Откуда действующая цена строки: своя (документ / вручную) и / или пересчёт группой выше.
export function priceSourceText(price) {
  if (!price) return ''
  const own = price.own
  const parts = []
  if (own) parts.push(own.source === 'document' ? 'документ' : 'вручную')
  if (price.scaled) parts.push(`группа ×${factorText(price.factor)}`)
  return parts.join(', ')
}
