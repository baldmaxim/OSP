// «Общая информация» → «Отделы» (миграция 20261104_company_departments): помощники без обращения к серверу —
// группировка по блокам, поиск, телефоны, перестановка и разбор списка руководителей.

export const DEPARTMENTS_MIGRATION_HINT =
  'Раздел появится после обновления базы (миграция 20261104_company_departments).'

export const MAX_CONTACTS = 20

/** Номер отдела — сквозной по всему списку, как в исходной таблице; поиск его не меняет. */
export const numberDepartments = (rows) => (rows || []).map((row, idx) => ({ ...row, number: idx + 1 }))

/** Отделы по блокам в порядке sort_order (у пронумерованных номер сохраняется). */
export function groupDepartments(rows) {
  const groups = []
  const byBlock = new Map()
  ;(rows || []).forEach((row, idx) => {
    const block = row.block || 'Прочее'
    let g = byBlock.get(block)
    if (!g) {
      g = { block, items: [] }
      byBlock.set(block, g)
      groups.push(g)
    }
    g.items.push({ ...row, number: row.number ?? idx + 1 })
  })
  return groups
}

const norm = (v) => String(v ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
const digits = (v) => String(v ?? '').replace(/\D/g, '')

/** Поиск по отделу, блоку, функциям, ФИО, должности и телефону (в телефоне — по цифрам). */
export function matchesDepartment(row, query) {
  const q = norm(query)
  if (!q) return true
  const qDigits = digits(query)
  const words = q.split(' ')
  const text = norm([row.block, row.name, row.duties, row.note,
    ...(row.contacts || []).flatMap(c => [c.name, c.position, c.phone])].join(' '))
  if (words.every(w => text.includes(w))) return true
  return qDigits.length >= 4 && (row.contacts || []).some(c => digits(c.phone).includes(qDigits))
}

/** Российский номер — «+7 900 712-25-46»; иное (добавочный, короткий) — как ввели. */
export function formatPhone(raw) {
  const s = String(raw ?? '').trim()
  if (/[a-zа-я]/i.test(s)) return s
  let d = digits(s)
  if (d.length === 11 && (d[0] === '7' || d[0] === '8')) d = d.slice(1)
  else if (d.length !== 10) return s
  return `+7 ${d.slice(0, 3)} ${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8, 10)}`
}

/** Ссылка для звонка: tel:+79007122546; не номер — null. */
export function phoneHref(raw) {
  let d = digits(raw)
  if (d.length < 5) return null
  if (d.length === 11 && d[0] === '8') d = `7${d.slice(1)}`
  if (d.length === 10) d = `7${d}`
  return `tel:+${d}`
}

/** Контакты к записи: три поля без пробелов по краям, без пустых строк. */
export function cleanContacts(list) {
  return (list || [])
    .map(c => ({
      name: String(c?.name ?? '').trim(),
      position: String(c?.position ?? '').trim(),
      phone: formatPhone(c?.phone),
    }))
    .filter(c => c.name || c.phone)
    .slice(0, MAX_CONTACTS)
}

/**
 * Сдвиг отдела на delta мест (−1 — выше, +1 — ниже). rows — в порядке показа.
 * → правки sort_order [{ id, sort_order }] только у тех, чей номер изменился; двигать некуда — null.
 * Номера пересчитываются шагом 10, как в начальном списке.
 */
export function moveDepartment(rows, id, delta) {
  const from = rows.findIndex(r => r.id === id)
  const to = from + delta
  if (from === -1 || to < 0 || to >= rows.length) return null
  const order = [...rows]
  const [moved] = order.splice(from, 1)
  order.splice(to, 0, moved)
  return order
    .map((r, idx) => ({ id: r.id, sort_order: (idx + 1) * 10, was: r.sort_order }))
    .filter(r => r.sort_order !== r.was)
    .map(({ id: rid, sort_order }) => ({ id: rid, sort_order }))
}

const looksLikePhone = (v) => digits(v).length >= 7 && !/[a-zа-я]{3,}/i.test(String(v))

/**
 * Руководители списком — по строке на человека:
 *   «№ отдела | ФИО | должность | телефон» (разделитель — «|» или табуляция, как при копировании из Excel).
 * Отдел — номер на странице или название целиком. Должность и телефон можно не писать; в строке из трёх
 * полей третье — телефон, если похоже на номер. Пустые строки и строки с «#» в начале пропускаются.
 * → { updates: Map<id отдела, контакты>, lines: [{ line, department, contact }], errors: [{ line, text, reason }] }
 * Отдел, упомянутый в списке, получает ровно перечисленные контакты; остальные не меняются.
 */
export function parseContactsList(text, departments) {
  const byNumber = new Map((departments || []).map((d, idx) => [idx + 1, d]))
  const byName = new Map((departments || []).map(d => [norm(d.name), d]))
  const updates = new Map()
  const lines = []
  const errors = []
  String(text ?? '').split(/\r?\n/).forEach((raw, idx) => {
    const line = idx + 1
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const parts = raw.split(/\t|\|/).map(p => p.trim())
    const ref = parts[0].replace(/[.)]$/, '')
    const department = /^\d+$/.test(ref) ? byNumber.get(Number(ref)) : byName.get(norm(ref))
    if (!department) {
      errors.push({ line, text: trimmed, reason: /^\d+$/.test(ref) ? `нет отдела № ${ref}` : `нет отдела «${ref}»` })
      return
    }
    let [, name = '', position = '', phone = ''] = parts
    if (parts.length === 3 && looksLikePhone(position)) {
      phone = position
      position = ''
    }
    if (!name && !phone) {
      errors.push({ line, text: trimmed, reason: 'нет ни ФИО, ни телефона' })
      return
    }
    const contact = cleanContacts([{ name, position, phone }])[0]
    const list = updates.get(department.id) || []
    if (list.length >= MAX_CONTACTS) {
      errors.push({ line, text: trimmed, reason: `у отдела больше ${MAX_CONTACTS} контактов` })
      return
    }
    list.push(contact)
    updates.set(department.id, list)
    lines.push({ line, department, contact })
  })
  return { updates, lines, errors }
}
