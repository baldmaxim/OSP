// Поиск в реестре контрагентов (/general/counterparties). 29.10.2026: «проматомстрой» не находил «ООО Пром Атом
// Строй (ПАС)» — поиск искал набранное буквально, вместе с пробелами, кавычками и дефисами. Теперь:
//  • регистр, ё / е, й / и, пробелы, кавычки, дефисы, точки и скобки не важны — ни в карточке, ни в запросе
//    («проматомстрой» = «Пром Атом Строй» = «Пром-Атом-Строй» = «ПромАтомСтрой»);
//  • латинские буквы, похожие на русские (A, B, C, E, H, K, M, O, P, T, X, Y), считаются русскими: в названиях
//    бывает «OOO» или «CK» латиницей;
//  • слова запроса — в любом порядке и в любых полях («атом пром», «сапаров фасад» — контакт и вид работ);
//  • телефон — цифрами, с 8 или 7 в начале («89104614571» = «+7(910)461-45-71»);
//  • ничего не нашлось — запрос в другой раскладке («ghjvfnjv» = «проматом»), затем названия и ФИО контактов
//    с опечатками (одна на 6–9 букв, две — от 10: «праматомстрой»); чем заменён запрос — пишет страница.
// Поля карточки разделены переводом строки: совпадение не склеивается из конца одного поля и начала другого.
//
// 06.11.2026: «АБ ц» не находил «ООО АБ Ц» — точнее, находил среди 185 строк: слова «аб» и «ц» искались кусками
// в любом поле («р-аб-оты», «-ц-ентр», адреса, примечания), а найденное шло по «№». Решение пользователя: форма
// организации (ООО, ИП, АО…) — не главное ни в поиске, ни в указателе. Теперь:
//  • форма — отдельно от названия: «ООО АБ Ц» ищется как «АБ Ц», «ООО» в запросе ничего не отбирает, а только
//    ставит выше контрагентов с этой формой; запрос из одной формы («ип») — все контрагенты с ней;
//  • слово короче 3 знаков — только с начала слова («аб» — «АБ Ц», «Абсолют», но не «работы»);
//  • найденное — по совпадению, внутри одного уровня — по «№»: название целиком → название начинается с запроса →
//    запрос внутри названия → все слова в названии → в других полях (ИНН, контакты, вид работ, адреса).
import { splitPhoneExt } from './phoneFormat.js'

const LATIN_AS_CYRILLIC = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' }

// Строчные, ё = е, й = и, латиница, похожая на кириллицу, — кириллицей; знаки остаются (делят слова). camel — «ПромАтомСтрой»
// тремя словами: «Пром», «Атом», «Строй» (для поиска с начала слова; только у названия и запроса).
const normalize = (value, camel = false) => {
  let s = String(value ?? '')
  if (camel) s = s.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
  return s.toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/й/g, 'и')
    .replace(/[abcehkmoptxy]/g, (ch) => LATIN_AS_CYRILLIC[ch])
}
const NOT_WORD = /[^\p{L}\p{N}]+/u
const NOT_WORD_ALL = /[^\p{L}\p{N}]+/gu

// Ключ поиска: только буквы и цифры, строчные, ё = е, й = и, латиница, похожая на кириллицу, — кириллицей.
export const searchKey = (value) => normalize(value).replace(NOT_WORD_ALL, '')

// Слова текста ключами.
const wordKeys = (value, camel = false) => normalize(value, camel).split(NOT_WORD).filter(Boolean)

// Формы организации — те же, что у регистрации подрядчика (LEGAL_FORMS в contractorSignupRules.js; совпадение сторожит
// tests/tender/counterparty-search.test.mjs), и ТОО. Сокращением или целиком, в любом месте названия: на копии
// реестра 02.11 форму пишут и в скобках («ООО "ГОРФОКС" (ИП Сорокин В. П.)»). Слова — ключами: й = и.
export const SEARCH_LEGAL_FORMS = [
  { code: 'ООО', phrases: ['ооо', 'общество с ограниченной ответственностью'] },
  { code: 'ИП', phrases: ['ип', 'индивидуальный предприниматель'] },
  { code: 'СЗ', phrases: ['сз', 'самозанятый', 'самозанятая'] },
  { code: 'АО', phrases: ['ао', 'акционерное общество'] },
  { code: 'ПАО', phrases: ['пао', 'публичное акционерное общество'] },
  { code: 'ЗАО', phrases: ['зао', 'закрытое акционерное общество'] },
  { code: 'ОАО', phrases: ['оао', 'открытое акционерное общество'] },
  { code: 'НАО', phrases: ['нао', 'непубличное акционерное общество'] },
  { code: 'АНО', phrases: ['ано', 'автономная некоммерческая организация'] },
  { code: 'ГУП', phrases: ['гуп', 'государственное унитарное предприятие'] },
  { code: 'МУП', phrases: ['муп', 'муниципальное унитарное предприятие'] },
  { code: 'ФГУП', phrases: ['фгуп', 'федеральное государственное унитарное предприятие'] },
  { code: 'ГБУ', phrases: ['гбу', 'государственное бюджетное учреждение'] },
  { code: 'ТОО', phrases: ['тоо', 'товарищество с ограниченной ответственностью'] },
]
// Длинные первыми: «публичное акционерное общество» — ПАО, а не «публичное» + АО.
const FORM_PHRASES = SEARCH_LEGAL_FORMS
  .flatMap((f) => f.phrases.map((p) => ({ code: f.code, words: wordKeys(p) })))
  .sort((a, b) => b.words.length - a.words.length)

// Слова (ключами) → { words: без форм, forms: коды форм }.
function splitForms(tokens) {
  const words = []
  const forms = []
  for (let i = 0; i < tokens.length;) {
    const hit = FORM_PHRASES.find((p) => p.words.every((w, k) => tokens[i + k] === w))
    if (hit) {
      if (!forms.includes(hit.code)) forms.push(hit.code)
      i += hit.words.length
    } else {
      words.push(tokens[i])
      i += 1
    }
  }
  return { words, forms }
}

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

// Что ищется у контрагента — один раз на загрузку списка:
//   core — название без формы организации одним ключом («ООО АБ Ц» → «абц»), главное для поиска;
//   full — название вместе с формой («оооабц»): набранное слитно с формой целиком — тоже название целиком;
//   cuts — где в core начинаются и кончаются слова ({0, 2, 3}): совпадение целыми словами — выше;
//   nameStarts — начала слов этого названия («\nаб\nц»), для коротких слов запроса;
//   forms — коды форм из названия (['ООО']);
//   text — название целиком и остальные поля карточки и контактов, по полю на строку; starts — начала их слов;
//   names — название без формы и ФИО контактов (для поиска с опечатками); no — постоянный номер.
export function counterpartySearchIndex(cp, no = null) {
  const tokens = wordKeys(cp.name, true)
  const named = splitForms(tokens)
  const nameWords = named.words.length ? named.words : tokens
  const core = nameWords.join('')
  const fields = [cp.name, cp.work_type, cp.inn, cp.kpp, cp.legal_address, cp.actual_address, cp.website, cp.notes]
  const names = [core]
  for (const ct of cp.counterparty_contacts || []) {
    fields.push(ct.full_name, ct.position, ct.email, ...phoneKeys(ct.phone))
    names.push(searchKey(ct.full_name))
  }
  const cuts = new Set([0])
  nameWords.reduce((at, w) => { cuts.add(at + w.length); return at + w.length }, 0)
  // Каждое поле нормализуется один раз: и ключом для text, и словами для starts.
  const keys = []
  const starts = []
  for (const field of fields) {
    const n = normalize(field)
    const key = n.replace(NOT_WORD_ALL, '')
    if (!key) continue
    keys.push(key)
    for (const w of n.split(NOT_WORD)) if (w) starts.push(w)
  }
  return {
    core,
    full: tokens.join(''),
    cuts,
    nameStarts: `\n${nameWords.join('\n')}`,
    forms: named.forms,
    text: keys.join('\n'),
    starts: `\n${starts.join('\n')}`,
    names: names.filter(Boolean),
    no,
  }
}

// Короче — только с начала слова: иначе «аб» и «ц» найдутся почти в каждой карточке.
const SHORT = 3

// Запрос внутри названия с начала слова: 2 — целыми словами («пас» в «Пром Атом Строй (ПАС)»), 1 — с начала слова
// («пас» в «ИСЛ Паскаль»), 0 — нет («ром» в «Пром Атом Строй»).
function wordAligned(ix, whole) {
  let best = 0
  for (let at = ix.core.indexOf(whole); at >= 0 && best < 2; at = ix.core.indexOf(whole, at + 1)) {
    if (ix.cuts.has(at)) best = ix.cuts.has(at + whole.length) ? 2 : 1
  }
  return best
}

// Запрос → оценка совпадения: число (меньше — лучше) или -1, если не подходит; null — запрос пустой.
// Уровни: 0 — название целиком; 1 — название начинается с запроса целыми словами («аб» — «АБ Ц»); 2 — просто начинается
// («аб» — «Абсолют»); 3 — внутри названия целыми словами; 4 — внутри с начала слова; 5 — внутри слова (от 3 знаков);
// 6 — все слова запроса в названии; 7 — в других полях. Форма из запроса — не условие, а порядок: с ней — выше внутри уровня.
function textMatcher(query) {
  const tokens = wordKeys(query, true)
  if (!tokens.length) return null
  const { words, forms } = splitForms(tokens)
  const hasForms = (ix) => forms.every((f) => ix.forms.includes(f))
  if (!words.length) return (ix) => (hasForms(ix) ? 0 : -1)

  const whole = words.join('')
  const inName = (ix, w) => (w.length >= SHORT ? ix.core.includes(w) : ix.nameStarts.includes(`\n${w}`))
  const inAny = (ix, w) => inName(ix, w) || (w.length >= SHORT ? ix.text.includes(w) : ix.starts.includes(`\n${w}`))
  const level = (ix) => {
    if (ix.core === whole || ix.full === whole) return 0
    if (ix.core.startsWith(whole)) return ix.cuts.has(whole.length) ? 1 : 2
    const aligned = wordAligned(ix, whole)
    if (aligned) return 5 - aligned
    if (whole.length >= SHORT && ix.core.includes(whole)) return 5
    if (words.every((w) => inName(ix, w))) return 6
    if ((whole.length >= SHORT && ix.text.includes(whole)) || words.every((w) => inAny(ix, w))) return 7
    return -1
  }
  return (ix) => {
    const l = level(ix)
    return l < 0 || !forms.length ? l : l * 2 + (hasForms(ix) ? 0 : 1)
  }
}

// Подходящие — по оценке, при равной — в прежнем порядке.
function ranked(list, match, indexOf) {
  const scored = []
  list.forEach((cp, i) => {
    const score = match(indexOf(cp))
    if (score >= 0) scored.push({ cp, score, i })
  })
  scored.sort((a, b) => a.score - b.score || a.i - b.i)
  return scored.map((s) => s.cp)
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

// Поиск по уже отобранному списку: сначала лучшие совпадения, при равных — порядок списка (с опечатками — сначала ближайшие).
// fix: null — найдено как набрано; { kind: 'layout', query } — в другой раскладке; { kind: 'typo' } — с опечатками.
// Постоянный номер: «№ 12» — ровно этот контрагент; просто «12» — он первым, дальше совпадения в ИНН, телефонах и других полях.
export function searchCounterparties(list, query, indexOf) {
  const match = textMatcher(query)
  if (!match) return { items: list, fix: null }
  const numbered = /^(№)?\s*(\d+)$/.exec(String(query ?? '').trim())
  const no = numbered ? Number(numbered[2]) : null
  const hasNo = (cp) => no != null && indexOf(cp).no === no
  if (numbered?.[1]) return { items: list.filter(hasNo), fix: null }
  const byNo = list.filter(hasNo)
  const found = ranked(list, match, indexOf).filter((cp) => !hasNo(cp))
  if (byNo.length || found.length) return { items: [...byNo, ...found], fix: null }

  const switched = switchLayout(query).trim()
  const matchSwitched = searchKey(switched) !== searchKey(query) && textMatcher(switched)
  if (matchSwitched) {
    const items = ranked(list, matchSwitched, indexOf)
    if (items.length) return { items, fix: { kind: 'layout', query: switched } }
  }

  // С опечатками — без формы организации: «ооо праматомстрой» ищет «праматомстрой».
  const key = splitForms(wordKeys(query, true)).words.join('') || searchKey(query)
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
