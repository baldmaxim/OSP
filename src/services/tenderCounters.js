// Счётчики для страницы-хаба «Тендеры» (индикаторы «сколько сейчас в работе»).
//
// Считаем на стороне БД через count: 'exact' + head: true — строки не передаются,
// приезжает только число. Шесть независимых запросов уходят параллельно.
//
// ВАЖНО: условия обязаны совпадать с фильтрами самих страниц, иначе бейдж покажет
// одно число, а страница — другое:
//   • основное строительство — TendersPage (department='construction', tenderType='main');
//   • планы затрат           — CostPlansPage;
//   • тендеры на материалы   — TendersPage (tenderType='materials');
//   • проверка КП            — fetchProposalFilesForReview() в tenderProposalFiles.js.
import { supabase } from '../supabase'

// Статусы тендера (tenders.status) — текстовые, как в БД.
const STATUS_NOT_STARTED = 'Не начат'
const STATUS_IN_PROGRESS = 'Идет тендерная процедура'

// Выполнить count-запрос. Возвращает 0 при ошибке: индикатор декоративный и не
// должен ломать страницу, поэтому ошибку только логируем.
async function runCount(label, query) {
  const { count, error } = await query
  if (error) {
    console.error(`Не удалось посчитать «${label}»:`, error.message)
    return 0
  }
  return count || 0
}

// Живые (не удалённые) тендеры нужного типа. objectIds — скоуп сотрудника ([] = все).
// objectStatus — статус объекта ('main_construction' | 'warranty_service'); при
// mainConstructionOnly подставляется основное строительство. Без него фильтра по
// объекту нет: страница тендеров на материалы показывает все объекты сразу.
function tendersQuery({ tenderType, objectIds, mainConstructionOnly = false, objectStatus = null }) {
  const status = objectStatus || (mainConstructionOnly ? 'main_construction' : null)
  let q = status
    ? supabase.from('tenders').select('id, objects!inner(status)', { count: 'exact', head: true })
        .eq('objects.status', status)
    : supabase.from('tenders').select('id', { count: 'exact', head: true })

  q = q.eq('tender_type', tenderType).is('deleted_at', null)
  if (objectIds?.length) q = q.in('object_id', objectIds)
  return q
}

// Очередь «Проверка КП»: только КП, попадающие в очередь (review_required), со статусом pending.
function kpPendingQuery(objectIds) {
  let q = supabase
    .from('tender_proposal_files')
    .select('id, tenders!inner(object_id)', { count: 'exact', head: true })
    .eq('file_kind', 'commercial_proposal')
    .eq('review_required', true)
    .eq('review_status', 'pending')
  if (objectIds?.length) q = q.in('tenders.object_id', objectIds)
  return q
}

// Все счётчики хаба одним вызовом.
export async function fetchTenderHubCounters(objectIds = []) {
  const construction = () => tendersQuery({ tenderType: 'main', objectIds, mainConstructionOnly: true })
  const materials = () => tendersQuery({ tenderType: 'materials', objectIds, mainConstructionOnly: false })
  const warranty = () => tendersQuery({ tenderType: 'main', objectIds, objectStatus: 'warranty_service' })

  const [
    constructionInProgress,
    warrantyInProgress,
    kpPending,
    vorNotStarted,
    vorInProgress,
    costPlanNotStarted,
    costPlanInProgress,
    materialsNotStarted,
    materialsInProgress,
  ] = await Promise.all([
    runCount('тендеры в работе', construction().eq('status', STATUS_IN_PROGRESS)),
    runCount('гарантия: в работе', warranty().eq('status', STATUS_IN_PROGRESS)),
    runCount('КП на проверке', kpPendingQuery(objectIds)),
    // На страницах ВОРов и планов затрат пустой статус трактуется как «не начат».
    runCount('ВОРы: не начат', construction().or('vor_status.is.null,vor_status.eq.not_started')),
    runCount('ВОРы: в работе', construction().eq('vor_status', 'in_progress')),
    runCount('планы затрат: не начат', construction().or('cost_plan_status.is.null,cost_plan_status.eq.not_started')),
    runCount('планы затрат: в работе', construction().eq('cost_plan_status', 'in_progress')),
    runCount('материалы: не начат', materials().eq('status', STATUS_NOT_STARTED)),
    runCount('материалы: в работе', materials().eq('status', STATUS_IN_PROGRESS)),
  ])

  return {
    constructionInProgress,
    warrantyInProgress,
    kpPending,
    vorNotStarted,
    vorInProgress,
    costPlanNotStarted,
    costPlanInProgress,
    materialsNotStarted,
    materialsInProgress,
  }
}
