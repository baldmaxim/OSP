// «Signal» в реестре договоров: состояния значка, подписи, причины и итоги сверки. Чистые функции — без запросов и разметки
// (tests/contracts/signal-review.test.mjs). Состояния и причины считает сервер (раздел 1 спецификации волны исправлений,
// server/osp-api/src/lib/signalMatch.js): здесь только русские подписи и разбор ответов. Чужих имён, путей и счётчиков в
// подписях нет — только общая причина.

// Те же восемь состояний, что у сервера (STATES): accepted — «ссылка принята, номер в папке не найден» (В-1).
export const SIGNAL_STATES = ['none', 'suggested', 'verified', 'accepted', 'unverified', 'attention', 'missing', 'conflict']

// «Сверка Signal» (один переключатель): предложение, противоречие, папка или файл не виден, файл удалён. Зелёные состояния
// (verified, accepted, unverified) и «ожидает» (pending) — не здесь.
export const REVIEW_STATES = ['suggested', 'conflict', 'attention', 'missing']
// Жёлтый «!»: ссылка есть, но с ней что-то не так.
export const WARN_STATES = ['conflict', 'attention', 'missing']

export const isReviewState = (state) => REVIEW_STATES.includes(state)

// Подпись состояния без подсказки сервера (tip): цвет — не единственный носитель смысла.
export const STATE_LABEL = {
  none: 'Signal: ссылки нет',
  suggested: 'Signal: предложена папка',
  verified: 'Signal: сверено',
  accepted: 'Signal: ссылка принята, номер в папке не найден',
  unverified: 'Signal: ссылка не сверялась',
  attention: 'Signal: папка не видна в Signal',
  missing: 'Signal: файл удалён в Signal',
  conflict: 'Signal: противоречие',
}

// Короткие названия состояний — для разбивки итога импорта.
export const STATE_SHORT = {
  verified: 'сверено',
  accepted: 'ссылка принята',
  suggested: 'предложена папка',
  conflict: 'противоречие',
  attention: 'не видна',
  missing: 'файл удалён',
  unverified: 'ссылка не сверена',
  none: 'нет ссылки',
}

// Общая причина состояния (reason) — без имён и путей. Ключи — ровно REASONS сервера (сторож — signal-review.test.mjs).
export const REASON_TEXT = {
  none: 'ссылки нет',
  unlinked: 'связь снята',
  no_object: 'у договора не указан объект',
  candidates: 'есть предложенные папки',
  existing_url: 'ссылка совпала с папкой',
  confirmed: 'подтверждено человеком',
  number_not_found: 'ссылка принята, номер в папке не найден',
  unsupported_url: 'формат ссылки не поддерживается',
  unavailable: 'папка недоступна для сверки',
  no_snapshot: 'данных Signal ещё нет',
  not_observed: 'папка не видна в последнем обходе',
  pending: 'сверка ждёт обработки',
  not_visible: 'папка не видна в Signal',
  file_not_visible: 'файл не виден в Signal',
  building_mismatch: 'корпус, очередь или секция не совпали',
  deleted: 'файл удалён в Signal',
  object_mismatch: 'объект папки не совпадает с объектом договора',
  number_mismatch: 'номер в папке не совпадает с номером договора',
  ambiguous: 'в названии папки несколько номеров',
  foreign_dp: 'папка относится к другому договору',
  ds_mismatch: 'номер ДС не совпал с номером в названии папки',
  kind_mismatch: 'папка относится к допсоглашению',
  foreign_party: 'в названии папки ИНН другой организации',
}
export const reasonText = (code) => REASON_TEXT[code] || ''

// Подпись значка по паре «состояние : причина», когда подсказки сервера (tip) нет (метка только что слита из ответа решения или
// /match, перезагрузка меток ещё не пришла). Противоречие называет причину; иначе — подпись состояния.
const REASON_LABEL = {
  'attention:file_not_visible': 'Signal: файл не виден в Signal',
  'attention:building_mismatch': 'Signal: корпус, очередь или секция не совпали — проверьте',
  'attention:kind_mismatch': 'Signal: папка относится к допсоглашению — проверьте',
  'unverified:unavailable': 'Signal: папка недоступна для сверки',
  'unverified:no_object': 'Signal: у договора не указан объект',
  'none:no_object': 'Signal: у договора не указан объект',
}
export function stateLabel(state, reason = null) {
  const exact = REASON_LABEL[`${state}:${reason}`]
  if (exact) return exact
  if (state === 'conflict' && reasonText(reason)) return `Signal: противоречие — ${reasonText(reason)}`
  return STATE_LABEL[state] || 'Signal'
}

// Признаки, по которым сервер предложил папку (candidates[].reasons), и пометки к ним (flags): ровно MATCH_REASONS и MATCH_FLAGS
// сопоставителя (server/osp-api/src/lib/signalMatch.js; сторож — tests/contracts/signal-review.test.mjs).
export const CANDIDATE_REASON_TEXT = {
  number: 'номер совпал',
  number_legacy: 'номер совпал с названием папки',
  ds_number: 'номер ДС совпал',
  inn: 'ИНН контрагента в названии папки',
  counterparty: 'контрагент в названии папки',
  name_similar: 'название контрагента похоже',
  object_name: 'объект назван в папке',
  features: 'корпус, очередь или секция совпали',
}
export const CANDIDATE_FLAG_TEXT = {
  similar: 'совпадение по сходству названия — проверьте',
  // В-11, С-41: мягкие предупреждения — подтвердить можно, но человек видит, что корпус, очередь или секция не те или что это папка
  // допсоглашения, а не договора.
  building_mismatch: 'Корпус, очередь или секция не совпали — проверьте',
  kind_mismatch: 'Папка допсоглашения, а не договора — проверьте',
  previously_rejected: 'уже отклоняли при прежних реквизитах',
  previously_unlinked: 'уже отвязывали при прежних реквизитах',
}
export const candidateReasonText = (code) => CANDIDATE_REASON_TEXT[code] || 'совпал признак'
export const candidateFlagText = (code) => CANDIDATE_FLAG_TEXT[code] || 'нужна проверка'

// Флажок «Запомнить … как название объекта»: объект в пути папки назван иначе, чем в портале (в причинах кандидата нет
// object_name) — это название стоит запомнить как синоним. Есть object_name — объект уже узнан по названию или синониму.
export const suggestsAlias = (candidate) => !!candidate && !(candidate.reasons || []).includes('object_name')

// Мягкие предупреждения (attention): подтвердить можно, но человек должен их увидеть. Ответ confirm несёт warning с тем же кодом.
export const SOFT_REASONS = ['building_mismatch', 'kind_mismatch']
export const isSoftReason = (reason) => SOFT_REASONS.includes(reason)

// Предупреждение у кандидата: флаг building_mismatch (корпус, очередь, секция) или kind_mismatch (папка ДС вместо договора).
export const hasSoftWarning = (candidate) => (candidate?.flags || []).some(isSoftReason)
export const hasBuildingWarning = (candidate) => (candidate?.flags || []).includes('building_mismatch')

// Плашка и сообщение для мягкого предупреждения: «Корпус, очередь или секция не совпали — проверьте», «Папка относится к
// допсоглашению — проверьте». Другие коды предупреждений — без текста (пустая строка).
export function softWarningText(code) {
  const text = isSoftReason(code) ? reasonText(code) : ''
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)} — проверьте` : ''
}

// Текущую папку договора (ссылка уже есть) человек может подтвердить: «ссылка принята, номер не найден» и мягкие предупреждения
// (корпус, вид документа). Остальные состояния с ссылкой (противоречие, папка не видна, файл удалён) подтвердить нельзя; сверено —
// подтверждать нечего. Решает сервер (evaluateNode, §2.5): здесь только выбор, показывать ли кнопку.
export const isCurrentConfirmable = (state, reason = null) =>
  state === 'accepted' || (state === 'attention' && isSoftReason(reason))

// Значок Signal. look: 'plain' — как без Signal (зелёный/красный по заполненности ссылки; сюда же accepted и unverified),
// 'suggest' — красный с синей точкой, 'warn' — жёлтый с «!». Метки нет — 'plain', значок ровно как раньше.
export function markLook(mark) {
  if (!mark) return 'plain'
  if (mark.state === 'suggested') return 'suggest'
  if (WARN_STATES.includes(mark.state)) return 'warn'
  return 'plain'
}

// Подпись значка: подсказка сервера (tip) или подпись состояния; ссылка — второй строкой. review — нажатие откроет сверку.
export function markTitle(mark, { link = '', canReview = false, canAdd = false } = {}) {
  const base = mark.tip || stateLabel(mark.state, mark.reason)
  const hint = canReview ? ' — нажмите, чтобы сверить' : (canAdd && !link ? ' — нажмите, чтобы указать' : '')
  return `${base}${hint}${link ? `\n${link}` : ''}`
}

// Метки, которые попадают в «Сверку Signal»: Map id → метка (или массив меток) → Set id.
export function signalReviewIds(marks) {
  const out = new Set()
  if (!marks) return out
  const list = marks instanceof Map ? marks.values() : marks
  for (const m of list) if (m && m.id && !m.pending && isReviewState(m.state)) out.add(m.id)
  return out
}

// Метка «ссылка не сверялась» (С-9): ставится сразу после правки ссылки человеком, до ответа сервера; сбой сверки её не сбрасывает.
export function pendingMark(id) {
  return { id, state: 'unverified', reason: 'pending', pending: true, tip: stateLabel('unverified', 'pending'), hasCandidate: false }
}

// Сообщение после сохранения (Р8) по ответу /match для одного документа: { kind, text, path } или null (ничего не нашлось).
export function matchNotice(item) {
  if (!item) return null
  if (item.state === 'suggested') {
    const path = String(item.path || '').trim()
    return { kind: 'found', text: path ? `Найдена папка в Signal: ${path}` : 'Найдена папка в Signal' }
  }
  if (WARN_STATES.includes(item.state)) {
    const why = reasonText(item.reason) || STATE_LABEL[item.state].replace(/^Signal: /, '')
    return { kind: 'warn', text: `Signal: ${why} — проверьте` }
  }
  return null
}

// Метка из ответа /match: в реестре сразу виден значок нового состояния (подсказку пришлёт следующая загрузка меток).
export function markFromMatch(item) {
  return { id: item.id, state: item.state, reason: item.reason ?? null, pending: false, tip: '', hasCandidate: !!item.hasCandidate }
}

// Итог сверки импорта (Ф5, В-9): три непересекающиеся группы по уникальным id успешно созданных документов.
// найдено = verified + accepted + suggested; внимание = conflict + attention + missing; без папки или ожидают = всё остальное
// (none, unverified, в том числе pending) и документы, на которые сервер не ответил. Повторный ответ по тому же id не удваивает,
// чужие id не считаются.
const FOUND_STATES = ['verified', 'accepted', 'suggested']
export function summarizeMatch(ids, items) {
  const wanted = [...new Set((ids || []).filter(Boolean))]
  const byId = new Map()
  for (const it of items || []) if (it && it.id) byId.set(it.id, it)
  const byState = {}
  let found = 0
  let attention = 0
  let waiting = 0
  let unanswered = 0
  for (const id of wanted) {
    const it = byId.get(id)
    if (!it) { unanswered++; waiting++; continue }
    const state = it.state || 'none'
    byState[state] = (byState[state] || 0) + 1
    if (FOUND_STATES.includes(state)) found++
    else if (WARN_STATES.includes(state)) attention++
    else waiting++
  }
  return { total: wanted.length, found, attention, waiting, unanswered, byState }
}

export const summaryLine = (s) =>
  `Signal: найдено ${s.found} · требуют внимания ${s.attention} · без папки или ожидают ${s.waiting}`

// Разбивка по состояниям — подсказкой к строке итога.
export function summaryTitle(s) {
  const parts = Object.keys(STATE_SHORT).filter((k) => s.byState[k]).map((k) => `${STATE_SHORT[k]}: ${s.byState[k]}`)
  if (s.unanswered) parts.push(`нет ответа сервера: ${s.unanswered}`)
  return `Всего документов: ${s.total}${parts.length ? ` · ${parts.join(' · ')}` : ''}`
}

// Полоса над реестром (В-7): данные Signal устарели. dataAt — наименьшее время данных включённых корней (status.dataAt, ISO).
// Дата — по Москве, как подсказки сервера; formatter — ruDateTime (передаётся, чтобы модуль остался без зависимостей).
export function staleNotice(status, formatDateTime) {
  if (!status || status.enabled !== true || status.stale !== true) return ''
  const at = status.dataAt ? formatDateTime(status.dataAt) : ''
  return at
    ? `Данные Signal обновлялись ${at} — сверка может быть устаревшей`
    : 'Данные Signal давно не обновлялись — сверка может быть устаревшей'
}

// Ключи идемпотентности окна сверки — по одному на попытку «действие + папка»: повтор той же попытки (после потерянного ответа
// или ошибки сети) идёт с тем же ключом и получает сохранённый результат, а другое действие или другая папка — с новым,
// иначе сервер вернул бы чужой сохранённый ответ. reset() — после успеха, оставившего окно открытым.
export function attemptKeys(newKey) {
  let current = null
  return {
    keyFor(action, nodeId) {
      const sig = `${action}\u0000${nodeId}`
      if (!current || current.sig !== sig) current = { sig, key: newKey() }
      return current.key
    },
    reset() { current = null },
  }
}
