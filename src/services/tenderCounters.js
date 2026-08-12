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
function tendersQuery({ tenderType, objectIds, mainConstructionOnly }) {
  // objects!inner нужен только там, где важен статус объекта: у тендеров на материалы
  // страница показывает все объекты, без деления на строительство/гарантию.
  let q = mainConstructionOnly
    ? supabase.from('tenders').select('id, objects!inner(status)', { count: 'exact', head: true })
        .eq('objects.status', 'main_construction')
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
// Возвращает { constructionInProgress, kpPending, costPlanNotStarted,
//              costPlanInProgress, materialsNotStarted, materialsInProgress }.
export async function fetchTenderHubCounters(objectIds = []) {
  const construction = () => tendersQuery({ tenderType: 'main', objectIds, mainConstructionOnly: true })
  const materials = () => tendersQuery({ tenderType: 'materials', objectIds, mainConstructionOnly: false })

  const [
    constructionInProgress,
    kpPending,
    costPlanNotStarted,
    costPlanInProgress,
    materialsNotStarted,
    materialsInProgress,
  ] = await Promise.all([
    runCount('тендеры в работе', construction().eq('status', STATUS_IN_PROGRESS)),
    runCount('КП на проверке', kpPendingQuery(objectIds)),
    // На странице планов затрат пустой cost_plan_status трактуется как «не начат».
    runCount('планы затрат: не начат', construction().or('cost_plan_status.is.null,cost_plan_status.eq.not_started')),
    runCount('планы затрат: в работе', construction().eq('cost_plan_status', 'in_progress')),
    runCount('материалы: не начат', materials().eq('status', STATUS_NOT_STARTED)),
    runCount('материалы: в работе', materials().eq('status', STATUS_IN_PROGRESS)),
  ])

  return {
    constructionInProgress,
    kpPending,
    costPlanNotStarted,
    costPlanInProgress,
    materialsNotStarted,
    materialsInProgress,
  }
}
