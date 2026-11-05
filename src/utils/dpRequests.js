// «Заявка на ДП» (миграция 20261227, решения пользователя 05.11.2026): правила без обращения к серверу. Те же границы держат
// правила по строкам и триггеры базы (dp_requests_guard, s3_documents_dp_request_guard): меняете здесь — меняйте и там.
import { parseAmount } from './money.js'
import { CONCEPT_SIGNED_ACCEPT, signedFileProblem } from './tenderConceptAgreement.js'

export const DP_OWNER_TYPE = 'dp_request'
// Без файла каждой из этих категорий заявка не подаётся (триггер базы), последний файл поданной заявки не убрать.
export const DP_CONCEPT_CATEGORY = 'dp_concept_agreement'
export const DP_CONTRACT_CATEGORY = 'dp_contract_doc'
const REQUIRED_CATEGORIES = new Set([DP_CONCEPT_CATEGORY, DP_CONTRACT_CATEGORY])

// Документы — PDF, Word или скан, до 50 МБ: как у подписанного понятийного соглашения тендера.
export const DP_FILE_ACCEPT = CONCEPT_SIGNED_ACCEPT
export const dpFileProblem = signedFileProblem

// Статус draft на странице не встречается: черновик живёт секунды, пока грузятся файлы, и виден только автору.
export const DP_STATUS_OPTIONS = [
  { value: 'new', label: 'Новая', className: 'status-new-request' },
  { value: 'in_work', label: 'В работе', className: 'status-in-work' },
  { value: 'completed', label: 'Завершена', className: 'status-completed' },
]
export const DP_STATUS_LABEL = Object.fromEntries(DP_STATUS_OPTIONS.map((o) => [o.value, o.label]))

export const DP_TABS = [
  { key: 'all', label: 'Все заявки' },
  { key: 'new', label: 'Новые' },
  { key: 'in_work', label: 'В работе' },
  { key: 'completed', label: 'Завершено' },
  { key: 'deleted', label: 'Удалённые' },
]

export const DP_ROLE_LABEL = {
  economist: 'Экономист объекта',
  construction_manager: 'Руководитель строительства',
}

// Роль учётки → кем человек может быть ответственным за заявку. Экономист ОСП (economist) — другой человек, не с объекта.
const ACCOUNT_ROLE = { economist_object: 'economist', construction_manager: 'construction_manager' }
export const accountResponsibleRole = (role) => ACCOUNT_ROLE[role] || null

const normName = (s) => String(s || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ')

const byRoleThenOrder = (a, b) => (
  (a.staff_role === 'economist' ? 0 : 1) - (b.staff_role === 'economist' ? 0 : 1)
  || (a.sort_order ?? 0) - (b.sort_order ?? 0)
  || normName(a.contacts?.full_name).localeCompare(normName(b.contacts?.full_name), 'ru')
)

// Кого можно назначить ответственным по объекту → { options: [{ key, contactId, name, role }], fallback }.
//  • люди объекта (object_staff: экономисты, затем руководители строительства);
//  • у объекта никто не указан — все такие люди с других объектов (fallback: окно об этом пишет);
//  • сам вошедший, если он экономист объекта или руководитель строительства, а в списке его нет: у части учёток нет карточки
//    в «Контактах» (на копии 02.11 — у 3 из 8 руководителей строительства), тогда contactId пуст, а в заявку идёт только ФИО.
export function responsibleOptions({ staff, objectId, me }) {
  const rows = (staff || []).filter((s) => s.contacts?.full_name && DP_ROLE_LABEL[s.staff_role])
  const own = rows.filter((s) => s.object_id === objectId)
  const fallback = !!objectId && own.length === 0
  const seen = new Set()
  const options = []
  for (const s of [...(fallback ? rows : own)].sort(byRoleThenOrder)) {
    const key = `${s.contact_id}:${s.staff_role}`
    if (seen.has(key)) continue
    seen.add(key)
    options.push({ key, contactId: s.contact_id, name: s.contacts.full_name, role: s.staff_role })
  }
  const myRole = accountResponsibleRole(me?.role)
  if (objectId && myRole && me?.name && !options.some((o) => normName(o.name) === normName(me.name))) {
    options.unshift({ key: 'me', contactId: null, name: me.name, role: myRole })
  }
  return { options, fallback }
}

// Кто выбран в форме: прежний выбор, пока он есть в списке (и у заявки, чей ответственный уже не на объекте — окно сохранит его);
// иначе сам вошедший, если он в списке; иначе единственный человек объекта. Угадывать среди нескольких не будем.
export function pickResponsibleKey({ options, current, myName }) {
  if (current && options.some((o) => o.key === current)) return current
  const mine = options.find((o) => normName(o.name) === normName(myName))
  if (mine) return mine.key
  return options.length === 1 ? options[0].key : ''
}

export const EMPTY_DP_FORM = { object_id: '', contract_title: '', amount: '', responsibleKey: '', reason: '' }

// Что мешает создать заявку или сохранить правку: пусто — можно. Счётчики файлов null — файлы правятся не в этом окне.
export function dpFormProblems(form, { conceptCount = null, contractCount = null } = {}) {
  const out = []
  if (!form.object_id) out.push('выберите объект')
  if (!String(form.contract_title || '').trim()) out.push('укажите договор')
  const amount = parseAmount(form.amount)
  if (amount == null || amount < 0) out.push('укажите сумму')
  if (!form.responsibleKey) out.push('выберите ответственного')
  if (!String(form.reason || '').trim()) out.push('напишите причину создания ДП')
  if (contractCount === 0) out.push('загрузите документ договора')
  if (conceptCount === 0) out.push('загрузите понятийное соглашение')
  return out
}

// Поля строки заявки из формы. ФИО у контакта базы всё равно поставит триггер: страница шлёт его ради ответственного без контакта.
export function dpFormFields(form, option) {
  return {
    object_id: form.object_id,
    contract_title: String(form.contract_title).trim(),
    amount: parseAmount(form.amount),
    responsible_contact_id: option?.contactId || null,
    responsible_name: option?.name || null,
    responsible_role: option?.role || null,
    reason: String(form.reason).trim(),
  }
}

// Может ли человек править заявку и её файлы: работает с заявками (не удалёнными и удалёнными) или автор, пока заявку не взяли в работу.
export function canChangeDpRequest(req, { canWork, canCreate, userId }) {
  if (canWork) return true
  return !!canCreate && !!userId && req?.created_by === userId && (req?.status === 'new' || req?.status === 'draft')
}

// Последний файл понятийного соглашения и документа договора поданной заявки нельзя убрать, только заменить.
// sameCategory — файлы заявки этой же категории.
export const isLastRequiredFile = (doc, sameCategory) => REQUIRED_CATEGORIES.has(doc?.doc_category) && (sameCategory || []).length <= 1

// Поиск: «12» и «№ 12» — номер заявки, иначе подстрока всех слов в любом поле.
export function matchesDpSearch(req, query) {
  const q = normName(query)
  if (!q) return true
  const num = /^№?\s*(\d+)$/.exec(q)
  if (num && Number(num[1]) === req.request_number) return true
  const text = normName([
    req.objects?.name, req.contract_title, req.responsible_name, req.reason, req.created_by_name, req.request_number,
  ].filter((v) => v != null).join(' '))
  return q.split(' ').every((word) => text.includes(word))
}

const inTab = (req, tab) => {
  if (tab === 'deleted') return !!req.deleted_at
  if (req.deleted_at) return false
  return tab === 'all' || req.status === tab
}

export function filterDpRequests(requests, { tab = 'all', query = '', objectIds = [] } = {}) {
  return (requests || []).filter((r) => (
    inTab(r, tab) && (objectIds.length === 0 || objectIds.includes(r.object_id)) && matchesDpSearch(r, query)
  ))
}

// Счётчики вкладок — при тех же поиске и объектах: число на вкладке равно числу строк, которые откроются.
export function countDpTabs(requests, { query = '', objectIds = [] } = {}) {
  return Object.fromEntries(DP_TABS.map(({ key }) => [key, filterDpRequests(requests, { tab: key, query, objectIds }).length]))
}

// Причина отказа базы — словами страницы; остальное — как есть.
const HINT_TEXT = {
  dp_concept_agreement_required: 'Заявку нельзя создать без понятийного соглашения: загрузите его файл.',
  dp_contract_doc_required: 'Заявку нельзя создать без документа договора: загрузите его файл.',
  dp_responsible_required: 'Укажите ответственного: экономиста объекта или руководителя строительства.',
}
export const dpErrorText = (err) => HINT_TEXT[err?.hint] || err?.message || String(err)

// База ещё без миграции: таблицы или функции нет.
export function isDpMigrationMissing(err) {
  const msg = String(err?.message || '')
  return err?.code === '42P01' || err?.code === 'PGRST205' || err?.code === 'PGRST202' || err?.code === '42883'
    || (/dp_request/.test(msg) && (/does not exist/.test(msg) || /schema cache/.test(msg)))
}
export const DP_MIGRATION_HINT = 'Раздел заработает после применения миграции 20261227_dp_requests.'

// Подпись количества: «1 новая заявка», «2 новые заявки», «5 новых заявок».
export function newRequestsLabel(n) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return `${n} новая заявка`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} новые заявки`
  return `${n} новых заявок`
}

// Страница создала заявку → окно получателя проверяет сразу (создавший сам может быть в списке получателей).
export const DP_CREATED_EVENT = 'osp:dp-request-created'
// Окно получило новые уведомления → реестр перечитывается.
export const DP_ALERTS_EVENT = 'osp:dp-request-alerts'
export const DP_REQUEST_PARAM = 'request'
