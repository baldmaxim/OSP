// Сопоставление договоров ОСП с папками Signal — чистые функции, без базы и без сети (интеграция OSP ↔ SIGNAL, раздел 2–3, 5
// спецификации). Один и тот же код вызывают очередь (signalJobs.js), маршрут POST /api/signal/match и проверка перед confirm.
//
// Что функции НЕ делают: не пишут ссылку (её меняет только человек через confirm/replace/unlink), не обращаются к Signal,
// не запрашивают пользовательский URL (он только разбирается). Пользовательская ссылка — это строка; её адрес сравнивается с
// шаблонами SIGNAL_URL_FORMATS по точному хосту, только https, без userinfo и порта.
//
// Источник решений — «таблица 9.1» плана ред. 3 и Ф1/Ф2 судейства: узел вне границы объекта договора (object_id узла NULL или
// другой) никогда не кандидат; при введённой ссылке на него — unverified:outside_roots / object_unassigned, а чужие id и
// имена наружу (nodeId, путь) не выдаются.
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
  unverified: 'Не сверено',
  attention: 'Требует внимания',
  missing: 'Файл удалён в Signal',
  conflict: 'Противоречие',
})

// Причины состояний (state:reason). Тексты общие — чужие имена, пути и id в них не попадают.
export const REASONS = Object.freeze({
  none: 'Ссылки нет',
  unlinked: 'Связь снята',
  candidates: 'Есть предложенные папки',
  existing_url: 'Введённая ссылка найдена в снимке',
  confirmed: 'Связь подтверждена человеком',
  unsupported_url: 'Формат ссылки не поддержан',
  outside_roots: 'Папка вне доступного объекта',
  root_disabled: 'Корень выключен или не готов',
  not_in_snapshot: 'Папки нет в снимке',
  no_snapshot: 'Снимка Signal ещё нет',
  object_unassigned: 'Объект папки не назначен',
  family_unknown: 'Папка договора, к которому относится ДС, не определена',
  not_observed: 'Папка не видна в последнем обходе',
  not_visible: 'Папка не видна в Signal',
  deleted: 'Файл удалён в Signal',
  object_mismatch: 'Номер в названии папки принадлежит другому объекту',
  number_mismatch: 'Номер договора не совпал с номером в названии папки',
  building_mismatch: 'Корпус, очередь или секция не совпали',
  foreign_dp: 'ДС вне папки своего договора или в папке чужого договора',
  ambiguous: 'В названии папки несколько номеров договоров',
  pending: 'Ожидает пересчёта',
})

// Допустимые пары state → reason (по таблице раздела 3 спецификации; pending ставит сервер по очереди, не сопоставитель).
export const STATE_REASONS = Object.freeze(Object.fromEntries(Object.entries({
  none: ['none', 'unlinked'],
  suggested: ['candidates'],
  verified: ['existing_url', 'confirmed'],
  unverified: ['unsupported_url', 'outside_roots', 'root_disabled', 'not_in_snapshot', 'no_snapshot', 'object_unassigned',
    'not_observed', 'family_unknown', 'pending'],
  attention: ['not_visible'],
  missing: ['deleted'],
  conflict: ['object_mismatch', 'number_mismatch', 'building_mismatch', 'foreign_dp', 'ambiguous'],
}).map(([k, v]) => [k, Object.freeze(v)])))

// Причины, по которым папка предложена договору (кандидат).
export const MATCH_REASONS = Object.freeze({
  number: 'Номер договора по схеме совпал с номером в названии папки',
  number_legacy: 'Номер договора совпал с названием папки',
  ds_number: 'Номер ДС совпал с номером в названии папки',
  inn: 'ИНН контрагента в названии папки',
  counterparty: 'Название контрагента в названии папки',
  name_similar: 'Название контрагента похоже (транслитерация)',
  object_name: 'Название или синоним объекта в названии папки',
  features: 'Корпус, очередь или секция совпали с объектом',
})
export const MATCH_FLAGS = Object.freeze({
  similar: 'Совпадение по сходству названия — проверьте',
  family_unknown: 'Папка договора, к которому относится ДС, не определена — подтвердить нельзя',
  previously_rejected: 'Эту папку уже отклоняли при прежних реквизитах',
  previously_unlinked: 'Эту папку уже отвязывали при прежних реквизитах',
})
const REASON_ORDER = Object.keys(MATCH_REASONS)
const FLAG_ORDER = Object.keys(MATCH_FLAGS)
const WEIGHT = { number: 100, ds_number: 90, number_legacy: 80, inn: 60, counterparty: 40, name_similar: 15, object_name: 15, features: 10 }
const PRIMARY = new Set(['number', 'ds_number', 'number_legacy', 'inn', 'counterparty', 'name_similar'])
const STRONG = new Set(['number', 'ds_number'])
const FAMILY_UNKNOWN_PENALTY = 60
const MAX_CANDIDATES = 10

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v)
const lower = (v) => String(v ?? '').toLowerCase()
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32)
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const sortedUnique = (list) => [...new Set(list)].sort(cmp)

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
  const s = String(value ?? '').toUpperCase().replace(/Ё/g, 'Е')
    .replace(/[ABCEHKMOPTXY]/g, (ch) => LOOKALIKE_UP[ch])
    .replace(/[^0-9A-ZА-Я]+/g, '-').replace(/^-+|-+$/g, '')
  return s || null
}

// Номер старого вида достаточно «особенный» для поиска по названию: буквы и цифры, не короче 5 знаков, не «б/н».
function legacyStrong(key) {
  return Boolean(key) && key.length >= 5 && /\d/.test(key) && /[A-ZА-Я]/.test(key) && !/^Б-?Н(-|$)/.test(key)
}

const EXT_RE = /\.(?:pdf|docx?|xlsx?|xlsm|rtf|odt|ods|txt|jpe?g|png|gif|bmp|heic|tiff?|zip|rar|7z|xml|dwg|msg|eml|pptx?|csv)$/i
const TOKEN_RE = /[0-9A-Za-zА-Яа-яЁё](?:[0-9A-Za-zА-Яа-яЁё./-]*[0-9A-Za-zА-Яа-яЁё])?/g
// Слова-приставки перед номером, склеенные с ним дефисом: «ДП-АЛИЯ-ДП-26-001».
const PREFIX_WORDS = new Set(['ДП', 'ДС', 'DP', 'DS', 'ДОГ', 'ДОГОВОР', 'ДОГОВОРА', 'ДОП', 'N', 'NO', 'НО'])
const MARKER_WORDS = new Set(['ДП', 'DP', 'ДОГОВОР', 'ДОГОВОРА', 'ДОГ', 'N', 'NO', 'НО', 'КОНТРАКТ'])
const DS_WORDS = new Set(['ДС', 'DS', 'Д.С'])
const NUMBERLIKE_RE = /^\d+(?:[./-]\d+)*[A-Za-zА-Яа-я]?$/
const FEATURE_TOKEN_RE = /^(?:корп|корпус|кор|к|bldg|bld|building|оч|очередь|queue|phase|сек|секц|секция|section|v|ver|rev|ред|прил|приложение)\.?-?\d+$/i

// Ключ номера по схеме у токена: приставки снимаются, хвост/голова через точку («…-001.v2») отбрасываются.
function schemeOfToken(tok) {
  const variants = [tok]
  if (tok.includes('.')) {
    const parts = tok.split('.')
    for (let k = 1; k <= Math.min(3, parts.length - 1); k++) {
      variants.push(parts.slice(0, parts.length - k).join('.'), parts.slice(k).join('.'))
    }
  }
  for (const v of variants) {
    if (!v) continue
    const parts = v.split('-')
    let rest = parts
    while (rest.length > 1 && PREFIX_WORDS.has(rest[0].toUpperCase()) && numberKey(rest.slice(1).join('-'))) rest = rest.slice(1)
    const joined = rest.join('-')
    const key = numberKey(joined)
    if (key) return { raw: joined, key }
  }
  return null
}

// Все ссылки на номера в названии файла/папки (W1-10). Расширение снимается; пробелы, «_», «№» — границы токенов; приставки
// «ДП», «№», «N» не часть номера. [{ raw, key, scheme, ds }]:
//   • scheme:true — номер по схеме КОД-ДП-ГГ-NNN, key = numberKey (= SQL contract_number_key);
//   • ds:true — собственный номер ДС («ДС 3», «ДС-3», «Доп. соглашение № 3»), key = «ДС|<номер>»;
//   • иначе — номер старого вида после явной приставки («ДП №СУ10-…») или единственный токен имени, key = legacyKey.
// Несколько разных ключей по схеме — неоднозначность (hasAmbiguousNumbers), а не выбор первого.
export function extractContractReferences(name) {
  let s = String(name ?? '').slice(0, 1000).normalize('NFC')
  for (let i = 0; i < 2 && EXT_RE.test(s); i++) s = s.replace(EXT_RE, '')
  const tokens = []
  let m
  TOKEN_RE.lastIndex = 0
  while ((m = TOKEN_RE.exec(s)) !== null) tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length })
  const refs = []
  const seen = new Set()
  const push = (raw, key, scheme, ds) => {
    const id = `${ds ? 'ds' : scheme ? 's' : 'l'}|${key}`
    if (seen.has(id)) return
    seen.add(id)
    refs.push({ raw, key, scheme, ds })
  }
  const upper = (t) => t.text.toUpperCase()
  let dsPending = false
  tokens.forEach((tok, i) => {
    const prev = i > 0 ? tokens[i - 1] : null
    const gap = prev ? s.slice(prev.end, tok.start) : s.slice(0, tok.start)
    const wasDsPending = dsPending
    dsPending = false
    const up = upper(tok)
    if (DS_WORDS.has(up) || /^доп\.?согл/i.test(tok.text) || (/^согл/i.test(tok.text) && prev && /^доп/i.test(prev.text))) { dsPending = true; return }
    if (wasDsPending && NUMBERLIKE_RE.test(tok.text)) { push(tok.text, `ДС|${legacyKey(tok.text)}`, false, true); return }
    // Номер ДС одним токеном: «ДС-3», «ДС3», «ДС.3».
    const one = /^(?:ДС|DS)[.-]?(\d[0-9A-Za-zА-Яа-я./-]*)$/i.exec(tok.text)
    if (one && !schemeOfToken(tok.text)) { push(one[1], `ДС|${legacyKey(one[1])}`, false, true); return }
    // Номер по схеме: токен целиком или любая из частей через «/».
    const pieces = tok.text.includes('/') ? [tok.text, ...tok.text.split('/')] : [tok.text]
    let found = false
    for (const piece of pieces) {
      const sch = schemeOfToken(piece)
      if (sch) { push(sch.raw, sch.key, true, false); found = true; if (piece === tok.text) break }
    }
    if (found) return
    // Номер старого вида: после явной приставки или единственный токен.
    const bound = (prev && MARKER_WORDS.has(upper(prev))) || gap.includes('№')
    const key = legacyKey(tok.text)
    if (!key || FEATURE_TOKEN_RE.test(tok.text)) return
    if (bound && /\d/.test(key)) push(tok.text, key, false, false)
    else if (tokens.length === 1 && legacyStrong(key)) push(tok.text, key, false, false)
    else if (tokens.length === 2 && prev && PREFIX_WORDS.has(upper(prev)) && legacyStrong(key)) push(tok.text, key, false, false)
  })
  return refs
}

// Несколько разных номеров по схеме в одном названии — неоднозначность.
export function hasAmbiguousNumbers(refs) {
  return new Set((refs || []).filter((r) => r.scheme && !r.ds).map((r) => r.key)).size >= 2
}

const analyzeName = memo((name) => {
  const refs = extractContractReferences(name)
  return {
    schemeKeys: sortedUnique(refs.filter((r) => r.scheme && !r.ds).map((r) => r.key)),
    dsKeys: sortedUnique(refs.filter((r) => r.ds).map((r) => r.key)),
  }
})

// ── Признаки: корпус, очередь, секция ───────────────────────────────────────────────────────────────────────────────
// Типизированные: корпус сравнивается с корпусом, очередь с очередью. Годы, версии, номера приложений — не признаки.
const B = '(?<![\\p{L}\\p{N}])'
const NUM = '(\\d{1,3})(?:[.,-](\\d{1,2}))?([a-zа-я])?(?![\\p{L}\\p{N}])'
const ROMAN = '(IV|IX|VI{0,3}|I{1,3}|X)(?![\\p{L}\\p{N}])'
const SEP = '\\.?\\s*[№#]?\\s*'
const FEATURE_RES = {
  building: [
    new RegExp(`${B}(?:корпус|корп|кор|bldg|bld|building)${SEP}${NUM}`, 'giu'),
    new RegExp(`${B}к(?:\\.\\s*|(?=[№#\\d]))[№#]?\\s*${NUM}`, 'giu'),
  ],
  queue: [
    new RegExp(`${B}(?:очередь|оч|queue|phase)${SEP}${NUM}`, 'giu'),
    new RegExp(`${B}(?:очередь|оч|queue|phase)${SEP}${ROMAN}`, 'giu'),
  ],
  section: [
    new RegExp(`${B}(?:секция|секц|сек|section|sect)${SEP}${NUM}`, 'giu'),
  ],
}
const ROMAN_VALUE = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 }
const LOOKALIKE_LOW = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' }

function featureValue(m) {
  if (m.length >= 2 && !/^\d/.test(m[1])) return String(ROMAN_VALUE[m[1].toUpperCase()] ?? '')
  let v = String(parseInt(m[1], 10))
  if (m[2]) v += `.${m[2]}`
  if (m[3]) v += LOOKALIKE_LOW[m[3].toLowerCase()] || m[3].toLowerCase()
  return v
}

const featuresOf = memo((text) => {
  const out = { building: [], queue: [], section: [] }
  for (const [type, list] of Object.entries(FEATURE_RES)) {
    const vals = new Set()
    for (const re of list) {
      for (const m of text.matchAll(re)) {
        const v = featureValue(m)
        if (v) vals.add(v)
      }
    }
    out[type] = [...vals].sort(cmp)
  }
  return out
})

// Признаки в пути папки от корня (названия через « / »).
export function pathFeatures(path) {
  const f = featuresOf(String(path ?? '').normalize('NFC'))
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
// signal_match_nodes через GIN); features — только непустые типы.
export function prepareNode({ name, path } = {}) {
  const nm = String(name ?? '')
  const refs = analyzeName(nm)
  const f = pathFeatures(path || nm)
  const features = {}
  for (const type of ['building', 'queue', 'section']) if (f[type].length) features[type] = f[type]
  return { nameNorm: normMatchName(nm), numberKeys: [...refs.schemeKeys], features }
}

// ── Контекст договора ───────────────────────────────────────────────────────────────────────────────────────────────
const normLink = (v) => (v == null ? '' : String(v).trim())

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
  const ref = extractContractReferences(number).find((r) => r.ds)
  if (ref) return ref.key
  const m = /^\s*(?:№|N|No\.?)?\s*(\d+(?:[./-]\d+)*[A-Za-zА-Яа-я]?)\s*$/i.exec(String(number ?? ''))
  return m ? `ДС|${legacyKey(m[1])}` : null
}

const containsLegacy = (name, key) => Boolean(key) && `-${legacyKey(name) || ''}-`.includes(`-${key}-`)

// ── Объекты, синонимы ───────────────────────────────────────────────────────────────────────────────────────────────
// Нормализованные названия, код и синонимы объекта для поиска в названиях папок. Синоним, совпавший с именем или кодом
// другого объекта, игнорируется (иначе имя чужого объекта «притянуло» бы папки): границу объекта синоним не задаёт.
export function objectTerms(object, objects) {
  if (!object) return []
  const foreign = new Set()
  for (const o of Array.isArray(objects) ? objects : []) {
    if (!o || o.id === object.id) continue
    for (const v of [o.name, o.code]) { const n = normMatchName(v); if (n) foreign.add(n) }
    const ck = codeKey(o.code); if (ck) foreign.add(ck.toLowerCase())
  }
  const terms = new Set()
  const add = (text, min) => { const n = normMatchName(text); if (n.length >= min) terms.add(n) }
  add(object.name, 4)
  add(object.code, 3)
  for (const a of Array.isArray(object.aliases) ? object.aliases : []) {
    const n = normMatchName(a?.text)
    const k = a?.key == null ? '' : String(a.key).toLowerCase()
    if (!n || foreign.has(n) || (k && foreign.has(k))) continue
    add(a.text, 4)
  }
  return [...terms].sort(cmp)
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const wordRe = (s) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(s)}(?![\\p{L}\\p{N}])`, 'u')

const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' }
const toLatin = (s) => String(s ?? '').toLowerCase().replace(/[а-яё]/g, (ch) => TRANSLIT[ch]).replace(/[^a-z0-9]+/g, '')

// Название стороны без формы собственности, нормализованное; null — слишком короткое для поиска.
function partyCore(name) {
  const raw = String(name ?? '').trim()
  const n = normMatchName(splitLegalForm(raw)?.name ?? raw).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
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
      core, re: core ? wordRe(core) : null, latin: latin.length >= 5 ? latin : '',
      inn, innRe: inn ? new RegExp(`(?<![0-9])${inn}(?![0-9])`) : null,
    })
  }
  return out
}

// ── Узлы ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const isObserved = (n, generation) => (typeof n.observed === 'boolean' ? n.observed
  : generation != null && n.seenGen != null && Number(n.seenGen) === Number(generation))

function levelsOf(node) {
  const name = String(node.name ?? '')
  const path = String(node.path ?? '')
  const levels = path ? path.split(' / ') : [name]
  if (levels[levels.length - 1] !== name && name) levels.push(name)
  return levels
}

function nodeFacts(ctx, node) {
  if (node._facts) return node._facts
  const own = analyzeName(String(node.name ?? ''))
  let eff = own.schemeKeys
  if (!eff.length) {
    const levels = levelsOf(node)
    for (let i = levels.length - 2; i >= 0 && !eff.length; i--) eff = analyzeName(levels[i]).schemeKeys
  }
  const facts = {
    ownKeys: new Set(own.schemeKeys), effKeys: new Set(eff), ownDs: new Set(own.dsKeys),
    features: pathFeatures(node.path || node.name), nameNorm: normMatchName(node.name),
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
    const norm = normMatchName(node.name)
    if (q.terms.some((t) => norm.includes(t))) return true
  }
  return q.under.length > 0 && Array.isArray(node.pathIds) && node.pathIds.some((p) => q.under.includes(lower(p)))
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
  const ctx = {
    c, formats: Array.isArray(formats) ? formats : [], generation, nodes, nodesById, objects, object, codeOwners,
    objectFeatures: object ? objectFeatures(object.name, object.code) : { building: [], queue: [], section: [] },
    objectTerms: objectTerms(object, objects), objectTermRes: [],
    ctxKey: contractContextKey(input), parties: buildParties(c.counterparties),
    dsKey: c.isDp ? null : dsKeyOf(c.number),
    // Номер по схеме принадлежит ДП: по нему ДС не ищется (у ДС «номер ДП» в поле — ошибка данных, а не признак).
    legacy: c.numberKey ? null : legacyKey(c.number),
  }
  ctx.objectTermRes = ctx.objectTerms.map(wordRe)
  ctx.legacyStrong = legacyStrong(ctx.legacy)
  ctx.dpNode = resolveDpNode(ctx)
  return ctx
}

// Папка корневого ДП для ДС — только по ТЕКУЩЕЙ ссылке ДП (family.dp.signalLink), разрешённой в том же снимке.
// family.dp.nodeId (узел прежнего состояния ДП в signal_contracts) источником не служит: ссылку ДП могли сменить, а состояние
// ещё не пересчитано — ДС в той же порции увидел бы старую папку. Пустая ссылка ДП или формат не поддержан → папки нет.
// Узел обязан быть живой папкой того же объекта и не противоречить номеру ДП, иначе семья считается неизвестной.
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
  const facts = nodeFacts(ctx, node)
  if (dp.numberKey && facts.effKeys.size && !facts.effKeys.has(dp.numberKey)) return null
  return node
}

// Жёсткое противоречие узла и договора → причина conflict или null.
function contradiction(ctx, node) {
  const { c } = ctx
  const facts = nodeFacts(ctx, node)
  if (facts.ownKeys.size >= 2) return 'ambiguous'
  if (c.isDp) {
    if (c.numberKey && facts.effKeys.size && !facts.effKeys.has(c.numberKey)) {
      const foreignCode = [...facts.effKeys].some((k) => {
        const owners = ctx.codeOwners.get(k.split('|')[0])
        return owners && !owners.has(c.objectId)
      })
      return foreignCode ? 'object_mismatch' : 'number_mismatch'
    }
  } else if (ctx.dpNode) {
    if (!insideFolder(node, ctx.dpNode.nodeId)) return 'foreign_dp'
    const dpKey = c.family.dp.numberKey
    if (dpKey && facts.effKeys.size && !facts.effKeys.has(dpKey)) return 'foreign_dp'
  }
  if (featuresMismatch(ctx.objectFeatures, facts.features)) return 'building_mismatch'
  return null
}

// Узел по введённой/выбранной ссылке: граница объекта, наблюдаемость, противоречия.
function assessNode(ctx, node) {
  const { c } = ctx
  if (node.sourceEnabled !== true || node.sourceReady !== true) return hidden('unverified', 'root_disabled')
  if (node.objectId == null) return hidden('unverified', 'object_unassigned')
  if (!c.objectId || node.objectId !== c.objectId) return hidden('unverified', 'outside_roots')
  const nodeId = node.nodeId
  if (node.kind === 'item' && node.deleted === true) return { state: 'missing', reason: 'deleted', nodeId }
  if (!isObserved(node, ctx.generation)) {
    return Number(node.absentNights) >= 2
      ? { state: 'attention', reason: 'not_visible', nodeId }
      : { state: 'unverified', reason: 'not_observed', nodeId }
  }
  const conflict = contradiction(ctx, node)
  if (conflict) return { state: 'conflict', reason: conflict, nodeId }
  if (!c.isDp && !ctx.dpNode) return { state: 'unverified', reason: 'family_unknown', nodeId }
  return { state: 'verified', reason: 'existing_url', nodeId }
}

// Проверка узла как выбора человека (для confirm): тот же код, что и у введённой ссылки. confirmable — только verified;
// conflict → маршрут отвечает hard_conflict без вызова SQL; family_unknown/not_observed/… — подтверждать нельзя.
export function evaluateNode(input, nodeId, { generation } = {}) {
  const ctx = buildContext(input, { generation, scoped: false })
  const node = ctx.nodesById.get(lower(nodeId))
  if (!node || ctx.c.deleted) {
    return { ...hidden('unverified', Number(generation) > 0 ? 'not_in_snapshot' : 'no_snapshot'), confirmable: false }
  }
  const r = assessNode(ctx, node)
  return { ...r, confirmable: r.state === 'verified' }
}

// ── Кандидаты ───────────────────────────────────────────────────────────────────────────────────────────────────────
function evidenceFor(ctx, node) {
  const { c } = ctx
  const facts = nodeFacts(ctx, node)
  const reasons = []
  const flags = []
  if (c.isDp) {
    if (c.numberKey && facts.ownKeys.has(c.numberKey)) reasons.push('number')
    else if (ctx.legacyStrong && containsLegacy(node.name, ctx.legacy)) reasons.push('number_legacy')
  } else {
    if (ctx.dsKey && facts.ownDs.has(ctx.dsKey)) reasons.push('ds_number')
    else if (ctx.legacyStrong && containsLegacy(node.name, ctx.legacy)) reasons.push('number_legacy')
  }
  if (c.isDp) {
    const nameLatin = toLatin(facts.nameNorm)
    let inn = false
    let named = false
    let similar = false
    for (const p of ctx.parties) {
      if (p.innRe && p.innRe.test(String(node.name ?? ''))) inn = true
      if (p.re && p.re.test(facts.nameNorm)) named = true
      else if (p.latin && nameLatin.includes(p.latin)) similar = true
    }
    if (inn) reasons.push('inn')
    if (named) reasons.push('counterparty')
    else if (similar) { reasons.push('name_similar'); flags.push('similar') }
  }
  if (!reasons.some((r) => PRIMARY.has(r))) return null
  if (ctx.objectTermRes.some((re) => re.test(facts.nameNorm))) reasons.push('object_name')
  if (featuresAgree(ctx.objectFeatures, facts.features)) reasons.push('features')
  return { reasons, flags }
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
    if (!c.isDp && ctx.dpNode && !insideFolder(node, ctx.dpNode.nodeId)) continue
    if (contradiction(ctx, node)) continue
    const ev = evidenceFor(ctx, node)
    if (!ev) continue
    const reasons = [...ev.reasons]
    const flags = [...ev.flags]
    let score = reasons.reduce((s, r) => s + WEIGHT[r], 0)
    if (!c.isDp && !ctx.dpNode) { flags.push('family_unknown'); score = Math.max(0, score - FAMILY_UNKNOWN_PENALTY) }
    const old = stored.get(node.nodeId)
    if (old && (old.status === 'rejected' || old.status === 'unlinked')) {
      if (old.ctxKey == null || old.ctxKey === ctx.ctxKey) { if (old.status === 'unlinked') unlinkedSuppressed = true; continue }
      flags.push(old.status === 'rejected' ? 'previously_rejected' : 'previously_unlinked')
    }
    found.push({
      nodeId: node.nodeId, score,
      reasons: REASON_ORDER.filter((r) => reasons.includes(r)),
      flags: FLAG_ORDER.filter((f) => flags.includes(f)),
      path: String(node.path ?? ''), strong: reasons.some((r) => STRONG.has(r)),
    })
  }
  // Есть папка с номером — остальные (по названию стороны) не предлагаем: это шум рядом с точным совпадением.
  const pool = found.some((f) => f.strong && !f.flags.includes('family_unknown')) ? found.filter((f) => f.strong) : found
  pool.sort((a, b) => b.score - a.score || cmp(a.path, b.path) || cmp(a.nodeId, b.nodeId))
  // Подавленная пара (отвязана при том же контексте) — не кандидат, но причина «none:unlinked» остаётся.
  if (!unlinkedSuppressed) {
    unlinkedSuppressed = c.stored.some((s) => s && s.status === 'unlinked' && (s.ctxKey == null || s.ctxKey === ctx.ctxKey))
  }
  return { list: pool.slice(0, MAX_CANDIDATES).map(({ nodeId, score, reasons, flags }) => ({ nodeId, score, reasons, flags })), unlinkedSuppressed }
}

// ── Сопоставление договора ──────────────────────────────────────────────────────────────────────────────────────────
// input — элемент contracts[] из signal_match_load (5.1) + nodes (5.2, из signal_match_nodes) + objects. Ответ:
// { state, reason, nodeId, candidates:[{nodeId, score, reasons, flags}], fingerprint, ctxKey }. nodeId — только узел, который
// виден договору (в границе объекта); для outside_roots, object_unassigned, root_disabled и т. п. он всегда null.
// pending (очередь новее) сопоставитель не знает — его добавляет сервер.
export function matchContract(input, { formats, generation, scoped } = {}) {
  const ctx = buildContext(input, { formats, generation, scoped })
  const { c } = ctx
  const out = (state, reason, nodeId, candidates) => ({
    state, reason, nodeId: nodeId || null, candidates: candidates || [],
    fingerprint: contractFingerprint(input), ctxKey: ctx.ctxKey,
  })
  if (c.deleted) return out('none', 'none')

  if (!c.signalLink) {
    const { list, unlinkedSuppressed } = buildCandidates(ctx, null)
    if (list.length) return out('suggested', 'candidates', null, list)
    return out('none', unlinkedSuppressed ? 'unlinked' : 'none')
  }

  const link = linkResult(ctx)
  const candidates = link.state === 'verified' ? [] : buildCandidates(ctx, link.nodeId).list
  return out(link.state, link.reason, link.nodeId, candidates)
}

function linkResult(ctx) {
  const { c } = ctx
  const parsed = parseSignalUrl(c.signalLink, ctx.formats)
  if (!parsed.ok) return hidden('unverified', 'unsupported_url')
  if (Array.isArray(ctx.c.input.rootProjectIds) && !ctx.c.input.rootProjectIds.map(lower).includes(parsed.projectId)) {
    return hidden('unverified', 'outside_roots')
  }
  const node = ctx.nodesById.get(parsed.nodeId)
  if (!node) return hidden('unverified', Number(ctx.generation) > 0 ? 'not_in_snapshot' : 'no_snapshot')
  if (node.projectId && lower(node.projectId) !== parsed.projectId) return hidden('unverified', 'outside_roots')
  if (node.kind && node.kind !== parsed.kind) return hidden('unverified', 'not_in_snapshot')
  return assessNode(ctx, node)
}

// Что запросить у signal_match_nodes для договора: { nodeIds, numberKeys, objectIds, terms, under } (все списки отсортированы).
//   nodeIds    — узел ссылки договора и узел из текущей ссылки его корневого ДП;
//   numberKeys — ключ номера ДП по схеме;
//   objectIds + terms — папки объекта, в названии которых есть сторона, ИНН или номер старого вида (без «%», «_», «\» — их LIKE
//                       понимает как шаблон);
//   under      — папка корневого ДП для ДС: искать в ней и её подпапках.
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
    const legacy = legacyKey(c.number)
    if (!c.numberKey && legacyStrong(legacy)) {
      // как набрано, через дефис и через пробел: name_norm не унифицирует разделители
      for (const t of [normMatchName(c.number), legacy.toLowerCase(), legacy.toLowerCase().replace(/-/g, ' ')]) terms.add(t)
    }
  } else if (!under.size) {
    const ds = dsKeyOf(c.number)
    if (ds) { const n = ds.slice(3).toLowerCase(); for (const t of [`дс ${n}`, `дс-${n}`, `дс${n}`, `дс №${n}`]) terms.add(t) }
  }
  const clean = [...terms].filter((t) => t.length >= 3 && t.length <= 100 && !/[%_\\]/.test(t)).sort(cmp).slice(0, 20)
  return {
    nodeIds: [...nodeIds].sort(cmp),
    numberKeys: c.isDp && c.numberKey ? [c.numberKey] : [],
    objectIds: c.objectId && clean.length ? [c.objectId] : [],
    terms: clean,
    under: [...under].sort(cmp),
  }
}
