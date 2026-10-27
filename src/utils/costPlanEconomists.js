// Экономисты ОСП по объектам (cost_plan_economists, миграция 20261110): кто отвечает за планы затрат объекта.
// Чистые помощники — без запросов: сводка «экономист → объекты» для вкладки «Экономисты ОСП» и подстановка
// ответственного за план затрат в форму нового тендера. Запросы — services/costPlanEconomists.js.

export const COST_PLAN_ECONOMISTS_MIGRATION_HINT =
  'Экономисты ОСП по объектам появятся после обновления базы (миграция 20261110_cost_plan_economists).'

const byRu = (a, b) => String(a || '').localeCompare(String(b || ''), 'ru')
// Названия объектов в справочнике бывают с двойным пробелом («ЖК  ЗИЛ 33») — на экране одинарный.
export const objectLabel = (name) => String(name || '').replace(/\s+/g, ' ').trim() || '—'

// Map<object_id, contact_id> — кого подставлять в форму тендера по объекту.
export function economistByObject(rows = []) {
  const map = new Map()
  for (const r of rows) if (r?.object_id && r?.contact_id) map.set(r.object_id, r.contact_id)
  return map
}

// Сводка для вкладки: экономист → его объекты, плюс объекты основного строительства без экономиста.
// rows — строки cost_plan_economists со вложенным contacts; objects — [{ id, name, status }].
// → { groups: [{ contact, objects: [{ id, name }] }], unassigned: [{ id, name }] }
export function groupByEconomist(rows = [], objects = []) {
  const objectsById = new Map(objects.map(o => [o.id, o]))
  const groups = new Map()
  const assigned = new Set()
  for (const r of rows) {
    const contact = r.contacts || { id: r.contact_id, full_name: '' }
    if (!groups.has(r.contact_id)) groups.set(r.contact_id, { contact, objects: [] })
    const obj = objectsById.get(r.object_id)
    groups.get(r.contact_id).objects.push({ id: r.object_id, name: objectLabel(obj?.name) })
    assigned.add(r.object_id)
  }
  const list = [...groups.values()]
  for (const g of list) g.objects.sort((a, b) => byRu(a.name, b.name))
  // Больше объектов — выше; поровну — по ФИО.
  list.sort((a, b) => (b.objects.length - a.objects.length) || byRu(a.contact.full_name, b.contact.full_name))
  const unassigned = objects
    .filter(o => o.status === 'main_construction' && !assigned.has(o.id))
    .map(o => ({ id: o.id, name: objectLabel(o.name) }))
    .sort((a, b) => byRu(a.name, b.name))
  return { groups: list, unassigned }
}

// Ответственный за план затрат в форме НОВОГО тендера: экономист ОСП объекта, пока человек сам не выбрал
// другого (touched). У объекта нет экономиста — поле пустое (не назначен). current — что сейчас в поле.
export function pickCostPlanResponsible({ objectId, economists, current = '', touched = false }) {
  if (touched || !economists) return current
  return (objectId && economists.get(objectId)) || ''
}

// Сотрудники для выбора экономиста: без повторов ФИО (в справочнике есть двойники с разными id — оставляем
// уже назначенного), сначала отдел ОСП. → { osp: [...], others: [...] }
export function economistOptions(contacts = [], keepIds = []) {
  const keep = new Set(keepIds.filter(Boolean))
  const seen = new Map()
  for (const c of contacts) {
    const key = String(c.full_name || '').trim().toLowerCase()
    if (!key) continue
    const prev = seen.get(key)
    if (!prev || (keep.has(c.id) && !keep.has(prev.id))) seen.set(key, c)
  }
  const list = [...seen.values()]
  // Назначенный двойник, которого вытеснил другой с тем же ФИО, всё равно должен остаться в списке.
  for (const c of contacts) if (keep.has(c.id) && !list.includes(c)) list.push(c)
  list.sort((a, b) => byRu(a.full_name, b.full_name))
  const isOsp = (c) => c.departments?.name === 'ОСП' || String(c.position || '').includes('ОСП')
  return { osp: list.filter(isOsp), others: list.filter(c => !isOsp(c)) }
}
