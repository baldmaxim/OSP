// Сопоставление договоров ОСП с папками Signal — чистые функции, без базы и без сети (интеграция OSP ↔ SIGNAL, раздел 2–3, 5
// спецификации). Один и тот же код вызывают очередь (signalJobs.js), маршрут POST /api/signal/match и проверка перед confirm.
//
// Что функции НЕ делают: не пишут ссылку (её меняет только человек через confirm/replace/unlink), не обращаются к Signal,
// не запрашивают пользовательский URL (он только разбирается). Пользовательская ссылка — это строка; её адрес сравнивается с
// шаблонами SIGNAL_URL_FORMATS по точному хосту, только https, без userinfo и порта.
//
// Контракт состояний и сопоставителя (волна исправлений OSP ↔ SIGNAL, спецификация §1–§2):
//   • «сверено» (verified:existing_url) — только если номер договора найден в названии папки или её предка (В-1); иначе
//     «ссылка принята, номер в папке не найден» (accepted:number_not_found); решение человека — verified:confirmed;
//   • противоречие (conflict) — только по номерам и виду (ДП/ДС), по чужому ИНН и по неоднозначности; расположение папки
//     («рядом с папкой ДП») само по себе не ошибка (В-3, В-4);
//   • корпус, очередь, секция — мягкое предупреждение (attention:building_mismatch), подтверждать можно (В-11);
//   • узел вне границы объекта договора (объект узла NULL или другой) никогда не кандидат; при введённой ссылке на него —
//     unverified:unavailable, а чужие id и имена наружу (nodeId, путь) не выдаются.
import { createHash } from 'node:crypto'
import { numberKey, codeKey } from '../shared/contractNumbering.js'
import { normMatchName } from '../shared/matchName.js'
import { isValidInn, splitLegalForm } from '../shared/contractorSignupRules.js'

// ── Константы ───────────────────────────────────────────────────────────────────────────────────────────────────────
// Состояния «сверки Signal» (значок в реестре): текст — для подсказок и отчётов, без имён и путей.
export const STATES = Object.freeze({
  none: 'Ссылки нет',
  suggested: 'Предложена папка',
  verified: 'Сверено',
  accepted: 'Ссылка принята, номер в папке не найден',
  unverified: 'Не сверено',
  attention: 'Требует внимания',
  missing: 'Файл удалён в Signal',
  conflict: 'Противоречие',
})

// Причины состояний (state:reason). Тексты общие — чужие имена, пути и id в них не попадают.
export const REASONS = Object.freeze({
  none: 'Ссылки нет',
  unlinked: 'Связь снята',
  no_object: 'У договора не указан объект',
  candidates: 'Есть предложенные папки',
  existing_url: 'Номер договора найден в названии папки',
  confirmed: 'Связь подтверждена человеком',
  number_not_found: 'Ссылка принята, номер в папке не найден',
  unsupported_url: 'Формат ссылки не поддержан',
  unavailable: 'Папка недоступна для сверки',
  no_snapshot: 'Снимка Signal ещё нет',
  not_observed: 'Папка не видна в последнем обходе',
  not_visible: 'Папка не видна в Signal',
  file_not_visible: 'Файл не виден в Signal',
  deleted: 'Файл удалён в Signal',
  object_mismatch: 'Номер в названии папки принадлежит другому объекту',
  number_mismatch: 'Номер договора не совпал с номером в названии папки',
  building_mismatch: 'Корпус, очередь или секция не совпали — проверьте',
  foreign_dp: 'В названии папки номер другого договора, не корневого для этого ДС',
  ds_mismatch: 'Номер ДС не совпал с номером в названии папки',
  kind_mismatch: 'Папка относится к допсоглашению — проверьте',
  foreign_party: 'В названии папки ИНН другой организации',
  ambiguous: 'В названии папки несколько номеров договоров',
  pending: 'Ожидает пересчёта',
})

// Допустимые пары state → reason (spec §1; pending ставит сервер по очереди, не сопоставитель).
export const STATE_REASONS = Object.freeze(Object.fromEntries(Object.entries({
  none: ['none', 'unlinked', 'no_object'],
  suggested: ['candidates'],
  verified: ['existing_url', 'confirmed'],
  accepted: ['number_not_found'],
  unverified: ['unsupported_url', 'unavailable', 'no_snapshot', 'not_observed', 'no_object', 'pending'],
  attention: ['not_visible', 'file_not_visible', 'building_mismatch', 'kind_mismatch'],
  missing: ['deleted'],
  conflict: ['number_mismatch', 'object_mismatch', 'ambiguous', 'foreign_dp', 'ds_mismatch', 'foreign_party'],
}).map(([k, v]) => [k, Object.freeze(v)])))

// Причины, по которым папка предложена договору (кандидат).
export const MATCH_REASONS = Object.freeze({
  number: 'Номер договора по схеме совпал с номером в названии папки',
  number_legacy: 'Номер договора совпал с названием папки',
  ds_number: 'Номер ДС совпал с номером в названии папки',
  inn: 'ИНН контрагента в названии папки',
  counterparty: 'Название контрагента в названии папки',
  name_similar: 'Название контрагента похоже (транслитерация или общее начало названия)',
  object_name: 'Название или синоним объекта в названии папки',
  features: 'Корпус, очередь или секция совпали с объектом',
})
export const MATCH_FLAGS = Object.freeze({
  similar: 'Совпадение по сходству названия — проверьте',
  building_mismatch: 'Корпус, очередь или секция не совпали — проверьте',
  kind_mismatch: 'Папка допсоглашения, а не договора — проверьте',
  previously_rejected: 'Эту папку уже отклоняли при прежних реквизитах или прежнем названии',
  previously_unlinked: 'Эту папку уже отвязывали при прежних реквизитах или прежнем названии',
})
const REASON_ORDER = Object.keys(MATCH_REASONS)
const FLAG_ORDER = Object.keys(MATCH_FLAGS)
const WEIGHT = { number: 100, ds_number: 90, number_legacy: 80, inn: 60, counterparty: 40, name_similar: 15, object_name: 15, features: 10 }
const PRIMARY = new Set(['number', 'ds_number', 'number_legacy', 'inn', 'counterparty', 'name_similar'])
const STRONG = new Set(['number', 'ds_number'])
const BUILDING_PENALTY = 30 // В-11: расхождение корпуса не исключает кандидата, а понижает его
const KIND_PENALTY = 40 // С-41: папка допсоглашения для ДП — мягкое предупреждение, ниже папки самого договора
const IN_DP_FOLDER_BONUS = 20 // ДС внутри известной папки своего ДП идёт выше такой же папки вне её
const EXACT_LEGACY_BONUS = 30 // С-55: «ДП №12» — точная папка выше «ДП №12/2023» и «ДП №12-1»
const MAX_CANDIDATES = 10

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v)
const lower = (v) => String(v ?? '').toLowerCase()
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32)
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const sortedUnique = (list) => [...new Set(list)].sort(cmp)
// С-56: порядок равных кандидатов — как в SQL на проде (ICU en_US), а не по кодовым единицам UTF-16.
const COLLATOR = new Intl.Collator('en-US')
const cmpPath = (a, b) => COLLATOR.compare(a, b) || cmp(a, b)

// Небольшой кэш чистых разборов строк (названия папок повторяются у сотен договоров одной выборки).
function memo(fn, cap = 20000) {
  const cache = new Map()
  return (key) => {
    if (cache.has(key)) return cache.get(key)
    const value = fn(key)
    if (cache.size >= cap) cache.clear()
    cache.set(key, value)
    return value
  }
}

// ── Разбор ссылки и форматы ─────────────────────────────────────────────────────────────────────────────────────────
// Формат — шаблон вида https://host/projects/{projectId}/docs/{folderId} (или {itemId} — ссылка на файл). Подстановки целым
// сегментом пути, значением параметра запроса или сегментом фрагмента (#/…). Хост — точное имя, https, без userinfo и порта.
const MAX_URL_LENGTH = 2048
const MAX_TEMPLATE_LENGTH = 500
const MAX_FORMATS = 10
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/
const LITERAL_RE = /^[A-Za-z0-9._~%-]+$/
// Пробелы, управляющие знаки и обратная косая в адресе — не разбираем (браузер их молча «чинит», нам этого не нужно).
const hasBadChars = (s) => [...s].some((ch) => ch.charCodeAt(0) <= 0x20 || ch.charCodeAt(0) === 0x7f || ch === '\\')
const PLACEHOLDER = { '{projectId}': 'projectId', '{folderId}': 'folder', '{itemId}': 'item' }

function compileSlot(text) {
  if (Object.hasOwn(PLACEHOLDER, text)) return { ph: PLACEHOLDER[text] }
  if (LITERAL_RE.test(text)) return { lit: text }
  return null
}

function compileSegments(text, fragment) {
  let slash = false
  let body = text
  if (fragment && body.startsWith('/')) { slash = true; body = body.slice(1) }
  const parts = body === '' ? [] : body.split('/')
  if (parts.length && parts[parts.length - 1] === '') parts.pop()
  const slots = []
  for (const p of parts) {
    const slot = p === '' ? null : compileSlot(p)
    if (!slot) return null
    slots.push(slot)
  }
  return { slots, slash }
}

const compileCache = new Map()
// Шаблон → { ok:true, host, path, query, frag, kind } | { ok:false, reason }.
function compileUrlTemplate(template) {
  const key = typeof template === 'string' ? template : ''
  if (compileCache.has(key)) return compileCache.get(key)
  const res = compileUncached(key.trim())
  if (compileCache.size > 200) compileCache.clear()
  compileCache.set(key, res)
  return res
}

function compileUncached(t) {
  const fail = (reason) => ({ ok: false, reason })
  if (!t) return fail('empty')
  if (t.length > MAX_TEMPLATE_LENGTH) return fail('too_long')
  if (hasBadChars(t)) return fail('bad_chars')
  if (!/^https:\/\//i.test(t)) return fail('not_https')
  const m = /^https:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(t)
  if (!m) return fail('bad_url')
  const authority = m[1]
  if (authority.includes('@')) return fail('userinfo')
  if (authority.includes(':')) return fail('port')
  const host = authority.toLowerCase()
  if (!host || host.length > 253 || !HOST_RE.test(host)) return fail('bad_host')
  try {
    if (new URL(`https://${host}/`).hostname !== host) return fail('bad_host')
  } catch { return fail('bad_host') }
  if (m[2] !== '' && !m[2].startsWith('/')) return fail('bad_path')
  const path = compileSegments(m[2] === '' ? '' : m[2].slice(1), false)
  if (!path) return fail('bad_placeholder')
  let query = null
  if (m[3] !== undefined) {
    query = []
    for (const pair of m[3].split('&')) {
      const eq = pair.indexOf('=')
      if (eq <= 0) return fail('bad_query')
      const k = pair.slice(0, eq)
      const slot = compileSlot(pair.slice(eq + 1))
      if (!LITERAL_RE.test(k) || !slot) return fail('bad_placeholder')
      query.push({ key: k, ...slot })
    }
  }
  let frag = null
  if (m[4] !== undefined) {
    frag = compileSegments(m[4], true)
    if (!frag) return fail('bad_placeholder')
  }
  const all = [...path.slots, ...(query || []), ...(frag ? frag.slots : [])]
  const count = (ph) => all.filter((s) => s.ph === ph).length
  if (count('projectId') > 1 || count('folder') + count('item') > 1) return fail('duplicate_placeholder')
  if (count('projectId') !== 1) return fail('no_project')
  if (count('folder') + count('item') !== 1) return fail('no_node')
  return { ok: true, host, path, query, frag, kind: count('folder') ? 'folder' : 'item' }
}

// Проверка одного шаблона (для настроек SIGNAL_URL_FORMATS, SIGNAL_UI_FOLDER_URL, SIGNAL_UI_FILE_URL).
export function validateUrlTemplate(template) {
  const t = compileUrlTemplate(template)
  return t.ok ? { ok: true, kind: t.kind } : { ok: false, reason: t.reason }
}

// Настройка SIGNAL_URL_FORMATS: «;»-список шаблонов → { formats, errors:[{index, reason}] }. Пустые элементы пропускаются;
// негодный шаблон в formats не попадает (ошибку при SIGNAL_SYNC=1 решает config.js).
export function parseUrlFormats(text) {
  const formats = []
  const errors = []
  String(text ?? '').split(';').forEach((raw, index) => {
    const s = raw.trim()
    if (!s) return
    const t = compileUrlTemplate(s)
    if (!t.ok) errors.push({ index, reason: t.reason })
    else if (!formats.includes(s)) formats.push(s)
  })
  if (formats.length > MAX_FORMATS) {
    errors.push({ index: MAX_FORMATS, reason: 'too_many' })
    formats.length = MAX_FORMATS
  }
  return { formats, errors }
}

function urlSegments(text) {
  const body = text.replace(/^\//, '')
  const parts = body === '' ? [] : body.split('/')
  if (parts.length && parts[parts.length - 1] === '') parts.pop()
  return parts
}

function matchSlots(slots, actual, out) {
  if (slots.length !== actual.length) return false
  for (let i = 0; i < slots.length; i++) {
    if (!matchSlot(slots[i], actual[i], out)) return false
  }
  return true
}

function matchSlot(slot, value, out) {
  if (slot.lit !== undefined) return slot.lit === value
  if (!isUuid(value)) return false
  out[slot.ph] = value.toLowerCase()
  return true
}

function matchTemplate(t, u) {
  const out = {}
  if (!matchSlots(t.path.slots, urlSegments(u.pathname), out)) return null
  for (const q of t.query || []) {
    const values = u.searchParams.getAll(q.key)
    if (values.length !== 1 || !matchSlot(q, values[0], out)) return null
  }
  if (t.frag) {
    if (!u.hash || !matchSlots(t.frag.slots, urlSegments(u.hash.slice(1)), out)) return null
  }
  const nodeId = out.folder || out.item
  if (!out.projectId || !nodeId) return null
  return { projectId: out.projectId, nodeId, kind: t.kind }
}

// Пользовательская ссылка → { ok:true, projectId, nodeId, kind:'folder'|'item' } | { ok:false, reason:'empty'|'unsupported_url' }.
// Только разбор строки: ни сети, ни перенаправлений. Query/fragment, не названные в шаблоне, игнорируются.
export function parseSignalUrl(url, formats) {
  if (url == null) return { ok: false, reason: 'empty' }
  if (typeof url !== 'string') return { ok: false, reason: 'unsupported_url' }
  const s = url.trim()
  if (!s) return { ok: false, reason: 'empty' }
  const bad = { ok: false, reason: 'unsupported_url' }
  if (s.length > MAX_URL_LENGTH || hasBadChars(s) || !/^https:\/\//i.test(s) || /^https:\/\/[^/?#]*@/i.test(s)) return bad
  let u
  try { u = new URL(s) } catch { return bad }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return bad
  const found = new Map()
  for (const f of Array.isArray(formats) ? formats : []) {
    const t = compileUrlTemplate(f)
    if (!t.ok || t.host !== u.hostname) continue
    const r = matchTemplate(t, u)
    if (r) found.set(`${r.kind}|${r.projectId}|${r.nodeId}`, r)
  }
  // Два формата дали разные узлы — ссылка неоднозначна, не выбираем первый.
  if (found.size !== 1) return bad
  return { ok: true, ...[...found.values()][0] }
}

// Обратная операция: шаблон + { projectId, nodeId } → адрес (для confirm и ссылок на файлы). Результат разбирается тем же
// шаблоном. null — шаблон негоден, id не uuid или вид шаблона не тот, что запрошен в kind.
export function buildSignalUrl(template, { projectId, nodeId, kind } = {}) {
  const t = compileUrlTemplate(template)
  if (!t.ok || !isUuid(projectId) || !isUuid(nodeId)) return null
  if (kind && kind !== t.kind) return null
  const fill = (slot) => (slot.lit !== undefined ? slot.lit : slot.ph === 'projectId' ? projectId.toLowerCase() : nodeId.toLowerCase())
  let out = `https://${t.host}/${t.path.slots.map(fill).join('/')}`
  if (t.query) out += `?${t.query.map((q) => `${q.key}=${fill(q)}`).join('&')}`
  if (t.frag) out += `#${t.frag.slash ? '/' : ''}${t.frag.slots.map(fill).join('/')}`
  try { return new URL(out).href } catch { return null }
}

// ── Номера в названиях папок и файлов ───────────────────────────────────────────────────────────────────────────────
const LOOKALIKE_UP = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У' }

// Безопасная нормализация номера «старого вида»: заглавные, латиница-двойник → кириллица, любые разделители → «-». Не ключ
// базы (contract_code_norm такие строки отвергает), а только сравнение. null — нормализовать нечего.
export function legacyKey(value) {
  const s = String(value ?? '').normalize('NFC').toUpperCase().replace(/Ё/g, 'Е')
    .replace(/[ABCEHKMOPTXY]/g, (ch) => LOOKALIKE_UP[ch])
    .replace(/[^0-9A-ZА-Я]+/g, '-').replace(/^-+|-+$/g, '')
  return s || null
}

// Номер старого вида достаточно «особенный» для поиска по названию: буквы и цифры, не короче 5 знаков, не «б/н».
function legacyStrong(key) {
  return Boolean(key) && key.length >= 5 && /\d/.test(key) && /[A-ZА-Я]/.test(key) && !/^Б-?Н(-|$)/.test(key)
}
// Номер старого вида годится для сравнения: есть цифра, не «б/н».
const legacyUsable = (key) => Boolean(key) && /\d/.test(key) && !/^Б-?Н(-|$)/.test(key)
// Цепочка сегментов «А-Б-В» содержит «Б-В» целыми сегментами.
const runIn = (hay, needle) => Boolean(hay) && Boolean(needle) && `-${hay}-`.includes(`-${needle}-`)

const EXT_RE = /\.(?:pdf|docx?|xlsx?|xlsm|rtf|odt|ods|txt|jpe?g|png|gif|bmp|heic|tiff?|zip|rar|7z|xml|dwg|msg|eml|pptx?|csv)$/i
const TOKEN_RE = /[0-9A-Za-zА-Яа-яЁё](?:[0-9A-Za-zА-Яа-яЁё./-]*[0-9A-Za-zА-Яа-яЁё])?/g
const FEATURE_TOKEN_RE = /^(?:корп|корпус|кор|к|bldg|bld|building|оч|очередь|queue|phase|сек|секц|секция|section|v|ver|rev|ред|прил|приложение)\.?-?\d+$/i
// Слова перед номером старого вида: «ДП №…», «Договор №…», «Договор подряда №…», «Дог. №…», «Контракт №…».
const MARKER_WORDS = new Set(['ДП', 'DP', 'ДОГОВОР', 'ДОГОВОРА', 'ДОГ', 'КОНТРАКТ'])
const NUM_WORDS = new Set(['N', 'NO', 'НО'])
const SKIP_WORDS = new Set(['ПОДРЯДА', 'ПОДРЯД'])
// Слова, которые не бывают кодом объекта: приставки перед номером по схеме («Дог.АЛФ-ДП-26-001», «Договор подряда-АЛФ-…»).
const STRAY_WORDS = new Set(['ДП', 'ДС', 'DP', 'DS', 'ДОГ', 'ДОГОВОР', 'ДОГОВОРА', 'ДОП', 'N', 'NO', 'НО', 'ПОДРЯДА', 'ПОДРЯД', 'КОНТРАКТ',
  'СОГЛАШЕНИЕ', 'ПРИЛОЖЕНИЕ', 'ОТ'])

const chars = (...codes) => codes.map((c) => String.fromCharCode(c)).join('')
// Тире и дефисоподобные знаки (U+2010–2015, минус U+2212 и др.) → «-»; невидимые знаки снимаются; нестандартные пробелы → « ».
const DASH_RE = new RegExp(`[${chars(0x2010)}-${chars(0x2015)}${chars(0x2212, 0xfe58, 0xfe63, 0xff0d)}]`, 'g')
const INVISIBLE_RE = new RegExp(`[${chars(0x200b)}-${chars(0x200d)}${chars(0x2060, 0xfeff, 0xad)}]`, 'g')
const SPACE_RE = new RegExp(`[${chars(0xa0, 0x1680)}${chars(0x2000)}-${chars(0x200a)}${chars(0x2028, 0x2029, 0x202f, 0x205f, 0x3000)}]`, 'g')
const DATE_RE = /^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/

// Текст для разбора: NFC, тире и неразрывные пробелы приведены к обычным, расширение файла снято, не длиннее 1000 знаков.
function scanText(name) {
  let s = String(name ?? '').slice(0, 1000).normalize('NFC').replace(INVISIBLE_RE, '').replace(DASH_RE, '-').replace(SPACE_RE, ' ')
  for (let i = 0; i < 2 && EXT_RE.test(s); i++) s = s.replace(EXT_RE, '')
  return s
}

// Название для предвыборки и сравнения (= signal_nodes.name_norm): normMatchName от NFC-текста, тире — дефисом (С-42).
export function searchNorm(value) {
  return normMatchName(String(value ?? '').normalize('NFC').replace(DASH_RE, '-'))
}

// ── Номер по схеме КОД-ДП-ГГ-NNN где угодно в названии ──────────────────────────────────────────────────────────────
// Хвост «ДП <год> <номер>»: разделители — пробел, «-», «_», «/», «.», «\»; год — две цифры или «20ГГ»; перед номером может стоять «№».
// Код — слитный отрезок «буквы, цифры, точка, дефис» перед «ДП». Если приставка слита с кодом через «-» или «.» («Альфа-ПРИМ»,
// «01.ПРИМ», «Дог.ПРИМ»), основной ключ берётся без приставки; остальные разборы остаются в alts — сравнение «свой номер» принимает
// любой из них (ложное противоречие хуже пропущенного). Ключ канонической записи совпадает с numberKey (SQL contract_number_key).
const SEPS = '[\\s\\-_/.\\\\]'
const TAIL_RE = new RegExp(`(?<![\\p{L}\\p{N}])ДП${SEPS}+(20\\d\\d|\\d{2})(?:${SEPS}+№?${SEPS}*|${SEPS}*№${SEPS}*)(\\d{1,6})(?!\\d)`, 'giu')
const CODE_RUN_RE = /[0-9A-Za-zА-Яа-яЁё.-]+$/
const TRAILING_SEPS_RE = /[\s\-_/.\\]+$/
const GLUED_PREFIX_RE = /^(ДП|ДОГОВОР|ДОГ|NO|N|НО)(?=[0-9A-Za-zА-Яа-яЁё])/i
const MAX_CODE_RUN = 60

const isStrayPiece = (p) => /^\d{1,4}$/.test(p) || STRAY_WORDS.has(p.toUpperCase())
  || (!/\d/.test(p) && (/^[А-ЯЁA-Z][а-яёa-z]{2,}$/.test(p) || /^[а-яёa-z]{3,}$/.test(p)))

function schemeRefsOf(s) {
  const out = []
  for (const m of s.matchAll(TAIL_RE)) {
    const at = m.index
    const end = at + m[0].length
    const year = m[1].length === 4 ? m[1].slice(2) : m[1]
    const seq = m[2]
    // «ДП 12.03.2026» — дата, а не номер.
    const body = m[0].replace(/^ДП[\s\-_/.\\]+/i, '')
    if (/^\d{2}[./]\d{2}$/.test(body) && /^[./]\d{2,4}(?!\d)/.test(s.slice(end))) continue
    const head = s.slice(0, at)
    const stripped = head.replace(TRAILING_SEPS_RE, '')
    const run = CODE_RUN_RE.exec(stripped)
    if (!run) continue
    let codeRun = run[0]
    const truncated = codeRun.length > MAX_CODE_RUN
    if (truncated) codeRun = codeRun.slice(-MAX_CODE_RUN)
    const base = stripped.length - codeRun.length
    // Допустимые начала кода: начало отрезка и позиции после «-» или «.».
    const starts = []
    if (!truncated && /^[0-9A-Za-zА-Яа-яЁё]/.test(codeRun)) starts.push(0)
    for (let i = 0; i < codeRun.length - 1; i++) {
      if ((codeRun[i] === '-' || codeRun[i] === '.') && /[0-9A-Za-zА-Яа-яЁё]/.test(codeRun[i + 1])) starts.push(i + 1)
    }
    const variants = []
    const tail = `-ДП-${year}-${seq}`
    for (const st of starts.slice(-12)) {
      const code = codeRun.slice(st)
      if (code.length > 20) continue
      const key = numberKey(code + tail)
      if (key) variants.push({ st, code, key, piece: code.split(/[-.]/, 1)[0] })
    }
    if (!variants.length) continue
    // Кроме слов-приставок целиком, код не может состоять только из них.
    if (variants.every((v) => STRAY_WORDS.has(v.piece.toUpperCase()) && !/[-.]/.test(v.code))) continue
    const primary = variants.find((v) => !isStrayPiece(v.piece)) || variants[variants.length - 1]
    // Слитая приставка без разделителя («ДППРИМ-ДП-26-001»): основной ключ — без неё, если остаток не короче трёх знаков.
    let primaryKey = primary.key
    const alts = new Set(variants.map((v) => v.key))
    for (const v of variants) {
      const g = GLUED_PREFIX_RE.exec(v.code)
      if (!g) continue
      const rest = v.code.slice(g[0].length)
      const k = rest.length >= 2 ? numberKey(rest + tail) : null
      if (!k) continue
      alts.add(k)
      if (v === primary && /^(ДП|ДОГОВОР|ДОГ)$/i.test(g[1]) && rest.length >= 3 && !/^[-.]/.test(rest)) primaryKey = k
    }
    alts.delete(primaryKey)
    out.push({ pos: base + primary.st, end, raw: s.slice(base + primary.st, end), key: primaryKey, alts: [...alts].sort(cmp) })
  }
  return out
}

// ── Номер ДС ────────────────────────────────────────────────────────────────────────────────────────────────────────
// «ДС-3», «ДС 3», «ДС №3», «ДС N1», «ДС3», «Д/С 1», «Доп. соглашение № 3», «доп.согл. 3».
const DS_RE = new RegExp(
  '(?<![\\p{L}\\p{N}])(?:Д[СC]|DS|Д[/.]\\s?С\\.?|доп(?:олнительн\\p{L}*)?\\.?\\s*согл(?:аш\\p{L}*|\\.)?)'
  + '(?:[\\s\\-_.:]*(?:№|N|No|Nо)?\\.?\\s*)(\\d+(?:[./-]\\d+)*[A-Za-zА-Яа-я]?)(?![\\p{L}\\p{N}])', 'giu')

// Номер ДС без ведущих нулей и хвоста «.0»: «04» = «4», «4.0» = «4».
function dsNumberKey(n) {
  const k = legacyKey(n)
  if (!k) return null
  return `ДС|${k.replace(/(^|-)0+(?=\d)/g, '$1').replace(/^(\d+)(?:-0+)+$/, '$1')}`
}

function dsRefsOf(s) {
  const out = []
  for (const m of s.matchAll(DS_RE)) {
    if (DATE_RE.test(m[1])) continue
    const key = dsNumberKey(m[1])
    if (key) out.push({ pos: m.index, end: m.index + m[0].length, raw: m[1], key })
  }
  return out
}

// ── Номер старого вида ──────────────────────────────────────────────────────────────────────────────────────────────
// TODO(В-2): временное правило, пересмотреть по выборке этапа 0. Противоречие дают только «явные» номера: после слова
// «ДП», «Договор», «Договор подряда», «Дог.», «Контракт» и знака «№»/«N»/«No» (или сильный номер сразу за словом).
// Прочие номероподобные токены (после голого «№», единственный «сильный» токен названия) — только положительный признак.
function legacyRefsOf(s, taken) {
  const tokens = []
  let m
  TOKEN_RE.lastIndex = 0
  while ((m = TOKEN_RE.exec(s)) !== null) tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length })
  const free = tokens.filter((t) => !taken.some((r) => t.start < r.end && t.end > r.pos))
  const strongOf = (t) => {
    const key = legacyKey(t.text)
    return legacyStrong(key) && !FEATURE_TOKEN_RE.test(t.text) && !DATE_RE.test(t.text)
  }
  const strong = free.filter(strongOf)
  const out = []
  for (const tok of free) {
    let text = tok.text
    const idx = tokens.indexOf(tok)
    const gap = idx > 0 ? s.slice(tokens[idx - 1].end, tok.start) : s.slice(0, tok.start)
    let hasNum = gap.includes('№')
    const glued = /^(?:N|No|НО)\.?(?=\d)/i.exec(text)
    if (glued) { text = text.slice(glued[0].length); hasNum = true }
    if (DATE_RE.test(text) || FEATURE_TOKEN_RE.test(text)) continue
    const key = legacyKey(text)
    if (!key || !/\d/.test(key)) continue
    let j = idx - 1
    if (j >= 0 && NUM_WORDS.has(tokens[j].text.toUpperCase())) { hasNum = true; j-- }
    if (j >= 0 && SKIP_WORDS.has(tokens[j].text.toUpperCase())) j--
    const marker = j >= 0 && MARKER_WORDS.has(tokens[j].text.toUpperCase())
    const explicit = marker && (hasNum || legacyStrong(key))
    if (explicit || marker || hasNum || (strong.length === 1 && strong[0] === tok)) {
      out.push({ pos: tok.start, end: tok.end, raw: text, key, explicit })
    }
  }
  return out
}

// Все ссылки на номера в названии файла/папки: [{ raw, key, kind:'scheme'|'legacy'|'ds', explicit, scheme, ds, alts? }].
//   • scheme — номер по схеме (key = numberKey = SQL contract_number_key), explicit всегда true; alts — другие разборы кода;
//   • ds — собственный номер ДС («ДС 3», «Доп. соглашение № 3»), key = «ДС|<номер>»;
//   • legacy — номер старого вида, key = legacyKey; explicit — после явной приставки (участвует в противоречии, TODO(В-2)).
// options.codes — коды объектов (codeKey): при слитой приставке выбирается разбор с известным кодом. Несколько разных ключей по
// схеме — неоднозначность (hasAmbiguousNumbers), а не выбор первого.
export function extractContractReferences(name, options = {}) {
  const s = scanText(name)
  const schemes = schemeRefsOf(s)
  const known = options?.codes ? new Set([...options.codes].map((c) => codeKey(c)).filter(Boolean)) : null
  if (known?.size) {
    for (const r of schemes) {
      const pick = [r.key, ...r.alts].find((k) => known.has(k.split('|')[0]))
      if (pick && pick !== r.key) { r.alts = [r.key, ...r.alts.filter((k) => k !== pick)].sort(cmp); r.key = pick }
    }
  }
  const dss = dsRefsOf(s)
  const taken = [...schemes, ...dss]
  const legacy = legacyRefsOf(s, taken)
  const all = [
    ...schemes.map((r) => ({ ...r, kind: 'scheme', explicit: true })),
    ...dss.map((r) => ({ ...r, kind: 'ds', explicit: true })),
    ...legacy.map((r) => ({ ...r, kind: 'legacy' })),
  ].sort((a, b) => a.pos - b.pos)
  const seen = new Set()
  const refs = []
  for (const r of all) {
    const id = `${r.kind}|${r.key}`
    if (seen.has(id)) {
      if (r.kind === 'legacy' && r.explicit) refs.find((x) => `${x.kind}|${x.key}` === id).explicit = true
      continue
    }
    seen.add(id)
    refs.push({ raw: r.raw, key: r.key, kind: r.kind, explicit: r.explicit, scheme: r.kind === 'scheme', ds: r.kind === 'ds',
      ...(r.kind === 'scheme' ? { alts: r.alts } : {}) })
  }
  return refs
}

// Несколько разных номеров по схеме в одном названии — неоднозначность.
export function hasAmbiguousNumbers(refs) {
  return new Set((refs || []).filter((r) => r.kind === 'scheme' || (r.scheme && !r.ds)).map((r) => r.key)).size >= 2
}

// ИНН (верная контрольная сумма) в названии. Сумма не сошлась — просто число.
const INN_RE = /(?<!\d)(?:\d{12}|\d{10})(?!\d)/g
const innsOf = (s) => sortedUnique((String(s).match(INN_RE) || []).filter((v) => isValidInn(v)))

// Разбор одного названия (уровня пути) для сопоставления.
const analyzeName = memo((name) => {
  const refs = extractContractReferences(name)
  const schemeRefs = refs.filter((r) => r.kind === 'scheme').map((r) => ({ key: r.key, alts: r.alts }))
  return {
    refs,
    schemeRefs,
    schemeKeys: sortedUnique(schemeRefs.map((r) => r.key)),
    dsKeys: sortedUnique(refs.filter((r) => r.kind === 'ds').map((r) => r.key)),
    legacyExplicit: sortedUnique(refs.filter((r) => r.kind === 'legacy' && r.explicit).map((r) => r.key)),
    legacyAll: sortedUnique(refs.filter((r) => r.kind === 'legacy').map((r) => r.key)),
    whole: legacyKey(scanText(name)) || '',
    inns: innsOf(String(name ?? '').slice(0, 1000)),
  }
})

// ── Признаки: корпус, очередь, секция ───────────────────────────────────────────────────────────────────────────────
// Типизированные: корпус сравнивается с корпусом, очередь с очередью. Годы, версии, номера приложений — не признаки.
// «Очередь 3.0» = «3», «корпус 1.0» = «1»; «Корпус 14 и 15», «14, 15», «14/15» — перечень; «14-15» — диапазон (если второе число
// больше первого; «6-1» = «6.1»); записи «14к», «К-14», «К 14», «K14», «3-й корпус», «корпуса 14» — тоже корпус (С-34, С-35).
const B = '(?<![\\p{L}\\p{N}])'
const NUMITEM = '\\d{1,3}(?:[.,-]\\d{1,3})?(?!\\d)[a-zа-я]?'
const GROUP = `${NUMITEM}(?:\\s*(?:[,;&/]|и|and)\\s*${NUMITEM})*`
const SEP = '\\.?\\s*(?:[№#]\\s*)?'
const ROMAN = '(IV|IX|VI{0,3}|I{1,3}|X)(?![\\p{L}\\p{N}])'
const ORD = '(?:й|я|е|го|ая|ой|ый|ое)'
// Число перед словом («3 корпус», «1 очередь») — не часть номера договора: без «№», точки, запятой, косой и дефиса перед ним.
const AFTER_NUM = '(?<![\\p{L}\\p{N}.,/-])(?<!№\\s*)(?<!#\\s*)'
const FEATURE_RES = {
  building: [
    new RegExp(`${B}(?:корпус(?:а|ы|ов)?|корп|кор|bldg|bld|building)${SEP}(${GROUP})`, 'giu'),
    new RegExp(`${B}[кk](?:\\.\\s*|-\\s*|(?=[№#\\d]))(?:[№#]\\s*)?(${GROUP})`, 'giu'),
    new RegExp(`${B}[КK]\\s(?=\\d)(${GROUP})`, 'gu'),
    new RegExp(`(?<![\\p{L}\\p{N}№#.,/-])(\\d{1,3})-?[кk](?![\\p{L}\\p{N}])`, 'giu'),
    new RegExp(`${B}(\\d{1,3})-${ORD}\\s*(?:корпус|корп)(?![\\p{L}\\p{N}])`, 'giu'),
    new RegExp(`${AFTER_NUM}(\\d{1,2})\\s+(?:корпус|корп)(?![\\p{L}\\p{N}])`, 'giu'),
  ],
  queue: [
    new RegExp(`${B}(?:очередь|очереди|оч|queue|phase)${SEP}(${GROUP})`, 'giu'),
    new RegExp(`${B}(?:очередь|очереди|оч|queue|phase)${SEP}${ROMAN}`, 'giu'),
    new RegExp(`${B}(\\d{1,3})-${ORD}\\s*(?:очередь|оч)(?![\\p{L}\\p{N}])`, 'giu'),
    new RegExp(`${AFTER_NUM}(\\d{1,2})\\s+(?:очередь|оч)(?![\\p{L}\\p{N}])`, 'giu'),
  ],
  section: [
    new RegExp(`${B}(?:секция|секции|секц|сек|section|sect)${SEP}(${GROUP})`, 'giu'),
    new RegExp(`${B}(\\d{1,3})-${ORD}\\s*(?:секция|сек)(?![\\p{L}\\p{N}])`, 'giu'),
    new RegExp(`${AFTER_NUM}(\\d{1,2})\\s+(?:секция|сек)(?![\\p{L}\\p{N}])`, 'giu'),
  ],
}
const ROMAN_VALUE = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 }
const LOOKALIKE_LOW = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' }
const ITEM_RE = /(\d{1,3})(?:([.,-])(\d{1,3}))?([a-zа-я])?/giu
const allZero = (v) => /^0+$/.test(v)

// Значения одного перечня/диапазона: «14 и 15» → 14, 15; «14-17» → 14…17; «6-1» и «6.1» → «6.1»; «3.0» → «3».
function groupValues(text) {
  const out = []
  for (const m of String(text).matchAll(ITEM_RE)) {
    const a = parseInt(m[1], 10)
    const sepc = m[2]
    const f = m[3]
    const tail = m[4] ? (LOOKALIKE_LOW[m[4].toLowerCase()] || m[4].toLowerCase()) : ''
    if (!sepc) { out.push(`${a}${tail}`); continue }
    const b = parseInt(f, 10)
    if (sepc === ',' && f.length >= 2 && b >= 10 && a >= 10) { out.push(`${a}`, `${b}${tail}`); continue }
    if (sepc === '-' && b > a && b - a <= 30) { for (let v = a; v <= b; v++) out.push(`${v}${v === b ? tail : ''}`); continue }
    out.push(allZero(f) ? `${a}${tail}` : `${a}.${f}${tail}`)
  }
  return out
}

function featureValues(m) {
  if (m[1] && !/^\d/.test(m[1])) { const v = ROMAN_VALUE[m[1].toUpperCase()]; return v ? [String(v)] : [] }
  return groupValues(m[1])
}

const featuresOf = memo((text) => {
  const out = { building: [], queue: [], section: [] }
  for (const [type, list] of Object.entries(FEATURE_RES)) {
    const vals = new Set()
    for (const re of list) for (const m of text.matchAll(re)) for (const v of featureValues(m)) vals.add(v)
    out[type] = [...vals].sort(cmp)
  }
  return out
})

// Признаки в пути папки от корня (названия через « / »).
export function pathFeatures(path) {
  const f = featuresOf(String(path ?? '').slice(0, 8000).normalize('NFC'))
  return { building: [...f.building], queue: [...f.queue], section: [...f.section] }
}

// Признаки объекта по его названию и коду («Дом 14, корп. 2»).
export function objectFeatures(name, code) {
  return pathFeatures([name, code].filter((v) => v != null && String(v).trim() !== '').join(' / '))
}

// Расхождение однотипных признаков: оба набора непусты и общего значения нет.
function featuresMismatch(a, b) {
  for (const type of ['building', 'queue', 'section']) {
    const x = a?.[type] || []
    const y = b?.[type] || []
    if (x.length && y.length && !x.some((v) => y.includes(v))) return true
  }
  return false
}
function featuresAgree(a, b) {
  for (const type of ['building', 'queue', 'section']) {
    const x = a?.[type] || []
    const y = b?.[type] || []
    if (x.length && y.length && x.some((v) => y.includes(v))) return true
  }
  return false
}

// Узел при записи снимка (staging): вычисленные поля для signal_nodes. numberKeys — только ключи по схеме (по ним ищет
// signal_match_nodes через GIN и по ним же сверяет SQL); features — только непустые типы.
// codes — коды объектов (необязательно): если код начинается с «01.»/«Альфа-» и похож на слитую приставку, известный код побеждает.
export function prepareNode({ name, path, codes } = {}) {
  const nm = String(name ?? '')
  const numberKeys = codes
    ? sortedUnique(extractContractReferences(nm, { codes }).filter((r) => r.kind === 'scheme').map((r) => r.key))
    : [...analyzeName(nm).schemeKeys]
  const f = pathFeatures(path || nm)
  const features = {}
  for (const type of ['building', 'queue', 'section']) if (f[type].length) features[type] = f[type]
  return { nameNorm: searchNorm(nm), numberKeys, features }
}

// Ключ «содержимого» узла для отказов (С-53): название и ключи номеров. Переименованная папка — другой узел для пары «договор — папка».
export function nodeKeyOf(node) {
  const n = node || {}
  const name = n.name != null ? searchNorm(n.name) : String(n.nameNorm ?? '')
  const keys = n.name != null ? analyzeName(String(n.name)).schemeKeys : sortedUnique(Array.isArray(n.numberKeys) ? n.numberKeys : [])
  return sha(['nk1', name, keys.join(',')].join('|'))
}

// ── Контекст договора ───────────────────────────────────────────────────────────────────────────────────────────────
// Пробельные знаки по краям снимает и база (osp_private.signal_norm_link): trim() + U+FEFF.
const EDGE_SPACE_RE = new RegExp(`^[\\s${chars(0xfeff)}]+|[\\s${chars(0xfeff)}]+$`, 'g')
const normLink = (v) => (v == null ? '' : String(v).replace(EDGE_SPACE_RE, ''))

function numberPart(c) {
  const nk = c.numberKey ?? numberKey(c.number)
  return nk || `n:${legacyKey(c.number) || ''}`
}

// Хеш делового контекста: номер (ключ по схеме или нормализованный), объект, вид, корневой ДП, стороны. Не входят: ссылка,
// даты, номер снимка, версия алгоритма — отказ/отвязка действуют, пока контекст тот же.
export function contractContextKey(contract) {
  const c = contract || {}
  const parties = (Array.isArray(c.counterparties) ? c.counterparties : []).map((p) => String(p?.id ?? '')).filter(Boolean).sort(cmp)
  return sha(['v1', numberPart(c), c.objectId || '', c.recordType || '', c.rootId || '', parties.join(',')].join('|'))
}

// Отпечаток: контекст + ссылка. Изменился — прежнее «сверено» недействительно.
export function contractFingerprint(contract) {
  return sha(`${contractContextKey(contract)}|${normLink(contract?.signalLink)}`)
}

// Семья ДС: корневой ДП по root_contract_id, резерв — цепочка parent_contract_id (≤ 10 шагов, цикл не зацикливает).
// lookup — Map, объект или функция id → { id, recordType, number, numberKey, objectId, signalLink, nodeId, parentId, rootId, deleted }.
export function resolveFamily(contract, lookup) {
  const get = typeof lookup === 'function' ? lookup
    : lookup instanceof Map ? (id) => lookup.get(id)
      : lookup && typeof lookup === 'object' ? (id) => lookup[id] : () => undefined
  const isDp = (r) => Boolean(r) && (r.recordType ?? 'dp') === 'dp'
  const pick = (r) => ({ id: r.id, number: r.number ?? null, numberKey: r.numberKey ?? numberKey(r.number), objectId: r.objectId ?? null,
    signalLink: r.signalLink ?? null, nodeId: r.nodeId ?? null, deleted: Boolean(r.deleted) })
  const c = contract || {}
  if (isDp(c)) return { dp: pick(c), cycle: false }
  if (c.rootId && c.rootId !== c.id) {
    const root = get(c.rootId)
    if (isDp(root)) return { dp: pick(root), cycle: false }
  }
  const seen = new Set([c.id])
  let cur = c
  for (let step = 0; step < 10; step++) {
    const pid = cur.parentId
    if (!pid) return { dp: null, cycle: false }
    if (seen.has(pid)) return { dp: null, cycle: true }
    seen.add(pid)
    const parent = get(pid)
    if (!parent) return { dp: null, cycle: false }
    if (isDp(parent)) return { dp: pick(parent), cycle: false }
    cur = parent
  }
  return { dp: null, cycle: false }
}

function normalizeContract(input) {
  const i = input || {}
  const recordType = i.recordType || 'dp'
  const family = i.family && typeof i.family === 'object' ? i.family
    : i.contractsById ? resolveFamily(i, i.contractsById) : { dp: null, cycle: false }
  return {
    id: i.id ?? null,
    recordType,
    isDp: recordType === 'dp',
    number: String(i.number ?? ''),
    numberKey: i.numberKey ?? numberKey(i.number),
    objectId: i.objectId || null,
    signalLink: normLink(i.signalLink),
    deleted: Boolean(i.deleted),
    counterparties: Array.isArray(i.counterparties) ? i.counterparties : [],
    family,
    stored: Array.isArray(i.candidates) ? i.candidates : [],
    input: i,
  }
}

// Собственный номер ДС: «ДС №3», «ДС-3», «Доп. соглашение 3» или просто «3» → «ДС|3»; иначе null.
function dsKeyOf(number) {
  const ref = extractContractReferences(number).find((r) => r.kind === 'ds')
  if (ref) return ref.key
  const m = /^\s*(?:№|N|No\.?)?\s*(\d+(?:[./-]\d+)*[A-Za-zА-Яа-я]?)\s*$/i.exec(String(number ?? ''))
  return m ? dsNumberKey(m[1]) : null
}

// ── Объекты, синонимы ───────────────────────────────────────────────────────────────────────────────────────────────
// Нормализованные названия, код и синонимы объекта для поиска в названиях папок. Синоним, совпавший с именем или кодом
// другого объекта, игнорируется (иначе имя чужого объекта «притянуло» бы папки): границу объекта синоним не задаёт.
export function objectTerms(object, objects) {
  if (!object) return []
  const foreign = new Set()
  for (const o of Array.isArray(objects) ? objects : []) {
    if (!o || o.id === object.id) continue
    for (const v of [o.name, o.code]) { const n = searchNorm(v); if (n) foreign.add(n) }
    const ck = codeKey(o.code); if (ck) foreign.add(ck.toLowerCase())
  }
  const terms = new Set()
  const add = (text, min) => { const n = searchNorm(text); if (n.length >= min) terms.add(n) }
  add(object.name, 4)
  add(object.code, 3)
  for (const a of Array.isArray(object.aliases) ? object.aliases : []) {
    const n = searchNorm(a?.text)
    const k = a?.key == null ? '' : String(a.key).toLowerCase()
    if (!n || foreign.has(n) || (k && foreign.has(k))) continue
    add(a.text, 4)
  }
  return [...terms].sort(cmp)
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const wordRe = (s) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(s)}(?![\\p{L}\\p{N}])`, 'u')
// Слово целиком, но не начало более длинного названия через дефис («Монолит» в «Монолит-Сервис»); «-ДП», «-ДС» — не продолжение.
const wholeWordRe = (s) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(s)}(?![\\p{L}\\p{N}])(?!-(?!дп|дс)\\p{L})`, 'u')

const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' }
const toLatin = (s) => String(s ?? '').toLowerCase().replace(/[а-яё]/g, (ch) => TRANSLIT[ch]).replace(/[^a-z0-9]+/g, '')

// Название стороны без формы собственности, нормализованное; null — слишком короткое для поиска.
function partyCore(name) {
  const raw = String(name ?? '').trim()
  const n = searchNorm(splitLegalForm(raw)?.name ?? raw).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  return n.length >= 4 ? n : null
}

function buildParties(counterparties) {
  const out = []
  for (const p of counterparties) {
    const core = partyCore(p?.name)
    const innDigits = String(p?.inn ?? '').replace(/\D+/g, '')
    const inn = isValidInn(innDigits) ? innDigits : null
    if (!core && !inn) continue
    const latin = core ? toLatin(core) : ''
    out.push({
      core, re: core ? wordRe(core) : null, whole: core ? wholeWordRe(core) : null, latin: latin.length >= 5 ? latin : '',
      inn, innRe: inn ? new RegExp(`(?<![0-9])${inn}(?![0-9])`) : null,
    })
  }
  return out
}

// ИНН сторон договора (только с верной контрольной суммой).
function ownInns(counterparties) {
  const set = new Set()
  for (const p of counterparties) {
    const d = String(p?.inn ?? '').replace(/\D+/g, '')
    if (isValidInn(d)) set.add(d)
  }
  return set
}

// ── Узлы ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const isObserved = (n, generation) => (typeof n.observed === 'boolean' ? n.observed
  : generation != null && n.seenGen != null && Number(n.seenGen) === Number(generation))

// Цепочка узла — имена от границы объекта (objectPath, spec §2.2; резерв — path) до самого узла.
function levelsOf(node) {
  const name = String(node.name ?? '')
  const path = String(node.objectPath ?? node.path ?? '')
  const levels = path ? path.split(' / ') : [name]
  if (levels[levels.length - 1] !== name && name) levels.push(name)
  return levels
}

// Разбор цепочки: chain[0] — название самого узла, дальше предки вверх до границы объекта.
function nodeFacts(node) {
  if (node._facts) return node._facts
  const names = levelsOf(node).slice(-40).reverse()
  const chain = names.map(analyzeName)
  const facts = {
    names, chain, own: chain[0] || analyzeName(''),
    features: pathFeatures(node.objectPath ?? node.path ?? node.name),
    nameNorm: searchNorm(node.name),
  }
  Object.defineProperty(node, '_facts', { value: facts, enumerable: false })
  return facts
}

const insideFolder = (node, folderId) => node.nodeId === folderId || (Array.isArray(node.pathIds) && node.pathIds.some((p) => lower(p) === folderId))

// Узел без скрытых данных: границы и наблюдаемость.
const hidden = (state, reason) => ({ state, reason, nodeId: null })

// Узел входит в выборку signal_match_nodes для этого договора (те же условия, что и в запросе nodeQueryFor).
function inQuery(q, node) {
  if (q.nodeIds.includes(node.nodeId)) return true
  if (node.kind !== 'folder') return false
  if (q.numberKeys.length && analyzeName(String(node.name ?? '')).schemeKeys.some((k) => q.numberKeys.includes(k))) return true
  if (q.objectIds.length && q.objectIds.includes(node.objectId)) {
    const norm = searchNorm(node.name)
    if (q.terms.some((t) => norm.includes(t))) return true
  }
  return q.under.length > 0 && Array.isArray(node.pathIds) && node.pathIds.some((p) => q.under.includes(lower(p)))
}

// Номер договора для сверки с названиями папок: ключ по схеме и номера старого вида — целиком («ДП №12» → «ДП-12») и без
// приставки («12»): папка, названная без приставки, тоже считается найденной.
function numberInfo(number, key) {
  const whole = legacyKey(number)
  const cores = extractContractReferences(number).filter((r) => r.kind === 'legacy').map((r) => r.key)
  return { key: key || null, legacies: sortedUnique([whole, ...cores].filter(legacyUsable)) }
}

function buildContext(input, { formats, generation, scoped = true } = {}) {
  const c = normalizeContract(input)
  const nodes = []
  const nodesById = new Map()
  // Результат не зависит от того, какие узлы по запросам других договоров пришли в той же выборке: берём только узлы,
  // которые вернул бы запрос именно этого договора (очередь и /match дают один ответ при любой разбивке на порции).
  const query = scoped ? nodeQueryFor(input, { formats }) : null
  for (const raw of Array.isArray(input?.nodes) ? input.nodes : []) {
    if (!raw || !raw.nodeId) continue
    const node = { ...raw, nodeId: lower(raw.nodeId) }
    if (query && !inQuery(query, node)) continue
    nodes.push(node)
    nodesById.set(node.nodeId, node)
  }
  const objects = Array.isArray(input?.objects) ? input.objects : []
  const object = objects.find((o) => o && o.id === c.objectId) || null
  const codeOwners = new Map()
  for (const o of objects) {
    const k = o && codeKey(o.code)
    if (!k) continue
    if (!codeOwners.has(k)) codeOwners.set(k, new Set())
    codeOwners.get(k).add(o.id)
  }
  const dp = !c.isDp && c.family && !c.family.cycle ? c.family.dp : null
  const prev = input?.state
  const ctx = {
    c, formats: Array.isArray(formats) ? formats : [], generation, nodes, nodesById, objects, object, codeOwners,
    objectFeatures: object ? objectFeatures(object.name, object.code) : { building: [], queue: [], section: [] },
    objectTerms: objectTerms(object, objects), objectTermRes: [],
    ctxKey: contractContextKey(input), parties: buildParties(c.counterparties), inns: ownInns(c.counterparties),
    dsKey: c.isDp ? null : dsKeyOf(c.number),
    // Номер самого договора (ДП) и номер корневого ДП для ДС — по ним сверяются названия папок (В-3: номер ДП берётся из семьи
    // независимо от наличия у ДП ссылки).
    num: numberInfo(c.number, c.numberKey),
    dpNum: dp && !dp.deleted ? numberInfo(dp.number, dp.numberKey ?? numberKey(dp.number)) : null,
    // Номер старого вида как основание предложения: у договора по схеме его нет; «особенные» (не короткие) номера ищутся в названии.
    legacyEvidence: [],
    legacyOwn: [],
    // Решение человека по тому же узлу сохраняется при пересчёте, пока нет жёсткого противоречия.
    confirmedNode: prev && prev.state === 'verified' && prev.reason === 'confirmed' && prev.confirmedBy && prev.nodeId ? lower(prev.nodeId) : null,
  }
  ctx.objectTermRes = ctx.objectTerms.map(wordRe)
  if (!c.numberKey) {
    ctx.legacyEvidence = ctx.num.legacies.filter(legacyStrong)
    ctx.legacyOwn = ctx.num.legacies
  }
  ctx.dpNode = resolveDpNode(ctx)
  return ctx
}

// ── Сверка названий папок с номерами ────────────────────────────────────────────────────────────────────────────────
// Уровень (разбор одного названия) содержит номер num = { key, legacies }: ключ по схеме (в том числе любой из других разборов
// кода) или номер старого вида (равный, как часть длинного номера, как слова в названии).
function levelMatches(a, num) {
  if (!num) return false
  if (num.key && a.schemeRefs.some((r) => r.key === num.key || r.alts.includes(num.key))) return true
  return num.legacies.some((k) => a.legacyAll.some((x) => x === k || runIn(x, k)) || (legacyStrong(k) && runIn(a.whole, k)))
}

// Расхождение номера (В-3, Б-1): на ближайшем уровне цепочки, где вообще названы номера (по схеме или явный старого вида),
// нет номера num → причина conflict; иначе null. Нет номеров или у договора нечего сравнивать — не противоречие.
function numberVerdict(ctx, chain, num) {
  if (!num || (!num.key && !num.legacies.length)) return null
  const lvl = chain.find((a) => a.schemeRefs.length || a.legacyExplicit.length)
  if (!lvl || levelMatches(lvl, num)) return null
  const mine = ctx.c.objectId
  const foreign = lvl.schemeRefs.some((r) => [r.key, ...r.alts].some((k) => {
    const owners = ctx.codeOwners.get(k.split('|')[0])
    return owners && !owners.has(mine)
  }))
  return foreign ? 'object_mismatch' : 'number_mismatch'
}

// Папка корневого ДП для ДС — только по ТЕКУЩЕЙ ссылке ДП (family.dp.signalLink), разрешённой в том же снимке.
// family.dp.nodeId (узел прежнего состояния ДП в signal_contracts) источником не служит: ссылку ДП могли сменить, а состояние
// ещё не пересчитано — ДС в той же порции увидел бы старую папку. Пустая ссылка ДП или формат не поддержан → папки нет.
// Узел обязан быть живой папкой того же объекта и не противоречить номеру ДП. Папка нужна только для предпочтения («внутри
// папки своего ДП — первыми»), а не как граница: ДС вне её тоже допустимы (В-3).
function resolveDpNode(ctx) {
  const { c } = ctx
  if (c.isDp || !c.family || c.family.cycle) return null
  const dp = c.family.dp
  if (!dp || dp.deleted || !c.objectId || dp.objectId !== c.objectId) return null
  if (!normLink(dp.signalLink)) return null
  const p = parseSignalUrl(dp.signalLink, ctx.formats)
  if (!p.ok || p.kind !== 'folder') return null
  const node = ctx.nodesById.get(p.nodeId)
  if (!node || (node.projectId && lower(node.projectId) !== p.projectId)) return null
  if (node.kind !== 'folder' || node.deleted === true) return null
  if (node.sourceEnabled !== true || node.sourceReady !== true || node.objectId !== c.objectId) return null
  if (!isObserved(node, ctx.generation)) return null
  if (numberVerdict(ctx, nodeFacts(node).chain, ctx.dpNum)) return null
  return node
}

// Жёсткое противоречие узла и договора → причина conflict или null (spec §2.3). Расположение папки само по себе не ошибка.
function contradiction(ctx, node) {
  const { c } = ctx
  const { chain, own } = nodeFacts(node)
  if (own.schemeKeys.length >= 2) return 'ambiguous'
  if (c.isDp) {
    const bad = numberVerdict(ctx, chain, ctx.num)
    if (bad) return bad
  } else {
    if (ctx.dsKey) {
      const lvl = chain.find((a) => a.dsKeys.length)
      if (lvl && !lvl.dsKeys.includes(ctx.dsKey)) return 'ds_mismatch'
    }
    if (ctx.dpNum && numberVerdict(ctx, chain, ctx.dpNum)) return 'foreign_dp'
  }
  // В-4: «чужая сторона» — только корректный ИНН другой организации; у договора нет ни одного ИНН — не проверяется.
  if (ctx.inns.size) {
    const lvl = chain.find((a) => a.inns.length)
    if (lvl && !lvl.inns.some((v) => ctx.inns.has(v))) return 'foreign_party'
  }
  return null
}

// Мягкие предупреждения: корпус, очередь или секция не совпали (В-11); ссылка ДП на папку допсоглашения — в собственном имени
// есть номер ДС (С-41: папка той же семьи, грубой ошибки нет). Подтверждать можно.
const buildingMismatch = (ctx, node) => featuresMismatch(ctx.objectFeatures, nodeFacts(node).features)
const kindMismatch = (ctx, node) => ctx.c.isDp && nodeFacts(node).own.dsKeys.length > 0

// Номер договора найден в названии узла или его предка (В-1).
function numberFound(ctx, node) {
  const { chain } = nodeFacts(node)
  if (ctx.c.isDp) return chain.some((a) => levelMatches(a, ctx.num))
  return (Boolean(ctx.dsKey) && chain.some((a) => a.dsKeys.includes(ctx.dsKey))) || (Boolean(ctx.dpNum) && chain.some((a) => levelMatches(a, ctx.dpNum)))
}

// Узел по введённой/выбранной ссылке: граница объекта, наблюдаемость, противоречия, положительный признак (В-1).
function assessNode(ctx, node) {
  const { c } = ctx
  if (node.sourceEnabled !== true || node.sourceReady !== true) return hidden('unverified', 'unavailable')
  if (node.objectId == null || !c.objectId || node.objectId !== c.objectId) return hidden('unverified', 'unavailable')
  const nodeId = node.nodeId
  const isItem = node.kind === 'item'
  if (isItem && node.deleted === true) return { state: 'missing', reason: 'deleted', nodeId }
  if (!isObserved(node, ctx.generation)) {
    return Number(node.absentNights) >= 2
      ? { state: 'attention', reason: isItem ? 'file_not_visible' : 'not_visible', nodeId }
      : { state: 'unverified', reason: 'not_observed', nodeId }
  }
  const conflict = contradiction(ctx, node)
  if (conflict) return { state: 'conflict', reason: conflict, nodeId }
  if (ctx.confirmedNode && ctx.confirmedNode === nodeId) return { state: 'verified', reason: 'confirmed', nodeId }
  if (kindMismatch(ctx, node)) return { state: 'attention', reason: 'kind_mismatch', nodeId }
  if (buildingMismatch(ctx, node)) return { state: 'attention', reason: 'building_mismatch', nodeId }
  return numberFound(ctx, node) ? { state: 'verified', reason: 'existing_url', nodeId } : { state: 'accepted', reason: 'number_not_found', nodeId }
}

// Проверка узла как выбора человека (для confirm): тот же код, что и у введённой ссылки. confirmable — verified, accepted и
// attention:building_mismatch|kind_mismatch (warning); conflict → маршрут отвечает hard_conflict без вызова SQL; прочее — подтверждать нельзя.
export function evaluateNode(input, nodeId, { generation } = {}) {
  const ctx = buildContext(input, { generation, scoped: false })
  const node = ctx.nodesById.get(lower(nodeId))
  const no = (reason) => ({ ...hidden('unverified', reason), confirmable: false, warning: null })
  if (!node || ctx.c.deleted) return no(Number(generation) > 0 ? 'unavailable' : 'no_snapshot')
  if (!ctx.c.objectId) return no('no_object')
  const r = assessNode(ctx, node)
  const warning = r.state === 'attention' && (r.reason === 'building_mismatch' || r.reason === 'kind_mismatch') ? r.reason : null
  return { ...r, confirmable: r.state === 'verified' || r.state === 'accepted' || warning !== null, warning }
}

// ── Кандидаты ───────────────────────────────────────────────────────────────────────────────────────────────────────
const containsLegacy = (a, key) => runIn(a.whole, key)

function evidenceFor(ctx, node) {
  const { c } = ctx
  const facts = nodeFacts(node)
  const own = facts.own
  const reasons = []
  const flags = []
  let exact = false
  if (c.isDp) {
    if (ctx.num.key && own.schemeRefs.some((r) => r.key === ctx.num.key || r.alts.includes(ctx.num.key))) reasons.push('number')
    else if (ctx.legacyEvidence.some((k) => containsLegacy(own, k))) {
      reasons.push('number_legacy')
      exact = ctx.legacyOwn.some((k) => own.legacyAll.includes(k))
    }
  } else {
    if (ctx.dsKey && own.dsKeys.includes(ctx.dsKey)) reasons.push('ds_number')
    else if (ctx.legacyEvidence.some((k) => containsLegacy(own, k))) reasons.push('number_legacy')
    // Номер корневого ДП назван в пути — ДС в «своей» ветке (находка С-3: ДС ищется и по номеру ДП в пути).
    if (reasons.length && ctx.dpNum && facts.chain.some((a) => levelMatches(a, ctx.dpNum))) reasons.push('number')
  }
  if (c.isDp) {
    const nameLatin = toLatin(facts.nameNorm)
    let inn = false
    let named = false
    let similar = false
    for (const p of ctx.parties) {
      if (p.innRe && p.innRe.test(String(node.name ?? ''))) inn = true
      if (p.re && p.re.test(facts.nameNorm)) {
        // С-44: общее начало названия («Монолит» в «Монолит-Сервис») — не та же организация: слабее и с пометкой «похоже».
        if (p.whole.test(facts.nameNorm)) named = true
        else similar = true
      } else if (p.latin && nameLatin.includes(p.latin)) similar = true
    }
    if (inn) reasons.push('inn')
    if (named) reasons.push('counterparty')
    else if (similar) { reasons.push('name_similar'); flags.push('similar') }
  }
  if (!reasons.some((r) => PRIMARY.has(r))) return null
  // Название или синоним объекта сравнивается с любым звеном пути от границы объекта (С-45), а не только с именем папки.
  if (ctx.objectTermRes.length && facts.names.some((nm, i) => { const n = i === 0 ? facts.nameNorm : searchNorm(nm); return ctx.objectTermRes.some((re) => re.test(n)) })) {
    reasons.push('object_name')
  }
  if (featuresAgree(ctx.objectFeatures, facts.features)) reasons.push('features')
  return { reasons, flags, exact }
}

function buildCandidates(ctx, excludeNodeId) {
  const { c } = ctx
  if (c.deleted || !c.objectId) return { list: [], unlinkedSuppressed: false }
  const stored = new Map(c.stored.filter((s) => s && s.nodeId).map((s) => [lower(s.nodeId), s]))
  let unlinkedSuppressed = false
  const found = []
  for (const node of ctx.nodes) {
    if (node.kind !== 'folder' || node.deleted === true || node.nodeId === excludeNodeId) continue
    if (node.sourceEnabled !== true || node.sourceReady !== true || node.objectId !== c.objectId) continue
    if (!isObserved(node, ctx.generation)) continue
    if (contradiction(ctx, node)) continue
    const ev = evidenceFor(ctx, node)
    if (!ev) continue
    const reasons = [...ev.reasons]
    const flags = [...ev.flags]
    let score = reasons.reduce((s, r) => s + WEIGHT[r], 0)
    if (ev.exact) score += EXACT_LEGACY_BONUS
    if (!c.isDp && ctx.dpNode && insideFolder(node, ctx.dpNode.nodeId)) score += IN_DP_FOLDER_BONUS
    // С-41: папка допсоглашения для ДП не исключается, а понижается (папка самого договора выше).
    if (kindMismatch(ctx, node)) { flags.push('kind_mismatch'); score = Math.max(0, score - KIND_PENALTY) }
    // В-11: расхождение корпуса — мягкое: кандидат остаётся, но ниже.
    if (buildingMismatch(ctx, node)) { flags.push('building_mismatch'); score = Math.max(0, score - BUILDING_PENALTY) }
    const nodeKey = nodeKeyOf(node)
    const old = stored.get(node.nodeId)
    if (old && (old.status === 'rejected' || old.status === 'unlinked')) {
      // Отказ действует, пока тот же контекст договора и тот же узел (С-53): переименованная папка возвращается.
      const sameCtx = old.ctxKey == null || old.ctxKey === ctx.ctxKey
      const sameNode = old.nodeKey == null || old.nodeKey === nodeKey
      if (sameCtx && sameNode) { if (old.status === 'unlinked') unlinkedSuppressed = true; continue }
      flags.push(old.status === 'rejected' ? 'previously_rejected' : 'previously_unlinked')
    }
    found.push({
      nodeId: node.nodeId, score, nodeKey,
      reasons: REASON_ORDER.filter((r) => reasons.includes(r)),
      flags: FLAG_ORDER.filter((f) => flags.includes(f)),
      kindMismatch: flags.includes('kind_mismatch') ? 1 : 0,
      sortPath: String(node.objectPath ?? node.path ?? ''), strong: reasons.some((r) => STRONG.has(r)),
    })
  }
  // Есть папка с номером — остальные (по названию стороны) не предлагаем: это шум рядом с точным совпадением.
  const pool = found.some((f) => f.strong) ? found.filter((f) => f.strong) : found
  // Равные баллы: папка допсоглашения после папки договора, затем путь (ICU en-US) и id.
  pool.sort((a, b) => b.score - a.score || a.kindMismatch - b.kindMismatch || cmpPath(a.sortPath, b.sortPath) || cmp(a.nodeId, b.nodeId))
  // Подавленная пара (отвязана при том же контексте) — не кандидат, но причина «none:unlinked» остаётся.
  if (!unlinkedSuppressed) {
    unlinkedSuppressed = c.stored.some((s) => s && s.status === 'unlinked' && (s.ctxKey == null || s.ctxKey === ctx.ctxKey))
  }
  return {
    list: pool.slice(0, MAX_CANDIDATES).map(({ nodeId, score, reasons, flags, nodeKey }) => ({ nodeId, score, reasons, flags, nodeKey })),
    unlinkedSuppressed,
  }
}

// ── Сопоставление договора ──────────────────────────────────────────────────────────────────────────────────────────
// input — элемент contracts[] из signal_match_load (5.1) + nodes (5.2, из signal_match_nodes) + objects. Узел может прийти с
// objectPath (путь от границы объекта): для уровней и признаков берётся он, иначе path. Ответ:
// { state, reason, nodeId, candidates:[{nodeId, score, reasons, flags, nodeKey}], fingerprint, ctxKey }. nodeId — только узел,
// который виден договору (в границе объекта); для unavailable, no_snapshot и т. п. он всегда null.
// pending (очередь новее) сопоставитель не знает — его добавляет сервер.
export function matchContract(input, { formats, generation, scoped } = {}) {
  const ctx = buildContext(input, { formats, generation, scoped })
  const { c } = ctx
  const out = (state, reason, nodeId, candidates) => ({
    state, reason, nodeId: nodeId || null, candidates: candidates || [],
    fingerprint: contractFingerprint(input), ctxKey: ctx.ctxKey,
  })
  if (c.deleted) return out('none', 'none')
  if (!c.objectId) return out(c.signalLink ? 'unverified' : 'none', 'no_object')

  if (!c.signalLink) {
    const { list, unlinkedSuppressed } = buildCandidates(ctx, null)
    if (list.length) return out('suggested', 'candidates', null, list)
    return out('none', unlinkedSuppressed ? 'unlinked' : 'none')
  }

  const link = linkResult(ctx)
  let candidates = []
  if (link.state !== 'verified') {
    candidates = buildCandidates(ctx, link.nodeId).list
    // Зелёное «номер не найден» не окружаем слабыми догадками: рядом — только папки с номером.
    if (link.state === 'accepted') candidates = candidates.filter((x) => x.reasons.some((r) => STRONG.has(r) || r === 'number_legacy'))
  }
  return out(link.state, link.reason, link.nodeId, candidates)
}

function linkResult(ctx) {
  const { c } = ctx
  const parsed = parseSignalUrl(c.signalLink, ctx.formats)
  if (!parsed.ok) return hidden('unverified', 'unsupported_url')
  if (Array.isArray(ctx.c.input.rootProjectIds) && !ctx.c.input.rootProjectIds.map(lower).includes(parsed.projectId)) {
    return hidden('unverified', 'unavailable')
  }
  const node = ctx.nodesById.get(parsed.nodeId)
  if (!node) return hidden('unverified', Number(ctx.generation) > 0 ? 'unavailable' : 'no_snapshot')
  if (node.projectId && lower(node.projectId) !== parsed.projectId) return hidden('unverified', 'unavailable')
  if (node.kind && node.kind !== parsed.kind) return hidden('unverified', 'unavailable')
  return assessNode(ctx, node)
}

// Что запросить у signal_match_nodes для договора: { nodeIds, numberKeys, objectIds, terms, under } (все списки отсортированы).
//   nodeIds    — узел ссылки договора и узел из текущей ссылки его корневого ДП;
//   numberKeys — ключ номера ДП по схеме;
//   objectIds + terms — папки объекта, в названии которых есть сторона, ИНН, номер старого вида или номер ДС. Термы дублируются
//                       с разными разделителями (С-42); чтобы не потерять записи с латинскими двойниками, для номера старого
//                       вида добавляется самый длинный числовой фрагмент (≥ 3 цифр). Знаки «%» и «\» не передаются (SQL ещё и
//                       экранирует шаблон LIKE);
//   under      — папка корневого ДП для ДС: искать в ней и её подпапках.
const TERM_SEPS = ['-', ' ', '_', '/', '.', ' - ']
export function nodeQueryFor(input, { formats } = {}) {
  const c = normalizeContract(input)
  const empty = { nodeIds: [], numberKeys: [], objectIds: [], terms: [], under: [] }
  if (c.deleted) return empty
  const fmts = Array.isArray(formats) ? formats : []
  const nodeIds = new Set()
  const under = new Set()
  if (c.signalLink) {
    const p = parseSignalUrl(c.signalLink, fmts)
    if (p.ok) nodeIds.add(p.nodeId)
  }
  const dp = !c.isDp && c.family && !c.family.cycle ? c.family.dp : null
  // Папка корневого ДП — только по текущей ссылке ДП; узел прежнего состояния ДП (family.dp.nodeId) не запрашивается.
  if (dp && !dp.deleted && normLink(dp.signalLink)) {
    const p = parseSignalUrl(dp.signalLink, fmts)
    if (p.ok && p.kind === 'folder') { nodeIds.add(p.nodeId); under.add(p.nodeId) }
  }
  const terms = new Set()
  if (c.isDp) {
    for (const p of buildParties(c.counterparties)) {
      if (p.core) { terms.add(p.core); if (p.latin) terms.add(p.latin) }
      if (p.inn) terms.add(p.inn)
    }
    if (!c.numberKey) {
      // «ДП №СУ2-ПРИМ14-0215» ищется и без приставки: берётся сам номер, а не вся запись
      const info = numberInfo(c.number, null).legacies.filter(legacyStrong)
      const cores = extractContractReferences(c.number).filter((r) => r.kind === 'legacy' && legacyStrong(r.key)).map((r) => r.key)
      const bases = cores.length ? cores : info
      if (bases.length) terms.add(searchNorm(c.number))
      for (const legacy of bases) {
        const parts = legacy.split('-')
        for (const sep of TERM_SEPS) terms.add(parts.join(sep).toLowerCase())
        const digits = parts.filter((x) => /^\d{3,}$/.test(x)).sort((a, b) => b.length - a.length || cmp(a, b))[0]
        if (digits) terms.add(digits)
      }
    }
  } else {
    // ДС ищется и по своему номеру, и вне известной папки ДП (В-3); номер ДП в пути проверяет сопоставитель.
    const ds = dsKeyOf(c.number)
    if (ds) {
      const n = ds.slice(3).toLowerCase()
      for (const t of [`дс ${n}`, `дс-${n}`, `дс${n}`, `дс №${n}`, `дс № ${n}`, `дс n${n}`, `д/с ${n}`, `соглашение № ${n}`, `соглашение №${n}`,
        `соглашение ${n}`, `согл. ${n}`, `согл.${n}`]) terms.add(t)
    }
  }
  const clean = [...terms].filter((t) => t.length >= 3 && t.length <= 100 && !/[%\\]/.test(t)).sort(cmp).slice(0, 30)
  return {
    nodeIds: [...nodeIds].sort(cmp),
    numberKeys: c.isDp && c.numberKey ? [c.numberKey] : [],
    objectIds: c.objectId && clean.length ? [c.objectId] : [],
    terms: clean,
    under: [...under].sort(cmp),
  }
}
