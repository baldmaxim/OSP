// task 434: дерево папок раздела «Общая информация» → «Документы».
//
// Две плоские таблицы:
//   general_document_folders  — папки (category + parent_id, NULL = корень подгруппы)
//   general_documents         — карточки (category + folder_id, NULL = корень подгруппы)
//
// Навигация в UI — как в Проводнике: показывается содержимое ОДНОЙ папки,
// поэтому здесь нет «разворачивания дерева в плоский список» (в отличие от
// appendixTree.js) — только выборка соседей, путь до корня и обход поддерева.
//
// Все обходы cycle-safe (visited Set): триггер в БД циклы не пропускает, но
// битые данные не должны вешать рендер намертво.

export const FOLDER_STEP = 10 // шаг sort_order — запас под вставки без перенумерации

// Сортировка соседей: sort_order, при равенстве — created_at (стабильность).
// NULL уходит в конец — так же, как это делал запрос с nullsFirst: false,
// иначе порядок уже существующих документов разово перетасовался бы.
function orderOf(x) {
  return x.sort_order == null ? Number.POSITIVE_INFINITY : x.sort_order
}

function byOrder(a, b) {
  const o = orderOf(a) - orderOf(b)
  if (o !== 0) return o
  return String(a.created_at || '').localeCompare(String(b.created_at || ''))
}

const sameId = (a, b) => (a || null) === (b || null)

/** Дочерние папки указанной папки (parentId=null — корень подгруппы). */
export function foldersIn(folders, category, parentId) {
  return (folders || [])
    .filter(f => (f.category || 'general') === category && sameId(f.parent_id, parentId))
    .sort(byOrder)
}

/** Карточки документов, лежащие непосредственно в указанной папке. */
export function docsIn(documents, category, folderId) {
  return (documents || [])
    .filter(d => (d.category || 'general') === category && sameId(d.folder_id, folderId))
    .sort(byOrder)
}

/**
 * Путь от корня подгруппы до папки: [корневая, ..., сама папка].
 * Пустой массив, если folderId не задан или папка не найдена.
 */
export function folderPathOf(folders, folderId) {
  const byId = new Map((folders || []).map(f => [f.id, f]))
  const chain = []
  const visited = new Set()
  let cur = folderId || null
  while (cur && !visited.has(cur)) {
    visited.add(cur)
    const node = byId.get(cur)
    if (!node) break
    chain.push(node)
    cur = node.parent_id || null
  }
  return chain.reverse()
}

/** Человекочитаемый путь: «Юристы / Договоры / 2026». */
export function folderPathLabel(folders, folderId, rootLabel = '') {
  const names = folderPathOf(folders, folderId).map(f => f.name)
  return [rootLabel, ...names].filter(Boolean).join(' / ')
}

/** Идентификаторы всего поддерева, включая саму папку. */
export function collectFolderIds(folders, rootId) {
  const result = new Set()
  if (!rootId) return result
  const childrenByParent = new Map()
  for (const f of folders || []) {
    const key = f.parent_id || null
    if (!childrenByParent.has(key)) childrenByParent.set(key, [])
    childrenByParent.get(key).push(f)
  }
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()
    if (result.has(id)) continue
    result.add(id)
    for (const child of childrenByParent.get(id) || []) stack.push(child.id)
  }
  return result
}

/**
 * Сколько всего внутри папки, включая вложенные уровни.
 * Используется для бейджа строки и для запрета удаления непустой папки.
 */
export function subtreeCounts(folders, documents, folderId) {
  const ids = collectFolderIds(folders, folderId)
  const docs = (documents || []).filter(d => d.folder_id && ids.has(d.folder_id)).length
  return { folders: Math.max(0, ids.size - 1), docs }
}

/**
 * Плоский список папок подгруппы для <select> — с отступами по уровню.
 * excludeIds — какие папки (и их потомков) не показывать: при переносе папки
 * это она сама и всё её поддерево, иначе получился бы цикл.
 * @returns {Array<{id, label, depth}>}
 */
export function folderOptions(folders, category, { excludeIds } = {}) {
  const skip = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || [])
  const out = []
  const walk = (parentId, depth) => {
    for (const f of foldersIn(folders, category, parentId)) {
      if (skip.has(f.id)) continue
      out.push({ id: f.id, label: `${'— '.repeat(depth)}${f.name}`, depth })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

function nextOrder(items) {
  const max = items.reduce((m, x) => (x.sort_order != null && x.sort_order > m ? x.sort_order : m), 0)
  return max + FOLDER_STEP
}

/** Следующий sort_order для новой папки в конец группы соседей. */
export function nextFolderOrder(folders, category, parentId) {
  return nextOrder(foldersIn(folders, category, parentId))
}

/** Следующий sort_order для новой карточки в конец папки. */
export function nextDocOrder(documents, category, folderId) {
  return nextOrder(docsIn(documents, category, folderId))
}

/**
 * Поиск по всей подгруппе, независимо от текущей папки: пользователь не знает,
 * в какой папке лежит документ. Каждому элементу приписывается __path —
 * путь до его папки (для подписи под названием).
 * @param matchDoc (doc, query) => boolean — предикат совпадения карточки
 * @returns {{folders: Array, docs: Array}}
 */
export function searchInCategory(folders, documents, category, query, matchDoc) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return { folders: [], docs: [] }

  const inCat = (x) => (x.category || 'general') === category

  const foundFolders = (folders || [])
    .filter(f => inCat(f) && String(f.name || '').toLowerCase().includes(q))
    .sort(byOrder)
    .map(f => ({ ...f, __path: folderPathLabel(folders, f.parent_id) }))

  const foundDocs = (documents || [])
    .filter(d => inCat(d) && matchDoc(d, q))
    .sort(byOrder)
    .map(d => ({ ...d, __path: folderPathLabel(folders, d.folder_id) }))

  return { folders: foundFolders, docs: foundDocs }
}
