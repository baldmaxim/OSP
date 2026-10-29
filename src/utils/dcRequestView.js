// Вид реестра «Заявок на ДС» переживает обновление страницы: вкладка, поиск, фильтры и раскрытые списки файлов
// лежат в sessionStorage вкладки браузера (новая вкладка открывает реестр как обычно), положение прокрутки — отдельным
// ключом (hooks/useScrollMemory.js). Хранилище недоступно (приватный режим, запрет) — реестр работает как раньше.
export const DC_VIEW_KEY = 'dcRequests:view:v1'
export const DC_SCROLL_KEY = 'dcRequests:scroll:v1'

// subResps — фильтр «Ответственный за статус ОКС» (id сотрудников, NO_SUBMISSION_RESP — не назначен).
const LISTS = ['statuses', 'objects', 'counterparties', 'responsibles', 'divisions', 'subResps', 'expanded']

export const EMPTY_DC_VIEW = Object.freeze({
  tab: 'all', search: '', statuses: [], objects: [], counterparties: [], responsibles: [], divisions: [], subResps: [],
  expanded: [],
})

export function sessionStore() {
  try { return window.sessionStorage } catch { return null }
}

const strings = (value) => (Array.isArray(value) ? value.filter(v => typeof v === 'string' && v) : [])

// Сохранённый вид; чужая вкладка (её больше нет) и испорченная запись — вид по умолчанию.
export function readDcView(storage = sessionStore(), tabKeys = null) {
  try {
    const raw = JSON.parse(storage?.getItem(DC_VIEW_KEY) || 'null')
    if (!raw || typeof raw !== 'object') return EMPTY_DC_VIEW
    const view = { ...EMPTY_DC_VIEW }
    if (typeof raw.tab === 'string' && (!tabKeys || tabKeys.includes(raw.tab))) view.tab = raw.tab
    if (typeof raw.search === 'string') view.search = raw.search
    for (const key of LISTS) view[key] = strings(raw[key])
    return view
  } catch {
    return EMPTY_DC_VIEW
  }
}

export function writeDcView(view, storage = sessionStore()) {
  try {
    const out = { tab: view.tab || 'all', search: view.search || '' }
    for (const key of LISTS) out[key] = strings(view[key])
    storage?.setItem(DC_VIEW_KEY, JSON.stringify(out))
  } catch { /* хранилище переполнено или закрыто — вид просто не запомнится */ }
}

// Файлы заявок списком из базы → Map<id заявки, файлы> в том же порядке.
export function groupDocsByRequest(rows) {
  const map = new Map()
  for (const d of rows || []) {
    const arr = map.get(d.owner_id) || []
    arr.push(d)
    map.set(d.owner_id, arr)
  }
  return map
}
