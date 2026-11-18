// «Перезапуск» тендера и тендер, который его заменил (решение пользователя 18.11.2026; миграция 20270217, обе базы).
// Ссылка — у прежнего тендера: tenders.restarted_by_tender_id. Один новый тендер может заменить несколько прежних
// (у № 733 — № 73 и № 81), у прежнего — один заменивший. Ссылка необязательна и действует, пока прежний — в «Перезапуске»:
// сменили статус — страница её снимает, а до того она просто не показывается.
import { RESTART_STATUS } from './tenderStatuses.js'

export const RESTART_LINK_FIELD = 'restarted_by_tender_id'

// Колонка есть (миграция применена): реестр читает tenders через «*», поэтому достаточно её наличия в строке.
export const hasRestartLink = (tender) => !!tender && RESTART_LINK_FIELD in tender

// Каким тендером перезапущен: id — только у тендера в «Перезапуске».
export function restartTargetId(tender) {
  if (!tender || tender.status !== RESTART_STATUS) return null
  const id = tender[RESTART_LINK_FIELD] || null
  return id && id !== tender.id ? id : null
}

const byNumber = (a, b) => (a.public_tender_number ?? Infinity) - (b.public_tender_number ?? Infinity)

// Связи по списку тендеров: byId — тендер по id (и удалённый: у прежнего «заменён № 984», даже если новый в корзине),
// restartedFrom — id нового → прежние тендеры, которые он заменил (по номеру); прежний в корзине — не в счёт.
export function buildRestartIndex(tenders) {
  const byId = new Map()
  for (const t of tenders || []) {
    if (t?.id) byId.set(t.id, t)
  }
  const restartedFrom = new Map()
  for (const t of byId.values()) {
    const to = restartTargetId(t)
    if (!to || t.deleted_at || !byId.has(to)) continue
    if (!restartedFrom.has(to)) restartedFrom.set(to, [])
    restartedFrom.get(to).push(t)
  }
  for (const list of restartedFrom.values()) list.sort(byNumber)
  return { byId, restartedFrom }
}

const lower = (v) => String(v || '').toLowerCase()

// Новый тендер называет прежний: в описании или примечании есть «перезап…» и номер прежнего (у № 984 —
// «перезапуск тендера №40»). Так перезапуски записывали до 18.11.2026 — такие тендеры предлагаются первыми.
export function mentionsRestartOf(candidate, number) {
  if (number == null) return false
  const text = `${candidate?.work_description || ''}\n${candidate?.notes || ''}`
  if (!/перезап/i.test(text)) return false
  return (text.match(/\d+/g) || []).includes(String(number))
}

const sameObject = (a, b) => (a.object_id
  ? a.object_id === b.object_id
  : !!a.custom_object_name && lower(a.custom_object_name) === lower(b.custom_object_name))

// Поиск: «984», «№ 984» — по номеру (с начала), иначе — по описанию, объекту и примечанию.
function matchesQuery(t, query) {
  const q = lower(query).trim()
  if (!q) return true
  const num = /^№?\s*(\d+)$/.exec(q)
  if (num) return String(t.public_tender_number ?? '').startsWith(num[1])
  const hay = lower([t.public_tender_number, t.work_description, t.objects?.name, t.custom_object_name, t.notes].join(' '))
  return q.split(/\s+/).every((w) => hay.includes(w))
}

// Кого предложить в окне «Перезапуск»: основные тендеры списка, кроме самого тендера и удалённых. Сверху — те, что называют
// его номер («перезапуск № 40»), затем того же объекта, затем остальные; внутри — новые (больший номер) выше.
export function restartCandidates(tender, tenders, query = '') {
  if (!tender) return []
  const rank = (t) => (mentionsRestartOf(t, tender.public_tender_number) ? 0 : sameObject(tender, t) ? 1 : 2)
  return (tenders || [])
    .filter((t) => t?.id && t.id !== tender.id && !t.deleted_at && (t.tender_type || 'main') === 'main')
    // Тот, кого этот тендер сам заменил, его заменой быть не может (иначе — круг: 40 → 984 → 40).
    .filter((t) => restartTargetId(t) !== tender.id)
    .filter((t) => matchesQuery(t, query))
    .map((t) => ({ tender: t, rank: rank(t) }))
    .sort((a, b) => a.rank - b.rank
      || (b.tender.public_tender_number ?? -Infinity) - (a.tender.public_tender_number ?? -Infinity))
}

// Запись в журнал тендера о смене ссылки.
export function restartLinkDescription(target) {
  if (!target) return 'Перезапуск: новый тендер не указан'
  return target.public_tender_number != null
    ? `Перезапущен тендером № ${target.public_tender_number}`
    : 'Перезапущен другим тендером'
}
