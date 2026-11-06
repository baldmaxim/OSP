// Раздел «Договоры и ДС» (/contracts): четыре блока, у каждого своё право. Объединены только на экране и в меню — разделы
// прав в базе и адреса заявок прежние: на них ведут ссылки из выгрузок Excel, карточки контрагента, окна о новой заявке.
// Новый блок — строка здесь: меню, хаб, стартовая страница и подсветка пункта меню берут список отсюда.

export const CONTRACTS_HUB_PATH = '/contracts'
export const CONTRACTS_REGISTRY_PATH = '/contracts/registry'

// Подписи счётчиков: «1 новая», «3 новые», «5 новых»; «в работе» не склоняется.
const IN_WORK = ['в работе', 'в работе', 'в работе']
const NEW = ['новая', 'новые', 'новых']

// section — ключ права (role_permissions.section). counters — ключи ответа fetchContractsHubCounters.
export const CONTRACT_SECTIONS = [
  {
    section: 'contracts',
    to: CONTRACTS_REGISTRY_PATH,
    title: 'Реестр по договорам',
    desc: 'Договоры и дополнительные соглашения: статусы, работа юриста, пути к документам',
    action: 'Перейти к реестру',
    tone: 'blue',
    counters: [{ key: 'registryInWork', forms: IN_WORK }],
  },
  {
    section: 'dc_requests',
    to: '/dc-requests',
    title: 'Заявка на ДС',
    desc: 'Заявки на дополнительные соглашения: проверка по договору, статус ОКС, итоговые документы',
    action: 'Перейти к заявкам',
    tone: 'green',
    counters: [{ key: 'dcInWork', forms: IN_WORK }],
  },
  {
    section: 'dp_requests',
    to: '/dp-requests',
    title: 'Заявка на ДП',
    desc: 'Заявки на договор подряда: понятийное соглашение, документы, примечание',
    action: 'Перейти к заявкам',
    tone: 'violet',
    counters: [{ key: 'dpNew', forms: NEW }, { key: 'dpInWork', forms: IN_WORK }],
  },
  {
    section: 'doc_check_requests',
    to: '/doc-check-requests',
    title: 'Заявки на проверку ДП/ДС',
    desc: 'Доска проверки договоров и ДС: от новой заявки до загрузки в Signal и 1С',
    action: 'Перейти к заявкам',
    tone: 'slate',
    counters: [{ key: 'docCheckNew', forms: NEW }, { key: 'docCheckInWork', forms: IN_WORK }],
  },
]

export const CONTRACT_SECTION_KEYS = CONTRACT_SECTIONS.map((s) => s.section)

export const visibleContractSections = (canView) => CONTRACT_SECTIONS.filter((s) => canView(s.section))

// Куда ведёт пункт меню. Один доступный блок — сразу в него: выбирать не из чего, а раньше пункт меню открывал раздел
// одним нажатием. Ничего не доступно — null.
export function contractsEntry(canView) {
  const sections = visibleContractSections(canView)
  if (sections.length === 0) return null
  return sections.length === 1 ? sections[0].to : CONTRACTS_HUB_PATH
}

// На этих адресах подсвечен пункт меню «Договоры и ДС». Карточка договора и загрузка ПСДЦ — под /contracts.
const SECTION_PATHS = [CONTRACTS_HUB_PATH, ...CONTRACT_SECTIONS.map((s) => s.to)]
export const isContractsPath = (pathname) => SECTION_PATHS.some((p) => pathname.startsWith(p))
