// «Путь к Signal» в карточке договора и вкладка «Signal» в администрировании: подписи, даты и разбор ответов сервера.
// Чистые функции — без запросов и разметки (tests/tender/contract-card-signal.test.mjs, admin-signal.test.mjs).
// Состояния и причины считает сервер (раздел 3 спецификации): здесь только русские подписи. Чужих имён, путей и счётчиков
// в подписях нет — общая причина из utils/signalReview.js.
import { reasonText } from './signalReview.js'

const MSK = 'Europe/Moscow'

// Даты — по Москве, как подсказки сервера (tip): «сверено 23.11.2026», «данные на 23.11.2026 14:00».
export function ruDate(value) {
  const d = value ? new Date(value) : null
  if (!d || Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ru-RU', { timeZone: MSK, day: '2-digit', month: '2-digit', year: 'numeric' })
}
export function ruDateTime(value) {
  const d = value ? new Date(value) : null
  if (!d || Number.isNaN(d.getTime())) return ''
  const time = d.toLocaleTimeString('ru-RU', { timeZone: MSK, hour: '2-digit', minute: '2-digit', hour12: false })
  return `${ruDate(d)} ${time}`
}

export const isWebUrl = (v) => /^https?:\/\/\S+$/i.test(String(v || '').trim())

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return many
  if (b > 1 && b < 5) return few
  return b === 1 ? one : many
}

// Состояние строки «Путь к Signal» текстом: { tone: 'ok'|'warn'|'info'|'neutral', text, why } или null (сказать нечего).
// data — ответ GET /api/signal/contracts/:id. «Предложена папка …» — только при праве правки: путь предложения сервер
// присылает только тем, кто может править (candidates), остальным состояние suggested не показывается.
export function rowState(data, { canEdit = false } = {}) {
  if (!data) return null
  const link = String(data.signalLink || '').trim()
  const at = ruDateTime(data.dataAt)
  const open = (data.candidates || []).filter((c) => !c.status || c.status === 'open')
  if (!link) {
    if (canEdit && data.state === 'suggested' && open[0]) {
      const path = String(open[0].path || '').trim()
      return { tone: 'info', text: path ? `предложена папка ${path}` : 'предложена папка', why: '' }
    }
    return null
  }
  const why = reasonText(data.reason)
  if (data.pending || data.state === 'unverified') {
    return {
      tone: 'neutral',
      text: `ссылка не сверялась${at ? ` — данные на ${at}` : ''}`,
      why: data.pending ? reasonText('pending') : why,
    }
  }
  switch (data.state) {
    case 'verified': return { tone: 'ok', text: `сверено${data.dataAt ? ` ${ruDate(data.dataAt)}` : ''}`, why: '' }
    case 'conflict': return { tone: 'warn', text: `противоречие: ${why || 'проверьте ссылку'}`, why: '' }
    case 'attention': return { tone: 'warn', text: 'папка не видна в Signal', why: '' }
    case 'missing': return { tone: 'warn', text: 'файл удалён в Signal', why: '' }
    default: return null
  }
}

// Есть ли что сверять: ссылка есть (состояние можно перепроверить или отвязать) или сервер предложил папку.
export function hasReviewWork(data) {
  if (!data) return false
  if (String(data.signalLink || '').trim()) return true
  return (data.candidates || []).some((c) => !c.status || c.status === 'open')
}

// Сводка списка файлов: «В папке: 7 файлов · данные на 23.11.2026 14:00».
export function filesSummary(files, { more = false, dataAt = null } = {}) {
  const list = Array.isArray(files) ? files : []
  const items = list.filter((f) => f.kind !== 'folder' && !f.deleted).length
  const folders = list.filter((f) => f.kind === 'folder').length
  const at = ruDateTime(dataAt)
  let head
  if (!items && !folders) head = more ? 'В папке: есть содержимое' : 'В папке файлов нет'
  else {
    head = `В папке: ${items}${more ? '+' : ''} ${plural(items, 'файл', 'файла', 'файлов')}`
    if (folders) head += `, подпапок: ${folders}`
  }
  return at ? `${head} · данные на ${at}` : head
}

// Версия и дата версии файла: «v3 · 12.11.2026».
export function fileMeta(file) {
  const parts = []
  if (file?.version != null && file.version !== '') parts.push(`v${file.version}`)
  const d = ruDate(file?.modifiedAt)
  if (d) parts.push(d)
  return parts.join(' · ')
}

// ── Вкладка «Signal» ─────────────────────────────────────────────────────────────────────────────────

// Коды, которыми прогон или корень заканчиваются со стороны службы (server/osp-api/src/lib/signalSync.js) и базы (held).
export const RUN_REASON_TEXT = {
  auth: 'ключ Signal не принят',
  scope: 'у ключа не хватает прав',
  http: 'Signal ответил ошибкой',
  timeout: 'Signal не ответил вовремя',
  too_large: 'ответ Signal слишком большой',
  invalid: 'Signal вернул неожиданные данные',
  rate_limited: 'Signal ограничил частоту запросов',
  not_configured: 'подключение не настроено',
  root_missing: 'папки корня нет в дереве Signal',
  root_unavailable: 'корень недоступен ключу',
  limit: 'в корне слишком много папок или он слишком глубокий',
  budget: 'обход не уложился в отведённое время',
  db: 'база недоступна',
  internal: 'внутренняя ошибка',
  read_only: 'портал в режиме только чтения',
  stopped: 'остановлен при перезапуске',
  lost_owner: 'прогон перехвачен другим',
  stale: 'завис и закрыт автоматически',
  root_failed: 'корень не удалось обойти',
  empty: 'в обходе пусто — снимок не заменён',
  shrink: 'данных стало заметно меньше — снимок не заменён',
}
export const runReasonText = (code) => (code ? RUN_REASON_TEXT[code] || 'причина не определена' : '')

export const RUN_INITIATOR_TEXT = { schedule: 'по расписанию', cli: 'с сервера (консоль)', admin: 'администратор' }
export const RUN_KIND_TEXT = { day: 'дневной', night: 'ночной', manual: 'ручной' }
export const RUN_MODE_TEXT = { full: 'полный', known: 'по известным папкам' }
export const DAY_MODE_TEXT = { full: 'все папки целиком', known: 'только известные папки' }

// Итог прогона: { tone, text }.
export function runOutcome(run) {
  const why = runReasonText(run?.reason)
  switch (run?.status) {
    case 'ok': return { tone: 'ok', text: 'успешно' }
    case 'running': return { tone: 'info', text: 'идёт' }
    case 'held': return { tone: 'warn', text: `отложен${why ? `: ${why}` : ''}` }
    case 'failed': return { tone: 'bad', text: `сбой${why ? `: ${why}` : ''}` }
    case 'cancelled': return { tone: 'neutral', text: `отменён${why ? `: ${why}` : ''}` }
    default: return { tone: 'neutral', text: '—' }
  }
}

// Папок и элементов прогона — сумма по корням из stats.roots (id корня и счётчики, без имён). null — счётчиков нет.
export function runCounts(run) {
  const roots = Array.isArray(run?.stats?.roots) ? run.stats.roots : null
  if (!roots || roots.length === 0) return null
  let folders = 0
  let items = 0
  for (const r of roots) {
    folders += Number(r?.folders) || 0
    items += Number(r?.items) || 0
  }
  return { folders, items }
}

export const runKindText = (run) => {
  const kind = RUN_KIND_TEXT[run?.kind] || '—'
  return run?.kind === 'day' && run?.mode === 'known' ? `${kind}, ${RUN_MODE_TEXT.known}` : kind
}

// Идёт ли прогон прямо сейчас (по журналу).
export const isRunning = (runs) => (runs || []).some((r) => r?.status === 'running')
