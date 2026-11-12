// Непрочитанные сообщения обсуждения заявок на проверку ДП/ДС (11.11.2026, просьба пользователя: «чтобы непрочитанное
// сообщение в обсуждении подсвечивалось цветом»).
//
// До миграции 20270216 «прочитано» хранится в браузере (localStorage, по пользователю) — как прочитанные уведомления
// (NotificationsContext). Цена — отметка своя у каждого браузера: прочитанное на телефоне на компьютере останется новым.
// С миграцией — в базе, см. «Отметки в базе» ниже.
//
// Непрочитанное — сообщение коллеги позже всех трёх границ:
//   • since — первое открытие доски в этом браузере: всё, что написано раньше, считается прочитанным (иначе в первый раз
//     подсветились бы все переписки разом — прочитанного до этого дня никто не отмечал);
//   • seen[заявка] — самое позднее сообщение коллеги, которое было на экране (окно заявки с перепиской);
//   • своё последнее сообщение в заявке — ответил, значит прочитал всё, что было до ответа.
// Время сообщения — от базы (created_at ставит триггер), сравниваем время базы со временем базы; since — часы браузера,
// расхождение в минуты здесь не важно.

const VERSION = 'v1'
// Отметок не больше, чем заявок на доске с запасом: на 11.11 их ~870. Лишние — самые давние.
const MAX_SEEN = 3000

export const talkReadKey = (userId) => `docCheckTalkRead:${VERSION}:${userId}`

const toMs = (value) => {
  const ms = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

function parse(raw) {
  try {
    const v = JSON.parse(raw)
    if (!v || !Number.isFinite(v.since) || typeof v.seen !== 'object' || v.seen === null) return null
    return { since: v.since, seen: { ...v.seen } }
  } catch {
    return null
  }
}

function storageGet(key) {
  try { return localStorage.getItem(key) } catch { return null }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* приватный режим, нет места — отметка живёт до перезагрузки */ }
}

// Отметки пользователя. Нет их — первое открытие: всё прежнее прочитано, граница — сейчас (и сразу записываем её, чтобы
// следующая загрузка страницы не сдвинула границу и не «прочитала» новое за пользователя).
export function loadTalkReads(userId, now = Date.now()) {
  const key = talkReadKey(userId)
  const stored = parse(storageGet(key))
  if (stored) return stored
  const fresh = { since: now, seen: {} }
  storageSet(key, fresh)
  return fresh
}

// ── Отметки в базе (миграция 20270216, решение пользователя 12.11.2026: «у каждого человека отдельный статус прочтения») ──
// С миграцией «прочитано» хранит база — своё у каждого сотрудника, одно и то же на телефоне и компьютере (doc_check_talk_reads,
// функции doc_check_talk_state / doc_check_talk_mark). Вид тот же — { since, seen }, правила непрочитанного те же. Отметки этого
// браузера при первом входе переносятся в базу (граница и прочитанное — ничего не подсветится заново) и здесь больше не хранятся.

// Отметки браузера как есть — без новой записи (для переноса в базу). Нет — null.
export function readLocalTalkReads(userId) {
  return userId ? parse(storageGet(talkReadKey(userId))) : null
}

export function dropLocalTalkReads(userId) {
  try { localStorage.removeItem(talkReadKey(userId)) } catch { /* приватный режим */ }
}

// Ответ базы → { since, seen } с числами; испорченное — null (непрочитанных нет, лучше, чем подсветить всё).
export function normalizeTalkReads(raw) {
  const since = Number(raw?.since)
  if (!Number.isFinite(since)) return null
  const seen = {}
  for (const [id, ms] of Object.entries(raw?.seen && typeof raw.seen === 'object' ? raw.seen : {})) {
    const n = Number(ms)
    if (Number.isFinite(n)) seen[id] = n
  }
  return { since, seen }
}

// Новая отметка заявки поверх прежних (растёт, назад не идёт); без изменений — тот же объект.
export function withSeen(reads, requestId, at) {
  const ms = toMs(at)
  if (!reads || ms <= (reads.seen[requestId] || 0)) return reads
  return { ...reads, seen: { ...reads.seen, [requestId]: ms } }
}

// Граница «прочитано» заявки без учёта своих сообщений.
export function readMarkOf(reads, requestId) {
  if (!reads) return Number.POSITIVE_INFINITY
  return Math.max(reads.since, reads.seen[requestId] || 0)
}

// Сообщения коллег заявки показаны до at включительно. Сливаем с тем, что уже записано (другая вкладка могла отметить
// другие заявки), берём большее и пишем. Возвращает новые отметки.
export function markTalkRead(userId, requestId, at, base) {
  const key = talkReadKey(userId)
  const stored = parse(storageGet(key))
  const since = Math.min(stored?.since ?? Number.POSITIVE_INFINITY, base?.since ?? Number.POSITIVE_INFINITY)
  const seen = { ...(base?.seen || {}) }
  for (const [id, ms] of Object.entries(stored?.seen || {})) seen[id] = Math.max(seen[id] || 0, ms)
  seen[requestId] = Math.max(seen[requestId] || 0, toMs(at))
  const ids = Object.keys(seen)
  if (ids.length > MAX_SEEN) {
    ids.sort((a, b) => seen[b] - seen[a])
    for (const id of ids.slice(MAX_SEEN)) delete seen[id]
  }
  const next = { since: Number.isFinite(since) ? since : Date.now(), seen }
  storageSet(key, next)
  return next
}

// Сколько непрочитанных: counts — из cardCountsById (время чужих сообщений и своего последнего).
export function unreadTalkCount(counts, mark) {
  const others = counts?.otherAts
  if (!others || !others.length) return 0
  const after = Math.max(mark, counts.lastMineAt || 0)
  let n = 0
  for (const at of others) if (at > after) n += 1
  return n
}

// Своё последнее и самое позднее чужое сообщение в списке переписки (окно заявки).
export function talkTimes(comments, userId) {
  let lastMine = 0
  let lastOther = 0
  for (const c of comments || []) {
    const at = toMs(c.created_at)
    if (userId && c.author_user_id === userId) lastMine = Math.max(lastMine, at)
    else lastOther = Math.max(lastOther, at)
  }
  return { lastMine, lastOther }
}

// Сообщение подсвечивается в окне: чужое и позже границы.
export function isUnreadMessage(comment, userId, after) {
  if (userId && comment.author_user_id === userId) return false
  return toMs(comment.created_at) > after
}
