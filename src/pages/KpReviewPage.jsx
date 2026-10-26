import { Fragment, useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useRole } from '../contexts/RoleContext'
import { fetchProposalFilesForReview, setRemarksSent, setSummaryAdded, setReviewStage } from '../services/tenderProposalFiles'
import { stageOf, STAGE_KEYS, STAGE_GROUPS, TAB_META } from '../utils/kpReviewStages'
import { kpDownloadName } from '../utils/kpDownloadName'
import { plural } from '../utils/taskHelpers'
import { shortPersonName } from '../utils/personName'
import { copyToClipboard } from '../utils/clipboard'
import { requestDownloadUrl } from '../services/s3'
import { IconDownload } from '../components/icons/ActionIcons'
import { IconCoins, IconFolder, IconSearch } from '../components/icons/ToolbarIcons'
import { IconShieldCheck } from '../components/icons/TenderHubIcons'
import IconTile from '../components/IconTile'
import KpReviewBadge from '../components/KpReviewBadge'
import KpReviewModal from '../components/KpReviewModal'
import S3DocumentPreview from '../components/S3DocumentPreview'
import VirtualTableBody from '../components/VirtualTableBody'
import PersonName from '../components/PersonName'
import ClampText from '../components/ClampText'
import useBodyClass from '../hooks/useBodyClass'
import './KpReviewPage.css'
// Рабочий стиль (docs/UI_GUIDELINES.md) — после CSS страницы.
import '../styles/fonts.css'
import '../styles/workUi.css'

// Порог включения виртуализации <tbody> (строки тендеров + строки КП): ниже него
// распорки и замеры высот только мешают, выше — обычная таблица подтормаживает.
const VIRTUALIZE_FROM = 150

// task 431: вкладка «Проверка КП» — очередь коммерческих предложений на проверку
// аналитиком-экономистом. КП сгруппированы по тендеру: строка тендера (номер,
// направление, работы, объект, ответственные, план затрат, папка), под ней — по
// строке на КП. Экономист/админ проставляет «проверено» или «есть замечания»,
// дальше КП идёт по своей ветке (utils/kpReviewStages.js).

const HINT = 'Коммерческие предложения контрагентов на проверку. Сюда попадают только КП, '
  + 'загруженные с момента запуска функции; ранее загруженные остаются в тендерах.'

const pad2 = (x) => String(x).padStart(2, '0')

// «25.10.26» — год двумя цифрами: в узкой колонке полный год не нужен, целиком
// дата со временем — в подсказке (fmtDateTime).
function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${pad2(d.getFullYear() % 100)}`
}

function fmtDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// Небольшие SVG-иконки (проект использует SVG-иконки, не эмодзи).
const IconFile = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
)

const IconDone = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

const IconCheck = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

// Шеврон: шаг маршрута внутри ветки, раскрытие группы, направление сортировки.
const IconChevron = ({ size = 12, className }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
)

const IconExternal = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 17 17 7" /><path d="M8 7h9v9" />
  </svg>
)

// «Ещё» — три точки: ручная установка этапа (суперпользователь).
const IconMore = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="19" r="1.8" />
  </svg>
)

const IconInfo = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" />
  </svg>
)

// Направление тендера коротким бейджем в строке тендера: из какого отдела пришёл
// КП. Берём tenders.department (миграция 20260820); у тендеров, заведённых до неё,
// поля может не быть — тогда падаем на статус объекта, как раньше считался отдел.
const DEPT_BADGE = {
  construction: { short: 'ОС', title: 'Основное строительство' },
  warranty: { short: 'ГО', title: 'Гарантийный отдел' },
  joint: { short: 'Совм.', title: 'Совместные тендеры' },
  other: { short: 'Проч.', title: 'Тендеры (прочее)' },
}

function tenderDeptKey(tender) {
  return tender?.department
    || (tender?.objects?.status === 'warranty_service' ? 'warranty' : null)
    || (tender?.objects?.status === 'main_construction' ? 'construction' : null)
}

function TenderDeptBadge({ tender }) {
  const key = tenderDeptKey(tender)
  const meta = DEPT_BADGE[key]
  if (!meta) return null
  return (
    <span className={`kprv-dept kprv-dept-${key}`} title={meta.title}>{meta.short}</span>
  )
}

// Отбор по направлению — галочки справа от поиска, можно несколько сразу;
// ничего не отмечено — показываем все КП.
const DEPT_FILTER_KEYS = ['construction', 'warranty', 'other', 'joint']
// Выбор переживает обновление страницы — хранится в браузере пользователя.
const DEPTS_STORAGE_KEY = 'kpReview:depts'

function loadSavedDepts() {
  try {
    const saved = JSON.parse(localStorage.getItem(DEPTS_STORAGE_KEY) || '[]')
    return new Set(Array.isArray(saved) ? saved.filter(k => DEPT_FILTER_KEYS.includes(k)) : [])
  } catch {
    return new Set()
  }
}

function DeptFilter({ deptKey, checked, count, onToggle }) {
  const m = DEPT_BADGE[deptKey]
  return (
    <label className={`kprv-dept-chip${checked ? ' is-on' : ''}`} title={m.title}>
      <input
        type="checkbox"
        checked={checked}
        onChange={() => onToggle(deptKey)}
        aria-label={`${m.title}: ${count}`}
      />
      <span className="kprv-dept-chip-box" aria-hidden><IconCheck /></span>
      <span className="kprv-dept-chip-label" aria-hidden>{m.short}</span>
      <span className={`kprv-dept-chip-count${count ? '' : ' is-zero'}`} aria-hidden>{count}</span>
    </label>
  )
}

// План затрат тендера: мини-кнопка «ПЗ ↗», если есть ссылка, иначе — стадия
// работы над планом. Метки те же, что на странице «Планы затрат», чтобы не
// расходились названия. Монеты — значок раздела «Планы затрат».
const COST_PLAN_LABEL = {
  not_started: 'Не начат',
  in_progress: 'В работе',
  awaiting_kp: 'Ожидание КП',
  completed: 'Завершён',
  not_required: 'Не требуется',
}

function CostPlanMark({ tender }) {
  const link = tender?.cost_plan_link
  if (link) {
    return (
      <a
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        className="kprv-plan-btn"
        title={`Открыть план затрат в новой вкладке\n${link}`}
        aria-label="ПЗ — открыть план затрат"
      >
        <IconCoins size={13} />
        <span>ПЗ</span>
        <IconExternal />
      </a>
    )
  }
  const status = tender?.cost_plan_status || 'not_started'
  // «Завершён» без ссылки — рассогласование данных, помечаем явно: иначе
  // выглядит как готовый план, который просто некуда открыть.
  if (status === 'completed') {
    return <span className="kprv-plan-state is-warn" title="План затрат: статус «Завершён», но ссылка не указана">ПЗ: нет ссылки</span>
  }
  const label = COST_PLAN_LABEL[status] || COST_PLAN_LABEL.not_started
  // «ПЗ: ожидание КП» — строчная только первая буква: аббревиатуры остаются прописными.
  return (
    <span className="kprv-plan-state" title={`План затрат: ${label}, ссылки пока нет`}>
      ПЗ: {label[0].toLowerCase() + label.slice(1)}
    </span>
  )
}

// Путь к папке тендера — то же поле, что в реестре тендеров и планах затрат.
// Здесь только копирование одним нажатием (проводник со страницы не открыть —
// см. FolderPathCell), сам путь — в подсказке. Правят его там, где ведут тендер.
function FolderCopyButton({ path }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  if (!path) return null
  const copy = async () => {
    const ok = await copyToClipboard(path)
    if (!ok) { alert('Не удалось скопировать путь. Выделите его и скопируйте вручную:\n' + path); return }
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      type="button"
      className={`kprv-mini-btn${copied ? ' is-done' : ''}`}
      title={`${path}\nНажмите, чтобы скопировать путь и вставить в адресную строку проводника`}
      aria-label="Папка — скопировать путь к папке тендера"
      onClick={copy}
    >
      {/* Скопировано — галочка вместо папки на 2 секунды; ширина кнопки не меняется. */}
      {copied ? <IconDone /> : <IconFolder size={13} />}
      <span>Папка</span>
    </button>
  )
}

// Отметка шага в строке КП («занесено в сводную», «отправлено подрядчику»):
// флажок для того, кто вправе отметить, у остальных — то же состояние без
// действия. Кто и когда отметил — в подсказке.
function StepMark({ done, at, by, label, canToggle, busy, onToggle }) {
  const who = [by, fmtDateTime(at)].filter(Boolean).join(' · ')
  const title = done
    ? `${label}${who ? `: ${who}` : ''}${canToggle ? '\nСнять отметку — нажать ещё раз' : ''}`
    : `${label} — ещё нет${canToggle ? '\nНажмите, когда будет сделано' : ''}`
  const box = <span className="kprv-step-box" aria-hidden><IconCheck /></span>
  if (!canToggle) {
    return (
      <span className={`kprv-step is-static${done ? ' is-done' : ''}`} title={title}>
        {box}
        <span className="ui-sr-only">{`${label}: ${done ? 'да' : 'нет'}`}</span>
      </span>
    )
  }
  return (
    <label className={`kprv-step${done ? ' is-done' : ''}${busy ? ' is-busy' : ''}`} title={title}>
      <input
        type="checkbox"
        checked={!!done}
        disabled={busy}
        aria-label={label}
        onChange={() => onToggle(!done)}
      />
      {box}
    </label>
  )
}

// Поля, которые возвращает отметка шага: их подставляем в строку сразу, не
// дожидаясь полного перечитывания списка.
const STEP_FIELDS = {
  summary: ['summary_added', 'summary_added_at', 'summary_added_by'],
  sent: ['remarks_sent', 'remarks_sent_at', 'remarks_sent_by'],
}

// Значение для сортировки. null → строка уходит вниз при любом направлении:
// «нет данных» это не «самое маленькое».
function sortValue(r, key) {
  if (key === 'tender_no') {
    const n = r.tenders?.public_tender_number
    return typeof n === 'number' ? n : null
  }
  const iso = key === 'reviewed_at' ? r.reviewed_at : r.created_at
  if (!iso) return null
  const t = new Date(iso).getTime()
  return isNaN(t) ? null : t
}

function cmpNullLast(va, vb, sign) {
  if (va === null || vb === null) {
    if (va === vb) return 0
    return va === null ? 1 : -1
  }
  return (va - vb) * sign
}

// Строки → группы по тендеру. Внутри группы строки идут в выбранном порядке
// (при сортировке по № тендера — свежие КП сверху), группы — по первой строке:
// «свежие сверху» поднимает тендер с самым свежим КП. Пустые значения — вниз.
function groupByTender(rows, sort) {
  const sign = sort.dir === 'asc' ? 1 : -1
  const byCreated = (a, b) => cmpNullLast(sortValue(a, 'created_at'), sortValue(b, 'created_at'), -1)
  const inGroup = sort.key === 'tender_no'
    ? byCreated
    : (a, b) => cmpNullLast(sortValue(a, sort.key), sortValue(b, sort.key), sign) || byCreated(a, b)
  const map = new Map()
  for (const r of rows) {
    const key = r.tenders?.id || r.tender_id
    let g = map.get(key)
    if (!g) {
      g = { key, tender: r.tenders || null, rows: [] }
      map.set(key, g)
    }
    g.rows.push(r)
  }
  const groups = [...map.values()]
  for (const g of groups) g.rows.sort(inGroup)
  return groups.sort((a, b) => cmpNullLast(sortValue(a.rows[0], sort.key), sortValue(b.rows[0], sort.key), sign)
    || byCreated(a.rows[0], b.rows[0])
    || String(a.key).localeCompare(String(b.key)))
}

function SortTh({ label, sortKey, sort, onSort, className = '', title }) {
  const active = sort.key === sortKey
  return (
    <th
      className={`kprv-th-sort${active ? ' is-active' : ''}${className ? ` ${className}` : ''}`}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button type="button" className="kprv-sort-btn" title={title} onClick={() => onSort(sortKey)}>
        <span>{label}</span>
        {/* Неактивный столбец — тот же шеврон приглушённым: видно, что колонка кликабельна. */}
        <span className={`kprv-sort-mark is-${active ? sort.dir : 'off'}`}><IconChevron size={11} /></span>
      </button>
    </th>
  )
}

// Вкладка этапа — она же очередь работы со счётчиком. Ветка подписана над её
// этапами, поэтому подпись вкладки короткая; полная и кто делает шаг — в подсказке.
function StageTab({ tabKey, tab, counts, onSelect }) {
  const m = TAB_META[tabKey]
  const isActive = tab === tabKey
  const count = counts[tabKey] ?? 0
  const full = m.title || m.label
  // Очередь — этап, где ждут работы: её непустой счётчик подсвечен тоном.
  const isQueue = !m.terminal && tabKey !== 'all'
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      aria-label={`${full}: ${count}`}
      title={m.actor ? `${full}\nДелает: ${m.actor}` : full}
      data-stage={tabKey}
      className={`kprv-stage is-${m.tone}${isActive ? ' is-active' : ''}`}
      onClick={() => onSelect(tabKey)}
    >
      {m.terminal && <IconDone />}
      <span className="kprv-stage-label">{m.short || m.label}</span>
      <span className={`kprv-stage-count${count ? (isQueue ? ' is-work' : '') : ' is-zero'}`}>{count}</span>
    </button>
  )
}

const EMPTY_TEXT = {
  pending: 'Нет КП, ожидающих проверки.',
  ok_summary: 'Нет КП без замечаний, ожидающих занесения в сводную таблицу.',
  ok_done: 'Нет полностью отработанных КП без замечаний.',
  remarks_work: 'Нет КП с замечаниями, ожидающих занесения в сводную таблицу и отправки подрядчику.',
  remarks_sent: 'Нет КП с замечаниями, у которых сделано и занесение в сводную, и отправка подрядчику.',
  nosend_summary: 'Нет КП с замечаниями без отправки подрядчику, ожидающих занесения в сводную таблицу.',
  nosend_done: 'Нет отработанных КП с замечаниями без отправки подрядчику.',
}

function KpReviewPage() {
  useBodyClass('ui-work-portal')
  const { isAdmin, isSuperAdmin, role, scopedObjectIds, userProfile, user } = useRole()
  // Аналитик-экономист (или админ) проставляет вердикт/замечания.
  // isSuperAdmin — доступ по e-mail (RoleContext): суперпользователь проверяет КП
  // всегда, даже когда переключился на другую роль для проверки интерфейса.
  const canReview = isAdmin || isSuperAdmin || role === 'economist'
  // Инженер (или админ) отмечает отправку замечаний контрагенту.
  const canSend = isAdmin || isSuperAdmin || role === 'engineer'
  // Занесение в сводную таблицу делает аналитик-экономист — в ветках «без
  // замечаний» и «без отправки подрядчику» это вообще его единственный шаг.
  // Инженеру доступ тоже нужен: в ветке «для отправки подрядчику» занесение и
  // отправка идут параллельно и делаются одним человеком.
  const canSummary = canSend || canReview
  // Колонка «Действия» — только тем, у кого в ней что-то есть.
  const hasActions = canReview || isSuperAdmin
  const colCount = hasActions ? 8 : 7
  const actor = userProfile?.full_name || user?.email || ''

  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('pending')
  const [search, setSearch] = useState('')
  // Отмеченные направления (ключи DEPT_BADGE); пустой набор — без отбора.
  const [depts, setDepts] = useState(loadSavedDepts)
  useEffect(() => {
    try { localStorage.setItem(DEPTS_STORAGE_KEY, JSON.stringify([...depts])) } catch { /* приватный режим */ }
  }, [depts])
  // По умолчанию — как раньше: свежие КП сверху (и тендер со свежим КП — первым).
  const [sort, setSort] = useState({ key: 'created_at', dir: 'desc' })
  // Свёрнутые тендеры (id); не сохраняются между заходами.
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [reviewFile, setReviewFile] = useState(null)
  const [previewDoc, setPreviewDoc] = useState(null)
  // Отметки шагов в полёте («<id КП>:summary» / «<id КП>:sent»): флажок занят,
  // повторное нажатие второй запрос не шлёт.
  const [busySteps, setBusySteps] = useState(() => new Set())
  // Открытое меню ручной установки этапа: { id, up } | null. `up` — раскрыть
  // вверх: таблица прокручивается внутри себя и обрезает меню у нижних строк.
  const [stagePopover, setStagePopover] = useState(null)
  const stagePopoverFor = stagePopover?.id ?? null
  // Скролл-контейнер таблицы — из него виртуализация берёт положение прокрутки.
  const tableWrapRef = useRef(null)

  // Закрытие меню этапа по клику вне и по Escape.
  useEffect(() => {
    if (!stagePopoverFor) return
    const onMousedown = (e) => {
      if (!e.target.closest('.kprv-stage-wrap')) setStagePopover(null)
    }
    const onKeydown = (e) => { if (e.key === 'Escape') setStagePopover(null) }
    // Откладываем на тик, иначе открывающий клик тут же закроет меню.
    const t = setTimeout(() => document.addEventListener('mousedown', onMousedown), 0)
    document.addEventListener('keydown', onKeydown)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onMousedown)
      document.removeEventListener('keydown', onKeydown)
    }
  }, [stagePopoverFor])

  // silent — обновление после действия в строке (отметка, этап, проверка).
  // Раньше каждое действие включало «Загрузка…»: таблица размонтировалась,
  // и прокрутка улетала в самый верх. Теперь таблица остаётся на месте, а
  // строки подменяются, когда придут свежие данные.
  // Отметки подряд запускают несколько перечитываний; ответ старого, пришедший
  // позже нового, не должен вернуть только что снятую отметку — берём последний.
  const loadSeq = useRef(0)
  const load = useCallback(async ({ silent = false } = {}) => {
    const seq = ++loadSeq.current
    if (!silent) setLoading(true)
    setError(null)
    try {
      const data = await fetchProposalFilesForReview({
        objectIds: scopedObjectIds.length ? scopedObjectIds : null,
      })
      if (seq !== loadSeq.current) return
      setRows(data)
    } catch (e) {
      if (seq !== loadSeq.current) return
      if (silent) {
        // Действие уже сохранено, не удалось только перечитать список: таблицу
        // не прячем за экраном ошибки (иначе снова сброс прокрутки).
        console.error('Не удалось обновить список КП:', e.message)
      } else {
        setError(e.message || 'Не удалось загрузить КП на проверку')
        setRows([])
      }
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [scopedObjectIds])

  useEffect(() => { load() }, [load])

  // Отметка шага: «занесено в сводную» (общий шаг всех веток) или «отправлено
  // подрядчику» (параллельно занесению, только в подветке с отправкой). Ответ базы
  // сразу подставляется в строку, затем список перечитывается целиком — так
  // подтягиваются и чужие правки.
  const handleStep = async (r, kind, next) => {
    const key = `${r.id}:${kind}`
    if (busySteps.has(key)) return
    setBusySteps(prev => new Set(prev).add(key))
    try {
      const updated = kind === 'summary'
        ? await setSummaryAdded(r.id, { added: next, author: actor })
        : await setRemarksSent(r.id, { sent: next, sender: actor })
      if (updated) {
        const patch = Object.fromEntries(STEP_FIELDS[kind].map(f => [f, updated[f] ?? null]))
        setRows(prev => prev.map(x => (x.id === r.id ? { ...x, ...patch } : x)))
      }
      load({ silent: true })
    } catch (e) {
      alert(`${kind === 'summary' ? 'Ошибка отметки о занесении в сводную' : 'Ошибка отметки отправки'}: ${e.message || e}`)
    } finally {
      setBusySteps(prev => {
        const n = new Set(prev)
        n.delete(key)
        return n
      })
    }
  }

  // Ручная установка этапа (только суперпользователь): чинит ошибки, когда КП
  // ушло не в ту ветку или не на тот шаг.
  const handleSetStage = async (r, stage) => {
    setStagePopover(null)
    if (stageOf(r) === stage) return
    try {
      await setReviewStage(r.id, stage, { author: actor })
      load({ silent: true })
    } catch (e) {
      alert('Не удалось поставить этап: ' + (e.message || e))
    }
  }

  // Скачивание КП одним кликом под именем «№ тендера_контрагент_тендер_объект»:
  // имя ставит сервер (Content-Disposition), a.download на чужом домене не работает.
  // Пока ссылка запрашивается, кнопка занята — повторный клик второй файл не качает.
  const [downloadingIds, setDownloadingIds] = useState(() => new Set())
  const handleDownload = async (r) => {
    if (!r.s3?.s3_key || downloadingIds.has(r.id)) return
    const fileName = kpDownloadName(r)
    setDownloadingIds(prev => new Set(prev).add(r.id))
    try {
      const { presigned_url } = await requestDownloadUrl(r.s3.s3_key, { fileName, download: true })
      const a = document.createElement('a')
      a.href = presigned_url
      a.download = fileName
      a.target = '_blank'
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (e) {
      alert('Не удалось скачать КП: ' + (e.message || e))
    } finally {
      setDownloadingIds(prev => {
        const next = new Set(prev)
        next.delete(r.id)
        return next
      })
    }
  }

  // Первый клик по новому столбцу: номер — по возрастанию, даты — от свежих.
  const toggleSort = useCallback((key) => {
    setSort(s => (s.key === key
      ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'tender_no' ? 'asc' : 'desc' }))
  }, [])

  const toggleDept = useCallback((key) => {
    setDepts(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const toggleCollapsed = useCallback((key) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const inDepts = useCallback(
    (r) => depts.size === 0 || depts.has(tenderDeptKey(r.tenders)),
    [depts],
  )

  // Счётчики этапов — с учётом отбора по направлениям: отметил ГО — очереди
  // показывают работу ГО, а не всего отдела.
  const counts = useMemo(() => {
    const c = Object.fromEntries(STAGE_KEYS.map(k => [k, 0]))
    let all = 0
    for (const r of rows) {
      if (!inDepts(r)) continue
      all++
      const st = stageOf(r)
      c[st] = (c[st] || 0) + 1
    }
    c.all = all
    return c
  }, [rows, inDepts])

  // Строки открытого этапа и поиска — без отбора по направлениям.
  const tabRows = useMemo(() => {
    const s = search.trim().toLowerCase()
    return rows.filter(r => {
      if (tab !== 'all' && stageOf(r) !== tab) return false
      if (!s) return true
      // ФИО — полностью и так, как они видны в таблице («Петрова А. С.»).
      const people = [
        r.tenders?.responsible_contact?.full_name,
        r.tenders?.cost_plan_responsible?.full_name,
        r.reviewed_by,
      ].filter(Boolean)
      const hay = [
        r.counterparties?.name,
        r.tenders?.public_tender_number,
        r.tenders?.work_description,
        r.tenders?.objects?.name,
        r.s3?.file_name,
        r.version_label,
        ...people,
        ...people.map(shortPersonName),
      ].filter(v => v != null && v !== '').join(' ').toLowerCase()
      return hay.includes(s)
    })
  }, [rows, tab, search])

  // Число у галочки — сколько КП этого направления в открытом этапе с учётом
  // поиска: ровно столько строк прибавится в списке, если её отметить.
  const deptCounts = useMemo(() => {
    const c = Object.fromEntries(Object.keys(DEPT_BADGE).map(k => [k, 0]))
    for (const r of tabRows) {
      const k = tenderDeptKey(r.tenders)
      if (k in c) c[k]++
    }
    return c
  }, [tabRows])

  const groups = useMemo(
    () => groupByTender(tabRows.filter(inDepts), sort),
    [tabRows, inDepts, sort],
  )
  const shownCount = useMemo(() => groups.reduce((n, g) => n + g.rows.length, 0), [groups])

  const renderGroupRow = (g) => {
    const t = g.tender || {}
    const isCollapsed = collapsed.has(g.key)
    const num = t.public_tender_number
    const tenderTitle = t.work_description || 'Тендер'
    const objectName = t.objects?.name
    return (
      <tr key={`g:${g.key}`} className={`kprv-group${isCollapsed ? ' is-collapsed' : ''}`} data-tender={g.key}>
        <td className="kprv-gutter">
          <button
            type="button"
            className="kprv-collapse"
            aria-expanded={!isCollapsed}
            aria-label={`${isCollapsed ? 'Показать' : 'Скрыть'} КП тендера${num != null ? ` № ${num}` : ''}`}
            title={isCollapsed ? 'Показать КП тендера' : 'Скрыть КП тендера'}
            onClick={() => toggleCollapsed(g.key)}
          >
            <IconChevron size={12} />
          </button>
          <span className="kprv-tnum" title={num != null ? `Тендер № ${num}` : 'Номер тендера не присвоен'}>
            {num != null ? num : '—'}
          </span>
        </td>
        <td className="kprv-group-cell" colSpan={colCount - 1}>
          <div className="kprv-group-in">
            {/* Работы и объект — один текст до двух строк (полностью — в подсказке
                и в карточке тендера); работы — ссылка в карточку. */}
            <div className="kprv-group-main">
              <TenderDeptBadge tender={t} />
              <span className="kprv-group-title" title={objectName ? `${tenderTitle}\nОбъект: ${objectName}` : tenderTitle}>
                {t.id
                  ? <Link to={`/tenders/${t.id}`} className="kprv-tender-link">{tenderTitle}</Link>
                  : <span className="kprv-tender-link">{tenderTitle}</span>}
                {objectName && <span className="kprv-object"> · {objectName}</span>}
                {isCollapsed && <span className="kprv-object"> · скрыто КП: {g.rows.length}</span>}
              </span>
            </div>
            <div className="kprv-group-meta">
              <span className="kprv-meta" title={t.responsible_contact?.full_name ? undefined : 'Ответственный по тендеру не назначен'}>
                <span className="kprv-meta-label">Отв.</span>
                {t.responsible_contact?.full_name
                  ? <PersonName full={t.responsible_contact.full_name} titlePrefix="Ответственный по тендеру" />
                  : <span className="kprv-na">—</span>}
              </span>
              {/* Ответственный по плану затрат — то же поле тендера, что и в разделе
                  «Планы затрат» (tenders.cost_plan_responsible_id): источник один,
                  значения не разойдутся. */}
              <span className="kprv-meta">
                <CostPlanMark tender={t} />
                {t.cost_plan_responsible?.full_name && (
                  <PersonName full={t.cost_plan_responsible.full_name} titlePrefix="Ответственный по плану затрат" />
                )}
              </span>
              <span className="kprv-meta"><FolderCopyButton path={t.folder_path} /></span>
            </div>
          </div>
        </td>
      </tr>
    )
  }

  const renderKpRow = (r, isLast) => {
    const reviewed = r.review_status === 'approved' || r.review_status === 'has_remarks'
    const remarks = r.review_status === 'has_remarks'
    const sendRequired = remarks && r.remarks_send_required !== false
    const downloading = downloadingIds.has(r.id)
    return (
      <tr key={r.id} className={`kprv-kp${isLast ? ' is-last' : ''}`} data-kp={r.id}>
        <td className="kprv-tree" aria-hidden="true" />
        {/* Метка версии («исходное», «после переторжки») — рядом с контрагентом:
            различает его КП в одном тендере. */}
        <td className="kprv-cp">
          {r.counterparties?.name || '—'}
          {r.version_label && <span className="kprv-vlabel" title="Метка версии КП"> · {r.version_label}</span>}
        </td>
        <td className="kprv-file">
          <span className="kprv-file-line">
            <button
              type="button"
              className="kprv-file-btn"
              title={r.s3?.file_name ? `Открыть КП: ${r.s3.file_name}` : 'Файл КП не найден'}
              onClick={() => r.s3 && setPreviewDoc(r.s3)}
              disabled={!r.s3}
            >
              <IconFile />
              <span>КП</span>
            </button>
            {r.s3?.s3_key && (
              <button
                type="button"
                className={`kprv-icon-btn${downloading ? ' is-busy' : ''}`}
                title={`Скачать как «${kpDownloadName(r)}»`}
                aria-label="Скачать КП"
                aria-busy={downloading}
                disabled={downloading}
                onClick={() => handleDownload(r)}
              >
                <IconDownload size={15} />
              </button>
            )}
          </span>
        </td>
        {/* data-label — подпись ячейки на телефоне (там нет шапки таблицы). */}
        <td className="kprv-date" data-label="Загружен" title={`Загружено ${fmtDateTime(r.created_at)}`}>{fmtDate(r.created_at)}</td>
        {/* Проверка целиком в одной ячейке: вердикт, кто и когда проверил, затем
            замечания и файл замечаний. Бейдж общий с карточкой тендера, его
            плашка и файл встают в общий ряд (display: contents в CSS). */}
        <td className="kprv-status">
          <div className="kprv-status-in">
            <KpReviewBadge file={r} canReview={canReview} onReview={setReviewFile} />
            {r.reviewed_by && (
              <span className="kprv-who">
                <PersonName full={r.reviewed_by} titlePrefix="Кто проверил" />
                {r.reviewed_at && <span className="kprv-sub" title={`Проверено ${fmtDateTime(r.reviewed_at)}`}>{fmtDate(r.reviewed_at)}</span>}
              </span>
            )}
            {remarks && r.review_note && (
              <div className="kprv-remarks">
                <ClampText text={r.review_note} lines={2} />
              </div>
            )}
          </div>
        </td>
        {/* Шага ещё (или вовсе) нет — ячейка пустая: до вердикта аналитика
            отмечать нечего, без замечаний — нечего отправлять. */}
        {/* Занесение в сводную — общий шаг всех веток после вердикта. */}
        <td className={`kprv-step-cell kprv-step-sum${reviewed ? '' : ' is-empty'}`} data-label="В сводной">
          {reviewed && (
            <StepMark
              done={!!r.summary_added}
              at={r.summary_added_at}
              by={r.summary_added_by}
              label="Занесено в сводную таблицу"
              canToggle={canSummary}
              busy={busySteps.has(`${r.id}:summary`)}
              onToggle={(next) => handleStep(r, 'summary', next)}
            />
          )}
        </td>
        {/* Отправка замечаний идёт параллельно занесению в сводную: порядок между
            ними не навязываем. Только в подветке «для отправки подрядчику». */}
        <td className={`kprv-step-cell kprv-step-sent${remarks ? '' : ' is-empty'}`} data-label="Подрядчику">
          {sendRequired ? (
            <StepMark
              done={!!r.remarks_sent}
              at={r.remarks_sent_at}
              by={r.remarks_sent_by}
              label="Замечания отправлены подрядчику"
              canToggle={canSend}
              busy={busySteps.has(`${r.id}:sent`)}
              onToggle={(next) => handleStep(r, 'sent', next)}
            />
          ) : remarks && (
            <span className="kprv-na" title="Замечания обрабатываются без отправки подрядчику">без отправки</span>
          )}
        </td>
        {hasActions && (
          <td className="kprv-actions">
            <div className="kprv-actions-in">
              {canReview && (
                <button
                  type="button"
                  className={`kprv-btn${r.review_status === 'pending' ? ' is-primary' : ''}`}
                  onClick={() => setReviewFile(r)}
                >{r.review_status === 'pending' ? 'Проверить' : 'Изменить'}</button>
              )}
              {/* Ручная установка этапа — служебный инструмент правки ошибок,
                  поэтому только суперпользователю и приглушённо. */}
              {isSuperAdmin && (
                <div className="kprv-stage-wrap">
                  <button
                    type="button"
                    className={`kprv-stage-btn${stagePopoverFor === r.id ? ' is-open' : ''}`}
                    title="Этап вручную: поставить КП на любой этап проверки"
                    aria-label="Этап вручную"
                    aria-haspopup="listbox"
                    aria-expanded={stagePopoverFor === r.id}
                    onClick={(e) => {
                      if (stagePopover?.id === r.id) { setStagePopover(null); return }
                      // Меню высокое (~260px), а таблица прокручивается
                      // внутри себя: у нижних строк раскрываем вверх.
                      const btn = e.currentTarget.getBoundingClientRect()
                      const wrap = tableWrapRef.current?.getBoundingClientRect()
                      const up = !!wrap && btn.bottom + 270 > wrap.bottom
                      setStagePopover({ id: r.id, up })
                    }}
                  ><IconMore /></button>
                  {stagePopoverFor === r.id && (
                    <div className={`kprv-stage-menu${stagePopover.up ? ' is-up' : ''}`} role="listbox">
                      <div className="kprv-stage-hint">
                        Поставить этап вручную. Замечания и вложенный файл
                        при этом сохраняются.
                      </div>
                      {STAGE_GROUPS.map(g => (
                        <div key={g.title} className="kprv-stage-group">
                          <div className="kprv-stage-group-title">{g.title}</div>
                          {g.keys.map(key => {
                            const isCurrent = stageOf(r) === key
                            return (
                              <button
                                key={key}
                                type="button"
                                role="option"
                                aria-selected={isCurrent}
                                className={`kprv-stage-item${isCurrent ? ' is-current' : ''}`}
                                title={TAB_META[key].title || TAB_META[key].label}
                                onClick={() => handleSetStage(r, key)}
                              >
                                {TAB_META[key].label}
                                {isCurrent && <span className="kprv-stage-check" aria-hidden><IconDone /></span>}
                              </button>
                            )
                          })}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </td>
        )}
      </tr>
    )
  }

  let body = null
  if (loading) {
    body = <div className="kprv-empty">Загрузка…</div>
  } else if (error) {
    body = <div className="kprv-error">Ошибка: {error}</div>
  } else if (groups.length === 0) {
    body = (
      <div className="kprv-empty">
        {depts.size > 0 && tabRows.length > 0 ? 'Нет КП по выбранным направлениям.' : (EMPTY_TEXT[tab] || 'Нет записей.')}
      </div>
    )
  } else {
    const rowEls = []
    for (const g of groups) {
      rowEls.push(renderGroupRow(g))
      if (collapsed.has(g.key)) continue
      g.rows.forEach((r, i) => rowEls.push(renderKpRow(r, i === g.rows.length - 1)))
    }
    body = (
      <div className="kprv-table-wrap" ref={tableWrapRef}>
        <table className={`kprv-table${hasActions ? '' : ' no-actions'}`}>
          {/* table-layout: fixed — ширины из <colgroup>, а не из содержимого.
              Фиксированные колонки — в rem по замеру, «Контрагент» — доля
              ширины, остаток — «Проверке» (KpReviewPage.css). */}
          <colgroup>
            <col className="kprv-c-num" />
            <col className="kprv-c-cp" />
            <col className="kprv-c-file" />
            <col className="kprv-c-date" />
            <col />{/* Проверка */}
            <col className="kprv-c-sum" />
            <col className="kprv-c-sent" />
            {hasActions && <col className="kprv-c-actions" />}
          </colgroup>
          <thead>
            <tr>
              <SortTh label="№" sortKey="tender_no" sort={sort} onSort={toggleSort} className="kprv-th-num" title="Сортировать по номеру тендера" />
              <th>Контрагент</th>
              <th>КП</th>
              <SortTh label="Загружен" sortKey="created_at" sort={sort} onSort={toggleSort} title="Сортировать по дате загрузки КП" />
              <SortTh label="Проверка" sortKey="reviewed_at" sort={sort} onSort={toggleSort} title="Сортировать по дате проверки" />
              <th title="КП занесено в сводную таблицу">В сводной</th>
              <th title="Замечания отправлены подрядчику">Подрядчику</th>
              {hasActions && <th>Действия</th>}
            </tr>
          </thead>
          {/* Очередь КП загружается целиком (fetchAllRows), и на тысяче строк
              обычный <tbody> заметно тормозит. Виртуализуем только когда строк
              действительно много. */}
          {rowEls.length > VIRTUALIZE_FROM
            ? <VirtualTableBody rows={rowEls} colSpan={colCount} scrollRef={tableWrapRef} rowHeight={40} />
            : <tbody>{rowEls}</tbody>}
        </table>
      </div>
    )
  }

  return (
    <div className="kprv-page ui-work">
      <div className="kprv-head">
        <h2 className="kprv-title">
          <IconTile tone="teal"><IconShieldCheck size={16} /></IconTile>
          Проверка КП
          <span className="kprv-info" role="img" aria-label={HINT} title={HINT}><IconInfo /></span>
        </h2>
        <label className="kprv-search">
          <IconSearch size={15} />
          <input
            type="search"
            placeholder="Контрагент, тендер, объект, ФИО"
            aria-label="Поиск по контрагенту, номеру и описанию тендера, объекту, имени файла КП и ответственным"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="kprv-depts" role="group" aria-label="Направление тендера">
          {DEPT_FILTER_KEYS.map(key => (
            <DeptFilter
              key={key}
              deptKey={key}
              checked={depts.has(key)}
              count={deptCounts[key] ?? 0}
              onToggle={toggleDept}
            />
          ))}
        </div>
        {!loading && !error && (
          <span className="kprv-shown" aria-live="polite">
            <b>{shownCount}</b> КП · <b>{groups.length}</b> {plural(groups.length, 'тендер', 'тендера', 'тендеров')}
          </span>
        )}
      </div>

      {/* Этапы проверки — они же навигация: каждая вкладка это очередь работы
          со своим счётчиком. Над этапами ветки — её подпись (вердикт аналитика и
          подветка), внутри ветки этапы идут по порядку маршрута. */}
      <div className="kprv-stages" role="tablist" aria-label="Этапы проверки КП">
        {STAGE_GROUPS.map(g => (
          <div key={g.title} className={`kprv-stage-grp${g.tone ? ` is-${g.tone}` : ''}`}>
            <span className="kprv-stage-cap" aria-hidden>{g.caption || ''}</span>
            <div className="kprv-stage-row">
              {g.keys.map((key, i) => (
                <Fragment key={key}>
                  {i > 0 && <span className="kprv-stage-step" aria-hidden><IconChevron size={11} /></span>}
                  <StageTab tabKey={key} tab={tab} counts={counts} onSelect={setTab} />
                </Fragment>
              ))}
            </div>
          </div>
        ))}
        <div className="kprv-stage-grp is-all">
          <span className="kprv-stage-cap" aria-hidden />
          <div className="kprv-stage-row">
            <StageTab tabKey="all" tab={tab} counts={counts} onSelect={setTab} />
          </div>
        </div>
      </div>

      {body}

      {reviewFile && (
        <KpReviewModal
          file={reviewFile}
          onClose={() => setReviewFile(null)}
          onSaved={() => load({ silent: true })}
        />
      )}
      {previewDoc && (
        <S3DocumentPreview doc={previewDoc} onClose={() => setPreviewDoc(null)} />
      )}
    </div>
  )
}

export default KpReviewPage
