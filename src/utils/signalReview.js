// «Signal» в реестре договоров: состояния значка, подписи, причины и итоги сверки. Чистые функции — без запросов и разметки
// (tests/contracts/signal-review.test.mjs). Состояния и причины считает сервер (раздел 3 спецификации): здесь только
// русские подписи и разбор ответов. Чужих имён, путей и счётчиков в подписях нет — только общая причина.

export const SIGNAL_STATES = ['none', 'suggested', 'verified', 'unverified', 'attention', 'missing', 'conflict']

// «Сверка Signal» (один переключатель): предложение, противоречие, папка не видна, файл удалён. «Ожидает» (pending) — не здесь.
export const REVIEW_STATES = ['suggested', 'conflict', 'attention', 'missing']
// Жёлтый «!»: ссылка есть, но с ней что-то не так.
export const WARN_STATES = ['conflict', 'attention', 'missing']

export const isReviewState = (state) => REVIEW_STATES.includes(state)

// Подпись состояния без подсказки сервера (tip): цвет — не единственный носитель смысла.
export const STATE_LABEL = {
  none: 'Signal: ссылки нет',
  suggested: 'Signal: предложена папка',
  verified: 'Signal: сверено',
  unverified: 'Signal: ссылка не сверялась',
  attention: 'Signal: папка не видна в Signal',
  missing: 'Signal: файл удалён в Signal',
  conflict: 'Signal: противоречие',
}

// Короткие названия состояний — для разбивки итога импорта.
export const STATE_SHORT = {
  verified: 'сверено',
  suggested: 'предложена папка',
  conflict: 'противоречие',
  attention: 'папка не видна',
  missing: 'файл удалён',
  unverified: 'ссылка не сверена',
  none: 'нет ссылки',
}

// Общая причина состояния (reason) — без имён и путей.
export const REASON_TEXT = {
  none: 'ссылки нет',
  candidates: 'есть предложенные папки',
  family_unknown: 'папка договора, к которому относится ДС, не определена',
  existing_url: 'ссылка совпала с папкой',
  confirmed: 'подтверждено человеком',
  unsupported_url: 'формат ссылки не поддерживается',
  outside_roots: 'папка вне подключённых папок Signal',
  root_disabled: 'папка Signal отключена',
  not_in_snapshot: 'папки ещё нет в данных Signal',
  no_snapshot: 'данных Signal ещё нет',
  object_unassigned: 'папке не назначен объект',
  not_observed: 'папка не видна в последнем обходе',
  not_visible: 'папка не видна в Signal',
  deleted: 'файл удалён в Signal',
  object_mismatch: 'объект папки не совпадает с объектом договора',
  number_mismatch: 'номер в папке не совпадает с номером договора',
  building_mismatch: 'корпус или очередь в папке не совпадают с договором',
  foreign_dp: 'папка относится к другому договору',
  ambiguous: 'в названии папки несколько номеров',
  pending: 'сверка ждёт обработки',
  unlinked: 'связь снята',
}
export const reasonText = (code) => REASON_TEXT[code] || ''

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
  family_unknown: 'папка договора, к которому относится ДС, не определена — подтвердить нельзя',
  previously_rejected: 'уже отклоняли при прежних реквизитах',
  previously_unlinked: 'уже отвязывали при прежних реквизитах',
}
export const candidateReasonText = (code) => CANDIDATE_REASON_TEXT[code] || 'совпал признак'
export const candidateFlagText = (code) => CANDIDATE_FLAG_TEXT[code] || 'нужна проверка'

// Флажок «Запомнить … как название объекта»: объект в пути папки назван иначе, чем в портале (в причинах кандидата нет
// object_name) — это название стоит запомнить как синоним. Есть object_name — объект уже узнан по названию или синониму.
export const suggestsAlias = (candidate) => !!candidate && !(candidate.reasons || []).includes('object_name')

// Папку с этим признаком подтвердить нельзя (сервер ответит 409 confirm_unavailable): папка договора, к которому относится ДС,
// не определена.
export const isUnconfirmable = (candidate) => (candidate?.flags || []).includes('family_unknown')

// Значок Signal. look: 'plain' — как без Signal (зелёный/красный по заполненности ссылки), 'suggest' — красный с синей
// точкой, 'warn' — жёлтый с «!». Метки нет — 'plain', значок ровно как раньше.
export function markLook(mark) {
  if (!mark) return 'plain'
  if (mark.state === 'suggested') return 'suggest'
  if (WARN_STATES.includes(mark.state)) return 'warn'
  return 'plain'
}

// Подпись значка: подсказка сервера (tip) или подпись состояния; ссылка — второй строкой. review — нажатие откроет сверку.
export function markTitle(mark, { link = '', canReview = false, canAdd = false } = {}) {
  const base = mark.tip || STATE_LABEL[mark.state] || 'Signal'
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

// Итог сверки импорта (Ф5): три непересекающиеся группы по уникальным id успешно созданных документов.
// найдено = verified + suggested; внимание = conflict + attention + missing; ожидают = остальное (none, unverified, pending)
// и документы, на которые сервер не ответил. Повторный ответ по тому же id не удваивает, чужие id не считаются.
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
    if (state === 'verified' || state === 'suggested') found++
    else if (WARN_STATES.includes(state)) attention++
    else waiting++
  }
  return { total: wanted.length, found, attention, waiting, unanswered, byState }
}

export const summaryLine = (s) =>
  `Signal: сверено или найдено ${s.found} · требуют внимания ${s.attention} · ожидают сверки ${s.waiting}`

// Разбивка по состояниям — подсказкой к строке итога.
export function summaryTitle(s) {
  const parts = Object.keys(STATE_SHORT).filter((k) => s.byState[k]).map((k) => `${STATE_SHORT[k]}: ${s.byState[k]}`)
  if (s.unanswered) parts.push(`нет ответа сервера: ${s.unanswered}`)
  return `Всего документов: ${s.total}${parts.length ? ` · ${parts.join(' · ')}` : ''}`
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
