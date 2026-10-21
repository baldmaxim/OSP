// Договоры и ДС контрагента для вкладки «Общая информация» его карточки.
//
// Контрагент — сторона договора: основной контрагент (contracts.counterparty_id) или одна из сторон
// (contract_counterparties). Кроме того, договор можно прикрепить к контрагенту вручную
// (counterparty_contract_links, миграция 20261031): стороны договора это не меняет, реестр договоров и
// кабинет подрядчика привязку не видят. ДС берутся всем деревом договора: сторону ДС не переназначает.
//
// Права — в базе: читает сотрудник, прикрепляет и открепляет право правки «Контрагентов».
import { db } from '../api'
import { chunkList } from '../utils/inChunks'
import { fetchAllRowsParallel } from '../utils/fetchAllRows'
import { DOC_TYPE } from '../utils/contractAmendments'

export const CONTRACT_LINKS_TABLE = 'counterparty_contract_links'

const DOC_FIELDS = 'id, display_id, record_type, parent_contract_id, root_contract_id, status, deleted_at, '
  + 'contract_number, contract_date, contract_amount, psdc_total, currency, work_name, objects(name)'

// В адрес уходят два списка id (id.in и root_contract_id.in) — порция меньше обычной.
const ROOT_CHUNK = 50

export function isMissingLinksTable(err) {
  const msg = String(err?.message || '')
  return err?.code === '42P01' || err?.code === 'PGRST205'
    || (msg.includes(CONTRACT_LINKS_TABLE) && (msg.includes('does not exist') || msg.includes('schema cache')))
}

// Привязки контрагента; таблицы ещё нет — null (раздел работает как до миграции, без «Прикрепить»).
async function loadLinks(counterpartyId) {
  const { data, error } = await db
    .from(CONTRACT_LINKS_TABLE)
    .select('contract_id, created_by, created_at')
    .eq('counterparty_id', counterpartyId)
  if (error) {
    if (isMissingLinksTable(error)) return null
    throw error
  }
  return data || []
}

// → { docs, manual, linksSupported }: docs — договоры и ДС плоским списком; manual — Map(id договора →
// привязка { created_by, created_at }) для договоров, которые в разделе только благодаря ручной привязке
// (договор, где контрагент и так сторона, пометки не получает и открепить его нельзя).
export async function loadCounterpartyDocs(counterpartyId) {
  const [direct, parties, links] = await Promise.all([
    db.from('contracts').select('id, root_contract_id').eq('counterparty_id', counterpartyId).is('deleted_at', null),
    db.from('contract_counterparties').select('contracts(id, root_contract_id, deleted_at)').eq('counterparty_id', counterpartyId),
    loadLinks(counterpartyId),
  ])
  if (direct.error) throw direct.error
  if (parties.error) throw parties.error
  const sides = new Set()
  for (const d of direct.data || []) sides.add(d.root_contract_id || d.id)
  for (const p of parties.data || []) {
    const c = p.contracts
    if (c && !c.deleted_at) sides.add(c.root_contract_id || c.id)
  }
  // Прикрепляется договор (выбор предлагает только договоры, не ДС) — его id и есть корень дерева.
  const manual = new Map()
  for (const l of links || []) if (!sides.has(l.contract_id)) manual.set(l.contract_id, l)

  const roots = [...sides, ...manual.keys()]
  if (roots.length === 0) return { docs: [], manual, linksSupported: links !== null }
  const parts = await Promise.all(chunkList(roots, ROOT_CHUNK).map(async (ids) => {
    const list = ids.join(',')
    const { data, error } = await db
      .from('contracts')
      .select(DOC_FIELDS)
      .or(`id.in.(${list}),root_contract_id.in.(${list})`)
      .is('deleted_at', null)
    if (error) throw error
    return data || []
  }))
  const byId = new Map()
  for (const row of parts.flat()) byId.set(row.id, row)
  return { docs: [...byId.values()], manual, linksSupported: links !== null }
}

// Договоры реестра для выбора «Прикрепить договор» — только договоры (ДС придут деревом), без удалённых.
// Список общий для всех карточек: договоров сотни, а искать по номеру, предмету, объекту и контрагенту
// удобнее в памяти, чем собирать or(ilike…) в адресе. Через 2 минуты перечитывается — договор, заведённый
// в соседней вкладке, найдётся без перезагрузки страницы.
const CHOICE_FIELDS = 'id, display_id, contract_number, contract_date, work_name, objects(name), counterparties(name)'
const CHOICES_TTL_MS = 2 * 60 * 1000
let choices = null // { at, promise }

export function loadContractChoices() {
  if (choices && Date.now() - choices.at < CHOICES_TTL_MS) return choices.promise
  const promise = fetchAllRowsParallel((from, to, withCount) => db
    .from('contracts')
    .select(CHOICE_FIELDS, withCount ? { count: 'exact' } : undefined)
    .eq('record_type', DOC_TYPE.CONTRACT)
    .is('deleted_at', null)
    .order('display_id', { ascending: false })
    .order('id', { ascending: true })
    .range(from, to))
  choices = { at: Date.now(), promise }
  promise.catch(() => { if (choices?.promise === promise) choices = null })
  return promise
}

export async function attachContract(counterpartyId, contractId) {
  const { error } = await db.from(CONTRACT_LINKS_TABLE).insert([{ counterparty_id: counterpartyId, contract_id: contractId }])
  // Уже прикреплён (вторая вкладка, двойной клик) — цель достигнута.
  if (error && error.code !== '23505') throw error
}

export async function detachContract(counterpartyId, contractId) {
  const { error } = await db.from(CONTRACT_LINKS_TABLE).delete()
    .eq('counterparty_id', counterpartyId)
    .eq('contract_id', contractId)
  if (error) throw error
}
