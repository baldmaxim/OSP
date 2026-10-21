import { useState, useEffect, useRef, useMemo, useDeferredValue, useTransition, useCallback } from 'react'
import { db } from '../api'
import { fetchAllRows, fetchAllRowsParallel } from '../utils/fetchAllRows'
import * as XLSX from 'xlsx'
import { formatPhone } from '../utils/phoneFormat'
import { generateUUID } from '../utils/uuid'
import { useRole } from '../contexts/RoleContext'
import CounterpartyCardChip from '../components/CounterpartyCardChip'
import CounterpartyDocBadges from '../components/CounterpartyDocBadges'
import S3DocumentList from '../components/S3DocumentList'
import { fetchCounterpartyDocSummary } from '../services/s3'
import { useIsPhone } from '../hooks/useMediaQuery'
import { diffWords } from '../utils/textDiff'
import { shortPersonName } from '../utils/personName'
import { buildRelationGroups, groupMatesOf, planRemoveFromGroup } from '../utils/counterpartyGroups'
import { vatFromSelect, vatText } from '../utils/counterpartyVat'
import { docTitle } from '../utils/counterpartyDocs'
import CounterpartyGeneralTab from '../components/counterparty/CounterpartyGeneralTab'
import './CounterpartiesPage.css'
import '../components/GeneralInfo.css'

// Инкрементальный рендер: сколько строк показываем изначально и на сколько прирастаем
// по кнопке «Показать ещё» — чтобы DOM оставался лёгким на больших списках.
const RENDER_STEP = 100

const EMPTY_CP_FORM = {
  name: '',
  work_type: '',
  department: '',
  inn: '',
  kpp: '',
  legal_address: '',
  actual_address: '',
  website: '',
  status: 'active',
  notes: '',
}
const EMPTY_CONTACT_FORM = { full_name: '', position: '', phone: '', email: '' }

const TENDER_STATUS_LABEL = {
  request_sent: 'Запрос отправлен',
  declined: 'Отказался',
  proposal_provided: 'Предоставил КП',
  accepted_for_work: 'Принят в работу',
}

const ruCollator = new Intl.Collator('ru')

// «Вид работ» хранится строкой через запятую.
const splitWorkTypes = (value) => (value || '').split(',').map(wt => wt.trim()).filter(Boolean)

const fmtRuDate = (iso) => (iso
  ? new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
  : null)

// Колонки файла импорта: шаблон, инструкция и разбор читают один список.
const IMPORT_COLUMNS = [
  { name: 'Наименование организации', required: true, example: 'ООО «Стройком»' },
  { name: 'Категория работ', example: 'Основное строительство, Гарантийный отдел' },
  { name: 'Вид работ', example: 'Строительно-монтажные работы' },
  { name: 'ИНН', example: '7728123456' },
  { name: 'КПП', example: '772801001' },
  { name: 'Юридический адрес', example: 'г. Москва, ул. Ленина, д. 1' },
  { name: 'Фактический адрес', example: 'г. Москва, ул. Ленина, д. 1' },
  { name: 'Ссылка на сайт', example: 'https://stroykom.ru' },
  { name: 'Статус', example: 'Действующий или Черный список' },
  { name: 'Примечание', example: 'Хороший подрядчик, рекомендуем' },
  { name: 'ФИО контакта', example: 'Иванов Иван Иванович' },
  { name: 'Должность контакта', example: 'Директор' },
  { name: 'Телефон контакта', example: '+7 (999) 123-45-67' },
  { name: 'Email контакта', example: 'director@stroykom.ru' },
]

// ── История изменений контрагента (миграция 20260829) ───────────────────────
// Подписи полей карточки для ленты «Изменения».
const CP_FIELD_LABEL = {
  name: 'Наименование',
  inn: 'ИНН',
  kpp: 'КПП',
  legal_address: 'Юридический адрес',
  actual_address: 'Фактический адрес',
  website: 'Сайт',
  work_type: 'Виды работ',
  department: 'Отдел',
  status: 'Статус',
  notes: 'Примечание',
}
const CP_STATUS_TEXT = { active: 'Действующий', blacklist: 'Чёрный список' }

function cpValueText(field, value) {
  if (value === null || value === undefined || value === '') return '—'
  if (field === 'status') return CP_STATUS_TEXT[value] || String(value)
  return String(value)
}

// Ключ контакта для сравнения наборов. В форме контрагента контакты каждый раз
// пересоздаются целиком (insert новых → delete старых), поэтому по самим
// операциям судить нельзя: любое сохранение выглядело бы как полная замена.
// Сравниваем по содержимому, а не по id.
function contactKey(c) {
  return [c?.full_name, c?.position, c?.phone, c?.email]
    .map(v => String(v ?? '').trim().toLowerCase())
    .join('|')
}
function contactText(c) {
  const parts = [c?.full_name, c?.position, c?.phone, c?.email].map(v => String(v ?? '').trim()).filter(Boolean)
  return parts.join(', ') || 'без данных'
}

const CP_EVENT_LABEL = {
  created: 'Контрагент создан',
  imported: 'Загружен из Excel',
  field_updated: 'Изменено поле',
  status_changed: 'Изменён статус',
  contact_added: 'Добавлено контактное лицо',
  contact_updated: 'Изменено контактное лицо',
  contact_removed: 'Удалено контактное лицо',
  soft_deleted: 'Перенесён в «Удалённые»',
  restored: 'Восстановлен',
  contract_linked: 'Прикреплён договор',
  contract_unlinked: 'Откреплён договор',
}

function fmtAuditDateTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ru-RU') + ', ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

// Подформа контакта в окне контрагента: подписи и поля.
const SUB_LABEL_STYLE = { fontSize: '0.875rem', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '0.25rem', display: 'block' }
const SUB_INPUT_STYLE = { width: '100%', padding: '0.5rem', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '0.875rem', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)' }

// Несколько телефонов или адресов почты в одном поле базы — через «;». Два вида: подформа контакта в окне
// контрагента (form) и отдельное окно контакта (modal, поля — по стилям .form-group).
const MULTI_STYLES = {
  form: {
    input: { ...SUB_INPUT_STYLE, width: undefined, flex: 1 },
    remove: { padding: '0 0.5rem', border: '1px solid #d1d5db', borderRadius: '4px', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '0.875rem' },
    add: { marginTop: '0.25rem', padding: '0.25rem 0.5rem', border: 'none', background: 'none', color: 'var(--primary-color)', cursor: 'pointer', fontSize: '0.8125rem' },
  },
  modal: {
    input: { flex: 1 },
    remove: { padding: '0 0.5rem', border: '1px solid var(--border-color)', borderRadius: '4px', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer' },
    add: { marginTop: '0.25rem', padding: '0.25rem 0', border: 'none', background: 'none', color: 'var(--primary-color)', cursor: 'pointer', fontSize: '0.8125rem', textAlign: 'left' },
  },
}

function MultiValueInput({ value, onChange, type, placeholder, format, addLabel, removeTitle, variant }) {
  const styles = MULTI_STYLES[variant]
  const items = (value || '').split(';').map(x => x.trim())
  return (
    <>
      {items.map((item, idx) => (
        <div key={idx} style={{ display: 'flex', gap: '0.25rem', marginBottom: idx < items.length - 1 ? '0.25rem' : 0 }}>
          <input
            type={type}
            value={item}
            onChange={(e) => onChange(items.map((x, i) => (i === idx ? (format ? format(e.target.value) : e.target.value) : x)).join('; '))}
            placeholder={placeholder}
            style={styles.input}
          />
          {items.length > 1 && (
            <button
              type="button"
              onClick={() => onChange(items.filter((_, i) => i !== idx).join('; '))}
              style={styles.remove}
              title={removeTitle}
              aria-label={removeTitle}
            >×</button>
          )}
        </div>
      ))}
      <button type="button" onClick={() => onChange((value || '') + '; ')} style={styles.add}>{addLabel}</button>
    </>
  )
}

function CounterpartiesPage() {
  const { isAdmin, canEdit, canView, userProfile } = useRole()
  // task 333: гейт add/edit/delete и inline-editing для раздела «counterparties».
  const canEditCp = canEdit('counterparties')
  const [counterparties, setCounterparties] = useState([])
  const isPhone = useIsPhone()
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState(null) // { success: [], errors: [], totalParsed: 0 }
  const [showCounterpartyModal, setShowCounterpartyModal] = useState(false)
  const [showContactModal, setShowContactModal] = useState(false)
  const [showImportInstructionsModal, setShowImportInstructionsModal] = useState(false)
  const [editingCounterparty, setEditingCounterparty] = useState(null)
  const [selectedCounterparty, setSelectedCounterparty] = useState(null)
  const [editingContact, setEditingContact] = useState(null)
  const [selectedCounterpartyIds, setSelectedCounterpartyIds] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  // task 339: useDeferredValue — фильтрация большой таблицы (500+ строк)
  // переезжает в low-priority render, инпут остаётся отзывчивым на каждый
  // keystroke. React не ждёт окончания пересборки таблицы перед отрисовкой
  // нового значения в input.
  const deferredSearchQuery = useDeferredValue(searchQuery)
  const [workTypeFilter, setWorkTypeFilter] = useState('')
  // task 302: карточки компаний (s3_documents owner_type='counterparty') — map по owner_id, latest first.
  const [cardsByCp, setCardsByCp] = useState(() => new Map())
  // task 422: сводка документов СБ/должной осмотрительности — map по owner_id.
  const [docSummaryByCp, setDocSummaryByCp] = useState(() => new Map())
  const fileInputRef = useRef(null)

  const [counterpartyFormData, setCounterpartyFormData] = useState(EMPTY_CP_FORM)
  const [contactFormData, setContactFormData] = useState(EMPTY_CONTACT_FORM)

  // Контакты, которые добавляются при создании/редактировании контрагента
  const [tempContacts, setTempContacts] = useState([])
  const [editingTempContactIndex, setEditingTempContactIndex] = useState(null)
  // Detail-модалка контрагента (по клику на строку): общая информация, документы, история тендеров,
  // журнал правок + редактирование.
  const [detailCp, setDetailCp] = useState(null)
  const [detailTab, setDetailTab] = useState('general') // 'general' | 'documents' | 'history' | 'changes'
  // История изменений контрагента: { counterpartyId: [события] }, ленивая загрузка.
  const [auditMap, setAuditMap] = useState({})
  const [auditLoadingId, setAuditLoadingId] = useState(null)
  // Сохранение карточки контрагента: блокировка формы от повторной отправки.
  const [cpSaving, setCpSaving] = useState(false)
  const cpSavingRef = useRef(false)
  // Инкрементальный рендер большого списка: показываем срез, «Показать ещё» наращивает.
  const [visibleCount, setVisibleCount] = useState(RENDER_STEP)

  // Виды работ (множественный выбор; task 321 — подтягиваются только из справочника)
  const [workTypes, setWorkTypes] = useState([])
  // task 322: поиск по справочнику видов работ внутри модалки контрагента
  const [wtSearch, setWtSearch] = useState('')
  const [wtDropdownOpen, setWtDropdownOpen] = useState(false)
  // task 323: поисковый фильтр «Виды работ» в верхнем тулбаре
  const [wtfSearch, setWtfSearch] = useState('')
  const [wtfOpen, setWtfOpen] = useState(false)

  // Аффилированные компании — пары counterparty_relations, читаются группами («Общая информация» карточки).
  const [relations, setRelations] = useState([]) // [{id, counterparty_id, related_counterparty_id}]

  // task 196: история участия в тендерах — лениво грузим при раскрытии строки
  const [tenderHistoryMap, setTenderHistoryMap] = useState({}) // { counterpartyId: [{tender_id, status, work_description, tender_start_date, tender_end_date, object_name}] }
  const [tenderHistoryLoadingId, setTenderHistoryLoadingId] = useState(null)

  // task 197: вкладка «Активные» / «Удалённые»
  // task 321: добавлена вкладка «Виды работ» — справочник work_types
  const [activeTab, setActiveTab] = useState('active') // 'active' | 'blacklist' | 'deleted' | 'work_types'
  // task 343: переключение табов через useTransition — кнопка-таб становится
  // активной мгновенно, перерисовка тяжёлой таблицы (~500 строк) уходит в
  // low-priority render и не блокирует клик/визуальный отклик.
  const [isTabPending, startTabTransition] = useTransition()
  const switchTab = useCallback((tab) => {
    startTabTransition(() => {
      setActiveTab(tab)
      setSelectedCounterpartyIds([])
      setDetailCp(null)
    })
  }, [])

  // task 321: справочник видов работ
  const [workTypesDirectory, setWorkTypesDirectory] = useState([])
  const [showWorkTypeModal, setShowWorkTypeModal] = useState(false)
  const [editingWorkType, setEditingWorkType] = useState(null)
  const [workTypeForm, setWorkTypeForm] = useState({ name: '', description: '' })
  // task 326: поиск по справочнику видов работ
  const [wtDirSearch, setWtDirSearch] = useState('')

  useEffect(() => {
    fetchCounterparties()
    fetchRelations()
    fetchWorkTypesDirectory()
  }, [])

  // Блокируем скролл body при открытой модалке
  const anyModalOpen = showCounterpartyModal || showContactModal || showImportInstructionsModal || showWorkTypeModal || importResult || detailCp
  useEffect(() => {
    if (anyModalOpen) {
      document.body.classList.add('modal-open')
    } else {
      document.body.classList.remove('modal-open')
    }
    return () => document.body.classList.remove('modal-open')
  }, [anyModalOpen])

  // Контрагенты, карточки компаний и сводка документов — одновременно: друг от друга они не зависят,
  // а последовательно складывались в три полные задержки сети на каждом открытии раздела.
  const fetchCounterparties = async () => {
    setLoading(true)
    // task 302: карточки компаний. Только doc_category='general' — чтобы документы СБ/Прочие (та же
    // owner_type='counterparty', категории 'sb_approval'/'other') не попадали в «карточку компании».
    const cardsTask = fetchAllRowsParallel((from, to, withCount) => db
      .from('s3_documents')
      .select('id, owner_id, file_name, s3_key, mime_type, size_bytes, created_at', withCount ? { count: 'exact' } : undefined)
      .eq('owner_type', 'counterparty')
      .eq('doc_category', 'general')
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to))
      .then((cards) => {
        const map = new Map()
        for (const c of cards) if (!map.has(c.owner_id)) map.set(c.owner_id, c) // latest first из order
        return map
      })
      .catch((err) => {
        console.warn('Не удалось загрузить карточки компаний:', err.message)
        return new Map()
      })
    // Сводка документов «Согласование СБ» / «Должная осмотрительность» — значки в строке (task 422).
    const summaryTask = fetchCounterpartyDocSummary().catch((err) => {
      console.warn('Не удалось загрузить сводку документов контрагентов:', err.message)
      return new Map()
    })
    try {
      // Постранично (потолок PostgREST — 1000 строк), страницы параллельно; тай-брейк по id — стабильная
      // пагинация при неуникальных именах.
      const data = await fetchAllRowsParallel((from, to, withCount) => db
        .from('counterparties')
        .select('*, counterparty_contacts (id, full_name, position, phone, email)', withCount ? { count: 'exact' } : undefined)
        .order('name', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to))
      setCounterparties(data)
    } catch (error) {
      console.error('Ошибка загрузки контрагентов:', error.message)
    }
    const [cards, summary] = await Promise.all([cardsTask, summaryTask])
    setCardsByCp(cards)
    setDocSummaryByCp(summary)
    setLoading(false)
  }

  const fetchRelations = async () => {
    try {
      // Постранично — связей может быть больше 1000.
      const data = await fetchAllRows((from, to) => db
        .from('counterparty_relations')
        .select('id, counterparty_id, related_counterparty_id')
        .order('id', { ascending: true })
        .range(from, to))
      setRelations(data)
    } catch (error) {
      console.error('Ошибка загрузки связей:', error.message)
    }
  }

  // task 321: справочник видов работ.
  const fetchWorkTypesDirectory = async () => {
    try {
      const { data, error } = await db
        .from('work_types')
        .select('*')
        .order('name', { ascending: true })
      if (error) throw error
      setWorkTypesDirectory(data || [])
    } catch (err) {
      console.warn('Не удалось загрузить справочник видов работ (таблица work_types?):', err.message)
      setWorkTypesDirectory([])
    }
  }

  const handleOpenAddWorkType = () => {
    setEditingWorkType(null)
    setWorkTypeForm({ name: '', description: '' })
    setShowWorkTypeModal(true)
  }

  const handleOpenEditWorkType = (wt) => {
    setEditingWorkType(wt)
    setWorkTypeForm({ name: wt.name, description: wt.description || '' })
    setShowWorkTypeModal(true)
  }

  const handleSubmitWorkType = async (e) => {
    e.preventDefault()
    const name = workTypeForm.name.trim()
    if (!name) {
      alert('Укажите название вида работ')
      return
    }
    const payload = {
      name,
      description: workTypeForm.description.trim() || null,
      updated_at: new Date().toISOString(),
    }
    try {
      if (editingWorkType) {
        const { error } = await db
          .from('work_types')
          .update(payload)
          .eq('id', editingWorkType.id)
        if (error) throw error
        // Если у вида работ было старое имя — синхронизируем все counterparties.work_type,
        // где это значение упоминается в comma-separated списке. Порциями по 8 одновременно:
        // по одному запросу подряд переименование популярного вида шло десятки секунд.
        if (editingWorkType.name !== name) {
          const old = editingWorkType.name
          const affected = counterparties.filter(cp => splitWorkTypes(cp.work_type).includes(old))
          for (let i = 0; i < affected.length; i += 8) {
            await Promise.all(affected.slice(i, i + 8).map(cp => db
              .from('counterparties')
              .update({ work_type: [...new Set(splitWorkTypes(cp.work_type).map(x => (x === old ? name : x)))].join(', ') })
              .eq('id', cp.id)))
          }
        }
      } else {
        const { error } = await db.from('work_types').insert([payload])
        if (error) throw error
      }
      setShowWorkTypeModal(false)
      setEditingWorkType(null)
      setWorkTypeForm({ name: '', description: '' })
      fetchWorkTypesDirectory()
      fetchCounterparties()
    } catch (err) {
      if (err.code === '23505') {
        alert('Вид работ с таким названием уже существует')
      } else {
        alert('Ошибка сохранения вида работ: ' + err.message)
      }
    }
  }

  const handleDeleteWorkType = async (wt) => {
    const used = workTypeUsage.get(wt.name) || 0
    const msg = used > 0
      ? `Вид работ «${wt.name}» используется у ${used} контрагент(ов). Удалить из справочника? У контрагентов значение останется текстом до ручной правки.`
      : `Удалить вид работ «${wt.name}»?`
    if (!window.confirm(msg)) return
    try {
      const { error } = await db.from('work_types').delete().eq('id', wt.id)
      if (error) throw error
      fetchWorkTypesDirectory()
    } catch (err) {
      alert('Ошибка удаления: ' + err.message)
    }
  }

  const counterpartyById = useMemo(() => new Map(counterparties.map(c => [c.id, c])), [counterparties])

  // Аффилированные — ГРУППАМИ, а не парами (utils/counterpartyGroups.js): если A связан
  // с B, а B с C, то у каждого из троих видны двое остальных. Раньше показывались
  // только прямые пары, и у второстепенного юрлица пропадала часть группы.
  const relationGroups = useMemo(() => buildRelationGroups(relations), [relations])

  // Вся группа, кроме самого контрагента, — в порядке реестра.
  const getRelatedCounterparties = (counterpartyId) => {
    const relatedIds = new Set(groupMatesOf(relationGroups, counterpartyId))
    return relatedIds.size ? counterparties.filter(c => relatedIds.has(c.id)) : []
  }

  const handleAddRelation = async (counterpartyId, relatedId) => {
    // У добавляемого уже может быть своя группа — тогда группы сольются в одну.
    // Это меняет связи у всех её участников, поэтому спрашиваем явно.
    const otherMates = groupMatesOf(relationGroups, relatedId)
    if (otherMates.length > 0) {
      const nameOf = (id) => counterpartyById.get(id)?.name
      const list = otherMates.map(id => `• ${nameOf(id) || id}`).join('\n')
      if (!window.confirm(`${nameOf(relatedId) || 'Контрагент'} уже связан с:\n${list}\n\nГруппы объединятся — все эти контрагенты станут связаны между собой. Продолжить?`)) return false
    }
    try {
      // Пара сохраняется в одном направлении; группа собирается при чтении.
      const { error } = await db
        .from('counterparty_relations')
        .insert([{ counterparty_id: counterpartyId, related_counterparty_id: relatedId }])

      if (error) {
        if (error.code === '23505') {
          alert('Эта связь уже существует')
          return false
        }
        throw error
      }
      await fetchRelations()
      return true
    } catch (error) {
      console.error('Ошибка добавления связи:', error.message)
      alert('Ошибка: ' + error.message)
      return false
    }
  }

  // Убрать контрагента из группы. Прямой пары с открытым контрагентом может и
  // не быть (связь через третьего), поэтому удаляются все пары исключаемого, а
  // если группа держалась на нём, оставшиеся части сшиваются с открытым
  // контрагентом — см. planRemoveFromGroup.
  const handleRemoveRelation = async (targetId, otherId) => {
    const members = relationGroups.get(otherId)
    const otherName = counterpartyById.get(otherId)?.name || 'Контрагент'
    if (members && members.size > 2
      && !window.confirm(`${otherName} будет исключён из группы связанных контрагентов — связь пропадёт у всех участников группы (${members.size - 1}). Продолжить?`)) {
      return
    }
    try {
      const { deleteIds, insertPairs } = planRemoveFromGroup(relations, otherId, targetId)
      // Сначала сшиваем остаток группы, потом удаляем: при сбое удаления группа
      // останется целой, а не развалится на части.
      if (insertPairs.length > 0) {
        const { error: insError } = await db.from('counterparty_relations').insert(insertPairs)
        if (insError && insError.code !== '23505') throw insError
      }
      if (deleteIds.length > 0) {
        const { error } = await db.from('counterparty_relations').delete().in('id', deleteIds)
        if (error) throw error
      }
      await fetchRelations()
    } catch (error) {
      console.error('Ошибка удаления связи:', error.message)
      alert('Не удалось удалить связь: ' + error.message)
    }
  }

  // ── Журнал изменений (миграция 20260829) ──────────────────────────────────
  // Сбой записи в журнал не должен ломать саму правку: сохранение уже прошло,
  // и откатывать его из-за истории неправильно. Поэтому только console.
  const logCpEvent = async (counterpartyId, eventType, payload = {}) => {
    if (!counterpartyId || !eventType) return
    try {
      const { error } = await db.from('counterparty_audit_log').insert([{
        counterparty_id: counterpartyId,
        event_type: eventType,
        field_name: payload.fieldName || null,
        old_value: payload.oldValue ?? null,
        new_value: payload.newValue ?? null,
        description: payload.description || null,
        changed_by_role: localStorage.getItem('userRole') || null,
        changed_by_name: userProfile?.full_name || null,
      }])
      if (error) console.error('Не удалось записать историю контрагента:', error.message)
      // Лента «Изменения» уже открывалась — перечитается при следующем открытии, а не покажет
      // прежний снимок без этой правки.
      else setAuditMap(prev => {
        if (!(counterpartyId in prev)) return prev
        const next = { ...prev }
        delete next[counterpartyId]
        return next
      })
    } catch (err) {
      console.error('Ошибка записи истории контрагента:', err?.message || err)
    }
  }

  const logCpFieldChange = (counterpartyId, field, before, after) => logCpEvent(
    counterpartyId,
    field === 'status' ? 'status_changed' : 'field_updated',
    {
      fieldName: field,
      oldValue: before ?? null,
      newValue: after ?? null,
      description: `${CP_FIELD_LABEL[field] || field}: ${cpValueText(field, before)} → ${cpValueText(field, after)}`,
    },
  )

  const handleCounterpartySubmit = async (e) => {
    e.preventDefault()
    // Защита от двойной отправки. Состояние — для вида кнопки, ref — для самой
    // защиты: два быстрых клика попадают в один рендер, и оба обработчика
    // увидели бы saving === false. Флаг снимаем в finally, иначе после ошибки
    // форма осталась бы заблокированной навсегда.
    if (cpSavingRef.current) return

    // Дубль по названию ловим до вставки: UNIQUE на counterparties.name нет, а
    // на медленной сети инженер успевает нажать «Добавить» дважды — так в реестре
    // и появлялись две одинаковые компании.
    if (!editingCounterparty) {
      const typedName = (counterpartyFormData.name || '').trim()
      const sameName = counterparties.find(
        cp => (cp.name || '').trim().toLowerCase() === typedName.toLowerCase()
      )
      if (sameName) {
        alert(`Контрагент «${sameName.name}» уже есть в реестре${sameName.inn ? ` (ИНН ${sameName.inn})` : ''}. Повторно добавлять не нужно.`)
        return
      }
      const typedInn = (counterpartyFormData.inn || '').trim()
      if (typedInn) {
        const sameInn = counterparties.find(cp => (cp.inn || '').trim() === typedInn)
        if (sameInn && !window.confirm(
          `ИНН ${typedInn} уже указан у контрагента «${sameInn.name}». Всё равно добавить новую запись?`
        )) return
      }
    }

    cpSavingRef.current = true
    setCpSaving(true)
    try {
      let counterpartyId

      // Объединяем виды работ в строку
      const dataToSave = {
        ...counterpartyFormData,
        work_type: workTypes.join(', ')
      }

      // Запоминаем ID старых контактов ДО любых изменений в БД,
      // чтобы потом удалить их строго по id (а не по counterparty_id) —
      // так мы не теряем данные при сбое вставки.
      const oldContactIds = editingCounterparty
        ? (editingCounterparty.counterparty_contacts || []).map(c => c.id).filter(Boolean)
        : []

      if (editingCounterparty) {
        // Обновление существующего контрагента
        const { error } = await db
          .from('counterparties')
          .update(dataToSave)
          .eq('id', editingCounterparty.id)

        if (error) throw error
        counterpartyId = editingCounterparty.id
      } else {
        // Создание нового контрагента
        const { data, error } = await db
          .from('counterparties')
          .insert([dataToSave])
          .select()

        if (error) throw error
        counterpartyId = data[0].id
      }

      // Шаг 1: вставляем новые контакты с клиентскими UUID.
      // Это страхует от ситуации, когда DEFAULT gen_random_uuid() в прод-БД
      // не срабатывает (и Postgres ругается "null value in column id").
      if (tempContacts.length > 0) {
        const contactsToInsert = tempContacts.map((contact) => ({
          id: generateUUID(),
          full_name: contact.full_name,
          position: contact.position || '',
          phone: contact.phone || '',
          email: contact.email || '',
          counterparty_id: counterpartyId
        }))

        const { error: contactsError } = await db
          .from('counterparty_contacts')
          .insert(contactsToInsert)

        if (contactsError) throw contactsError
      }

      // Шаг 2: только теперь удаляем старые контакты — по их собственным id,
      // не по counterparty_id. Если этот шаг упадёт, у пользователя останутся
      // и старые, и новые контакты (можно подчистить вручную), но данные точно
      // не потеряются. Раньше же удаление шло первым, и при ошибке вставки
      // все контакты исчезали.
      if (oldContactIds.length > 0) {
        const { error: deleteError } = await db
          .from('counterparty_contacts')
          .delete()
          .in('id', oldContactIds)

        if (deleteError) {
          console.error('Не удалось удалить старые контакты (новые сохранены):', deleteError)
        }
      }

      // ── История ────────────────────────────────────────────────────────────
      if (editingCounterparty) {
        // Поля карточки: по записи на каждое реально изменившееся.
        const auditWrites = []
        for (const field of Object.keys(CP_FIELD_LABEL)) {
          const before = editingCounterparty[field] ?? null
          const after = dataToSave[field] ?? null
          if ((before || null) === (after || null)) continue
          auditWrites.push(logCpFieldChange(counterpartyId, field, before, after))
        }
        // Контакты: сравниваем наборы по содержимому. Прямое логирование
        // insert/delete давало бы «удалён»+«добавлен» на каждый контакт при
        // любом сохранении формы, даже когда их никто не трогал.
        const oldContacts = editingCounterparty.counterparty_contacts || []
        const oldKeys = new Set(oldContacts.map(contactKey))
        const newKeys = new Set(tempContacts.map(contactKey))
        for (const c of tempContacts) {
          if (oldKeys.has(contactKey(c))) continue
          auditWrites.push(logCpEvent(counterpartyId, 'contact_added', {
            fieldName: 'contact',
            newValue: contactText(c),
            description: `Добавлено контактное лицо: ${contactText(c)}`,
          }))
        }
        for (const c of oldContacts) {
          if (newKeys.has(contactKey(c))) continue
          auditWrites.push(logCpEvent(counterpartyId, 'contact_removed', {
            fieldName: 'contact',
            oldValue: contactText(c),
            description: `Удалено контактное лицо: ${contactText(c)}`,
          }))
        }
        await Promise.all(auditWrites)
      } else {
        await logCpEvent(counterpartyId, 'created', {
          description: `Контрагент создан: ${dataToSave.name || 'без названия'}`,
        })
      }

      setShowCounterpartyModal(false)
      setEditingCounterparty(null)
      setCounterpartyFormData(EMPTY_CP_FORM)
      setTempContacts([])
      fetchCounterparties()
    } catch (error) {
      console.error('Ошибка сохранения контрагента:', error.message)
      // 23505 — нарушение уникальности: значит запись уже создана (в том числе
      // первым из двух кликов), и вторая попытка не нужна.
      alert(error.code === '23505'
        ? 'Такой контрагент уже есть в реестре.'
        : 'Ошибка: ' + error.message)
    } finally {
      cpSavingRef.current = false
      setCpSaving(false)
    }
  }

  const handleContactSubmit = async (e) => {
    e.preventDefault()
    try {
      const contactData = {
        ...contactFormData,
        counterparty_id: selectedCounterparty.id
      }

      if (editingContact) {
        const { error } = await db
          .from('counterparty_contacts')
          .update(contactFormData)
          .eq('id', editingContact.id)

        if (error) throw error
      } else {
        const { error } = await db
          .from('counterparty_contacts')
          .insert([contactData])
        if (error) throw error
      }

      await logCpEvent(
        selectedCounterparty.id,
        editingContact ? 'contact_updated' : 'contact_added',
        {
          fieldName: 'contact',
          oldValue: editingContact ? contactText(editingContact) : null,
          newValue: contactText(contactFormData),
          description: editingContact
            ? `Контактное лицо: ${contactText(editingContact)} → ${contactText(contactFormData)}`
            : `Добавлено контактное лицо: ${contactText(contactFormData)}`,
        },
      )

      setShowContactModal(false)
      setEditingContact(null)
      setContactFormData(EMPTY_CONTACT_FORM)
      fetchCounterparties()
    } catch (error) {
      console.error('Ошибка сохранения контакта:', error.message)
      alert('Ошибка: ' + error.message)
    }
  }

  const handleEditCounterparty = (counterparty) => {
    setEditingCounterparty(counterparty)
    setCounterpartyFormData({
      name: counterparty.name,
      work_type: counterparty.work_type || '',
      department: counterparty.department || '',
      inn: counterparty.inn || '',
      kpp: counterparty.kpp || '',
      legal_address: counterparty.legal_address || '',
      actual_address: counterparty.actual_address || '',
      website: counterparty.website || '',
      status: counterparty.status || 'active',
      notes: counterparty.notes || '',
    })
    setWorkTypes(splitWorkTypes(counterparty.work_type))
    setWtSearch('')
    setWtDropdownOpen(false)
    // Загружаем существующие контакты в tempContacts
    setTempContacts(counterparty.counterparty_contacts || [])
    setShowCounterpartyModal(true)
  }

  // Функции для работы с временными контактами в форме контрагента
  const handleAddTempContact = () => {
    if (!contactFormData.full_name.trim()) {
      alert('Введите ФИО контакта')
      return
    }

    if (editingTempContactIndex !== null) {
      // Редактирование существующего временного контакта
      const updatedContacts = [...tempContacts]
      updatedContacts[editingTempContactIndex] = { ...contactFormData }
      setTempContacts(updatedContacts)
      setEditingTempContactIndex(null)
    } else {
      // Добавление нового временного контакта
      setTempContacts([...tempContacts, { ...contactFormData }])
    }

    // Очищаем форму контакта
    setContactFormData(EMPTY_CONTACT_FORM)
  }

  const handleEditTempContact = (index) => {
    setContactFormData({ ...tempContacts[index] })
    setEditingTempContactIndex(index)
  }

  const handleDeleteTempContact = (index) => {
    setTempContacts(tempContacts.filter((_, i) => i !== index))
    if (editingTempContactIndex === index) {
      setEditingTempContactIndex(null)
      setContactFormData(EMPTY_CONTACT_FORM)
    }
  }

  const handleCancelEditTempContact = () => {
    setEditingTempContactIndex(null)
    setContactFormData(EMPTY_CONTACT_FORM)
  }

  const handleAddContact = (counterparty) => {
    // Сохраняем только id и name, чтобы исключить циклические ссылки в state
    // (counterparty приходит с counterparty_contacts; на компьютерах с менее устойчивыми
    // версиями браузера/Supabase глубокий объект иногда вызывает stack overflow при сериализации).
    setSelectedCounterparty({ id: counterparty.id, name: counterparty.name })
    setEditingContact(null)
    setContactFormData(EMPTY_CONTACT_FORM)
    setShowContactModal(true)
  }


  // task 197: soft delete — переносит в «Удалённые»
  const handleDeleteCounterparty = async (id, name) => {
    if (window.confirm(`Перенести контрагента «${name}» в «Удалённые»? Его можно будет восстановить.`)) {
      try {
        const { error } = await db
          .from('counterparties')
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', id)
        if (error) throw error
        await logCpEvent(id, 'soft_deleted', { description: 'Перенесён в «Удалённые»' })
        fetchCounterparties()
      } catch (error) {
        console.error('Ошибка удаления контрагента:', error.message)
        alert('Ошибка: ' + error.message)
      }
    }
  }

  // task 197: восстановить из «Удалённых»
  const handleRestoreCounterparty = async (id) => {
    try {
      const { error } = await db
        .from('counterparties')
        .update({ deleted_at: null })
        .eq('id', id)
      if (error) throw error
      await logCpEvent(id, 'restored', { description: 'Восстановлен из «Удалённых»' })
      fetchCounterparties()
    } catch (error) {
      console.error('Ошибка восстановления контрагента:', error.message)
      alert('Ошибка: ' + error.message)
    }
  }

  // К организации привязаны логины подрядчиков: база не даёт её удалить
  // (миграция 20261006, ON DELETE RESTRICT), иначе логины стали бы сотрудниками.
  const hardDeleteErrorText = (error) =>
    error?.code === '23503' && /user_roles/.test(error?.message || '')
      ? 'К организации привязаны логины подрядчиков. Сначала отвяжите или удалите их в «Администрировании», затем удаляйте контрагента.'
      : error?.message

  // task 197: безвозвратное удаление — только для администратора
  const handleHardDeleteCounterparty = async (id, name) => {
    if (!isAdmin) {
      alert('Безвозвратное удаление доступно только администратору.')
      return
    }
    if (!window.confirm(`Безвозвратно удалить контрагента «${name}»? Это действие нельзя отменить.`)) return
    try {
      const { error } = await db.from('counterparties').delete().eq('id', id)
      if (error) throw error
      fetchCounterparties()
    } catch (error) {
      console.error('Ошибка безвозвратного удаления:', error.message)
      alert('Ошибка: ' + hardDeleteErrorText(error))
    }
  }

  // Функции для массового выбора и удаления
  const handleSelectCounterparty = (id) => {
    setSelectedCounterpartyIds(prev => {
      if (prev.includes(id)) {
        return prev.filter(selectedId => selectedId !== id)
      } else {
        return [...prev, id]
      }
    })
  }

  // Только видимые строки (вкладка, фильтр, поиск). Раньше выбирался весь загруженный список — и
  // «В корзину» на вкладке «Активные» уносило заодно чёрный список, а «Удалить безвозвратно» на
  // «Удалённых» — действующих контрагентов.
  const handleSelectAll = () => {
    setSelectedCounterpartyIds(allVisibleSelected ? [] : filteredCounterparties.map(cp => cp.id))
  }

  const handleBulkDelete = async () => {
    if (selectedCounterpartyIds.length === 0) {
      alert('Выберите контрагентов для удаления')
      return
    }

    const isHardDelete = activeTab === 'deleted'
    if (isHardDelete && !isAdmin) {
      alert('Безвозвратное удаление доступно только администратору.')
      return
    }

    const verb = isHardDelete ? 'безвозвратно удалить' : 'перенести в «Удалённые»'
    const confirmed = window.confirm(
      `Вы уверены, что хотите ${verb} ${selectedCounterpartyIds.length} ${
        selectedCounterpartyIds.length === 1 ? 'контрагента' :
        selectedCounterpartyIds.length < 5 ? 'контрагента' : 'контрагентов'
      }?`
    )

    if (!confirmed) return

    try {
      const query = isHardDelete
        ? db.from('counterparties').delete().in('id', selectedCounterpartyIds)
        : db.from('counterparties').update({ deleted_at: new Date().toISOString() }).in('id', selectedCounterpartyIds)
      const { error } = await query
      if (error) throw error

      // Безвозвратное удаление не логируем — записи уходят каскадом вместе с
      // контрагентом, писать их некуда.
      if (!isHardDelete) {
        await Promise.all(selectedCounterpartyIds.map(id =>
          logCpEvent(id, 'soft_deleted', { description: 'Перенесён в «Удалённые» (массовая операция)' })
        ))
      }

      setSelectedCounterpartyIds([])
      fetchCounterparties()
      alert(`${isHardDelete ? 'Безвозвратно удалено' : 'Перемещено в «Удалённые»'}: ${selectedCounterpartyIds.length}`)
    } catch (error) {
      console.error('Ошибка массового удаления:', error.message)
      alert('Ошибка удаления: ' + hardDeleteErrorText(error))
    }
  }

  // Функция для обновления статуса контрагента
  const handleStatusChange = async (counterpartyId, newStatus) => {
    const prevStatus = counterpartyById.get(counterpartyId)?.status ?? null
    try {
      const { error } = await db
        .from('counterparties')
        .update({ status: newStatus })
        .eq('id', counterpartyId)

      if (error) throw error

      // Обновляем локальное состояние
      setCounterparties(prev =>
        prev.map(cp =>
          cp.id === counterpartyId ? { ...cp, status: newStatus } : cp
        )
      )
      if ((prevStatus || null) !== (newStatus || null)) {
        await logCpFieldChange(counterpartyId, 'status', prevStatus, newStatus)
      }
    } catch (error) {
      console.error('Ошибка обновления статуса:', error.message)
      alert('Ошибка обновления статуса: ' + error.message)
    }
  }

  // Примечание — во вкладке «Общая информация» карточки (из таблицы реестра колонка убрана),
  // сохранение по blur.
  const handleNotesChange = async (counterpartyId, rawNotes) => {
    const notes = rawNotes.trim() || null
    const prevNotes = counterpartyById.get(counterpartyId)?.notes ?? null
    // Сохранение идёт по blur — без этой проверки простой уход из поля писал бы
    // в историю пустую правку.
    if ((prevNotes || '') === (notes || '')) return
    try {
      const { error } = await db
        .from('counterparties')
        .update({ notes })
        .eq('id', counterpartyId)
      if (error) throw error
      setCounterparties(prev =>
        prev.map(cp => (cp.id === counterpartyId ? { ...cp, notes } : cp))
      )
      await logCpFieldChange(counterpartyId, 'notes', prevNotes, notes)
    } catch (error) {
      console.error('Ошибка обновления примечания:', error.message)
      alert('Ошибка обновления примечания: ' + error.message)
    }
  }

  // НДС контрагента — во вкладке «Общая информация» (миграция 20261026). В CP_FIELD_LABEL его нет
  // намеренно: форма редактирования НДС не отправляет, и сравнение полей формы писало бы ложную правку.
  const handleVatChange = async (counterpartyId, selectValue) => {
    const prev = counterpartyById.get(counterpartyId)
    const next = vatFromSelect(selectValue)
    if (!prev) return
    const prevRate = prev.vat_rate == null ? null : Number(prev.vat_rate)
    if (prevRate === next.vat_rate && !!prev.vat_exempt === next.vat_exempt) return
    try {
      const { error } = await db
        .from('counterparties')
        .update(next)
        .eq('id', counterpartyId)
      if (error) throw error
      setCounterparties(list =>
        list.map(cp => (cp.id === counterpartyId ? { ...cp, ...next } : cp))
      )
      const before = vatText(prev)
      const after = vatText(next)
      await logCpEvent(counterpartyId, 'field_updated', {
        fieldName: 'vat',
        oldValue: before,
        newValue: after,
        description: `НДС: ${before} → ${after}`,
      })
    } catch (error) {
      console.error('Ошибка обновления НДС:', error.message)
      alert(['42703', 'PGRST204'].includes(error.code) || /vat_/.test(error.message || '')
        ? 'НДС пока нельзя сохранить: база ещё не обновлена (миграция 20261026).'
        : 'Ошибка обновления НДС: ' + error.message)
    }
  }

  // Договор прикреплён к контрагенту вручную или откреплён (раздел «Договоры и ДС» карточки пишет сам) — в журнал.
  const handleContractLinkChange = (counterpartyId, eventType, doc) => {
    const t = docTitle(doc)
    const label = `${t.num}${t.date ? ` от ${t.date}` : ''}`
    logCpEvent(counterpartyId, eventType, {
      fieldName: 'contract',
      oldValue: eventType === 'contract_unlinked' ? label : null,
      newValue: eventType === 'contract_linked' ? label : null,
      description: `${CP_EVENT_LABEL[eventType]} ${label}`,
    })
  }

  const handleAddNewCounterparty = () => {
    setEditingCounterparty(null)
    setCounterpartyFormData(EMPTY_CP_FORM)
    setWorkTypes([])
    setWtSearch('')
    setWtDropdownOpen(false)
    setTempContacts([])
    setContactFormData(EMPTY_CONTACT_FORM)
    setEditingTempContactIndex(null)
    setShowCounterpartyModal(true)
  }

  const handleImportClick = () => {
    setShowImportInstructionsModal(true)
  }

  const handleExportToExcel = () => {
    // Выгружаем ровно то, что видит пользователь: учтены вкладка (активные /
    // чёрный список / удалённые), фильтр по виду работ и строка поиска.
    // Раньше здесь стоял counterparties — весь загруженный список, и файл
    // приезжал полным независимо от фильтров.
    const exportList = filteredCounterparties
    if (exportList.length === 0) {
      alert('Нет данных для экспорта: под текущие фильтры и поиск ничего не подходит')
      return
    }

    const headers = [
      '№ п/п',
      'Наименование организации',
      'Категория работ',
      'Вид работ',
      'ИНН',
      'КПП',
      'Юридический адрес',
      'Фактический адрес',
      'Ссылка на сайт',
      'Статус',
      'НДС',
      'Примечание',
      'ФИО контакта',
      'Должность контакта',
      'Телефон контакта',
      'Email контакта'
    ]

    // Без колонок НДС (миграция 20261026) — пустая ячейка, а не «не указан».
    const vatLabel = (cp) => (cp.vat_exempt || cp.vat_rate != null ? vatText(cp) : '')

    const statusLabel = (status) => {
      if (status === 'blacklist') return 'Черный список'
      if (status === 'active') return 'Активный'
      return status || ''
    }

    // Порядок берём как есть: filteredCounterparties уже отсортирован так же —
    // активные сверху, чёрный список снизу, внутри по имени.
    const rows = []
    exportList.forEach((cp, idx) => {
      const baseRow = [
        idx + 1,
        cp.name || '',
        cp.department || '',
        cp.work_type || '',
        cp.inn || '',
        cp.kpp || '',
        cp.legal_address || '',
        cp.actual_address || '',
        cp.website || '',
        statusLabel(cp.status),
        vatLabel(cp),
        cp.notes || '',
      ]
      // Для второго и последующих контактов основные поля пустые — строки с контактами
      // одной организации визуально группируются.
      const blankRow = baseRow.map(() => '')
      const contacts = cp.counterparty_contacts || []
      if (contacts.length === 0) rows.push([...baseRow, '', '', '', ''])
      contacts.forEach((contact, ci) => rows.push([
        ...(ci === 0 ? baseRow : blankRow),
        contact.full_name || '',
        contact.position || '',
        contact.phone ? formatPhone(contact.phone) : '',
        contact.email || '',
      ]))
    })

    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])

    // Ширина колонок для удобного чтения
    ws['!cols'] = [
      { wch: 6 },   // №
      { wch: 35 },  // Наименование
      { wch: 22 },  // Категория
      { wch: 30 },  // Виды работ
      { wch: 14 },  // ИНН
      { wch: 12 },  // КПП
      { wch: 38 },  // Юр. адрес
      { wch: 38 },  // Факт. адрес
      { wch: 24 },  // Сайт
      { wch: 14 },  // Статус
      { wch: 10 },  // НДС
      { wch: 28 },  // Примечание
      { wch: 28 },  // ФИО
      { wch: 22 },  // Должность
      { wch: 18 },  // Телефон
      { wch: 26 },  // Email
    ]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Контрагенты')

    // Имя файла отражает выборку: иначе несколько выгрузок с разными фильтрами
    // невозможно различить в папке «Загрузки».
    const today = new Date().toISOString().slice(0, 10)
    const tabPart = activeTab === 'blacklist' ? 'Черный список'
      : activeTab === 'deleted' ? 'Удаленные'
        : ''
    // Вид работ попадает в имя файла — чистим символы, недопустимые в имени.
    const workTypePart = workTypeFilter ? workTypeFilter.replace(/[\\/:*?"<>|]/g, '-').slice(0, 40) : ''
    const searchPart = deferredSearchQuery.trim() ? 'поиск' : ''
    const parts = ['Контрагенты', tabPart, workTypePart, searchPart, today].filter(Boolean)
    XLSX.writeFile(wb, `${parts.join('_')}.xlsx`)
  }

  const handleProceedWithImport = () => {
    setShowImportInstructionsModal(false)
    fileInputRef.current?.click()
  }

  const handleDownloadTemplate = () => {
    const headers = IMPORT_COLUMNS.map(c => c.name)
    const exampleRows = [
      ['ООО "Стройком"', 'Основное строительство', 'Строительно-монтажные работы', '7728123456', '772801001', 'г. Москва, ул. Ленина, д. 1', 'г. Москва, ул. Ленина, д. 1', 'https://stroykom.ru', 'Действующий', '', 'Иванов Иван Иванович', 'Директор', '+7(999)123-45-67', 'ivanov@stroykom.ru'],
      ['ООО "Стройком"', '', '', '7728123456', '772801001', '', '', '', '', '', 'Сидоров Сергей Петрович', 'Главный инженер', '+7(999)765-43-21', 'sidorov@stroykom.ru'],
      ['ЗАО "Ремонт+"', 'Основное строительство, Гарантийный отдел', 'Отделочные работы', '7729654321', '', 'г. Москва, ул. Мира, д. 5', '', '', 'Действующий', 'Надёжный подрядчик', 'Петров Пётр Петрович', 'Менеджер', '+7(999)111-22-33', 'petrov@remont.ru'],
    ]

    const ws = XLSX.utils.aoa_to_sheet([headers, ...exampleRows])

    // Ширина столбцов
    ws['!cols'] = [
      { wch: 30 }, { wch: 35 }, { wch: 30 }, { wch: 14 }, { wch: 12 },
      { wch: 35 }, { wch: 35 }, { wch: 25 }, { wch: 15 },
      { wch: 25 }, { wch: 28 }, { wch: 22 }, { wch: 22 }, { wch: 25 }
    ]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Контрагенты')
    XLSX.writeFile(wb, 'Шаблон_импорта_контрагентов.xlsx')
  }

  const handleFileImport = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    setImporting(true)

    try {
      const workbook = XLSX.read(await file.arrayBuffer())
      const worksheet = workbook.Sheets[workbook.SheetNames[0]]
      const jsonData = XLSX.utils.sheet_to_json(worksheet)
      // Шапка и начало листа — один раз: гиперссылка сайта читается из ячейки по номеру колонки.
      const headers = XLSX.utils.sheet_to_json(worksheet, { header: 1 })[0] || []
      const origin = XLSX.utils.decode_range(worksheet['!ref'] || 'A1').s

      // Ячейка «Ссылка на сайт» бывает гиперссылкой с подписью — берём адрес, а не подпись.
      // __rowNum__ — номер строки листа (пустые строки sheet_to_json пропускает).
      const getHyperlinkFromCell = (row, columnName) => {
        const colIndex = headers.indexOf(columnName)
        if (colIndex === -1) return null
        const cell = worksheet[XLSX.utils.encode_cell({ r: row.__rowNum__, c: origin.c + colIndex })]
        return cell?.l?.Target || null
      }

      // Колонки контакта — с учётом возможных вариантов написания.
      const getColumnValue = (row, possibleNames) => {
        for (const name of possibleNames) {
          const key = Object.keys(row).find(k => k.trim().toLowerCase() === name.toLowerCase())
          if (key && row[key]) return String(row[key]).trim()
        }
        return null
      }
      const text = (value) => (value ? String(value).trim() : null)

      const errors = []
      // Группируем строки по контрагентам (имя + ИНН): несколько строк — несколько контактов.
      const counterpartiesMap = new Map()

      jsonData.forEach((row, index) => {
        const rowNumber = (row.__rowNum__ ?? index + 1) + 1

        if (!row['Наименование организации']) {
          errors.push(`Строка ${rowNumber}: отсутствует обязательное поле "Наименование организации"`)
          return
        }

        const counterpartyName = String(row['Наименование организации']).trim()
        const counterpartyInn = row['ИНН'] ? String(row['ИНН']).trim() : ''
        const counterpartyKey = `${counterpartyName}_${counterpartyInn}`

        if (!counterpartiesMap.has(counterpartyKey)) {
          // Название колонки сайта — с учётом пробелов по краям.
          const websiteColumnName = Object.keys(row).find(key => key.trim() === 'Ссылка на сайт') || 'Ссылка на сайт'
          counterpartiesMap.set(counterpartyKey, {
            name: counterpartyName,
            department: text(row['Категория работ']),
            work_type: text(row['Вид работ']),
            inn: counterpartyInn || null,
            kpp: text(row['КПП']),
            legal_address: text(row['Юридический адрес']),
            actual_address: text(row['Фактический адрес']),
            website: getHyperlinkFromCell(row, websiteColumnName) || text(row[websiteColumnName]),
            status: row['Статус'] === 'Черный список' ? 'blacklist' : 'active',
            notes: text(row['Примечание']),
            contacts: [],
          })
        }

        const contactFullName = getColumnValue(row, ['ФИО контакта', 'ФИО', 'Контактное лицо'])
        if (contactFullName) {
          counterpartiesMap.get(counterpartyKey).contacts.push({
            full_name: contactFullName,
            position: getColumnValue(row, ['Должность контакта', 'Должность']),
            phone: getColumnValue(row, ['Телефон контакта', 'Телефон', 'Тел.']),
            email: getColumnValue(row, ['Email контакта', 'E-mail контакта', 'Email', 'E-mail', 'Электронная почта', 'Почта']),
          })
        }
      })

      const counterpartiesToInsert = Array.from(counterpartiesMap.values())

      if (counterpartiesToInsert.length === 0) {
        setImportResult({ success: [], contacts: 0, errors: [...errors, 'Не найдено корректных данных для импорта'], totalParsed: jsonData.length })
        return
      }

      // Вставляем контрагентов по одному, чтобы отловить ошибки поштучно
      const successList = []
      const failList = [...errors]
      let contactsInserted = 0

      for (const { contacts, ...cpData } of counterpartiesToInsert) {
        try {
          const { data: inserted, error: cpError } = await db
            .from('counterparties')
            .insert([cpData])
            .select('id, name')
          if (cpError) throw cpError
          successList.push(inserted[0].name)

          if (contacts.length > 0) {
            const { error: contactsErr } = await db
              .from('counterparty_contacts')
              .insert(contacts.map(c => ({ ...c, counterparty_id: inserted[0].id })))
            if (contactsErr) failList.push(`${cpData.name}: контакты не загружены — ${contactsErr.message}`)
            else contactsInserted += contacts.length
          }
        } catch (err) {
          failList.push(`${cpData.name}: ${err.message}`)
        }
      }

      setImportResult({
        success: successList,
        contacts: contactsInserted,
        errors: failList,
        totalParsed: counterpartiesToInsert.length
      })

      fetchCounterparties()
    } catch (error) {
      console.error('Ошибка импорта:', error)
      setImportResult({
        success: [],
        contacts: 0,
        errors: [`Критическая ошибка: ${error.message}`],
        totalParsed: 0
      })
    } finally {
      // Тот же файл можно выбрать повторно (иначе onChange не сработает).
      event.target.value = ''
      setImporting(false)
    }
  }

  // Уникальные виды работ (для фильтра) и сколько действующих контрагентов у каждого (справочник).
  const { uniqueWorkTypes, workTypeUsage } = useMemo(() => {
    const all = new Set()
    const usage = new Map()
    for (const c of counterparties) {
      for (const wt of splitWorkTypes(c.work_type)) {
        all.add(wt)
        if (!c.deleted_at) usage.set(wt, (usage.get(wt) || 0) + 1)
      }
    }
    return { uniqueWorkTypes: [...all].sort(ruCollator.compare), workTypeUsage: usage }
  }, [counterparties])

  // Текст поиска по каждому контрагенту (поля карточки и контакты) — один раз на загрузку списка, а не
  // на каждую букву поиска. Поля разделены переводом строки: совпадение не склеивается из двух полей.
  const searchTextById = useMemo(() => {
    const map = new Map()
    for (const c of counterparties) {
      const parts = [c.name, c.work_type, c.inn, c.kpp, c.legal_address, c.actual_address, c.website, c.notes]
      for (const ct of c.counterparty_contacts || []) parts.push(ct.full_name, ct.position, ct.phone, ct.email)
      map.set(c.id, parts.filter(Boolean).join('\n').toLowerCase())
    }
    return map
  }, [counterparties])

  // Фильтрация контрагентов (мемоизация)
  const filteredCounterparties = useMemo(() => {
    // task 339: фильтрация по deferred-значению — отвязана от ввода в input
    const query = deferredSearchQuery.trim() ? deferredSearchQuery.toLowerCase() : ''
    return counterparties.filter(counterparty => {
      // task 197 + 201: фильтр по активной вкладке (активные / чёрный список / удалённые)
      if (activeTab === 'deleted') {
        if (!counterparty.deleted_at) return false
      } else if (counterparty.deleted_at || (counterparty.status === 'blacklist') !== (activeTab === 'blacklist')) {
        return false
      }
      // Фильтр по виду работ (проверяем каждый вид отдельно)
      if (workTypeFilter && !splitWorkTypes(counterparty.work_type).includes(workTypeFilter)) return false
      return !query || searchTextById.get(counterparty.id).includes(query)
    }).sort((a, b) => {
      // Сортировка: активные сверху, черный список снизу, внутри — по имени
      if ((a.status === 'blacklist') !== (b.status === 'blacklist')) return a.status === 'blacklist' ? 1 : -1
      return ruCollator.compare(a.name || '', b.name || '')
    })
  }, [counterparties, searchTextById, workTypeFilter, deferredSearchQuery, activeTab])

  const selectedSet = useMemo(() => new Set(selectedCounterpartyIds), [selectedCounterpartyIds])
  const allVisibleSelected = filteredCounterparties.length > 0 && filteredCounterparties.every(cp => selectedSet.has(cp.id))

  // При смене вкладки/фильтра/поиска показываем список с начала (лёгкий первый экран).
  useEffect(() => {
    setVisibleCount(RENDER_STEP)
  }, [activeTab, workTypeFilter, deferredSearchQuery])

  const tabCounts = useMemo(() => {
    const counts = { active: 0, blacklist: 0, deleted: 0 }
    for (const c of counterparties) counts[c.deleted_at ? 'deleted' : c.status === 'blacklist' ? 'blacklist' : 'active'] += 1
    return counts
  }, [counterparties])

  // task 196: подгружаем историю участия в тендерах (lazy)
  const fetchTenderHistory = async (counterpartyId) => {
    if (tenderHistoryMap[counterpartyId]) return // уже загружено
    setTenderHistoryLoadingId(counterpartyId)
    try {
      const { data, error } = await db
        .from('tender_counterparties')
        .select('status, tenders(id, work_description, tender_start_date, tender_end_date, objects(name))')
        .eq('counterparty_id', counterpartyId)
      if (error) throw error
      const list = (data || [])
        .filter(r => r.tenders)
        .map(r => ({
          tender_id: r.tenders.id,
          status: r.status,
          work_description: r.tenders.work_description,
          tender_start_date: r.tenders.tender_start_date,
          tender_end_date: r.tenders.tender_end_date,
          object_name: r.tenders.objects?.name || '—',
        }))
        // свежие тендеры сверху
        .sort((a, b) => (b.tender_start_date || '').localeCompare(a.tender_start_date || ''))
      setTenderHistoryMap(prev => ({ ...prev, [counterpartyId]: list }))
    } catch (err) {
      console.error('Ошибка загрузки истории тендеров:', err.message)
      setTenderHistoryMap(prev => ({ ...prev, [counterpartyId]: [] }))
    } finally {
      setTenderHistoryLoadingId(null)
    }
  }

  // Журнал правок контрагента — ленивая загрузка при первом открытии вкладки.
  // Постранично: у активного контрагента лента легко перевалит за 1000 записей
  // (потолок PostgREST). Тай-брейк по id — changed_at не уникален.
  const fetchCpAudit = async (counterpartyId) => {
    if (auditMap[counterpartyId]) return
    setAuditLoadingId(counterpartyId)
    try {
      const rows = await fetchAllRows((from, to) => db
        .from('counterparty_audit_log')
        .select('*')
        .eq('counterparty_id', counterpartyId)
        .order('changed_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to))
      setAuditMap(prev => ({ ...prev, [counterpartyId]: rows }))
    } catch (err) {
      console.error('Ошибка загрузки истории изменений (миграция 20260829?):', err.message)
      setAuditMap(prev => ({ ...prev, [counterpartyId]: [] }))
    } finally {
      setAuditLoadingId(null)
    }
  }

  // Клик по строке открывает detail-модалку контрагента — по умолчанию «Общая информация»;
  // значки документов СБ / должной осмотрительности открывают сразу «Документы».
  const openDetail = (counterparty, tab = 'general') => {
    setDetailCp(counterparty)
    setDetailTab(tab)
    fetchTenderHistory(counterparty.id) // ленивая загрузка истории (task 196)
  }

  // Колонки НДС появляются с миграцией 20261026; select('*') без них их просто не отдаёт.
  const vatSupported = counterparties.length === 0 || Object.prototype.hasOwnProperty.call(counterparties[0], 'vat_exempt')
  // Карточка открыта со снимком строки; правки (примечание, НДС) идут в список — показываем свежую.
  const detailCpLive = detailCp ? (counterpartyById.get(detailCp.id) || detailCp) : null

  return (
    <div className="counterparties-page">
      {/* Toolbar */}
      <div className="counterparties-toolbar">
        {/* task 321: тулбар с поиском/фильтром/импортом релевантен только для
            вкладок с контрагентами. На «Виды работ» прячем — там свой тулбар. */}
        {activeTab !== 'work_types' && (
          <div className="toolbar-row">
            <div className="toolbar-left">
              <h2 className="page-title">Контрагенты</h2>
              <span className="counter-badge">{filteredCounterparties.length}</span>
            </div>

            <div className="toolbar-center">
              <div className="search-container">
                <svg className="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                <input
                  type="text"
                  placeholder="Поиск..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>

              {/* task 323: поисковый dropdown по видам работ. Источник — uniqueWorkTypes
                  (значения, реально используемые в counterparties), чтобы фильтр не
                  предлагал заведомо «пустые» варианты. */}
              {(() => {
                const q = wtfSearch.trim().toLowerCase()
                const opts = !q
                  ? uniqueWorkTypes
                  : uniqueWorkTypes.filter(wt => wt.toLowerCase().includes(q))
                const displayValue = wtfOpen ? wtfSearch : workTypeFilter
                return (
                  <div className={`wt-filter-wrap ${workTypeFilter ? 'has-value' : ''}`}>
                    <input
                      type="text"
                      className={`wt-filter-input ${workTypeFilter ? 'active' : ''}`}
                      value={displayValue}
                      placeholder="Все виды работ"
                      onChange={(e) => { setWtfSearch(e.target.value); setWtfOpen(true) }}
                      onFocus={() => { setWtfSearch(''); setWtfOpen(true) }}
                      onBlur={() => setTimeout(() => setWtfOpen(false), 150)}
                    />
                    {workTypeFilter && !wtfOpen && (
                      <button
                        type="button"
                        className="wt-filter-clear"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { setWorkTypeFilter(''); setWtfSearch('') }}
                        title="Сбросить фильтр"
                      >×</button>
                    )}
                    {wtfOpen && (
                      <div className="wt-filter-dropdown">
                        <button
                          type="button"
                          className={`wt-filter-item ${!workTypeFilter ? 'is-current' : ''}`}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => { setWorkTypeFilter(''); setWtfSearch(''); setWtfOpen(false) }}
                        >Все виды работ</button>
                        {opts.length === 0 ? (
                          <div className="wt-filter-empty">
                            Ничего не найдено по запросу «{wtfSearch}»
                          </div>
                        ) : (
                          opts.map(wt => (
                            <button
                              key={wt}
                              type="button"
                              className={`wt-filter-item ${workTypeFilter === wt ? 'is-current' : ''}`}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => { setWorkTypeFilter(wt); setWtfSearch(''); setWtfOpen(false) }}
                            >{wt}</button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )
              })()}

            </div>

            <div className="toolbar-actions">
              {/* task 333: add/import только при can_edit. Export — admin-only. */}
              {canEditCp && (
                <>
                  <button className="btn-add" onClick={handleAddNewCounterparty}>+ Добавить</button>
                  <button className="btn-import" onClick={handleImportClick} disabled={importing}>
                    {importing ? '...' : 'Импорт'}
                  </button>
                </>
              )}
              {isAdmin && (
                <button
                  className="btn-import"
                  onClick={handleExportToExcel}
                  disabled={filteredCounterparties.length === 0}
                  title={`Скачать в Excel то, что сейчас в списке (${filteredCounterparties.length})`}
                >
                  📥 Экспорт
                </button>
              )}
            </div>
          </div>
        )}

        {activeTab !== 'work_types' && canEditCp && selectedCounterpartyIds.length > 0 && (
          <div className="toolbar-selection">
            <span>Выбрано: {selectedCounterpartyIds.length}</span>
            <button className="btn-link" onClick={handleSelectAll}>
              {allVisibleSelected ? 'Снять' : 'Выбрать все'}
            </button>
            <button className="btn-bulk-delete" onClick={handleBulkDelete}>
              {activeTab === 'deleted' ? 'Удалить безвозвратно' : 'В корзину'}
            </button>
          </div>
        )}

        {/* task 197 + 201: вкладки Активные / Чёрный список / Удалённые.
            task 343: switchTab оборачивает в startTransition — клик мгновенный,
            таблица перерисовывается в фоне. isTabPending → лёгкая полупрозрачность. */}
        <div className={`counterparties-tabs${isTabPending ? ' is-pending' : ''}`}>
          <button
            className={`cp-tab ${activeTab === 'active' ? 'active' : ''}`}
            onClick={() => switchTab('active')}
          >
            Активные
            <span className="cp-tab-count">{tabCounts.active}</span>
          </button>
          <button
            className={`cp-tab cp-tab-blacklist ${activeTab === 'blacklist' ? 'active' : ''}`}
            onClick={() => switchTab('blacklist')}
          >
            Чёрный список
            {tabCounts.blacklist > 0 && <span className="cp-tab-count">{tabCounts.blacklist}</span>}
          </button>
          <button
            className={`cp-tab cp-tab-deleted ${activeTab === 'deleted' ? 'active' : ''}`}
            onClick={() => switchTab('deleted')}
          >
            Удалённые
            {tabCounts.deleted > 0 && <span className="cp-tab-count">{tabCounts.deleted}</span>}
          </button>
          {/* task 321: справочник видов работ — отдельная вкладка */}
          <button
            className={`cp-tab cp-tab-worktypes ${activeTab === 'work_types' ? 'active' : ''}`}
            onClick={() => switchTab('work_types')}
          >
            Виды работ
            {workTypesDirectory.length > 0 && <span className="cp-tab-count">{workTypesDirectory.length}</span>}
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls"
        onChange={handleFileImport}
        style={{ display: 'none' }}
      />

      {/* Content */}
      {loading ? (
        <div className="loading-container">
          <div className="loading-spinner"></div>
        </div>
      ) : (
        /* task 343/344: рендерим обе панели всегда, переключаем через display.
           Это убирает дорогой unmount/mount всей таблицы (~500 строк) при
           переходе из «Видов работ» обратно в «Активные». */
        <>
        <div
          className="counterparties-content"
          style={{ display: activeTab === 'work_types' ? 'flex' : 'none' }}
        >
          <div className="work-types-directory">
            <div className="work-types-directory-toolbar">
              <h3 className="work-types-directory-title">Справочник видов работ</h3>
              {/* task 326: поиск по справочнику */}
              <div className="work-types-directory-search">
                <svg className="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                <input
                  type="text"
                  placeholder="Поиск по названию или описанию…"
                  value={wtDirSearch}
                  onChange={(e) => setWtDirSearch(e.target.value)}
                />
                {wtDirSearch && (
                  <button
                    type="button"
                    className="work-types-directory-search-clear"
                    onClick={() => setWtDirSearch('')}
                    title="Очистить"
                  >×</button>
                )}
              </div>
              {/* task 333: добавление/правка справочника — только при can_edit */}
              {canEditCp && (
                <button className="btn-add" onClick={handleOpenAddWorkType}>+ Добавить вид работ</button>
              )}
            </div>
            {workTypesDirectory.length === 0 ? (
              <div className="empty-state">
                <p className="empty-title">Справочник пуст</p>
                <p className="empty-hint">
                  {canEditCp
                    ? 'Добавьте первый вид работ — он станет доступен в карточке любого контрагента.'
                    : 'У вас нет прав на редактирование. Обратитесь к администратору.'}
                </p>
                {canEditCp && (
                  <button className="btn-add" onClick={handleOpenAddWorkType}>+ Добавить вид работ</button>
                )}
              </div>
            ) : (() => {
              const q = wtDirSearch.trim().toLowerCase()
              const filteredWt = !q
                ? workTypesDirectory
                : workTypesDirectory.filter(wt =>
                    (wt.name || '').toLowerCase().includes(q) ||
                    (wt.description || '').toLowerCase().includes(q)
                  )
              return (
              <div className="table-wrapper">
                <table className="compact-table work-types-table">
                  <thead>
                    <tr>
                      <th style={{ width: '52px', textAlign: 'center' }}>№</th>
                      <th>Название</th>
                      <th>Описание</th>
                      <th style={{ width: '140px', textAlign: 'right' }}>Контрагентов</th>
                      <th style={{ width: '90px' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredWt.length === 0 ? (
                      <tr>
                        <td colSpan="5" style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                          Ничего не найдено по запросу «{wtDirSearch}»
                        </td>
                      </tr>
                    ) : filteredWt.map((wt, idx) => {
                      const used = workTypeUsage.get(wt.name) || 0
                      return (
                        <tr key={wt.id}>
                          <td style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>{idx + 1}</td>
                          <td><strong>{wt.name}</strong></td>
                          <td style={{ color: 'var(--text-secondary)' }}>{wt.description || '—'}</td>
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{used}</td>
                          <td className="col-actions">
                            {canEditCp ? (
                              <div className="actions-group">
                                <button
                                  className="btn-action"
                                  onClick={() => handleOpenEditWorkType(wt)}
                                  title="Редактировать"
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                </button>
                                <button
                                  className="btn-action delete"
                                  onClick={() => handleDeleteWorkType(wt)}
                                  title="Удалить"
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                                </button>
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              )
            })()}
          </div>
        </div>

        <div
          className="counterparties-content"
          style={{ display: activeTab !== 'work_types' ? 'block' : 'none' }}
        >
          {filteredCounterparties.length === 0 ? (
            <div className="empty-state">
              <p className="empty-title">
                {searchQuery.trim() || workTypeFilter ? 'Ничего не найдено' : 'Нет контрагентов'}
              </p>
              {!searchQuery.trim() && !workTypeFilter && canEditCp && (
                <button className="btn-add" onClick={handleAddNewCounterparty}>+ Добавить</button>
              )}
            </div>
          ) : isPhone ? (
            /* Телефон: плотный список, как у тендеров — название, виды работ,
               ИНН и первый контакт; телефон контакта — ссылка «позвонить».
               Карточку открывает кнопка-название, растянутая на всю строку
               (::after); ссылка на звонок лежит поверх неё, а не внутри кнопки. */
            <>
            <ul className="cp-mlist">
              {filteredCounterparties.slice(0, visibleCount).map((cp) => {
                const c0 = (cp.counterparty_contacts || [])[0]
                const phone = (c0?.phone || '').split(';').map(p => p.trim()).find(Boolean)
                const isBl = cp.status === 'blacklist'
                return (
                  <li key={cp.id} className={`cp-mrow${isBl ? ' is-blacklist' : ''}`}>
                    <div className="cp-mrow-top">
                      <button type="button" className="cp-mrow-open" onClick={() => openDetail(cp)}>
                        {cp.name}
                      </button>
                      {isBl && <span className="cp-mrow-bl" title="Чёрный список">ЧС</span>}
                      <CounterpartyDocBadges summary={docSummaryByCp.get(cp.id)} />
                    </div>
                    {cp.work_type && <div className="cp-mrow-wt">{cp.work_type}</div>}
                    {(cp.inn || c0) && (
                      <div className="cp-mrow-meta">
                        {cp.inn && <span className="cp-mrow-inn">ИНН {cp.inn}</span>}
                        {c0?.full_name && <span className="cp-mrow-person" title={c0.full_name}>{shortPersonName(c0.full_name)}</span>}
                        {phone && (
                          <a href={`tel:${phone}`} className="cp-mrow-tel" aria-label={`Позвонить: ${phone}`}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                            {phone}
                          </a>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
            {visibleCount < filteredCounterparties.length && (
              <div className="cp-mlist-more">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setVisibleCount(v => v + RENDER_STEP)}
                >
                  Показать ещё {Math.min(RENDER_STEP, filteredCounterparties.length - visibleCount)}
                </button>
              </div>
            )}
            </>
          ) : (
            <div className="table-wrapper">
              <table className="compact-table">
                <thead>
                  <tr>
                    <th className="col-num">№</th>
                    <th className="col-checkbox">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={handleSelectAll}
                      />
                    </th>
                    <th className="col-name">Наименование</th>
                    <th className="col-worktype">Вид работ</th>
                    <th className="col-inn">ИНН</th>
                    <th className="col-contact-name">Контакты</th>
                    <th className="col-contact-phone">Телефон</th>
                    <th className="col-contact-email">Email</th>
                    <th className="col-website">Сайт</th>
                    <th className="col-status">Статус</th>
                    <th className="col-actions"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCounterparties.slice(0, visibleCount).map((counterparty, cpIndex) => {
                    const contacts = counterparty.counterparty_contacts || []
                    const contactsCount = contacts.length
                    const isSelected = selectedSet.has(counterparty.id)

                    return (
                      <tr
                        key={counterparty.id}
                        className={`table-row ${isSelected ? 'selected' : ''} ${counterparty.status === 'blacklist' ? 'blacklist' : ''}`}
                        onClick={() => openDetail(counterparty)}
                      >
                        <td className="col-num">{cpIndex + 1}</td>
                        <td className="col-checkbox" onClick={(e) => e.stopPropagation()}>
                          {/* task 333: bulk-select только с правом редактирования */}
                          {canEditCp && (
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => handleSelectCounterparty(counterparty.id)}
                            />
                          )}
                        </td>
                        <td className="col-name">
                          <span className="company-name">{counterparty.name}</span>
                          <CounterpartyCardChip
                            counterparty={counterparty}
                            card={cardsByCp.get(counterparty.id) || null}
                            canEdit={canEditCp}
                            onChange={(newCard) => setCardsByCp(prev => {
                              const next = new Map(prev)
                              if (newCard) next.set(counterparty.id, newCard)
                              else next.delete(counterparty.id)
                              return next
                            })}
                          />
                          {/* task 422: индикаторы Согласование СБ / Должная осмотрительность.
                              Клик открывает detail-модалку на вкладке «Документы». */}
                          <CounterpartyDocBadges
                            summary={docSummaryByCp.get(counterparty.id)}
                            showDate
                            onOpen={() => openDetail(counterparty, 'documents')}
                          />
                        </td>
                        <td className="col-worktype">
                          {counterparty.work_type ? (
                            <div className="worktype-list">
                              {counterparty.work_type.split(',').map((wt, i) => (
                                <span key={i} className="worktype-tag">{wt.trim()}</span>
                              ))}
                            </div>
                          ) : <span className="empty-cell">--</span>}
                        </td>
                        {/* task 196: только ИНН, без КПП */}
                        <td className="col-inn">
                          <span className="inn-value">{counterparty.inn || '--'}</span>
                        </td>
                        {/* task 199: «Контакты» — только Должность + ФИО, телефоны в отдельном столбце */}
                        <td className="col-contact-name" onClick={(e) => e.stopPropagation()}>
                          {contactsCount > 0 ? (
                            <div className="contacts-stack">
                              {contacts.map((c) => (
                                <div key={c.id} className="contact-stack-item">
                                  {c.position && <div className="contact-position">{c.position}</div>}
                                  <div className="contact-name">{c.full_name}</div>
                                </div>
                              ))}
                              {canEditCp && (
                                <button
                                  className="btn-add-contact-inline"
                                  onClick={() => handleAddContact(counterparty)}
                                  title="Добавить контакт"
                                >+ контакт</button>
                              )}
                            </div>
                          ) : canEditCp ? (
                            <button
                              className="btn-add-contact-inline btn-add-contact-empty"
                              onClick={() => handleAddContact(counterparty)}
                            >+ контакт</button>
                          ) : (
                            <span className="empty-cell">—</span>
                          )}
                        </td>
                        {/* task 199: телефоны — отдельный столбец */}
                        <td className="col-contact-phone" onClick={(e) => e.stopPropagation()}>
                          {contactsCount > 0 && contacts.some(c => c.phone) ? (
                            <div className="contacts-stack contacts-stack-phones">
                              {contacts.map((c) => (
                                c.phone ? (
                                  <div key={c.id} className="phone-cell">
                                    {c.phone.split(';').map((ph, i) => (
                                      ph.trim() && <a key={i} href={`tel:${ph.trim()}`} className="contact-link">{ph.trim()}</a>
                                    ))}
                                  </div>
                                ) : (
                                  <span key={c.id} className="empty-cell">--</span>
                                )
                              ))}
                            </div>
                          ) : <span className="empty-cell">--</span>}
                        </td>
                        <td className="col-contact-email" onClick={(e) => e.stopPropagation()}>
                          {contactsCount > 0 && contacts.some(c => c.email) ? (
                            <div className="contacts-stack contacts-stack-emails">
                              {contacts.map((c) => (
                                c.email ? (
                                  <div key={c.id} className="phone-cell">
                                    {c.email.split(';').map((em, i) => (
                                      em.trim() && <a key={i} href={`mailto:${em.trim()}`} className="contact-link">{em.trim()}</a>
                                    ))}
                                  </div>
                                ) : (
                                  <span key={c.id} className="empty-cell">--</span>
                                )
                              ))}
                            </div>
                          ) : <span className="empty-cell">--</span>}
                        </td>
                        <td className="col-website" onClick={(e) => e.stopPropagation()}>
                          {counterparty.website ? (
                            <a href={counterparty.website} target="_blank" rel="noopener noreferrer" className="contact-link">
                              ссылка
                            </a>
                          ) : <span className="empty-cell">--</span>}
                        </td>
                        <td className="col-status" onClick={(e) => e.stopPropagation()}>
                          {/* task 333: select становится disabled при read-only */}
                          <select
                            className={`status-select-mini ${counterparty.status === 'blacklist' ? 'blacklist' : 'active'}`}
                            value={counterparty.status || 'active'}
                            onChange={(e) => handleStatusChange(counterparty.id, e.target.value)}
                            disabled={!canEditCp}
                          >
                            <option value="active">Активный</option>
                            <option value="blacklist">ЧС</option>
                          </select>
                        </td>
                        <td className="col-actions" onClick={(e) => e.stopPropagation()}>
                          {/* task 333: actions только для can_edit (hard-delete — отдельно admin-only) */}
                          <div className="actions-group">
                            {activeTab === 'deleted' ? (
                              <>
                                {canEditCp && (
                                  <button className="btn-action btn-action-restore" onClick={() => handleRestoreCounterparty(counterparty.id)} title="Восстановить">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 10 9 10"/></svg>
                                  </button>
                                )}
                                {isAdmin && (
                                  <button className="btn-action delete" onClick={() => handleHardDeleteCounterparty(counterparty.id, counterparty.name)} title="Удалить безвозвратно (админ)">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                                  </button>
                                )}
                              </>
                            ) : canEditCp ? (
                              <>
                                {/* task 196: иконка открытия полной карточки компании */}
                                <button className="btn-action btn-action-card" onClick={() => handleEditCounterparty(counterparty)} title="Открыть полную карточку">
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/></svg>
                                </button>
                                <button className="btn-action delete" onClick={() => handleDeleteCounterparty(counterparty.id, counterparty.name)} title="В корзину">
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                                </button>
                              </>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                  {visibleCount < filteredCounterparties.length && (
                    <tr className="show-more-row">
                      <td colSpan="11">
                        <button
                          type="button"
                          className="btn-show-more"
                          onClick={() => setVisibleCount((c) => c + RENDER_STEP)}
                        >
                          Показать ещё {Math.min(RENDER_STEP, filteredCounterparties.length - visibleCount)}
                        </button>
                        <span className="show-more-info">
                          Показано {Math.min(visibleCount, filteredCounterparties.length)} из {filteredCounterparties.length}
                        </span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
        </>
      )}

      {/* Detail-модалка контрагента: история участия + документы + кнопка редактирования.
          Клик по подложке не закрывает — только крестик. */}
      {detailCp && (
        <div className="modal-overlay">
          <div className="modal cp-detail-modal">
            <div className="modal-header cp-detail-header">
              <div className="cp-detail-title">
                <h3>{detailCp.name}</h3>
                {detailCp.inn && <span className="cp-detail-inn">ИНН: {detailCp.inn}</span>}
              </div>
              <div className="cp-detail-header-actions">
                {canEditCp && (
                  <button
                    type="button"
                    className="btn-secondary cp-detail-edit"
                    onClick={() => { const cp = detailCp; setDetailCp(null); handleEditCounterparty(cp) }}
                  >{isPhone ? 'Редактировать' : 'Редактировать контрагента'}</button>
                )}
                <button className="modal-close" onClick={() => setDetailCp(null)} aria-label="Закрыть">×</button>
              </div>
            </div>

            <div className="cp-detail-tabs">
              <button
                type="button"
                className={`cp-detail-tab ${detailTab === 'general' ? 'active' : ''}`}
                onClick={() => setDetailTab('general')}
              >
                Общая информация
              </button>
              <button
                type="button"
                className={`cp-detail-tab ${detailTab === 'documents' ? 'active' : ''}`}
                onClick={() => setDetailTab('documents')}
              >
                Документы
              </button>
              <button
                type="button"
                className={`cp-detail-tab ${detailTab === 'history' ? 'active' : ''}`}
                onClick={() => setDetailTab('history')}
              >
                История участия{tenderHistoryMap[detailCp.id]?.length ? ` (${tenderHistoryMap[detailCp.id].length})` : ''}
              </button>
              {/* Журнал правок — не путать с «Историей участия»: та про тендеры. */}
              <button
                type="button"
                className={`cp-detail-tab ${detailTab === 'changes' ? 'active' : ''}`}
                onClick={() => { setDetailTab('changes'); fetchCpAudit(detailCp.id) }}
              >
                Изменения{auditMap[detailCp.id]?.length ? ` (${auditMap[detailCp.id].length})` : ''}
              </button>
            </div>

            <div className="cp-detail-body">
              {detailTab === 'general' && (
                <CounterpartyGeneralTab
                  counterparty={detailCpLive}
                  counterparties={counterparties}
                  canEdit={canEditCp}
                  isAdmin={isAdmin}
                  canViewContracts={canView('contracts')}
                  isPhone={isPhone}
                  vatSupported={vatSupported}
                  affiliates={getRelatedCounterparties(detailCp.id)}
                  onSaveNotes={(text) => handleNotesChange(detailCp.id, text)}
                  onSaveVat={(value) => handleVatChange(detailCp.id, value)}
                  onAddAffiliate={(other) => handleAddRelation(detailCp.id, other.id)}
                  onRemoveAffiliate={(other) => handleRemoveRelation(detailCp.id, other.id)}
                  onOpenCounterparty={(other) => openDetail(other)}
                  onContractLinkChange={(event, doc) => handleContractLinkChange(detailCp.id, event, doc)}
                />
              )}

              {detailTab === 'changes' && (
                auditLoadingId === detailCp.id ? (
                  <div className="tender-history-loading">Загрузка истории…</div>
                ) : !auditMap[detailCp.id] || auditMap[detailCp.id].length === 0 ? (
                  <div className="cp-audit-empty">
                    <p>Записей нет.</p>
                    <p className="cp-audit-hint">
                      История ведётся с момента подключения функции — более ранние правки
                      нигде не сохранялись и восстановлению не подлежат.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="cp-audit-legend">
                      <span className="nd-removed">удалено</span>
                      <span className="nd-added">добавлено</span>
                    </div>
                    <ul className="cp-audit-list">
                      {auditMap[detailCp.id].map(ev => {
                        // Примечание показываем пословным diff: «было → стало» на
                        // абзаце текста нечитаемо, глазами правку не найти.
                        const isNote = ev.field_name === 'notes'
                        const before = String(ev.old_value ?? '')
                        const after = String(ev.new_value ?? '')
                        const label = isNote
                          ? (!before ? 'Примечание добавлено' : !after ? 'Примечание очищено' : 'Примечание изменено')
                          : (ev.description || CP_EVENT_LABEL[ev.event_type] || ev.event_type)
                        const parts = isNote ? diffWords(before, after) : null
                        return (
                          <li key={ev.id} className="cp-audit-item">
                            <div className="cp-audit-meta">
                              <span className="cp-audit-when">{fmtAuditDateTime(ev.changed_at)}</span>
                              <span className="cp-audit-who">{ev.changed_by_name || 'без имени'}</span>
                            </div>
                            <div className="cp-audit-what">{label}</div>
                            {isNote && (
                              <div className="cp-audit-diff">
                                {parts.length === 0
                                  ? <span className="cp-audit-hint">— пусто —</span>
                                  : parts.map((p, idx) => (
                                    <span
                                      key={idx}
                                      className={p.type === 'added' ? 'nd-added' : p.type === 'removed' ? 'nd-removed' : undefined}
                                    >{p.text}</span>
                                  ))}
                              </div>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </>
                )
              )}

              {detailTab === 'history' && (
                tenderHistoryLoadingId === detailCp.id ? (
                  <div className="tender-history-loading">Загрузка истории…</div>
                ) : !tenderHistoryMap[detailCp.id] || tenderHistoryMap[detailCp.id].length === 0 ? (
                  <div className="tender-history-empty">Контрагент пока не участвовал в тендерах.</div>
                ) : isPhone ? (
                  // Таблица с фиксированными колонками на телефоне не помещалась:
                  // статус и даты (nowrap) выдавливали описание в столбец по слову.
                  <ul className="cp-history-cards">
                    {tenderHistoryMap[detailCp.id].map((h) => {
                      const status = h.status || 'request_sent'
                      return (
                        <li key={h.tender_id}>
                          <a href={`/tenders/${h.tender_id}`} className="cp-history-card">
                            <div className="cp-history-card-head">
                              <span className="cp-history-card-obj">{h.object_name || '—'}</span>
                              <span className={`tender-history-status status-${status}`}>
                                <span className="tender-history-status-dot" aria-hidden />
                                {TENDER_STATUS_LABEL[status] || status}
                              </span>
                            </div>
                            <div className="cp-history-card-desc">{h.work_description || '—'}</div>
                            <div className="cp-history-card-foot">
                              <span>{(h.tender_start_date || h.tender_end_date)
                                ? `${fmtRuDate(h.tender_start_date) || '—'} → ${fmtRuDate(h.tender_end_date) || '—'}`
                                : 'Сроки не указаны'}</span>
                              <span className="cp-history-card-open">Открыть ›</span>
                            </div>
                          </a>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <div className="tender-history-table-wrap">
                    <table className="tender-history-table">
                      <thead>
                        <tr>
                          <th className="th-num">№</th>
                          <th className="th-obj">Объект</th>
                          <th className="th-desc">Описание работ</th>
                          <th className="th-status">Статус</th>
                          <th className="th-dates">Сроки процедуры</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tenderHistoryMap[detailCp.id].map((h, i) => {
                          const status = h.status || 'request_sent'
                          const startDate = fmtRuDate(h.tender_start_date)
                          const endDate = fmtRuDate(h.tender_end_date)
                          return (
                            <tr key={h.tender_id}>
                              <td className="tender-history-num">{i + 1}</td>
                              <td className="tender-history-obj">{h.object_name}</td>
                              <td>
                                <a
                                  href={`/tenders/${h.tender_id}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="tender-history-link"
                                  title="Открыть тендер в новой вкладке"
                                >
                                  {h.work_description || '—'}
                                </a>
                              </td>
                              <td>
                                <span className={`tender-history-status status-${status}`}>
                                  <span className="tender-history-status-dot" aria-hidden />
                                  {TENDER_STATUS_LABEL[status] || status}
                                </span>
                              </td>
                              <td className="tender-history-dates">
                                {startDate || endDate ? (
                                  <span className="tender-history-dates-range">
                                    <span>{startDate || '—'}</span>
                                    <span className="tender-history-dates-sep">→</span>
                                    <span>{endDate || '—'}</span>
                                  </span>
                                ) : <span className="muted-dash">—</span>}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              )}

              {detailTab === 'documents' && (
                <div className="cp-detail-docs">
                  <section className="cp-doc-section">
                    <S3DocumentList
                      ownerType="counterparty"
                      ownerId={detailCp.id}
                      category="sb_approval"
                      title="Согласование СБ"
                      canEdit={canEditCp}
                    />
                  </section>
                  <section className="cp-doc-section">
                    <S3DocumentList
                      ownerType="counterparty"
                      ownerId={detailCp.id}
                      category="other"
                      title="Должная осмотрительность"
                      canEdit={canEditCp}
                    />
                  </section>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal для добавления/редактирования контрагента.
          Клик по подложке НЕ закрывает окно — заполненную форму легко потерять
          случайным кликом. Закрытие только осознанное: крестик (×). */}
      {showCounterpartyModal && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <h3>
                {editingCounterparty
                  ? 'Редактировать контрагента'
                  : 'Добавить нового контрагента'}
              </h3>
              <button
                className="modal-close"
                onClick={() => {
                  setShowCounterpartyModal(false)
                  setEditingCounterparty(null)
                }}
              >
                ×
              </button>
            </div>

            <form onSubmit={handleCounterpartySubmit}>
              <div className="form-grid">
                <div className="form-group full-width">
                  <label>Наименование организации *</label>
                  <input
                    type="text"
                    value={counterpartyFormData.name}
                    onChange={(e) =>
                      setCounterpartyFormData({
                        ...counterpartyFormData,
                        name: e.target.value,
                      })
                    }
                    required
                  />
                </div>

                <div className="form-group full-width">
                  <label>Виды работ</label>
                  <div className="work-types-container">
                    {workTypes.length > 0 && (
                      <div className="work-types-tags">
                        {workTypes.map((wt, index) => (
                          <span key={index} className="work-type-tag">
                            {wt}
                            <button
                              type="button"
                              className="work-type-tag-remove"
                              onClick={() => setWorkTypes(workTypes.filter((_, i) => i !== index))}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    {/* task 321 + 322: поиск по справочнику work_types.
                        Чтобы добавить новый вид работ — перейти на вкладку «Виды работ». */}
                    {(() => {
                      const available = workTypesDirectory.filter(wt => !workTypes.includes(wt.name))
                      const q = wtSearch.trim().toLowerCase()
                      const filtered = !q
                        ? available
                        : available.filter(wt => (wt.name || '').toLowerCase().includes(q))
                      if (workTypesDirectory.length === 0) {
                        return (
                          <div style={{ fontSize: '0.8125rem', color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                            Справочник видов работ пуст. Добавьте записи на вкладке «Виды работ».
                          </div>
                        )
                      }
                      if (available.length === 0) {
                        return (
                          <div style={{ fontSize: '0.8125rem', color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                            Все виды работ из справочника уже выбраны.
                          </div>
                        )
                      }
                      return (
                        <div className="wt-search-wrap">
                          <input
                            type="text"
                            className="wt-search-input"
                            value={wtSearch}
                            placeholder="Начните вводить название вида работ…"
                            onChange={(e) => { setWtSearch(e.target.value); setWtDropdownOpen(true) }}
                            onFocus={() => setWtDropdownOpen(true)}
                            onBlur={() => setTimeout(() => setWtDropdownOpen(false), 150)}
                          />
                          {wtDropdownOpen && (
                            <div className="wt-search-dropdown">
                              {filtered.length === 0 ? (
                                <div className="wt-search-empty">
                                  Ничего не найдено по запросу «{wtSearch}»
                                </div>
                              ) : (
                                filtered.map(wt => (
                                  <button
                                    key={wt.id}
                                    type="button"
                                    className="wt-search-item"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => {
                                      setWorkTypes([...workTypes, wt.name])
                                      setWtSearch('')
                                      setWtDropdownOpen(false)
                                    }}
                                  >
                                    {wt.name}
                                  </button>
                                ))
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })()}
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.375rem' }}>
                      Новые виды работ добавляются на вкладке <strong>«Виды работ»</strong>.
                    </div>
                  </div>
                </div>

                <div className="form-group">
                  <label>ИНН</label>
                  <input
                    type="text"
                    value={counterpartyFormData.inn}
                    onChange={(e) =>
                      setCounterpartyFormData({
                        ...counterpartyFormData,
                        inn: e.target.value,
                      })
                    }
                    placeholder="1234567890"
                    maxLength="12"
                  />
                </div>

                <div className="form-group">
                  <label>КПП</label>
                  <input
                    type="text"
                    value={counterpartyFormData.kpp}
                    onChange={(e) =>
                      setCounterpartyFormData({
                        ...counterpartyFormData,
                        kpp: e.target.value,
                      })
                    }
                    placeholder="123456789"
                    maxLength="9"
                  />
                </div>

                <div className="form-group full-width">
                  <label>Юридический адрес</label>
                  <input
                    type="text"
                    value={counterpartyFormData.legal_address}
                    onChange={(e) =>
                      setCounterpartyFormData({
                        ...counterpartyFormData,
                        legal_address: e.target.value,
                      })
                    }
                  />
                </div>

                <div className="form-group full-width">
                  <label>Фактический адрес</label>
                  <input
                    type="text"
                    value={counterpartyFormData.actual_address}
                    onChange={(e) =>
                      setCounterpartyFormData({
                        ...counterpartyFormData,
                        actual_address: e.target.value,
                      })
                    }
                  />
                </div>

                <div className="form-group full-width">
                  <label>Ссылка на сайт</label>
                  <input
                    type="url"
                    value={counterpartyFormData.website}
                    onChange={(e) =>
                      setCounterpartyFormData({
                        ...counterpartyFormData,
                        website: e.target.value,
                      })
                    }
                    placeholder="https://example.com"
                  />
                </div>

                <div className="form-group">
                  <label>Статус</label>
                  <select
                    value={counterpartyFormData.status}
                    onChange={(e) =>
                      setCounterpartyFormData({
                        ...counterpartyFormData,
                        status: e.target.value,
                      })
                    }
                  >
                    <option value="active">Действующий</option>
                    <option value="blacklist">Черный список</option>
                  </select>
                </div>

                <div className="form-group full-width">
                  <label>Примечание</label>
                  <textarea
                    value={counterpartyFormData.notes}
                    onChange={(e) =>
                      setCounterpartyFormData({
                        ...counterpartyFormData,
                        notes: e.target.value,
                      })
                    }
                    placeholder="Дополнительная информация о контрагенте"
                    rows="3"
                  />
                </div>
              </div>

              {/* Секция контактов */}
              <div style={{ marginTop: '1.5rem', padding: '1.5rem', backgroundColor: 'var(--bg-tertiary)', borderRadius: '6px' }}>
                <h4 style={{ margin: '0 0 1rem 0', fontSize: '1rem', color: 'var(--text-primary)' }}>
                  Контактные лица
                </h4>

                {/* Список добавленных контактов */}
                {tempContacts.length > 0 && (
                  <div style={{ marginBottom: '1rem' }}>
                    {tempContacts.map((contact, index) => (
                      <div
                        key={index}
                        style={{
                          padding: '0.75rem',
                          backgroundColor: 'var(--bg-secondary)',
                          borderRadius: '4px',
                          marginBottom: '0.5rem',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'flex-start',
                          border: editingTempContactIndex === index ? '2px solid #2563eb' : '1px solid var(--border-color)'
                        }}
                      >
                        <div style={{ fontSize: '0.875rem' }}>
                          <div style={{ fontWeight: '600', marginBottom: '0.25rem' }}>
                            {contact.full_name}
                          </div>
                          {contact.position && (
                            <div style={{ color: 'var(--text-tertiary)' }}>
                              {contact.position}
                            </div>
                          )}
                          {contact.phone && (
                            <div style={{ marginTop: '0.25rem' }}>
                              📞 {contact.phone}
                            </div>
                          )}
                          {contact.email && (
                            <div>
                              ✉️ {contact.email}
                            </div>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: '0.25rem' }}>
                          <button
                            type="button"
                            className="btn-icon btn-edit"
                            onClick={() => handleEditTempContact(index)}
                            title="Редактировать"
                            style={{ fontSize: '0.875rem', padding: '0.25rem' }}
                          >
                            ✏️
                          </button>
                          <button
                            type="button"
                            className="btn-icon btn-delete"
                            onClick={() => handleDeleteTempContact(index)}
                            title="Удалить"
                            style={{ fontSize: '0.875rem', padding: '0.25rem' }}
                          >
                            🗑️
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Форма добавления/редактирования контакта */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem', marginBottom: '0.75rem' }}>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={SUB_LABEL_STYLE}>
                      ФИО
                    </label>
                    <input
                      type="text"
                      value={contactFormData.full_name}
                      onChange={(e) =>
                        setContactFormData({
                          ...contactFormData,
                          full_name: e.target.value,
                        })
                      }
                      placeholder="Иванов Иван Иванович"
                      style={SUB_INPUT_STYLE}
                    />
                  </div>
                  <div>
                    <label style={SUB_LABEL_STYLE}>
                      Должность
                    </label>
                    <input
                      type="text"
                      value={contactFormData.position}
                      onChange={(e) =>
                        setContactFormData({
                          ...contactFormData,
                          position: e.target.value,
                        })
                      }
                      placeholder="Директор"
                      style={SUB_INPUT_STYLE}
                    />
                  </div>
                  <div>
                    <label style={SUB_LABEL_STYLE}>
                      Телефон
                    </label>
                    <MultiValueInput
                      variant="form"
                      type="tel"
                      value={contactFormData.phone}
                      onChange={(phone) => setContactFormData({ ...contactFormData, phone })}
                      format={formatPhone}
                      placeholder="+7(916)712-69-10"
                      addLabel="+ Ещё номер"
                      removeTitle="Удалить номер"
                    />
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={SUB_LABEL_STYLE}>
                      Email
                    </label>
                    <MultiValueInput
                      variant="form"
                      type="email"
                      value={contactFormData.email}
                      onChange={(email) => setContactFormData({ ...contactFormData, email })}
                      placeholder="email@example.com"
                      addLabel="+ Ещё email"
                      removeTitle="Удалить email"
                    />
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={handleAddTempContact}
                    style={{ fontSize: '0.875rem', padding: '0.5rem 1rem' }}
                  >
                    {editingTempContactIndex !== null ? '✓ Сохранить контакт' : '+ Добавить контакт'}
                  </button>
                  {editingTempContactIndex !== null && (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={handleCancelEditTempContact}
                      style={{ fontSize: '0.875rem', padding: '0.5rem 1rem' }}
                    >
                      Отмена
                    </button>
                  )}
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={cpSaving}
                  onClick={() => {
                    setShowCounterpartyModal(false)
                    setEditingCounterparty(null)
                  }}
                >
                  Отмена
                </button>
                <button type="submit" className="btn-primary" disabled={cpSaving}>
                  {cpSaving ? 'Сохранение…' : (editingCounterparty ? 'Сохранить' : 'Добавить')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal для добавления/редактирования контакта контрагента */}
      {showContactModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                {editingContact ? 'Редактировать контакт' : 'Добавить контакт'}
              </h3>
              <button
                className="modal-close"
                onClick={() => {
                  setShowContactModal(false)
                  setEditingContact(null)
                }}
              >
                ×
              </button>
            </div>

            <form onSubmit={handleContactSubmit}>
              <div className="form-grid">
                <div className="form-group full-width">
                  <label>Контрагент</label>
                  <input
                    type="text"
                    value={selectedCounterparty?.name || ''}
                    disabled
                    style={{ backgroundColor: 'var(--bg-tertiary)', cursor: 'not-allowed' }}
                  />
                </div>

                <div className="form-group full-width">
                  <label>ФИО *</label>
                  <input
                    type="text"
                    value={contactFormData.full_name}
                    onChange={(e) =>
                      setContactFormData({
                        ...contactFormData,
                        full_name: e.target.value,
                      })
                    }
                    required
                  />
                </div>

                <div className="form-group">
                  <label>Должность</label>
                  <input
                    type="text"
                    value={contactFormData.position}
                    onChange={(e) =>
                      setContactFormData({
                        ...contactFormData,
                        position: e.target.value,
                      })
                    }
                    placeholder="Директор, Главный бухгалтер и т.д."
                  />
                </div>

                <div className="form-group">
                  <label>Телефон</label>
                  <MultiValueInput
                    variant="modal"
                    type="tel"
                    value={contactFormData.phone}
                    onChange={(phone) => setContactFormData({ ...contactFormData, phone })}
                    format={formatPhone}
                    placeholder="+7(916)712-69-10"
                    addLabel="+ Ещё номер"
                    removeTitle="Удалить номер"
                  />
                </div>

                <div className="form-group full-width">
                  <label>Email</label>
                  <MultiValueInput
                    variant="modal"
                    type="email"
                    value={contactFormData.email}
                    onChange={(email) => setContactFormData({ ...contactFormData, email })}
                    placeholder="email@example.com"
                    addLabel="+ Ещё email"
                    removeTitle="Удалить email"
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setShowContactModal(false)
                    setEditingContact(null)
                  }}
                >
                  Отмена
                </button>
                <button type="submit" className="btn-primary">
                  {editingContact ? 'Сохранить' : 'Добавить'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* task 321: модалка добавления/редактирования вида работ */}
      {showWorkTypeModal && (
        <div className="modal-overlay" onClick={() => setShowWorkTypeModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '480px' }}>
            <div className="modal-header">
              <h3>{editingWorkType ? 'Редактировать вид работ' : 'Новый вид работ'}</h3>
              <button
                className="modal-close"
                onClick={() => { setShowWorkTypeModal(false); setEditingWorkType(null) }}
              >×</button>
            </div>
            <form onSubmit={handleSubmitWorkType}>
              <div className="form-grid">
                <div className="form-group full-width">
                  <label>Название *</label>
                  <input
                    type="text"
                    value={workTypeForm.name}
                    onChange={(e) => setWorkTypeForm({ ...workTypeForm, name: e.target.value })}
                    required
                    autoFocus
                    placeholder="Например, Строительно-монтажные работы"
                  />
                </div>
                <div className="form-group full-width">
                  <label>Описание</label>
                  <textarea
                    value={workTypeForm.description}
                    onChange={(e) => setWorkTypeForm({ ...workTypeForm, description: e.target.value })}
                    rows={3}
                    placeholder="Краткое описание вида работ (необязательно)"
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => { setShowWorkTypeModal(false); setEditingWorkType(null) }}
                >
                  Отмена
                </button>
                <button type="submit" className="btn-primary">
                  {editingWorkType ? 'Сохранить' : 'Добавить'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal с инструкцией по импорту */}
      {showImportInstructionsModal && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowImportInstructionsModal(false) }}>
          <div className="modal" style={{ maxWidth: '800px' }}>
            <div className="modal-header">
              <h3>Инструкция по импорту контрагентов из Excel</h3>
              <button
                className="modal-close"
                onClick={() => setShowImportInstructionsModal(false)}
              >
                ×
              </button>
            </div>

            <div style={{ padding: '2rem' }}>
              <div style={{ marginBottom: '1.5rem' }}>
                <h4 style={{ margin: '0 0 1rem 0', fontSize: '1rem', color: 'var(--text-primary)' }}>
                  📋 Формат файла Excel
                </h4>
                <p style={{ margin: '0 0 0.5rem 0', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                  Файл должен содержать следующие столбцы (первая строка - заголовки):
                </p>
              </div>

              <div style={{
                backgroundColor: 'var(--bg-tertiary)',
                padding: '1rem',
                borderRadius: '6px',
                marginBottom: '1.5rem',
                overflowX: 'auto'
              }}>
                <table style={{
                  width: '100%',
                  fontSize: '0.875rem',
                  borderCollapse: 'collapse'
                }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid var(--border-color)' }}>
                      <th style={{ padding: '0.5rem', textAlign: 'left', color: 'var(--text-primary)', fontWeight: '600' }}>Название столбца</th>
                      <th style={{ padding: '0.5rem', textAlign: 'left', color: 'var(--text-primary)', fontWeight: '600' }}>Обязательно</th>
                      <th style={{ padding: '0.5rem', textAlign: 'left', color: 'var(--text-primary)', fontWeight: '600' }}>Пример</th>
                    </tr>
                  </thead>
                  <tbody>
                    {IMPORT_COLUMNS.map((col, i) => (
                      <tr key={col.name} style={i < IMPORT_COLUMNS.length - 1 ? { borderBottom: '1px solid var(--border-color)' } : undefined}>
                        <td style={{ padding: '0.5rem', color: 'var(--text-secondary)' }}>{col.name}</td>
                        {col.required
                          ? <td style={{ padding: '0.5rem' }}><span style={{ color: '#b91c1c', fontWeight: '600' }}>Да</span></td>
                          : <td style={{ padding: '0.5rem', color: 'var(--text-tertiary)' }}>Нет</td>}
                        <td style={{ padding: '0.5rem', color: 'var(--text-tertiary)', fontSize: '0.8125rem' }}>{col.example}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{
                backgroundColor: 'var(--bg-tertiary)',
                border: '1px solid var(--border-color)',
                padding: '1rem',
                borderRadius: '6px',
                marginBottom: '1.5rem'
              }}>
                <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '0.875rem', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  💡 Важные замечания
                </h4>
                <ul style={{ margin: '0', paddingLeft: '1.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                  <li style={{ marginBottom: '0.25rem' }}>Названия столбцов должны точно совпадать с указанными выше</li>
                  <li style={{ marginBottom: '0.25rem' }}>Первая строка файла должна содержать заголовки столбцов</li>
                  <li style={{ marginBottom: '0.25rem' }}>Чтобы добавить несколько контактов для одного контрагента, укажите контрагента в нескольких строках с одинаковым названием и ИНН</li>
                  <li style={{ marginBottom: '0.25rem' }}>Контрагенты группируются по названию и ИНН (дубли не создаются)</li>
                  <li>Пустые ячейки допускаются (кроме «Наименование организации»)</li>
                </ul>
              </div>

              <div style={{
                backgroundColor: 'var(--bg-tertiary)',
                padding: '1rem',
                borderRadius: '6px'
              }}>
                <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '0.875rem', color: 'var(--text-primary)' }}>
                  📝 Пример структуры файла
                </h4>
                <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.8125rem', color: 'var(--text-tertiary)', fontFamily: 'monospace' }}>
                  | Наименование организации | ИНН | КПП | ... | ФИО контакта | Должность контакта | ...<br/>
                  | ООО «Стройком» | 7728123456 | 772801001 | ... | Иванов И.И. | Директор | ...<br/>
                  | ООО «Стройком» | 7728123456 | 772801001 | ... | Сидоров С.С. | Главный инженер | ...<br/>
                  | ЗАО «Ремонт+» | 7729654321 | ... | ... | Петров П.П. | Менеджер | ...
                </p>
                <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.75rem', color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                  ℹ️ В этом примере для ООО «Стройком» будут импортированы 2 контакта, а для ЗАО «Ремонт+» — 1 контакт
                </p>
              </div>
            </div>

            <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={handleDownloadTemplate}
                style={{ marginRight: 'auto' }}
              >
                Скачать шаблон (.xlsx)
              </button>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowImportInstructionsModal(false)}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleProceedWithImport}
                >
                  Выбрать файл
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Результат импорта */}
      {importResult && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setImportResult(null) }}>
          <div className="modal" style={{ maxWidth: '600px' }}>
            <div className="modal-header">
              <h3>Результат импорта</h3>
              <button className="modal-close" onClick={() => setImportResult(null)}>×</button>
            </div>
            <div style={{ padding: '1.5rem' }}>
              {/* Успешно */}
              <div style={{
                display: 'flex', gap: '1.5rem', marginBottom: '1.25rem'
              }}>
                <div style={{
                  flex: 1, padding: '1rem', background: 'rgba(22, 163, 74, 0.08)',
                  borderRadius: '8px', textAlign: 'center', border: '1px solid rgba(22, 163, 74, 0.2)'
                }}>
                  <div style={{ fontSize: '2rem', fontWeight: 800, color: '#16a34a' }}>{importResult.success.length}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>Контрагентов загружено</div>
                </div>
                <div style={{
                  flex: 1, padding: '1rem', background: 'rgba(37, 99, 235, 0.08)',
                  borderRadius: '8px', textAlign: 'center', border: '1px solid rgba(37, 99, 235, 0.2)'
                }}>
                  <div style={{ fontSize: '2rem', fontWeight: 800, color: '#2563eb' }}>{importResult.contacts}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>Контактов загружено</div>
                </div>
                {importResult.errors.length > 0 && (
                  <div style={{
                    flex: 1, padding: '1rem', background: 'rgba(220, 38, 38, 0.08)',
                    borderRadius: '8px', textAlign: 'center', border: '1px solid rgba(220, 38, 38, 0.2)'
                  }}>
                    <div style={{ fontSize: '2rem', fontWeight: 800, color: '#dc2626' }}>{importResult.errors.length}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>Ошибок</div>
                  </div>
                )}
              </div>

              {/* Список загруженных */}
              {importResult.success.length > 0 && (
                <div style={{ marginBottom: '1rem' }}>
                  <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
                    Загруженные контрагенты:
                  </div>
                  <div style={{
                    maxHeight: '150px', overflowY: 'auto', background: 'var(--bg-tertiary)',
                    borderRadius: '6px', padding: '0.5rem 0.75rem', fontSize: '0.8125rem',
                    border: '1px solid var(--border-color)'
                  }}>
                    {importResult.success.map((name, i) => (
                      <div key={i} style={{ padding: '0.2rem 0', color: 'var(--text-secondary)', borderBottom: i < importResult.success.length - 1 ? '1px solid var(--border-color)' : 'none' }}>
                        {i + 1}. {name}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Ошибки */}
              {importResult.errors.length > 0 && (
                <div>
                  <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#dc2626', marginBottom: '0.5rem' }}>
                    Не удалось импортировать:
                  </div>
                  <div style={{
                    maxHeight: '150px', overflowY: 'auto', background: 'rgba(220, 38, 38, 0.05)',
                    borderRadius: '6px', padding: '0.5rem 0.75rem', fontSize: '0.8125rem',
                    border: '1px solid rgba(220, 38, 38, 0.15)'
                  }}>
                    {importResult.errors.map((err, i) => (
                      <div key={i} style={{ padding: '0.25rem 0', color: 'var(--text-secondary)', borderBottom: i < importResult.errors.length - 1 ? '1px solid var(--border-color)' : 'none' }}>
                        {err}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ marginTop: '1.25rem', display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn-primary" onClick={() => setImportResult(null)}>Закрыть</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default CounterpartiesPage
