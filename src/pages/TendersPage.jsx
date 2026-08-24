import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import StatusDropdown from '../components/StatusDropdown'
import TgPublishToggle from '../components/TgPublishToggle'
import TenderCounterpartyFiles from '../components/TenderCounterpartyFiles'
import VorDocsModal from '../components/VorDocsModal'
import PaperclipIcon from '../components/icons/PaperclipIcon'
import FilterDropdown from '../components/FilterDropdown'
import IconTile from '../components/IconTile'
import { IconHardHat, IconShieldCheck, IconPackage } from '../components/icons/TenderHubIcons'
import {
  IconObject, IconTag, IconUser, IconMail, IconColumns, IconColumnsWide,
  IconJoint, IconOther,
} from '../components/icons/ToolbarIcons'
import { departmentConfig, objectDeptBadge, tenderObjectName } from '../utils/tenderDepartments'
import { copyToClipboard } from '../utils/clipboard'
import { reorderSiblings } from '../utils/appendixTree'
import { sanitizeUserText, sanitizeDeep } from '../utils/text'
import { diffWords } from '../utils/textDiff'
import { describeSupabaseError, isAuthError, SESSION_EXPIRED_MESSAGE } from '../utils/supabaseError'
import { useIsPhone } from '../hooks/useMediaQuery'
import '../components/Tenders.css'
import '../components/MobileCards.css'

// task 419+: еженедельно ротируемый «Ответственный по тендерам».
// Ротация считается детерминированно на фронте (без cron): якорь + число недель % N.
// Ручная замена админом хранится в app_settings под ключом ниже (см. TendersPage).
const TENDER_RESPONSIBLES = [
  'Крюкова Юлия Денисовна',
  'Архипов Антон Михайлович',
  'Савостенко Владислав Андреевич',
]
// Понедельник недели, когда ответственна Крюкова (index 0). 2026-07-06 — текущая неделя.
const ROTATION_ANCHOR_MONDAY = '2026-07-06'
const RESPONSIBLE_OVERRIDE_KEY = 'tender_responsible_override'

// Понедельник недели для даты (локальное время, 00:00).
function mondayOf(dateInput) {
  const d = new Date(dateInput)
  d.setHours(0, 0, 0, 0)
  const dow = (d.getDay() + 6) % 7 // 0=Пн … 6=Вс
  d.setDate(d.getDate() - dow)
  return d
}
// Ключ недели 'YYYY-MM-DD' (понедельник).
function weekKey(dateInput) {
  const m = mondayOf(dateInput)
  const p = (x) => String(x).padStart(2, '0')
  return `${m.getFullYear()}-${p(m.getMonth() + 1)}-${p(m.getDate())}`
}
// Ответственный по расписанию (без учёта ручной замены).
function baseResponsible(dateInput) {
  const anchor = mondayOf(ROTATION_ANCHOR_MONDAY)
  const weeks = Math.round((mondayOf(dateInput) - anchor) / (7 * 24 * 60 * 60 * 1000))
  const n = TENDER_RESPONSIBLES.length
  return TENDER_RESPONSIBLES[((weeks % n) + n) % n]
}

// Дата и время правки для истории примечаний: «24.07.2026, 14:05».
function formatDateTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ru-RU') + ', ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

const PencilIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
)

const HistoryIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 3v5h5" />
    <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
    <path d="M12 7v5l3 2" />
  </svg>
)

function TendersPage({ department = 'construction', tenderType = 'main' }) {
  const isMaterialsView = tenderType === 'materials'
  const { scopedObjectIds, userProfile, isAdmin, canEdit } = useRole()
  // task 333: гейт add/edit/delete для раздела «tenders»
  const canEditTenders = canEdit('tenders')
  // Телефон: список рендерим карточками вместо широкой таблицы
  const isPhone = useIsPhone()
  // Руководитель строительства (привязан к объекту) не видит внутренние примечания,
  // а также элементы работы с подрядчиками: «Дежурный по тендерам», «Шаблон письма»,
  // «Копировать email».
  const hideNotes = scopedObjectIds.length > 0
  const isScopedManager = scopedObjectIds.length > 0
  // Сохранение настроенных фильтров: при переходе в тендер и возврате назад
  // страница перемонтируется — читаем сохранённую выборку из localStorage, чтобы
  // она не сбрасывалась. Ключ свой на каждое представление, чтобы
  // construction/warranty/materials не мешали друг другу.
  const filtersStorageKey = `tenders-filters:${tenderType}:${department}`
  const [savedFilters] = useState(() => {
    try {
      const raw = localStorage.getItem(filtersStorageKey)
      const parsed = raw ? JSON.parse(raw) : null
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch { return {} }
  })
  const [tenders, setTenders] = useState([])
  const [objects, setObjects] = useState([])
  const [counterparties, setCounterparties] = useState([])
  const [responsibleContacts, setResponsibleContacts] = useState([])
  // Ручная замена «Ответственного по тендерам» (app_settings): { week, name } | null
  const [responsibleOverride, setResponsibleOverride] = useState(null)
  const [respMenuOpen, setRespMenuOpen] = useState(false)
  // task 393: документы «ВОРы и РД» (S3, категория 'vor')
  const [vorDocsModalTenderId, setVorDocsModalTenderId] = useState(null)
  const [vorDocCounts, setVorDocCounts] = useState({}) // tenderId → число документов
  // task 397: документы «Тендерный пакет» (S3, категория 'tender_package')
  const [packageDocsModalTenderId, setPackageDocsModalTenderId] = useState(null)
  const [packageDocCounts, setPackageDocCounts] = useState({}) // tenderId → число документов
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  // task 212: 'all' | <status> | 'template' | 'deleted'.
  // Вкладку «Шаблон письма» не восстанавливаем — это режим редактирования, а не
  // выборка тендеров; в остальных случаях возвращаем сохранённую вкладку.
  const [activeTab, setActiveTab] = useState(() => (
    typeof savedFilters.activeTab === 'string' && savedFilters.activeTab !== 'template'
      ? savedFilters.activeTab
      : 'all'
  ))
  // task 232/233: статус-вкладки скрыты под кнопкой «Статусы тендеров»
  const [statusMenuOpen, setStatusMenuOpen] = useState(false)
  const [editingTender, setEditingTender] = useState(null)
  const [expandedTenderId, setExpandedTenderId] = useState(null)
  const [tenderCounterparties, setTenderCounterparties] = useState({})
  // Идентификаторы тендеров, у которых список контрагентов сейчас грузится
  // (чтобы при раскрытии показать индикатор загрузки, а не «контрагентов нет»).
  const [loadingCounterparties, setLoadingCounterparties] = useState(() => new Set())
  // task 427: DnD-перестановка участников
  const [draggedTc, setDraggedTc] = useState(null) // { tenderId, id }
  const [tcDragOver, setTcDragOver] = useState(null) // { id, position }
  // Сводка по каждому тендеру: { tenderId: { total, proposalProvided } }
  const [tenderProposalCounts, setTenderProposalCounts] = useState({})
  // Примечание участника: явное редактирование (одна строка за раз) и хронология правок
  const [notesEdit, setNotesEdit] = useState(null) // { tcId, draft } | null
  const [savingNotes, setSavingNotes] = useState(false)
  const [notesHistoryFor, setNotesHistoryFor] = useState(null) // { tenderId, tcId, cpName } | null
  const [notesHistoryRows, setNotesHistoryRows] = useState([])
  const [notesHistoryLoading, setNotesHistoryLoading] = useState(false)
  const [copiedEmailsTenderId, setCopiedEmailsTenderId] = useState(null)
  const [editingResponsibleTenderId, setEditingResponsibleTenderId] = useState(null)
  const [showAddCounterpartyModal, setShowAddCounterpartyModal] = useState(false)
  const [selectedTenderForCounterparty, setSelectedTenderForCounterparty] = useState(null)
  const [counterpartySearchQuery, setCounterpartySearchQuery] = useState('')
  const [counterpartyWorkTypeFilter, setCounterpartyWorkTypeFilter] = useState('')
  const [selectedCounterpartyIds, setSelectedCounterpartyIds] = useState([])
  const [showWinnerModal, setShowWinnerModal] = useState(false)
  const [tenderForWinnerSelection, setTenderForWinnerSelection] = useState(null)
  // task 215: несколько победителей — массив { counterparty_id, scope_note }
  const [selectedWinners, setSelectedWinners] = useState([])
  const [showLetterModal, setShowLetterModal] = useState(false)
  const [generatedLetter, setGeneratedLetter] = useState('')
  const [letterCopied, setLetterCopied] = useState(false)

  const DEFAULT_LETTER_TEMPLATE = `Тема письма: Объект {object_name} / Тендер № {tender_number} / Приглашение на участие в тендере на выполнение работ {work_description}

Уважаемые руководители!

ООО «СУ-10» уведомляет о проведении тендера № {tender_number} на выбор подрядчика на {work_description} для объекта: «{object_name}».

В связи с этим, мы приглашаем вашу компанию принять участие в тендере и предоставить свои предложения для рассмотрения.
Срок подачи заявок на участие в тендере: {start_date}-{end_date} гг.

Для получения дополнительных разъяснений и уточнений вы можете связаться с нами по телефону {employee_phone} или отправить запрос на электронную почту {employee_email}, в теле письма указать по какому тендеру и объекту обращаетесь.

Мы рассчитываем на плодотворное сотрудничество и надеемся на участие вашей компании в тендере.

Приложение: ссылка на тендерную документацию:
{tender_package_link}

С уважением,
{employee_position} ООО "СУ-10"
{employee_name}
Телефон для связи: {employee_phone}
Почта: {employee_email}`

  // Ключ версионный: в шаблон добавлены тема письма и № тендера, и сохранённый
  // раньше вариант их не содержит. Без смены ключа никто из тех, кто хоть раз
  // нажимал «Сохранить шаблон», нововведений бы не увидел.
  const LETTER_TEMPLATE_KEY = 'letterTemplate:v2'
  const [letterTemplate, setLetterTemplate] = useState(() => {
    return localStorage.getItem(LETTER_TEMPLATE_KEY) || DEFAULT_LETTER_TEMPLATE
  })
  const [templateSaved, setTemplateSaved] = useState(false)
  // Фильтры множественного выбора: пустой массив = фильтр не применён.
  const [objectFilter, setObjectFilter] = useState(() => Array.isArray(savedFilters.objectFilter) ? savedFilters.objectFilter : [])
  const [responsibleFilter, setResponsibleFilter] = useState(() => Array.isArray(savedFilters.responsibleFilter) ? savedFilters.responsibleFilter : [])
  const [statusFilter, setStatusFilter] = useState(() => Array.isArray(savedFilters.statusFilter) ? savedFilters.statusFilter : [])
  const [searchQuery, setSearchQuery] = useState(() => typeof savedFilters.searchQuery === 'string' ? savedFilters.searchQuery : '')
  // Компактный вид: скрывает столбцы «ВОРы и РД», «План затрат», «Тендер на материалы», «Сводная КП»
  // и сохраняется в localStorage отдельно для каждого представления (construction/warranty/materials).
  const compactStorageKey = `tenders-compact-view:${tenderType}:${department}`
  const [compactView, setCompactView] = useState(() => {
    try { return localStorage.getItem(compactStorageKey) === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(compactStorageKey, compactView ? '1' : '0') } catch { /* noop */ }
  }, [compactView, compactStorageKey])
  // Родительский тендер при создании дочернего тендера на материалы (preselect)
  const [materialsParentTender, setMaterialsParentTender] = useState(null)
  const [sortField, setSortField] = useState(() => savedFilters.sortField || 'start_date') // 'start_date' | 'end_date'
  const [sortOrder, setSortOrder] = useState(() => savedFilters.sortOrder || 'desc') // 'asc' | 'desc'
  // Сохраняем настроенные фильтры при каждом изменении — восстановятся при
  // возврате со страницы тендера (см. savedFilters выше). Эффект объявлен ПОСЛЕ
  // sortField/sortOrder: массив зависимостей вычисляется сразу, а до их
  // объявления они в TDZ (иначе ReferenceError и белый экран при рендере).
  useEffect(() => {
    try {
      localStorage.setItem(filtersStorageKey, JSON.stringify({
        activeTab, searchQuery, objectFilter, responsibleFilter, statusFilter, sortField, sortOrder,
      }))
    } catch { /* noop */ }
  }, [filtersStorageKey, activeTab, searchQuery, objectFilter, responsibleFilter, statusFilter, sortField, sortOrder])
  const [formData, setFormData] = useState({
    object_id: '',
    work_description: '',
    status: 'Заявка на тендер',
    start_date: '',
    end_date: '',
    tender_package_link: '',
    responsible_contact_id: '',
    cost_plan_link: '',
    cost_plan_responsible_id: '',
    vor_link: '',
    vor_responsible_id: '',
    vor_start_date: '',
    vor_end_date: '',
    tender_start_date: '',
    tender_end_date: '',
    summary_proposal_link: '',
    notes: '',
  })
  // Отдельное состояние поля «Наименование объекта» в направлении «прочее»:
  // это свободный текст, который при сохранении раскладывается либо в object_id
  // (если совпал с объектом реестра), либо в custom_object_name.
  const [objectNameInput, setObjectNameInput] = useState('')

  // Настройки направления: какие объекты доступны, обязателен ли объект, заголовок,
  // тон плитки-иконки. Единый справочник — src/utils/tenderDepartments.js.
  const dept = departmentConfig(department)
  // Статус объектов для формы: null = объекты обоих отделов (совместные / прочее).
  const objectStatus = dept.objectStatus
  const pageTitle = isMaterialsView ? 'Тендеры на материалы' : dept.title
  // Иконка в шапке — своя на каждое направление, как у пунктов бокового меню.
  const HeaderIcon = isMaterialsView
    ? IconPackage
    : { construction: IconHardHat, warranty: IconShieldCheck, joint: IconJoint, other: IconOther }[dept.key]
  const headerTone = isMaterialsView ? 'sand' : dept.tone
  // Объект обязателен везде, кроме «прочего»: там встречаются общехозяйственные
  // закупки, не привязанные к стройплощадке.
  const objectRequired = isMaterialsView ? true : dept.requireObject
  // Смешанный список объектов показываем с бейджем отдела — иначе одноимённые
  // объекты ОС и ГО в одном списке не различить.
  const showObjectDeptBadge = !isMaterialsView && dept.objectStatus === null
  // «Прочее»: наименование объекта можно вписать руками, минуя реестр объектов.
  const allowCustomObject = !isMaterialsView && !!dept.allowCustomObject
  // Введённое имя, совпавшее с объектом реестра (без учёта регистра и пробелов):
  // тогда тендер привязывается к объекту, а не хранит текст.
  const matchedObjectByName = (() => {
    const q = objectNameInput.trim().toLowerCase()
    if (!q) return null
    return objects.find(o => (o.name || '').trim().toLowerCase() === q) || null
  })()

  const statusOptions = ['Заявка на тендер', 'Подготовка ВОР', 'Идет тендерная процедура', 'Подведение итогов', 'Завершен', 'Приостановка тендера']
  // Отдельный набор статусов для тендеров на материалы — не пересекается со статусами основного тендера.
  // «Не требуется» — финальный статус (материалы закупать не требуется), считается как завершённый.
  const materialsStatusOptions = ['Не начат', 'В работе', 'Завершён', 'Не требуется']
  const currentStatusOptions = isMaterialsView ? materialsStatusOptions : statusOptions
  // Для тендеров на материалы «завершённые» — это «Завершён» и «Не требуется»
  // (а также старое значение «Не нужно» — для обратной совместимости).
  // Для основных тендеров — только «Завершен».
  const isCompletedStatus = (status) => isMaterialsView
    ? (status === 'Завершён' || status === 'Не требуется' || status === 'Не нужно')
    : (status === 'Завершен')
  const initialStatusValue = isMaterialsView ? 'Не начат' : 'Заявка на тендер'

  const counterpartyStatusOptions = [
    { value: 'request_sent', label: 'Запрос отправлен' },
    { value: 'accepted_for_work', label: 'Принято в работу' },
    { value: 'proposal_provided', label: 'КП предоставлено' },
    { value: 'declined', label: 'Отказ' }
  ]

  const getCounterpartyStatusLabel = (status) => {
    const option = counterpartyStatusOptions.find(opt => opt.value === status)
    return option ? option.label : status
  }

  const getCounterpartyStatusColor = (status) => {
    const colors = {
      'request_sent': '#6b7a99',
      'declined': '#9c6b6b',
      'proposal_provided': '#5a8a72',
      'accepted_for_work': '#4338ca'
    }
    return colors[status] || '#64748b'
  }

  useEffect(() => {
    // Загружаем всё параллельно
    Promise.all([
      fetchTenders(),
      fetchObjects(),
      fetchCounterparties(),
      fetchResponsibleContacts(),
      fetchTenderProposalCounts()
    ])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [department, tenderType])

  // Сводный запрос: считаем для каждого тендера сколько контрагентов и сколько предоставили КП.
  // Пагинация обязательна: Supabase по умолчанию отдаёт максимум 1000 строк, а выборка идёт по
  // ВСЕЙ таблице участников. Без неё знаменатель занижался («0/8» вместо «0/10»), а у тендеров,
  // чьи строки уходили за лимит, бейдж пропадал совсем.
  // .order('id') обязателен: без стабильного ключа порядок = порядок кучи Postgres, а UPDATE
  // статуса физически переносит строку в конец — счётчик «прыгал» после смены статуса.
  const fetchTenderProposalCounts = async () => {
    try {
      const PAGE = 1000
      const rows = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('tender_counterparties')
          .select('tender_id, status')
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1)
        if (error) throw error
        if (data?.length) rows.push(...data)
        if (!data || data.length < PAGE) break
      }
      const map = {}
      rows.forEach(row => {
        const t = row.tender_id
        if (!map[t]) map[t] = { total: 0, proposalProvided: 0 }
        map[t].total += 1
        if (row.status === 'proposal_provided') map[t].proposalProvided += 1
      })
      setTenderProposalCounts(map)
    } catch (err) {
      console.error('Ошибка загрузки счётчиков КП:', err.message)
    }
  }

  const fetchTenders = async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('tenders')
        .select('*, objects(name, status, address, map_link), winner:counterparties!winner_counterparty_id(id, name), tender_winners(counterparty_id, scope_note, counterparties(id, name)), responsible_contact:contacts!responsible_contact_id(id, full_name), cost_plan_responsible:contacts!cost_plan_responsible_id(id, full_name), vor_responsible:contacts!vor_responsible_id(id, full_name), materials_tender:tenders!parent_tender_id(id, status, summary_proposal_link, cost_plan_status, cost_plan_link, materials_proposal_deadline, materials_proposal_link)')
        .eq('tender_type', tenderType)
        .order('start_date', { ascending: false })

      if (error) throw error
      // Reverse FK tenders!parent_tender_id возвращается массивом (UNIQUE на parent_tender_id нет).
      // Сводим к одному объекту или null, чтобы дальше обращаться как tender.materials_tender.status.
      const normalized = (data || []).map(t => ({
        ...t,
        materials_tender: Array.isArray(t.materials_tender)
          ? (t.materials_tender[0] || null)
          : (t.materials_tender || null)
      }))
      // Основные тендеры разложены по направлениям через tenders.department
      // (миграция 20260820). Раньше направление вычислялось из статуса объекта —
      // так «совместные» и «прочие» не выразить, объекта у них может не быть вовсе.
      // Тендеры на материалы показываем все, без деления по направлениям.
      let filteredTenders = isMaterialsView
        ? normalized
        : normalized.filter(tender => (tender.department || 'construction') === dept.key)
      if (scopedObjectIds.length > 0) {
        filteredTenders = filteredTenders.filter(t => scopedObjectIds.includes(t.object_id))
      }

      // task 223b: для тендеров на материалы подгружаем родительский тендер
      // основного строительства (отдельным запросом — self-FK неоднозначен в embed).
      if (isMaterialsView) {
        const parentIds = [...new Set(filteredTenders.map(t => t.parent_tender_id).filter(Boolean))]
        if (parentIds.length > 0) {
          const { data: parents, error: parentsError } = await supabase
            .from('tenders')
            .select('id, public_tender_number, work_description, objects(name)')
            .in('id', parentIds)
          if (parentsError) {
            console.error('Не удалось загрузить родительские тендеры:', parentsError.message)
          } else {
            const parentMap = new Map((parents || []).map(p => [p.id, p]))
            // task 231: описание работ тендера на материалы всегда взято из
            // основного тендера (взаимосвязь). Если разошлось — тихо приводим
            // к родительскому и в отображении, и в БД (самовосстановление,
            // чинит и старые расхождения без миграции).
            const toSync = []
            filteredTenders = filteredTenders.map(t => {
              const parent = t.parent_tender_id ? (parentMap.get(t.parent_tender_id) || null) : null
              if (parent && (parent.work_description || '') !== (t.work_description || '')) {
                toSync.push({ id: t.id, work_description: parent.work_description })
                return { ...t, parent_tender: parent, work_description: parent.work_description }
              }
              return { ...t, parent_tender: parent }
            })
            if (toSync.length > 0) {
              await Promise.all(toSync.map(async (s) => {
                const { error: upErr } = await supabase
                  .from('tenders')
                  .update({ work_description: s.work_description })
                  .eq('id', s.id)
                if (upErr) {
                  console.error('Синхронизация описания тендера на материалы не удалась:', s.id, upErr.message)
                }
              }))
            }
          }
        }
      }

      setTenders(filteredTenders)
      fetchVorDocCounts(filteredTenders.map(t => t.id))
    } catch (error) {
      console.error('Ошибка загрузки тендеров:', error.message)
    } finally {
      setLoading(false)
    }
  }

  // task 393/397: счётчики документов тендера одним запросом — для бейджей в колонках
  // «ВОРы и РД» (категория 'vor') и «Тендерный пакет» (категория 'tender_package')
  const fetchVorDocCounts = async (tenderIds) => {
    if (!tenderIds || tenderIds.length === 0) { setVorDocCounts({}); setPackageDocCounts({}); return }
    try {
      const { data, error } = await supabase
        .from('s3_documents')
        .select('owner_id, doc_category')
        .eq('owner_type', 'tender')
        .in('doc_category', ['vor', 'tender_package'])
        .in('owner_id', tenderIds)
      if (error) throw error
      const vor = {}
      const pkg = {}
      for (const row of data || []) {
        const bucket = row.doc_category === 'tender_package' ? pkg : vor
        bucket[row.owner_id] = (bucket[row.owner_id] || 0) + 1
      }
      setVorDocCounts(vor)
      setPackageDocCounts(pkg)
    } catch (err) {
      console.error('Ошибка загрузки счётчиков документов тендера:', err.message)
    }
  }

  // Пересчитать число документов одной категории для одного тендера (после загрузки/удаления)
  const refreshDocCount = async (tenderId, category, setCounts) => {
    try {
      const { count, error } = await supabase
        .from('s3_documents')
        .select('id', { count: 'exact', head: true })
        .eq('owner_type', 'tender')
        .eq('doc_category', category)
        .eq('owner_id', tenderId)
      if (error) throw error
      setCounts(prev => ({ ...prev, [tenderId]: count || 0 }))
    } catch (err) {
      console.error('Ошибка обновления счётчика документов тендера:', err.message)
    }
  }
  const refreshVorDocCount = (tenderId) => refreshDocCount(tenderId, 'vor', setVorDocCounts)
  const refreshPackageDocCount = (tenderId) => refreshDocCount(tenderId, 'tender_package', setPackageDocCounts)

  const fetchObjects = async () => {
    try {
      let query = supabase
        .from('objects')
        .select('*')
        .order('name', { ascending: true })
      // Объекты любого отдела — для тендеров на материалы и для направлений
      // «совместные» / «прочее» (objectStatus = null).
      if (!isMaterialsView && objectStatus) {
        query = query.eq('status', objectStatus)
      }
      const { data, error } = await query

      if (error) throw error
      setObjects(data || [])
    } catch (error) {
      console.error('Ошибка загрузки объектов:', error.message)
    }
  }

  const fetchCounterparties = async () => {
    try {
      // Постранично: PostgREST молча отдаёт максимум 1000 строк, а активных контрагентов
      // уже больше — без пагинации обрезался хвост сортировки по названию (буква «Ф» и далее).
      // Тай-брейк по id обязателен: имена неуникальны, иначе страницы «плывут».
      const PAGE = 1000
      const rows = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('counterparties')
          .select('*')
          .eq('status', 'active')
          .is('deleted_at', null)   // удалённых не предлагаем к добавлению в тендер
          .order('name', { ascending: true })
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1)
        if (error) throw error
        if (data?.length) rows.push(...data)
        if (!data || data.length < PAGE) break
      }
      setCounterparties(rows)
    } catch (error) {
      console.error('Ошибка загрузки контрагентов:', error.message)
    }
  }

  const ROLE_LABELS_MAP = {
    admin: 'Администратор',
    engineer: 'Инженер ОСП',
    economist: 'Экономист ОСП',
    lawyer: 'Юрист ОСП'
  }

  // Справочник сотрудников ведётся ВРУЧНУЮ в «Общая информация → Сотрудники».
  // Раньше сюда подмешивались профили из user_roles, и недостающие автоматически
  // вставлялись в contacts при каждом открытии страницы. Сверка шла по сырому ФИО,
  // поэтому лишний пробел/иной регистр давали новую запись — так копились дубли,
  // а в «Должность» попадал служебный слаг роли ('otiz', 'udorojanie').
  // Связь с пользователями сайта разорвана: список = только таблица contacts.
  const fetchResponsibleContacts = async () => {
    try {
      const { data, error } = await supabase
        .from('contacts')
        .select('*, departments(name)')
        .order('full_name', { ascending: true })
      if (error) throw error
      setResponsibleContacts(data || [])
    } catch (error) {
      console.error('Ошибка загрузки сотрудников:', error.message)
    }
  }

  // Найти имя ответственного по tender
  const getResponsibleName = (tender) => {
    if (tender.responsible_contact?.full_name) return tender.responsible_contact.full_name
    return null
  }

  // task 392: «Ответственный по тендеру» назначается только из сотрудников СУ-10 —
  // отдел «ОСП» И должность «Инженер ОСП». Полный responsibleContacts оставляем как есть
  // (он нужен, например, для генерации письма), а в дропдаунах показываем подмножество.
  const OSP_DEPT = 'ОСП'
  const OSP_POSITION = 'Инженер ОСП'
  const eligibleResponsibleContacts = responsibleContacts.filter(
    (c) => c.departments?.name === OSP_DEPT && c.position === OSP_POSITION
  )
  // Опции для конкретного селекта: допустимые + (если назначен «не-ОСП») текущий контакт,
  // чтобы уже выбранное значение не пропадало визуально.
  const getResponsibleOptions = (selectedId) => {
    if (!selectedId || eligibleResponsibleContacts.some((c) => c.id === selectedId)) {
      return eligibleResponsibleContacts
    }
    const current = responsibleContacts.find((c) => c.id === selectedId)
    return current ? [current, ...eligibleResponsibleContacts] : eligibleResponsibleContacts
  }

  const fetchTenderCounterparties = async (tenderId) => {
    setLoadingCounterparties(prev => new Set(prev).add(tenderId))
    try {
      const { data, error } = await supabase
        .from('tender_counterparties')
        .select(`
          *,
          counterparties(
            id,
            name,
            work_type,
            inn,
            counterparty_contacts(
              id,
              full_name,
              position,
              phone,
              email
            )
          )
        `)
        .eq('tender_id', tenderId)
        .order('sort_order', { ascending: true })
        .order('invited_at', { ascending: true })

      if (error) throw error
      setTenderCounterparties(prev => ({
        ...prev,
        [tenderId]: data || []
      }))
    } catch (error) {
      console.error('Ошибка загрузки контрагентов тендера:', error.message)
    } finally {
      setLoadingCounterparties(prev => {
        const next = new Set(prev)
        next.delete(tenderId)
        return next
      })
    }
  }

  const handleToggleTender = async (tenderId) => {
    // Незавершённое редактирование примечания сбрасываем: строка скрывается,
    // и висящий черновик только путал бы при повторном раскрытии.
    setNotesEdit(null)
    if (expandedTenderId === tenderId) {
      setExpandedTenderId(null)
    } else {
      setExpandedTenderId(tenderId)
      if (!tenderCounterparties[tenderId]) {
        await fetchTenderCounterparties(tenderId)
      }
    }
  }

  const handleAddCounterpartiesToTender = async () => {
    if (!selectedTenderForCounterparty || selectedCounterpartyIds.length === 0) {
      alert('Выберите хотя бы одного контрагента')
      return
    }

    try {
      // Новые участники встают в конец списка. Без явного sort_order они брали
      // DEFAULT 0 (миграция 20260731), а у существующих после бэкфилла 10, 20, 30…
      // — и свежедобавленные оказывались первыми.
      // Максимум спрашиваем у базы, а не у локального состояния: список участников
      // тендера мог быть ещё ни разу не раскрыт, и в памяти его просто нет.
      const { data: lastRow } = await supabase
        .from('tender_counterparties')
        .select('sort_order')
        .eq('tender_id', selectedTenderForCounterparty)
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle()
      const maxOrder = lastRow?.sort_order || 0
      const inserts = selectedCounterpartyIds.map((counterpartyId, i) => ({
        tender_id: selectedTenderForCounterparty,
        counterparty_id: counterpartyId,
        sort_order: maxOrder + (i + 1) * 10,
      }))

      const { error } = await supabase
        .from('tender_counterparties')
        .insert(inserts)

      if (error) throw error

      for (const counterpartyId of selectedCounterpartyIds) {
        const cp = counterparties.find(c => c.id === counterpartyId)
        const name = cp?.name || null
        await logTenderEvent(selectedTenderForCounterparty, 'participant_added', {
          fieldName: 'participants',
          newValue: { id: counterpartyId, name },
          description: `Добавлен участник: ${name || '—'}`
        })
      }

      await fetchTenderCounterparties(selectedTenderForCounterparty)
      fetchTenderProposalCounts()
      setShowAddCounterpartyModal(false)
      setSelectedCounterpartyIds([])
      setCounterpartySearchQuery('')
      setCounterpartyWorkTypeFilter('')
    } catch (error) {
      console.error('Ошибка добавления контрагентов:', error.message)
      alert('Ошибка добавления: ' + error.message)
    }
  }

  const handleToggleCounterpartySelection = (counterpartyId) => {
    setSelectedCounterpartyIds(prev => {
      if (prev.includes(counterpartyId)) {
        return prev.filter(id => id !== counterpartyId)
      } else {
        return [...prev, counterpartyId]
      }
    })
  }

  const handleUpdateCounterpartyStatus = async (tenderId, tenderCounterpartyId, newStatus) => {
    const tc = (tenderCounterparties[tenderId] || []).find(x => x.id === tenderCounterpartyId)
    const oldStatus = tc?.status || 'request_sent'
    const cpName = tc?.counterparties?.name || null
    try {
      const { error } = await supabase
        .from('tender_counterparties')
        .update({ status: newStatus })
        .eq('id', tenderCounterpartyId)

      if (error) throw error

      // Пишем в журнал: отметка «КП предоставлено»/«Отказ» — это результат работы
      // инженера с подрядчиком, и он должен попадать и в историю тендера, и в отчёт
      // «Работа инженеров». Раньше смена статуса нигде не фиксировалась.
      if (oldStatus !== newStatus) {
        logTenderEvent(tenderId, 'participant_status', {
          fieldName: 'participant_status',
          oldValue: { tc_id: tenderCounterpartyId, cp_name: cpName, text: getCounterpartyStatusLabel(oldStatus) },
          newValue: { tc_id: tenderCounterpartyId, cp_name: cpName, text: getCounterpartyStatusLabel(newStatus) },
          description: `Статус участника${cpName ? ` (${cpName})` : ''}: ${getCounterpartyStatusLabel(oldStatus)} → ${getCounterpartyStatusLabel(newStatus)}`,
        })
      }

      // Обновляем локальное состояние
      setTenderCounterparties(prev => ({
        ...prev,
        [tenderId]: prev[tenderId].map(tc =>
          tc.id === tenderCounterpartyId ? { ...tc, status: newStatus } : tc
        )
      }))
      // Перепосчитываем счётчик «КП предоставлено» для этого тендера
      fetchTenderProposalCounts()
    } catch (error) {
      console.error('Ошибка обновления статуса:', error.message)
      alert('Ошибка обновления статуса: ' + error.message)
    }
  }

  const handleUpdateMaterialsDeadline = async (tenderId, value) => {
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ materials_proposal_deadline: value || null })
        .eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t =>
        t.id === tenderId ? { ...t, materials_proposal_deadline: value || null } : t
      ))
    } catch (err) {
      console.error('Ошибка сохранения срока КП на материалы:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleUpdateMaterialsLink = async (tenderId, currentValue) => {
    const next = window.prompt('Ссылка на КП на материалы (Google/Yandex Drive):', currentValue || '')
    if (next === null) return
    const trimmed = next.trim()
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ materials_proposal_link: trimmed || null })
        .eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t =>
        t.id === tenderId ? { ...t, materials_proposal_link: trimmed || null } : t
      ))
    } catch (err) {
      console.error('Ошибка сохранения ссылки на КП:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleUpdateCounterpartyNotes = async (tenderId, tenderCounterpartyId, notes, oldNotes = '', cpName = '') => {
    // Текст, вставленный из Word/PDF/1С, приносит служебные символы, которые Postgres
    // отвергает (22P05) — снаружи это выглядело как необъяснимая «ошибка сохранения»
    // у отдельного сотрудника. Чистим до отправки.
    const cleanNotes = sanitizeUserText(notes) || ''
    const cleanOldNotes = sanitizeUserText(oldNotes) || ''
    try {
      // .select() обязателен: без него не отличить успешную запись от «0 строк».
      // При истёкшей сессии запрос уходит как anon, RLS молча отсекает строку и
      // ошибки нет — раньше UI в этом случае рисовал сохранение как успешное.
      const { data, error } = await supabase
        .from('tender_counterparties')
        .update({ notes: cleanNotes || null })
        .eq('id', tenderCounterpartyId)
        .select('id')

      if (error) {
        console.error('Ошибка сохранения примечания участника:', error)
        alert(isAuthError(error)
          ? SESSION_EXPIRED_MESSAGE
          : 'Не удалось сохранить примечание: ' + describeSupabaseError(error))
        return false
      }

      if (!data || data.length === 0) {
        console.warn('Примечание участника: UPDATE не затронул ни одной строки', { tenderId, tenderCounterpartyId })
        alert('Примечание не сохранено: строка участника недоступна. Обычно это истёкшая сессия или удалённый участник — обновите страницу (F5) и повторите.')
        return false
      }

      setTenderCounterparties(prev => ({
        ...prev,
        [tenderId]: (prev[tenderId] || []).map(tc =>
          tc.id === tenderCounterpartyId ? { ...tc, notes: cleanNotes } : tc
        )
      }))

      // Хронология правок. Привязка к участнику живёт внутри JSONB (tc_id) —
      // отдельная колонка в tender_audit_log не нужна. Ключ именно text, а не name:
      // formatHistoryValue во вкладке «История» тендера разворачивает name и показал
      // бы имя контрагента вместо самого примечания.
      await logTenderEvent(tenderId, 'field_updated', {
        fieldName: 'participant_notes',
        oldValue: { tc_id: tenderCounterpartyId, cp_name: cpName || null, text: cleanOldNotes },
        newValue: { tc_id: tenderCounterpartyId, cp_name: cpName || null, text: cleanNotes },
        description: cpName ? `Примечание участника: ${cpName}` : 'Примечание участника',
      })
      return true
    } catch (err) {
      // Сюда попадают только исключения самого фронта — их нельзя показывать как
      // отказ базы, иначе диагностика уходит не в ту сторону.
      console.error('Непредвиденная ошибка при сохранении примечания участника:', err)
      alert('Непредвиденная ошибка при сохранении примечания: ' + (err?.message || err))
      return false
    }
  }

  // Сохранить правку примечания. Без изменений — просто выходим из режима
  // редактирования, чтобы не плодить пустые записи в истории.
  const handleSaveCounterpartyNotes = async (tenderId, tc) => {
    const draft = notesEdit?.draft ?? ''
    const previous = tc.notes || ''
    if (draft === previous) {
      setNotesEdit(null)
      return
    }
    setSavingNotes(true)
    const ok = await handleUpdateCounterpartyNotes(tenderId, tc.id, draft, previous, tc.counterparties?.name || '')
    setSavingNotes(false)
    if (ok) setNotesEdit(null)
  }

  // История правок примечания конкретного участника.
  const openNotesHistory = async (tenderId, tc) => {
    setNotesHistoryFor({ tenderId, tcId: tc.id, cpName: tc.counterparties?.name || '' })
    setNotesHistoryRows([])
    setNotesHistoryLoading(true)
    try {
      // Постранично: у активного тендера история может перевалить за 1000 записей
      // (потолок PostgREST). Тай-брейк по id — changed_at не уникален.
      const PAGE = 1000
      const rows = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('tender_audit_log')
          .select('*')
          .eq('tender_id', tenderId)
          .eq('field_name', 'participant_notes')
          .order('changed_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, from + PAGE - 1)
        if (error) throw error
        if (data?.length) rows.push(...data)
        if (!data || data.length < PAGE) break
      }
      setNotesHistoryRows(rows.filter(r => r.new_value?.tc_id === tc.id || r.old_value?.tc_id === tc.id))
    } catch (err) {
      console.error('Ошибка загрузки истории примечания:', err.message)
    } finally {
      setNotesHistoryLoading(false)
    }
  }

  const handleUpdateTenderResponsible = async (tenderId, newContactId) => {
    const value = newContactId || null
    const tender = tenders.find(t => t.id === tenderId)
    const oldName = tender?.responsible_contact?.full_name || null
    const newContact = value ? responsibleContacts.find(c => c.id === value) : null
    const newName = newContact?.full_name || null
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ responsible_contact_id: value })
        .eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t =>
        t.id === tenderId
          ? { ...t, responsible_contact_id: value, responsible_contact: newContact ? { id: newContact.id, full_name: newContact.full_name } : null }
          : t
      ))
      if (oldName !== newName) {
        logTenderEvent(tenderId, 'field_updated', {
          fieldName: 'responsible_contact_id',
          oldValue: oldName,
          newValue: newName,
          description: newName
            ? (oldName ? `Сменён ответственный по тендеру: ${oldName} → ${newName}` : `Назначен ответственный по тендеру: ${newName}`)
            : `Снят ответственный по тендеру (был: ${oldName})`,
        })
      }
    } catch (err) {
      console.error('Ошибка назначения ответственного:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  // Отметка публикации тендера в Telegram-канале (галочка под описанием работ).
  const handleToggleTgPublished = async (tenderId, published) => {
    const by = userProfile?.full_name || 'Сотрудник'
    const patch = published
      ? { tg_published: true, tg_published_at: new Date().toISOString(), tg_published_by: by }
      : { tg_published: false, tg_published_at: null, tg_published_by: null }
    try {
      const { error } = await supabase.from('tenders').update(patch).eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t => t.id === tenderId ? { ...t, ...patch } : t))
      logTenderEvent(tenderId, 'field_updated', {
        fieldName: 'tg_published',
        description: published ? 'Отмечена публикация в ТГ-канале' : 'Снята отметка о публикации в ТГ-канале',
      })
    } catch (err) {
      console.error('Ошибка отметки публикации в ТГ:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  // Инлайн-редактирование ссылок (тендерный пакет / сводная КП) прямо из таблицы.
  const TENDER_LINK_FIELDS = {
    tender_package_link: 'Ссылка на тендерный пакет',
    summary_proposal_link: 'Ссылка на сводную КП',
  }
  const handleUpdateTenderLink = async (tenderId, field, currentValue) => {
    const label = TENDER_LINK_FIELDS[field] || 'Ссылка'
    const next = window.prompt(`${label} (Google/Yandex Drive):`, currentValue || '')
    if (next === null) return
    const value = next.trim() || null
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ [field]: value })
        .eq('id', tenderId)
      if (error) throw error
      setTenders(prev => prev.map(t => t.id === tenderId ? { ...t, [field]: value } : t))
      // Пишем событие в журнал, чтобы изменение было видно в истории тендера.
      logTenderEvent(tenderId, 'field_updated', {
        fieldName: field,
        oldValue: currentValue || null,
        newValue: value,
        description: `Изменено: ${label}`,
      })
    } catch (err) {
      console.error('Ошибка сохранения ссылки:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  // Открыть модалку с шаблоном письма прямо из строки таблицы (без перехода в редактирование).
  const handleShowLetterForTender = (tender) => {
    if (!tender.responsible_contact_id) {
      alert('Сначала назначьте ответственного по тендеру — без него нельзя сформировать письмо.')
      return
    }
    const objectName = tenderObjectName(tender, '[Объект не указан]')
    const employee = responsibleContacts.find(c => c.id === tender.responsible_contact_id)
    const letter = generateRequestLetter(tender, objectName, employee)
    setGeneratedLetter(letter)
    setShowLetterModal(true)
  }

  const handleCopyEmailsForTender = async (tenderId) => {
    const rows = tenderCounterparties[tenderId] || []
    const emails = []
    rows.forEach(tc => {
      const contacts = tc.counterparties?.counterparty_contacts || []
      contacts.forEach(c => {
        if (c.email && c.email.trim()) emails.push(c.email.trim())
      })
    })
    const unique = Array.from(new Set(emails))
    if (unique.length === 0) {
      alert('У контрагентов нет email-адресов')
      return
    }
    const ok = await copyToClipboard(unique.join('; '))
    if (ok) {
      setCopiedEmailsTenderId(tenderId)
      setTimeout(() => setCopiedEmailsTenderId(prev => prev === tenderId ? null : prev), 2000)
    } else {
      alert('Не удалось скопировать в буфер обмена')
    }
  }

  // task 427: перетаскивание участника внутри списка тендера (общий порядок с
  // карточкой тендера — сохраняется в tender_counterparties.sort_order).
  const handleReorderTc = async (tenderId, draggedId, targetId) => {
    const position = tcDragOver?.position || 'before'
    setDraggedTc(null)
    setTcDragOver(null)
    const list = tenderCounterparties[tenderId] || []
    const pairs = reorderSiblings(list, draggedId, targetId, position)
    if (!pairs) return
    setTenderCounterparties(prev => ({
      ...prev,
      [tenderId]: (prev[tenderId] || [])
        .map(tc => { const p = pairs.find(x => x.id === tc.id); return p ? { ...tc, sort_order: p.sort_order } : tc })
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)),
    }))
    try {
      await Promise.all(pairs.map(p =>
        supabase.from('tender_counterparties').update({ sort_order: p.sort_order }).eq('id', p.id)
      ))
    } catch (err) {
      alert('Не удалось сохранить порядок участников: ' + (err.message || err))
      fetchTenderCounterparties(tenderId)
    }
  }

  const handleRemoveCounterpartyFromTender = async (tenderId, tenderCounterpartyId) => {
    if (!window.confirm('Удалить контрагента из тендера?')) return

    try {
      const removed = (tenderCounterparties[tenderId] || []).find(tc => tc.id === tenderCounterpartyId)
      const removedInfo = removed
        ? { id: removed.counterparty_id, name: removed.counterparties?.name || null }
        : null

      const { error} = await supabase
        .from('tender_counterparties')
        .delete()
        .eq('id', tenderCounterpartyId)

      if (error) throw error

      if (removedInfo) {
        await logTenderEvent(tenderId, 'participant_removed', {
          fieldName: 'participants',
          oldValue: removedInfo,
          description: `Удалён участник: ${removedInfo.name || '—'}`
        })
      }

      await fetchTenderCounterparties(tenderId)
      fetchTenderProposalCounts()
    } catch (error) {
      console.error('Ошибка удаления контрагента:', error.message)
      alert('Ошибка удаления: ' + error.message)
    }
  }

  const handleInputChange = (e) => {
    const { name, value } = e.target
    setFormData((prev) => ({ ...prev, [name]: value }))
  }

  // Поля, которые могут содержать UUID — пустую строку конвертируем в null,
  // иначе Postgres падает на невалидном UUID.
  const UUID_FIELDS = new Set([
    'object_id', 'responsible_contact_id', 'cost_plan_responsible_id', 'vor_responsible_id'
  ])
  const normalizeField = (key, value) => {
    if (value === '' || value === undefined) return null
    return value
  }
  const normalizePayload = (data) => {
    const out = {}
    for (const [k, v] of Object.entries(data)) {
      const nv = normalizeField(k, v)
      // UUID — null если пусто
      if (UUID_FIELDS.has(k) && (nv === '' || nv == null)) {
        out[k] = null
      } else {
        out[k] = nv
      }
    }
    return out
  }

  // Направление «прочее»: свободный текст из поля раскладываем в два поля БД.
  // Совпал с объектом реестра — привязываем к нему; иначе сохраняем как текст,
  // и в таблицу objects ничего не добавляется.
  const resolveCustomObject = () => {
    if (!allowCustomObject) return null
    const name = objectNameInput.trim()
    if (!name) return { object_id: null, custom_object_name: null }
    if (matchedObjectByName) return { object_id: matchedObjectByName.id, custom_object_name: null }
    return { object_id: null, custom_object_name: name }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    try {
      if (editingTender) {
        // Update existing tender — отправляем все поля
        const updatePayload = { ...normalizePayload(formData), ...(resolveCustomObject() || {}) }
        const { error } = await supabase
          .from('tenders')
          .update(updatePayload)
          .eq('id', editingTender.id)

        if (error) throw error

        // Логируем изменения каждого поля
        const trackFields = [
          'work_description', 'start_date', 'end_date',
          'vor_start_date', 'vor_end_date', 'tender_start_date', 'tender_end_date',
          'tender_package_link', 'responsible_contact_id', 'object_id',
          'cost_plan_link', 'cost_plan_responsible_id',
          'vor_link', 'vor_responsible_id',
          'summary_proposal_link', 'notes'
        ]
        for (const f of trackFields) {
          const oldV = editingTender[f] ?? null
          const newV = updatePayload[f] ?? null
          if ((oldV || null) !== (newV || null)) {
            await logTenderEvent(editingTender.id, 'field_updated', {
              fieldName: f,
              oldValue: oldV,
              newValue: newV,
              description: `Изменено: ${FIELD_LABELS[f] || f}`
            })
          }
        }
        // Если статус изменился через форму — отдельно
        if ((editingTender.status || null) !== (formData.status || null)) {
          await logTenderEvent(editingTender.id, 'status_changed', {
            oldValue: editingTender.status || null,
            newValue: formData.status,
            description: `Статус: ${editingTender.status || '—'} → ${formData.status}`
          })
        }

        // task 223a / 226 / 229: описание работ основного тендера взаимосвязано
        // с дочерним тендером на материалы — синхронизируем при любом изменении.
        const descChanged = (editingTender.work_description || '') !== (updatePayload.work_description || '')
        if (editingTender.tender_type !== 'materials' && descChanged) {
          const newDesc = updatePayload.work_description
          let syncedCount = 0

          // 1) Основной путь: дочерние тендеры на материалы по parent_tender_id.
          const { data: byParent, error: byParentErr } = await supabase
            .from('tenders')
            .update({ work_description: newDesc })
            .eq('parent_tender_id', editingTender.id)
            .select('id')
          if (byParentErr) {
            console.error('Синхронизация описания (по parent_tender_id) не удалась:', byParentErr.message)
          } else {
            syncedCount += byParent?.length || 0
          }

          // 2) Самовосстановление связи: если по parent_tender_id ничего не нашлось,
          //    подхватываем «осиротевшие» тендеры на материалы того же объекта
          //    (parent_tender_id IS NULL) — обновляем описание и проставляем связь,
          //    чтобы дальше работал быстрый путь.
          if (syncedCount === 0 && editingTender.object_id) {
            const { data: adopted, error: adoptErr } = await supabase
              .from('tenders')
              .update({ work_description: newDesc, parent_tender_id: editingTender.id })
              .eq('object_id', editingTender.object_id)
              .eq('tender_type', 'materials')
              .is('parent_tender_id', null)
              .select('id')
            if (adoptErr) {
              console.error('Синхронизация описания (привязка по объекту) не удалась:', adoptErr.message)
            } else {
              syncedCount += adopted?.length || 0
            }
          }

          if (syncedCount === 0) {
            console.warn('Описание работ изменено, но связанный тендер на материалы не найден ' +
              '(нет тендера на материалы с parent_tender_id этого тендера и нет несвязанного ' +
              'тендера на материалы для объекта).')
          }
        }
      } else {
        // Insert new tender — только минимальный набор для заявки от руководителя строительства.
        // Это страхует от падений, если новые миграции (notes, cost_plan_*, vor_*) ещё не применены.
        // Тип тендера определяется текущим режимом страницы или явным запуском дочернего тендера на материалы.
        const newTenderType = materialsParentTender ? 'materials' : tenderType
        const custom = resolveCustomObject()
        const insertPayload = {
          object_id: custom ? custom.object_id : (formData.object_id || null),
          ...(custom?.custom_object_name ? { custom_object_name: custom.custom_object_name } : {}),
          work_description: formData.work_description,
          status: formData.status || initialStatusValue,
          // task 270: даты работ необязательны — пустое значение сохраняем как NULL
          start_date: formData.start_date || null,
          end_date: formData.end_date || null,
          tender_type: newTenderType,
          // Направление задаётся разделом, в котором создают тендер; дочерний
          // тендер на материалы наследует направление родителя.
          department: materialsParentTender
            ? (materialsParentTender.department || 'construction')
            : dept.key,
        }
        if (materialsParentTender) {
          insertPayload.parent_tender_id = materialsParentTender.id
        }
        if (formData.notes) insertPayload.notes = formData.notes
        // task 271: даты тендерной процедуры теперь сохраняются и при создании
        // (поля есть в форме создания, но раньше не попадали в insert).
        if (formData.tender_start_date) insertPayload.tender_start_date = formData.tender_start_date
        if (formData.tender_end_date) insertPayload.tender_end_date = formData.tender_end_date

        // Вставка с автоматическим retry: если БД ругается на отсутствующие новые колонки
        // (миграция ещё не применена), отбрасываем эти поля и пробуем снова.
        const insertTenderWithRetry = async (payload) => {
          const attempt = async (p) => await supabase
            .from('tenders')
            .insert([p])
            .select('id')
            .single()
          let p = { ...payload }
          let res = await attempt(p)
          // Retry для каждой проблемной колонки (notes, tender_type, parent_tender_id)
          for (let i = 0; i < 4 && res.error; i++) {
            const m = res.error.message || ''
            const match = m.match(/column "?([a-z_]+)"? .* does not exist/i)
              || m.match(/Could not find the '([a-z_]+)' column/i)
            if (match && p[match[1]] !== undefined) {
              const col = match[1]
              const next = { ...p }
              delete next[col]
              p = next
              res = await attempt(p)
              continue
            }
            break
          }
          return { res, finalPayload: p }
        }

        const { res: mainRes, finalPayload: mainFinalPayload } = await insertTenderWithRetry(insertPayload)
        let createdMainId = null
        if (mainRes.error) throw mainRes.error
        if (mainRes.data?.id) {
          createdMainId = mainRes.data.id
          await logTenderEvent(mainRes.data.id, 'created', {
            newValue: mainFinalPayload,
            description: 'Тендер создан'
          })
        }

        // Автоматически создаём связанный тендер на материалы только для тендеров основного строительства.
        // В гарантийном отделе тендеры на материалы не нужны.
        if (createdMainId && newTenderType === 'main' && department === 'construction') {
          // Если retry основной вставки удалил tender_type / parent_tender_id — миграция не применена,
          // создание дочернего тендера невозможно. Сообщаем пользователю явно.
          if (mainFinalPayload.tender_type === undefined) {
            alert('Тендер создан, но автосоздание тендера на материалы пропущено: миграция 20260515_add_tender_type_and_parent не применена в БД. Примените миграцию и пересоздайте основной тендер.')
          } else {
            try {
              const materialsPayload = {
                object_id: insertPayload.object_id,
                work_description: insertPayload.work_description,
                status: 'Не начат',
                start_date: insertPayload.start_date,
                end_date: insertPayload.end_date,
                tender_type: 'materials',
                parent_tender_id: createdMainId,
                department: insertPayload.department,
              }
              const { res: matRes, finalPayload: matFinalPayload } = await insertTenderWithRetry(materialsPayload)
              if (matRes.error) {
                console.error('Не удалось автоматически создать тендер на материалы:', matRes.error.message)
                alert('Тендер создан, но автосоздание тендера на материалы не удалось: ' + matRes.error.message)
              } else if (matRes.data?.id) {
                await logTenderEvent(matRes.data.id, 'created', {
                  newValue: matFinalPayload,
                  description: 'Тендер на материалы создан автоматически'
                })
              }
            } catch (matErr) {
              console.error('Ошибка автосоздания тендера на материалы:', matErr.message)
              alert('Ошибка автосоздания тендера на материалы: ' + matErr.message)
            }
          }
        }
      }

      setShowModal(false)
      setEditingTender(null)
      setMaterialsParentTender(null)
      setFormData({
        object_id: '',
        work_description: '',
        status: initialStatusValue,
        start_date: '',
        end_date: '',
        tender_package_link: '',
        responsible_contact_id: '',
        cost_plan_link: '',
        cost_plan_responsible_id: '',
        vor_link: '',
        vor_responsible_id: '',
        vor_start_date: '',
        vor_end_date: '',
        tender_start_date: '',
        tender_end_date: '',
        summary_proposal_link: '',
        notes: '',
      })
      fetchTenders()
    } catch (error) {
      console.error('Ошибка сохранения тендера:', error.message)
      alert('Ошибка: ' + error.message)
    }
  }

  const handleEditTender = (tender) => {
    setEditingTender(tender)
    setFormData({
      object_id: tender.object_id || '',
      work_description: tender.work_description,
      status: tender.status,
      start_date: tender.start_date || '',
      end_date: tender.end_date || '',
      tender_package_link: tender.tender_package_link || '',
      responsible_contact_id: tender.responsible_contact_id || '',
      cost_plan_link: tender.cost_plan_link || '',
      cost_plan_responsible_id: tender.cost_plan_responsible_id || '',
      vor_link: tender.vor_link || '',
      vor_responsible_id: tender.vor_responsible_id || '',
      vor_start_date: tender.vor_start_date || '',
      vor_end_date: tender.vor_end_date || '',
      tender_start_date: tender.tender_start_date || '',
      tender_end_date: tender.tender_end_date || '',
      summary_proposal_link: tender.summary_proposal_link || '',
      notes: tender.notes || '',
    })
    // Поле «прочего»: показываем то, что реально записано — имя объекта из
    // реестра либо вписанное вручную.
    setObjectNameInput(tender.objects?.name || tender.custom_object_name || '')
    setShowModal(true)
  }

  // Мягкое удаление: тендер уходит во вкладку «Удалённые» и может быть восстановлен.
  const handleDeleteTender = async (id, objectName) => {
    if (!isAdmin) {
      alert('Удалять тендеры может только администратор.')
      return
    }
    if (
      window.confirm(`Переместить тендер "${objectName}" в «Удалённые»? Его можно будет восстановить.`)
    ) {
      try {
        const delAt = new Date().toISOString()
        const { error } = await supabase
          .from('tenders')
          .update({ deleted_at: delAt })
          .eq('id', id)
        if (error) throw error
        // task 267: дочерние тендеры на материалы тоже уходят в «Удалённые»
        const { error: childErr } = await supabase
          .from('tenders')
          .update({ deleted_at: delAt })
          .eq('parent_tender_id', id)
        if (childErr) console.error('Не удалось удалить связанный тендер на материалы:', childErr.message)
        fetchTenders()
      } catch (error) {
        console.error('Ошибка удаления тендера:', error.message)
        alert('Ошибка удаления: ' + error.message)
      }
    }
  }

  const handleRestoreTender = async (id, objectName) => {
    if (!window.confirm(`Восстановить тендер "${objectName}"?`)) return
    try {
      const { error } = await supabase
        .from('tenders')
        .update({ deleted_at: null })
        .eq('id', id)
      if (error) throw error
      // task 267: восстанавливаем и связанный тендер на материалы
      const { error: childErr } = await supabase
        .from('tenders')
        .update({ deleted_at: null })
        .eq('parent_tender_id', id)
      if (childErr) console.error('Не удалось восстановить связанный тендер на материалы:', childErr.message)
      fetchTenders()
    } catch (err) {
      console.error('Ошибка восстановления тендера:', err.message)
      alert('Ошибка восстановления: ' + err.message)
    }
  }

  const handleHardDeleteTender = async (id, objectName) => {
    if (!isAdmin) {
      alert('Удалять тендеры может только администратор.')
      return
    }
    if (!window.confirm(`Удалить тендер "${objectName}" БЕЗВОЗВРАТНО? Это действие нельзя отменить.`)) return
    try {
      const { error } = await supabase.from('tenders').delete().eq('id', id)
      if (error) throw error
      fetchTenders()
    } catch (err) {
      console.error('Ошибка безвозвратного удаления:', err.message)
      alert('Ошибка: ' + err.message)
    }
  }

  const handleAddNew = () => {
    setEditingTender(null)
    setMaterialsParentTender(null)
    setFormData({
      object_id: '',
      work_description: '',
      status: initialStatusValue,
      start_date: '',
      end_date: '',
      tender_package_link: '',
      responsible_contact_id: '',
      cost_plan_link: '',
      cost_plan_responsible_id: '',
      vor_link: '',
      vor_responsible_id: '',
      vor_start_date: '',
      vor_end_date: '',
      tender_start_date: '',
      tender_end_date: '',
      summary_proposal_link: '',
      notes: '',
    })
    setObjectNameInput('')
    setShowModal(true)
  }

  // Открыть форму создания дочернего тендера на материалы для конкретного родительского тендера

  const handleStatusChange = async (tenderId, newStatus) => {
    // Для тендеров на материалы выбор победителя не требуется — статус ставится напрямую.
    // Для основных тендеров при переходе в «Завершен» открываем модал выбора победителя.
    if (!isMaterialsView && newStatus === 'Завершен') {
      const tender = tenders.find(t => t.id === tenderId)
      setTenderForWinnerSelection(tender)

      // Загружаем контрагентов тендера если еще не загружены
      if (!tenderCounterparties[tenderId]) {
        await fetchTenderCounterparties(tenderId)
      }

      const existingWinners = (tender?.tender_winners || []).map(w => ({
        counterparty_id: w.counterparty_id,
        scope_note: w.scope_note || ''
      }))
      // подстраховка, если миграция tender_winners ещё не применена
      if (existingWinners.length === 0 && tender?.winner_counterparty_id) {
        existingWinners.push({ counterparty_id: tender.winner_counterparty_id, scope_note: '' })
      }
      setSelectedWinners(existingWinners)
      setShowWinnerModal(true)
      return
    }

    try {
      const prev = tenders.find(t => t.id === tenderId)
      const oldStatus = prev?.status || null

      const { error } = await supabase
        .from('tenders')
        .update({ status: newStatus })
        .eq('id', tenderId)

      if (error) throw error

      if (oldStatus !== newStatus) {
        await logTenderEvent(tenderId, 'status_changed', {
          oldValue: oldStatus,
          newValue: newStatus,
          description: `Статус: ${oldStatus || '—'} → ${newStatus}`
        })
      }

      fetchTenders()
    } catch (error) {
      console.error('Ошибка изменения статуса:', error.message)
      alert('Ошибка изменения статуса: ' + error.message)
    }
  }

  // task 215: помощники для выбора нескольких победителей
  const isWinnerSelected = (cpId) => selectedWinners.some(w => w.counterparty_id === cpId)
  const toggleWinner = (cpId) => setSelectedWinners(prev =>
    prev.some(w => w.counterparty_id === cpId)
      ? prev.filter(w => w.counterparty_id !== cpId)
      : [...prev, { counterparty_id: cpId, scope_note: '' }]
  )
  const setWinnerScope = (cpId, note) => setSelectedWinners(prev =>
    prev.map(w => w.counterparty_id === cpId ? { ...w, scope_note: note } : w)
  )
  const getWinnerScope = (cpId) => selectedWinners.find(w => w.counterparty_id === cpId)?.scope_note || ''

  // task 215: список победителей тендера для отображения (с откатом на одиночного winner)
  const getTenderWinners = (tender) => {
    const tw = tender?.tender_winners || []
    if (tw.length > 0) {
      return tw.map(w => ({
        id: w.counterparty_id,
        name: w.counterparties?.name || '—',
        scope: w.scope_note || ''
      }))
    }
    if (tender?.winner) {
      return [{ id: tender.winner.id, name: tender.winner.name, scope: '' }]
    }
    return []
  }

  const handleConfirmWinner = async () => {
    if (!tenderForWinnerSelection) return

    try {
      const prevStatus = tenderForWinnerSelection.status || null
      // основной победитель (первый выбранный) — для обратной совместимости
      const primaryWinnerId = selectedWinners[0]?.counterparty_id || null

      // Обновляем статус тендера и основного победителя
      const { error: tenderError } = await supabase
        .from('tenders')
        .update({
          status: 'Завершен',
          winner_counterparty_id: primaryWinnerId
        })
        .eq('id', tenderForWinnerSelection.id)

      if (tenderError) throw tenderError

      // Пересобираем список победителей в junction-таблице
      const { error: delError } = await supabase
        .from('tender_winners')
        .delete()
        .eq('tender_id', tenderForWinnerSelection.id)
      if (delError) throw delError

      if (selectedWinners.length > 0) {
        const { error: insError } = await supabase
          .from('tender_winners')
          .insert(selectedWinners.map(w => ({
            tender_id: tenderForWinnerSelection.id,
            counterparty_id: w.counterparty_id,
            scope_note: w.scope_note?.trim() || null
          })))
        if (insError) throw insError
      }

      // Лог: смена статуса
      if (prevStatus !== 'Завершен') {
        await logTenderEvent(tenderForWinnerSelection.id, 'status_changed', {
          oldValue: prevStatus,
          newValue: 'Завершен',
          description: `Статус: ${prevStatus || '—'} → Завершен`
        })
      }

      // Лог: назначение победителей
      if (selectedWinners.length > 0) {
        const tcList = tenderCounterparties[tenderForWinnerSelection.id] || []
        const nameOf = (cpId) => tcList.find(tc => tc.counterparties?.id === cpId)?.counterparties?.name || null
        const winnerNames = selectedWinners
          .map(w => {
            const nm = nameOf(w.counterparty_id) || '—'
            return w.scope_note?.trim() ? `${nm} (${w.scope_note.trim()})` : nm
          })
          .join(', ')
        await logTenderEvent(tenderForWinnerSelection.id, 'winner_assigned', {
          oldValue: tenderForWinnerSelection.winner_counterparty_id || null,
          newValue: { winners: selectedWinners },
          description: `Назначены победители: ${winnerNames}`
        })
      }

      // Задача 390: договоры из тендера автоматически НЕ создаются.
      // Договор заводится вручную в разделе «Договоры» с опциональной привязкой к тендеру.

      setShowWinnerModal(false)
      setTenderForWinnerSelection(null)
      setSelectedWinners([])
      fetchTenders()
    } catch (error) {
      console.error('Ошибка завершения тендера:', error.message)
      alert('Ошибка завершения тендера: ' + error.message)
    }
  }

  const formatDate = (dateString) => {
    if (!dateString) return ''
    return new Date(dateString).toLocaleDateString('ru-RU')
  }

  const formatDateRange = (startDate, endDate) => {
    if (!startDate && !endDate) return '—'
    if (!startDate) return formatDate(endDate)
    if (!endDate) return formatDate(startDate)
    const start = new Date(startDate)
    const end = new Date(endDate)
    const sameYear = start.getFullYear() === end.getFullYear()
    const dd = (d) => String(d.getDate()).padStart(2, '0')
    const mm = (d) => String(d.getMonth() + 1).padStart(2, '0')
    if (sameYear) {
      return `${dd(start)}.${mm(start)} — ${dd(end)}.${mm(end)}.${end.getFullYear()}`
    }
    return `${formatDate(startDate)} — ${formatDate(endDate)}`
  }

  const FIELD_LABELS = {
    work_description: 'Описание работ',
    start_date: 'Дата начала работ',
    end_date: 'Дата окончания работ',
    vor_start_date: 'Начало подготовки ВОР',
    vor_end_date: 'Окончание подготовки ВОР',
    tender_start_date: 'Начало тендерной процедуры',
    tender_end_date: 'Окончание тендерной процедуры',
    tender_package_link: 'Ссылка на тендерный пакет',
    responsible_contact_id: 'Ответственный',
    object_id: 'Объект',
    cost_plan_link: 'План затрат',
    cost_plan_responsible_id: 'Ответственный за план затрат',
    vor_link: 'ВОРы и РД',
    vor_responsible_id: 'Ответственный за ВОРы и РД',
    summary_proposal_link: 'Сводная КП',
    notes: 'Примечание'
  }

  const logTenderEvent = async (tenderId, eventType, payload = {}) => {
    if (!tenderId || !eventType) return
    try {
      const role = localStorage.getItem('userRole') || null
      // supabase-js не бросает исключение — без проверки { error } провал вставки
      // исчезал бесследно, и история молча переставала писаться.
      const { error } = await supabase.from('tender_audit_log').insert([{
        tender_id: tenderId,
        event_type: eventType,
        field_name: payload.fieldName || null,
        old_value: sanitizeDeep(payload.oldValue ?? null),
        new_value: sanitizeDeep(payload.newValue ?? null),
        description: sanitizeUserText(payload.description) || null,
        changed_by_role: role,
        changed_by_name: userProfile?.full_name || null
      }])
      // Пользователю не показываем: основное изменение уже сохранено, история вторична.
      if (error) console.error('Не удалось записать историю тендера:', describeSupabaseError(error), error)
    } catch (err) {
      console.error('Ошибка записи истории тендера:', err?.message || err)
    }
  }

  const formatDateForLetter = (dateString) => {
    if (!dateString) return ''
    const date = new Date(dateString)
    const day = String(date.getDate()).padStart(2, '0')
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const year = date.getFullYear()
    return `${day}.${month}.${year}`
  }

  const generateRequestLetter = (tenderData, objectName, employee) => {
    const replacements = {
      '{work_description}': tenderData.work_description || '[Описание работ]',
      '{object_name}': objectName || '[Объект не указан]',
      // Сквозной номер тендера в портале — он же в теме письма и в реестре.
      '{tender_number}': tenderData.public_tender_number != null
        ? String(tenderData.public_tender_number)
        : '[номер не присвоен]',
      '{start_date}': formatDateForLetter(tenderData.start_date),
      '{end_date}': formatDateForLetter(tenderData.end_date),
      '{employee_name}': employee?.full_name || '[ФИО не указано]',
      '{employee_position}': employee?.position || 'Сотрудник отдела сопровождения подрядчиков',
      '{employee_phone}': employee?.phone || '[Телефон не указан]',
      '{employee_email}': employee?.email || '[Email не указан]',
      '{tender_package_link}': tenderData.tender_package_link || '[Ссылка не указана]'
    }

    let result = letterTemplate
    for (const [key, value] of Object.entries(replacements)) {
      result = result.replaceAll(key, value)
    }
    return result
  }

  const handleSaveTemplate = () => {
    localStorage.setItem(LETTER_TEMPLATE_KEY, letterTemplate)
    setTemplateSaved(true)
    setTimeout(() => setTemplateSaved(false), 2000)
  }

  const handleResetTemplate = () => {
    if (window.confirm('Вернуть шаблон по умолчанию?')) {
      setLetterTemplate(DEFAULT_LETTER_TEMPLATE)
      localStorage.setItem(LETTER_TEMPLATE_KEY, DEFAULT_LETTER_TEMPLATE)
    }
  }

  // ── Ответственный по тендерам: авто-ротация + ручная замена (только админ) ──
  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', RESPONSIBLE_OVERRIDE_KEY)
        .maybeSingle()
      if (!alive) return
      try {
        setResponsibleOverride(data?.value ? JSON.parse(data.value) : null)
      } catch {
        setResponsibleOverride(null)
      }
    })()
    return () => { alive = false }
  }, [])

  // Закрытие мини-меню выбора ответственного (клик вне / Escape)
  useEffect(() => {
    if (!respMenuOpen) return
    const onDown = (e) => { if (!e.target.closest('.tender-resp-chip-wrap')) setRespMenuOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setRespMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [respMenuOpen])

  const currentWeek = weekKey(new Date())
  const overrideActive = !!(responsibleOverride && responsibleOverride.week === currentWeek && responsibleOverride.name)
  const currentResponsible = overrideActive ? responsibleOverride.name : baseResponsible(new Date())

  const persistResponsibleOverride = async (value) => {
    const { error } = await supabase
      .from('app_settings')
      .upsert({ key: RESPONSIBLE_OVERRIDE_KEY, value, updated_at: new Date().toISOString() })
    if (error) throw error
  }

  const handleSetResponsible = async (name) => {
    if (!isAdmin) return
    const payload = { week: currentWeek, name }
    try {
      await persistResponsibleOverride(JSON.stringify(payload))
      setResponsibleOverride(payload)
    } catch (err) {
      alert('Не удалось сохранить ответственного: ' + (err.message || err))
    }
  }

  const handleClearResponsible = async () => {
    if (!isAdmin) return
    try {
      await persistResponsibleOverride('')
      setResponsibleOverride(null)
    } catch (err) {
      alert('Не удалось сбросить ответственного: ' + (err.message || err))
    }
  }

  const handleCopyLetter = async () => {
    const ok = await copyToClipboard(generatedLetter)
    if (ok) {
      setLetterCopied(true)
      setTimeout(() => setLetterCopied(false), 2000)
    } else {
      alert('Не удалось скопировать текст')
    }
  }

  const getStatusBadgeClass = (status) => {
    const statusClasses = {
      'Заявка на тендер': 'status-not-started',
      'Подготовка ВОР': 'status-waiting-vor',
      'Идет тендерная процедура': 'status-in-progress',
      'Подведение итогов': 'status-summarizing',
      'Завершен': 'status-completed',
      'Приостановка тендера': 'status-suspended',
      // Статусы тендеров на материалы
      'Не начат': 'status-not-started',
      'В работе': 'status-in-progress',
      'Завершён': 'status-completed',
      'Не требуется': 'status-suspended',
      'Не нужно': 'status-suspended', // legacy
      // legacy fallbacks (на случай несмигрированных данных)
      'Ожидание ВОР': 'status-waiting-vor',
      'Принято в работу': 'status-completed',
    }
    return statusClasses[status] || 'status-not-started'
  }

  if (loading) {
    return <div className="loading">Загрузка...</div>
  }

  // Фильтрация тендеров по вкладке и объекту
  const filteredByTab = tenders.filter(tender => {
    // task 212: Фильтр по вкладке — 'all' | <конкретный статус> | 'deleted'
    if (activeTab === 'deleted') {
      if (!tender.deleted_at) return false
    } else if (activeTab === 'all') {
      if (tender.deleted_at) return false
    } else {
      // вкладка конкретного статуса
      if (tender.deleted_at) return false
      if (tender.status !== activeTab) return false
    }
    // Фильтр по объекту (несколько объектов = ИЛИ)
    if (objectFilter.length > 0 && !objectFilter.includes(tender.object_id)) return false
    // Фильтр по ответственному. '__unassigned__' — отдельная опция «Не назначен».
    if (responsibleFilter.length > 0) {
      const isUnassigned = !tender.responsible_contact_id
      const matches = isUnassigned
        ? responsibleFilter.includes('__unassigned__')
        : responsibleFilter.includes(tender.responsible_contact_id)
      if (!matches) return false
    }
    // Фильтр по статусу (несколько статусов = ИЛИ)
    if (statusFilter.length > 0 && !statusFilter.includes(tender.status)) return false
    // Текстовый поиск по наименованию объекта, адресу и описанию работ
    const q = searchQuery.trim().toLowerCase()
    if (q) {
      const haystack = [
        tender.objects?.name,
        tender.custom_object_name,
        tender.objects?.address,
        tender.work_description,
      ].filter(Boolean).join(' ').toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  })

  // Сортировка по выбранному полю
  const statusOrder = Object.fromEntries(currentStatusOptions.map((s, i) => [s, i]))
  const sortedTenders = [...filteredByTab].sort((a, b) => {
    let av, bv
    if (sortField === 'status') {
      av = statusOrder[a.status] ?? 999
      bv = statusOrder[b.status] ?? 999
    } else {
      av = a[sortField] || ''
      bv = b[sortField] || ''
    }
    if (av === bv) return 0
    if (av === '' || av === null || av === undefined) return 1
    if (bv === '' || bv === null || bv === undefined) return -1
    return sortOrder === 'asc' ? (av > bv ? 1 : -1) : (av > bv ? -1 : 1)
  })

  const toggleSort = (field) => {
    if (sortField === field) {
      setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      // По номеру тендера логичнее восходящая (1, 2, 3...), по датам — нисходящая (свежие сверху).
      setSortOrder(field === 'public_tender_number' ? 'asc' : 'desc')
    }
  }

  const sortIndicator = (field) => {
    if (sortField !== field) return ' ↕'
    return sortOrder === 'asc' ? ' ↑' : ' ↓'
  }

  // task 212: счётчики — «Все» + по каждому статусу + «Удалённые»
  const allTendersCount = tenders.filter(t => !t.deleted_at).length
  const statusCounts = Object.fromEntries(
    currentStatusOptions.map(s => [s, tenders.filter(t => !t.deleted_at && t.status === s).length])
  )
  const deletedTendersCount = tenders.filter(t => t.deleted_at).length

  // task 212: «завершённая» вкладка — когда активен таб статуса, считающегося завершённым
  const isCompletedTab = activeTab !== 'all'
    && activeTab !== 'deleted'
    && activeTab !== 'template'
    && isCompletedStatus(activeTab)

  // Число колонок основной таблицы. Считаем один раз: и строка «нет данных», и
  // раскрытый блок участников должны растягиваться ровно на всю ширину, иначе
  // справа остаётся пустая клетка под «Действиями».
  const mainTableColSpan = compactView
    ? 9
    : (isCompletedTab
      ? (!isMaterialsView && department === 'construction' ? 12 : 10)
      : (isMaterialsView ? 10 : (department === 'construction' ? 13 : 10)))

  // Проверка просроченности
  const today = new Date().toISOString().split('T')[0]
  const isOverdue = (tender) => tender.tender_end_date && tender.tender_end_date < today && !isCompletedStatus(tender.status)

  // Уникальные объекты из тендеров для фильтра
  const tenderObjectIds = [...new Set(tenders.map(t => t.object_id).filter(Boolean))]
  const tenderObjects = objects.filter(o => tenderObjectIds.includes(o.id))

  return (
    <div className="tenders-page">
      {/* Акцент шапки — тон направления: разделы отличаются с одного взгляда. */}
      <div className={`page-header page-header-tenders hdr-tone--${headerTone}`}>
        <h2>
          <IconTile tone={headerTone} className="page-icon-tile"><HeaderIcon size={17} /></IconTile>
          {pageTitle}
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          {!isMaterialsView && department === 'construction' && !isScopedManager && (
            <div className="tender-resp-chip-wrap">
              <button
                type="button"
                className={`tender-resp-chip${respMenuOpen ? ' is-open' : ''}${isAdmin ? ' is-clickable' : ''}`}
                onClick={() => isAdmin && setRespMenuOpen(o => !o)}
                title={`Дежурный по тендерам на этой неделе: ${currentResponsible}${isAdmin ? ' — нажмите, чтобы изменить' : ''}`}
                aria-haspopup={isAdmin ? 'listbox' : undefined}
                aria-expanded={isAdmin ? respMenuOpen : undefined}
              >
                <svg className="tender-resp-chip-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                <span className="tender-resp-chip-label">Дежурный по тендерам:</span>
                <span className="tender-resp-chip-name">{currentResponsible}</span>
                {overrideActive && <span className="tender-resp-chip-dot" title="ручная замена на неделю" aria-hidden />}
                {isAdmin && <span className="tender-resp-chip-caret" aria-hidden>▾</span>}
              </button>
              {isAdmin && respMenuOpen && (
                <div className="tender-resp-menu" role="listbox">
                  <div className="tender-resp-menu-head">Дежурный на неделю</div>
                  <button
                    type="button"
                    className={`tender-resp-menu-item${!overrideActive ? ' is-current' : ''}`}
                    onClick={() => { handleClearResponsible(); setRespMenuOpen(false) }}
                  >
                    Авто (по расписанию)
                    {!overrideActive && <span className="tender-resp-menu-check" aria-hidden>✓</span>}
                  </button>
                  {TENDER_RESPONSIBLES.map((n) => (
                    <button
                      type="button"
                      key={n}
                      className={`tender-resp-menu-item${overrideActive && currentResponsible === n ? ' is-current' : ''}`}
                      onClick={() => { handleSetResponsible(n); setRespMenuOpen(false) }}
                    >
                      {n}
                      {overrideActive && currentResponsible === n && <span className="tender-resp-menu-check" aria-hidden>✓</span>}
                    </button>
                  ))}
                  <div className="tender-resp-menu-hint">Меняется автоматически каждую неделю с понедельника. Ручная замена — до конца недели.</div>
                </div>
              )}
            </div>
          )}
          {!isMaterialsView && !isScopedManager && (
            <button
              type="button"
              className={`btn-view-toggle ${activeTab === 'template' ? 'active' : ''}`}
              onClick={() => setActiveTab(activeTab === 'template' ? 'all' : 'template')}
              title="Шаблон письма для запроса КП"
            >
              <IconMail size={15} />
              <span>Шаблон письма</span>
            </button>
          )}
          {!isMaterialsView && (
            <button
              type="button"
              className={`btn-view-toggle ${compactView ? 'active' : ''}`}
              onClick={() => setCompactView(v => !v)}
              title={compactView
                ? 'Показать все столбцы'
                : 'Скрыть столбцы: ВОРы и РД, План затрат, Тендер на материалы, Сводная КП'}
            >
              {compactView ? <IconColumnsWide size={15} /> : <IconColumns size={15} />}
              <span>{compactView ? 'Все столбцы' : 'Компактный вид'}</span>
            </button>
          )}
          {canEditTenders && (
            <button className="btn-primary" onClick={handleAddNew}>
              + Добавить тендер
            </button>
          )}
        </div>
      </div>

      {/* task 212: Вкладки — «Все тендеры» + по каждому статусу + Шаблон + Удалённые */}
      <div className={`tender-tabs${isMaterialsView ? ' tender-tabs--simple' : ''}`}>
        <button
          className={`tender-tab ${activeTab === 'all' ? 'active' : ''}`}
          onClick={() => setActiveTab('all')}
        >
          Все тендеры
          {allTendersCount > 0 && (
            <span className="tender-tab-count">{allTendersCount}</span>
          )}
        </button>
        {(() => {
          const statusActive = currentStatusOptions.includes(activeTab)
          return (
            <>
              <button
                type="button"
                className={`tender-tab tender-tab-status-toggle ${statusActive ? 'active' : ''} ${statusMenuOpen ? 'open' : ''}`}
                onClick={() => setStatusMenuOpen(o => !o)}
                aria-expanded={statusMenuOpen}
                title="Развернуть/свернуть статусы тендеров"
              >
                Статусы тендеров
                <span className="tender-tab-chevron" aria-hidden>▸</span>
              </button>
              {statusMenuOpen && currentStatusOptions.map(s => (
                <button
                  key={s}
                  className={`tender-tab tender-tab-status ${activeTab === s ? 'active' : ''}`}
                  onClick={() => setActiveTab(s)}
                >
                  {s}
                  {statusCounts[s] > 0 && (
                    <span className={`tender-tab-count ${isCompletedStatus(s) ? 'completed' : ''}`}>
                      {statusCounts[s]}
                    </span>
                  )}
                </button>
              ))}
            </>
          )
        })()}
        {/* task 242: «Шаблон письма» перенесён в шапку (справа сверху) */}
        {/* task 194: «Удалённые» — в самой правой части */}
        <button
          className={`tender-tab tender-tab-deleted ${activeTab === 'deleted' ? 'active' : ''}`}
          onClick={() => setActiveTab('deleted')}
        >
          Удалённые
          {deletedTendersCount > 0 && (
            <span className="tender-tab-count">{deletedTendersCount}</span>
          )}
        </button>
      </div>

      {/* Фильтры и таблица (скрываем на вкладке шаблона) */}
      {activeTab !== 'template' && (<>
      <div style={{ padding: '0.5rem 0', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <div className="tenders-search-wrap" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: '1 1 240px', minWidth: '200px', maxWidth: '360px' }}>
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Поиск по объекту, адресу, описанию работ…"
            style={{
              width: '100%',
              padding: '0.375rem 0.625rem',
              fontSize: '0.8125rem',
              border: '1px solid var(--border-color)',
              borderRadius: '4px',
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
            }}
          />
        </div>

        <div className="tender-filter-item">
          <span className="tender-filter-label">Объект:</span>
          <FilterDropdown
            label=""
            multiple
            searchable
            searchPlaceholder="Начните вводить объект…"
            allLabel="Все объекты"
            icon={<IconObject size={15} />}
            value={objectFilter}
            onChange={setObjectFilter}
            options={tenderObjects.map(obj => ({
              value: obj.id,
              label: showObjectDeptBadge && objectDeptBadge(obj.status)
                ? `${obj.name} · ${objectDeptBadge(obj.status)}`
                : obj.name,
            }))}
          />
        </div>

        {/* task 212: фильтр по статусу нужен только на вкладке «Все тендеры» —
            на вкладке конкретного статуса список уже отфильтрован */}
        {activeTab === 'all' && (
        <div className="tender-filter-item">
          <span className="tender-filter-label">Статус:</span>
          <FilterDropdown
            label=""
            multiple
            searchable
            searchPlaceholder="Поиск статуса…"
            allLabel="Все статусы"
            icon={<IconTag size={15} />}
            value={statusFilter}
            onChange={setStatusFilter}
            options={currentStatusOptions.map(s => ({ value: s, label: s }))}
          />
        </div>
        )}

        <div className="tender-filter-item">
          <span className="tender-filter-label">Ответственный:</span>
          <FilterDropdown
            label=""
            multiple
            searchable
            searchPlaceholder="Поиск сотрудника…"
            allLabel="Все ответственные"
            icon={<IconUser size={15} />}
            value={responsibleFilter}
            onChange={setResponsibleFilter}
            options={[
              { value: '__unassigned__', label: '— Не назначен —' },
              ...responsibleContacts
                .filter(c => tenders.some(t => !t.deleted_at && t.responsible_contact_id === c.id))
                .map(c => ({ value: c.id, label: c.full_name })),
            ]}
          />
        </div>

        {(objectFilter.length > 0 || responsibleFilter.length > 0 || statusFilter.length > 0 || searchQuery) && (
          <button
            onClick={() => { setObjectFilter([]); setResponsibleFilter([]); setStatusFilter([]); setSearchQuery('') }}
            style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '0.8125rem' }}
          >
            Сбросить все
          </button>
        )}
      </div>

      {isPhone ? (
        sortedTenders.length === 0 ? (
          <div className="no-data" style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--text-tertiary)' }}>
            Тендеры не найдены
          </div>
        ) : (
          <div className="mcard-list">
            {sortedTenders.map((tender) => (
              <Link
                key={tender.id}
                to={`/tenders/${tender.id}`}
                className={`mcard is-tappable${isOverdue(tender) ? ' mcard-overdue' : ''}`}
              >
                <div className="mcard-head">
                  <span className="mcard-num">№{tender.public_tender_number ?? '—'}</span>
                  {tender.status && (
                    <span className={`status-badge ${getStatusBadgeClass(tender.status)}`} style={{ padding: '0.1875rem 0.5rem', borderRadius: '6px', fontSize: '0.6875rem', fontWeight: 600 }}>
                      {tender.status}
                    </span>
                  )}
                </div>
                <div className="mcard-title">{tenderObjectName(tender)}</div>
                {tender.work_description && (
                  <div className="mcard-desc">{tender.work_description}</div>
                )}
                <div>
                  <TgPublishToggle tender={tender} canEdit={canEditTenders} onToggle={handleToggleTgPublished} />
                </div>
                <div className="mcard-rows">
                  <div className="mcard-row">
                    <span className="mcard-label">Ответственный</span>
                    <span className="mcard-value">{tender.responsible_contact?.full_name || '—'}</span>
                  </div>
                  <div className="mcard-row">
                    <span className="mcard-label">Срок процедур</span>
                    <span className={`mcard-value${isOverdue(tender) ? ' is-overdue' : ''}`}>
                      {formatDateRange(tender.tender_start_date, tender.tender_end_date)}
                    </span>
                  </div>
                </div>
                <div className="mcard-foot">
                  {(() => {
                    const c = tenderProposalCounts[tender.id]
                    return c && c.total > 0
                      ? <span className="mcard-chip">{c.proposalProvided}/{c.total} КП</span>
                      : <span />
                  })()}
                  <span className="mcard-open">Открыть ›</span>
                </div>
              </Link>
            ))}
          </div>
        )
      ) : (
      <div className="table-container">
        <table className={`data-table ${compactView ? 'data-table--compact' : ''}`}>
          {isMaterialsView ? (
            <>
              <thead>
                <tr>
                  <th
                    className="sortable-th"
                    style={{ width: '52px', textAlign: 'center', cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => toggleSort('public_tender_number')}
                    title="Номер тендера. Кликните для сортировки"
                  >
                    №{sortIndicator('public_tender_number')}
                  </th>
                  <th style={{ width: '130px', textAlign: 'center' }}>Объект</th>
                  <th style={{ width: '170px', textAlign: 'center' }}>Описание работ</th>
                  <th style={{ width: '160px' }}>Ответственный</th>
                  <th
                    className="sortable-th"
                    onClick={() => toggleSort('materials_proposal_deadline')}
                    title="Сортировать по сроку"
                    style={{ width: '110px', textAlign: 'center' }}
                  >
                    Срок предоставления<br />КП на материалы{sortIndicator('materials_proposal_deadline')}
                  </th>
                  <th style={{ width: '140px' }}>Ссылка на КП</th>
                  <th style={{ width: '140px' }}>Статус</th>
                  <th className="actions-column" style={{ width: '90px' }}>Действия</th>
                </tr>
              </thead>
              <tbody>
                {sortedTenders.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="no-data">
                      {activeTab === 'deleted'
                        ? 'В корзине нет тендеров на материалы'
                        : activeTab === 'all'
                          ? 'Нет тендеров на материалы. Они создаются автоматически вместе с основным тендером, либо через «+ Добавить тендер».'
                          : `Нет тендеров на материалы со статусом «${activeTab}»`}
                    </td>
                  </tr>
                ) : (
                  sortedTenders.map((tender) => (
                    <tr key={tender.id} className={isOverdue(tender) ? 'overdue-row' : ''}>
                      <td style={{ textAlign: 'center', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                        {tender.public_tender_number ?? '—'}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {tenderObjectName(tender, '-')}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {tender.parent_tender_id ? (
                          <Link
                            to={`/tenders/${tender.parent_tender_id}`}
                            className="row-link primary"
                            title="Открыть тендер основного строительства (Ctrl+клик или средняя кнопка — в новой вкладке)"
                            style={{ fontSize: '0.75rem', textAlign: 'center', display: 'inline-block', color: 'var(--primary-color)', textDecoration: 'underline' }}
                          >
                            {tender.work_description}
                          </Link>
                        ) : (
                          <span style={{ fontSize: '0.75rem' }}>{tender.work_description}</span>
                        )}
                      </td>
                      <td>
                        {editingResponsibleTenderId === tender.id ? (
                          <select
                            autoFocus
                            className="inline-responsible-select"
                            value={tender.responsible_contact_id || ''}
                            onChange={(e) => { handleUpdateTenderResponsible(tender.id, e.target.value); setEditingResponsibleTenderId(null) }}
                            onBlur={() => setEditingResponsibleTenderId(null)}
                          >
                            <option value="">— не назначен —</option>
                            {responsibleContacts.map(c => (
                              <option key={c.id} value={c.id}>{c.full_name}</option>
                            ))}
                          </select>
                        ) : (
                          canEditTenders ? (
                            <button
                              className="responsible-display"
                              onClick={() => setEditingResponsibleTenderId(tender.id)}
                              title="Назначить ответственного"
                            >
                              {tender.responsible_contact?.full_name || (
                                <span className="responsible-empty">— не назначен —</span>
                              )}
                            </button>
                          ) : (
                            <span className="responsible-display" style={{ cursor: 'default' }}>
                              {tender.responsible_contact?.full_name || (
                                <span className="responsible-empty">— не назначен —</span>
                              )}
                            </span>
                          )
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="date"
                          value={tender.materials_proposal_deadline || ''}
                          onChange={(e) => handleUpdateMaterialsDeadline(tender.id, e.target.value)}
                          disabled={!canEditTenders}
                          readOnly={!canEditTenders}
                          style={{
                            width: '100%',
                            padding: '0.25rem 0.375rem',
                            fontSize: '0.75rem',
                            border: '1px solid var(--border-color)',
                            borderRadius: '4px',
                            background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)',
                            fontFamily: 'inherit',
                            boxSizing: 'border-box',
                          }}
                        />
                      </td>
                      <td>
                        {tender.materials_proposal_link ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                            <a
                              href={tender.materials_proposal_link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="link"
                            >
                              Открыть
                            </a>
                            {canEditTenders && (
                              <button
                                className="btn-icon btn-edit"
                                onClick={() => handleUpdateMaterialsLink(tender.id, tender.materials_proposal_link)}
                                title="Изменить ссылку"
                                style={{ fontSize: '0.75rem' }}
                              >
                                ✏️
                              </button>
                            )}
                          </div>
                        ) : (
                          canEditTenders ? (
                            <button
                              onClick={() => handleUpdateMaterialsLink(tender.id, '')}
                              style={{
                                background: 'none',
                                border: '1px dashed var(--border-color)',
                                borderRadius: '4px',
                                padding: '0.1875rem 0.5rem',
                                color: 'var(--text-tertiary)',
                                cursor: 'pointer',
                                fontSize: '0.75rem'
                              }}
                              title="Добавить ссылку на КП"
                            >
                              + ссылка
                            </button>
                          ) : (
                            <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>—</span>
                          )
                        )}
                      </td>
                      <td>
                        {isCompletedTab || !canEditTenders ? (
                          <span className={`status-badge ${getStatusBadgeClass(tender.status)}`} style={{ display: 'inline-block', padding: '0.25rem 0.5rem', borderRadius: '6px', fontSize: '0.6875rem', fontWeight: 600 }}>
                            {tender.status}
                          </span>
                        ) : (
                          <StatusDropdown
                            value={tender.status}
                            options={materialsStatusOptions}
                            onChange={(next) => handleStatusChange(tender.id, next)}
                            getBadgeClass={getStatusBadgeClass}
                            ariaLabel="Статус тендера"
                          />
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', justifyContent: 'center' }}>
                          {/* task 246 (исправление): в тендер на материалы нельзя «заходить внутрь» —
                              кнопка открытия его собственной карточки убрана */}
                          {activeTab === 'deleted' ? (
                            <>
                              {canEditTenders && (
                                <button
                                  className="btn-icon"
                                  onClick={() => handleRestoreTender(tender.id, tenderObjectName(tender, 'тендер'))}
                                  title="Восстановить"
                                >
                                  ♻️
                                </button>
                              )}
                              {isAdmin && (
                                <button
                                  className="btn-icon btn-delete"
                                  onClick={() => handleHardDeleteTender(tender.id, tenderObjectName(tender, 'тендер'))}
                                  title="Удалить безвозвратно (только для администратора)"
                                >
                                  🗑️
                                </button>
                              )}
                            </>
                          ) : (
                            isAdmin && (
                              <button
                                className="btn-icon btn-delete"
                                onClick={() => handleDeleteTender(tender.id, tenderObjectName(tender, 'тендер'))}
                                title="Переместить в Корзину (только для администратора)"
                              >
                                🗑️
                              </button>
                            )
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </>
          ) : (
          <>
          <thead>
            <tr>
              <th
                className="sortable-th"
                style={{ width: '44px', textAlign: 'center', cursor: 'pointer', userSelect: 'none' }}
                onClick={() => toggleSort('public_tender_number')}
                title="Номер тендера. Кликните для сортировки"
              >
                №{sortIndicator('public_tender_number')}
              </th>
              <th style={{ width: '36px' }}></th>
              <th style={{ minWidth: '160px' }}>Наименование<br />объекта</th>
              <th style={{ minWidth: '140px', maxWidth: '220px' }}>Описание работ</th>
              {!isCompletedTab && <th style={{ width: '100px' }}>Статус</th>}
              {isCompletedTab && <th style={{ width: '130px' }}>Победитель</th>}
              <th
                className="sortable-th"
                onClick={() => toggleSort('tender_start_date')}
                title="Сортировать по срокам тендерных процедур"
                style={{ width: '150px' }}
              >
                Срок проведения<br />тендерных процедур{sortIndicator('tender_start_date')}
              </th>
              <th style={{ width: '130px' }}>Ответственный<br />по тендеру</th>
              {!compactView && department === 'construction' && (
                <th style={{ width: '90px' }}>ВОРы<br />и&nbsp;РД</th>
              )}
              <th style={{ width: '105px' }}>Тендерный<br />пакет</th>
              {!compactView && department === 'construction' && !isCompletedTab && (
                <th style={{ width: '95px' }}>План<br />затрат</th>
              )}
              {!compactView && !isMaterialsView && department === 'construction' && (
                <th style={{ width: '105px' }}>Тендер<br />на&nbsp;материалы</th>
              )}
              {!compactView && <th style={{ width: '105px' }}>Сводная<br />КП</th>}
              <th className="actions-column" style={{ width: '72px' }}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {sortedTenders.length === 0 ? (
              <tr>
                <td colSpan={mainTableColSpan} className="no-data">
                  {activeTab === 'deleted'
                    ? 'В корзине нет тендеров'
                    : activeTab === 'all'
                      ? 'Нет тендеров. Добавьте первый тендер.'
                      : `Нет тендеров со статусом «${activeTab}»`}
                </td>
              </tr>
            ) : (
              sortedTenders.map((tender) => (
                <React.Fragment key={tender.id}>
                  <tr className={isOverdue(tender) ? 'overdue-row' : ''}>
                    <td style={{ textAlign: 'center', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                      {tender.public_tender_number ?? '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.25rem' }}>
                        <button
                          onClick={() => handleToggleTender(tender.id)}
                          className={`expand-toggle${expandedTenderId === tender.id ? ' is-expanded' : ''}`}
                          title="Показать контрагентов"
                          aria-expanded={expandedTenderId === tender.id}
                        >
                          <span className="expand-toggle-chevron" aria-hidden>›</span>
                        </button>
                        {(() => {
                          const c = tenderProposalCounts[tender.id]
                          if (!c || c.total === 0) return null
                          const all = c.proposalProvided === c.total
                          return (
                            <span
                              className={`kp-counter ${all ? 'kp-counter-full' : ''}`}
                              title={`КП предоставлено: ${c.proposalProvided} из ${c.total} контрагентов`}
                            >
                              {c.proposalProvided}/{c.total} КП
                            </span>
                          )
                        })()}
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.125rem' }}>
                        {tender.object_id ? (
                          <Link
                            to={`/general/objects/${tender.object_id}`}
                            className="row-link primary"
                            title="Открыть карточку объекта (Ctrl+клик или средняя кнопка — в новой вкладке)"
                          >
                            {tender.objects?.name || '-'}
                          </Link>
                        ) : (
                          /* Без привязки к реестру: показываем вписанное вручную
                             наименование («прочее»), карточки объекта у него нет. */
                          <span className="row-link primary" style={{ cursor: 'default' }}>{tenderObjectName(tender, '-')}</span>
                        )}
                        {tender.objects?.address && (
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', wordBreak: 'break-word' }}>
                            {tender.objects.address}
                          </div>
                        )}
                        {tender.objects?.map_link && (
                          <a
                            href={tender.objects.map_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title="Открыть в Яндекс.Картах"
                            className="yandex-map-link"
                          >
                            <span aria-hidden>🗺️</span>
                            <span>Месторасположение</span>
                          </a>
                        )}
                      </div>
                    </td>
                    <td>
                      <Link
                        to={`/tenders/${tender.id}`}
                        className="row-link primary"
                        title="Открыть тендер (Ctrl+клик или средняя кнопка — в новой вкладке)"
                        style={{ color: 'var(--primary-color)', textDecoration: 'underline' }}
                      >
                        {tender.work_description}
                      </Link>
                      <div>
                        <TgPublishToggle
                          tender={tender}
                          canEdit={canEditTenders}
                          onToggle={handleToggleTgPublished}
                        />
                      </div>
                    </td>
                    {!isCompletedTab && (
                      <td>
                        {canEditTenders ? (
                          <StatusDropdown
                            value={tender.status}
                            options={statusOptions}
                            onChange={(next) => handleStatusChange(tender.id, next)}
                            getBadgeClass={getStatusBadgeClass}
                            getDisplay={(s) =>
                              s === 'Идет тендерная процедура'
                                ? <>Идет тендерная<br />процедура</>
                                : s
                            }
                            ariaLabel="Статус тендера"
                          />
                        ) : (
                          <span className={`status-badge ${getStatusBadgeClass(tender.status)}`} style={{ display: 'inline-block', padding: '0.25rem 0.5rem', borderRadius: '6px', fontSize: '0.6875rem', fontWeight: 600 }}>
                            {tender.status}
                          </span>
                        )}
                      </td>
                    )}
                    {isCompletedTab && (
                      <td>
                        {(() => {
                          const winners = getTenderWinners(tender)
                          if (winners.length === 0) {
                            return (
                              <span style={{
                                color: 'var(--text-tertiary)',
                                fontStyle: 'italic',
                                fontSize: '0.8125rem'
                              }}>
                                Не выбран
                              </span>
                            )
                          }
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                              {winners.map(w => (
                                <span key={w.id} className="winner-cell" title="Победитель">
                                  <span className="winner-icon" aria-hidden>🏆</span>
                                  <span className="winner-name">
                                    {w.name}
                                    {w.scope && (
                                      <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>
                                        {' '}— {w.scope}
                                      </span>
                                    )}
                                  </span>
                                </span>
                              ))}
                            </div>
                          )
                        })()}
                      </td>
                    )}
                    {/* Цвет просрочки — классом, а не инлайн-стилем: инлайн не знает про тему,
                        и ярко-красный #dc2626 на тёмном фоне резал глаз. */}
                    <td className={`tender-period-cell ${isOverdue(tender) ? 'is-overdue' : ''}`}>
                      {formatDateRange(tender.tender_start_date, tender.tender_end_date)}
                      {isOverdue(tender) && <span className="tender-period-warn" title="Срок истёк">!</span>}
                    </td>
                    <td>
                      {editingResponsibleTenderId === tender.id ? (
                        <select
                          autoFocus
                          className="inline-responsible-select"
                          value={tender.responsible_contact_id || ''}
                          onChange={(e) => {
                            handleUpdateTenderResponsible(tender.id, e.target.value)
                            setEditingResponsibleTenderId(null)
                          }}
                          onBlur={() => setEditingResponsibleTenderId(null)}
                        >
                          <option value="">— не назначен —</option>
                          {getResponsibleOptions(tender.responsible_contact_id).map((contact) => (
                            <option key={contact.id} value={contact.id}>
                              {contact.full_name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        canEditTenders ? (
                          <button
                            className="responsible-display"
                            onClick={() => setEditingResponsibleTenderId(tender.id)}
                            title="Назначить ответственного"
                          >
                            {getResponsibleName(tender) || (
                              <span className="responsible-empty">— не назначен —</span>
                            )}
                          </button>
                        ) : (
                          <span className="responsible-display" style={{ cursor: 'default' }}>
                            {getResponsibleName(tender) || (
                              <span className="responsible-empty">— не назначен —</span>
                            )}
                          </span>
                        )
                      )}
                    </td>
                    {/* ВОРы и РД */}
                    {!compactView && department === 'construction' && (
                      <td>
                        <div className="phase-cell">
                          {(() => {
                            const s = tender.vor_status || 'not_started'
                            const hasDocs = (vorDocCounts[tender.id] || 0) > 0
                            if (s === 'completed') {
                              return (tender.vor_link || hasDocs)
                                ? <span className="phase-done" title="ВОР готов">✓ Готово</span>
                                : <span className="phase-warn" title="Статус «Завершён», но нет ни ссылки, ни документа">⚠ Нет файла</span>
                            }
                            if (s === 'in_progress') {
                              return <span className="phase-progress" title="В работе">В работе</span>
                            }
                            return <span className="phase-pending" title="Не начат">Не начат</span>
                          })()}
                          {tender.vor_link && (
                            <a
                              href={tender.vor_link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="link"
                            >
                              Открыть
                            </a>
                          )}
                          <button
                            type="button"
                            onClick={() => setVorDocsModalTenderId(tender.id)}
                            style={{
                              background: 'none',
                              border: '1px dashed var(--border-color)',
                              borderRadius: '4px',
                              padding: '0.0625rem 0.375rem',
                              color: 'var(--text-tertiary)',
                              cursor: 'pointer',
                              fontSize: '0.6875rem'
                            }}
                            title="Документы ВОР и РД"
                          >
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.1875rem' }}>
                              <PaperclipIcon size={12} />
                              {vorDocCounts[tender.id] ? vorDocCounts[tender.id] : ''}
                            </span>
                          </button>
                        </div>
                        {tender.vor_responsible?.full_name && (
                          <div style={{ fontSize: '0.6875rem', color: 'var(--text-tertiary)', marginTop: '0.125rem' }}>
                            {tender.vor_responsible.full_name}
                          </div>
                        )}
                      </td>
                    )}
                    {/* Тендерный пакет */}
                    <td>
                        <div className="phase-cell">
                        {tender.tender_package_link ? (
                          <div className="link-with-edit">
                            <a
                              href={tender.tender_package_link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="link"
                            >
                              Открыть
                            </a>
                            {canEditTenders && (
                              <button
                                className="btn-icon btn-edit"
                                onClick={() => handleUpdateTenderLink(tender.id, 'tender_package_link', tender.tender_package_link)}
                                title="Изменить ссылку"
                                style={{ fontSize: '0.75rem' }}
                              >✏️</button>
                            )}
                          </div>
                        ) : (
                          canEditTenders ? (
                            <button
                              onClick={() => handleUpdateTenderLink(tender.id, 'tender_package_link', '')}
                              style={{
                                background: 'none',
                                border: '1px dashed var(--border-color)',
                                borderRadius: '4px',
                                padding: '0.1875rem 0.5rem',
                                color: 'var(--text-tertiary)',
                                cursor: 'pointer',
                                fontSize: '0.75rem'
                              }}
                              title="Добавить ссылку на тендерный пакет"
                            >+ ссылка</button>
                          ) : (
                            !((packageDocCounts[tender.id] || 0) > 0) && (
                              <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>—</span>
                            )
                          )
                        )}
                        {(canEditTenders || (packageDocCounts[tender.id] || 0) > 0) && (
                          <button
                            type="button"
                            onClick={() => setPackageDocsModalTenderId(tender.id)}
                            style={{
                              background: 'none',
                              border: '1px dashed var(--border-color)',
                              borderRadius: '4px',
                              padding: '0.0625rem 0.375rem',
                              color: 'var(--text-tertiary)',
                              cursor: 'pointer',
                              fontSize: '0.6875rem'
                            }}
                            title="Документы тендерного пакета"
                          >
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.1875rem' }}>
                              <PaperclipIcon size={12} />
                              {packageDocCounts[tender.id] ? packageDocCounts[tender.id] : ''}
                            </span>
                          </button>
                        )}
                        </div>
                      </td>
                    {/* План затрат */}
                    {!compactView && department === 'construction' && !isCompletedTab && (
                      <td>
                        <div className="phase-cell">
                          {(() => {
                            const s = tender.cost_plan_status || 'not_started'
                            if (s === 'not_required') {
                              return <span className="phase-done" title="План затрат не требуется">— Не требуется</span>
                            }
                            if (s === 'completed') {
                              return tender.cost_plan_link
                                ? <span className="phase-done" title="План затрат готов">✓ Готово</span>
                                : <span className="phase-warn" title="Статус «Завершён», но ссылка не указана">⚠ Нет ссылки</span>
                            }
                            if (s === 'in_progress') {
                              return <span className="phase-progress" title="В работе">В работе</span>
                            }
                            return <span className="phase-pending" title="Не начат">Не начат</span>
                          })()}
                          {tender.cost_plan_link && (
                            <a
                              href={tender.cost_plan_link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="link"
                            >
                              Открыть
                            </a>
                          )}
                        </div>
                        {tender.cost_plan_responsible?.full_name && (
                          <div style={{ fontSize: '0.6875rem', color: 'var(--text-tertiary)', marginTop: '0.125rem' }}>
                            {tender.cost_plan_responsible.full_name}
                          </div>
                        )}
                      </td>
                    )}
                    {/* Тендер на материалы (дочерний) — только в основном строительстве */}
                    {!compactView && !isMaterialsView && department === 'construction' && (
                      <td>
                        {tender.materials_tender ? (
                          <div className="phase-cell">
                            {(() => {
                              const s = tender.materials_tender.status
                              if (s === 'Завершён' || s === 'Завершен') {
                                return <span className="phase-done" title="Тендер на материалы завершён">✓ Завершён</span>
                              }
                              if (s === 'В работе') {
                                return <span className="phase-progress" title="В работе">В работе</span>
                              }
                              if (s === 'Не требуется' || s === 'Не нужно') {
                                return <span className="phase-done" title="Тендер на материалы не требуется">— Не требуется</span>
                              }
                              return <span className="phase-pending" title={s || 'Не начат'}>{s || 'Не начат'}</span>
                            })()}
                            {tender.materials_tender.materials_proposal_link && (
                              <a
                                href={tender.materials_tender.materials_proposal_link}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="link"
                                title="Открыть КП на материалы"
                              >
                                Открыть
                              </a>
                            )}
                          </div>
                        ) : (
                          // Task 289: ручное создание тендера на материалы запрещено —
                          // материал создаётся автоматически при создании основного тендера.
                          // Если у тендера нет материала (исторические данные или ошибка) —
                          // показываем прочерк, а не предлагаем создать вручную.
                          <span className="muted" style={{ fontSize: '0.75rem' }} title="Тендер на материалы не создан">—</span>
                        )}
                      </td>
                    )}
                    {/* Сводная КП */}
                    {!compactView && (
                      <td>
                        {tender.summary_proposal_link ? (
                          <div className="link-with-edit">
                            <a
                              href={tender.summary_proposal_link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="link"
                            >
                              Открыть
                            </a>
                            {canEditTenders && (
                              <button
                                className="btn-icon btn-edit"
                                onClick={() => handleUpdateTenderLink(tender.id, 'summary_proposal_link', tender.summary_proposal_link)}
                                title="Изменить ссылку"
                                style={{ fontSize: '0.75rem' }}
                              >✏️</button>
                            )}
                          </div>
                        ) : (
                          canEditTenders ? (
                            <button
                              onClick={() => handleUpdateTenderLink(tender.id, 'summary_proposal_link', '')}
                              style={{
                                background: 'none',
                                border: '1px dashed var(--border-color)',
                                borderRadius: '4px',
                                padding: '0.1875rem 0.5rem',
                                color: 'var(--text-tertiary)',
                                cursor: 'pointer',
                                fontSize: '0.75rem'
                              }}
                              title="Добавить ссылку на сводную КП"
                            >+ ссылка</button>
                          ) : (
                            <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>—</span>
                          )
                        )}
                      </td>
                    )}
                    <td className="actions-cell">
                      {activeTab === 'deleted' ? (
                        <>
                          {canEditTenders && (
                            <button
                              className="btn-icon"
                              onClick={() => handleRestoreTender(tender.id, tenderObjectName(tender, 'тендер'))}
                              title="Восстановить"
                              style={{ fontSize: '0.875rem' }}
                            >
                              ↩️
                            </button>
                          )}
                          {isAdmin && (
                            <button
                              className="btn-icon btn-delete"
                              onClick={() => handleHardDeleteTender(tender.id, tenderObjectName(tender, 'тендер'))}
                              title="Удалить безвозвратно (только для администратора)"
                            >
                              🗑️
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          <button
                            className="btn-icon"
                            onClick={() => handleShowLetterForTender(tender)}
                            title="Шаблон письма подрядчикам"
                            style={{ fontSize: '0.875rem' }}
                          >
                            ✉️
                          </button>
                          {canEditTenders && (
                            <button
                              className="btn-icon btn-edit"
                              onClick={() => handleEditTender(tender)}
                              title="Редактировать"
                            >
                              ✏️
                            </button>
                          )}
                          {isAdmin && (
                            <button
                              className="btn-icon btn-delete"
                              onClick={() =>
                                handleDeleteTender(tender.id, tenderObjectName(tender, 'тендер'))
                              }
                              title="В корзину (только для администратора)"
                            >
                              🗑️
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                  {expandedTenderId === tender.id && (
                    <tr>
                      <td colSpan={mainTableColSpan} className="expanded-cp-row">
                        <div className="expanded-cp-toolbar">
                          {canEditTenders && (
                            <button
                              className="btn-primary"
                              onClick={() => {
                                setSelectedTenderForCounterparty(tender.id)
                                // Сбрасываем поиск/фильтр ПРИ ОТКРЫТИИ, а не только при
                                // закрытии: иначе оставшийся с прошлого раза фильтр молча
                                // прячет часть контрагентов, и кажется, что компании нет.
                                setCounterpartySearchQuery('')
                                setCounterpartyWorkTypeFilter('')
                                setSelectedCounterpartyIds([])
                                setShowAddCounterpartyModal(true)
                              }}
                            >
                              + Добавить контрагента
                            </button>
                          )}
                          {!isScopedManager && tenderCounterparties[tender.id] && tenderCounterparties[tender.id].length > 0 && (
                            <button
                              className="btn-secondary"
                              onClick={() => handleCopyEmailsForTender(tender.id)}
                              title="Скопировать все email-адреса контрагентов в буфер обмена"
                            >
                              {copiedEmailsTenderId === tender.id ? '✓ Скопировано' : '📋 Копировать email'}
                            </button>
                          )}
                        </div>
                        {tenderCounterparties[tender.id] && tenderCounterparties[tender.id].length > 0 ? (
                          <div className="expanded-cp-table-wrap">
                            <table className="data-table" style={{ margin: 0 }}>
                              <thead>
                                <tr>
                                  {canEditTenders && <th style={{ width: '26px' }}></th>}
                                  <th style={{ width: '40px' }}>№</th>
                                  <th style={{ width: '16%', minWidth: '150px' }}>Наименование компании</th>
                                  <th style={{ width: '13%' }}>Контактные данные</th>
                                  <th style={{ width: '140px' }}>Email</th>
                                  <th style={{ width: '190px' }}>Статус</th>
                                  <th style={{ width: '280px' }}>КП / Документы</th>
                                  {!hideNotes && <th>Примечание</th>}
                                  <th style={{ width: '56px' }}></th>
                                </tr>
                              </thead>
                              <tbody>
                                {tenderCounterparties[tender.id].map((tc, index) => (
                                  <tr
                                    key={tc.id}
                                    className={`${draggedTc?.id === tc.id ? 'tc-dragging' : ''}${tcDragOver?.id === tc.id ? ` tc-drop-${tcDragOver.position}` : ''}`}
                                    onDragOver={!canEditTenders ? undefined : (e) => {
                                      e.preventDefault()
                                      e.dataTransfer.dropEffect = 'move'
                                      const rect = e.currentTarget.getBoundingClientRect()
                                      const position = (e.clientY - rect.top) < rect.height / 2 ? 'before' : 'after'
                                      if (tc.id === draggedTc?.id) { setTcDragOver(null); return }
                                      setTcDragOver(prev => (prev?.id === tc.id && prev?.position === position) ? prev : { id: tc.id, position })
                                    }}
                                    onDragLeave={!canEditTenders ? undefined : () => setTcDragOver(prev => prev?.id === tc.id ? null : prev)}
                                    onDrop={!canEditTenders ? undefined : (e) => {
                                      e.preventDefault()
                                      const draggedId = e.dataTransfer.getData('text/plain')
                                      handleReorderTc(tender.id, draggedId, tc.id)
                                    }}
                                  >
                                    {canEditTenders && (
                                      <td className="tc-drag-cell">
                                        <span
                                          className="tc-drag-handle"
                                          draggable
                                          title="Перетащите, чтобы изменить порядок"
                                          onDragStart={(e) => {
                                            e.dataTransfer.effectAllowed = 'move'
                                            e.dataTransfer.setData('text/plain', tc.id)
                                            setDraggedTc({ tenderId: tender.id, id: tc.id })
                                          }}
                                          onDragEnd={() => { setDraggedTc(null); setTcDragOver(null) }}
                                        >⋮⋮</span>
                                      </td>
                                    )}
                                    <td style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>
                                      {index + 1}
                                    </td>
                                    <td>
                                      <div style={{ fontWeight: 600, wordBreak: 'break-word' }}>
                                        {tc.counterparties?.name}
                                      </div>
                                      {tc.counterparties?.work_type && (
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.125rem' }}>
                                          {tc.counterparties.work_type}
                                        </div>
                                      )}
                                      {tc.counterparties?.inn && (
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                                          ИНН: {tc.counterparties.inn}
                                        </div>
                                      )}
                                    </td>
                                    <td>
                                      {tc.counterparties?.counterparty_contacts && tc.counterparties.counterparty_contacts.length > 0 ? (
                                        <div className="tc-contacts-stack">
                                          {tc.counterparties.counterparty_contacts.map((contact, idx) => (
                                            <div key={contact.id || idx} className="tc-contact-item">
                                              {contact.full_name && (
                                                <div style={{ fontWeight: 500 }}>{contact.full_name}</div>
                                              )}
                                              {contact.position && (
                                                <div style={{
                                                  color: 'var(--text-tertiary)',
                                                  fontWeight: 400,
                                                  fontSize: '0.75rem'
                                                }}>
                                                  {contact.position}
                                                </div>
                                              )}
                                              {/* Несколько телефонов (через «;») — каждый с новой строки. */}
                                              {contact.phone && contact.phone.split(';').map(p => p.trim()).filter(Boolean).map((p, pi) => (
                                                <a
                                                  key={pi}
                                                  href={`tel:${p.replace(/\s+/g, '')}`}
                                                  style={{
                                                    color: 'var(--primary-color)',
                                                    textDecoration: 'none',
                                                    display: 'block',
                                                    fontSize: '0.75rem'
                                                  }}
                                                >
                                                  {p}
                                                </a>
                                              ))}
                                            </div>
                                          ))}
                                        </div>
                                      ) : (
                                        <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                                      )}
                                    </td>
                                    <td>
                                      {tc.counterparties?.counterparty_contacts && tc.counterparties.counterparty_contacts.length > 0 ? (
                                        <div className="tc-contacts-stack">
                                          {/* Итерируем ВСЕ контакты (1:1 с колонкой контактов),
                                              чтобы разделители и email стояли на уровне своего контакта. */}
                                          {tc.counterparties.counterparty_contacts.map((contact, idx) => (
                                            <div key={contact.id || idx} className="tc-contact-item">
                                              {contact.email
                                                ? contact.email.split(';').map(em => em.trim()).filter(Boolean).map((em, ei) => (
                                                  <a
                                                    key={ei}
                                                    href={`mailto:${em}`}
                                                    style={{
                                                      color: 'var(--primary-color)',
                                                      textDecoration: 'none',
                                                      display: 'block',
                                                      fontSize: '0.75rem',
                                                      wordBreak: 'break-all',
                                                    }}
                                                  >
                                                    {em}
                                                  </a>
                                                ))
                                                : <span style={{ color: 'var(--text-tertiary)' }}>—</span>}
                                            </div>
                                          ))}
                                        </div>
                                      ) : (
                                        <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                                      )}
                                    </td>
                                    <td>
                                      <FilterDropdown
                                        className="tc-status-fdrop"
                                        style={{ '--tc-color': getCounterpartyStatusColor(tc.status || 'request_sent') }}
                                        label=""
                                        value={tc.status || 'request_sent'}
                                        onChange={(v) => handleUpdateCounterpartyStatus(tender.id, tc.id, v)}
                                        options={counterpartyStatusOptions}
                                        disabled={!canEditTenders}
                                        renderOption={(o) => (
                                          <span className="tc-status-opt">
                                            <span className="tc-status-dot" style={{ background: getCounterpartyStatusColor(o.value) }} />
                                            {o.label}
                                          </span>
                                        )}
                                      />
                                    </td>
                                    <td style={{ verticalAlign: 'top' }}>
                                      <TenderCounterpartyFiles
                                        tenderId={tender.id}
                                        counterpartyId={tc.counterparty_id}
                                        canEdit={canEditTenders}
                                      />
                                    </td>
                                    {!hideNotes && (
                                    <td className="tc-notes-cell">
                                      {notesEdit?.tcId === tc.id ? (
                                        <div className="tc-notes-edit">
                                          <textarea
                                            className="tc-notes-textarea"
                                            autoFocus
                                            ref={(el) => {
                                              if (el) {
                                                el.style.height = 'auto'
                                                el.style.height = Math.max(el.scrollHeight, 56) + 'px'
                                              }
                                            }}
                                            value={notesEdit.draft}
                                            onChange={(e) => {
                                              const value = e.target.value
                                              e.target.style.height = 'auto'
                                              e.target.style.height = Math.max(e.target.scrollHeight, 56) + 'px'
                                              setNotesEdit(prev => (prev && prev.tcId === tc.id ? { ...prev, draft: value } : prev))
                                            }}
                                            placeholder="Примечание…"
                                            rows={2}
                                          />
                                          <div className="tc-notes-actions">
                                            <button
                                              type="button"
                                              className="tc-notes-btn tc-notes-btn-save"
                                              onClick={() => handleSaveCounterpartyNotes(tender.id, tc)}
                                              disabled={savingNotes}
                                            >
                                              {savingNotes ? 'Сохранение…' : 'Сохранить'}
                                            </button>
                                            <button
                                              type="button"
                                              className="tc-notes-btn tc-notes-btn-cancel"
                                              onClick={() => setNotesEdit(null)}
                                              disabled={savingNotes}
                                            >
                                              Отмена
                                            </button>
                                          </div>
                                        </div>
                                      ) : (
                                        <div className="tc-notes-view">
                                          <div className={`tc-notes-text${tc.notes ? '' : ' is-empty'}`}>
                                            {tc.notes || 'Примечание не заполнено'}
                                          </div>
                                          <div className="tc-notes-tools">
                                            {canEditTenders && (
                                              <button
                                                type="button"
                                                className="tc-notes-icon"
                                                onClick={() => setNotesEdit({ tcId: tc.id, draft: tc.notes || '' })}
                                                title="Редактировать примечание"
                                                aria-label="Редактировать примечание"
                                              >
                                                <PencilIcon />
                                              </button>
                                            )}
                                            {/* История только для чтения — доступна всем, кто видит колонку */}
                                            <button
                                              type="button"
                                              className="tc-notes-icon"
                                              onClick={() => openNotesHistory(tender.id, tc)}
                                              title="История изменений примечания"
                                              aria-label="История изменений примечания"
                                            >
                                              <HistoryIcon />
                                            </button>
                                          </div>
                                        </div>
                                      )}
                                    </td>
                                    )}
                                    <td style={{ textAlign: 'center' }}>
                                      {canEditTenders && (
                                        <button
                                          className="btn-icon btn-delete"
                                          onClick={() => handleRemoveCounterpartyFromTender(tender.id, tc.id)}
                                          title="Удалить из тендера"
                                        >
                                          🗑️
                                        </button>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : loadingCounterparties.has(tender.id) ? (
                          <div className="expanded-cp-loading">
                            <span className="expanded-cp-spinner" aria-hidden />
                            <span>Загрузка подрядчиков…</span>
                          </div>
                        ) : (
                          <p className="expanded-cp-empty">
                            Контрагенты еще не добавлены к этому тендеру
                          </p>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))
            )}
          </tbody>
          </>
          )}
        </table>
      </div>
      )}
      </>)}

      {/* Вкладка шаблона письма */}
      {activeTab === 'template' && !isMaterialsView && (
        <div style={{ padding: '1.5rem' }}>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-tertiary)', marginBottom: '1rem' }}>
            Редактируйте шаблон письма для запроса КП. Используйте переменные в фигурных скобках — они будут заменены реальными данными при создании тендера:
          </p>

          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginBottom: '1rem'
          }}>
            {[
              ['{work_description}', 'Описание работ'],
              ['{object_name}', 'Название объекта'],
              ['{tender_number}', 'Номер тендера'],
              ['{start_date}', 'Дата начала'],
              ['{end_date}', 'Дата окончания'],
              ['{employee_name}', 'ФИО сотрудника'],
              ['{employee_position}', 'Должность'],
              ['{employee_phone}', 'Телефон сотрудника'],
              ['{employee_email}', 'Email сотрудника'],
              ['{tender_package_link}', 'Ссылка на тендерный пакет'],
            ].map(([variable, label]) => (
              <span
                key={variable}
                title={label}
                onClick={() => copyToClipboard(variable)}
                style={{
                  padding: '0.2rem 0.5rem',
                  fontSize: '0.75rem',
                  fontFamily: 'Consolas, Monaco, monospace',
                  background: 'var(--bg-tertiary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '3px',
                  color: 'var(--primary-color)',
                  cursor: 'pointer',
                }}
              >
                {variable}
              </span>
            ))}
          </div>
          <textarea
            value={letterTemplate}
            onChange={(e) => setLetterTemplate(e.target.value)}
            readOnly={!canEditTenders}
            disabled={!canEditTenders}
            style={{
              width: '100%',
              minHeight: '400px',
              padding: '1rem',
              fontSize: '0.875rem',
              lineHeight: '1.6',
              fontFamily: 'inherit',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', alignItems: 'center' }}>
            {canEditTenders && (
              <>
                <button className="btn-primary" onClick={handleSaveTemplate}>
                  {templateSaved ? 'Сохранено!' : 'Сохранить шаблон'}
                </button>
                <button className="btn-secondary" onClick={handleResetTemplate}>
                  По умолчанию
                </button>
              </>
            )}
            {templateSaved && (
              <span style={{ fontSize: '0.8125rem', color: '#16a34a' }}>Шаблон сохранён</span>
            )}
          </div>
        </div>
      )}

      {showModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                {editingTender
                  ? 'Редактировать тендер'
                  : materialsParentTender
                    ? `Тендер на материалы для: ${materialsParentTender.objects?.name || ''}`
                    : isMaterialsView
                      ? 'Новый тендер на материалы'
                      : 'Добавить новый тендер'}
              </h3>
              <button
                className="modal-close"
                onClick={() => {
                  setShowModal(false)
                  setEditingTender(null)
                  setMaterialsParentTender(null)
                }}
              >
                ×
              </button>
            </div>

            <form onSubmit={handleSubmit}>
              <div className="form-grid">
                <div className="form-group full-width">
                  <label>Наименование объекта {objectRequired ? '*' : ''}</label>
                  {allowCustomObject && !materialsParentTender ? (
                    <>
                      {/* Одно поле вместо списка: можно выбрать существующий объект
                          из подсказки или вписать своё название. Совпало с реестром —
                          привязываем к объекту, нет — сохраняем как текст в самом
                          тендере, в раздел «Объекты» такие названия не попадают. */}
                      <input
                        type="text"
                        name="object_name_input"
                        list="tender-object-names"
                        value={objectNameInput}
                        onChange={(e) => setObjectNameInput(e.target.value)}
                        placeholder="Выберите из списка или впишите своё"
                        autoComplete="off"
                      />
                      <datalist id="tender-object-names">
                        {objects.map(obj => <option key={obj.id} value={obj.name} />)}
                      </datalist>
                      <small style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>
                        {matchedObjectByName
                          ? `Совпало с объектом из реестра${objectDeptBadge(matchedObjectByName.status) ? ` · ${objectDeptBadge(matchedObjectByName.status)}` : ''}`
                          : objectNameInput.trim()
                            ? 'Новое наименование — сохранится только в этом тендере'
                            : 'Можно оставить пустым — например, для общехозяйственных закупок'}
                      </small>
                    </>
                  ) : (
                    <>
                      <select
                        name="object_id"
                        value={formData.object_id}
                        onChange={handleInputChange}
                        required={objectRequired}
                        disabled={!!materialsParentTender}
                      >
                        <option value="">{objectRequired ? 'Выберите объект' : 'Без привязки к объекту'}</option>
                        {(materialsParentTender && !objects.some(o => o.id === materialsParentTender.object_id)
                          ? [{ id: materialsParentTender.object_id, name: materialsParentTender.objects?.name || '—' }, ...objects]
                          : objects
                        ).map((obj) => (
                          <option key={obj.id} value={obj.id}>
                            {/* В смешанном списке (совместные / прочее) объекты ОС и ГО
                                бывают одноимёнными — помечаем отделом. */}
                            {showObjectDeptBadge && objectDeptBadge(obj.status)
                              ? `${obj.name} · ${objectDeptBadge(obj.status)}`
                              : obj.name}
                          </option>
                        ))}
                      </select>
                      {materialsParentTender && (
                        <small style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>
                          Объект унаследован от родительского тендера на работы
                        </small>
                      )}
                      {!objectRequired && !materialsParentTender && (
                        <small style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>
                          Объект можно не указывать — например, для общехозяйственных закупок
                        </small>
                      )}
                    </>
                  )}
                </div>

                <div className="form-group full-width">
                  <label>Описание работ *</label>
                  <textarea
                    name="work_description"
                    value={formData.work_description}
                    onChange={handleInputChange}
                    required
                    rows="4"
                    placeholder="Опишите виды работ, которые будут проводиться..."
                  />
                </div>

                {editingTender && (
                  <div className="form-group full-width">
                    <label>Статус *</label>
                    <select
                      name="status"
                      value={formData.status}
                      onChange={handleInputChange}
                      required
                    >
                      {statusOptions.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="form-group">
                  <label>Дата начала работ</label>
                  <input
                    type="date"
                    name="start_date"
                    value={formData.start_date}
                    onChange={handleInputChange}
                    min="2020-01-01"
                    max="9999-12-31"
                  />
                </div>

                <div className="form-group">
                  <label>Дата окончания работ</label>
                  <input
                    type="date"
                    name="end_date"
                    value={formData.end_date}
                    onChange={handleInputChange}
                    min={formData.start_date || '2020-01-01'}
                    max="9999-12-31"
                  />
                </div>

                <div className="form-group">
                  <label>Тендерная процедура: начало</label>
                  <input
                    type="date"
                    name="tender_start_date"
                    value={formData.tender_start_date}
                    onChange={handleInputChange}
                    min="2020-01-01"
                    max="9999-12-31"
                  />
                </div>

                <div className="form-group">
                  <label>Тендерная процедура: окончание</label>
                  <input
                    type="date"
                    name="tender_end_date"
                    value={formData.tender_end_date}
                    onChange={handleInputChange}
                    min={formData.tender_start_date || '2020-01-01'}
                    max="9999-12-31"
                  />
                </div>

                {editingTender && (
                  <>
                    <div className="form-group">
                      <label>Подготовка ВОР: начало</label>
                      <input
                        type="date"
                        name="vor_start_date"
                        value={formData.vor_start_date}
                        onChange={handleInputChange}
                        min="2020-01-01"
                        max="9999-12-31"
                      />
                    </div>

                    <div className="form-group">
                      <label>Подготовка ВОР: окончание</label>
                      <input
                        type="date"
                        name="vor_end_date"
                        value={formData.vor_end_date}
                        onChange={handleInputChange}
                        min={formData.vor_start_date || '2020-01-01'}
                        max="9999-12-31"
                      />
                    </div>

                    <div className="form-group full-width">
                      <label>Ответственный сотрудник</label>
                      <select
                        name="responsible_contact_id"
                        value={formData.responsible_contact_id}
                        onChange={handleInputChange}
                      >
                        <option value="">— не назначен —</option>
                        {getResponsibleOptions(formData.responsible_contact_id).map((contact) => (
                          <option key={contact.id} value={contact.id}>
                            {contact.full_name}{contact.position ? ` — ${contact.position}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group full-width">
                      <label>Ссылка на тендерный пакет</label>
                      <input
                        type="url"
                        name="tender_package_link"
                        value={formData.tender_package_link}
                        onChange={handleInputChange}
                        placeholder="https://example.com/tender-package.pdf"
                      />
                    </div>

                    <div className="form-group full-width">
                      <label>План затрат — ссылка</label>
                      <input
                        type="url"
                        name="cost_plan_link"
                        value={formData.cost_plan_link}
                        onChange={handleInputChange}
                        placeholder="https://drive.google.com/... или https://disk.yandex.ru/..."
                      />
                    </div>

                    <div className="form-group full-width">
                      <label>Ответственный за план затрат</label>
                      <select
                        name="cost_plan_responsible_id"
                        value={formData.cost_plan_responsible_id}
                        onChange={handleInputChange}
                      >
                        <option value="">— не назначен —</option>
                        {responsibleContacts.map((contact) => (
                          <option key={contact.id} value={contact.id}>
                            {contact.full_name}{contact.position ? ` — ${contact.position}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group full-width">
                      <label>ВОРы и РД — ссылка на диск</label>
                      <input
                        type="url"
                        name="vor_link"
                        value={formData.vor_link}
                        onChange={handleInputChange}
                        placeholder="https://drive.google.com/... или https://disk.yandex.ru/..."
                      />
                    </div>

                    <div className="form-group full-width">
                      <label>Ответственный за ВОРы и РД</label>
                      <select
                        name="vor_responsible_id"
                        value={formData.vor_responsible_id}
                        onChange={handleInputChange}
                      >
                        <option value="">— не назначен —</option>
                        {responsibleContacts.map((contact) => (
                          <option key={contact.id} value={contact.id}>
                            {contact.full_name}{contact.position ? ` — ${contact.position}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group full-width">
                      <label>Сводная КП — ссылка</label>
                      <input
                        type="url"
                        name="summary_proposal_link"
                        value={formData.summary_proposal_link}
                        onChange={handleInputChange}
                        placeholder="https://drive.google.com/... или https://disk.yandex.ru/..."
                      />
                    </div>
                  </>
                )}

                <div className="form-group full-width">
                  <label>Примечание</label>
                  <textarea
                    name="notes"
                    value={formData.notes}
                    onChange={handleInputChange}
                    rows={3}
                    placeholder="Свободные заметки по тендеру: ход переговоров, особые условия, риски и т.п."
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setShowModal(false)
                    setEditingTender(null)
                  }}
                >
                  Отмена
                </button>
                {editingTender && formData.responsible_contact_id && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      const selectedObject = objects.find(obj => obj.id === formData.object_id)
                      const objectName = selectedObject?.name || '[Объект не указан]'
                      const selectedContact = responsibleContacts.find(c => c.id === formData.responsible_contact_id)
                      // Номера в форме нет — он присваивается базой, берём из редактируемого тендера.
                      const letter = generateRequestLetter(
                        { ...formData, public_tender_number: editingTender?.public_tender_number },
                        objectName,
                        selectedContact,
                      )
                      setGeneratedLetter(letter)
                      setShowLetterModal(true)
                    }}
                    title="Сгенерировать письмо для подрядчиков"
                  >
                    Письмо подрядчикам
                  </button>
                )}
                <button type="submit" className="btn-primary">
                  {editingTender ? 'Сохранить' : 'Добавить'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showAddCounterpartyModal && (() => {
        const currentTenderCounterparties = tenderCounterparties[selectedTenderForCounterparty] || []
        const uniqueWorkTypes = [...new Set(
          counterparties
            .flatMap(c => (c.work_type || '').split(',').map(wt => wt.trim()))
            .filter(wt => wt !== '')
        )].sort((a, b) => a.localeCompare(b, 'ru'))

        // Уже добавленных к тендеру НЕ прячем — показываем с пометкой «уже в тендере»
        // (иначе кажется, что контрагент «не находится» в списке).
        const addedIds = new Set(currentTenderCounterparties.map(tc => tc.counterparty_id))

        const availableCounterparties = counterparties.filter(cp => {
          // Фильтр по виду работ
          if (counterpartyWorkTypeFilter) {
            const types = (cp.work_type || '').split(',').map(wt => wt.trim())
            if (!types.includes(counterpartyWorkTypeFilter)) return false
          }

          // Поиск (task 415: без категории ОС/ОГ — по названию/виду работ/ИНН)
          if (counterpartySearchQuery.trim()) {
            const query = counterpartySearchQuery.toLowerCase()
            return (
              (cp.name && cp.name.toLowerCase().includes(query)) ||
              (cp.work_type && cp.work_type.toLowerCase().includes(query)) ||
              (cp.inn && cp.inn.toLowerCase().includes(query))
            )
          }

          return true
        })

        // Уже добавленные показываются, но не выбираются — «выбрать все» и счётчик
        // работают только по доступным для добавления.
        const selectableCounterparties = availableCounterparties.filter(cp => !addedIds.has(cp.id))

        return (
          <div className="modal-overlay">
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '900px', maxHeight: '85vh' }}>
              <div className="modal-header">
                <h3>Выбрать контрагентов для добавления к тендеру</h3>
                <button
                  className="modal-close"
                  onClick={() => {
                    setShowAddCounterpartyModal(false)
                    setCounterpartySearchQuery('')
                    setCounterpartyWorkTypeFilter('')
                    setSelectedCounterpartyIds([])
                  }}
                >
                  ×
                </button>
              </div>

              <div style={{ padding: '1.5rem' }}>
                {/* Поиск и фильтры */}
                <div style={{ marginBottom: '1rem' }}>
                  <input
                    type="text"
                    placeholder="🔍 Поиск по названию, виду работ, ИНН..."
                    value={counterpartySearchQuery}
                    onChange={(e) => setCounterpartySearchQuery(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '0.75rem 1rem',
                      fontSize: '1rem',
                      border: '1px solid var(--border-color)',
                      borderRadius: '6px',
                      backgroundColor: 'var(--bg-color)',
                      color: 'var(--text-color)',
                      marginBottom: '0.75rem'
                    }}
                  />

                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    {uniqueWorkTypes.length > 0 && (
                      <FilterDropdown
                        label="Вид работ"
                        value={counterpartyWorkTypeFilter}
                        onChange={(v) => setCounterpartyWorkTypeFilter(v)}
                        options={[
                          { value: '', label: 'Все виды работ' },
                          ...uniqueWorkTypes.map(wt => ({ value: wt, label: wt })),
                        ]}
                        searchable
                        searchPlaceholder="Поиск вида работ…"
                        allLabel="Все виды работ"
                      />
                    )}
                  </div>

                  {/* Сколько строк скрыто фильтром — иначе непонятно, почему нужной
                      компании нет в списке. Рядом — сброс в один клик. */}
                  {(counterpartySearchQuery.trim() || counterpartyWorkTypeFilter) && (
                    <div style={{
                      marginTop: '0.5rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.75rem',
                      fontSize: '0.8125rem',
                      color: 'var(--text-secondary)'
                    }}>
                      <span>Показано {availableCounterparties.length} из {counterparties.length}</span>
                      <button
                        className="btn-secondary"
                        onClick={() => {
                          setCounterpartySearchQuery('')
                          setCounterpartyWorkTypeFilter('')
                        }}
                      >
                        Сбросить фильтры
                      </button>
                    </div>
                  )}
                </div>

                {/* Таблица контрагентов */}
                {counterparties.length === 0 ? (
                  <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '3rem' }}>
                    Нет активных контрагентов
                  </p>
                ) : availableCounterparties.length === 0 ? (
                  <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '3rem' }}>
                    <p>Контрагенты не найдены по заданным критериям</p>
                    <p style={{ fontSize: '0.8125rem' }}>
                      Всего активных контрагентов: {counterparties.length}
                    </p>
                    <button
                      className="btn-secondary"
                      onClick={() => {
                        setCounterpartySearchQuery('')
                        setCounterpartyWorkTypeFilter('')
                      }}
                    >
                      Показать всех
                    </button>
                  </div>
                ) : (
                  <>
                    <div style={{
                      maxHeight: '400px',
                      overflowY: 'auto',
                      border: '1px solid var(--border-color)',
                      borderRadius: '8px',
                      marginBottom: '1rem'
                    }}>
                      <table className="data-table" style={{ margin: 0 }}>
                        <thead>
                          <tr>
                            <th style={{
                              width: '50px',
                              position: 'sticky',
                              top: 0,
                              backgroundColor: 'var(--card-bg)',
                              backdropFilter: 'blur(10px)',
                              zIndex: 11,
                              borderBottom: '2px solid var(--border-color)',
                              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
                              padding: '0.75rem'
                            }}>
                              <input
                                type="checkbox"
                                checked={selectableCounterparties.length > 0 && selectedCounterpartyIds.length === selectableCounterparties.length}
                                disabled={selectableCounterparties.length === 0}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setSelectedCounterpartyIds(selectableCounterparties.map(cp => cp.id))
                                  } else {
                                    setSelectedCounterpartyIds([])
                                  }
                                }}
                                style={{ cursor: 'pointer' }}
                              />
                            </th>
                            <th style={{
                              position: 'sticky',
                              top: 0,
                              backgroundColor: 'var(--card-bg)',
                              backdropFilter: 'blur(10px)',
                              zIndex: 11,
                              borderBottom: '2px solid var(--border-color)',
                              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
                              padding: '0.75rem'
                            }}>Наименование</th>
                            <th style={{
                              position: 'sticky',
                              top: 0,
                              backgroundColor: 'var(--card-bg)',
                              zIndex: 11,
                              borderBottom: '2px solid var(--border-color)',
                              padding: '0.75rem'
                            }}>Вид работ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {availableCounterparties.map((counterparty) => {
                            const isAdded = addedIds.has(counterparty.id)
                            return (
                            <tr
                              key={counterparty.id}
                              style={{
                                cursor: isAdded ? 'default' : 'pointer',
                                opacity: isAdded ? 0.55 : 1,
                                backgroundColor: !isAdded && selectedCounterpartyIds.includes(counterparty.id) ? 'var(--hover-bg, #f0f9ff)' : ''
                              }}
                              onClick={() => { if (!isAdded) handleToggleCounterpartySelection(counterparty.id) }}
                              onMouseEnter={(e) => {
                                if (!isAdded && !selectedCounterpartyIds.includes(counterparty.id)) {
                                  e.currentTarget.style.backgroundColor = 'var(--hover-bg, #f9fafb)'
                                }
                              }}
                              onMouseLeave={(e) => {
                                if (!isAdded && !selectedCounterpartyIds.includes(counterparty.id)) {
                                  e.currentTarget.style.backgroundColor = ''
                                }
                              }}
                            >
                              <td onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  checked={!isAdded && selectedCounterpartyIds.includes(counterparty.id)}
                                  disabled={isAdded}
                                  onChange={() => { if (!isAdded) handleToggleCounterpartySelection(counterparty.id) }}
                                  style={{ cursor: isAdded ? 'default' : 'pointer' }}
                                />
                              </td>
                              <td style={{ fontWeight: 500 }}>
                                {counterparty.name}
                                {isAdded && (
                                  <span style={{
                                    marginLeft: '0.5rem',
                                    padding: '0.0625rem 0.4375rem',
                                    fontSize: '0.6875rem',
                                    fontWeight: 600,
                                    color: 'var(--text-tertiary)',
                                    background: 'var(--bg-tertiary)',
                                    border: '1px solid var(--border-color)',
                                    borderRadius: '999px',
                                    whiteSpace: 'nowrap'
                                  }}>уже в тендере</span>
                                )}
                              </td>
                              <td>
                                {counterparty.work_type ? (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                                    {counterparty.work_type.split(',').map((wt, i) => (
                                      <span key={i} style={{
                                        display: 'block',
                                        padding: '0.1rem 0.35rem',
                                        fontSize: '0.75rem',
                                        background: 'var(--bg-tertiary)',
                                        borderRadius: '3px',
                                        borderLeft: '2px solid var(--primary-color)',
                                        color: 'var(--text-secondary)',
                                      }}>{wt.trim()}</span>
                                    ))}
                                  </div>
                                ) : '-'}
                              </td>
                            </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                        {selectedCounterpartyIds.length > 0 && (
                          <span>Выбрано: <strong>{selectedCounterpartyIds.length}</strong></span>
                        )}
                      </div>
                      <button
                        onClick={handleAddCounterpartiesToTender}
                        disabled={selectedCounterpartyIds.length === 0}
                        style={{
                          backgroundColor: selectedCounterpartyIds.length > 0 ? 'var(--primary-color)' : '#9ca3af',
                          color: 'white',
                          border: 'none',
                          borderRadius: '8px',
                          padding: '0.75rem 2rem',
                          cursor: selectedCounterpartyIds.length > 0 ? 'pointer' : 'not-allowed',
                          fontSize: '1rem',
                          fontWeight: '600',
                          transition: 'all 0.2s',
                          boxShadow: selectedCounterpartyIds.length > 0 ? '0 4px 6px rgba(0, 0, 0, 0.1)' : 'none'
                        }}
                        onMouseEnter={(e) => {
                          if (selectedCounterpartyIds.length > 0) {
                            e.target.style.transform = 'scale(1.05)'
                            e.target.style.boxShadow = '0 6px 8px rgba(0, 0, 0, 0.15)'
                          }
                        }}
                        onMouseLeave={(e) => {
                          e.target.style.transform = 'scale(1)'
                          if (selectedCounterpartyIds.length > 0) {
                            e.target.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.1)'
                          }
                        }}
                      >
                        ✓ Добавить выбранных ({selectedCounterpartyIds.length})
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )
      })()}

      {/* Модальное окно выбора победителя */}
      {showWinnerModal && tenderForWinnerSelection && (() => {
        const tenderCps = tenderCounterparties[tenderForWinnerSelection.id] || []

        return (
          <div className="modal-overlay">
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
              <div className="modal-header">
                <h3>Выбор победителей тендера</h3>
                <button
                  className="modal-close"
                  onClick={() => {
                    setShowWinnerModal(false)
                    setTenderForWinnerSelection(null)
                    setSelectedWinners([])
                  }}
                >
                  ×
                </button>
              </div>

              <div style={{ padding: '1.5rem' }}>
                <div style={{ marginBottom: '1.5rem' }}>
                  <p style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                    <strong>Объект:</strong> {tenderForWinnerSelection.objects?.name || '-'}
                  </p>
                  <p style={{ color: 'var(--text-secondary)' }}>
                    <strong>Описание работ:</strong> {tenderForWinnerSelection.work_description}
                  </p>
                </div>

                {tenderCps.length === 0 ? (
                  <div style={{
                    textAlign: 'center',
                    padding: '2rem',
                    color: 'var(--text-secondary)',
                    backgroundColor: 'var(--bg-tertiary)',
                    borderRadius: '8px'
                  }}>
                    <p style={{ marginBottom: '1rem' }}>К этому тендеру не добавлены контрагенты.</p>
                    <p>Вы можете завершить тендер без победителя или сначала добавить контрагентов.</p>
                  </div>
                ) : (
                  <>
                    <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', fontWeight: '500' }}>
                      Выберите победителей тендера (можно несколько — при разделении по корпусам/системам):
                    </p>
                    <div style={{
                      maxHeight: '320px',
                      overflowY: 'auto',
                      border: '1px solid var(--border-color)',
                      borderRadius: '8px'
                    }}>
                      {tenderCps.map((tc) => {
                        const selected = isWinnerSelected(tc.counterparty_id)
                        return (
                          <div
                            key={tc.id}
                            onClick={() => toggleWinner(tc.counterparty_id)}
                            style={{
                              padding: '1rem',
                              cursor: 'pointer',
                              borderBottom: '1px solid var(--border-color)',
                              backgroundColor: selected ? 'color-mix(in srgb, var(--primary-color) 12%, transparent)' : 'transparent',
                              color: 'var(--text-primary)',
                              transition: 'background 0.15s',
                              display: 'flex',
                              alignItems: 'flex-start',
                              gap: '1rem'
                            }}
                            onMouseEnter={(e) => {
                              if (!selected) e.currentTarget.style.backgroundColor = 'var(--hover-bg)'
                            }}
                            onMouseLeave={(e) => {
                              if (!selected) e.currentTarget.style.backgroundColor = 'transparent'
                            }}
                          >
                            <div style={{
                              width: '20px',
                              height: '20px',
                              borderRadius: '4px',
                              border: selected ? '2px solid var(--primary-color)' : '2px solid var(--border-color)',
                              background: selected ? 'var(--primary-color)' : 'transparent',
                              color: 'white',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                              marginTop: '0.125rem',
                              fontSize: '0.75rem',
                              lineHeight: 1
                            }}>
                              {selected && '✓'}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: '600', marginBottom: '0.25rem' }}>
                                {tc.counterparties?.name}
                              </div>
                              {tc.counterparties?.work_type && (
                                <div style={{ fontSize: '0.875rem', opacity: 0.7 }}>
                                  {tc.counterparties.work_type}
                                </div>
                              )}
                              <div style={{
                                fontSize: '0.75rem',
                                marginTop: '0.25rem',
                                padding: '0.25rem 0.5rem',
                                borderRadius: '4px',
                                display: 'inline-block',
                                backgroundColor: 'var(--bg-tertiary)',
                                color: getCounterpartyStatusColor(tc.status)
                              }}>
                                {getCounterpartyStatusLabel(tc.status || 'request_sent')}
                              </div>
                              {selected && (
                                <div
                                  onClick={(e) => e.stopPropagation()}
                                  style={{ marginTop: '0.625rem' }}
                                >
                                  <input
                                    type="text"
                                    value={getWinnerScope(tc.counterparty_id)}
                                    onChange={(e) => setWinnerScope(tc.counterparty_id, e.target.value)}
                                    placeholder="Корпус / система (необязательно)"
                                    style={{
                                      width: '100%',
                                      padding: '0.375rem 0.5rem',
                                      fontSize: '0.8125rem',
                                      border: '1px solid var(--border-color)',
                                      borderRadius: '4px',
                                      background: 'var(--bg-secondary)',
                                      color: 'var(--text-primary)',
                                      fontFamily: 'inherit',
                                      boxSizing: 'border-box'
                                    }}
                                  />
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    {selectedWinners.length > 0 && (
                      <p style={{ marginTop: '0.75rem', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                        Выбрано победителей: <strong>{selectedWinners.length}</strong>. На каждого будет создан проект договора.
                      </p>
                    )}
                  </>
                )}

                <div style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: '1rem',
                  marginTop: '1.5rem',
                  paddingTop: '1.5rem',
                  borderTop: '1px solid var(--border-color)'
                }}>
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      setShowWinnerModal(false)
                      setTenderForWinnerSelection(null)
                      setSelectedWinners([])
                    }}
                  >
                    Отмена
                  </button>
                  <button
                    className="btn-primary"
                    onClick={handleConfirmWinner}
                  >
                    {selectedWinners.length > 0 ? 'Завершить с победителями' : 'Завершить без победителя'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Документы «ВОРы и РД» */}
      {vorDocsModalTenderId && (
        <VorDocsModal
          tenderId={vorDocsModalTenderId}
          onClose={() => setVorDocsModalTenderId(null)}
          onChange={() => refreshVorDocCount(vorDocsModalTenderId)}
        />
      )}

      {/* task 397: документы «Тендерный пакет» */}
      {packageDocsModalTenderId && (
        <VorDocsModal
          tenderId={packageDocsModalTenderId}
          title="Документы тендерного пакета"
          category="tender_package"
          onClose={() => setPackageDocsModalTenderId(null)}
          onChange={() => refreshPackageDocCount(packageDocsModalTenderId)}
        />
      )}

      {showLetterModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '700px', maxHeight: '90vh' }}>
            <div className="modal-header">
              <h3>📧 Шаблон письма для запроса КП</h3>
              <button
                className="modal-close"
                onClick={() => {
                  setShowLetterModal(false)
                  setLetterCopied(false)
                }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: '1.5rem' }}>
              <p style={{
                color: 'var(--text-secondary)',
                marginBottom: '1rem',
                fontSize: '0.9rem'
              }}>
                Тендер успешно создан! Ниже готовое письмо для отправки контрагентам:
              </p>

              <div style={{
                backgroundColor: 'var(--bg-tertiary)',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                padding: '1.5rem',
                maxHeight: '400px',
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                fontFamily: 'inherit',
                fontSize: '0.9rem',
                lineHeight: '1.6',
                color: 'var(--text-primary)'
              }}>
                {generatedLetter}
              </div>

              <div style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '1rem',
                marginTop: '1.5rem',
                paddingTop: '1rem',
                borderTop: '1px solid var(--border-color)'
              }}>
                <button
                  className="btn-secondary"
                  onClick={() => {
                    setShowLetterModal(false)
                    setLetterCopied(false)
                  }}
                >
                  Закрыть
                </button>
                <button
                  className="btn-primary"
                  onClick={handleCopyLetter}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    backgroundColor: letterCopied ? '#16a34a' : undefined
                  }}
                >
                  {letterCopied ? '✓ Скопировано!' : '📋 Копировать письмо'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Хронология правок примечания участника. Только чтение; закрывается крестиком/«Закрыть». */}
      {notesHistoryFor && (
        <div className="modal-overlay">
          <div className="modal tc-notes-history-modal">
            <div className="modal-header">
              <div>
                <h3>История примечания</h3>
                <p className="tc-notes-history-sub">{notesHistoryFor.cpName || 'Участник тендера'}</p>
              </div>
              <button className="modal-close" onClick={() => setNotesHistoryFor(null)} aria-label="Закрыть">×</button>
            </div>
            <div className="tc-notes-history-body">
              {notesHistoryLoading ? (
                <div className="loading">Загрузка...</div>
              ) : notesHistoryRows.length === 0 ? (
                <div className="tc-notes-history-empty">
                  <p>Записей нет.</p>
                  <p className="tc-notes-history-hint">
                    История ведётся с момента подключения этой функции — более ранние правки
                    не фиксировались.
                  </p>
                </div>
              ) : (
                <>
                  <div className="tc-notes-history-legend">
                    <span className="nd-removed">удалено</span>
                    <span className="nd-added">добавлено</span>
                  </div>
                  <ul className="tc-notes-history-list">
                    {notesHistoryRows.map(ev => {
                      const before = ev.old_value?.text || ''
                      const after = ev.new_value?.text || ''
                      const parts = diffWords(before, after)
                      const author = ev.changed_by_name
                        || ROLE_LABELS_MAP[ev.changed_by_role]
                        || ev.changed_by_role
                        || 'без имени'
                      const kind = !before ? 'Примечание добавлено' : !after ? 'Примечание очищено' : 'Примечание изменено'
                      return (
                        <li key={ev.id} className="tc-notes-history-item">
                          <div className="tc-notes-history-meta">
                            <span className="tc-notes-history-when">{formatDateTime(ev.changed_at)}</span>
                            <span className="tc-notes-history-who">{author}</span>
                          </div>
                          <div className="tc-notes-history-kind">{kind}</div>
                          <div className="tc-notes-diff">
                            {parts.length === 0 ? (
                              <span className="tc-notes-diff-empty">— пусто —</span>
                            ) : (
                              parts.map((p, idx) => (
                                <span
                                  key={idx}
                                  className={p.type === 'added' ? 'nd-added' : p.type === 'removed' ? 'nd-removed' : undefined}
                                >
                                  {p.text}
                                </span>
                              ))
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-secondary" onClick={() => setNotesHistoryFor(null)}>Закрыть</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default TendersPage
