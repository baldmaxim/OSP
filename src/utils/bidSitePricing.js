// Расценка подрядчика на сайте — по ведомостям ВОР (просьба пользователя 24.11.2026, миграция 20270301). Без библиотеки Excel и без
// обращений к серверу: кабинет собирает этим позиции, суммы по каждой ведомости, «что изменилось в ВОР» и подсказки.
//
// Цена подрядчика по-прежнему одна на позицию тендера (вид + наименование + ед. изм., tender_bid_rates): одна и та же позиция в двух
// ведомостях (корпусах) — одна цена, а объём и сумма — по каждой ведомости. Итог тендера = сумма по ведомостям.
//
// Новая версия ведомости, которую отдел ещё не подтвердил (снабжение не ответило «новая версия» / «отдельный ВОР»), в расценку не
// входит: подрядчик сам изменения ВОР не принимает — они действуют после подтверждения отдела (решение пользователя). Правило — как
// вопрос снабжению «новая версия?» (versionQuestions): то же имя без отметки редакции, у прежнего ВОР есть цены снабжения.
import { lineTotal, roundMoney2 } from './bidPrice.js'
import { versionlessName } from './supplyVorVersions.js'
import { nameParts, scoreParts, SIMILAR_MIN, WORDS_MIN } from './supplySimilarity.js'

const titleOf = (name) => String(name ?? '').replace(/\.(xlsx|xlsm|xls)$/i, '')
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const sameVolume = (a, b) => (a == null || b == null ? a == null && b == null : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)))
const round4 = (v) => Math.round(v * 10000) / 10000

// Ведомости, которые ждут подтверждения отдела. files: [{ id, title, created_at }], meta: Map(id → { tracked, separate, valuable,
// created_at }) из bid_vor_changes (нет функции — пустая Map: ничего не задерживаем, как раньше). → Map(id новой → название прежней).
export function heldBackFiles(files, meta) {
  const out = new Map()
  if (!meta?.size) return out
  const at = (f) => String(meta.get(f.id)?.created_at || f.created_at || '')
  for (const b of files) {
    const mb = meta.get(b.id)
    if (!mb?.tracked || mb.separate) continue
    const name = versionlessName(titleOf(b.title))
    if (!name) continue
    const older = files.find((a) => a.id !== b.id && at(a) && at(a) < at(b) && meta.get(a.id)?.tracked && meta.get(a.id)?.valuable
      && versionlessName(titleOf(a.title)) === name)
    if (older) out.set(b.id, older.title)
  }
  return out
}

// Ведомости → позиции расценки. files: [{ id, title, positions: [{ kind, key, itemKey, unitKey, name, unit, volume }] }] — в порядке
// показа; held — Set(id) ведомостей, не входящих в расценку. Позиция: { key, kind, itemKey, unitKey, name, unit, volume (сумма по
// ведомостям), vols: { [id ведомости]: объём }, files: [id] }. Объём позиции, повторённой в ведомости, складывается.
export function buildBidView(files, held = new Set()) {
  const byKey = new Map()
  const vors = []
  for (const f of files) {
    const isHeld = held.has(f.id)
    let materials = 0
    let works = 0
    const seen = new Set()
    for (const p of f.positions || []) {
      if (!p?.key) continue
      if (!seen.has(p.key)) {
        seen.add(p.key)
        if (p.kind === 'work') works += 1
        else materials += 1
      }
      if (isHeld) continue
      let cur = byKey.get(p.key)
      if (!cur) {
        cur = { key: p.key, kind: p.kind, itemKey: p.itemKey, unitKey: p.unitKey, name: p.name, unit: p.unit || null, volume: null, vols: {}, files: [] }
        byKey.set(p.key, cur)
      }
      const v = num(p.volume)
      if (v != null) {
        cur.volume = round4((cur.volume ?? 0) + v)
        cur.vols[f.id] = round4((cur.vols[f.id] ?? 0) + v)
      } else if (!(f.id in cur.vols)) {
        cur.vols[f.id] = null
      }
      if (!cur.files.includes(f.id)) cur.files.push(f.id)
    }
    vors.push({ id: f.id, title: f.title, held: isHeld, items: { material: materials, work: works } })
  }
  const positions = [...byKey.values()]
  return {
    positions,
    byKey,
    vors,
    materials: positions.filter((p) => p.kind !== 'work'),
    works: positions.filter((p) => p.kind === 'work'),
  }
}

// Что изменилось в ведомости по сравнению с прежней версией (обе — позиции разбора одной ведомости). Сравнение — по виду и
// наименованию: та же позиция с другой ед. изм. — «ед. изм.», с другим объёмом — «объём», нет в прежней — «новая», нет в новой —
// «убрана». → { byKey: Map(ключ позиции → { op: added | volume | unit, oldVolume, oldUnit }), removed: [{ kind, key, name, unit,
// volume }], counts: { added, removed, volume, unit } }.
export function vorChanges(current, prior) {
  const group = (list) => {
    const m = new Map()
    for (const p of list || []) {
      if (!p?.key) continue
      const g = `${p.kind}|${p.itemKey}`
      let cur = m.get(g)
      if (!cur) m.set(g, (cur = new Map()))
      const prev = cur.get(p.unitKey)
      const v = num(p.volume)
      if (prev) prev.volume = prev.volume == null || v == null ? (prev.volume ?? v) : round4(prev.volume + v)
      else cur.set(p.unitKey, { kind: p.kind, key: p.key, name: p.name, unit: p.unit || null, volume: v })
    }
    return m
  }
  const now = group(current)
  const before = group(prior)
  const byKey = new Map()
  const removed = []
  const counts = { added: 0, removed: 0, volume: 0, unit: 0 }
  for (const [g, units] of now) {
    const old = before.get(g)
    for (const [unitKey, p] of units) {
      if (!old) { byKey.set(p.key, { op: 'added' }); counts.added += 1; continue }
      const same = old.get(unitKey)
      if (same) {
        if (!sameVolume(same.volume, p.volume)) { byKey.set(p.key, { op: 'volume', oldVolume: same.volume }); counts.volume += 1 }
        continue
      }
      const [first] = old.values()
      byKey.set(p.key, { op: 'unit', oldUnit: [...old.values()].map((x) => x.unit).filter(Boolean).join(', ') || null, oldVolume: old.size === 1 ? first.volume : null })
      counts.unit += 1
    }
  }
  for (const [g, units] of before) {
    if (now.has(g)) continue
    for (const p of units.values()) { removed.push(p); counts.removed += 1 }
  }
  return { byKey, removed, counts }
}

const emptyKind = () => ({ items: 0, priced: 0, total: 0 })

// Суммы по ведомостям и итог: цена позиции × её объём в этой ведомости. Позиция без цены — «не расценена» (итог неполный — жёлтым, как в
// «Сравнении КП»). → { rows: [{ id, title, held, material, work, total, incomplete }], total: { material, work, total, incomplete } }.
export function vorTotals(view, rates) {
  const rows = new Map(view.vors.map((v) => [v.id, { id: v.id, title: v.title, held: v.held, material: emptyKind(), work: emptyKind(), total: 0 }]))
  const grand = { material: emptyKind(), work: emptyKind(), total: 0 }
  for (const p of view.positions) {
    const kind = p.kind === 'work' ? 'work' : 'material'
    const price = rates.get(p.key)?.price ?? null
    grand[kind].items += 1
    if (price != null) grand[kind].priced += 1
    for (const id of p.files) {
      const row = rows.get(id)
      if (!row) continue
      row[kind].items += 1
      if (price == null) continue
      row[kind].priced += 1
      const sum = lineTotal(price, p.vols[id])
      if (sum != null) { row[kind].total += sum; grand[kind].total += sum }
    }
  }
  const finish = (r) => {
    r.material.total = roundMoney2(r.material.total)
    r.work.total = roundMoney2(r.work.total)
    r.total = roundMoney2(r.material.total + r.work.total)
    r.incomplete = r.material.priced < r.material.items || r.work.priced < r.work.items
    return r
  }
  return { rows: [...rows.values()].map(finish), total: finish(grand) }
}

// Цены снабжения по позициям материалов: prices — Map(`${itemKey}|${unitKey}` → цена) из bid_supply_prices. → Map(ключ позиции →
// цена снабжения).
export function supplyByPosition(materials, prices) {
  const out = new Map()
  if (!prices?.size) return out
  for (const p of materials) {
    const price = prices.get(`${p.itemKey}|${p.unitKey}`)
    if (price != null) out.set(p.key, price)
  }
  return out
}

// Цены без позиции (позицию убрали или переименовали в новой версии ВОР) → самая похожая позиция того же вида без цены, куда
// цену можно перенести (по похожести, как «похожие цены» снабжения). orphans: [[ключ, { price, name, kind, unit }]].
// → Map(ключ цены → позиция).
export function carryTargets(orphans, positions, rates) {
  const out = new Map()
  if (!orphans.length) return out
  const parts = new Map()
  const partsOf = (name) => { let x = parts.get(name); if (!x) parts.set(name, (x = nameParts(name))); return x }
  const free = positions.filter((p) => rates.get(p.key)?.price == null)
  for (const [key, r] of orphans) {
    if (!r?.name) continue
    const kind = key.split('|')[0]
    let best = null
    let bestScore = 0
    for (const p of free) {
      if (p.kind !== kind) continue
      const s = scoreParts(partsOf(r.name), partsOf(p.name))
      if (s.words >= WORDS_MIN && s.score >= SIMILAR_MIN && s.score > bestScore) { best = p; bestScore = s.score }
    }
    if (best) out.set(key, best)
  }
  return out
}
