// Запросы шага «Понятийное соглашение» при завершении тендера и выбора победителя не из участников. Правила —
// utils/tenderConceptAgreement.js.
import { db } from '../api'
import { fetchAllRowsParallel } from '../utils/fetchAllRows'
import { fetchLinkAsFile } from '../utils/linkDownload'
import {
  CONCEPT_CARD_TITLE, CONCEPT_SIGNED_CATEGORY, CONCEPT_TEMPLATE_CATEGORY, CONCEPT_TEMPLATE_FILE_NAME,
  CONCEPT_TEMPLATE_LINK_TITLE, filesOfCategory, findConceptCard,
} from '../utils/tenderConceptAgreement'
import { uploadFile } from './s3'
import { SECTION_TEMPLATE_LINK_KEY, fetchTemplateLinks, isWebLink } from './sectionTemplates'
import { fetchTenderDocs } from './tenderDocs'

const TEMPLATE_KEY = SECTION_TEMPLATE_LINK_KEY.conceptAgreement

const uploadToCard = (card, file, category) => uploadFile({ file, ownerType: 'tender', ownerId: card.id, category })

async function loadCard(tenderId) {
  return findConceptCard(await fetchTenderDocs(tenderId))
}

async function createCard(tenderId, { userId, userName }) {
  const { data, error } = await db.from('tender_docs')
    .insert({
      tender_id: tenderId,
      title: CONCEPT_CARD_TITLE,
      is_final: false,
      created_by: userId,
      created_by_name: userName,
      updated_by: userId,
      updated_by_name: userName,
    })
    .select('*')
    .single()
  if (error) throw error
  return { ...data, links: [], files: [] }
}

const hasTemplate = (card) => (
  filesOfCategory(card, CONCEPT_TEMPLATE_CATEGORY).length > 0
  || (card.links || []).some((l) => l.title === CONCEPT_TEMPLATE_LINK_TITLE)
)

// Шаблон задаётся ссылкой («Документы раздела» → «Материалы»). Копия файла остаётся в тендере, даже если шаблон потом
// поменяют. Файл не отдаётся (доступ к документу закрыт) — в карточку идёт сама ссылка. → что показать человеку.
async function loadTemplate(card) {
  const link = (await fetchTemplateLinks([TEMPLATE_KEY])).get(TEMPLATE_KEY) || null
  if (!link) return { kind: 'no_link' }
  if (!isWebLink(link)) return { kind: 'path', path: link }
  try {
    await uploadToCard(card, await fetchLinkAsFile(link, CONCEPT_TEMPLATE_FILE_NAME), CONCEPT_TEMPLATE_CATEGORY)
    return null
  } catch (err) {
    const { error } = await db.from('tender_doc_links')
      .insert({ tender_doc_id: card.id, title: CONCEPT_TEMPLATE_LINK_TITLE, url: link, sort_order: 0 })
    if (error) throw error
    return { kind: 'link_only', reason: err.message }
  }
}

// Страница может открыть шаг дважды подряд (StrictMode, повторный выбор статуса): вторая карточка и второй файл шаблона не нужны.
const inflight = new Map()

// Карточка соглашения тендера с шаблоном: нет — создаётся, шаблона нет — подгружается. → { card, template }.
export function prepareConceptAgreement(tenderId, actor) {
  if (inflight.has(tenderId)) return inflight.get(tenderId)
  const job = (async () => {
    const existing = await loadCard(tenderId)
    const card = existing || await createCard(tenderId, actor)
    if (hasTemplate(card)) return { card, template: null }
    const template = await loadTemplate(card)
    return { card: await loadCard(tenderId), template }
  })().finally(() => inflight.delete(tenderId))
  inflight.set(tenderId, job)
  return job
}

export const uploadSignedConceptAgreement = (card, file) => uploadToCard(card, file, CONCEPT_SIGNED_CATEGORY)

export const reloadConceptCard = loadCard

// Перед самим завершением — по базе, а не по открытому окну: файл мог удалить коллега.
export async function hasSignedConceptAgreement(tenderId) {
  return filesOfCategory(await loadCard(tenderId), CONCEPT_SIGNED_CATEGORY).length > 0
}

// Вся база контрагентов, кроме удалённых: победителем бывает и не участвовавший, и не «активный» — статус показывается в списке.
export function fetchWinnerCandidates() {
  return fetchAllRowsParallel((from, to, withCount) => db
    .from('counterparties')
    .select('id, name, work_type, inn, status', withCount ? { count: 'exact' } : undefined)
    .is('deleted_at', null)
    .order('name', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to))
}

// Контрагент, которого нет в базе. Сбой записи в журнал контрагента запись самого контрагента не отменяет.
export async function createWinnerCounterparty({ name, inn }, { role, userName, tenderLabel }) {
  const { data, error } = await db.from('counterparties')
    .insert([{ name, inn: inn || null, status: 'active' }])
    .select('id, name, work_type, inn, status')
    .single()
  if (error) throw error
  const { error: logError } = await db.from('counterparty_audit_log').insert([{
    counterparty_id: data.id,
    event_type: 'created',
    description: `Добавлен при завершении тендера${tenderLabel ? ` ${tenderLabel}` : ''}`,
    changed_by_role: role,
    changed_by_name: userName,
  }])
  if (logError) console.error('Не удалось записать историю контрагента:', logError.message)
  return data
}
