// Счётчики страницы-хаба «Договоры и ДС». Как у хаба «Тендеры»: count + head, строки не передаются.
//
// ВАЖНО: условия обязаны совпадать с вкладками самих страниц, иначе бейдж покажет одно число, а страница — другое:
//   • реестр            — вкладка «В работе», inTab() в utils/contractRegistryTabs.js (пустой статус — новая заявка);
//   • заявка на ДС      — вкладка «В работе» DcRequestsPage (пустой статус — «В работе»);
//   • заявка на ДП      — вкладки «Новые» и «В работе» (utils/dpRequests.js); объекты сотрудника ограничивает правило базы;
//   • проверка ДП/ДС    — колонки доски без архива и удалённых (DocCheckRequestsPage); с привязкой к объектам — только свои
//                         (страница и правило базы 20270101; здесь — ещё и для «Посмотреть от имени роли»).
// Считаем только разделы, открытые роли: запрос к чужому разделу не уходит вовсе.
import { db } from '../api'
import { runCount } from './tenderCounters'

const count = (table) => db.from(table).select('id', { count: 'exact', head: true }).is('deleted_at', null)

const scoped = (query, objectIds) => (objectIds?.length ? query.in('object_id', objectIds) : query)

const docCheck = (status, objectIds) => scoped(count('doc_check_requests'), objectIds).is('archived_at', null).eq('status', status)

const COUNTERS_BY_SECTION = {
  contracts: (objectIds) => ({
    registryInWork: () => scoped(count('contracts'), objectIds).or('status.is.null,status.not.in.(paused,completed)'),
  }),
  dc_requests: (objectIds) => ({
    dcInWork: () => scoped(count('dc_requests'), objectIds).or('status.is.null,status.eq.in_work'),
  }),
  dp_requests: () => ({
    dpNew: () => count('dp_requests').eq('status', 'new'),
    dpInWork: () => count('dp_requests').eq('status', 'in_work'),
  }),
  doc_check_requests: (objectIds) => ({
    docCheckNew: () => docCheck('new', objectIds),
    docCheckInWork: () => docCheck('in_progress', objectIds),
  }),
}

export async function fetchContractsHubCounters(sections, objectIds = []) {
  const queries = sections.flatMap((section) => Object.entries(COUNTERS_BY_SECTION[section](objectIds)))
  const values = await Promise.all(queries.map(([key, query]) => runCount(key, query())))
  return Object.fromEntries(queries.map(([key], i) => [key, values[i]]))
}
