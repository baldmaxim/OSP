// Нумерация договоров подряда по объектам (решение пользователя 10.11.2026, файл «Нумерация_договоров_по_объектам.xlsx»):
//   КОД ОБЪЕКТА-ДП-ГГ-НОМЕР, например АЛИЯ-ДП-26-001 — код объекта, «ДП» — договор подряда, год регистрации, порядковый номер.
//   • Счётчик — на объект и год, общий для всех подрядчиков: новый договор получает следующий номер, в том числе повторный
//     договор с тем же подрядчиком. В новом году — снова с 001.
//   • Номер подставляется в форму нового договора, человек может заменить его своим.
//   • Номер по схеме не повторяется: занятый база не примет (уникальный индекс), счётчик только растёт — номер удалённого
//     договора снова не выдаётся (счётчик — таблица contract_number_counters, её ведёт триггер базы).
//   • ДС нумеруются внутри договора — генератор их не касается.
//
// Ключи (codeKey, numberKey) совпадают с функциями базы contract_code_key / contract_number_key (миграция 20270110) —
// сторожит tests/tender/contract-numbering-db.test.mjs: заглавные буквы, латиница-двойник = кириллица (С и C, А и A…),
// ведущие нули номера не важны (АЛИЯ-ДП-26-1 = АЛИЯ-ДП-26-001). Меняете правило — меняйте обе стороны новой миграцией.

export const NUMBER_MARK = 'ДП'
export const CODE_MAX_LENGTH = 20
export const SEQ_DIGITS = 3

// Пробелы по краям — те же, что снимает база (btrim с пробелом, табуляцией, переводами строк и неразрывным пробелом).
const EDGE_SPACES = /^[ \t\r\n\u00a0]+|[ \t\r\n\u00a0]+$/g
// Допустимые знаки: цифры, латиница, кириллица, точка и дефис (СОБ6.1, ЗИЛ18-19-27, ДОМ56Рен).
const ALLOWED = /^[0-9A-Za-zА-Яа-яЁё.-]+$/
// Код после приведения: с буквы или цифры, ими же заканчивается.
const CODE_SHAPE = /^[0-9A-ZА-ЯЁ](?:[0-9A-ZА-ЯЁ.-]*[0-9A-ZА-ЯЁ])?$/
const NUMBER_SHAPE = /^([0-9A-ZА-ЯЁ.-]+)-ДП-([0-9]{2})-([0-9]{1,6})$/
// Латинские буквы, неотличимые на глаз от кириллических: в ключе — кириллица.
const LOOKALIKE = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У' }

const trimEdges = (value) => String(value ?? '').replace(EDGE_SPACES, '')

// Строка в заглавных, двойники — кириллицей; null, если в ней есть недопустимые знаки.
function normalize(value) {
  const s = trimEdges(value)
  if (!s || !ALLOWED.test(s)) return null
  return s.toUpperCase().replace(/[ABCEHKMOPTXY]/g, (ch) => LOOKALIKE[ch])
}

// Код объекта, как его хранит база: края без пробелов, пустой — null.
export function cleanCode(code) {
  const s = trimEdges(code)
  return s || null
}

// Ключ кода для сравнения и счётчика (= contract_code_key в базе); null — код недопустим.
export function codeKey(code) {
  const k = normalize(code)
  return k && k.length <= CODE_MAX_LENGTH && CODE_SHAPE.test(k) ? k : null
}

// Почему код не годится; null — годится (пустой код тоже годится: «кода нет»).
export function codeProblem(code) {
  const s = cleanCode(code)
  if (!s) return null
  if (s.length > CODE_MAX_LENGTH) return `Код длиннее ${CODE_MAX_LENGTH} знаков`
  if (!ALLOWED.test(s)) return 'Только буквы, цифры, точка и дефис — без пробелов'
  if (!codeKey(s)) return 'Код начинается и заканчивается буквой или цифрой'
  return null
}

// Разбор номера по схеме: { codeKey, year, seq } или null — номер не по схеме (старый вид, ДС, «№ 5» и т. п.).
export function parseContractNumber(number) {
  const n = normalize(number)
  const m = n && NUMBER_SHAPE.exec(n)
  if (!m) return null
  const key = codeKey(m[1])
  const seq = Number(m[3])
  if (!key || seq < 1) return null
  return { codeKey: key, year: 2000 + Number(m[2]), seq }
}

// Ключ номера (= contract_number_key в базе): «КОД|ГГГГ|N»; по нему база не даёт двум договорам один номер.
export function numberKey(number) {
  const p = parseContractNumber(number)
  return p ? `${p.codeKey}|${p.year}|${p.seq}` : null
}

export function formatContractNumber(code, year, seq) {
  const c = cleanCode(code)
  if (!c || !Number.isInteger(year) || !Number.isInteger(seq) || seq < 1) return null
  return `${c}-${NUMBER_MARK}-${String(year % 100).padStart(2, '0')}-${String(seq).padStart(SEQ_DIGITS, '0')}`
}

// Год регистрации — по Москве (договор, заведённый 31 декабря в 23:30 по Москве, — ещё этого года).
export function moscowYear(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Moscow', year: 'numeric' }).format(date))
}

// Последний выданный номер по счётчику; counters — строки contract_number_counters { code_key, year, last_number }.
export function lastIssued(counters, key, year) {
  if (!key) return 0
  const row = (counters || []).find((c) => c.code_key === key && Number(c.year) === year)
  return row ? Number(row.last_number) || 0 : 0
}

// Следующий номер объекта: { number, code, seq, year, last } или null — у объекта нет кода (или он недопустим).
export function nextContractNumber(object, counters, year = moscowYear()) {
  const code = cleanCode(object?.contract_code)
  const key = codeKey(code)
  if (!key) return null
  const last = lastIssued(counters, key, year)
  return { number: formatContractNumber(code, year, last + 1), code, seq: last + 1, year, last }
}

// Номер, введённый вручную, перед записью: что в нём не так по схеме (для одного окна подтверждения).
// Номер не по схеме — свой номер человека, вопросов нет. ownNumber — номер, который у договора уже был (правка):
// его не переспрашиваем.
export function manualNumberWarnings({ number, object, counters, ownNumber = null }) {
  const p = parseContractNumber(number)
  if (!p) return []
  if (ownNumber != null && numberKey(ownNumber) === numberKey(number)) return []
  const warnings = []
  const objectKey = codeKey(object?.contract_code)
  if (objectKey && objectKey !== p.codeKey) {
    warnings.push(`код в номере не совпадает с кодом объекта «${object.name}» — ${cleanCode(object.contract_code)}`)
  }
  const last = lastIssued(counters, p.codeKey, p.year)
  const pad = (n) => String(n).padStart(SEQ_DIGITS, '0')
  if (p.seq > last + 1) {
    const skipped = p.seq - last - 1
    warnings.push(`номер идёт не по порядку: следующий по счётчику — ${pad(last + 1)}; `
      + `${skipped === 1 ? `номер ${pad(last + 1)} останется невыданным` : `номера ${pad(last + 1)}–${pad(p.seq - 1)} останутся невыданными`}, `
      + `а счётчик ${p.year} года продолжится с ${pad(p.seq + 1)}`)
  } else if (p.seq <= last) {
    warnings.push(`номер ${pad(p.seq)} уже выдавался: по счётчику ${p.year} года выдано ${pad(1)}–${pad(last)}. `
      + 'Номера не выдаются повторно — проверьте, что это не номер удалённого договора')
  }
  return warnings
}

// Отказ базы «номер по схеме уже занят» (уникальный индекс contracts_scheme_number_uniq).
export function isSchemeNumberTaken(err) {
  if (err?.code !== '23505') return false
  const msg = String(err?.message || '') + String(err?.details || '')
  // Шлюз может отдать сообщение без имени индекса; другая уникальность у договоров — id, display_id и номер ДС внутри
  // договора (uq_contracts_amendment_number), их не путаем.
  return /contracts_scheme_number_uniq/.test(msg) || !/display_id|_pkey|amendment_number/.test(msg)
}

// Код объекта уже занят другим объектом (уникальный индекс objects_contract_code_uniq).
export function isCodeTaken(err) {
  return err?.code === '23505' && /objects_contract_code_uniq|contract_code/.test(String(err?.message || '') + String(err?.details || ''))
}
