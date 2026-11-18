// «Перезапуск» тендера для карточки (TenderDetailPage): какие прежние тендеры заменил этот и каким тендером заменён он сам.
// Реестр берёт это из своего списка (buildRestartIndex), карточке список раздела не нужен — два маленьких запроса.
// Колонки tenders.restarted_by_tender_id нет (база до 20270217) — пусто, без ошибки.
import { db } from '../api'
import { RESTART_STATUS } from '../utils/tenderStatuses'
import { RESTART_LINK_FIELD, hasRestartLink, restartTargetId } from '../utils/tenderRestart'

const COLS = `id, public_tender_number, status, deleted_at, ${RESTART_LINK_FIELD}`

export async function loadRestartRelated(tender) {
  if (!tender?.id || !hasRestartLink(tender)) return []
  const targetId = restartTargetId(tender)
  const [from, to] = await Promise.all([
    db.from('tenders').select(COLS)
      .eq(RESTART_LINK_FIELD, tender.id)
      .eq('status', RESTART_STATUS)
      .is('deleted_at', null)
      .order('public_tender_number', { ascending: true }),
    targetId
      ? db.from('tenders').select(COLS).eq('id', targetId).is('deleted_at', null)
      : Promise.resolve({ data: [], error: null }),
  ])
  const error = from.error || to.error
  if (error) {
    if (String(error.code) === '42703') return []
    throw new Error(error.message)
  }
  return [...(from.data || []), ...(to.data || [])]
}
