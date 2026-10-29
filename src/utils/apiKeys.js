// Ключи API для смежных систем — подписи и проверки вкладки «Доступ к API» («Администрирование»). Без React и сети
// (tests/tender/api-keys.test.mjs). Права, ресурсы и отказы задаёт сервер (server/osp-api/src/lib/apiKeys.js).

export const KEY_STATUS = {
  active: { label: 'Действует', tone: 'ok' },
  expired: { label: 'Срок истёк', tone: 'warn' },
  revoked: { label: 'Отозван', tone: 'off' },
  removed: { label: 'Убран с сервера', tone: 'off' },
}

// Причины отказа в журнале вызовов (поле reason) — как пишет сервер.
export const CALL_REASONS = {
  revoked: 'ключ отозван',
  expired: 'срок ключа истёк',
  removed: 'ключ убран из настроек сервера',
  rate_limit: 'больше 60 запросов в минуту',
  busy: 'больше 2 запросов одновременно',
  forbidden_resource: 'ресурс ключу не открыт',
  unknown_resource: 'нет такого ресурса',
  bad_param: 'неверный параметр запроса',
}

export const NAME_MAX = 200
export const NOTE_MAX = 1000

const pad = (n) => String(n).padStart(2, '0')

export function formatDate(iso) {
  if (!iso) return '—'
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '—'
}

export function formatDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const resourceLabel = (resources, code) => resources.find((r) => r.code === code)?.label || code

export function callReasonText(call) {
  if (call.reason && CALL_REASONS[call.reason]) return CALL_REASONS[call.reason]
  if (call.status >= 500) return 'ошибка сервера'
  return ''
}

// Форма выпуска и правки → текст ошибки или ''. today — «ГГГГ-ММ-ДД» по Москве (отдаёт сервер).
export function keyFormError({ name, scopes, expiresOn }, today, { scopesRequired = true } = {}) {
  if (!String(name || '').trim()) return 'Укажите название — по нему ключ узнают в списке и журнале'
  if (String(name).trim().length > NAME_MAX) return `Название — не длиннее ${NAME_MAX} знаков`
  if (scopesRequired && (!scopes || scopes.length === 0)) return 'Отметьте хотя бы одно право'
  if (expiresOn && today && expiresOn < today) return 'Срок действия — сегодня или позже'
  return ''
}

// Только изменённые поля формы правки: сервер не трогает остальное.
export function keyPatch(key, form, { accessEditable }) {
  const patch = {}
  const name = form.name.trim()
  if (name !== key.name) patch.name = name
  const note = form.note.trim()
  if (note !== (key.note || '')) patch.note = note || null
  if (accessEditable) {
    const scopes = [...form.scopes].sort()
    if (scopes.join(',') !== [...key.scopes].sort().join(',')) patch.scopes = form.scopes
    if ((form.expiresOn || null) !== (key.expiresOn || null)) patch.expiresOn = form.expiresOn || null
  }
  return patch
}

// Права и срок меняются только у выпущенного в портале и не отозванного ключа.
export const accessEditable = (key) => key.source === 'portal' && key.status !== 'revoked'

// Пример запроса для того, кому выдают ключ (адрес портала — тот, где открыт раздел).
export function curlExample(origin, resource, secret = '<ключ>') {
  return `curl -H "X-API-Key: ${secret}" "${origin}/api/rates/${resource}?limit=10"`
}

export function usageText(key) {
  if (!key.callsDay) return key.lastUsedAt ? 'за сутки — 0' : 'не использовался'
  return `${key.callsDay} за сутки`
}
