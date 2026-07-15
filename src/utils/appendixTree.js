// Иерархия приложений (2 уровня: №1 → подпункт №1.1) для двух таблиц:
//   contract_appendices          (numberField = 'appendix_number')
//   object_contract_attachments  (numberField = 'number_label')
//
// Строки хранятся плоско: parent_id (NULL = верхний уровень) + sort_order (порядок
// среди соседей одного уровня). Номера считаются здесь автоматически; number_manual=true
// означает ручной override, который берётся из numberField.

const SIBLING_STEP = 10 // шаг sort_order — запас под ручные вставки без перенумерации соседей

// Сортировка соседей: по sort_order, при равенстве — по created_at (стабильность).
function bySortOrder(a, b) {
  const o = (a.sort_order || 0) - (b.sort_order || 0)
  if (o !== 0) return o
  return String(a.created_at || '').localeCompare(String(b.created_at || ''))
}

/**
 * Разворачивает плоский список строк в упорядоченное дерево 2 уровней.
 * @returns {Array<{row, level, autoNumber, displayNumber, hasChildren, parentId,
 *                  isFirstTopLevel, prevTopLevelId}>}
 *   Порядок выдачи: родитель, затем его дети, затем следующий родитель.
 */
export function buildAppendixTree(rows, { numberField } = {}) {
  const list = Array.isArray(rows) ? rows : []
  const tops = list.filter(r => !r.parent_id).sort(bySortOrder)
  const childrenByParent = new Map()
  for (const r of list) {
    if (!r.parent_id) continue
    if (!childrenByParent.has(r.parent_id)) childrenByParent.set(r.parent_id, [])
    childrenByParent.get(r.parent_id).push(r)
  }
  for (const arr of childrenByParent.values()) arr.sort(bySortOrder)

  const out = []
  tops.forEach((top, ti) => {
    const autoNumber = String(ti + 1)
    const kids = childrenByParent.get(top.id) || []
    out.push({
      row: top,
      level: 0,
      autoNumber,
      displayNumber: displayNumberOf(top, autoNumber, numberField),
      hasChildren: kids.length > 0,
      parentId: null,
      isFirstTopLevel: ti === 0,
      prevTopLevelId: ti > 0 ? tops[ti - 1].id : null,
    })
    kids.forEach((kid, ki) => {
      const kidAuto = `${autoNumber}.${ki + 1}`
      out.push({
        row: kid,
        level: 1,
        autoNumber: kidAuto,
        displayNumber: displayNumberOf(kid, kidAuto, numberField),
        hasChildren: false,
        parentId: top.id,
        isFirstTopLevel: false,
        prevTopLevelId: null,
      })
    })
  })
  return out
}

function displayNumberOf(row, autoNumber, numberField) {
  if (row.number_manual && numberField && (row[numberField] ?? '') !== '') {
    return String(row[numberField])
  }
  return autoNumber
}

// Соседи строки (тот же parent_id), отсортированные по порядку.
export function siblingsOf(rows, row) {
  const pid = row.parent_id || null
  return (rows || [])
    .filter(r => (r.parent_id || null) === pid)
    .sort(bySortOrder)
}

/**
 * Переставляет draggedId относительно targetId ВНУТРИ одной группы соседей.
 * @returns {Array<{id, sort_order}>|null} пары для персиста, либо null если перестановка
 *   невозможна (разные уровни / не найдено / та же позиция).
 */
export function reorderSiblings(rows, draggedId, targetId, position) {
  if (!draggedId || draggedId === targetId) return null
  const dragged = (rows || []).find(r => r.id === draggedId)
  const target = (rows || []).find(r => r.id === targetId)
  if (!dragged || !target) return null
  // Перетаскивание только внутри одного уровня (одна группа parent_id).
  if ((dragged.parent_id || null) !== (target.parent_id || null)) return null

  const group = siblingsOf(rows, dragged)
  const fromIdx = group.findIndex(r => r.id === draggedId)
  if (fromIdx === -1) return null
  const [moved] = group.splice(fromIdx, 1)
  let toIdx = group.findIndex(r => r.id === targetId)
  if (toIdx === -1) return null
  if (position === 'after') toIdx += 1
  group.splice(toIdx, 0, moved)

  return group.map((r, idx) => ({ id: r.id, sort_order: (idx + 1) * SIBLING_STEP }))
}

// Следующий sort_order для добавления строки в группу (конец группы).
export function nextSortOrder(rows, parentId) {
  const pid = parentId || null
  const group = (rows || []).filter(r => (r.parent_id || null) === pid)
  const max = group.reduce((m, r) => Math.max(m, r.sort_order || 0), 0)
  return max + SIBLING_STEP
}

/**
 * Вложить строку (сделать подпунктом предыдущего приложения верхнего уровня).
 * @returns {Array<{id, parent_id, sort_order}>|null} обновления для персиста.
 */
export function indentUpdates(rows, rowId) {
  const tree = buildAppendixTree(rows, {})
  const node = tree.find(n => n.row.id === rowId)
  if (!node) return null
  // Вкладывать можно только верхний уровень, не первый и без своих детей (жёстко 2 уровня).
  if (node.level !== 0 || node.isFirstTopLevel || node.hasChildren || !node.prevTopLevelId) return null
  const newParentId = node.prevTopLevelId
  return [{ id: rowId, parent_id: newParentId, sort_order: nextSortOrder(rows, newParentId) }]
}

/**
 * Поднять подпункт на верхний уровень, поставив сразу после группы бывшего родителя.
 * @returns {Array<{id, parent_id, sort_order}>|null} обновления для персиста
 *   (перенумеровывает весь верхний уровень, чтобы вставить строку в нужное место).
 */
export function outdentUpdates(rows, rowId) {
  const row = (rows || []).find(r => r.id === rowId)
  if (!row || !row.parent_id) return null
  const parentId = row.parent_id
  const tops = (rows || []).filter(r => !r.parent_id).sort(bySortOrder)
  const parentIdx = tops.findIndex(r => r.id === parentId)
  const insertAt = parentIdx === -1 ? tops.length : parentIdx + 1
  const newTops = [...tops]
  newTops.splice(insertAt, 0, row) // строка встаёт сразу после бывшего родителя
  return newTops.map((r, idx) => ({
    id: r.id,
    parent_id: null,
    sort_order: (idx + 1) * SIBLING_STEP,
  }))
}
