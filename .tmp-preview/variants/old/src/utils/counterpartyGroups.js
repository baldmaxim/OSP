// Группы связанных контрагентов (одна компания под разными юрлицами).
//
// В таблице counterparty_relations связь хранится ПАРОЙ. Раньше пары и
// показывались: у «Эвереста», которому добавили Букрина и Мельникова, видны
// оба, а у Мельникова — только «Эверест», Букрин пропадал. По смыслу связь
// транзитивна: если A связан с B, а B с C — это одна группа, и каждый её участник
// должен видеть всех остальных.
//
// Поэтому пары читаются как рёбра графа, а группа — компонента связности. Схема
// БД не меняется, старые данные сразу показываются группами.
//
// Чистые функции без Supabase — их проверяет тест.

// Map<counterpartyId, Set<counterpartyId>> — все участники группы, включая самого.
// Контрагенты без связей в карту не попадают.
export function buildRelationGroups(relations = []) {
  const parent = new Map()
  const find = (x) => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)
    // Сжатие пути: следующие поиски — за один шаг.
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  const add = (x) => { if (!parent.has(x)) parent.set(x, x) }
  for (const r of relations) {
    const a = r.counterparty_id
    const b = r.related_counterparty_id
    if (!a || !b || a === b) continue
    add(a); add(b)
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  const byRoot = new Map()
  for (const id of parent.keys()) {
    const root = find(id)
    if (!byRoot.has(root)) byRoot.set(root, new Set())
    byRoot.get(root).add(id)
  }
  const groups = new Map()
  for (const members of byRoot.values()) {
    for (const id of members) groups.set(id, members)
  }
  return groups
}

// Остальные участники группы (без самого контрагента).
export function groupMatesOf(groups, counterpartyId) {
  const members = groups.get(counterpartyId)
  if (!members) return []
  return [...members].filter((id) => id !== counterpartyId)
}

// План исключения removeId из группы.
//
// Мало удалить прямую пару «открытый контрагент — removeId»: removeId может быть
// связан с группой через третьего (у Мельникова Букрин виден через «Эверест»,
// прямой пары нет). Поэтому удаляются ВСЕ пары removeId внутри группы.
//
// Но removeId мог быть «мостом»: если группа держалась на нём (A—X—B), без его пар
// A и B распались бы. Оставшиеся части сшиваем новыми парами с anchorId (тем,
// из чьей карточки удаляют), чтобы исключение одного не разваливало группу.
//
// → { deleteIds: id пар для удаления, insertPairs: [{counterparty_id, related_counterparty_id}] }
export function planRemoveFromGroup(relations, removeId, anchorId) {
  const groups = buildRelationGroups(relations)
  const members = groups.get(removeId)
  if (!members) return { deleteIds: [], insertPairs: [] }

  const deleteIds = relations
    .filter((r) => r.counterparty_id === removeId || r.related_counterparty_id === removeId)
    .map((r) => r.id)
    .filter(Boolean)

  const remaining = [...members].filter((id) => id !== removeId)
  if (remaining.length < 2) return { deleteIds, insertPairs: [] }

  const remainingSet = new Set(remaining)
  const kept = relations.filter((r) =>
    r.counterparty_id !== removeId && r.related_counterparty_id !== removeId
    && remainingSet.has(r.counterparty_id) && remainingSet.has(r.related_counterparty_id))
  const parts = buildRelationGroups(kept)

  const anchor = remainingSet.has(anchorId) ? anchorId : remaining[0]
  const anchorPart = parts.get(anchor) || new Set([anchor])
  const insertPairs = []
  const linked = new Set(anchorPart)
  for (const id of remaining) {
    if (linked.has(id)) continue
    insertPairs.push({ counterparty_id: anchor, related_counterparty_id: id })
    for (const m of parts.get(id) || [id]) linked.add(m)
  }
  return { deleteIds, insertPairs }
}
