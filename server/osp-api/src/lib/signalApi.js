// Адаптер протокола SIGNAL — единственное место, где известны пути и поля ответов (выжимка официальной
// спецификации: .local/osp-signal-impl/signal-openapi-digest.md). Разрешены ровно четыре операции чтения и токен:
//
//   const api = createSignalApi({ client })
//   await api.getToken()                                  // проверка входа; сам токен наружу не отдаётся
//   await api.listProjects({ skip, take })                // [{ id, name, code }]
//   await api.getFolderTree(projectId)                    // плоский список папок проекта в порядке обхода
//   await api.listItems(folderId, { skip, take })         // элементы папки (только непосредственные)
//   await api.searchItems(folderId, { modifiedFrom, skip, take })  // задел под выборку изменений; в MVP не вызывается
//
// Каждая операция принимает необязательный { signal } для отмены. Ответ проверяется по типам: идентификаторы —
// uuid, строки — не длиннее 500 знаков, children — массив; иное — SignalError('invalid'). Пагинация — Skip/Take:
// «следующий» адрес из ответа не читается и не используется. Результат — узлы раздела 5.2 спецификации
// (.local/OSP_SIGNAL_спецификация_реализации.md); поля, которые считает сама служба (границы, номера, наблюдаемость),
// добавляются позже, при записи.
import { SignalError } from './signalClient.js'

const V1 = '/public/v1'
export const SIGNAL_OPERATIONS = Object.freeze(['getToken', 'listProjects', 'getFolderTree', 'listItems', 'searchItems'])
export const SIGNAL_PAGE_MAX = 200
export const SIGNAL_API_LIMITS = Object.freeze({ nameChars: 500, treeNodes: 500_000, treeDepth: 200, skip: 10_000_000 })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Управляющие знаки в названии (в том числе NUL, который база не примет) заменяются пробелом.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g

const invalid = (what) => new SignalError('invalid', `SIGNAL: неверный ответ — ${what}`)
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function uuidOf(v, what) {
  if (typeof v !== 'string' || !UUID.test(v)) throw invalid(what)
  return v.toLowerCase()
}
function textOf(v, what) {
  if (typeof v !== 'string' || v.length > SIGNAL_API_LIMITS.nameChars) throw invalid(what)
  return v.replace(CONTROL, ' ').trim()
}
function optText(v, what) {
  if (v === undefined || v === null) return null
  return textOf(v, what)
}
function dateOf(v, what) {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw invalid(what)
  const t = Date.parse(v)
  if (!Number.isFinite(t)) throw invalid(what)
  return new Date(t).toISOString()
}

function pageArgs({ skip = 0, take = SIGNAL_PAGE_MAX } = {}) {
  if (!Number.isInteger(skip) || skip < 0 || skip > SIGNAL_API_LIMITS.skip) throw new SignalError('invalid', 'SIGNAL: Skip — целое число от 0')
  if (!Number.isInteger(take) || take < 1 || take > SIGNAL_PAGE_MAX) throw new SignalError('invalid', `SIGNAL: Take — целое число от 1 до ${SIGNAL_PAGE_MAX}`)
  return { skip, take }
}

export function normalizeProjects(data, take = SIGNAL_PAGE_MAX) {
  if (!Array.isArray(data) || data.length > take) throw invalid('список проектов')
  return data.map((p) => {
    if (!isObject(p)) throw invalid('проект')
    return { id: uuidOf(p.id, 'id проекта'), name: textOf(p.name, 'название проекта'), code: optText(p.code, 'код проекта') }
  })
}

// Дерево проекта: корень или массив корней → плоский список папок (родитель раньше детей). Обход без рекурсии:
// глубокое вложение не должно ронять службу. Повтор id, чужой тип поля, глубина и число узлов сверх предела — invalid.
export function normalizeTree(data, { maxNodes = SIGNAL_API_LIMITS.treeNodes, maxDepth = SIGNAL_API_LIMITS.treeDepth } = {}) {
  const roots = Array.isArray(data) ? data : [data]
  if (!roots.length || roots.some((r) => !isObject(r))) throw invalid('дерево папок')
  const out = []
  const seen = new Set()
  const stack = []
  for (let i = roots.length - 1; i >= 0; i--) stack.push({ raw: roots[i], parent: null })
  while (stack.length) {
    const { raw, parent } = stack.pop()
    if (!isObject(raw)) throw invalid('папка')
    const nodeId = uuidOf(raw.id, 'id папки')
    if (seen.has(nodeId)) throw invalid('повтор папки в дереве')
    if (out.length >= maxNodes) throw invalid('слишком много папок')
    seen.add(nodeId)
    const name = textOf(raw.name, 'название папки')
    const depth = parent ? parent.depth + 1 : 0
    if (depth > maxDepth) throw invalid('слишком глубокая вложенность')
    const children = raw.children === undefined || raw.children === null ? [] : raw.children
    if (!Array.isArray(children)) throw invalid('children — не массив')
    const node = {
      nodeId,
      kind: 'folder',
      parentId: parent ? parent.nodeId : null,
      name,
      path: parent ? `${parent.path} / ${name}` : name,
      pathIds: parent ? [...parent.pathIds, parent.nodeId] : [],
      depth,
      modifiedAt: dateOf(raw.modified, 'дата папки'),
      itemType: null,
      versionNumber: null,
      deleted: false,
    }
    out.push(node)
    for (let i = children.length - 1; i >= 0; i--) stack.push({ raw: children[i], parent: node })
  }
  return out
}

// Элемент: файл, ссылка, группа файлов, XML. Тип не сверяется со списком (SIGNAL может добавить новый), но это строка.
export function normalizeItem(raw, { folderId = null } = {}) {
  if (!isObject(raw)) throw invalid('элемент')
  let parentId = folderId
  if (raw.folderId !== undefined && raw.folderId !== null) parentId = uuidOf(raw.folderId, 'папка элемента')
  if (!parentId) throw invalid('у элемента нет папки')
  if (folderId && parentId !== folderId) throw invalid('элемент чужой папки')
  const version = raw.topVersionNumber
  if (version !== undefined && version !== null && (!Number.isInteger(version) || version < 0 || version > 2_147_483_647)) throw invalid('номер версии')
  if (raw.deleted !== undefined && raw.deleted !== null && typeof raw.deleted !== 'boolean') throw invalid('признак удаления')
  return {
    nodeId: uuidOf(raw.id, 'id элемента'),
    kind: 'item',
    parentId,
    name: textOf(raw.name, 'название элемента'),
    itemType: optText(raw.type, 'тип элемента'),
    modifiedAt: dateOf(raw.modified, 'дата элемента'),
    versionNumber: version ?? null,
    deleted: raw.deleted === true,
  }
}

export function normalizeItems(data, { folderId = null, take = SIGNAL_PAGE_MAX } = {}) {
  if (!Array.isArray(data) || data.length > take) throw invalid('список элементов')
  return data.map((raw) => normalizeItem(raw, { folderId }))
}

export function createSignalApi({ client }) {
  if (!client) throw new Error('signalApi: нужен клиент')
  const get = (path, query, signal) => client.request({ method: 'GET', path, query }, { signal })

  return {
    configured: client.configured,
    async getToken({ signal } = {}) {
      return client.ensureToken({ signal })
    },
    async listProjects(page = {}, { signal } = {}) {
      const { skip, take } = pageArgs({ take: 100, ...page })
      return normalizeProjects(await get(`${V1}/projects`, { Skip: skip, Take: take }, signal), take)
    },
    async getFolderTree(projectId, { signal } = {}) {
      const id = uuidOf(projectId, 'id проекта')
      return normalizeTree(await get(`${V1}/projects/${id}/folders/tree`, undefined, signal))
    },
    async listItems(folderId, page = {}, { signal } = {}) {
      const id = uuidOf(folderId, 'id папки')
      const { skip, take } = pageArgs(page)
      const data = await get(`${V1}/items`, { folderId: id, deleted: 'false', Skip: skip, Take: take }, signal)
      return normalizeItems(data, { folderId: id, take })
    },
    async searchItems(folderId, { modifiedFrom = null, ...page } = {}, { signal } = {}) {
      const id = uuidOf(folderId, 'id папки')
      const { skip, take } = pageArgs(page)
      const from = modifiedFrom === null ? null : dateOf(modifiedFrom instanceof Date ? modifiedFrom.toISOString() : modifiedFrom, 'modifiedFrom')
      const data = await client.request({
        method: 'POST', path: `${V1}/items/search`, query: { Skip: skip, Take: take }, body: { folderId: id, modifiedFrom: from },
      }, { signal })
      return normalizeItems(data, { take })
    },
  }
}
