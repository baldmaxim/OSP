// Документы карточки объекта (object_documents, вкладка «Документы»): порядок, вложенность приложений и куда встаёт
// перетаскиваемая строка. Строки хранятся плоско: parent_document_id (NULL — договор или ДС) + order_number (порядок
// среди соседей). Чистые функции — проверяются без браузера (tests/tender/object-doc-tree.test.mjs).

// Приложения — не глубже двух уровней: приложение к документу (1) и приложение к приложению (2). К приложению второго
// уровня своё приложение не добавляется (просьба пользователя 26.11.2026). Строки глубже, заведённые раньше, остаются
// на экране: их можно открыть, исправить и удалить.
export const MAX_ATTACHMENT_LEVEL = 2

// Шаг order_number: запас под будущие вставки без перенумерации соседей.
export const ORDER_STEP = 10

// Порядок соседей: order_number, при равенстве — дата создания, затем id (устойчиво при одинаковых датах).
export function byDocOrder(a, b) {
  const o = (a.order_number || 0) - (b.order_number || 0)
  if (o !== 0) return o
  const c = String(a.created_at || '').localeCompare(String(b.created_at || ''))
  if (c !== 0) return c
  return String(a.id).localeCompare(String(b.id))
}

const parentOf = (doc) => doc?.parent_document_id || null

// Соседи — строки одного родителя. Наверху у договора и ДС свои таблицы, поэтому там соседи ещё и одного типа.
function sameGroup(a, b) {
  if (parentOf(a) !== parentOf(b)) return false
  return parentOf(a) ? true : a.document_type === b.document_type
}

export function siblingsOf(docs, doc) {
  return (docs || []).filter((d) => sameGroup(d, doc)).sort(byDocOrder)
}

// Уровень строки: 0 — договор или ДС, 1 — приложение, 2 — приложение к приложению. Петля в данных не зацикливает.
export function docLevel(docs, id) {
  const byId = new Map((docs || []).map((d) => [d.id, d]))
  let level = 0
  let cur = byId.get(id)
  const seen = new Set()
  while (cur && parentOf(cur) && !seen.has(cur.id)) {
    seen.add(cur.id)
    level += 1
    cur = byId.get(parentOf(cur))
  }
  return level
}

// Можно ли добавить приложение к строке уровня level.
export const canAddAttachmentAtLevel = (level) => level < MAX_ATTACHMENT_LEVEL

// order_number новой строки — в конец своей группы. Раньше бралось «число документов объекта + 1»: после перетаскивания
// соседи получают 10, 20, 30…, и новое приложение вставало в начало или в середину списка.
export function nextOrderNumber(docs, parentId, documentType) {
  const probe = { id: null, parent_document_id: parentId || null, document_type: documentType }
  const max = (docs || []).filter((d) => sameGroup(d, probe)).reduce((m, d) => Math.max(m, d.order_number || 0), 0)
  return max + ORDER_STEP
}

/**
 * Куда встанет перетаскиваемая строка, если отпустить её над строкой overId. Ответ — сосед перетаскиваемой строки
 * (overId сам или его предок) и inside: строка под курсором лежит внутри блока этого соседа (его приложение). Блок
 * целиком — «после соседа». null — сюда нельзя: над собой, над своим приложением или в чужой группе (у приложения
 * другого документа; родитель меняется в форме, не перетаскиванием).
 */
export function resolveDropTarget(docs, draggedId, overId) {
  const byId = new Map((docs || []).map((d) => [d.id, d]))
  const dragged = byId.get(draggedId)
  if (!dragged) return null
  let node = byId.get(overId)
  let inside = false
  const seen = new Set()
  while (node && !seen.has(node.id)) {
    seen.add(node.id)
    if (node.id === draggedId) return null
    if (sameGroup(node, dragged)) return { id: node.id, inside }
    inside = true
    node = byId.get(parentOf(node))
  }
  return null
}

/**
 * Новый порядок группы после перестановки draggedId перед/после targetId.
 * @returns {Array<{id, order_number}>|null} только строки, у которых order_number меняется; null — переставлять нечего.
 */
export function reorderUpdates(docs, draggedId, targetId, position) {
  if (!draggedId || draggedId === targetId) return null
  const dragged = (docs || []).find((d) => d.id === draggedId)
  const target = (docs || []).find((d) => d.id === targetId)
  if (!dragged || !target || !sameGroup(dragged, target)) return null
  const original = siblingsOf(docs, dragged)
  const group = [...original]
  const [moved] = group.splice(group.findIndex((d) => d.id === draggedId), 1)
  let to = group.findIndex((d) => d.id === targetId)
  if (position === 'after') to += 1
  group.splice(to, 0, moved)
  if (group.every((d, i) => d.id === original[i].id)) return null
  return group
    .map((d, i) => ({ id: d.id, order_number: (i + 1) * ORDER_STEP, before: d.order_number || 0 }))
    .filter((u) => u.order_number !== u.before)
    .map(({ id, order_number }) => ({ id, order_number }))
}

// Сосед сверху/снизу — для перестановки с клавиатуры (↑ / ↓ на ручке).
export function neighbourOf(docs, id, dir) {
  const doc = (docs || []).find((d) => d.id === id)
  if (!doc) return null
  const group = siblingsOf(docs, doc)
  const i = group.findIndex((d) => d.id === id)
  return group[i + dir] || null
}

// id строки и всех её приложений (любой глубины) — блок, который едет вместе с ней.
export function blockIds(docs, rootId) {
  const out = new Set()
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()
    if (out.has(id)) continue
    out.add(id)
    for (const d of docs || []) if (parentOf(d) === id) stack.push(d.id)
  }
  return out
}
