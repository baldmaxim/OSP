// «Путь к Signal» в карточке договора и вкладка «Signal» в администрировании: подписи, даты и разбор ответов сервера.
// Чистые функции — без запросов и разметки (tests/tender/contract-card-signal.test.mjs, admin-signal.test.mjs).
// Состояния и причины считает сервер (раздел 3 спецификации): здесь только русские подписи. Чужих имён, путей и счётчиков
// в подписях нет — общая причина из utils/signalReview.js. Путь папки в карточке — ровно тот, что отдал сервер (он уже от границы
// объекта, С-21): клиент его не собирает и имя корня или проекта не дописывает.
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
// Состояния — раздел 1 спецификации волны исправлений: accepted — зелёное («ссылка принята, номер в папке не найден»); attention —
// по причине (папка или файл не виден, корпус/очередь/секция не совпали, папка допсоглашения); missing — файл удалён в Signal.
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
    case 'accepted': return { tone: 'ok', text: 'ссылка принята, номер в папке не найден', why: at ? `данные на ${at}` : '' }
    case 'conflict': return { tone: 'warn', text: `противоречие: ${why || 'проверьте ссылку'}`, why: '' }
    case 'attention': return { tone: 'warn', text: attentionText(data.reason, why), why: '' }
    case 'missing': return { tone: 'warn', text: 'файл удалён в Signal', why: '' }
    default: return null
  }
}

// Подпись состояния attention по причине (В-10, В-11, С-41). Неизвестная причина — общий текст с её описанием, если оно есть.
const ATTENTION_TEXT = {
  not_visible: 'папка не видна в Signal',
  file_not_visible: 'файл не виден в Signal',
  building_mismatch: 'корпус, очередь или секция не совпали — проверьте',
  kind_mismatch: 'папка относится к допсоглашению — проверьте',
}
function attentionText(reason, why) {
  return ATTENTION_TEXT[reason] || `требует внимания${why ? `: ${why}` : ''}`
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

// Запомненные названия объекта (синонимы) для карточки договора (С-2): сотрудник с правкой получает от сервера только свои в своём
// охвате, администратор — все. Для объекта договора — по objectId; чужие и без объекта не показываются.
export function aliasesForObject(items, objectId) {
  if (!objectId) return []
  return (Array.isArray(items) ? items : []).filter((a) => a && a.id && a.objectId === objectId && String(a.text || '').trim())
}

// ── Вкладка «Signal» ─────────────────────────────────────────────────────────────────────────────────────────────────────────

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
  superseded: 'вытеснен более новым прогоном',
  root_failed: 'корень не удалось обойти',
  empty: 'в обходе пусто — снимок не заменён',
  shrink: 'данных стало заметно меньше — снимок не заменён',
}
export const runReasonText = (code) => (code ? RUN_REASON_TEXT[code] || 'причина не определена' : '')

export const RUN_INITIATOR_TEXT = { schedule: 'по расписанию', cli: 'с сервера (консоль)', admin: 'администратор' }
export const RUN_KIND_TEXT = { day: 'дневной', night: 'ночной', manual: 'ручной' }
export const RUN_MODE_TEXT = { full: 'полный', known: 'по известным папкам' }
export const DAY_MODE_TEXT = { full: 'все папки целиком', known: 'только известные папки' }

// Итог прогона: { tone, text }. partial — часть корней опубликована, часть нет (В-5).
export function runOutcome(run) {
  const why = runReasonText(run?.reason)
  switch (run?.status) {
    case 'ok': return { tone: 'ok', text: 'успешно' }
    case 'running': return { tone: 'info', text: 'идёт' }
    case 'partial': return { tone: 'warn', text: `частично${why ? `: ${why}` : ': часть корней не обновлена'}` }
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

// Идёт ли прогон прямо сейчас (по журналу). Журнал не знает, что процесс упал: «зависший» прогон (heartbeat старше порога) отдаёт
// сервер в status.running.stuck (С-48) — вкладка смотрит на него, а не на эту проверку.
export const isRunning = (runs) => (runs || []).some((r) => r?.status === 'running')

// Идущий прогон для вкладки: status.running (null или { runId, startedAt, heartbeatAt, stuck }); у сервера без этого поля — по журналу.
export function runningOf(status, runs) {
  if (status && status.running !== undefined) return status.running && typeof status.running === 'object' ? status.running : null
  const r = (runs || []).find((x) => x?.status === 'running')
  return r ? { runId: r.id, startedAt: r.startedAt || null, heartbeatAt: null, stuck: false } : null
}

// «Прогон не отвечает с <время по Москве>; будет снят при следующем запуске» (С-48): с последнего сигнала жизни, иначе с начала.
export function stuckText(running) {
  const since = ruDateTime(running?.heartbeatAt || running?.startedAt)
  return `Прогон не отвечает${since ? ` с ${since}` : ''}; будет снят при следующем запуске`
}

// Готовая команда для принятия отложенного прогона (С-50). Номер прогона и поколение — только целые числа от сервера, иначе — ''.
export function acceptHeldCommand(held) {
  const run = Number(held?.runId)
  const gen = Number(held?.generation)
  if (!Number.isSafeInteger(run) || run < 0 || !Number.isSafeInteger(gen) || gen < 0) return ''
  return `deploy.sh signal accept-held --run ${run} --expected-generation ${gen} --reason "…"`
}

// Свежесть данных (В-7): «Данные Signal обновлялись <дата> — сверка может быть устаревшей».
export function staleText(dataAt) {
  const at = ruDateTime(dataAt)
  return at ? `Данные Signal обновлялись ${at} — сверка может быть устаревшей` : 'Данные Signal давно не обновлялись — сверка может быть устаревшей'
}

// Оповещения сервера (status.alerts, В-5): { tone, text } или null (неизвестный вид не показываем кодом). sources — корни из status.
export function alertView(alert, sources = []) {
  const src = alert?.sourceId != null ? (sources || []).find((s) => String(s.id) === String(alert.sourceId)) : null
  const name = src ? `«${src.projectName} → ${src.rootPath}»` : ''
  const since = ruDateTime(alert?.since)
  const from = since ? ` с ${since}` : ''
  switch (alert?.kind) {
    case 'root_failed': return { tone: 'bad', text: `Корень${name ? ` ${name}` : ''} не обновляется${from}` }
    case 'run_held': return { tone: 'warn', text: `Прогон отложен${from}: снимок папок не заменён, пока данные не примут` }
    case 'run_stuck': return { tone: 'warn', text: stuckText({ heartbeatAt: alert.since }) }
    case 'data_stale': return { tone: 'warn', text: `Данные Signal не обновлялись${from}` }
    default: return null
  }
}

// Сколько оповещений на ярлыке вкладки «Signal» (В-5).
export const alertCount = (status) => (Array.isArray(status?.alerts) ? status.alerts.length : 0)

// Показывать ли вкладку «Signal» администратору: сверка включена и сервер признал администратором, либо выключена по ОШИБОЧНОЙ причине
// (В-8: ошибка настройки, нет схемы в базе, сбой базы — вкладка покажет причину). Намеренно выключенная сверка (not_enabled,
// SIGNAL_SYNC≠1) и выключенная без причины — вкладки нет, админка как до интеграции.
export const SIGNAL_ERROR_REASONS = ['config_invalid', 'no_schema', 'db_error']
export const signalTabVisible = (status) => !!status && (
  (status.enabled === true && status.isAdmin === true) || (status.enabled === false && SIGNAL_ERROR_REASONS.includes(status.disabledReason))
)

// Причина выключения сверки (В-8): имена переменных настройки — только вида SIGNAL_… (значений сервер не присылает; чужое не рисуем).
export const CONFIG_VAR = /^SIGNAL_[A-Z0-9_]{1,64}$/
export function disabledView(status) {
  const vars = (Array.isArray(status?.configErrors) ? status.configErrors : []).filter((v) => CONFIG_VAR.test(String(v)))
  switch (status?.disabledReason) {
    case 'config_invalid':
      return { tone: 'bad', title: 'Сверка Signal выключена: ошибка настройки', text: vars.length ? `Ошибка настройки: ${vars.join(', ')}` : 'Ошибка настройки', hint: 'Проверьте значения этих переменных в настройках сервера и перезапустите службу портала.' }
    case 'no_schema':
      return { tone: 'bad', title: 'Сверка Signal выключена: нет схемы в базе', text: 'В базе портала нет схемы сверки Signal', hint: 'Нужно применить миграцию сверки Signal; портал при этом работает как раньше.' }
    case 'db_error':
      return { tone: 'bad', title: 'Сверка Signal выключена: сбой базы', text: 'Не удалось проверить базу для сверки Signal', hint: 'Проверка повторится сама; портал при этом работает как раньше.' }
    default:
      return null
  }
}

// Состояние корня (status.sources[]): сбой с даты, отложен, число проблемных подпапок (В-5). Чипы без имён папок.
// problems — число либо список { nodeId, code }: считаем и то и другое; разбивка по кодам — в подсказку.
export const PROBLEM_CODE_TEXT = {
  forbidden: 'нет доступа к папке',
  not_found: 'папки нет в Signal',
  invalid: 'ответ Signal не разобрать',
  unstable: 'содержимое менялось во время обхода',
}
export function rootProblems(source) {
  const p = source?.problems
  if (Array.isArray(p)) {
    const byCode = {}
    for (const x of p) {
      const code = PROBLEM_CODE_TEXT[x?.code] ? x.code : 'other'
      byCode[code] = (byCode[code] || 0) + 1
    }
    const title = Object.entries(byCode).map(([code, n]) => `${PROBLEM_CODE_TEXT[code] || 'другая причина'}: ${n}`).join('; ')
    return { count: p.length, title }
  }
  const n = Number(p)
  return { count: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0, title: '' }
}
export function rootStatusChips(source) {
  const chips = []
  if (source?.status === 'failed' || source?.lastError) {
    const since = source.failedSince ? ruDate(source.failedSince) : ''
    const why = runReasonText(source.lastError)
    chips.push({ key: 'error', tone: 'bad', text: `${source.status === 'failed' || since ? `сбой${since ? ` с ${since}` : ''}` : 'ошибка'}${why ? `: ${why}` : ''}`, title: source.lastError || '' })
  }
  if (source?.status === 'held') chips.push({ key: 'held', tone: 'warn', text: 'отложен: снимок корня не заменён', title: '' })
  const { count, title } = rootProblems(source)
  if (count > 0) chips.push({ key: 'problems', tone: 'warn', text: `проблемных подпапок: ${count}`, title: title || 'Элементы этих подпапок не удалось прочитать; прежние данные сохранены' })
  return chips
}

// Разметка папок (В-6): объект папки в дереве, предупреждение и охват привязки.
export function folderObjectView(node) {
  if (!node?.objectId) return { tone: 'warn', text: 'без объекта', title: 'Договоры этой папки не сверяются' }
  const name = node.objectName || 'объект'
  return node.bound
    ? { tone: 'info', text: `привязана: ${name}`, title: 'Своя привязка папки' }
    : { tone: '', text: `${name} (унаследован)`, title: 'Объект унаследован от папки выше' }
}
export function bindWarningText(w) {
  const n = Math.max(0, Number(w?.folders) || 0)
  return `Внутри папки есть номера договоров объекта ${w?.objectName || 'другого объекта'}: ${n} ${plural(n, 'папка', 'папки', 'папок')}`
}
export function bindAffectedText(a) {
  const f = Math.max(0, Number(a?.folders) || 0)
  const i = Math.max(0, Number(a?.items) || 0)
  return `Привязка заденет ${f} ${plural(f, 'папку', 'папки', 'папок')} и ${i} ${plural(i, 'файл', 'файла', 'файлов')}`
}
