import { useState, useEffect, useRef, useLayoutEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { db } from '../api'
import { useRole } from '../contexts/RoleContext'
import { deleteDocument, requestDownloadUrl, uploadFile } from '../services/s3'
import S3DocumentPreview from '../components/S3DocumentPreview'
import DcRequestDocsModal from '../components/DcRequestDocsModal'
import FilterDropdown from '../components/FilterDropdown'
import VorDivisionChip from '../components/VorDivisionChip'
import VorDivisionFilter from '../components/VorDivisionFilter'
import IconTile from '../components/IconTile'
import { IconDcRequest } from '../components/icons/NavIcons'
import { IconHardHat } from '../components/icons/TenderHubIcons'
import { IconObject, IconUser, IconSearch, IconDocsStack } from '../components/icons/ToolbarIcons'
import { IconFileSpreadsheet } from '../components/icons/BsmIcons'
import { IconPencil as IconEdit, IconTrash, IconRestore, IconClock, IconCalendar, IconLink, IconCheck as IconCheckMark } from '../components/icons/ActionIcons'
import ClampText from '../components/ClampText'
import PersonName from '../components/PersonName'
import BreakableId from '../components/BreakableId'
import PaperclipIcon from '../components/icons/PaperclipIcon'
import { useIsPhone } from '../hooks/useMediaQuery'
import useBodyClass from '../hooks/useBodyClass'
import { copyToClipboard } from '../utils/clipboard'
import { parseAmount, formatAmount, formatAmountLive, amountChange } from '../utils/money'
import {
  CHECK_STATUS_CLASS, CHECK_STATUS_LABEL, CHECK_STATUS_OPTIONS, CHECK_STATUS_SHORT, DS_TYPE_CLASS, DS_TYPE_LABEL,
  DS_TYPE_OPTIONS, MATERIAL_CLASS, MATERIAL_LABEL, MATERIAL_OPTIONS, STATUS_LABEL, STATUS_OPTIONS, SUBMISSION_CLASS,
  SUBMISSION_DEFAULT, SUBMISSION_HINT, SUBMISSION_LABEL, SUBMISSION_OPTIONS, hasSubmissionColumns, hasVerdict,
  matchesRequestNo, submissionNeedsComment, submissionOf, withRequestNumbers,
} from '../utils/dcRequestOptions'
import { DC_FILE_PARAM, DOC_SECTIONS, SPECIAL_DOC_CATEGORIES, dcRequestDocRows, dcRequestFileLink } from '../utils/dcRequestDocs'
import { amendmentLabel, amendmentsOf, autoContractFor, contractChoicesFor, contractLabel, matchAmendment } from '../utils/dcRequestContracts'
import { VOR_DIVISIONS, VOR_DIVISION_LABEL, NO_VOR_DIVISION } from '../utils/vorDivisions'
import { fetchAllRows, fetchAllRowsParallel } from '../utils/fetchAllRows'
import { DC_SCROLL_KEY, groupDocsByRequest, readDcView, sessionStore, writeDcView } from '../utils/dcRequestView'
import useScrollMemory from '../hooks/useScrollMemory'
import { openFolder } from '../components/FolderOpen'
import { canOpenFolders, isFolderPath } from '../utils/folderOpen'
import '../components/ContractRegistry.css'
import '../components/MobileCards.css'
import './DcRequestsPage.css'
// Общий рабочий стиль разделов (docs/UI_GUIDELINES.md) — после стилей страницы.
import '../styles/fonts.css'
import '../styles/workUi.css'

// Task 306 + 307 + 309 + 310. Реестр «Заявок на ДС» — независимая сущность.
// Объект можно выбрать из ОБОИХ отделов: основное строительство и гарантийный отдел.
// Документы хранятся в s3_documents с owner_type='dc_request', notes = описание.
// Договор и номер ДС — раздельно (миграция 20261109, utils/dcRequestContracts.js): договор — из реестра
// «Договоры и ДС» (договоры контрагента заявки; единственный по объекту подставляется сам), «№ ДС» — текстом,
// «занесена в ДС» — ДС того договора (с тем же номером — подставляется само). Подразделение — коды
// подразделений ВОР, фильтр как у тендеров. Колонки «Задачи» с 27.10.2026 нет: задачи (dc_request_tasks)
// остаются в базе и в выгрузке в Excel.

const EMPTY_FORM = {
  object_id: '',
  counterparty_id: '',
  ds_number: '',
  works_description: '',
  responsible_contact_id: '',
  // Путь к папке с документами в хранилище (миграция 20260828).
  folder_path: '',
  // Новая заявка всегда начинается со сверки с договором. Поля выбора статуса в
  // форме нет: дальше по цепочке статус двигают чипом в таблице реестра.
  status: 'contract_check',
  expected_approval_date: '', // task 365
  amount_before: '', // task 370
  amount_after: '', // task 370
  material_type: '', // task 370
  ds_type: '',
  // Миграция 20261109: договор реестра «Договоры и ДС», ДС, в которое занесена заявка, подразделение.
  contract_id: '',
  amendment_id: '',
  division: '',
}

// Этапы, исход проверки, тип ДС и тип материала — utils/dcRequestOptions.js (общие с отчётом).

// Категории файлов заявки (рабочие, отчёт по документам, итоговые) — utils/dcRequestDocs.js.

// Сколько контрагентов показывать в выпадающем поиске за раз (список большой — 1000+).
const CP_SEARCH_LIMIT = 50

// Высота меню статуса (четыре этапа) с отступом, px: меньше места под чипом — меню открывается вверх.
const STATUS_POPOVER_SPACE = 180

// Путь заявки открывается в проводнике нажатием: путь к папке Windows и компьютер на Windows.
const folderOpenable = (path) => isFolderPath(path) && canOpenFolders()

const TABS = [
  { key: 'all', label: 'Все заявки' },
  { key: 'contract_check', label: 'Проверка по договору' },
  { key: 'check_result', label: 'Итог проверки' },
  { key: 'in_work', label: 'В работе' },
  { key: 'completed', label: 'Завершено' },
  { key: 'deleted', label: 'Удаленные' },
]

// ── История изменений заявки (dc_request_audit_log) ─────────────────────────
const EVENT_LABEL = {
  created: 'Создание',
  status_changed: 'Смена статуса',
  field_updated: 'Изменение поля',
  soft_deleted: 'В «Удаленные»',
  restored: 'Восстановление',
}

// Поля заявки, изменения которых пишем в историю (порядок = порядок в модалке).
// Иконки строки «путь к папке» — outline-стиль бокового меню, не эмодзи.
const pathIconProps = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
  width: 14, height: 14, 'aria-hidden': true, focusable: 'false',
}
const IconFolder = () => (
  <svg {...pathIconProps}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
)
const IconCopy = () => (
  <svg {...pathIconProps}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)
const IconCheck = () => (
  <svg {...pathIconProps} strokeWidth="2.4"><path d="M20 6 9 17l-5-5" /></svg>
)
const IconPencil = () => (
  <svg {...pathIconProps}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
)

const AUDIT_FIELD_LABEL = {
  object_id: 'Объект',
  counterparty_id: 'Контрагент',
  ds_number: '№ ДС',
  works_description: 'Описание ДС',
  responsible_contact_id: 'Ответственный',
  folder_path: 'Путь к папке',
  status: 'Статус',
  expected_approval_date: 'Срок согласования',
  amount_before: 'Было подано',
  amount_after: 'Утверждено',
  material_type: 'Материал',
  check_status: 'Итог проверки',
  check_result_notes: 'Заключение по проверке',
  ds_type: 'Тип ДС',
  contract_id: 'Договор',
  amendment_id: 'Занесена в ДС',
  division: 'Подразделение',
  submission_check: 'Статус ОКС',
  submission_comment: 'Комментарий к статусу ОКС',
}

function formatDateTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ru-RU') + ', ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

function formatShortDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}.${d.getFullYear()}`
}

// Процент изменения суммы: «5,6» (1 знак после запятой; для мелких изменений — 2).
const PERCENT_FORMATTER = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})
const PERCENT_FORMATTER_SMALL = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
function formatPercent(num) {
  if (num == null || !Number.isFinite(num)) return ''
  return num < 0.1 ? PERCENT_FORMATTER_SMALL.format(num) : PERCENT_FORMATTER.format(num)
}

// task 365 + 366: маленький popover для быстрого редактирования ориентировочного
//   срока согласования. Рендерится через React Portal в <body>, position:fixed —
//   не вызывает прокрутку родительской таблицы и не обрезается её overflow:auto.
//   Координаты считаются от anchorRect (BCR кнопки-триггера) с авто-флипом
//   вверх, если внизу не помещается.
const POPOVER_WIDTH = 248
const POPOVER_HEIGHT = 132

function DeadlinePopover({ initial, anchorRect, onClose, onSave }) {
  const [value, setValue] = useState(initial || '')
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const rootRef = useRef(null)

  useLayoutEffect(() => {
    if (!anchorRect) return
    const margin = 8
    const vw = window.innerWidth
    const vh = window.innerHeight
    let top = anchorRect.bottom + 6
    if (top + POPOVER_HEIGHT > vh - margin) {
      // не помещается снизу — переворачиваем над триггером
      top = Math.max(margin, anchorRect.top - POPOVER_HEIGHT - 6)
    }
    let left = anchorRect.left
    if (left + POPOVER_WIDTH > vw - margin) left = vw - POPOVER_WIDTH - margin
    if (left < margin) left = margin
    setPos({ top, left })
  }, [anchorRect])

  useEffect(() => {
    const handleClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) onClose()
    }
    const handleKey = (e) => { if (e.key === 'Escape') onClose() }
    const handleScrollOrResize = () => onClose()
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    // При прокрутке таблицы / окна позиция popover устареет — проще закрыть.
    window.addEventListener('resize', handleScrollOrResize)
    window.addEventListener('scroll', handleScrollOrResize, true)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
      window.removeEventListener('resize', handleScrollOrResize)
      window.removeEventListener('scroll', handleScrollOrResize, true)
    }
  }, [onClose])

  return createPortal(
    <div
      className="dcr-deadline-popover"
      ref={rootRef}
      style={{ top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        type="date"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
      />
      <div className="dcr-deadline-popover-actions">
        {initial && (
          <button type="button" className="dcr-deadline-btn dcr-deadline-btn-clear" onClick={() => onSave('')}>
            Очистить
          </button>
        )}
        <button type="button" className="dcr-deadline-btn dcr-deadline-btn-cancel" onClick={onClose}>
          Отмена
        </button>
        <button
          type="button"
          className="dcr-deadline-btn dcr-deadline-btn-save"
          onClick={() => onSave(value)}
          disabled={!value && !initial}
        >
          Сохранить
        </button>
      </div>
    </div>,
    document.body
  )
}

// Выбор в узкой ячейке: нативный select не переносит текст, и длинное значение
// («Доп. работы по текущему договору») обрезалось. Видимая плашка — обычный
// текст с переносом; сам select лежит поверх прозрачным слоем, поэтому клик,
// клавиатура и экранный диктор работают с настоящим select, как раньше.
function WrapSelect({ faceClassName, label, children, ...selectProps }) {
  return (
    <span className="dcr-wrap-select">
      <span className={`${faceClassName} dcr-wrap-select-face`} aria-hidden="true">
        {label}
        <svg className="dcr-wrap-select-chev" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 4.5 6 7.5 9 4.5" />
        </svg>
      </span>
      <select className="dcr-wrap-select-native" {...selectProps}>{children}</select>
    </span>
  )
}

// Отказ записи договора / ДС / подразделения: нет колонок — подсказка про миграцию, а не сырой текст.
function dcLinkSaveError(err, what) {
  const msg = String(err?.message || err)
  if (err?.code === 'PGRST204' || err?.code === '42703' || /contract_id|amendment_id|division/.test(msg)) {
    return `Не удалось сохранить ${what}: в базе не применена миграция 20261109_contracts_dc_requests.`
  }
  return `Ошибка сохранения (${what}): ${msg}`
}

// Договор заявки в таблице (миграция 20261109): с правом правки — выбор из договоров контрагента заявки (объект
// заявки выбран — только по нему и без объекта), без права — номер договора ссылкой на его карточку. contracts = null
// — договоры ещё грузятся.
function DcContractCell({ req, contracts, contractsById, parties, canEdit, onChange }) {
  const current = req.contract_id ? contractsById.get(req.contract_id) : null
  const currentText = req.contract_id ? (current ? contractLabel(current) : 'договор не найден') : null
  if (!canEdit || !contracts) {
    if (!req.contract_id) return <span className="muted-dash">—</span>
    return current
      ? <a className="dcr-contract-link ui-num-wrap" href={`/contracts/${current.id}`} target="_blank" rel="noopener noreferrer"
           title="Открыть карточку договора в новой вкладке">{currentText}</a>
      : <span className="muted-dash" title="Договор удалён из реестра или недоступен">{currentText}</span>
  }
  const choices = contractChoicesFor(contracts, req.counterparty_id, req.object_id, parties)
  if (!choices.length && !req.contract_id) {
    return (
      <span className="dcr-contract-none" title={req.object_id
        ? 'У контрагента заявки нет договоров по этому объекту в реестре «Договоры и ДС»'
        : 'У контрагента заявки нет договоров в реестре «Договоры и ДС»'}>нет договоров</span>
    )
  }
  return (
    <>
      <WrapSelect
        faceClassName={`dcr-material-select dcr-contract-select${req.contract_id ? '' : ' is-empty'}`}
        label={currentText || 'Выбрать'}
        value={req.contract_id || ''}
        onChange={(e) => onChange(e.target.value || null)}
        title={currentText ? `Договор ${currentText} — нажмите, чтобы сменить` : 'Выбрать договор из реестра «Договоры и ДС»'}
        aria-label="Договор заявки"
      >
        <option value="">Не выбран</option>
        {/* Выбранный раньше договор другого объекта виден, но выбрать его снова нельзя. */}
        {req.contract_id && !choices.some(c => c.id === req.contract_id) && (
          <option value={req.contract_id} disabled>
            {currentText}{current && req.object_id && current.object_id && current.object_id !== req.object_id ? ' · другой объект' : ''}
          </option>
        )}
        {choices.map(c => (
          <option key={c.id} value={c.id}>
            {contractLabel(c)}{req.object_id && !c.object_id ? ' · объект не указан' : ''}
          </option>
        ))}
      </WrapSelect>
      {current && (
        <a className="dcr-contract-open" href={`/contracts/${current.id}`} target="_blank" rel="noopener noreferrer"
           title="Открыть карточку договора в новой вкладке" aria-label={`Открыть договор ${currentText}`}>
          <IconLink size={12} />
        </a>
      )}
    </>
  )
}

// «Занесена в ДС» под номером ДС: ДС реестра, в которое занесена заявка (ссылкой), а если не занесена, но у
// договора есть ДС с тем же номером, — с правом правки «связать». Остальное — в форме заявки.
function DcAmendmentMark({ req, contracts, contractsById, canEdit, onLink }) {
  if (req.amendment_id) {
    const doc = contractsById.get(req.amendment_id)
    return (
      <a className="dcr-in-ds" href={`/contracts/${req.amendment_id}`} target="_blank" rel="noopener noreferrer"
         title={`Заявка занесена в ${doc ? amendmentLabel(doc) : 'ДС'} — открыть в новой вкладке`}>
        <IconCheckMark size={11} /> в ДС
      </a>
    )
  }
  if (!canEdit || !contracts || !req.contract_id) return null
  const match = matchAmendment(req.ds_number, amendmentsOf(contracts, req.contract_id))
  if (!match) return null
  return (
    <button type="button" className="dcr-in-ds-link" onClick={() => onLink(match.id)}
      title={`В реестре договоров есть ${amendmentLabel(match)} этого договора — отметить, что заявка занесена в него`}>
      связать с ДС
    </button>
  )
}

function formatBytes(bytes) {
  if (bytes == null) return ''
  if (bytes === 0) return '0 Б'
  const units = ['Б', 'КБ', 'МБ', 'ГБ']
  let v = Number(bytes)
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

// task 371: инлайн-ввод суммы с красивым форматированием.
//   В фокусе — «сырое» число для редактирования, вне фокуса — «1 000 000,00».
//   Сумма может быть отрицательной (ДС на уменьшение стоимости): минус первым символом.
const AMOUNT_INPUT_HINT = 'Уменьшение стоимости — со знаком минус'
const liveAmount = (raw) => formatAmountLive(raw, { allowNegative: true })
function AmountCellInput({ value, disabled, onSave }) {
  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState('')
  // Вне фокуса — с фикс. 2 знаками; в фокусе — «живой» формат (разряды пробелами).
  const display = focused ? draft : (value != null ? formatAmount(value) : '')
  return (
    <input
      type="text"
      inputMode="decimal"
      className="dcr-amount-input"
      value={display}
      disabled={disabled}
      placeholder="—"
      title={AMOUNT_INPUT_HINT}
      onFocus={() => { setFocused(true); setDraft(value != null ? liveAmount(String(value)) : '') }}
      onChange={(e) => setDraft(liveAmount(e.target.value))}
      onBlur={() => { setFocused(false); onSave(draft) }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
    />
  )
}

// «Комментарий» к статусу ОКС: правится прямо в ячейке, сохраняется при уходе из поля (Ctrl+Enter — тоже),
// Esc — отменить правку. Пока запись идёт, в поле — записываемый текст, а не прежний.
// missing — у проверки нужен комментарий (номер письма, срок…), а его нет: поле подсвечено.
const SUBMISSION_COMMENT_MAX = 2000 // ограничение в базе (миграция 20261108)
function SubmissionCommentInput({ value, hint, missing, onSave }) {
  const [draft, setDraft] = useState(null)
  const [pending, setPending] = useState(null)
  const cancelRef = useRef(false)
  return (
    <textarea
      className={`dcr-sub-comment${missing ? ' is-missing' : ''}`}
      rows={2}
      maxLength={SUBMISSION_COMMENT_MAX}
      value={draft ?? pending ?? (value || '')}
      placeholder={hint || '—'}
      title={missing ? `Укажите в комментарии: ${hint.toLowerCase()}` : undefined}
      aria-label={hint ? `Комментарий к статусу ОКС: ${hint.toLowerCase()}` : 'Комментарий к статусу ОКС'}
      onFocus={() => { cancelRef.current = false; setDraft(value || '') }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={async (e) => {
        const next = e.target.value
        setDraft(null)
        if (cancelRef.current) return
        setPending(next)
        try { await onSave(next) } finally { setPending(null) }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { cancelRef.current = true; e.currentTarget.blur() }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.blur()
      }}
    />
  )
}

function DcRequestsPage() {
  const { userProfile, canEdit, isAdmin, isSuperAdmin, role, scopedObjectIds } = useRole()
  // Всплывающие списки фильтров и окошко срока рисуются в <body>.
  useBodyClass('ui-work-portal')
  // Телефон: список заявок рендерим карточками вместо широкой таблицы
  const isPhone = useIsPhone()
  // task 333: гейт add/edit/delete и inline-editing на этой странице.
  // Сам факт показа страницы контролируется EmployeeLayout (по App.jsx).
  const canEditDc = canEdit('dc_requests')
  // Пока заявка на сверке с договором, двигать её дальше может только юрист:
  // это его этап, и решение «соответствует договору» принимает он. Остальные
  // статусы переключает любой, у кого есть право на раздел.
  const canLeaveContractCheck = isAdmin || isSuperAdmin || role === 'lawyer'
  const canChangeStatus = (currentStatus) => (
    canEditDc && (currentStatus !== 'contract_check' || canLeaveContractCheck)
  )

  const [requests, setRequests] = useState([])
  const [objects, setObjects] = useState([])
  const [counterparties, setCounterparties] = useState([])
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(false)
  // Заявки хоть раз загружены: «Загрузка…» вместо таблицы — только до этого. Перечитывание после правки таблицу
  // не убирает — иначе страница прыгала наверх.
  const [requestsLoaded, setRequestsLoaded] = useState(false)

  // Вкладка, поиск, фильтры и раскрытые списки файлов — как были до обновления страницы (utils/dcRequestView.js).
  const [savedView] = useState(() => readDcView(sessionStore(), TABS.map(t => t.key)))
  const [activeTab, setActiveTab] = useState(savedView.tab)

  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [formData, setFormData] = useState(EMPTY_FORM)
  // task 434: пока идёт запись, форма заблокирована — иначе повторный клик по
  // «Добавить» успевал создать вторую заявку до закрытия модалки.
  // Состояние — для вида кнопок, ref — для самой защиты: два быстрых клика могут
  // попасть в один рендер, и оба обработчика увидели бы saving === false.
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  // id заявки, чей путь только что скопирован — на пару секунд меняем иконку.
  const [copiedPathId, setCopiedPathId] = useState(null)
  // Инлайн-правка пути к папке прямо в таблице: { id, draft } | null.
  const [pathEdit, setPathEdit] = useState(null)
  const [savingPath, setSavingPath] = useState(false)
  // task 314: поиск контрагента в модалке.
  const [cpSearch, setCpSearch] = useState('')
  const [cpDropdownOpen, setCpDropdownOpen] = useState(false)
  // Активный пункт списка для навигации клавишами ↑/↓/Enter.
  const [cpHighlight, setCpHighlight] = useState(0)
  // task 365 + 366: какая заявка сейчас в inline-popover для редактирования срока,
  //   и куда привязан popover (rect триггерной кнопки). Popover рендерится через
  //   portal, поэтому anchor нужен для расчёта fixed-координат.
  const [deadlinePopover, setDeadlinePopover] = useState(null) // { id, rect } | null

  const [searchQuery, setSearchQuery] = useState(savedView.search)
  // Фильтры в тулбаре: множественный выбор (пустой массив = фильтр не применён).
  const [filterStatuses, setFilterStatuses] = useState(savedView.statuses)
  const [filterObjectIds, setFilterObjectIds] = useState(savedView.objects)
  const [filterCounterpartyIds, setFilterCounterpartyIds] = useState(savedView.counterparties)
  const [filterResponsibleIds, setFilterResponsibleIds] = useState(savedView.responsibles)
  // История изменений: заявка, чья история открыта (или null) + её записи.
  const [historyFor, setHistoryFor] = useState(null)
  const [historyRows, setHistoryRows] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  // Фильтр по подразделению (коды подразделений ВОР, NO_VOR_DIVISION — «Не указано»).
  const [filterDivisions, setFilterDivisions] = useState(savedView.divisions)
  // Договоры и ДС реестра «Договоры и ДС» для выбора договора заявки (миграция 20261109): живые документы
  // и стороны договоров с несколькими контрагентами. null — ещё не загружены (автоподстановка ждёт).
  const [contracts, setContracts] = useState(null)
  const [contractParties, setContractParties] = useState(() => new Map())
  // Договор и ДС в форме выбраны руками — больше не подставляются сами.
  const [linkTouched, setLinkTouched] = useState({ contract: false, amendment: false })
  const contractsById = useMemo(() => new Map((contracts || []).map(c => [c.id, c])), [contracts])
  // Колонки договора, ДС и подразделения — когда они есть в базе (миграция 20261109): select * их отдаёт.
  const linkEnabled = requests.some(r => r.contract_id !== undefined)

  // task 310 — статус в виде клик-попапа. statusPopoverUp — открыть вверх: внизу блока таблицы меню не помещается
  // (таблица прокручивается в своём блоке под закреплённой шапкой).
  const [statusPopoverFor, setStatusPopoverFor] = useState(null)
  const [statusPopoverUp, setStatusPopoverUp] = useState(false)
  const toggleStatusPopover = (e, reqId) => {
    if (statusPopoverFor === reqId) { setStatusPopoverFor(null); return }
    const chip = e.currentTarget.getBoundingClientRect()
    const box = e.currentTarget.closest('.table-container')?.getBoundingClientRect()
    const below = box ? box.bottom - chip.bottom : Infinity
    setStatusPopoverUp(below < STATUS_POPOVER_SPACE && chip.top - box.top > below)
    setStatusPopoverFor(reqId)
  }

  // Окно «Результат проверки по договору»:
  //   { requestId, nextStatus, verdict, notes } | null
  // nextStatus — статус, на который переключались, когда результат ещё не был
  // зафиксирован: сохраняем исход и сразу двигаем заявку дальше.
  const [verdictModal, setVerdictModal] = useState(null)
  const [verdictSaving, setVerdictSaving] = useState(false)

  // task 310 — документы заявки.
  // docsByReq: Map<requestId, s3_documents[]>
  const [docsByReq, setDocsByReq] = useState(() => new Map())
  // Файлы загружены (или загрузка не удалась) — до этого ссылку ?file= из выгрузки не разбираем.
  const [docsLoaded, setDocsLoaded] = useState(false)
  // Растёт при каждой своей загрузке и удалении файла: список с сервера, прочитанный до этого, устарел и
  // затёр бы только что приложенный файл.
  const docsEpochRef = useRef(0)
  const docsReadAtRef = useRef(0)
  const [expandedDocs, setExpandedDocs] = useState(() => new Set(savedView.expanded))
  // Модалка загрузки документа: { requestId, file, description } | null
  const [docUpload, setDocUpload] = useState(null)
  const [docUploadBusy, setDocUploadBusy] = useState(false)
  // Документ открытый в превью (S3DocumentPreview).
  const [previewDoc, setPreviewDoc] = useState(null)
  // Ссылка на файл из выгрузки в Excel: /dc-requests?file=<id s3_documents>.
  const [searchParams, setSearchParams] = useSearchParams()
  const fileParam = searchParams.get(DC_FILE_PARAM)
  // «Документы раздела» — окно с материалами (шаблон «Было-Стало»), как у тендеров.
  const [showSectionDocs, setShowSectionDocs] = useState(false)

  // task 324: ссылка на общую таблицу с отделами. Хранится в app_settings
  // под ключом 'dc_requests_external_link'. Редактируется через модалку.
  const [externalLink, setExternalLink] = useState('')
  const [showLinkModal, setShowLinkModal] = useState(false)
  const [linkInput, setLinkInput] = useState('')

  useEffect(() => {
    fetchRequests()
    fetchObjects()
    fetchCounterparties()
    fetchContacts()
    fetchAllDocs()
    fetchExternalLink()
    fetchContracts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    writeDcView({
      tab: activeTab, search: searchQuery, statuses: filterStatuses, objects: filterObjectIds,
      counterparties: filterCounterpartyIds, responsibles: filterResponsibleIds, divisions: filterDivisions,
      expanded: [...expandedDocs],
    })
  }, [activeTab, searchQuery, filterStatuses, filterObjectIds, filterCounterpartyIds, filterResponsibleIds, filterDivisions, expandedDocs])

  // Прокрутку возвращаем, когда высота строк окончательная: заявки, их файлы и договоры (подписи договоров).
  // На компьютере прокручивается таблица под закреплённой шапкой, на телефоне — страница.
  const pageRef = useScrollMemory(DC_SCROLL_KEY, requestsLoaded && docsLoaded && contracts !== null, '.table-container')

  // Файлы, приложенные коллегами, — без обновления страницы: при возврате на вкладку браузера, не чаще раза в минуту.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || Date.now() - docsReadAtRef.current < 60000) return
      fetchAllDocs()
    }
    document.addEventListener('visibilitychange', onVisible)
    // fetchAllDocs из первой отрисовки годится: читает только ref и сеттеры.
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // Ссылка из карточки контрагента: /dc-requests?counterparty=<id> — реестр сразу с фильтром по контрагенту
  // (прочие фильтры и поиск, оставшиеся с прошлого раза, сняты — иначе заявки контрагента могли не показаться).
  const counterpartyParam = searchParams.get('counterparty')
  useEffect(() => {
    if (!counterpartyParam) return
    setFilterCounterpartyIds([counterpartyParam])
    setFilterStatuses([])
    setFilterObjectIds([])
    setFilterResponsibleIds([])
    setFilterDivisions([])
    setSearchQuery('')
    setActiveTab('all')
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('counterparty')
      return next
    }, { replace: true })
  }, [counterpartyParam, setSearchParams])

  // Закрытие попапа статуса по клику вне его.
  useEffect(() => {
    if (!statusPopoverFor) return
    const onMousedown = (e) => {
      if (!e.target.closest('.dcr-status-wrap')) setStatusPopoverFor(null)
    }
    // Откладываем на тик, чтобы открывающий клик не закрыл попап мгновенно.
    const t = setTimeout(() => document.addEventListener('mousedown', onMousedown), 0)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', onMousedown) }
  }, [statusPopoverFor])

  // Ссылка из выгрузки в Excel открывает файл в окне просмотра (не PDF и не картинка — там же «Скачать»).
  // Файл — только заявки из реестра этого пользователя (с учётом его объектов). Параметр убираем сразу,
  // чтобы обновление страницы не открывало окно снова.
  useEffect(() => {
    if (!fileParam || !requestsLoaded || loading || !docsLoaded) return
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete(DC_FILE_PARAM)
      return next
    }, { replace: true })
    const doc = [...docsByReq.values()].flat().find(d => d.id === fileParam)
    if (!doc || !requests.some(r => r.id === doc.owner_id)) {
      alert('Файл не найден: его удалили или заявка вам недоступна.')
      return
    }
    setExpandedDocs(prev => new Set(prev).add(doc.owner_id))
    setPreviewDoc(doc)
  }, [fileParam, requestsLoaded, loading, docsLoaded, docsByReq, requests, setSearchParams])

  const fetchRequests = async () => {
    try {
      setLoading(true)
      // Постранично: без .range() PostgREST отдаёт первые 1000 строк, и пропадали бы самые новые заявки.
      const data = await fetchAllRows((from, to) => {
        let query = db
          .from('dc_requests')
          .select(`
            *,
            objects(id, name),
            counterparties(id, name),
            responsible:contacts!responsible_contact_id(id, full_name),
            dc_request_tasks(id, task_text, response_text, is_completed, order_number, created_at, created_by_name, responded_by_name, responded_at)
          `)
        // Скоуп по объектам: сотрудник видит только заявки своих объектов.
        if (scopedObjectIds.length > 0) query = query.in('object_id', scopedObjectIds)
        // task 325: хронология добавления — старые сверху, новые внизу. «№» — постоянный номер
        // заявки (withRequestNumbers), а не номер строки: при смене вкладки и фильтров не меняется.
        return query.order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to)
      })
      const sorted = data.map(r => ({
        ...r,
        dc_request_tasks: (r.dc_request_tasks || []).sort(
          (a, b) => (a.order_number || 0) - (b.order_number || 0)
        ),
      }))
      setRequests(withRequestNumbers(sorted))
    } catch (err) {
      console.error('Ошибка загрузки заявок на ДС:', err.message)
    } finally {
      setLoading(false)
      setRequestsLoaded(true)
    }
  }

  const fetchObjects = async () => {
    // Оба отдела: основное строительство И гарантийный отдел. Сортируем по статусу
    // ('main_construction' < 'warranty_service'), затем по имени — в пикере ОС идут первыми.
    const { data, error } = await db
      .from('objects')
      .select('id, name, status')
      .order('status', { ascending: true })
      .order('name', { ascending: true })
    if (!error) setObjects(data || [])
  }

  const fetchCounterparties = async () => {
    // Постранично: PostgREST отдаёт максимум 1000 строк, а контрагентов уже больше —
    // без пагинации обрезался хвост сортировки по названию (буква «Ф» и далее,
    // из-за чего не находился «Фортекс»). Тай-брейк по id: имена неуникальны.
    const PAGE = 1000
    const rows = []
    try {
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await db
          .from('counterparties')
          .select('id, name, inn')
          .is('deleted_at', null)   // удалённых не предлагаем к выбору
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

  const fetchContacts = async () => {
    const { data, error } = await db
      .from('contacts')
      .select('id, full_name')
      .order('full_name', { ascending: true })
    if (!error) setContacts(data || [])
  }

  // Договоры и ДС для выбора договора заявки: только нужные колонки, удалённые не предлагаются. Сбой — заявки
  // работают, договор выбрать нельзя (в форме — подсказка).
  const fetchContracts = async () => {
    try {
      const page = (table, cols, filter = (q) => q) => fetchAllRowsParallel((from, to, withCount) => filter(db
        .from(table)
        .select(cols, withCount ? { count: 'exact' } : undefined))
        .order('id', { ascending: true })
        .range(from, to))
      const [docs, parties] = await Promise.all([
        page('contracts', 'id, display_id, record_type, deleted_at, status, counterparty_id, object_id, contract_number, contract_date, parent_contract_id, root_contract_id',
          (q) => q.is('deleted_at', null)),
        page('contract_counterparties', 'id, contract_id, counterparty_id').catch(() => []),
      ])
      const byContract = new Map()
      for (const p of parties) {
        if (!byContract.has(p.contract_id)) byContract.set(p.contract_id, new Set())
        byContract.get(p.contract_id).add(p.counterparty_id)
      }
      setContractParties(byContract)
      setContracts(docs)
    } catch (err) {
      console.error('Ошибка загрузки договоров для заявок на ДС:', err?.message || err)
      setContracts([])
    }
  }

  // task 324: ссылка на общую таблицу с отделами.
  const fetchExternalLink = async () => {
    try {
      const { data, error } = await db
        .from('app_settings')
        .select('value')
        .eq('key', 'dc_requests_external_link')
        .maybeSingle()
      if (error) throw error
      setExternalLink(data?.value || '')
    } catch (err) {
      console.warn('Не удалось загрузить ссылку на общую таблицу (app_settings?):', err.message)
      setExternalLink('')
    }
  }

  const openLinkEditor = () => {
    setLinkInput(externalLink || '')
    setShowLinkModal(true)
  }

  const saveExternalLink = async (e) => {
    e.preventDefault()
    const value = linkInput.trim() || null
    try {
      const { error } = await db
        .from('app_settings')
        .upsert({ key: 'dc_requests_external_link', value, updated_at: new Date().toISOString() })
      if (error) throw error
      setExternalLink(value || '')
      setShowLinkModal(false)
    } catch (err) {
      alert('Не удалось сохранить ссылку: ' + (err.message || err))
    }
  }

  // Все документы всех заявок — в Map по owner_id. Постранично: без .range() PostgREST отдаёт первые 1000 строк, и
  // когда файлов заявок стало больше (15.10.2026 — 892, 27.10 — за тысячу), самые новые после обновления страницы
  // пропадали из реестра, хотя в базе и хранилище были.
  // Пока читали, свой файл загрузили или удалили — список устарел, читаем заново (иначе он затёр бы этот файл).
  const fetchAllDocs = async () => {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const epoch = docsEpochRef.current
        const startedAt = Date.now()
        // Хронологический порядок: первый загруженный — наверху, новые — снизу.
        const rows = await fetchAllRowsParallel((from, to, withCount) => db
          .from('s3_documents')
          .select('*', withCount ? { count: 'exact' } : undefined)
          .eq('owner_type', 'dc_request')
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to))
        if (docsEpochRef.current !== epoch) continue
        docsReadAtRef.current = startedAt
        setDocsByReq(groupDocsByRequest(rows))
        return
      }
    } catch (err) {
      console.error('Ошибка загрузки документов заявок:', err.message)
    } finally {
      setDocsLoaded(true)
    }
  }

  // Договор и ДС формы подставляются сами, пока их не выбрали руками: договор — единственный договор контрагента
  // по объекту, ДС — ДС этого договора с тем же номером, что «№ ДС». Договор не того контрагента и ДС не того
  // договора снимаются. Пока договоры не загрузились, форма ничего не подставляет и не снимает.
  const withAutoLinks = (next, touched = linkTouched) => {
    if (!contracts) return next
    const out = { ...next }
    const choices = contractChoicesFor(contracts, out.counterparty_id, out.object_id, contractParties)
    let contractTouched = touched.contract
    if (out.contract_id && !choices.some(c => c.id === out.contract_id)) { out.contract_id = ''; contractTouched = false }
    if (!contractTouched) out.contract_id = autoContractFor(contracts, out.counterparty_id, out.object_id, contractParties)?.id || ''
    const amendments = amendmentsOf(contracts, out.contract_id)
    if (out.amendment_id && !amendments.some(a => a.id === out.amendment_id)) out.amendment_id = ''
    if (!touched.amendment) out.amendment_id = matchAmendment(out.ds_number, amendments)?.id || ''
    return out
  }
  const updateForm = (patch, touched = linkTouched) => setFormData(prev => withAutoLinks({ ...prev, ...patch }, touched))

  const handleInputChange = (e) => {
    const { name, value } = e.target
    if (name === 'contract_id' || name === 'amendment_id') {
      const touched = { ...linkTouched, [name === 'contract_id' ? 'contract' : 'amendment']: true }
      setLinkTouched(touched)
      updateForm({ [name]: value }, touched)
      return
    }
    if (name === 'ds_number') { updateForm({ ds_number: value }); return }
    setFormData(prev => ({ ...prev, [name]: value }))
  }

  const handleAddNew = () => {
    setEditing(null)
    setLinkTouched({ contract: false, amendment: false })
    setFormData(EMPTY_FORM)
    setCpSearch('')
    setCpDropdownOpen(false)
    setShowModal(true)
  }

  const handleEdit = (req) => {
    setEditing(req)
    setFormData({
      object_id: req.object_id || '',
      counterparty_id: req.counterparty_id || '',
      ds_number: req.ds_number || '',
      works_description: req.works_description || '',
      responsible_contact_id: req.responsible_contact_id || '',
      folder_path: req.folder_path || '',
      status: req.status || 'contract_check',
      expected_approval_date: req.expected_approval_date || '', // task 365
      amount_before: req.amount_before != null ? String(req.amount_before) : '', // task 370
      amount_after: req.amount_after != null ? String(req.amount_after) : '', // task 370
      material_type: req.material_type || '', // task 370
      ds_type: req.ds_type || '',
      contract_id: req.contract_id || '',
      amendment_id: req.amendment_id || '',
      division: req.division || '',
    })
    // Уже выбранные договор и ДС сами не меняются; пустые — подставятся при правке контрагента, объекта, № ДС.
    setLinkTouched({ contract: !!req.contract_id, amendment: !!req.amendment_id })
    setCpSearch(req.counterparties?.name || '')
    setCpDropdownOpen(false)
    setShowModal(true)
  }

  // Путь в буфер — для тех, у кого нет помощника «Открыть папку» (FolderOpen.jsx): сам браузер на file:// и UNC
  // со страницы по https не переходит, путь вставляют в адресную строку проводника.
  const handleCopyFolderPath = async (reqId, path) => {
    const ok = await copyToClipboard(path)
    if (!ok) { alert('Не удалось скопировать путь. Выделите его и скопируйте вручную.'); return }
    setCopiedPathId(reqId)
    setTimeout(() => setCopiedPathId(prev => (prev === reqId ? null : prev)), 2000)
  }

  const handleSelectCp = (cp) => {
    updateForm({ counterparty_id: cp.id })
    setCpSearch(cp.name || '')
    setCpDropdownOpen(false)
  }

  // Поиск контрагента: сначала совпадения С НАЧАЛА названия/ИНН, потом любые вхождения —
  // при 1000+ контрагентах это выводит нужного наверх (набрал «форт» → «Фортекс» первым).
  const cpMatches = useMemo(() => {
    const q = cpSearch.trim().toLowerCase()
    if (!q) return counterparties
    const starts = []
    const contains = []
    for (const cp of counterparties) {
      const name = (cp.name || '').toLowerCase()
      const inn = (cp.inn || '').toLowerCase()
      if (name.startsWith(q) || inn.startsWith(q)) starts.push(cp)
      else if (name.includes(q) || inn.includes(q)) contains.push(cp)
    }
    return [...starts, ...contains]
  }, [counterparties, cpSearch])

  const cpVisible = cpMatches.slice(0, CP_SEARCH_LIMIT)

  // При изменении запроса подсветку возвращаем на первый пункт.
  useEffect(() => { setCpHighlight(0) }, [cpSearch])

  // ── История изменений ──────────────────────────────────────────────────────
  // Универсальная запись в аудит-лог (по образцу logContractEvent). Ошибки глотаем:
  // сбой логирования не должен ломать саму правку заявки.
  const logDcEvent = async (dcRequestId, eventType, payload = {}) => {
    if (!dcRequestId || !eventType) return
    try {
      await db.from('dc_request_audit_log').insert([{
        dc_request_id: dcRequestId,
        event_type: eventType,
        field_name: payload.fieldName || null,
        old_value: payload.oldValue ?? null,
        new_value: payload.newValue ?? null,
        description: payload.description || null,
        changed_by_role: localStorage.getItem('userRole') || null,
        changed_by_name: userProfile?.full_name || null,
      }])
    } catch (err) {
      console.error('Ошибка записи истории заявки:', err.message)
    }
  }

  // Человекочитаемое значение поля: id → имя, суммы/даты/словари → как в интерфейсе.
  const auditValueText = useCallback((field, value) => {
    if (value === null || value === undefined || value === '') return '—'
    switch (field) {
      case 'object_id':
        return objects.find(o => o.id === value)?.name || String(value)
      case 'counterparty_id':
        return counterparties.find(c => c.id === value)?.name || String(value)
      case 'responsible_contact_id':
        return contacts.find(c => c.id === value)?.full_name || String(value)
      case 'status':
        return STATUS_LABEL[value] || String(value)
      case 'material_type':
        return MATERIAL_LABEL[value] || String(value)
      case 'check_status':
        return CHECK_STATUS_LABEL[value] || String(value)
      case 'ds_type':
        return DS_TYPE_LABEL[value] || String(value)
      case 'contract_id':
      case 'amendment_id': {
        const doc = contractsById.get(value)
        if (!doc) return 'документ реестра договоров'
        return field === 'amendment_id' ? amendmentLabel(doc) : contractLabel(doc)
      }
      case 'division':
        return VOR_DIVISION_LABEL[value] || String(value)
      case 'submission_check':
        return SUBMISSION_LABEL[value] || String(value)
      case 'expected_approval_date':
        return formatShortDate(value) || String(value)
      case 'amount_before':
      case 'amount_after':
        return `${formatAmount(Number(value))} ₽`
      default:
        return String(value)
    }
  }, [objects, counterparties, contacts, contractsById])

  // Открыть историю заявки (модалка, только чтение).
  const openHistory = async (req) => {
    setHistoryFor(req)
    setHistoryLoading(true)
    setHistoryRows([])
    try {
      const { data, error } = await db
        .from('dc_request_audit_log')
        .select('*')
        .eq('dc_request_id', req.id)
        .order('changed_at', { ascending: false })
      if (error) throw error
      setHistoryRows(data || [])
    } catch (err) {
      console.error('Ошибка загрузки истории заявки:', err.message)
    } finally {
      setHistoryLoading(false)
    }
  }

  // Одна запись «Поле: было → стало».
  const logFieldChange = (id, field, oldValue, newValue) => logDcEvent(id, 'field_updated', {
    fieldName: field,
    oldValue: oldValue ?? null,
    newValue: newValue ?? null,
    description: `${AUDIT_FIELD_LABEL[field] || field}: ${auditValueText(field, oldValue)} → ${auditValueText(field, newValue)}`,
  })

  const handleSubmit = async (e) => {
    e.preventDefault()
    // Защита от двойной отправки: между кликом и закрытием модалки успевает
    // пройти несколько запросов, и второй клик создавал дубль заявки.
    // Флаг снимаем в finally — иначе после ошибки форма осталась бы заблокирована.
    if (savingRef.current) return
    // Пикер объекта — кастомный (не native required), поэтому проверяем вручную.
    if (!formData.object_id) { alert('Выберите объект'); return }
    savingRef.current = true
    setSaving(true)
    try {
      const payload = {
        object_id: formData.object_id || null,
        counterparty_id: formData.counterparty_id || null,
        ds_number: formData.ds_number.trim() || null,
        works_description: formData.works_description.trim() || null,
        responsible_contact_id: formData.responsible_contact_id || null,
        folder_path: formData.folder_path.trim() || null,
        expected_approval_date: formData.expected_approval_date || null, // task 365
        amount_before: parseAmount(formData.amount_before), // task 370
        amount_after: parseAmount(formData.amount_after), // task 370
        material_type: formData.material_type || null, // task 370
        ds_type: formData.ds_type || null,
        // Колонки договора и подразделения — только если они уже есть в базе (миграция 20261109).
        ...(linkEnabled ? {
          contract_id: formData.contract_id || null,
          amendment_id: (formData.contract_id && formData.amendment_id) || null,
          division: formData.division || null,
        } : {}),
        updated_at: new Date().toISOString(),
      }
      if (editing) {
        // Статус в payload не кладём: им управляет только чип в таблице. Иначе
        // форма, открытая до смены статуса, вернула бы прежнее значение.
        const { error } = await db.from('dc_requests').update(payload).eq('id', editing.id)
        if (error) throw error
        // История: по одной записи на каждое реально изменившееся поле («было → стало»).
        // Пишем параллельно: последовательные await по каждому полю давали столько
        // же обращений к серверу, сколько правок, и модалка заметно подвисала.
        const auditWrites = []
        for (const field of Object.keys(AUDIT_FIELD_LABEL)) {
          // Поля, которых нет в payload (статус), форма не меняет — иначе
          // сравнение с undefined давало бы ложную запись «стало —».
          if (!(field in payload)) continue
          const before = editing[field] ?? null
          const after = payload[field] ?? null
          if (before === after) continue
          if (field === 'status') {
            auditWrites.push(logDcEvent(editing.id, 'status_changed', {
              fieldName: 'status',
              oldValue: before,
              newValue: after,
              description: `Статус: ${auditValueText('status', before)} → ${auditValueText('status', after)}`,
            }))
          } else {
            auditWrites.push(logFieldChange(editing.id, field, before, after))
          }
        }
        await Promise.all(auditWrites)
      } else {
        // .select('id') нужен, чтобы записать в историю событие создания.
        const { data, error } = await db.from('dc_requests').insert([{
          ...payload,
          // Новая заявка всегда идёт на сверку с договором — выбора нет.
          status: 'contract_check',
          created_by_name: userProfile?.full_name || null,
        }]).select('id').single()
        if (error) throw error
        await logDcEvent(data?.id, 'created', {
          description: `Заявка создана${payload.ds_number ? ` (№ ДС ${payload.ds_number})` : ''}`,
        })
      }
      setShowModal(false)
      setEditing(null)
      setFormData(EMPTY_FORM)
      fetchRequests()
    } catch (err) {
      alert('Ошибка сохранения: ' + (err.message || err))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  // task 365: быстрое сохранение ориентировочного срока согласования из inline-popover.
  const handleQuickSaveDeadline = async (id, newDate) => {
    const next = newDate || null
    const prev = requests.find(r => r.id === id)?.expected_approval_date ?? null
    try {
      const { error } = await db
        .from('dc_requests')
        .update({ expected_approval_date: next, updated_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
      if (prev !== next) await logFieldChange(id, 'expected_approval_date', prev, next)
      setDeadlinePopover(null)
      fetchRequests()
    } catch (err) {
      alert('Ошибка сохранения срока: ' + (err.message || err))
    }
  }

  // task 366: открыть popover, привязав его к BCR-кнопки-триггера.
  const openDeadlinePopover = (id, e) => {
    setDeadlinePopover({ id, rect: e.currentTarget.getBoundingClientRect() })
  }

  // Открыть окно результата: на просмотр/правку или как обязательный шаг перед
  // сменой статуса (nextStatus).
  const openVerdictModal = (req, nextStatus = null) => {
    setVerdictModal({
      requestId: req.id,
      nextStatus,
      verdict: hasVerdict(req) ? req.check_status : '',
      notes: req.check_result_notes || '',
    })
  }

  // Сохранение результата проверки. Исход обязателен: без него запись не имеет
  // смысла, а заявка не должна уходить со стадии сверки.
  const handleSaveVerdict = async () => {
    if (!verdictModal) return
    const req = requests.find(r => r.id === verdictModal.requestId)
    if (!req) { setVerdictModal(null); return }
    if (!verdictModal.verdict) {
      alert('Укажите исход проверки.')
      return
    }
    const notes = verdictModal.notes.trim() || null
    const prevVerdict = hasVerdict(req) ? req.check_status : 'not_checked'
    const prevNotes = req.check_result_notes ?? null
    const nextStatus = verdictModal.nextStatus
    const checkedAt = new Date().toISOString()
    const patch = {
      check_status: verdictModal.verdict,
      check_result_notes: notes,
      checked_by_name: userProfile?.full_name || null,
      checked_at: checkedAt,
      updated_at: checkedAt,
    }
    if (nextStatus) patch.status = nextStatus
    setVerdictSaving(true)
    try {
      const { error } = await db.from('dc_requests').update(patch).eq('id', req.id)
      if (error) throw error
      setRequests(prev => prev.map(r => r.id === req.id ? { ...r, ...patch } : r))
      if (prevVerdict !== verdictModal.verdict) {
        await logFieldChange(req.id, 'check_status', prevVerdict, verdictModal.verdict)
      }
      if ((prevNotes || '') !== (notes || '')) {
        await logFieldChange(req.id, 'check_result_notes', prevNotes, notes)
      }
      if (nextStatus && nextStatus !== (req.status ?? null)) {
        await logDcEvent(req.id, 'status_changed', {
          fieldName: 'status',
          oldValue: req.status ?? null,
          newValue: nextStatus,
          description: `Статус: ${auditValueText('status', req.status ?? null)} → ${auditValueText('status', nextStatus)}`,
        })
      }
      setVerdictModal(null)
    } catch (err) {
      // PGRST204 / «column … in the schema cache» — в базе нет колонок результата
      // проверки (миграция 20260912), 23514 — ограничение статусов без этапа
      // «Итог проверки» (миграция 20260907). Говорим, что применить, а не сырой текст.
      const msg = String(err?.message || err)
      if (err?.code === 'PGRST204' || /check_result_notes|checked_by_name|checked_at/.test(msg)) {
        alert('Не удалось сохранить результат проверки: в базе не применена миграция 20260912_dc_request_check_verdict. Обратитесь к администратору.')
      } else if (err?.code === '23514' && /status/.test(msg)) {
        alert('Не удалось перевести заявку на этап: в базе не применена миграция 20260907_dc_request_check_result. Обратитесь к администратору.')
      } else {
        alert('Ошибка сохранения результата проверки: ' + msg)
      }
    } finally {
      setVerdictSaving(false)
    }
  }

  const handleStatusChange = async (id, newStatus) => {
    const req = requests.find(r => r.id === id)
    const oldStatus = req?.status ?? null
    // Проверка не только на кнопке: попап мог остаться открытым с момента, когда
    // статус был другим, да и вызвать обработчик можно не только кликом.
    if (oldStatus === 'contract_check' && !canLeaveContractCheck) {
      alert('Сменить статус «Проверка по договору» может только юрист ОСП, администратор или суперпользователь.')
      return
    }
    // Уйти со сверки можно только с зафиксированным исходом — иначе по заявке
    // навсегда останется непонятно, чем проверка закончилась. Вместо отказа
    // сразу открываем окно результата и двигаем статус после сохранения.
    if (oldStatus === 'contract_check' && newStatus !== 'contract_check' && !hasVerdict(req)) {
      openVerdictModal(req, newStatus)
      return
    }
    try {
      const { error } = await db
        .from('dc_requests')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
      setRequests(prev => prev.map(r => r.id === id ? { ...r, status: newStatus } : r))
      if (oldStatus !== newStatus) {
        await logDcEvent(id, 'status_changed', {
          fieldName: 'status',
          oldValue: oldStatus,
          newValue: newStatus,
          description: `Статус: ${auditValueText('status', oldStatus)} → ${auditValueText('status', newStatus)}`,
        })
      }
    } catch (err) {
      alert('Ошибка смены статуса: ' + (err.message || err))
    }
  }

  // task 370: инлайн-сохранение суммы (Было/Стало) прямо из ячейки таблицы.
  // field ∈ 'amount_before' | 'amount_after'. Пустая строка → null.
  const handleSaveAmount = async (id, field, rawValue) => {
    const num = parseAmount(rawValue)
    const current = requests.find(r => r.id === id)
    if (current && (current[field] ?? null) === num) return // без изменений
    const prevValue = current?.[field] ?? null
    try {
      const { error } = await db
        .from('dc_requests')
        .update({ [field]: num, updated_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
      setRequests(prev => prev.map(r => r.id === id ? { ...r, [field]: num } : r))
      await logFieldChange(id, field, prevValue, num)
    } catch (err) {
      alert('Ошибка сохранения суммы: ' + (err.message || err))
    }
  }

  // task 371: инлайн-смена типа материала прямо из таблицы.
  const handleSaveMaterial = async (id, value) => {
    const next = value || null
    const prevValue = requests.find(r => r.id === id)?.material_type ?? null
    if (prevValue === next) return
    try {
      const { error } = await db
        .from('dc_requests')
        .update({ material_type: next, updated_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
      setRequests(prev => prev.map(r => r.id === id ? { ...r, material_type: next } : r))
      await logFieldChange(id, 'material_type', prevValue, next)
    } catch (err) {
      alert('Ошибка сохранения материала: ' + (err.message || err))
    }
  }

  // Тип ДС — инлайн-селектором под материалом, как и материал.
  const handleSaveDsType = async (id, value) => {
    const next = value || null
    const prevValue = requests.find(r => r.id === id)?.ds_type ?? null
    if (prevValue === next) return
    try {
      const { error } = await db
        .from('dc_requests')
        .update({ ds_type: next, updated_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
      setRequests(prev => prev.map(r => r.id === id ? { ...r, ds_type: next } : r))
      await logFieldChange(id, 'ds_type', prevValue, next)
    } catch (err) {
      const msg = String(err?.message || err)
      // 23514 — старое ограничение без новых типов, PGRST204/42703 — нет колонки.
      alert((err?.code === '23514' || err?.code === 'PGRST204' || err?.code === '42703' || /ds_type/.test(msg))
        ? 'Не удалось сохранить тип ДС: в базе не применена миграция 20260923_dc_requests_ds_type_values.'
        : 'Ошибка сохранения типа ДС: ' + msg)
    }
  }

  // Договор заявки из таблицы. ДС другого договора снимается; ДС нового договора с тем же номером, что «№ ДС»,
  // подставляется само. В историю — обе правки.
  const handleSaveContract = async (req, contractId) => {
    const next = contractId || null
    if ((req.contract_id ?? null) === next) return
    const amendments = amendmentsOf(contracts, next)
    const keep = req.amendment_id && amendments.some(a => a.id === req.amendment_id) ? req.amendment_id : null
    const nextAmendment = keep || matchAmendment(req.ds_number, amendments)?.id || null
    const patch = { contract_id: next, amendment_id: nextAmendment, updated_at: new Date().toISOString() }
    try {
      const { error } = await db.from('dc_requests').update(patch).eq('id', req.id)
      if (error) throw error
      setRequests(prev => prev.map(r => r.id === req.id ? { ...r, ...patch } : r))
      await logFieldChange(req.id, 'contract_id', req.contract_id ?? null, next)
      if ((req.amendment_id ?? null) !== nextAmendment) await logFieldChange(req.id, 'amendment_id', req.amendment_id ?? null, nextAmendment)
    } catch (err) {
      alert(dcLinkSaveError(err, 'договор'))
    }
  }

  const handleSaveAmendment = async (req, amendmentId) => {
    const next = amendmentId || null
    if ((req.amendment_id ?? null) === next) return
    try {
      const { error } = await db.from('dc_requests')
        .update({ amendment_id: next, updated_at: new Date().toISOString() })
        .eq('id', req.id)
      if (error) throw error
      setRequests(prev => prev.map(r => r.id === req.id ? { ...r, amendment_id: next } : r))
      await logFieldChange(req.id, 'amendment_id', req.amendment_id ?? null, next)
    } catch (err) {
      alert(dcLinkSaveError(err, 'ДС'))
    }
  }

  const handleSaveDivision = async (req, value) => {
    const next = value || null
    if ((req.division ?? null) === next) return
    try {
      const { error } = await db.from('dc_requests')
        .update({ division: next, updated_at: new Date().toISOString() })
        .eq('id', req.id)
      if (error) throw error
      setRequests(prev => prev.map(r => r.id === req.id ? { ...r, division: next } : r))
      await logFieldChange(req.id, 'division', req.division ?? null, next)
    } catch (err) {
      alert(dcLinkSaveError(err, 'подразделение'))
    }
  }

  // «Статус ОКС» и «Комментарий» — прямо из таблицы (миграция 20261108). Кто и когда сменил статус, ставит база
  // (триггер), поэтому строку берём из ответа, а не подставляем имя со страницы.
  const handleSaveSubmission = async (id, field, rawValue) => {
    const req = requests.find(r => r.id === id)
    if (!req) return
    const isCheck = field === 'submission_check'
    const next = isCheck ? (rawValue || SUBMISSION_DEFAULT) : (rawValue.trim() || null)
    const prevValue = isCheck ? submissionOf(req) : (req.submission_comment ?? null)
    if (prevValue === next) return
    try {
      const { data, error } = await db
        .from('dc_requests')
        .update({ [field]: next, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('submission_check, submission_comment, submission_by_name, submission_at')
        .single()
      if (error) throw error
      setRequests(prev => prev.map(r => r.id === id ? { ...r, ...data } : r))
      await logFieldChange(id, field, prevValue, next)
    } catch (err) {
      // PGRST204 / 42703 — колонок проверки в базе ещё нет.
      alert((err?.code === 'PGRST204' || err?.code === '42703')
        ? 'Не удалось сохранить статус ОКС: в базе не применена миграция 20261108_dc_request_submission_check.'
        : `Ошибка сохранения ${isCheck ? 'статуса ОКС' : 'комментария'}: ${err?.message || err}`)
    }
  }

  // Путь к папке правится прямо в таблице: открывать форму заявки ради одной
  // строки неудобно, а меняют её чаще, чем остальные поля.
  const handleSaveFolderPath = async (id, value) => {
    const next = value.trim() || null
    const prevValue = requests.find(r => r.id === id)?.folder_path ?? null
    if (prevValue === next) { setPathEdit(null); return }
    setSavingPath(true)
    try {
      const { error } = await db
        .from('dc_requests')
        .update({ folder_path: next, updated_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
      setRequests(prev => prev.map(r => r.id === id ? { ...r, folder_path: next } : r))
      await logFieldChange(id, 'folder_path', prevValue, next)
      setPathEdit(null)
    } catch (err) {
      alert('Ошибка сохранения пути: ' + (err.message || err))
    } finally {
      setSavingPath(false)
    }
  }

  // Soft-delete: заявка уходит во вкладку «Удаленные» (документы/задачи сохраняются).
  const handleDelete = async (id) => {
    if (!window.confirm('Переместить заявку в «Удаленные»?')) return
    try {
      const { error } = await db.from('dc_requests')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
      await logDcEvent(id, 'soft_deleted', { description: 'Заявка перемещена в «Удаленные»' })
      fetchRequests()
    } catch (err) {
      alert('Ошибка удаления: ' + (err.message || err))
    }
  }

  // Восстановление из «Удаленных» (доступно редактору).
  const handleRestore = async (id) => {
    try {
      const { error } = await db.from('dc_requests')
        .update({ deleted_at: null })
        .eq('id', id)
      if (error) throw error
      await logDcEvent(id, 'restored', { description: 'Заявка восстановлена из «Удаленных»' })
      fetchRequests()
    } catch (err) {
      alert('Ошибка восстановления: ' + (err.message || err))
    }
  }

  // Безвозвратное удаление — только администратор. Чистим S3-документы (нет FK-каскада).
  const handleHardDelete = async (id) => {
    if (!window.confirm('Удалить заявку безвозвратно? Все её задачи и документы также будут удалены.')) return
    try {
      const docs = docsByReq.get(id) || []
      for (const d of docs) {
        try { await deleteDocument(d) } catch { /* best effort */ }
      }
      const { error } = await db.from('dc_requests').delete().eq('id', id)
      if (error) throw error
      fetchRequests()
      fetchAllDocs()
    } catch (err) {
      alert('Ошибка удаления: ' + (err.message || err))
    }
  }

  const toggleDocsExpanded = (requestId) => {
    setExpandedDocs(prev => {
      const next = new Set(prev)
      if (next.has(requestId)) next.delete(requestId); else next.add(requestId)
      return next
    })
  }

  // Docs upload. task 370: category ∈ 'general' | 'final' — рабочий или итоговый документ.
  const handleDocPick = (requestId, category = 'general') => {
    const input = document.createElement('input')
    input.type = 'file'
    input.style.display = 'none'
    input.onchange = (e) => {
      const file = e.target.files?.[0]
      if (file) {
        setDocUpload({ requestId, file, description: '', category })
      }
    }
    document.body.appendChild(input)
    input.click()
    setTimeout(() => input.remove(), 1000)
  }

  const handleDocUploadConfirm = async () => {
    if (!docUpload) return
    setDocUploadBusy(true)
    try {
      const newDoc = await uploadFile({
        file: docUpload.file,
        ownerType: 'dc_request',
        ownerId: docUpload.requestId,
        notes: docUpload.description.trim() || null,
        category: docUpload.category || 'general', // task 370
      })
      // Файл виден сразу: локально добавляем в docsByReq (в конец — сохраняем хронологический порядок). Список с
      // сервера, который читался в это время, устарел — fetchAllDocs его не применит.
      docsEpochRef.current += 1
      setDocsByReq(prev => {
        const next = new Map(prev)
        const arr = (next.get(docUpload.requestId) || []).filter(d => d.id !== newDoc.id)
        next.set(docUpload.requestId, [...arr, newDoc])
        return next
      })
      setExpandedDocs(prev => new Set(prev).add(docUpload.requestId))
      setDocUpload(null)
    } catch (err) {
      alert('Ошибка загрузки: ' + (err.message || err))
    } finally {
      setDocUploadBusy(false)
    }
  }

  const handleDocDownload = async (doc) => {
    try {
      const { presigned_url } = await requestDownloadUrl(doc.s3_key, { fileName: doc.file_name, download: true })
      const a = document.createElement('a')
      a.href = presigned_url
      a.download = doc.file_name
      a.target = '_blank'
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (err) {
      alert('Ошибка скачивания: ' + (err.message || err))
    }
  }

  const handleDocDelete = async (doc) => {
    if (!window.confirm(`Удалить файл «${doc.file_name}»?`)) return
    try {
      await deleteDocument(doc)
      docsEpochRef.current += 1
      setDocsByReq(prev => {
        const next = new Map(prev)
        const arr = (next.get(doc.owner_id) || []).filter(d => d.id !== doc.id)
        if (arr.length > 0) next.set(doc.owner_id, arr)
        else next.delete(doc.owner_id)
        return next
      })
    } catch (err) {
      alert('Ошибка удаления: ' + (err.message || err))
    }
  }

  const isDeletedTab = activeTab === 'deleted'
  // Столбцы «Статус ОКС» и «Комментарий» — когда в базе есть их колонки (миграция 20261108).
  const submissionEnabled = hasSubmissionColumns(requests)

  // Фильтр по подразделению — когда колонка есть в базе; счётчики — по заявкам вкладки (без этого фильтра).
  const divisionFilterOn = linkEnabled && filterDivisions.length > 0
  const divisionCounts = (() => {
    const map = new Map()
    for (const r of requests) {
      if (isDeletedTab ? r.deleted_at == null : r.deleted_at != null) continue
      const key = r.division || NO_VOR_DIVISION
      map.set(key, (map.get(key) || 0) + 1)
    }
    return map
  })()

  // Фильтрация: таб (soft-delete) → статусы → объект → контрагент → ответственный → подразделение → поиск.
  // Выгрузка в Excel берёт этот же список, поэтому при нескольких выбранных
  // статусах в файл попадают заявки всех этих статусов.
  const filtered = requests
    .filter(r => isDeletedTab
      ? r.deleted_at != null
      : (r.deleted_at == null && (activeTab === 'all' || (r.status || 'in_work') === activeTab)))
    .filter(r => filterStatuses.length === 0 || filterStatuses.includes(r.status || 'in_work'))
    .filter(r => filterObjectIds.length === 0 || filterObjectIds.includes(r.object_id))
    .filter(r => filterCounterpartyIds.length === 0 || filterCounterpartyIds.includes(r.counterparty_id))
    .filter(r => filterResponsibleIds.length === 0 || filterResponsibleIds.includes(r.responsible_contact_id))
    .filter(r => !divisionFilterOn || filterDivisions.includes(r.division || NO_VOR_DIVISION))
    .filter(r => {
      const q = searchQuery.trim().toLowerCase()
      if (!q) return true
      return (
        matchesRequestNo(r, q) ||
        (r.objects?.name || '').toLowerCase().includes(q) ||
        (r.counterparties?.name || '').toLowerCase().includes(q) ||
        (r.ds_number || '').toLowerCase().includes(q) ||
        (contractsById.get(r.contract_id)?.contract_number || '').toLowerCase().includes(q) ||
        (r.works_description || '').toLowerCase().includes(q)
      )
    })

  const counts = {
    all: requests.filter(r => r.deleted_at == null).length,
    contract_check: requests.filter(r => r.deleted_at == null && r.status === 'contract_check').length,
    check_result: requests.filter(r => r.deleted_at == null && r.status === 'check_result').length,
    in_work: requests.filter(r => r.deleted_at == null && (r.status || 'in_work') === 'in_work').length,
    completed: requests.filter(r => r.deleted_at == null && r.status === 'completed').length,
    deleted: requests.filter(r => r.deleted_at != null).length,
  }

  // В таблице contacts один сотрудник может встречаться несколько раз
  // (по записи на каждый объект). В UI показываем по одной строке на ФИО.
  const dedupedContacts = (() => {
    const seen = new Set()
    return contacts.filter(c => {
      const key = (c.full_name || '').trim().toLowerCase()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
  })()

  // Любой id контакта → «представитель» (первый id с тем же ФИО), который и есть в
  // dedupedContacts. Иначе сохранённый ответственный из non-first дубля не совпадёт
  // ни с одной опцией селекта и покажется «Не назначен» (хотя в таблице виден).
  const contactRepById = (() => {
    const nameToRep = new Map(dedupedContacts.map(c => [(c.full_name || '').trim().toLowerCase(), c.id]))
    const m = {}
    for (const c of contacts) {
      m[c.id] = nameToRep.get((c.full_name || '').trim().toLowerCase()) || c.id
    }
    return m
  })()

  // Фильтр ответственных — только те сотрудники, что реально назначены хотя бы на одну заявку.
  const usedResponsibleIds = new Set(
    requests.map(r => r.responsible_contact_id).filter(Boolean)
  )
  const responsibleFilterOptions = dedupedContacts.filter(c => usedResponsibleIds.has(c.id))

  // task 371: фильтр по контрагентам — только те, что реально фигурируют в заявках.
  const counterpartyFilterOptions = (() => {
    const byId = new Map()
    for (const r of requests) {
      if (r.counterparties?.id && !byId.has(r.counterparties.id)) {
        byId.set(r.counterparties.id, r.counterparties)
      }
    }
    return [...byId.values()].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'))
  })()

  // task 370: выгрузка текущей выборки (с учётом вкладки/фильтров/поиска) в Excel.
  const handleExportExcel = () => {
    if (filtered.length === 0) {
      alert('Нечего выгружать — список пуст.')
      return
    }
    const rows = filtered.map((req) => {
      const allDocs = docsByReq.get(req.id) || []
      const [generalCount, reportCount, finalCount] = DOC_SECTIONS.map(sec => allDocs.filter(sec.has).length)
      const tasks = req.dc_request_tasks || []
      const done = tasks.filter(t => t.is_completed).length
      const before = req.amount_before
      const after = req.amount_after
      const { diff, pct } = amountChange(before, after)
      return {
        '№': req.requestNo,
        'Объект': req.objects?.name || '',
        'Контрагент': req.counterparties?.name || '',
        'Материал': MATERIAL_LABEL[req.material_type] || '',
        'Тип ДС': DS_TYPE_LABEL[req.ds_type] || '',
        ...(linkEnabled ? { 'Договор': req.contract_id ? contractLabel(contractsById.get(req.contract_id)) || 'не найден' : '' } : {}),
        '№ ДС': req.ds_number || '',
        ...(linkEnabled ? {
          'Занесена в ДС': req.amendment_id ? (contractsById.get(req.amendment_id) ? amendmentLabel(contractsById.get(req.amendment_id)) : 'да') : '',
          'Подразделение': VOR_DIVISION_LABEL[req.division] || '',
        } : {}),
        'Описание ДС': req.works_description || '',
        'Было подано, ₽ (с НДС 22%)': before != null ? before : '',
        'Утверждено, ₽ (с НДС 22%)': after != null ? after : '',
        'Разница, ₽': diff != null ? diff : '',
        'Изменение, %': pct != null ? Number(pct.toFixed(2)) : '',
        'Статус': STATUS_LABEL[req.status || 'in_work'] || '',
        'Итог проверки': hasVerdict(req) ? (CHECK_STATUS_LABEL[req.check_status] || '') : '',
        'Заключение по проверке': req.check_result_notes || '',
        'Проверил': req.checked_by_name || '',
        'Дата проверки': formatShortDate(req.checked_at),
        'Ответственный': req.responsible?.full_name || '',
        'Срок согласования': formatShortDate(req.expected_approval_date),
        'Задачи': tasks.length ? `${done}/${tasks.length}` : '',
        'Документы': generalCount || '',
        'Отчёт по документам': reportCount || '',
        'Итоговые документы': finalCount || '',
        'Путь к папке': req.folder_path || '',
        // Статус ОКС — как в таблице, в конце (перед сведениями о создании).
        ...(submissionEnabled ? {
          'Статус ОКС': SUBMISSION_LABEL[submissionOf(req)] || '',
          'Комментарий к статусу ОКС': req.submission_comment || '',
          'Статус ОКС изменил': req.submission_by_name || '',
          'Дата изменения статуса ОКС': formatShortDate(req.submission_at),
        } : {}),
        'Создал': req.created_by_name || '',
        'Создано': formatShortDate(req.created_at),
      }
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    // Ширины — по порядку колонок выше (№ … Создано).
    ws['!cols'] = [
      { wch: 5 }, { wch: 24 }, { wch: 24 }, { wch: 20 }, { wch: 22 },
      ...(linkEnabled ? [{ wch: 26 }] : []),
      { wch: 16 },
      ...(linkEnabled ? [{ wch: 26 }, { wch: 22 }] : []),
      { wch: 40 }, { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 14 },
      { wch: 22 }, { wch: 26 }, { wch: 50 }, { wch: 22 }, { wch: 14 },
      { wch: 16 }, { wch: 9 }, { wch: 11 }, { wch: 16 },
      { wch: 16 }, { wch: 16 }, { wch: 40 },
      ...(submissionEnabled ? [{ wch: 34 }, { wch: 40 }, { wch: 22 }, { wch: 16 }] : []),
      { wch: 22 }, { wch: 12 },
    ]
    // Второй лист — задачи и ответы по тем же заявкам: в основной строке для
    // них только счётчик, а полный текст нужен, чтобы выгрузка была полной.
    const taskRows = []
    filtered.forEach((req) => {
      const tasks = [...(req.dc_request_tasks || [])]
        .sort((a, b) => (a.order_number ?? 0) - (b.order_number ?? 0))
      tasks.forEach((t) => {
        taskRows.push({
          '№ заявки': req.requestNo,
          'Объект': req.objects?.name || '',
          '№ ДС': req.ds_number || '',
          'Статус заявки': STATUS_LABEL[req.status || 'in_work'] || '',
          'Задача': t.task_text || '',
          'Ответ': t.response_text || '',
          'Выполнено': t.is_completed ? 'Да' : 'Нет',
          'Ответил': t.responded_by_name || '',
        })
      })
    })
    // Третий лист — файлы заявок, строка на файл, со ссылкой на портал: подписанная ссылка хранилища живёт час.
    // В ячейке Excel ссылка одна, поэтому в основном листе счётчик раздела ведёт на первый его файл здесь.
    const origin = window.location.origin
    const docRows = dcRequestDocRows(filtered, docsByReq)
    const docSheetRows = docRows.map(({ req, section, doc }) => ({
      '№ заявки': req.requestNo,
      'Объект': req.objects?.name || '',
      'Контрагент': req.counterparties?.name || '',
      '№ ДС': req.ds_number || '',
      'Раздел': section.label,
      'Описание': doc.notes || '',
      'Файл': doc.file_name || '',
      'Размер': formatBytes(doc.size_bytes),
      'Загрузил': doc.uploaded_by_name || '',
      'Загружено': formatShortDate(doc.created_at),
      'Ссылка': dcRequestFileLink(doc.id, origin),
    }))
    const wsDocs = XLSX.utils.json_to_sheet(docSheetRows)
    wsDocs['!cols'] = [
      { wch: 9 }, { wch: 24 }, { wch: 24 }, { wch: 14 }, { wch: 20 }, { wch: 36 },
      { wch: 36 }, { wch: 10 }, { wch: 22 }, { wch: 12 }, { wch: 60 },
    ]
    // Строка 0 обоих листов — заголовки: строка данных i — это r = i + 1.
    const docHeader = Object.keys(docSheetRows[0] || {})
    const linkCols = ['Файл', 'Ссылка'].map(h => docHeader.indexOf(h))
    const firstDocRow = new Map()
    docRows.forEach(({ req, section }, i) => {
      const Target = docSheetRows[i]['Ссылка']
      for (const c of linkCols) wsDocs[XLSX.utils.encode_cell({ r: i + 1, c })].l = { Target, Tooltip: 'Открыть файл на портале' }
      const key = `${req.id}:${section.key}`
      if (!firstDocRow.has(key)) firstDocRow.set(key, i + 1)
    })
    const header = Object.keys(rows[0])
    filtered.forEach((req, i) => {
      for (const section of DOC_SECTIONS) {
        const r = firstDocRow.get(`${req.id}:${section.key}`)
        if (r == null) continue
        ws[XLSX.utils.encode_cell({ r: i + 1, c: header.indexOf(section.label) })].l = {
          Target: `#'Документы'!A${r + 1}`, Tooltip: 'Файлы — на листе «Документы»',
        }
      }
    })

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Заявки на ДС')
    if (taskRows.length > 0) {
      const wsTasks = XLSX.utils.json_to_sheet(taskRows)
      wsTasks['!cols'] = [{ wch: 9 }, { wch: 24 }, { wch: 14 }, { wch: 20 }, { wch: 50 }, { wch: 50 }, { wch: 10 }, { wch: 22 }]
      XLSX.utils.book_append_sheet(wb, wsTasks, 'Задачи')
    }
    if (docRows.length > 0) XLSX.utils.book_append_sheet(wb, wsDocs, 'Документы')
    const today = formatShortDate(new Date().toISOString()).replace(/\./g, '-')
    XLSX.writeFile(wb, `Заявки_на_ДС_${today}.xlsx`)
  }

  // task 370: единый рендер чипа документа — используется и в «рабочих»,
  // и в «итоговых» документах.
  const renderDocChip = (doc) => {
    const tooltip = [
      doc.file_name,
      doc.notes,
      [formatBytes(doc.size_bytes), doc.uploaded_by_name].filter(Boolean).join(' · '),
    ].filter(Boolean).join('\n')
    const mime = (doc.mime_type || '').toLowerCase()
    const previewable = mime === 'application/pdf' || mime.startsWith('image/')
    return (
      <div key={doc.id} className="dcr-doc-chip">
        <button
          type="button"
          className="dcr-doc-chip-main"
          onClick={() => previewable ? setPreviewDoc(doc) : handleDocDownload(doc)}
          title={tooltip}
        >
          <svg
            className="dcr-doc-chip-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          {doc.notes
            ? <span className="dcr-doc-chip-desc">{doc.notes}</span>
            : <span className="dcr-doc-chip-desc dcr-doc-chip-desc-empty" title={doc.file_name}>{doc.file_name}</span>}
        </button>
        {previewable && (
          <button
            type="button"
            className="dcr-doc-chip-action"
            onClick={() => setPreviewDoc(doc)}
            title="Просмотр"
            aria-label="Просмотр"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className="dcr-doc-chip-action"
          onClick={() => handleDocDownload(doc)}
          title="Скачать"
          aria-label="Скачать"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
        {canEditDc && (
          <button
            type="button"
            className="dcr-doc-chip-del"
            onClick={() => handleDocDelete(doc)}
            title="Удалить"
            aria-label="Удалить"
          >×</button>
        )}
      </div>
    )
  }

  return (
    // dcr-dense — плотный вариант реестра (DcRequestsPage.css, конец файла);
    // на телефоне заявки идут карточками, их вид не меняем.
    <div ref={pageRef} className={`dc-requests-page contract-registry ui-work${isPhone ? '' : ' dcr-dense'}`}>
      <div className="registry-header">
        <h2>
          <IconTile tone="coral" className="dcr-title-icon"><IconDcRequest /></IconTile>
          Заявка на ДС
        </h2>
        <div className="dcr-header-actions">
          {/* Документы раздела — материалы и шаблоны по заявкам (DcRequestDocsModal), как в тендерах. */}
          <button
            type="button"
            className="dcr-link-btn"
            onClick={() => setShowSectionDocs(true)}
            title="Материалы раздела: шаблон «Было-Стало»"
          >
            <IconDocsStack size={15} />
            <span>Документы</span>
          </button>
          {/* task 324: ссылка на общую таблицу с отделами (хранится в app_settings) */}
          {externalLink ? (
            <a
              href={externalLink}
              target="_blank"
              rel="noopener noreferrer"
              className="dcr-link-btn"
              title={externalLink}
            >
              <IconLink size={15} />
              <span>Общая таблица отделов</span>
            </a>
          ) : canEditDc && (
            <button
              type="button"
              className="dcr-link-btn dcr-link-btn-empty"
              onClick={openLinkEditor}
              title="Задать ссылку на общую таблицу"
            >
              <IconLink size={15} />
              <span>Указать ссылку</span>
            </button>
          )}
          {canEditDc && externalLink && (
            <button
              type="button"
              className="dcr-link-edit"
              onClick={openLinkEditor}
              title="Изменить ссылку"
              aria-label="Изменить ссылку"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
          )}
          {/* task 370: выгрузка текущей выборки в Excel */}
          <button
            type="button"
            className="btn-secondary dcr-export-btn"
            onClick={handleExportExcel}
            title="Выгрузить текущую выборку в Excel"
          >
            <IconFileSpreadsheet />
            <span>Excel</span>
          </button>
          {canEditDc && (
            <button className="btn-primary" onClick={handleAddNew}>+ Добавить заявку</button>
          )}
        </div>
      </div>

      <div className="status-tabs">
        {TABS.map(tab => (
          <button
            key={tab.key}
            className={`status-tab ${activeTab === tab.key ? 'active' : ''} ${tab.key === 'deleted' ? 'tab-deleted' : ''}`}
            onClick={() => {
              setActiveTab(tab.key)
              // Вкладка статуса сама задаёт статус — мультифильтр с ней конфликтует.
              if (tab.key !== 'all') setFilterStatuses([])
            }}
          >
            {tab.label}
            <span className="tab-count">{counts[tab.key]}</span>
          </button>
        ))}
      </div>

      <div className="dcr-toolbar">
        <div className="ui-search">
          <IconSearch />
          {/* Короткая подсказка помещается целиком; где ищет поле — в aria-label. */}
          <input
            type="search"
            className="dcr-search"
            placeholder="Объект, контрагент, № ДС, работы"
            aria-label="Поиск по номеру заявки, объекту, контрагенту, номеру ДС и описанию работ"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        {/* Фильтр по нескольким статусам сразу. На вкладке конкретного статуса
            он бы только сужал до нуля, поэтому выбор статусов переводит на «Все». */}
        {!isDeletedTab && (
          <div className={`dcr-filter-drop${filterStatuses.length ? ' is-active' : ''}`}>
            <FilterDropdown
              label=""
              multiple
              allLabel="Все статусы"
              value={filterStatuses}
              onChange={(next) => {
                setFilterStatuses(next)
                if (next.length > 0 && activeTab !== 'all') setActiveTab('all')
              }}
              options={STATUS_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
            />
          </div>
        )}
        <div className={`dcr-filter-drop${filterObjectIds.length ? ' is-active' : ''}`}>
          <FilterDropdown
            label=""
            multiple
            searchable
            searchPlaceholder="Поиск объекта…"
            allLabel="Все объекты"
            icon={<IconObject size={15} />}
            value={filterObjectIds}
            onChange={setFilterObjectIds}
            options={objects.map(o => ({ value: o.id, label: o.name }))}
          />
        </div>
        <div className={`dcr-filter-drop${filterCounterpartyIds.length ? ' is-active' : ''}`}>
          <FilterDropdown
            label=""
            multiple
            searchable
            searchPlaceholder="Поиск контрагента…"
            allLabel="Все контрагенты"
            icon={<IconHardHat size={15} />}
            value={filterCounterpartyIds}
            onChange={setFilterCounterpartyIds}
            options={counterpartyFilterOptions.map(cp => ({ value: cp.id, label: cp.name }))}
            disabled={counterpartyFilterOptions.length === 0}
          />
        </div>
        <div className={`dcr-filter-drop${filterResponsibleIds.length ? ' is-active' : ''}`}>
          <FilterDropdown
            label=""
            multiple
            searchable
            searchPlaceholder="Поиск сотрудника…"
            allLabel="Все ответственные"
            icon={<IconUser size={15} />}
            value={filterResponsibleIds}
            onChange={setFilterResponsibleIds}
            options={responsibleFilterOptions.map(c => ({ value: c.id, label: c.full_name }))}
            disabled={responsibleFilterOptions.length === 0}
          />
        </div>
        {/* Подразделение — те же подразделения, что у тендеров (подразделения ВОР). */}
        {linkEnabled && (
          <div className={`dcr-filter-drop${filterDivisions.length ? ' is-active' : ''}`}>
            <VorDivisionFilter subject="dc" value={filterDivisions} onChange={setFilterDivisions} counts={divisionCounts} />
          </div>
        )}
        {(filterStatuses.length > 0 || filterObjectIds.length > 0 || filterCounterpartyIds.length > 0 || filterResponsibleIds.length > 0 || divisionFilterOn) && (
          <button
            type="button"
            className="dcr-filter-clear"
            onClick={() => { setFilterStatuses([]); setFilterObjectIds([]); setFilterCounterpartyIds([]); setFilterResponsibleIds([]); setFilterDivisions([]) }}
            title="Сбросить фильтры"
          >Сбросить</button>
        )}
      </div>

      {!requestsLoaded ? (
        <div className="loading">Загрузка...</div>
      ) : isPhone ? (
        filtered.length === 0 ? (
          <div className="no-data" style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--text-tertiary)' }}>
            {searchQuery ? 'Ничего не найдено.' : isDeletedTab ? 'Нет удалённых заявок.' : 'Заявок пока нет.'}
          </div>
        ) : (
          <div className="mcard-list">
            {filtered.map((req) => {
              const currentStatus = req.status || 'in_work'
              const statusOpt = STATUS_OPTIONS.find(o => o.value === currentStatus)
              const docsCount = (docsByReq.get(req.id) || []).length
              const contract = contractsById.get(req.contract_id)
              const amendment = contractsById.get(req.amendment_id)
              return (
                <div key={req.id} className={`mcard${req.deleted_at ? ' row-deleted' : ''}`}>
                  <div className="mcard-head">
                    <span className="mcard-num">
                      № {req.requestNo}
                      <small className="mcard-id"> · {req.ds_number ? `№ ДС ${req.ds_number}` : '№ ДС не присвоен'}</small>
                    </span>
                    <span className={`status-badge ${statusOpt?.className || ''}`}>{STATUS_LABEL[currentStatus]}</span>
                  </div>
                  <div className="mcard-title">{req.objects?.name || '—'}</div>
                  {req.works_description && <div className="mcard-desc"><ClampText text={req.works_description} lines={4} /></div>}
                  <div className="mcard-rows">
                    <div className="mcard-row">
                      <span className="mcard-label">Контрагент</span>
                      <span className="mcard-value">{req.counterparties?.name || '—'}</span>
                    </div>
                    {linkEnabled && (
                      <div className="mcard-row">
                        <span className="mcard-label">Договор</span>
                        <span className="mcard-value">
                          {req.contract_id ? (contract ? contractLabel(contract) : 'выбран') : '—'}
                          {req.amendment_id && (
                            <small className="dcr-sub-mcard-meta">Занесена в {amendment ? amendmentLabel(amendment) : 'ДС'}</small>
                          )}
                        </span>
                      </div>
                    )}
                    {linkEnabled && req.division && (
                      <div className="mcard-row">
                        <span className="mcard-label">Подразделение</span>
                        <span className="mcard-value">{VOR_DIVISION_LABEL[req.division] || req.division}</span>
                      </div>
                    )}
                    {req.ds_type && (
                      <div className="mcard-row">
                        <span className="mcard-label">Тип ДС</span>
                        <span className="mcard-value">{DS_TYPE_LABEL[req.ds_type] || req.ds_type}</span>
                      </div>
                    )}
                    {req.material_type && (
                      <div className="mcard-row">
                        <span className="mcard-label">Материал</span>
                        <span className="mcard-value">{MATERIAL_LABEL[req.material_type] || '—'}</span>
                      </div>
                    )}
                    <div className="mcard-row">
                      <span className="mcard-label">Сумма, руб.</span>
                      <span className="mcard-value">
                        {req.amount_before != null ? formatAmount(req.amount_before) : '—'}
                        {' → '}
                        {req.amount_after != null ? formatAmount(req.amount_after) : '—'}
                      </span>
                    </div>
                    <div className="mcard-row">
                      <span className="mcard-label">Ответственный</span>
                      <span className="mcard-value">{req.responsible?.full_name || '—'}</span>
                    </div>
                    <div className="mcard-row">
                      <span className="mcard-label">Ориент. срок</span>
                      <span className="mcard-value">{req.expected_approval_date ? formatShortDate(req.expected_approval_date) : '—'}</span>
                    </div>
                    {/* Итог сверки с договором: на телефоне — строкой, клик открывает
                        то же окно с заключением и файлами. */}
                    <div className="mcard-row">
                      <span className="mcard-label">Итог проверки</span>
                      <span className="mcard-value">
                        {hasVerdict(req) ? (
                          <button
                            type="button"
                            className={`dcr-verdict-badge ${CHECK_STATUS_CLASS[req.check_status] || ''}`}
                            onClick={() => openVerdictModal(req)}
                          >
                            <span className="dcr-verdict-badge-text">{CHECK_STATUS_SHORT[req.check_status]}</span>
                          </button>
                        ) : canEditDc && !req.deleted_at ? (
                          <button
                            type="button"
                            className="dcr-verdict-add"
                            onClick={() => openVerdictModal(req)}
                          >+ Итог проверки</button>
                        ) : '—'}
                      </span>
                    </div>
                    {/* Статус ОКС (подача заказчику) — на телефоне только просмотр, как материал и тип ДС. */}
                    {submissionEnabled && (
                      <div className="mcard-row">
                        <span className="mcard-label">Статус ОКС</span>
                        <span className="mcard-value">
                          {SUBMISSION_LABEL[submissionOf(req)]}
                          {req.submission_at && (
                            <small className="dcr-sub-mcard-meta">
                              {[req.submission_by_name, formatShortDate(req.submission_at)].filter(Boolean).join(' · ')}
                            </small>
                          )}
                        </span>
                      </div>
                    )}
                    {submissionEnabled && req.submission_comment && (
                      <div className="mcard-row">
                        <span className="mcard-label">Комментарий</span>
                        <span className="mcard-value"><ClampText text={req.submission_comment} lines={4} /></span>
                      </div>
                    )}
                  </div>
                  <div className="mcard-foot">
                    {docsCount > 0 && <span className="mcard-chip" aria-label={`Файлов: ${docsCount}`}><PaperclipIcon size={12} /> {docsCount}</span>}
                    <div className="mcard-actions">
                      <button
                        className="btn-icon btn-history"
                        onClick={() => openHistory(req)}
                        title="История изменений"
                        aria-label="История изменений"
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 3v5h5" />
                          <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
                          <path d="M12 7v5l3 2" />
                        </svg>
                      </button>
                      {isDeletedTab ? (
                        <>
                          {canEditDc && (
                            <button type="button" className="btn-icon btn-restore" onClick={() => handleRestore(req.id)} title="Восстановить" aria-label="Восстановить"><IconRestore /></button>
                          )}
                          {isAdmin && (
                            <button type="button" className="btn-icon btn-delete" onClick={() => handleHardDelete(req.id)} title="Удалить безвозвратно" aria-label="Удалить безвозвратно"><IconTrash /></button>
                          )}
                        </>
                      ) : canEditDc ? (
                        <button type="button" className="btn-icon btn-edit" onClick={() => handleEdit(req)} title="Редактировать" aria-label="Редактировать"><IconEdit /></button>
                      ) : null}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )
      ) : (
        <div className="table-container">
          <table className={`dcr-table${linkEnabled ? ' has-link' : ''}${submissionEnabled ? ' has-sub' : ''}`}>
            {/* Ширины — в DcRequestsPage.css (.dcr-col-*): суммы и номера целиком,
                описание ДС забирает остаток. Связанное — в одном столбце, иначе
                таблица не помещается в окно: № ДС — под договором, ответственный —
                под статусом, комментарий — под статусом ОКС. */}
            <colgroup>
              <col className="dcr-col-num" />
              <col className="dcr-col-object" />
              <col className="dcr-col-cp" />
              <col className={linkEnabled ? 'dcr-col-contract' : 'dcr-col-dsnum'} />
              <col className="dcr-col-desc" />
              <col className="dcr-col-amount" />
              <col className="dcr-col-status" />
              <col className="dcr-col-docs" />
              {submissionEnabled && <col className="dcr-col-sub" />}
              <col className="dcr-col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th style={{ textAlign: 'center' }}>№</th>
                <th>Объект</th>
                <th>Контрагент</th>
                <th>{linkEnabled ? 'Договор и № ДС' : '№ ДС'}</th>
                <th>Описание ДС</th>
                {/* task 370: сумма ДС («Было подано» / «Утверждено») с НДС 22% перед статусом */}
                <th style={{ textAlign: 'right' }}>Сумма, руб. с НДС 22%</th>
                <th>Статус и ответственный</th>
                <th>Документы</th>
                {/* Статус ОКС — подаётся ли ДС заказчику; под ним пояснение (номер письма, срок…).
                    Перед последним столбцом («Действия»). */}
                {submissionEnabled && <th>Статус ОКС</th>}
                <th><span className="ui-sr-only">Действия</span></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={submissionEnabled ? 10 : 9} className="no-data" style={{ textAlign: 'center' }}>
                    {searchQuery
                      ? 'Ничего не найдено.'
                      : (activeTab === 'all'
                        ? 'Заявок пока нет. Нажмите «+ Добавить заявку».'
                        : `Нет заявок со статусом «${STATUS_LABEL[activeTab]}».`)}
                  </td>
                </tr>
              ) : (
                filtered.map((req) => {
                  const currentStatus = req.status || 'in_work'
                  const statusOpt = STATUS_OPTIONS.find(o => o.value === currentStatus)
                  const isStatusOpen = statusPopoverFor === req.id

                  const docs = docsByReq.get(req.id) || []
                  // task 370: рабочие vs итоговые документы.
                  const generalDocs = docs.filter(d => !SPECIAL_DOC_CATEGORIES.has(d.doc_category))
                  const finalDocs = docs.filter(d => d.doc_category === 'final')
                  const reportDocs = docs.filter(d => d.doc_category === 'check_report')
                  // Блок отчёта показываем с этапа «Итог проверки» и дальше, а также
                  // всегда, если отчёт уже приложен.
                  const showReport = reportDocs.length > 0 || hasVerdict(req)
                    || (canEditDc && currentStatus !== 'contract_check')
                  const docsOpen = expandedDocs.has(req.id)

                  // task 370: разница сумм («Было подано» − «Утверждено»). >0 → удешевление.
                  // Процент — от модуля поданной суммы (суммы бывают отрицательными), со знаком
                  // изменения: < 0 — утверждено меньше поданного. «Было подано» пусто или 0 — без процента.
                  const amountBefore = req.amount_before
                  const amountAfter = req.amount_after
                  const { diff: amountDiff, pct: amountPct } = amountChange(amountBefore, amountAfter)

                  const submission = submissionOf(req)
                  const canEditSubmission = canEditDc && !isDeletedTab

                  return (
                    <tr key={req.id} className={req.deleted_at ? 'row-deleted' : ''}>
                      <td className="ui-rownum" style={{ textAlign: 'center' }}>{req.requestNo}</td>
                      <td>
                        <div className="dcr-object-name">
                          {req.objects?.name || <span className="muted-dash">—</span>}
                        </div>
                        {(req.created_at || req.created_by_name) && (
                          <div className="dcr-meta-line">
                            <span className="dcr-meta-icon" aria-hidden><IconClock size={12} /></span>
                            {req.created_at && <span className="ui-num">{formatShortDate(req.created_at)}</span>}
                            {req.created_by_name && (
                              <>
                                <span className="dcr-meta-sep">·</span>
                                <PersonName full={req.created_by_name} titlePrefix="Создал" className="dcr-meta-author" />
                              </>
                            )}
                          </div>
                        )}
                        {/* task 365: ориентировочный срок согласования + inline-edit */}
                        <div className="dcr-meta-deadline">
                          <span className="dcr-meta-icon" aria-hidden><IconCalendar size={12} /></span>
                          <span className="dcr-meta-deadline-label">Ориентировочный срок:</span>
                          {req.expected_approval_date ? (
                            <button
                              type="button"
                              className="dcr-meta-deadline-value"
                              onClick={canEditDc ? (e) => openDeadlinePopover(req.id, e) : undefined}
                              disabled={!canEditDc}
                              title={canEditDc ? 'Изменить срок' : undefined}
                            >
                              {formatShortDate(req.expected_approval_date)}г.
                            </button>
                          ) : canEditDc ? (
                            <button
                              type="button"
                              className="dcr-meta-deadline-link"
                              onClick={(e) => openDeadlinePopover(req.id, e)}
                            >
                              Указать срок
                            </button>
                          ) : (
                            <span className="dcr-meta-deadline-empty">—</span>
                          )}
                          {deadlinePopover?.id === req.id && (
                            <DeadlinePopover
                              initial={req.expected_approval_date || ''}
                              anchorRect={deadlinePopover.rect}
                              onClose={() => setDeadlinePopover(null)}
                              onSave={(newDate) => handleQuickSaveDeadline(req.id, newDate)}
                            />
                          )}
                        </div>
                      </td>
                      <td>
                        {req.counterparties?.name || <span className="muted-dash">—</span>}
                        {/* task 370 + 371: материал. Сотрудник меняет инлайн-селектором
                            прямо в таблице, остальные видят бейдж «Материал: …». */}
                        {canEditDc ? (
                          <div className="dcr-material-edit">
                            <span className="dcr-material-edit-label">Материал:</span>
                            <WrapSelect
                              faceClassName={`dcr-material-select ${MATERIAL_CLASS[req.material_type] || 'is-empty'}`}
                              label={MATERIAL_LABEL[req.material_type] || 'Не указан'}
                              value={req.material_type || ''}
                              onChange={(e) => handleSaveMaterial(req.id, e.target.value)}
                              title="Тип материала"
                              aria-label="Тип материала"
                            >
                              <option value="">Не указан</option>
                              {MATERIAL_OPTIONS.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </WrapSelect>
                          </div>
                        ) : req.material_type && (
                          <div className={`dcr-material-badge ${MATERIAL_CLASS[req.material_type] || ''}`}>
                            Материал: {MATERIAL_LABEL[req.material_type]}
                          </div>
                        )}
                        {/* Тип ДС — под материалом, тем же инлайн-селектором: признак
                            самой заявки, отдельная колонка раздула бы таблицу. */}
                        {canEditDc ? (
                          <div className="dcr-material-edit">
                            <span className="dcr-material-edit-label">Тип ДС:</span>
                            <WrapSelect
                              faceClassName={`dcr-material-select dcr-dstype-select ${DS_TYPE_CLASS[req.ds_type] || (req.ds_type ? '' : 'is-empty')}`}
                              label={req.ds_type ? (DS_TYPE_LABEL[req.ds_type] || req.ds_type) : 'Не указан'}
                              value={req.ds_type || ''}
                              onChange={(e) => handleSaveDsType(req.id, e.target.value)}
                              title="Тип ДС"
                              aria-label="Тип ДС"
                            >
                              <option value="">Не указан</option>
                              {req.ds_type && !DS_TYPE_OPTIONS.some(o => o.value === req.ds_type) && (
                                <option value={req.ds_type} disabled>{DS_TYPE_LABEL[req.ds_type] || req.ds_type}</option>
                              )}
                              {DS_TYPE_OPTIONS.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </WrapSelect>
                          </div>
                        ) : req.ds_type && (
                          <div className={`dcr-tag ${DS_TYPE_CLASS[req.ds_type] || ''}`}>
                            Тип ДС: {DS_TYPE_LABEL[req.ds_type] || req.ds_type}
                          </div>
                        )}
                      </td>
                      {linkEnabled ? (
                        // Договор, под ним № ДС и «в ДС» — один столбец: ДС — часть договора.
                        <td className="dcr-cell-contract">
                          <DcContractCell
                            req={req}
                            contracts={contracts}
                            contractsById={contractsById}
                            parties={contractParties}
                            canEdit={canEditDc && !isDeletedTab}
                            onChange={(contractId) => handleSaveContract(req, contractId)}
                          />
                          <div className="dcr-cell-dsnum dcr-dsnum-line">
                            <span className="dcr-dsnum-label">№ ДС:</span>
                            {req.ds_number
                              ? <BreakableId value={req.ds_number} className="ui-num-wrap" />
                              : <span className="muted-dash">—</span>}
                          </div>
                          <DcAmendmentMark
                            req={req}
                            contracts={contracts}
                            contractsById={contractsById}
                            canEdit={canEditDc && !isDeletedTab}
                            onLink={(amendmentId) => handleSaveAmendment(req, amendmentId)}
                          />
                        </td>
                      ) : (
                        <td className="dcr-cell-dsnum">
                          {req.ds_number
                            ? <BreakableId value={req.ds_number} className="ui-num-wrap" />
                            : <span className="muted-dash">—</span>}
                        </td>
                      )}
                      <td className="dcr-cell-works">
                        {/* До трёх строк, длиннее — «Показать полностью». */}
                        <ClampText text={req.works_description} />
                        {/* Подразделение — плашкой под описанием, как подразделение ВОР у тендеров. */}
                        {linkEnabled && (
                          <div className="dcr-division">
                            <VorDivisionChip
                              subject="dc"
                              value={req.division}
                              canEdit={canEditDc && !isDeletedTab}
                              onChange={(v) => handleSaveDivision(req, v)}
                            />
                          </div>
                        )}
                      </td>
                      {/* task 370: сумма ДС («Было подано» / «Утверждено») с инлайн-редактированием + разница */}
                      <td className="dcr-cell-amount">
                        <div className="dcr-amount">
                          <div className="dcr-amount-row">
                            <span className="dcr-amount-label">Было подано</span>
                            {canEditDc ? (
                              <AmountCellInput
                                value={amountBefore}
                                disabled={!canEditDc}
                                onSave={(v) => handleSaveAmount(req.id, 'amount_before', v)}
                              />
                            ) : (
                              <span className="dcr-amount-value">{amountBefore != null ? formatAmount(amountBefore) : '—'}</span>
                            )}
                          </div>
                          <div className="dcr-amount-row">
                            <span className="dcr-amount-label">Утверждено</span>
                            {canEditDc ? (
                              <AmountCellInput
                                value={amountAfter}
                                disabled={!canEditDc}
                                onSave={(v) => handleSaveAmount(req.id, 'amount_after', v)}
                              />
                            ) : (
                              <span className="dcr-amount-value">{amountAfter != null ? formatAmount(amountAfter) : '—'}</span>
                            )}
                          </div>
                          {amountDiff != null && amountDiff !== 0 ? (
                            <div
                              className={`dcr-amount-diff ${amountDiff > 0 ? 'is-cheaper' : 'is-pricier'}`}
                              title={amountDiff > 0 ? 'Удешевление относительно поданной суммы' : 'Удорожание относительно поданной суммы'}
                            >
                              <span className="dcr-diff-abs">{amountDiff > 0 ? '↓' : '↑'} {formatAmount(Math.abs(amountDiff))} ₽</span>
                              {amountPct != null && (
                                <span className="dcr-diff-pct">
                                  {amountPct < 0 ? '−' : '+'}{formatPercent(Math.abs(amountPct))}%
                                </span>
                              )}
                            </div>
                          ) : (
                            <div className="dcr-amount-diff is-zero">
                              {amountDiff === 0 ? 'без изменений' : ''}
                            </div>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="dcr-status-wrap">
                          <button
                            type="button"
                            className={`dcr-status-chip ${statusOpt?.className || ''}${isStatusOpen ? ' is-open' : ''}`}
                            onClick={(e) => canChangeStatus(currentStatus) && !isDeletedTab && toggleStatusPopover(e, req.id)}
                            disabled={!canChangeStatus(currentStatus) || isDeletedTab}
                            title={currentStatus === 'contract_check' && !canLeaveContractCheck
                              ? 'Снять статус «Проверка по договору» может только юрист ОСП или администратор'
                              : undefined}
                            aria-haspopup="listbox"
                            aria-expanded={isStatusOpen}
                          >
                            <span>{STATUS_LABEL[currentStatus]}</span>
                            <span className="dcr-status-chev" aria-hidden>▾</span>
                          </button>
                          {isStatusOpen && (
                            <div className={`dcr-status-popover${statusPopoverUp ? ' is-up' : ''}`} role="listbox">
                              {STATUS_OPTIONS.map(opt => {
                                const isCurrent = opt.value === currentStatus
                                return (
                                  <button
                                    key={opt.value}
                                    type="button"
                                    role="option"
                                    aria-selected={isCurrent}
                                    className={`dcr-status-popover-item ${opt.className}${isCurrent ? ' is-current' : ''}`}
                                    onClick={() => {
                                      if (!isCurrent) handleStatusChange(req.id, opt.value)
                                      setStatusPopoverFor(null)
                                    }}
                                  >
                                    <span className="dcr-status-popover-dot" />
                                    {opt.label}
                                    {isCurrent && <span className="dcr-status-popover-check" aria-hidden>✓</span>}
                                  </button>
                                )
                              })}
                            </div>
                          )}
                        </div>
                        {/* Итог сверки с договором: чем закончилась проверка.
                            Клик открывает окно с заключением и файлами отчёта. */}
                        {hasVerdict(req) ? (
                          <button
                            type="button"
                            className={`dcr-verdict-badge ${CHECK_STATUS_CLASS[req.check_status] || ''}`}
                            onClick={() => openVerdictModal(req)}
                            title={[
                              CHECK_STATUS_LABEL[req.check_status],
                              req.check_result_notes,
                              [req.checked_by_name, formatDateTime(req.checked_at)].filter(Boolean).join(' · '),
                            ].filter(Boolean).join('\n')}
                          >
                            <span className="dcr-verdict-badge-text">{CHECK_STATUS_SHORT[req.check_status]}</span>
                            {req.checked_at && (
                              <span className="dcr-verdict-badge-date">{formatShortDate(req.checked_at)}</span>
                            )}
                          </button>
                        ) : canEditDc && !isDeletedTab && (canLeaveContractCheck || currentStatus !== 'contract_check') ? (
                          <button
                            type="button"
                            className="dcr-verdict-add"
                            onClick={() => openVerdictModal(req)}
                            title="Зафиксировать итог проверки по договору"
                          >+ Итог проверки</button>
                        ) : null}
                        {/* Ответственный — под статусом: кто ведёт заявку по этапам. */}
                        <div className="dcr-resp-line" title="Ответственный">
                          <span className="dcr-meta-icon" aria-hidden><IconUser size={12} /></span>
                          {req.responsible?.full_name
                            ? <PersonName full={req.responsible.full_name} titlePrefix="Ответственный" />
                            : <span className="muted-dash">Не назначен</span>}
                        </div>
                      </td>
                      <td className="dcr-cell-docs">
                        {/* Путь к папке в хранилище — первым: с него начинают поиск
                            документов, файлы на сайте лишь дополняют его.
                            Правится прямо здесь, без захода в форму заявки. */}
                        {pathEdit?.id === req.id ? (
                          <div className="dcr-folder-path is-edit">
                            <IconFolder />
                            <input
                              type="text"
                              className="dcr-folder-path-input"
                              autoFocus
                              value={pathEdit.draft}
                              onChange={(e) => setPathEdit(prev => (prev?.id === req.id ? { ...prev, draft: e.target.value } : prev))}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); handleSaveFolderPath(req.id, pathEdit.draft) }
                                if (e.key === 'Escape') setPathEdit(null)
                              }}
                              placeholder="\\su10-fs\ДС\ЖК Алия\ДС-14"
                              disabled={savingPath}
                            />
                            <button
                              type="button"
                              className="dcr-folder-path-btn"
                              onClick={() => handleSaveFolderPath(req.id, pathEdit.draft)}
                              disabled={savingPath}
                            >{savingPath ? '…' : 'ОК'}</button>
                            <button
                              type="button"
                              className="dcr-folder-path-btn is-cancel"
                              onClick={() => setPathEdit(null)}
                              disabled={savingPath}
                            >Отмена</button>
                          </div>
                        ) : req.folder_path ? (
                          <div className="dcr-folder-path" title={req.folder_path}>
                            <IconFolder />
                            {/* Нажатие на путь — папка в проводнике (помощник, FolderOpen.jsx); не путь к папке
                                Windows или не Windows — только текст, путь копируют кнопкой. */}
                            {folderOpenable(req.folder_path) ? (
                              <span
                                className="dcr-folder-path-text is-openable"
                                role="button"
                                tabIndex={0}
                                onClick={() => openFolder(req.folder_path)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFolder(req.folder_path) }
                                }}
                                title={`Открыть папку в проводнике:\n${req.folder_path}`}
                              >{req.folder_path}</span>
                            ) : (
                              <span className="dcr-folder-path-text">{req.folder_path}</span>
                            )}
                            <button
                              type="button"
                              className="dcr-folder-path-copy"
                              onClick={() => handleCopyFolderPath(req.id, req.folder_path)}
                              title="Скопировать путь"
                              aria-label="Скопировать путь к папке"
                            >
                              {copiedPathId === req.id ? <IconCheck /> : <IconCopy />}
                            </button>
                            {canEditDc && !isDeletedTab && (
                              <button
                                type="button"
                                className="dcr-folder-path-copy"
                                onClick={() => setPathEdit({ id: req.id, draft: req.folder_path || '' })}
                                title="Изменить путь"
                                aria-label="Изменить путь к папке"
                              ><IconPencil /></button>
                            )}
                          </div>
                        ) : canEditDc && !isDeletedTab ? (
                          <button
                            type="button"
                            className="dcr-folder-path-add"
                            onClick={() => setPathEdit({ id: req.id, draft: '' })}
                          ><IconFolder /> Указать путь к папке</button>
                        ) : null}
                        {/* Рабочие документы */}
                        <div className="dcr-docs">
                          {generalDocs.length > 0 && (
                            <button
                              type="button"
                              className="dcr-docs-toggle"
                              onClick={() => toggleDocsExpanded(req.id)}
                              aria-expanded={docsOpen}
                            >
                              <span className="dcr-docs-chev" aria-hidden>{docsOpen ? '▼' : '▶'}</span>
                              <svg
                                className="dcr-docs-icon"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                              >
                                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                              </svg>
                              <span className="dcr-docs-summary">
                                Файлы: <strong>{generalDocs.length}</strong>
                              </span>
                            </button>
                          )}
                          {docsOpen && generalDocs.length > 0 && (
                            <div className="dcr-doc-chips">
                              {generalDocs.map(renderDocChip)}
                            </div>
                          )}
                          {canEditDc && (
                            <button
                              type="button"
                              className="dcr-doc-add"
                              onClick={() => handleDocPick(req.id, 'general')}
                              title="Добавить документ"
                            >+ Документ</button>
                          )}
                        </div>

                        {/* Отчёт по документам — результат этапа «Итог проверки». */}
                        {showReport && (
                          <div className={`dcr-final-docs dcr-report-docs${reportDocs.length > 0 ? ' has-final' : ''}`}>
                            <div className="dcr-final-docs-title">
                              <IconFileSpreadsheet size={12} />
                              Отчёт по документам
                              {reportDocs.length > 0 && (
                                <span className="dcr-final-docs-count">{reportDocs.length}</span>
                              )}
                            </div>
                            {reportDocs.length > 0 && (
                              <div className="dcr-doc-chips">
                                {reportDocs.map(renderDocChip)}
                              </div>
                            )}
                            {canEditDc && !isDeletedTab && (
                              <button
                                type="button"
                                className="dcr-doc-add dcr-doc-add-final"
                                onClick={() => handleDocPick(req.id, 'check_report')}
                                title="Приложить отчёт по проверке документов"
                              >+ Отчёт</button>
                            )}
                          </div>
                        )}

                        {/* task 370: итоговые документы — отдельная секция,
                            подсвечивается при наличии файлов. */}
                        {(finalDocs.length > 0 || canEditDc) && (
                          <div className={`dcr-final-docs${finalDocs.length > 0 ? ' has-final' : ''}`}>
                            <div className="dcr-final-docs-title">
                              <span className="dcr-final-docs-icon" aria-hidden><IconCheckMark size={12} /></span>
                              Итоговые документы
                              {finalDocs.length > 0 && (
                                <span className="dcr-final-docs-count">{finalDocs.length}</span>
                              )}
                            </div>
                            {finalDocs.length > 0 && (
                              <div className="dcr-doc-chips">
                                {finalDocs.map(renderDocChip)}
                              </div>
                            )}
                            {canEditDc && (
                              <button
                                type="button"
                                className="dcr-doc-add dcr-doc-add-final"
                                onClick={() => handleDocPick(req.id, 'final')}
                                title="Добавить итоговый документ"
                              >+ Итоговый документ</button>
                            )}
                          </div>
                        )}
                      </td>
                      {/* Статус ОКС: выбор прямо в ячейке; под ним — кто и когда сменил (ставит база)
                          и комментарий. Перед последним столбцом («Действия»). */}
                      {submissionEnabled && (
                        <td className="dcr-cell-sub">
                          {canEditSubmission ? (
                            <WrapSelect
                              faceClassName={`dcr-material-select dcr-sub-select ${SUBMISSION_CLASS[submission] || ''}`}
                              label={SUBMISSION_LABEL[submission] || submission}
                              value={submission}
                              onChange={(e) => handleSaveSubmission(req.id, 'submission_check', e.target.value)}
                              title="Статус ОКС: подаётся ли ДС заказчику"
                              aria-label="Статус ОКС"
                            >
                              {SUBMISSION_OPTIONS.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </WrapSelect>
                          ) : (
                            <span className={`dcr-sub-tag ${SUBMISSION_CLASS[submission] || ''}`}>
                              {SUBMISSION_LABEL[submission] || submission}
                            </span>
                          )}
                          {req.submission_at && (
                            <div className="dcr-sub-meta" title={`Статус ОКС изменил: ${req.submission_by_name || 'имя не записано'}, ${formatDateTime(req.submission_at)}`}>
                              {req.submission_by_name && (
                                <PersonName full={req.submission_by_name} titlePrefix="Статус ОКС изменил" className="dcr-meta-author" />
                              )}
                              <span className="ui-num">{formatShortDate(req.submission_at)}</span>
                            </div>
                          )}
                          {canEditSubmission ? (
                            <SubmissionCommentInput
                              value={req.submission_comment}
                              hint={SUBMISSION_HINT[submission]}
                              missing={submissionNeedsComment(req)}
                              onSave={(v) => handleSaveSubmission(req.id, 'submission_comment', v)}
                            />
                          ) : req.submission_comment && (
                            <div className="dcr-sub-comment-text"><ClampText text={req.submission_comment} /></div>
                          )}
                        </td>
                      )}
                      <td className="actions-cell">
                        {/* История доступна всем, кто видит заявку, — она только для чтения */}
                        <button
                          className="btn-icon btn-history"
                          onClick={() => openHistory(req)}
                          title="История изменений"
                          aria-label="История изменений"
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 3v5h5" />
                            <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
                            <path d="M12 7v5l3 2" />
                          </svg>
                        </button>
                        {isDeletedTab ? (
                          <>
                            {canEditDc && (
                              <button type="button" className="btn-icon btn-restore" onClick={() => handleRestore(req.id)} title="Восстановить" aria-label="Восстановить заявку"><IconRestore /></button>
                            )}
                            {isAdmin && (
                              <button type="button" className="btn-icon btn-delete" onClick={() => handleHardDelete(req.id)} title="Удалить безвозвратно (админ)" aria-label="Удалить заявку безвозвратно"><IconTrash /></button>
                            )}
                          </>
                        ) : canEditDc ? (
                          <>
                            <button type="button" className="btn-icon btn-edit" onClick={() => handleEdit(req)} title="Редактировать" aria-label="Редактировать заявку"><IconEdit /></button>
                            <button type="button" className="btn-icon btn-delete" onClick={() => handleDelete(req.id)} title="Удалить" aria-label="Удалить заявку"><IconTrash /></button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Модалка создания/редактирования заявки */}
      {showModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editing ? 'Редактировать заявку' : 'Добавить заявку на ДС'}</h3>
              <button
                className="modal-close"
                onClick={() => { setShowModal(false); setEditing(null) }}
                disabled={saving}
              >×</button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="form-grid">
                <div className="form-group full-width">
                  <label>Объект *</label>
                  <FilterDropdown
                    className="dcr-object-picker"
                    label=""
                    value={formData.object_id}
                    onChange={(v) => updateForm({ object_id: v })}
                    options={objects.map(o => ({ value: o.id, label: o.name, status: o.status }))}
                    searchable
                    searchPlaceholder="Поиск объекта…"
                    allLabel="Выберите объект"
                    renderOption={(o) => (
                      <span className="dcr-obj-option">
                        <span className="dcr-obj-name">{o.label}</span>
                        <span
                          className={`dcr-obj-badge ${o.status === 'warranty_service' ? 'is-go' : 'is-os'}`}
                          title={o.status === 'warranty_service' ? 'Гарантийный отдел' : 'Основное строительство'}
                        >{o.status === 'warranty_service' ? 'ГО' : 'ОС'}</span>
                      </span>
                    )}
                  />
                  <small style={{ color: 'var(--text-tertiary)', marginTop: '0.25rem', display: 'block' }}>
                    Основное строительство (ОС) и гарантийный отдел (ГО)
                  </small>
                </div>

                <div className="form-group full-width">
                  <label>Контрагент *</label>
                  <div className="cp-search-wrap">
                    <input
                      type="text"
                      className="cp-search-input"
                      placeholder="Начните вводить название или ИНН…"
                      value={cpSearch}
                      onChange={(e) => {
                        setCpSearch(e.target.value)
                        setCpDropdownOpen(true)
                        // Если пользователь чистит / правит — снимаем выбор, чтобы required снова сработал.
                        if (formData.counterparty_id) {
                          setFormData(prev => ({ ...prev, counterparty_id: '' }))
                        }
                      }}
                      onFocus={() => setCpDropdownOpen(true)}
                      onBlur={() => setTimeout(() => setCpDropdownOpen(false), 150)}
                      // Навигация клавишами: ↑/↓ — по списку, Enter — выбрать, Esc — закрыть.
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') { setCpDropdownOpen(false); return }
                        if (!cpDropdownOpen) {
                          if (e.key === 'ArrowDown') { setCpDropdownOpen(true); e.preventDefault() }
                          return
                        }
                        if (e.key === 'ArrowDown') {
                          e.preventDefault()
                          setCpHighlight(i => Math.min(i + 1, cpVisible.length - 1))
                        } else if (e.key === 'ArrowUp') {
                          e.preventDefault()
                          setCpHighlight(i => Math.max(i - 1, 0))
                        } else if (e.key === 'Enter' && cpVisible[cpHighlight]) {
                          e.preventDefault()
                          handleSelectCp(cpVisible[cpHighlight])
                        }
                      }}
                      required={!formData.counterparty_id}
                    />
                    {cpSearch && (
                      <button
                        type="button"
                        className="cp-search-clear"
                        title="Очистить"
                        aria-label="Очистить"
                        onMouseDown={(e) => {
                          e.preventDefault()
                          setCpSearch('')
                          updateForm({ counterparty_id: '' })
                          setCpDropdownOpen(true)
                        }}
                      >×</button>
                    )}
                    {cpDropdownOpen && (
                      <div className="cp-search-dropdown">
                        {cpVisible.length === 0 ? (
                          <div className="cp-search-empty">Ничего не найдено</div>
                        ) : (
                          <>
                            {cpVisible.map((cp, i) => (
                              <button
                                type="button"
                                key={cp.id}
                                className={`cp-search-item ${cp.id === formData.counterparty_id ? 'active' : ''} ${i === cpHighlight ? 'is-highlighted' : ''}`}
                                onMouseEnter={() => setCpHighlight(i)}
                                onMouseDown={() => handleSelectCp(cp)}
                              >
                                <div className="cp-search-name">{cp.name}</div>
                                {cp.inn && <div className="cp-search-inn">ИНН: {cp.inn}</div>}
                              </button>
                            ))}
                            <div className="cp-search-hint">
                              {cpMatches.length > CP_SEARCH_LIMIT
                                ? `Показаны первые ${CP_SEARCH_LIMIT} из ${cpMatches.length} — уточните запрос`
                                : `Найдено: ${cpMatches.length}`}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* task 370: тип материала по ДС */}
                <div className="form-group full-width">
                  <label>Материал</label>
                  <select name="material_type" value={formData.material_type} onChange={handleInputChange}>
                    <option value="">— Не указан —</option>
                    {MATERIAL_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>

                {/* Тип ДС — под материалом, как и просили. */}
                <div className="form-group full-width">
                  <label>Тип ДС</label>
                  <select name="ds_type" value={formData.ds_type} onChange={handleInputChange}>
                    <option value="">— Не указан —</option>
                    {DS_TYPE_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>

                {/* Договор и номер ДС — раздельно (миграция 20261109): договор — из реестра «Договоры и ДС»,
                    единственный договор контрагента по объекту подставляется сам. */}
                {linkEnabled && (() => {
                  const choices = contracts ? contractChoicesFor(contracts, formData.counterparty_id, formData.object_id, contractParties) : []
                  const current = formData.contract_id ? contractsById.get(formData.contract_id) : null
                  return (
                    <div className="form-group">
                      <label htmlFor="dcr-form-contract">Договор</label>
                      <select
                        id="dcr-form-contract"
                        name="contract_id"
                        value={formData.contract_id}
                        onChange={handleInputChange}
                        disabled={!contracts || !formData.counterparty_id}
                      >
                        <option value="">
                          {!contracts ? 'Загрузка договоров…'
                            : !formData.counterparty_id ? '— Сначала выберите контрагента —'
                              : choices.length ? '— Не выбран —'
                                : formData.object_id ? '— У контрагента нет договоров по объекту —' : '— У контрагента нет договоров —'}
                        </option>
                        {formData.contract_id && !choices.some(c => c.id === formData.contract_id) && (
                          <option value={formData.contract_id}>
                            {current ? contractLabel(current) : 'договор не найден'}
                            {current?.object_id && formData.object_id && current.object_id !== formData.object_id ? ' · другой объект' : ''}
                          </option>
                        )}
                        {choices.map(c => (
                          <option key={c.id} value={c.id}>
                            {contractLabel(c)}{formData.object_id && !c.object_id ? ' · объект не указан' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  )
                })()}

                <div className="form-group">
                  <label htmlFor="dcr-form-dsnum">№ ДС</label>
                  <input
                    id="dcr-form-dsnum"
                    type="text"
                    name="ds_number"
                    value={formData.ds_number}
                    onChange={handleInputChange}
                    placeholder={linkEnabled ? 'например: 12' : 'например: ДС №12 / 2026-001'}
                  />
                </div>

                {/* ДС реестра договоров, в которое занесена заявка: ДС выбранного договора с тем же номером
                    подставляется само. */}
                {linkEnabled && formData.contract_id && contracts && (() => {
                  const amendments = amendmentsOf(contracts, formData.contract_id)
                  return (
                    <div className="form-group full-width">
                      <label htmlFor="dcr-form-amendment">Занесена в ДС</label>
                      <select
                        id="dcr-form-amendment"
                        name="amendment_id"
                        value={formData.amendment_id}
                        onChange={handleInputChange}
                        disabled={!amendments.length}
                      >
                        <option value="">{amendments.length ? '— Не занесена —' : '— У договора ещё нет ДС в реестре —'}</option>
                        {amendments.map(a => (
                          <option key={a.id} value={a.id}>{amendmentLabel(a)}</option>
                        ))}
                      </select>
                    </div>
                  )
                })()}

                {linkEnabled && (
                  <div className="form-group full-width">
                    <label htmlFor="dcr-form-division">Подразделение</label>
                    <select id="dcr-form-division" name="division" value={formData.division} onChange={handleInputChange}>
                      <option value="">— Не указано —</option>
                      {VOR_DIVISIONS.map(d => (
                        <option key={d.value} value={d.value}>{d.label}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Поля «Статус» здесь нет намеренно: новая заявка всегда идёт на
                    проверку по договору, а дальше статус двигают чипом в таблице
                    реестра — одно место управления вместо двух. */}

                {/* task 370: суммы ДС (с НДС 22%) — «Было подано» / «Утверждено» */}
                <div className="form-group">
                  <label>Было подано, ₽ (с НДС 22%)</label>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    name="amount_before"
                    value={formData.amount_before}
                    onChange={handleInputChange}
                    placeholder="0"
                    title={AMOUNT_INPUT_HINT}
                  />
                </div>

                <div className="form-group">
                  <label>Утверждено, ₽ (с НДС 22%)</label>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    name="amount_after"
                    value={formData.amount_after}
                    onChange={handleInputChange}
                    placeholder="0"
                    title={AMOUNT_INPUT_HINT}
                  />
                </div>

                {/* task 365: ориентировочный срок согласования */}
                <div className="form-group full-width">
                  <label>Ориентировочный срок согласования</label>
                  <input
                    type="date"
                    name="expected_approval_date"
                    value={formData.expected_approval_date}
                    onChange={handleInputChange}
                  />
                </div>

                <div className="form-group full-width">
                  <label>Ответственный сотрудник</label>
                  <select
                    name="responsible_contact_id"
                    value={contactRepById[formData.responsible_contact_id] || formData.responsible_contact_id || ''}
                    onChange={handleInputChange}
                  >
                    <option value="">— Не назначен —</option>
                    {dedupedContacts.map(c => (
                      <option key={c.id} value={c.id}>{c.full_name}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group full-width">
                  <label>Описание ДС</label>
                  <textarea
                    name="works_description"
                    rows="3"
                    value={formData.works_description}
                    onChange={handleInputChange}
                    placeholder="Краткое описание ДС"
                  />
                </div>

                {/* Именно type="text": у пути нет схемы, и нативная валидация
                    type="url" отклонила бы \\server\share\... */}
                <div className="form-group full-width">
                  <label>Путь к папке с документами</label>
                  <input
                    type="text"
                    name="folder_path"
                    value={formData.folder_path}
                    onChange={handleInputChange}
                    placeholder="\\su10-fs\ДС\ЖК Алия\ДС-14"
                  />
                  <small style={{ color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>
                    Путь показывается в колонке «Документы» с кнопкой копирования: открыть
                    проводник по клику браузер не даёт, поэтому путь копируют и вставляют
                    в его адресную строку.
                  </small>
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => { setShowModal(false); setEditing(null) }}
                  disabled={saving}
                >Отмена</button>
                <button type="submit" className="btn-primary" disabled={saving}>
                  {saving ? 'Сохранение…' : (editing ? 'Сохранить' : 'Добавить')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Результат проверки по договору: исход, заключение юриста и файлы отчёта.
          Открывается кнопкой в колонке статуса и автоматически — при попытке
          увести заявку со стадии сверки без зафиксированного исхода. */}
      {verdictModal && (() => {
        const req = requests.find(r => r.id === verdictModal.requestId)
        if (!req) return null
        const reportDocs = (docsByReq.get(req.id) || []).filter(d => d.doc_category === 'check_report')
        const readOnly = !canEditDc || !!req.deleted_at
        return (
          <div className="modal-overlay" onClick={() => !verdictSaving && setVerdictModal(null)}>
            <div className="modal dcr-verdict-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <div>
                  <h3>Результат проверки по договору</h3>
                  <p className="dcr-history-sub">
                    {`Заявка № ${req.requestNo} · `}
                    {req.ds_number ? `№ ДС ${req.ds_number}` : 'без № ДС'}
                    {req.objects?.name ? ` · ${req.objects.name}` : ''}
                    {req.counterparties?.name ? ` · ${req.counterparties.name}` : ''}
                  </p>
                </div>
                <button
                  className="modal-close"
                  onClick={() => setVerdictModal(null)}
                  disabled={verdictSaving}
                  aria-label="Закрыть"
                >×</button>
              </div>

              <div className="dcr-verdict-body">
                {verdictModal.nextStatus && (
                  <div className="dcr-verdict-note">
                    Чтобы перевести заявку в «{STATUS_LABEL[verdictModal.nextStatus]}», зафиксируйте итог сверки:
                    иначе по заявке не останется следа, чем закончилась проверка.
                  </div>
                )}

                <div className="dcr-verdict-field">
                  <label className="dcr-verdict-label">Исход проверки *</label>
                  <div className="dcr-verdict-options">
                    {CHECK_STATUS_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`dcr-verdict-option ${opt.className}${verdictModal.verdict === opt.value ? ' is-active' : ''}`}
                        onClick={() => setVerdictModal(prev => ({ ...prev, verdict: opt.value }))}
                        disabled={readOnly || verdictSaving}
                        aria-pressed={verdictModal.verdict === opt.value}
                      >{opt.label}</button>
                    ))}
                  </div>
                </div>

                <div className="dcr-verdict-field">
                  <label className="dcr-verdict-label" htmlFor="dcr-verdict-notes">Заключение</label>
                  {/* Обычная управляемая textarea: AutoGrowTextarea работает на
                      defaultValue/onInput и для формы с черновиком не подходит. */}
                  <textarea
                    id="dcr-verdict-notes"
                    className="dcr-verdict-textarea"
                    rows={4}
                    value={verdictModal.notes}
                    onChange={(e) => setVerdictModal(prev => ({ ...prev, notes: e.target.value }))}
                    placeholder="Что проверено, какие расхождения с договором найдены, что нужно исправить"
                    disabled={readOnly || verdictSaving}
                  />
                </div>

                <div className="dcr-verdict-field">
                  <label className="dcr-verdict-label">Файлы результата</label>
                  {reportDocs.length > 0 ? (
                    <div className="dcr-doc-chips">{reportDocs.map(renderDocChip)}</div>
                  ) : (
                    <p className="dcr-verdict-empty">Файлы не приложены.</p>
                  )}
                  {!readOnly && (
                    <button
                      type="button"
                      className="dcr-doc-add dcr-doc-add-final"
                      onClick={() => handleDocPick(req.id, 'check_report')}
                      title="Приложить отчёт, заключение или сравнительную таблицу"
                    >+ Файл результата</button>
                  )}
                  <p className="dcr-verdict-hint">
                    Те же файлы видны в колонке «Документы» в блоке «Отчёт по документам».
                  </p>
                </div>

                {(req.checked_by_name || req.checked_at) && (
                  <div className="dcr-verdict-signature">
                    Проверил: <strong>{req.checked_by_name || 'без имени'}</strong>
                    {req.checked_at ? ` · ${formatDateTime(req.checked_at)}` : ''}
                  </div>
                )}
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setVerdictModal(null)}
                  disabled={verdictSaving}
                >{readOnly ? 'Закрыть' : 'Отмена'}</button>
                {!readOnly && (
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={handleSaveVerdict}
                    disabled={verdictSaving || !verdictModal.verdict}
                  >
                    {verdictSaving
                      ? 'Сохранение…'
                      : verdictModal.nextStatus
                        ? `Сохранить и перевести в «${STATUS_LABEL[verdictModal.nextStatus]}»`
                        : 'Сохранить'}
                  </button>
                )}
              </div>
            </div>
          </div>
        )
      })()}

      {previewDoc && (
        <S3DocumentPreview doc={previewDoc} onClose={() => setPreviewDoc(null)} />
      )}

      {showSectionDocs && (
        <DcRequestDocsModal onClose={() => setShowSectionDocs(false)} canEditTemplates={isAdmin} />
      )}

      {/* История изменений заявки. Только чтение; закрывается крестиком/«Закрыть». */}
      {historyFor && (
        <div className="modal-overlay">
          <div className="modal dcr-history-modal">
            <div className="modal-header">
              <div>
                <h3>История изменений</h3>
                <p className="dcr-history-sub">
                  {`Заявка № ${historyFor.requestNo} · `}
                  {historyFor.ds_number ? `№ ДС ${historyFor.ds_number}` : 'без № ДС'}
                  {historyFor.objects?.name ? ` · ${historyFor.objects.name}` : ''}
                </p>
              </div>
              <button className="modal-close" onClick={() => setHistoryFor(null)} aria-label="Закрыть">×</button>
            </div>
            <div className="dcr-history-body">
              {historyLoading ? (
                <div className="loading">Загрузка...</div>
              ) : historyRows.length === 0 ? (
                <div className="dcr-history-empty">
                  <p>Записей нет.</p>
                  <p className="dcr-history-hint">
                    История ведётся с момента подключения этой функции — более ранние изменения
                    не фиксировались.
                  </p>
                </div>
              ) : (
                <ul className="audit-list">
                  {historyRows.map(ev => (
                    <li key={ev.id} className="audit-item">
                      <div className="audit-meta">
                        <span className="audit-type">{EVENT_LABEL[ev.event_type] || ev.event_type}</span>
                        <span className="audit-date">{formatDateTime(ev.changed_at)}</span>
                      </div>
                      <div className="audit-desc">{ev.description || '—'}</div>
                      <div className="audit-who">
                        {ev.changed_by_name || 'без имени'}
                        {ev.changed_by_role ? ` (${ev.changed_by_role})` : ''}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-secondary" onClick={() => setHistoryFor(null)}>Закрыть</button>
            </div>
          </div>
        </div>
      )}

      {/* task 324: модалка редактирования ссылки на общую таблицу с отделами */}
      {showLinkModal && (
        <div className="modal-overlay" onClick={() => setShowLinkModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '520px' }}>
            <div className="modal-header">
              <h3>{externalLink ? 'Изменить ссылку на общую таблицу' : 'Указать ссылку на общую таблицу'}</h3>
              <button className="modal-close" onClick={() => setShowLinkModal(false)}>×</button>
            </div>
            <form onSubmit={saveExternalLink}>
              <div className="form-grid">
                <div className="form-group full-width">
                  <label>URL общей таблицы отделов</label>
                  <input
                    type="url"
                    value={linkInput}
                    onChange={(e) => setLinkInput(e.target.value)}
                    placeholder="https://docs.google.com/spreadsheets/…"
                    autoFocus
                  />
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.375rem' }}>
                    Оставьте поле пустым, чтобы удалить ссылку.
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowLinkModal(false)}>
                  Отмена
                </button>
                <button type="submit" className="btn-primary">Сохранить</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Модалка загрузки документа */}
      {docUpload && (
        <div
          className="modal-overlay"
          onClick={() => !docUploadBusy && setDocUpload(null)}
        >
          <div className="modal dcr-doc-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{docUpload.category === 'final'
                ? 'Загрузка итогового документа'
                : docUpload.category === 'check_report' ? 'Загрузка отчёта по документам' : 'Загрузка документа'}</h3>
              <button
                className="modal-close"
                onClick={() => !docUploadBusy && setDocUpload(null)}
                disabled={docUploadBusy}
              >×</button>
            </div>
            <div className="dcr-doc-modal-body">
              <div className="dcr-doc-modal-file">
                <span className="dcr-doc-modal-icon" aria-hidden>📄</span>
                <div className="dcr-doc-modal-fileinfo">
                  <span className="dcr-doc-modal-filename" title={docUpload.file.name}>
                    {docUpload.file.name}
                  </span>
                  <span className="dcr-doc-modal-filesize">{formatBytes(docUpload.file.size)}</span>
                </div>
              </div>
              <label className="dcr-doc-modal-field">
                <span>Описание документа (опционально)</span>
                <textarea
                  rows="3"
                  value={docUpload.description}
                  onChange={(e) => setDocUpload(s => s ? { ...s, description: e.target.value } : s)}
                  placeholder="Кратко — что внутри файла"
                  autoFocus
                />
              </label>
            </div>
            <div className="dcr-doc-modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setDocUpload(null)}
                disabled={docUploadBusy}
              >Отмена</button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleDocUploadConfirm}
                disabled={docUploadBusy}
              >{docUploadBusy ? 'Загрузка…' : 'Загрузить'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default DcRequestsPage
