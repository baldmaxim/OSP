// Поиск в реестре контрагентов (/general/counterparties). 29.10.2026: «проматомстрой» не находил «ООО Пром Атом
// Строй (ПАС)» — поиск искал набранное буквально, вместе с пробелами, кавычками и дефисами. Теперь:
//  • регистр, ё / е, й / и, пробелы, кавычки, дефисы, точки и скобки не важны — ни в карточке, ни в запросе
//    («проматомстрой» = «Пром Атом Строй» = «Пром-Атом-Строй» = «ПромАтомСтрой»);
//  • латинские буквы, похожие на русские (A, B, C, E, H, K, M, O, P, T, X, Y), считаются русскими: в названиях
//    бывает «OOO» или «CK» латиницей;
//  • слова запроса — в любом порядке и в любых полях («атом пром», «ооо проматомстрой» при «ПромАтомСтрой, ООО»,
//    «сапаров фасад» — контакт и вид работ);
//  • телефон — цифрами, с 8 или 7 в начале («89104614571» = «+7(910)461-45-71»);
//  • ничего не нашлось — запрос в другой раскладке («ghjvfnjv» = «проматом»), затем названия и ФИО контактов
//    с опечатками (одна на 6–9 букв, две — от 10: «праматомстрой»); чем заменён запрос — пишет страница.
// Поля карточки разделены переводом строки: совпадение не склеивается из конца одного поля и начала другого.
import { splitPhoneExt } from './phoneFormat.js'

const LATIN_AS_CYRILLIC = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' }

// Ключ поиска: только буквы и цифры, строчные, ё = е, й = и, латиница, похожая на кириллицу, — кириллицей.
export const searchKey = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/ё/g, 'е')
  .replace(/й/g, 'и')
  .replace(/[^\p{L}\p{N}]+/gu, '')
  .replace(/[abcehkmoptxy]/g, (ch) => LATIN_AS_CYRILLIC[ch])

// Клавиши: латинская раскладка ↔ русская (ЙЦУКЕН).
const EN_KEYS = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`"
const RU_KEYS = 'йцукенгшщзхъфывапролджэячсмитьбюё'
const EN_TO_RU = { '{': 'х', '}': 'ъ', ':': 'ж', '"': 'э', '<': 'б', '>': 'ю', '~': 'ё' }
const RU_TO_EN = {}
for (let i = 0; i < EN_KEYS.length; i++) {
  EN_TO_RU[EN_KEYS[i]] = RU_KEYS[i]
  RU_TO_EN[RU_KEYS[i]] = EN_KEYS[i]
}

// Тот же набор клавиш в другой раскладке: «ghjvfnjv» → «проматом», «ыщаашеех» → «soffitti».
export const switchLayout = (value) => Array.from(String(value ?? '').toLowerCase(), (ch) => EN_TO_RU[ch] ?? RU_TO_EN[ch] ?? ch).join('')

// Телефоны контакта — через «;»: каждый номер отдельно и ещё с 7 и с 8 в начале (добавочный — не часть номера).
function phoneKeys(phone) {
  const keys = []
  for (const part of String(phone ?? '').split(';')) {
    keys.push(part)
    const digits = splitPhoneExt(part).number.replace(/\D/g, '')
    if (/^[78]\d{10}$/.test(digits)) keys.push(`7${digits.slice(1)}`, `8${digits.slice(1)}`)
  }
  return keys
}

// Что ищется у контрагента — один раз на загрузку списка: text — все поля карточки и контактов, names — название
// и ФИО контактов (для поиска с опечатками).
export function counterpartySearchIndex(cp) {
  const fields = [cp.name, cp.work_type, cp.inn, cp.kpp, cp.legal_address, cp.actual_address, cp.website, cp.notes]
  const names = [cp.name]
  for (const ct of cp.counterparty_contacts || []) {
    fields.push(ct.full_name, ct.position, ct.email, ...phoneKeys(ct.phone))
    names.push(ct.full_name)
  }
  return {
    text: fields.map(searchKey).filter(Boolean).join('\n'),
    names: names.map(searchKey).filter(Boolean),
  }
}

// Совпадение: запрос целиком (без пробелов) — в одном поле, или каждое слово запроса — в каком-нибудь поле.
function textMatcher(query) {
  const whole = searchKey(query)
  if (!whole) return null
  const words = String(query ?? '').split(/\s+/).map(searchKey).filter(Boolean)
  return (text) => text.includes(whole) || (words.length > 1 && words.every((w) => text.includes(w)))
}

// Сколько опечаток допускается: короткий запрос — только точно, иначе к нему подходили бы чужие названия
// («сибур» с одной опечаткой — в «Мосбурстрое»).
const typoLimit = (length) => (length >= 10 ? 2 : length >= 6 ? 1 : 0)

// Наименьшее число опечаток (буква заменена, лишняя, пропущена, две соседние переставлены), с которым запрос
// входит в текст: «праматомстрой» в «ооопроматомстройпас» — 1.
export function typoDistance(query, text) {
  const m = query.length
  let before = null
  let prev = Array.from({ length: m + 1 }, (_, i) => i)
  let best = prev[m]
  for (let j = 0; j < text.length; j++) {
    const cur = new Array(m + 1)
    cur[0] = 0
    for (let i = 1; i <= m; i++) {
      let d = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (query[i - 1] === text[j] ? 0 : 1))
      if (before && i > 1 && query[i - 1] === text[j - 1] && query[i - 2] === text[j]) d = Math.min(d, before[i - 2] + 1)
      cur[i] = d
    }
    if (cur[m] < best) best = cur[m]
    before = prev
    prev = cur
  }
  return best
}

// Поиск по уже отобранному списку, порядок сохраняется (с опечатками — сначала ближайшие).
// fix: null — найдено как набрано; { kind: 'layout', query } — в другой раскладке; { kind: 'typo' } — с опечатками.
export function searchCounterparties(list, query, indexOf) {
  const match = textMatcher(query)
  if (!match) return { items: list, fix: null }
  const found = list.filter((cp) => match(indexOf(cp).text))
  if (found.length) return { items: found, fix: null }

  const switched = switchLayout(query).trim()
  const matchSwitched = searchKey(switched) !== searchKey(query) && textMatcher(switched)
  if (matchSwitched) {
    const items = list.filter((cp) => matchSwitched(indexOf(cp).text))
    if (items.length) return { items, fix: { kind: 'layout', query: switched } }
  }

  const key = searchKey(query)
  const limit = typoLimit(key.length)
  if (!limit) return { items: [], fix: null }
  const near = []
  for (const cp of list) {
    const distance = Math.min(...indexOf(cp).names.map((name) => typoDistance(key, name)))
    if (distance <= limit) near.push({ cp, distance })
  }
  near.sort((a, b) => a.distance - b.distance)
  return { items: near.map((n) => n.cp), fix: near.length ? { kind: 'typo' } : null }
}
