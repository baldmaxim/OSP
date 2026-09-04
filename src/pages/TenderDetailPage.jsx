import { useState, useEffect, useMemo, useRef, memo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { supabase } from '../supabase'
import { getColumnPreviews } from '../utils/parseProposalExcel'
import { normName, supplyKey } from '../utils/supplyRateHelpers'
import { reorderSiblings } from '../utils/appendixTree'
import { tenderObjectName } from '../utils/tenderDepartments'
import { sanitizeUserText, sanitizeDeep } from '../utils/text'
import { describeSupabaseError, isAuthError, SESSION_EXPIRED_MESSAGE } from '../utils/supabaseError'
import { useRole } from '../contexts/RoleContext'
import TenderCounterpartyFiles from '../components/TenderCounterpartyFiles'
import TenderProposalsCompare from '../components/TenderProposalsCompare'
import VorDocsModal from '../components/VorDocsModal'
import VirtualTableBody from '../components/VirtualTableBody'
import PaperclipIcon from '../components/icons/PaperclipIcon'
import AccessDenied from '../components/AccessDenied'
import FilterDropdown from '../components/FilterDropdown'
import TenderDocumentsTab from '../components/TenderDocumentsTab'
import TenderFinalDocBlock from '../components/TenderFinalDocBlock'
import '../components/TenderDetail.css'

// task 410: с какого числа видимых строк включаем виртуализацию <tbody>.
// Ниже порога — обычный рендер (поведение 1:1 как раньше, нулевой риск для мелких ВОР).
const VIRTUALIZE_FROM = 150

// Подписи статусов участника тендера — для истории и отчёта «Работа инженеров»
// (в выпадающем списке те же значения).
const PARTICIPANT_STATUS_LABEL = {
  request_sent: 'Запрос отправлен',
  accepted_for_work: 'Принято в работу',
  proposal_provided: 'КП предоставлено',
  declined: 'Отказ',
}

// task 261: числа выводим с округлением до сотых
const fmtNum = (v) => (v === null || v === undefined || v === '')
  ? '—'
  : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(v)

// task 398: суммы стоимости материалов от снабжения — «1 234,50 ₽», пусто → «—»
const MONEY_FMT = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtMoney = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)))
  ? '—'
  : MONEY_FMT.format(Number(v)) + ' ₽'

// Момент загрузки КП на сайт — «дд.мм.гггг, чч:мм».
const formatKpUploadedAt = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ru-RU') + ', ' +
    d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

// task 406/407/408: normName и supplyKey вынесены в ../utils/supplyRateHelpers
// (переиспользуются в TenderProposalsCompare для колонки «Цена от снабжения»).

// task 405: выбор листа/столбцов при импорте расценок снабжения
const SUPPLY_COLUMN_COUNT = 26
const SUPPLY_COLUMN_FIELDS = [
  { key: 'name',  label: 'Наименование', default: 0, required: true },
  { key: 'unit',  label: 'Ед. изм.',     default: 1, required: false },
  { key: 'price', label: 'Цена',         default: 2, required: true },
]
const SUPPLY_COLUMN_DEFAULTS = Object.fromEntries(SUPPLY_COLUMN_FIELDS.map(f => [f.key, f.default]))
const SUPPLY_COLS_LS_KEY = 'supply-rates-cols'

// Загрузка сохранённого маппинга столбцов с фолбэком на дефолты (паттерн из TenderProposalUploadModal).
const loadSupplyColumnMap = () => {
  try {
    const raw = localStorage.getItem(SUPPLY_COLS_LS_KEY)
    if (!raw) return { ...SUPPLY_COLUMN_DEFAULTS }
    const parsed = JSON.parse(raw)
    const out = { ...SUPPLY_COLUMN_DEFAULTS }
    for (const k of Object.keys(SUPPLY_COLUMN_DEFAULTS)) {
      const v = parsed[k]
      if (v === null) out[k] = null
      else if (Number.isInteger(v) && v >= 0 && v < SUPPLY_COLUMN_COUNT) out[k] = v
    }
    return out
  } catch {
    return { ...SUPPLY_COLUMN_DEFAULTS }
  }
}

// task 260: КОД «Р»/«Р-» → работы, «мат.»/иное → материалы (как в Анализ КП/БСМ)
const isWorkItem = (it) => {
  const c = (it.code || '').trim().toUpperCase()
  return c.startsWith('Р')
}

const sectionKey = (it, idx) => (it.id != null ? `id:${it.id}` : `idx:${idx}`)

// task 349 + 350: «Объединённый ВОР» в исходном виде — конкатенация документов
// друг за другом со специальными разделителями-заголовками между ними.
// Каждый разделитель сворачивается + позволяет перейти к отдельной вкладке доку.
// AggregateTable (Материалы/Работы) разделители игнорирует (_isDocDivider).
function concatCombinedEstimate(items) {
  if (!items || items.length === 0) return items
  const groups = new Map()
  for (const it of items) {
    const name = it.estimate_name || 'Основная смета'
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(it)
  }
  const sortedNames = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'ru'))
  const out = []
  for (const name of sortedNames) {
    out.push({
      _isDocDivider: true,
      _docName: name,
      _docCount: groups.get(name).length,
      id: `__doc-divider:${name}`,
      cost_name: name,
      is_section: false,
      outline_level: 0,
    })
    for (const it of groups.get(name)) out.push(it)
  }
  return out
}
const docDividerKey = (name) => `__doc:${name}`

// task 345 + 346: сопоставление столбцов Excel — как в «Анализ ВОР/КП».
// Объёмы только раздельные: workVolume + materialVolume. Общий объём не нужен.
const VOR_COLUMN_FIELDS = [
  { key: 'num',            label: '№ п/п',              default: 0 },
  { key: 'code',           label: 'КОД (мат./Р)',       default: 1 },
  { key: 'name',           label: 'Наименование',       default: 2 },
  { key: 'unit',           label: 'Ед. изм.',           default: 3 },
  { key: 'workVolume',     label: 'Объём работ',        default: 4 },
  { key: 'materialVolume', label: 'Объём материалов',   default: 5 },
  { key: 'note',           label: 'Примечание',         default: null },
]
const VOR_DEFAULT_COLUMN_MAP = Object.fromEntries(VOR_COLUMN_FIELDS.map(f => [f.key, f.default]))
const VOR_COLUMN_CHOICES_COUNT = 26
const VOR_COLUMN_MAP_STORAGE_KEY = 'tender-vor-column-map'

// Глубина иерархической нумерации: «1» → 1, «1.2» → 2, «1.2.3» → 3.
// Берём ведущий числовой токен (поддержка . - ) как разделителей).
function numberDepth(s) {
  if (s == null) return 0
  const m = String(s).trim().match(/^[№\s.]*(\d+(?:[.\-)]\d+)*)/)
  if (!m) return 0
  return m[1].split(/[.\-)]/).filter(Boolean).length
}

// task 262/265: эффективный уровень строки.
// 1) если есть outline_level из Excel — берём его;
// 2) иначе уровень мог быть посчитан при импорте и сохранён в cost_type
//    (чтобы группировка работала БЕЗ доп. миграции);
// 3) иначе эвристика (раздел=0, позиция=1).
function rowLevel(it) {
  if (Number.isFinite(it.outline_level) && it.outline_level > 0) return it.outline_level
  const ct = parseInt(it.cost_type, 10)
  if (Number.isFinite(ct)) return ct
  return it.is_section ? 0 : 1
}

function makeLevelOf(items) {
  const maxLvl = items.reduce((m, x) => Math.max(m, rowLevel(x)), 0)
  if (maxLvl > 0) return rowLevel
  return (it) => (it.is_section ? 0 : 1)
}

// Ключи всех «свёртываемых» строк-заголовков (у кого есть вложенные строки глубже)
function getHeaderKeys(items) {
  const lvlOf = makeLevelOf(items)
  const keys = []
  for (let i = 0; i < items.length; i++) {
    const next = items[i + 1]
    if (next && lvlOf(next) > lvlOf(items[i])) keys.push(sectionKey(items[i], i))
  }
  return keys
}

// task 398: стоимость материалов от снабжения по строкам + подытоги.
// Для каждой строки-материала: material_consumption × supply_price (расценка
// сопоставляется по наименованию в пределах ВОР-документа). Подытоги всплывают
// к родительским разделам, к документам (для Объединённого ВОР) и в общий итог.
// Один проход с тем же стеком уровней, что у EstimateTable — индексы leaf и
// ключи sectionTotals совпадают с разметкой таблицы.
function computeSupplyCosts(items, ratesMap) {
  // task 409: leaf — «Итого от снабжения» (объём×цена); unitPrice — «Цена за ед.» (raw supply_price).
  const empty = { leaf: [], unitPrice: [], sectionTotals: new Map(), docTotals: new Map(), grand: 0 }
  if (!items || items.length === 0 || !ratesMap) return empty
  const lvlOf = makeLevelOf(items)
  const leaf = new Array(items.length).fill(null)
  const unitPrice = new Array(items.length).fill(null)
  const sectionTotals = new Map()
  const docTotals = new Map()
  let grand = 0
  const stack = [] // открытые разделы: { key, level, total }
  let curDoc = null
  // Закрыть разделы с уровнем >= toLevel, всплывая сумму к родителю.
  const flush = (toLevel) => {
    while (stack.length && stack[stack.length - 1].level >= toLevel) {
      const s = stack.pop()
      sectionTotals.set(s.key, (sectionTotals.get(s.key) || 0) + s.total)
      if (stack.length) stack[stack.length - 1].total += s.total
    }
  }
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx]
    if (it._isDocDivider) {
      flush(0)
      stack.length = 0
      curDoc = it._docName
      if (!docTotals.has(curDoc)) docTotals.set(curDoc, 0)
      continue
    }
    const L = lvlOf(it)
    const next = items[idx + 1]
    const isHeader = !!next && !next._isDocDivider && lvlOf(next) > L
    const isSectionLike = it.is_section || isHeader
    if (isSectionLike) {
      flush(L)
      stack.push({ key: sectionKey(it, idx), level: L, total: 0 })
      continue
    }
    flush(L)
    if (isWorkItem(it)) continue // в колонку снабжения попадают только материалы
    const dk = it.estimate_name || curDoc || 'Основная смета'
    const price = ratesMap.get(supplyKey(dk, it.cost_name))
    if (price == null) continue // нет цены снабжения → нерасценено (обе ячейки пустые + жёлтый)
    unitPrice[idx] = Number(price)
    // task 409: цена за единицу есть, но если объём некорректен/<=0 — итог НЕ считаем
    // (показываем прочерк), цену оставляем. Подсветки «нерасценено» при этом нет.
    const vol = Number(it.material_consumption)
    if (!Number.isFinite(vol) || vol <= 0) continue
    const cost = vol * Number(price)
    leaf[idx] = cost
    grand += cost
    if (stack.length) stack[stack.length - 1].total += cost
    docTotals.set(dk, (docTotals.get(dk) || 0) + cost)
  }
  flush(0)
  return { leaf, unitPrice, sectionTotals, docTotals, grand }
}

// task 398: вкладка снабжения показывает только материалы. После удаления строк-работ
// итеративно убираем разделы/подразделы, под которыми не осталось ни одного материала
// (пустой раздел = следующий за ним элемент это разделитель документа, конец списка
// или строка того же/более высокого уровня).
function pruneEmptySections(items) {
  if (!items || items.length === 0) return items
  const lvlOf = makeLevelOf(items)
  let arr = items
  let changed = true
  while (changed) {
    changed = false
    const out = []
    for (let i = 0; i < arr.length; i++) {
      const it = arr[i]
      if (it.is_section) {
        const next = arr[i + 1]
        const empty = !next || next._isDocDivider || lvlOf(next) <= lvlOf(it)
        if (empty) { changed = true; continue }
      }
      out.push(it)
    }
    arr = out
  }
  return arr
}

// task 260/262: смета с многоуровневой группировкой/сворачиванием (как в Excel)
// task 348/351: дерево документов ВОР — «Объединённый» + дочерние ВОРы.
// Переиспользуется во вкладках «ВОР» и «Расценки снабжения».
function DocTabsTree({ docNames, estimateItems, selected, onSelect }) {
  if (!docNames || docNames.length === 0) return null
  return (
    <div className="estimate-doc-tabs" role="tablist" aria-label="Документы ВОР">
      <button
        type="button"
        role="tab"
        aria-selected={selected === 'all'}
        className={`estimate-doc-tab estimate-doc-tab-parent ${selected === 'all' ? 'active' : ''}`}
        onClick={() => onSelect('all')}
        title="Объединённый ВОР — все документы вместе"
      >
        <span className="estimate-doc-tab-parent-icon" aria-hidden>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7h18" />
            <path d="M3 12h18" />
            <path d="M3 17h18" />
          </svg>
        </span>
        <span className="estimate-doc-tab-label">Объединённый ВОР</span>
        <span className="estimate-doc-tab-count">{estimateItems.length}</span>
        <span className="estimate-doc-tab-parent-hint">
          состоит из {docNames.length}{' '}
          {docNames.length === 1 ? 'документа' : 'документов'}
        </span>
      </button>
      <div className="estimate-doc-tabs-children">
        {docNames.map((name, i) => {
          const count = estimateItems.filter(it =>
            (it.estimate_name || 'Основная смета') === name
          ).length
          const isLast = i === docNames.length - 1
          return (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={selected === name}
              className={`estimate-doc-tab estimate-doc-tab-child ${selected === name ? 'active' : ''} ${isLast ? 'is-last' : ''}`}
              onClick={() => onSelect(name)}
              title={`Открыть ВОР «${name}»`}
            >
              <span className="estimate-doc-tab-branch" aria-hidden />
              <span className="estimate-doc-tab-label">{name}</span>
              <span className="estimate-doc-tab-count">{count}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

const EstimateTable = memo(function EstimateTable({ items, collapsedSections, onToggleSection, onSwitchToDoc, supplyCosts, showSupply = false, hideWorkVolume = false }) {
  const scrollRef = useRef(null)
  const sc = supplyCosts || { leaf: [], unitPrice: [], sectionTotals: new Map(), docTotals: new Map(), grand: 0 }
  // colSpan «средних» колонок (КОД…Объём материалов) для строк-разделов/разделителей.
  const midSpan = hideWorkVolume ? 4 : 5
  const lvlOf = makeLevelOf(items)
  const collapseStack = [] // активные свёрнутые заголовки: их уровни
  const rendered = []
  // task 347: иерархическая нумерация — работы 1, 2, 3…; материалы под ними
  // 1.1, 1.2, 1.3… Разделы/подразделы не считаются. Счётчики инкрементятся
  // в порядке обхода (для всех элементов, видимых или скрытых под свёрнутой
  // секцией) — чтобы нумерация была стабильна при сворачивании.
  let workCount = 0
  let matCount = 0
  // task 350: видимость разделителя документа (если он свёрнут — все items
  // ВОРа до следующего разделителя пропускаются при рендере).
  let docHidden = false
  let docHiddenKey = null
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx]

    // task 350: разделитель документа — особая строка, не участвует в section-логике.
    if (it._isDocDivider) {
      // Сброс счётчиков для каждого документа — в исходном виде нумерация
      // должна начинаться с 1 в каждом ВОРе.
      workCount = 0
      matCount = 0
      const dkey = docDividerKey(it._docName)
      docHidden = collapsedSections.has(dkey)
      docHiddenKey = it._docName
      rendered.push(
        <tr key={`doc:${it._docName}`} className={`estimate-doc-divider-row${docHidden ? ' is-collapsed' : ''}`}>
          <td className="estimate-num">
            <button
              type="button"
              className="estimate-group-toggle estimate-doc-toggle"
              onClick={() => onToggleSection(dkey)}
              title={docHidden ? 'Развернуть документ' : 'Свернуть документ'}
              aria-expanded={!docHidden}
            >
              {docHidden ? '▶' : '▼'}
            </button>
          </td>
          <td colSpan={midSpan}>
            <div className="estimate-doc-divider-content">
              <span className="estimate-doc-divider-eyebrow">ВОР</span>
              <span className="estimate-doc-divider-name">{it._docName}</span>
              <span className="estimate-doc-divider-count">{it._docCount} позиций</span>
              {onSwitchToDoc && (
                <button
                  type="button"
                  className="estimate-doc-divider-link"
                  onClick={() => onSwitchToDoc(it._docName)}
                  title={`Открыть «${it._docName}» отдельно`}
                >Открыть отдельно →</button>
              )}
            </div>
          </td>
          {showSupply && (
            <>
              <td className="estimate-num-cell estimate-supply-total" />
              <td className="estimate-num-cell estimate-supply-total">
                {sc.docTotals.get(it._docName) > 0 ? fmtMoney(sc.docTotals.get(it._docName)) : ''}
              </td>
            </>
          )}
        </tr>
      )
      // Любые активные section-collapse сбрасываем на границе документа.
      collapseStack.length = 0
      continue
    }

    // Если активный документ свёрнут — пропускаем его items.
    if (docHidden) continue

    const L = lvlOf(it)
    while (collapseStack.length && L <= collapseStack[collapseStack.length - 1]) collapseStack.pop()
    const hidden = collapseStack.length > 0
    const next = items[idx + 1]
    // Игнорируем доку-разделитель при поиске следующего «уровня».
    const isHeader = !!next && !next._isDocDivider && lvlOf(next) > L
    const key = sectionKey(it, idx)
    const collapsed = collapsedSections.has(key)
    // task 428: «пустая» строка ВОР (без наименования) — всегда обычная строка,
    // никогда не секция/заголовок (иначе следующий более глубокий item сделал бы её
    // сворачиваемым заголовком с пустым названием).
    const isEmptyItem = !it.is_section && !String(it.cost_name || '').trim()
    const isSectionLike = !isEmptyItem && (it.is_section || isHeader)

    // Считаем номер заранее — даже для скрытых, чтобы порядок не «прыгал».
    let displayNum = ''
    if (!isSectionLike) {
      if (isWorkItem(it)) {
        workCount++
        matCount = 0
        displayNum = String(workCount)
      } else {
        matCount++
        displayNum = workCount > 0 ? `${workCount}.${matCount}` : String(matCount)
      }
    }

    if (!hidden) {
      const indent = { paddingLeft: `${0.625 + L * 1.1}rem` }
      if (isSectionLike) {
        rendered.push(
          <tr key={it.id || idx} className="estimate-section-row">
            <td className="estimate-num">
              {isHeader && (
                <button
                  type="button"
                  className="estimate-group-toggle"
                  onClick={() => onToggleSection(key)}
                  title={collapsed ? 'Развернуть' : 'Свернуть'}
                  aria-expanded={!collapsed}
                >
                  {collapsed ? '+' : '−'}
                </button>
              )}
            </td>
            <td colSpan={midSpan} style={indent}>{it.cost_name}</td>
            {showSupply && (
              <>
                <td className="estimate-num-cell estimate-supply-total" />
                <td className="estimate-num-cell estimate-supply-total">
                  {sc.sectionTotals.get(key) > 0 ? fmtMoney(sc.sectionTotals.get(key)) : ''}
                </td>
              </>
            )}
          </tr>
        )
      } else {
        // task 408/409: материал без ЦЕНЫ ЗА ЕД. от снабжения = нерасценён → жёлтая подсветка.
        // Опираемся на unitPrice (а не на итог): итог может быть null из-за отсутствия
        // объёма ВОР, хотя цена снабжения есть — это не «нерасценено».
        const supplyMissing = showSupply && !isWorkItem(it) && sc.unitPrice[idx] == null
        // task 428: строка без наименования — сохранённая «пустая» строка ВОР.
        const isEmptyRow = isEmptyItem
        const rowClass = isEmptyRow ? 'estimate-empty-row' : (supplyMissing ? 'supply-row-missing' : undefined)
        rendered.push(
          <tr key={it.id || idx} className={rowClass}>
            <td className="estimate-num">{displayNum}</td>
            <td>{it.code || '—'}</td>
            <td style={indent}>
              {isEmptyRow ? <span className="estimate-empty-label">(пустая строка)</span> : it.cost_name}
            </td>
            <td>{it.unit || '—'}</td>
            {!hideWorkVolume && <td className="estimate-num-cell">{fmtNum(it.work_volume)}</td>}
            <td className="estimate-num-cell">{fmtNum(it.material_consumption)}</td>
            {showSupply && (
              <>
                <td className={`estimate-num-cell estimate-supply-cell${supplyMissing && !isEmptyRow ? ' supply-price-missing' : ''}`}>
                  {fmtMoney(sc.unitPrice[idx])}
                </td>
                <td className={`estimate-num-cell estimate-supply-cell estimate-supply-total-cell${supplyMissing && !isEmptyRow ? ' supply-price-missing' : ''}`}>
                  {fmtMoney(sc.leaf[idx])}
                </td>
              </>
            )}
          </tr>
        )
      }
    }
    if (isHeader && collapsed && !hidden) collapseStack.push(L)
  }
  // suppress unused warning
  void docHiddenKey
  // task 410: при большом числе видимых строк виртуализируем <tbody> (в DOM — окно,
  // а не тысячи <tr>). Логика построения строк выше не меняется — окном управляет
  // только VirtualTableBody. Число колонок нужно для colSpan строк-спейсеров.
  const totalCols = 5 + (hideWorkVolume ? 0 : 1) + (showSupply ? 2 : 0)
  const virtualize = rendered.length > VIRTUALIZE_FROM
  return (
    <div ref={scrollRef} className={`table-container${virtualize ? ' table-virtual' : ''}`}>
      <table className="data-table estimate-table">
        <thead>
          <tr>
            <th style={{ width: '64px' }}>№</th>
            <th style={{ width: '110px' }}>КОД</th>
            <th>Наименование затрат</th>
            <th style={{ width: '90px' }}>Ед. изм.</th>
            {!hideWorkVolume && <th style={{ width: '130px' }}>Объём работ</th>}
            <th style={{ width: '130px' }}>Объём материалов</th>
            {showSupply && <th style={{ width: '150px' }}>Цена за ед. от снабжения</th>}
            {showSupply && <th style={{ width: '150px' }}>Итого от снабжения</th>}
          </tr>
        </thead>
        {virtualize
          ? <VirtualTableBody rows={rendered} colSpan={totalCols} scrollRef={scrollRef} rowHeight={48} />
          : <tbody>{rendered}</tbody>}
        {showSupply && sc.grand > 0 && (
          <tfoot>
            <tr className="estimate-total-row">
              <td colSpan={hideWorkVolume ? 5 : 6}>Итого от снабжения</td>
              <td className="estimate-num-cell estimate-supply-total" />
              <td className="estimate-num-cell estimate-supply-total">{fmtMoney(sc.grand)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
})

// task 260: подвкладки «Материалы»/«Работы» — суммирование объёмов по наименованию
// task 398: для «Материалы» добавляем колонку стоимости от снабжения (Σ объём×цена).
function AggregateTable({ items, type, ratesMap }) {
  const withSupply = type === 'materials' && !!ratesMap
  const map = new Map()
  for (const it of items) {
    if (it.is_section) continue
    if (it._isDocDivider) continue // task 350: разделители документов в агрегации не участвуют
    const work = isWorkItem(it)
    if (type === 'works' && !work) continue
    if (type === 'materials' && work) continue
    const name = (it.cost_name || '').trim()
    if (!name) continue
    const unit = (it.unit || '').trim()
    const key = `${name.toLowerCase()}∣${unit.toLowerCase()}`
    const vol = type === 'works' ? it.work_volume : it.material_consumption
    const cur = map.get(key) || { name, unit, total: 0, count: 0, supplyCost: 0 }
    cur.total += Number(vol) || 0
    cur.count += 1
    if (withSupply) {
      const price = ratesMap.get(supplyKey(it.estimate_name, name))
      if (price != null) cur.supplyCost += (Number(it.material_consumption) || 0) * Number(price)
    }
    map.set(key, cur)
  }
  const rows = [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  const grandTotal = rows.reduce((s, r) => s + r.total, 0)
  const grandCount = rows.reduce((s, r) => s + r.count, 0)
  const grandSupply = rows.reduce((s, r) => s + (r.supplyCost || 0), 0)
  if (rows.length === 0) {
    return (
      <div className="empty-state">
        <p>{type === 'works' ? 'Позиций по работам не найдено' : 'Позиций по материалам не найдено'}</p>
        <p className="hint">Тип определяется столбцом КОД: «Р»/«Р-» — работы, остальное — материалы.</p>
      </div>
    )
  }
  return (
    <div className="table-container">
      <table className="data-table estimate-table">
        <thead>
          <tr>
            <th style={{ width: '52px' }}>№</th>
            <th>Наименование</th>
            <th style={{ width: '90px' }}>Ед. изм.</th>
            <th style={{ width: '90px' }}>Позиций</th>
            <th style={{ width: '150px' }}>Суммарный объём</th>
            {withSupply && <th style={{ width: '180px' }}>Стоимость от снабжения</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.name + '∣' + r.unit}>
              <td className="estimate-num">{i + 1}</td>
              <td>{r.name}</td>
              <td>{r.unit || '—'}</td>
              <td className="estimate-num">{r.count}</td>
              <td className="estimate-num-cell">{fmtNum(r.total)}</td>
              {withSupply && (
                <td className="estimate-num-cell estimate-supply-cell">
                  {r.supplyCost > 0 ? fmtMoney(r.supplyCost) : '—'}
                </td>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="estimate-total-row">
            <td colSpan={3}>Итого{type === 'works' ? ' по работам' : ' по материалам'}</td>
            <td className="estimate-num">{grandCount}</td>
            <td className="estimate-num-cell">{fmtNum(grandTotal)}</td>
            {withSupply && <td className="estimate-num-cell estimate-supply-total">{fmtMoney(grandSupply)}</td>}
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function TenderDetailPage() {
  const { tenderId } = useParams()
  const navigate = useNavigate()
  const { userProfile, canEdit, scopedObjectIds } = useRole()
  // Руководитель строительства (привязан к объекту) не видит внутренние примечания.
  const hideNotes = scopedObjectIds.length > 0
  // task 333: гейт add/edit/delete для раздела «tenders»
  const canEditTenders = canEdit('tenders')

  const [tender, setTender] = useState(null)
  const [tenderCounterparties, setTenderCounterparties] = useState([])
  // Когда КП контрагента фактически попало на сайт: counterparty_id → ISO-дата.
  // Источник — загруженный файл КП, а если файла нет (кабинет подрядчика) — строки расценок.
  const [kpUploadedAt, setKpUploadedAt] = useState({})
  // task 427: DnD-перестановка участников
  const [draggedTc, setDraggedTc] = useState(null) // { id }
  const [tcDragOver, setTcDragOver] = useState(null) // { id, position }
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('estimate') // 'estimate' | 'supply' | 'proposals' | 'participants' | 'documents' | 'history'
  // Версия документов тендера: любое изменение (во вкладке «Документы» или в блоке
  // «Итоговый документ» победителя) поднимает счётчик и синхронизирует оба места.
  const [tenderDocsVersion, setTenderDocsVersion] = useState(0)
  const bumpTenderDocs = () => setTenderDocsVersion((v) => v + 1)
  // task 346: число контрагентов с загруженными КП — обновляет дочерний компонент.
  const [proposalsCount, setProposalsCount] = useState(0)

  // task 259: смета тендера (импорт из Excel → проверка → сохранение)
  const [estimateItems, setEstimateItems] = useState([])
  const estimateFileRef = useRef(null)
  const [pendingWorkbook, setPendingWorkbook] = useState(null)
  const [estSheetNames, setEstSheetNames] = useState([])
  const [estSelectedSheet, setEstSelectedSheet] = useState('')
  const [estStartRow, setEstStartRow] = useState('2')
  const [estEndRow, setEstEndRow] = useState('')
  // true, если «По строку» подставлено автоматически по строке «Итого».
  const [estEndAuto, setEstEndAuto] = useState(false)
  // task 348: название текущего загружаемого ВОРа (например, «Электрика», «ОВ»)
  // и название выбранного для просмотра (или 'all' для объединённого ВОРа).
  const [estDocName, setEstDocName] = useState('')
  const [selectedDocName, setSelectedDocName] = useState('all')
  const [showEstimateModal, setShowEstimateModal] = useState(false)
  const [parsedEstimate, setParsedEstimate] = useState(null) // предпросмотр до сохранения
  const [estimateSaving, setEstimateSaving] = useState(false)
  const [estimateSubTab, setEstimateSubTab] = useState('source') // 'source' | 'materials' | 'works'
  const [collapsedSections, setCollapsedSections] = useState(new Set())
  // task 345: сопоставление столбцов Excel — persist в localStorage между сессиями.
  const [estColumnMap, setEstColumnMap] = useState(() => {
    try {
      const saved = localStorage.getItem(VOR_COLUMN_MAP_STORAGE_KEY)
      if (!saved) return { ...VOR_DEFAULT_COLUMN_MAP }
      const parsed = JSON.parse(saved)
      const result = { ...VOR_DEFAULT_COLUMN_MAP }
      for (const f of VOR_COLUMN_FIELDS) {
        const v = parsed?.[f.key]
        if (v === null) result[f.key] = null
        else if (Number.isInteger(v) && v >= 0 && v < VOR_COLUMN_CHOICES_COUNT) result[f.key] = v
      }
      return result
    } catch {
      return { ...VOR_DEFAULT_COLUMN_MAP }
    }
  })

  useEffect(() => {
    try { localStorage.setItem(VOR_COLUMN_MAP_STORAGE_KEY, JSON.stringify(estColumnMap)) }
    catch { /* localStorage недоступен — игнорируем */ }
  }, [estColumnMap])

  // task 398: расценки от снабжения по материалам ВОР (отдельная вкладка)
  const [supplyRates, setSupplyRates] = useState([])
  // task 410: лёгкие счётчики для бейджей вкладок (грузятся на открытии тендера
  // через count head — без выгрузки полного массива; сами массивы грузятся лениво).
  const [supplyRatesCount, setSupplyRatesCount] = useState(0)
  const [auditLogCount, setAuditLogCount] = useState(0)
  const supplyFileRef = useRef(null)
  const [supplyImportReport, setSupplyImportReport] = useState(null)
  const [supplyConflictDecisions, setSupplyConflictDecisions] = useState({})
  const [supplyImporting, setSupplyImporting] = useState(false)
  // task 405: конфиг-модалка выбора листа/столбцов перед парсингом
  // { workbook, sheetNames, sheetName, startRow, endRow, columnMap, fileName, docName }
  const [supplyConfig, setSupplyConfig] = useState(null)
  // выбранный документ + свёрнутые разделы для вкладки «Расценки снабжения»
  const [supplySelectedDoc, setSupplySelectedDoc] = useState('all')
  const [supplyCollapsed, setSupplyCollapsed] = useState(new Set())

  // Состояния для добавления участников
  const [showAddParticipantModal, setShowAddParticipantModal] = useState(false)
  const [availableCounterparties, setAvailableCounterparties] = useState([])
  const [selectedParticipants, setSelectedParticipants] = useState(new Set())
  const [loadingCounterparties, setLoadingCounterparties] = useState(false)
  const [participantSearchQuery, setParticipantSearchQuery] = useState('')
  const [participantWorkTypeFilter, setParticipantWorkTypeFilter] = useState('')

  // История изменений тендера
  const [auditLog, setAuditLog] = useState([])
  const [loadingAuditLog, setLoadingAuditLog] = useState(false)
  const [auditLogError, setAuditLogError] = useState(null)

  // Примечание тендера (inline-редактирование)
  const [notesDraft, setNotesDraft] = useState('')
  const [notesSaving, setNotesSaving] = useState(false)
  const [notesSavedAt, setNotesSavedAt] = useState(null)

  // task 396/397: документы тендера внутри карточки (S3, owner_type='tender')
  // категория 'vor' — «ВОРы и РД», 'tender_package' — «Тендерный пакет»
  const [vorDocsModalOpen, setVorDocsModalOpen] = useState(false)
  const [vorDocCount, setVorDocCount] = useState(0)
  const [packageDocsModalOpen, setPackageDocsModalOpen] = useState(false)
  const [packageDocCount, setPackageDocCount] = useState(0)

  const refreshDocCount = async (category, setCount) => {
    try {
      const { count, error } = await supabase
        .from('s3_documents')
        .select('id', { count: 'exact', head: true })
        .eq('owner_type', 'tender')
        .eq('owner_id', tenderId)
        .eq('doc_category', category)
      if (error) throw error
      setCount(count || 0)
    } catch (err) {
      console.error('Ошибка загрузки счётчика документов тендера:', err.message)
    }
  }
  const refreshVorDocCount = () => refreshDocCount('vor', setVorDocCount)
  const refreshPackageDocCount = () => refreshDocCount('tender_package', setPackageDocCount)

  // task 410: лёгкие счётчики для бейджей «Расценки снабжения» и «История».
  const refreshTabCounts = async () => {
    try {
      const [supply, audit] = await Promise.all([
        supabase.from('tender_vor_supply_rates').select('id', { count: 'exact', head: true }).eq('tender_id', tenderId),
        supabase.from('tender_audit_log').select('id', { count: 'exact', head: true }).eq('tender_id', tenderId),
      ])
      setSupplyRatesCount(supply.count || 0)
      setAuditLogCount(audit.count || 0)
    } catch (err) {
      console.error('Ошибка загрузки счётчиков вкладок:', err.message)
    }
  }

  // task 410: какие «тяжёлые» вкладки уже подгрузили — чтобы не грузить повторно
  // при переключении и не грузить всё сразу при открытии тендера.
  const loadedTabsRef = useRef(new Set())

  useEffect(() => {
    if (tenderId) {
      // На открытии — только то, что нужно для карточки и вкладки «ВОР» по умолчанию.
      // История и расценки снабжения грузятся лениво при первом открытии их вкладок.
      loadedTabsRef.current = new Set()
      fetchTenderData()
      fetchEstimateItems()
      refreshVorDocCount()
      refreshPackageDocCount()
      refreshTabCounts()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenderId])

  // task 410: ленивые загрузки по вкладкам (один раз на тендер).
  //  • «История» → loadAuditLog;
  //  • «Расценки снабжения» / «Сравнение КП» → fetchSupplyRates (нужны для колонок снабжения).
  useEffect(() => {
    if (!tenderId) return
    const loaded = loadedTabsRef.current
    if (activeTab === 'history' && !loaded.has('history')) {
      loaded.add('history')
      loadAuditLog()
    }
    if ((activeTab === 'supply' || activeTab === 'proposals') && !loaded.has('supply')) {
      loaded.add('supply')
      fetchSupplyRates()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, tenderId])

  // task 259: загрузка сохранённой сметы тендера
  // task 366: paginated fetch to avoid PostgREST 1000-row default limit
  const fetchEstimateItems = async () => {
    try {
      const PAGE = 1000
      let all = [], from = 0, done = false
      while (!done) {
        const { data, error } = await supabase
          .from('tender_estimate_items')
          .select('*')
          .eq('tender_id', tenderId)
          .order('row_number', { ascending: true })
          .range(from, from + PAGE - 1)
        if (error) throw error
        all = all.concat(data || [])
        if (!data || data.length < PAGE) done = true
        else from += PAGE
      }
      setEstimateItems(all)
    } catch (err) {
      console.error('Ошибка загрузки сметы:', err.message)
    }
  }

  // task 398: загрузка расценок снабжения тендера. Если миграция ещё не
  // применена — таблицы нет, тихо работаем без расценок (колонка покажет «—»).
  const fetchSupplyRates = async () => {
    try {
      // Постранично: PostgREST отдаёт максимум 1000 строк за запрос, а расценок у больших
      // ВОР (тысячи позиций) заметно больше — без пагинации загружалась только 1000,
      // из-за чего часть материалов оставалась без цены снабжения.
      // Тай-брейк по id — стабильный порядок между страницами.
      const PAGE = 1000
      const rows = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('tender_vor_supply_rates')
          .select('*')
          .eq('tender_id', tenderId)
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1)
        if (error) throw error
        if (data?.length) rows.push(...data)
        if (!data || data.length < PAGE) break
      }
      setSupplyRates(rows)
      return rows
    } catch (err) {
      console.error('Ошибка загрузки расценок снабжения:', err.message)
      setSupplyRates([])
      return []
    }
  }

  // Очистка числовых значений из Excel (валюта, пробелы, запятая → точка)
  const cleanNumericValue = (value) => {
    if (value === null || value === undefined || value === '') return null
    if (typeof value === 'number') return Math.round(value * 100) / 100
    let str = String(value)
    str = str.replace(/[₽$€¥£]/g, '')
    str = str.replace(/\s/g, '')
    str = str.replace(',', '.')
    str = str.replace(/[^\d.-]/g, '')
    const n = parseFloat(str)
    // task 261: округляем до сотых (2 знака после запятой)
    return isNaN(n) ? null : Math.round(n * 100) / 100
  }

  // Авто-граница таблицы ВОР: последняя строка, где в любом столбце значение начинается
  // со слова «Итого», считается итоговой. Таблица заканчивается ПЕРЕД ней (строку «Итого»
  // исключаем). Возвращает значение для поля «По строку» (совпадает с 0-based индексом
  // строки «Итого» — при парсинге это же число исключает её из диапазона) или '' если не найдено.
  const detectEstimateEndRow = (sheet) => {
    if (!sheet) return ''
    try {
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 })
      let lastItogo = -1
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        if (!row) continue
        if (row.some((cell) => /^итог/i.test(String(cell ?? '').trim()))) lastItogo = i
      }
      return lastItogo > 0 ? String(lastItogo) : ''
    } catch {
      return ''
    }
  }

  const handleEstimateFileSelect = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    try {
      const data = new Uint8Array(await file.arrayBuffer())
      const workbook = XLSX.read(data, { type: 'array' })
      const names = workbook.SheetNames || []
      setPendingWorkbook(workbook)
      setEstSheetNames(names)
      setEstSelectedSheet(names[0] || '')
      setEstStartRow('2')
      // task: авто-определение конца таблицы по строке «Итого» (можно поправить вручную).
      const autoEnd = detectEstimateEndRow(workbook.Sheets[names[0]])
      setEstEndRow(autoEnd)
      setEstEndAuto(!!autoEnd)
      // task 348: дефолт названия документа — имя файла без расширения.
      // Пользователь может переименовать перед сохранением.
      const baseName = file.name.replace(/\.[^.]+$/, '').trim() || 'ВОР'
      setEstDocName(baseName)
      setShowEstimateModal(true)
    } catch (error) {
      alert('Ошибка чтения файла: ' + error.message)
    }
    if (estimateFileRef.current) estimateFileRef.current.value = ''
  }

  // Распознаём строки в предпросмотр (БД ещё не трогаем — пользователь проверяет)
  const handleParseEstimate = () => {
    if (!pendingWorkbook) return
    try {
      const sheet = pendingWorkbook.Sheets[estSelectedSheet || pendingWorkbook.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 })
      // task 262: уровни группировки (структуры) Excel — ws['!rows'][i].level
      const rowMeta = sheet['!rows'] || []
      const levelAt = (i) => {
        const m = rowMeta[i]
        return (m && Number.isFinite(m.level)) ? m.level : 0
      }
      const start = Math.max(0, (parseInt(estStartRow) || 2) - 1)
      const end = estEndRow ? Math.min(rows.length, parseInt(estEndRow) || rows.length) : rows.length

      // task 345: используем пользовательский маппинг столбцов
      const c = estColumnMap
      const cell = (row, idx) => (idx != null && row[idx] != null) ? String(row[idx]).trim() : ''

      const items = []
      let rowNum = 1
      let runSecLvl = 0 // текущий уровень последнего встреченного раздела (для нумерации)
      // Определяет, выглядит ли строка как «голый номер» (1, 1.1, 2-3 и т.п.).
      // Если в столбце А только цифры/точки/тире — это номер позиции, не текст раздела.
      const looksLikeBareNumber = (s) => !s ? true : /^[\d.\-)\s]+$/.test(String(s))
      for (let i = start; i < end; i++) {
        const row = rows[i]
        if (!row || row.length === 0) continue
        // № п/п: пользователь может задать свой столбец (по умолчанию A=0).
        const numA = cell(row, c.num != null ? c.num : 0)
        const code = cell(row, c.code)
        let name = cell(row, c.name)
        const unit = cell(row, c.unit)
        const note = c.note != null ? cell(row, c.note) : ''

        const workVolume = c.workVolume != null ? cleanNumericValue(row[c.workVolume]) : null
        const materialConsumption = c.materialVolume != null ? cleanNumericValue(row[c.materialVolume]) : null

        // task 346: разделы/подразделы Excel часто пишутся текстом в столбце А
        // (с объединёнными ячейками: «Часть 10. Субподрядные работы», «Раздел 10.03Б…»,
        // «Подраздел 10.03Б.02…», «Заголовок…», «Подзаголовок…», «10.03Б.02.01.07.01.01.
        // Подготовительные работы»). Наименование (C) у них пустое — раньше такие
        // строки SKIPались. Теперь если в А есть нетривиальный текст и нет других
        // данных строки → это секция, переносим текст из А в name.
        const isSectionByA = !name && !code && !unit
          && workVolume == null && materialConsumption == null
          && numA && !looksLikeBareNumber(numA)
        if (isSectionByA) name = numA
        if (!name) {
          // task 428: строка без наименования (обычно пустая строка в блоке
          // материалов). Раньше отбрасывалась через continue — данные терялись.
          // Теперь сохраняем как есть (cost_name NOT NULL → ''), чтобы позиция не
          // пропала, и подсвечиваем на рендере (см. EstimateTable, estimate-empty-row).
          items.push({
            row_number: rowNum++,
            code: code || null,
            cost_name: '',
            unit: unit || null,
            calculation_note: note || null,
            work_volume: workVolume,
            material_consumption: materialConsumption,
            is_section: false,
            outline_level: runSecLvl + 1,
            cost_type: String(runSecLvl + 1),
            original_row_number: numA || String(i + 1),
          })
          continue
        }

        // Секция: либо детектирована по А, либо строка только с наименованием.
        const isSection = isSectionByA
          || (!code && !unit && workVolume == null && materialConsumption == null)

        // task 265 + 346: уровень = группировка Excel (приоритет), иначе по иерархической
        // нумерации столбца A (1 / 1.1 / 1.1.1), иначе эвристика раздел/позиция.
        // Для секций из А берём depth по ведущему числовому коду названия.
        const exLvl = levelAt(i)
        let lvl
        if (exLvl > 0) {
          lvl = exLvl
        } else if (isSection) {
          // Для секций детектированных по А — берём depth из самого названия
          // (там обычно «10.03Б.02.01.07.01.01. Подготовительные работы»).
          const source = isSectionByA ? name : numA
          const d = numberDepth(source)
          lvl = d > 0 ? d - 1 : runSecLvl
          runSecLvl = lvl
        } else {
          lvl = runSecLvl + 1
        }

        items.push({
          row_number: rowNum++,
          code: code || null,
          cost_name: name,
          unit: unit || null,
          calculation_note: note || null,
          work_volume: workVolume,
          material_consumption: materialConsumption,
          is_section: isSection,
          outline_level: lvl,
          // Дублируем уровень в cost_type — чтобы группировка сохранялась
          // даже без миграции outline_level (cost_type есть в базовой схеме).
          cost_type: String(lvl),
          original_row_number: numA || String(i + 1),
        })
      }
      if (items.length === 0) {
        alert('Не найдено позиций сметы. Проверьте лист и диапазон строк.')
        return
      }
      setParsedEstimate(items)
      setShowEstimateModal(false)
    } catch (error) {
      alert('Ошибка распознавания: ' + error.message)
    }
  }

  // Сохранение проверенной сметы в тендер.
  // task 348: каждый ВОР сохраняется со своим estimate_name → несколько
  // документов сосуществуют. Перезаписываем только items с этим же именем.
  // task 366: batched insert to handle 2000+ row estimates safely.
  const handleSaveEstimate = async () => {
    if (!parsedEstimate || parsedEstimate.length === 0) return
    const docName = (estDocName || '').trim() || 'Основная смета'
    setEstimateSaving(true)
    try {
      const { error: delErr } = await supabase
        .from('tender_estimate_items')
        .delete()
        .eq('tender_id', tenderId)
        .eq('estimate_name', docName)
      if (delErr) throw delErr
      const payload = parsedEstimate.map(it => ({
        ...it,
        tender_id: tenderId,
        estimate_name: docName,
      }))
      // task 366: chunk insert into 500-row batches
      const CHUNK = 500
      let insErr = null
      for (let i = 0; i < payload.length; i += CHUNK) {
        const chunk = payload.slice(i, i + CHUNK)
        let { error: chunkErr } = await supabase
          .from('tender_estimate_items')
          .insert(chunk)
        // Подстраховка: миграция outline_level ещё не применена — сохраняем без него
        if (chunkErr && /outline_level/i.test(chunkErr.message || '')) {
          const stripped = chunk.map(({ outline_level, ...rest }) => rest) // eslint-disable-line no-unused-vars
          const retry = await supabase.from('tender_estimate_items').insert(stripped)
          chunkErr = retry.error
        }
        // task 348: подстраховка для миграции original_row_number VARCHAR(20) → TEXT.
        // Если ещё не применена, обрезаем длинные значения до 20 символов и пробуем снова.
        if (chunkErr && /character varying\(20\)|value too long/i.test(chunkErr.message || '')) {
          const truncated = chunk.map(it => ({
            ...it,
            original_row_number: it.original_row_number
              ? String(it.original_row_number).slice(0, 20)
              : it.original_row_number,
          }))
          const retry = await supabase.from('tender_estimate_items').insert(truncated)
          chunkErr = retry.error
        }
        if (chunkErr) {
          insErr = chunkErr
          break
        }
      }
      if (insErr) throw insErr
      setParsedEstimate(null)
      setPendingWorkbook(null)
      await fetchEstimateItems()
      setSelectedDocName(docName) // показать только что сохранённый документ
      alert(`ВОР «${docName}» сохранён: ${payload.length} позиций`)
    } catch (error) {
      console.error('Ошибка сохранения ВОР:', error.message)
      alert('Ошибка сохранения ВОР: ' + error.message)
    } finally {
      setEstimateSaving(false)
    }
  }

  // task 348: удаляем либо выбранный документ, либо все ВОРы тендера.
  const handleClearEstimate = async () => {
    const isAll = selectedDocName === 'all'
    const msg = isAll
      ? 'Удалить ВСЕ ВОРы тендера? Это действие нельзя отменить.'
      : `Удалить ВОР «${selectedDocName}»? Остальные документы останутся.`
    if (!window.confirm(msg)) return
    try {
      let q = supabase.from('tender_estimate_items').delete().eq('tender_id', tenderId)
      if (!isAll) q = q.eq('estimate_name', selectedDocName)
      const { error } = await q
      if (error) throw error
      if (isAll) {
        setEstimateItems([])
      } else {
        setEstimateItems(prev => prev.filter(it => it.estimate_name !== selectedDocName))
        setSelectedDocName('all')
      }
    } catch (error) {
      alert('Ошибка удаления ВОР: ' + error.message)
    }
  }

  // task 398 + 405: загрузка расценок снабжения из Excel к выбранному ВОР-документу.
  // Шаг 1 — прочитать workbook и открыть конфиг-модалку (выбор листа/диапазона/столбцов).
  // Парсинг и сопоставление выполняет buildSupplyImportReport по выбору пользователя.
  const handleSupplyRatesFileSelect = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    if (supplySelectedDoc === 'all') {
      alert('Выберите конкретный раздел (ВОР-документ) слева, чтобы загрузить к нему стоимость материалов.')
      if (supplyFileRef.current) supplyFileRef.current.value = ''
      return
    }
    const docName = supplySelectedDoc
    try {
      const data = new Uint8Array(await file.arrayBuffer())
      const workbook = XLSX.read(data, { type: 'array' })
      const sheetNames = workbook.SheetNames
      const sheetName = sheetNames[0]
      // Авто-определение строки-заголовка для дефолтного значения «Со строки».
      const sheet = workbook.Sheets[sheetName]
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 })
      let headerIdx = -1
      for (let i = 0; i < Math.min(10, rows.length); i++) {
        const row = rows[i]
        if (row && row.some(c => c && typeof c === 'string' &&
          (c.toLowerCase().includes('наименование') || c.toLowerCase().includes('материал')))) {
          headerIdx = i
          break
        }
      }
      setSupplyConfig({
        workbook,
        sheetNames,
        sheetName,
        startRow: String(headerIdx >= 0 ? headerIdx + 2 : 1),
        endRow: '',
        columnMap: loadSupplyColumnMap(),
        fileName: file.name,
        docName,
      })
    } catch (err) {
      alert('Ошибка чтения файла: ' + err.message)
    } finally {
      if (supplyFileRef.current) supplyFileRef.current.value = ''
    }
  }

  // task 405: парсинг по выбранному листу/диапазону/столбцам → отчёт (новые/без изменений/конфликты).
  const buildSupplyImportReport = () => {
    if (!supplyConfig) return
    const { workbook, sheetName, startRow, endRow, columnMap, fileName, docName } = supplyConfig
    if (columnMap.name == null || columnMap.price == null) {
      alert('Укажите столбцы «Наименование» и «Цена».')
      return
    }
    try {
      const sheet = workbook.Sheets[sheetName]
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 })
      const from = Math.max(0, (parseInt(startRow, 10) || 1) - 1)
      const endParsed = parseInt(endRow, 10)
      const to = endParsed ? Math.min(rows.length, endParsed) : rows.length
      const existingMap = new Map()
      for (const r of supplyRates) {
        if ((r.estimate_name || 'Основная смета') === docName) {
          existingMap.set(normName(r.material_name), r) // task 406: тот же ключ, что при сопоставлении
        }
      }
      const seen = new Set()
      const newItems = [], sameItems = [], conflictItems = []
      for (let i = from; i < to; i++) {
        const row = rows[i]
        if (!row) continue
        const nameCell = row[columnMap.name]
        if (nameCell == null || nameCell === '') continue
        const materialName = String(nameCell).trim()
        const unit = (columnMap.unit != null && row[columnMap.unit] != null)
          ? String(row[columnMap.unit]).trim() : ''
        const price = cleanNumericValue(row[columnMap.price])
        if (!materialName || !price || price <= 0) continue
        const lk = normName(materialName) // task 406: согласовано с ключом сопоставления
        if (seen.has(lk)) continue // дубликат в файле — берём первое вхождение
        seen.add(lk)
        const rate = { material_name: materialName, unit, supply_price: price }
        const existing = existingMap.get(lk)
        if (!existing) {
          newItems.push(rate)
        } else {
          const existingPrice = Number(existing.supply_price) || 0
          if (Math.abs(existingPrice - price) < 0.01) {
            sameItems.push({ ...rate, existingId: existing.id })
          } else {
            conflictItems.push({
              ...rate,
              existingId: existing.id,
              existingPrice,
              newPrice: price,
              difference: price - existingPrice,
              percentDiff: existingPrice > 0 ? ((price - existingPrice) / existingPrice * 100) : 0,
            })
          }
        }
      }
      if (newItems.length + sameItems.length + conflictItems.length === 0) {
        alert('Не найдено расценок для импорта. Проверьте выбранный лист, диапазон строк и столбцы.')
        return
      }
      try { localStorage.setItem(SUPPLY_COLS_LS_KEY, JSON.stringify(columnMap)) } catch { /* localStorage недоступен — игнорируем */ }
      const decisions = {}
      conflictItems.forEach((_, idx) => { decisions[idx] = 'keep' })
      setSupplyImportReport({
        fileName,
        docName,
        totalParsed: newItems.length + sameItems.length + conflictItems.length,
        newItems, sameItems, conflictItems,
      })
      setSupplyConflictDecisions(decisions)
      setSupplyConfig(null)
    } catch (err) {
      alert('Ошибка распознавания: ' + err.message)
    }
  }

  const handleConfirmSupplyImport = async () => {
    if (!supplyImportReport) return
    setSupplyImporting(true)
    const { docName, newItems, conflictItems, sameItems } = supplyImportReport
    let added = 0, updated = 0, skipped = 0
    const errors = []
    try {
      if (newItems.length) {
        const payload = newItems.map(it => ({
          tender_id: tenderId,
          estimate_name: docName,
          material_name: it.material_name,
          unit: it.unit || null,
          supply_price: it.supply_price,
        }))
        const { error } = await supabase.from('tender_vor_supply_rates').insert(payload)
        if (error) errors.push(error.message)
        else added = payload.length
      }
      for (let idx = 0; idx < conflictItems.length; idx++) {
        const it = conflictItems[idx]
        if (supplyConflictDecisions[idx] === 'update') {
          const { error } = await supabase
            .from('tender_vor_supply_rates')
            .update({ unit: it.unit || null, supply_price: it.supply_price })
            .eq('id', it.existingId)
          if (error) errors.push(error.message)
          else updated++
        } else {
          skipped++
        }
      }
      await fetchSupplyRates()
      let msg = `Импорт расценок снабжения «${docName}» завершён.\n`
        + `Добавлено: ${added}\nОбновлено: ${updated}\n`
        + `Без изменений: ${skipped + sameItems.length}`
      if (errors.length) msg += `\n\nОшибок: ${errors.length}\n${errors[0]}`
      alert(msg)
      setSupplyImportReport(null)
      setSupplyConflictDecisions({})
    } catch (err) {
      alert('Ошибка импорта расценок: ' + err.message)
    } finally {
      setSupplyImporting(false)
    }
  }

  const cancelSupplyImport = () => {
    setSupplyImportReport(null)
    setSupplyConflictDecisions({})
  }
  const setSupplyDecision = (idx, d) =>
    setSupplyConflictDecisions(prev => ({ ...prev, [idx]: d }))
  const supplyDecideAll = (d) => {
    const obj = {}
    supplyImportReport.conflictItems.forEach((_, idx) => { obj[idx] = d })
    setSupplyConflictDecisions(obj)
  }

  // task 398: удалить все расценки снабжения выбранного документа.
  const handleClearSupplyRates = async () => {
    if (supplySelectedDoc === 'all') return
    if (!window.confirm(`Удалить всю стоимость материалов от снабжения для ВОР «${supplySelectedDoc}»?`)) return
    try {
      const { error } = await supabase
        .from('tender_vor_supply_rates')
        .delete()
        .eq('tender_id', tenderId)
        .eq('estimate_name', supplySelectedDoc)
      if (error) throw error
      setSupplyRates(prev => prev.filter(r => (r.estimate_name || 'Основная смета') !== supplySelectedDoc))
    } catch (err) {
      alert('Ошибка удаления расценок: ' + err.message)
    }
  }

  // task 345: превью первой непустой ячейки каждого столбца — подсказка
  // «A — № п/п», «C — Наименование» в выпадающих списках сопоставления.
  const estColumnPreviews = useMemo(() => {
    const empty = Array(VOR_COLUMN_CHOICES_COUNT).fill('')
    if (!pendingWorkbook || !estSelectedSheet) return empty
    const sheet = pendingWorkbook.Sheets[estSelectedSheet]
    if (!sheet) return empty
    const result = []
    for (let col = 0; col < VOR_COLUMN_CHOICES_COUNT; col++) {
      let preview = ''
      for (let r = 0; r < 6; r++) {
        const ref = XLSX.utils.encode_cell({ r, c: col })
        const cell = sheet[ref]
        if (cell && cell.v !== undefined && cell.v !== '') {
          preview = String(cell.v).replace(/\s+/g, ' ').trim()
          if (preview) break
        }
      }
      if (preview.length > 28) preview = preview.slice(0, 28) + '…'
      result.push(preview)
    }
    return result
  }, [pendingWorkbook, estSelectedSheet])

  const updateEstColumnMap = (fieldKey, value) => {
    setEstColumnMap(prev => ({
      ...prev,
      [fieldKey]: value === '' ? null : Number(value),
    }))
  }

  const resetEstColumnMap = () => setEstColumnMap({ ...VOR_DEFAULT_COLUMN_MAP })

  // task 260: текущий набор позиций (предпросмотр имеет приоритет над сохранённым)
  // task 348: фильтрация по выбранному документу. 'all' = объединённый ВОР,
  // конкретное имя = только items этого документа.
  const docNames = useMemo(() => {
    const set = new Set(estimateItems.map(it => it.estimate_name || 'Основная смета'))
    return [...set].sort((a, b) => a.localeCompare(b, 'ru'))
  }, [estimateItems])

  const currentEstimate = useMemo(() => {
    if (parsedEstimate) return parsedEstimate
    if (selectedDocName === 'all') return concatCombinedEstimate(estimateItems)
    return estimateItems.filter(it => (it.estimate_name || 'Основная смета') === selectedDocName)
  }, [parsedEstimate, estimateItems, selectedDocName])

  // task 398: карта расценок (документ ∣ материал → цена).
  const supplyRatesMap = useMemo(() => {
    const m = new Map()
    for (const r of supplyRates) {
      m.set(supplyKey(r.estimate_name, r.material_name), Number(r.supply_price) || 0)
    }
    return m
  }, [supplyRates])

  // task 405: превью столбцов для конфиг-модалки импорта расценок снабжения
  const supplyColumnPreviews = useMemo(
    () => getColumnPreviews(supplyConfig?.workbook, supplyConfig?.sheetName, SUPPLY_COLUMN_COUNT),
    [supplyConfig?.workbook, supplyConfig?.sheetName]
  )

  // Вкладка «Расценки снабжения»: только материалы (без работ) выбранного документа
  // или объединённый вид. Работы отбрасываем до конкатенации, пустые разделы — после.
  const supplyEstimate = useMemo(() => {
    const docFiltered = supplySelectedDoc === 'all'
      ? estimateItems
      : estimateItems.filter(it => (it.estimate_name || 'Основная смета') === supplySelectedDoc)
    const noWorks = docFiltered.filter(it => it.is_section || !isWorkItem(it))
    const tree = supplySelectedDoc === 'all' ? concatCombinedEstimate(noWorks) : noWorks
    return pruneEmptySections(tree)
  }, [estimateItems, supplySelectedDoc])

  const supplyCosts = useMemo(
    () => computeSupplyCosts(supplyEstimate, supplyRatesMap),
    [supplyEstimate, supplyRatesMap]
  )

  const supplySectionKeys = useMemo(() => getHeaderKeys(supplyEstimate), [supplyEstimate])
  const toggleSupplySection = (key) => {
    setSupplyCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Сброс выбранного документа во вкладке снабжения, если он исчез.
  useEffect(() => {
    if (supplySelectedDoc === 'all') return
    if (!docNames.includes(supplySelectedDoc)) setSupplySelectedDoc('all')
  }, [docNames, supplySelectedDoc])

  // Число загруженных расценок для выбранного во вкладке снабжения документа.
  const supplyTabRatesCount = useMemo(() => {
    if (supplySelectedDoc === 'all') return supplyRates.length
    return supplyRates.filter(r => (r.estimate_name || 'Основная смета') === supplySelectedDoc).length
  }, [supplyRates, supplySelectedDoc])

  // task 406: сколько расценок снабжения выбранного документа реально сопоставились
  // материалу ВОР. Отличает «не загрузил» от «загрузил, но имена не совпали».
  const supplyMatchStats = useMemo(() => {
    if (supplySelectedDoc === 'all') return null
    const docRates = supplyRates.filter(
      r => (r.estimate_name || 'Основная смета') === supplySelectedDoc
    )
    if (docRates.length === 0) return null
    const vorNames = new Set(
      supplyEstimate
        .filter(it => !it.is_section && !it._isDocDivider && !isWorkItem(it))
        .map(it => normName(it.cost_name))
    )
    const unmatched = docRates.filter(r => !vorNames.has(normName(r.material_name)))
    return { matched: docRates.length - unmatched.length, total: docRates.length, unmatched }
  }, [supplyRates, supplySelectedDoc, supplyEstimate])

  // Если активный документ удалён или ещё не выбран — переключаемся на 'all'.
  useEffect(() => {
    if (selectedDocName === 'all') return
    if (!docNames.includes(selectedDocName)) setSelectedDocName('all')
  }, [docNames, selectedDocName])

  // task 262: ключи всех свёртываемых заголовков (учитывает группировку Excel)
  const estimateSectionKeys = getHeaderKeys(currentEstimate)

  const toggleSection = (key) => {
    setCollapsedSections(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const collapseAllSections = () => setCollapsedSections(new Set(estimateSectionKeys))
  const expandAllSections = () => setCollapsedSections(new Set())

  // task 352: экспорт текущего ВОР в Excel — 3 листа (Исходный / Материалы / Работы).
  const handleExportEstimate = async () => {
    if (!currentEstimate || currentEstimate.length === 0) {
      alert('Нечего экспортировать.')
      return
    }
    // Расценки снабжения грузятся лениво (только при открытии их вкладки). Если
    // экспорт нажали с вкладки «ВОР», не посетив «Расценки снабжения», подгружаем их
    // здесь и строим локальную карту — иначе столбец «Стоимость от снабжения» пуст.
    let ratesMap = supplyRatesMap
    if (!loadedTabsRef.current.has('supply')) {
      const rows = await fetchSupplyRates()
      loadedTabsRef.current.add('supply')
      ratesMap = new Map()
      for (const r of rows || []) {
        ratesMap.set(supplyKey(r.estimate_name, r.material_name), Number(r.supply_price) || 0)
      }
    }
    const wb = XLSX.utils.book_new()

    // ===== Лист 1: Исходный ВОР =====
    // task: столбцы «Цена материалов/работ» — контрагент заполняет их; скрытый
    // столбец «ID (не изменять)» = estimate_item_id → надёжный реимпорт без
    // угадывания столбцов и без сдвига строк (матчинг по якорю в парсере).
    const sourceHeaders = ['№ п/п', 'КОД', 'Наименование затрат', 'Ед. изм.', 'Объём работ', 'Объём материалов', 'Стоимость материалов от снабжения', 'Цена материалов, ₽', 'Цена работ, ₽', 'ID (не изменять)']
    const sourceRows = [sourceHeaders]
    let workCount = 0
    let matCount = 0
    let exportDoc = null // текущий ВОР-документ (для сопоставления расценок снабжения)
    for (const it of currentEstimate) {
      if (it._isDocDivider) {
        sourceRows.push([`=== ВОР: ${it._docName} (${it._docCount} позиций) ===`, '', '', '', '', '', '', '', '', ''])
        workCount = 0
        matCount = 0
        exportDoc = it._docName
        continue
      }
      if (it.is_section) {
        sourceRows.push(['', '', it.cost_name || '', '', '', '', '', '', '', ''])
        continue
      }
      let num
      let supplyVal = ''
      if (isWorkItem(it)) {
        workCount++
        matCount = 0
        num = String(workCount)
      } else {
        matCount++
        num = workCount > 0 ? `${workCount}.${matCount}` : String(matCount)
        const price = ratesMap.get(supplyKey(it.estimate_name || exportDoc, it.cost_name))
        if (price != null) supplyVal = Math.round((Number(it.material_consumption) || 0) * Number(price) * 100) / 100
      }
      sourceRows.push([
        num,
        it.code || '',
        it.cost_name || '',
        it.unit || '',
        it.work_volume ?? '',
        it.material_consumption ?? '',
        supplyVal,
        '', // Цена материалов — заполняет контрагент
        '', // Цена работ — заполняет контрагент
        it.id, // якорь для реимпорта
      ])
    }
    const wsSource = XLSX.utils.aoa_to_sheet(sourceRows)
    wsSource['!cols'] = [
      { wch: 8 }, { wch: 10 }, { wch: 60 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 22 },
      { wch: 16 }, { wch: 16 }, { wch: 38, hidden: true },
    ]
    XLSX.utils.book_append_sheet(wb, wsSource, 'Исходный ВОР')

    // ===== Листы 2 и 3: Материалы / Работы (агрегированные по name+unit) =====
    const buildAggregateRows = (type) => {
      const map = new Map()
      for (const it of currentEstimate) {
        if (it.is_section || it._isDocDivider) continue
        const work = isWorkItem(it)
        if (type === 'works' && !work) continue
        if (type === 'materials' && work) continue
        const name = (it.cost_name || '').trim()
        if (!name) continue
        const unit = (it.unit || '').trim()
        const key = `${name.toLowerCase()}∣${unit.toLowerCase()}`
        const vol = type === 'works' ? it.work_volume : it.material_consumption
        const cur = map.get(key) || { name, unit, total: 0, count: 0, supplyCost: 0 }
        cur.total += Number(vol) || 0
        cur.count += 1
        if (type === 'materials') {
          const price = ratesMap.get(supplyKey(it.estimate_name, name))
          if (price != null) cur.supplyCost += (Number(it.material_consumption) || 0) * Number(price)
        }
        map.set(key, cur)
      }
      const rows = [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'))
      const grandTotal = rows.reduce((s, r) => s + r.total, 0)
      const grandCount = rows.reduce((s, r) => s + r.count, 0)
      const r2 = (v) => Math.round(v * 100) / 100
      if (type === 'materials') {
        const grandSupply = rows.reduce((s, r) => s + (r.supplyCost || 0), 0)
        return [
          ['№', 'Наименование', 'Ед. изм.', 'Объём (сумма)', 'Кол-во позиций', 'Стоимость от снабжения'],
          ...rows.map((r, i) => [i + 1, r.name, r.unit || '', r.total, r.count, r.supplyCost ? r2(r.supplyCost) : '']),
          ['', 'ИТОГО', '', grandTotal, grandCount, r2(grandSupply)],
        ]
      }
      const out = [
        ['№', 'Наименование', 'Ед. изм.', 'Объём (сумма)', 'Кол-во позиций'],
        ...rows.map((r, i) => [i + 1, r.name, r.unit || '', r.total, r.count]),
        ['', 'ИТОГО', '', grandTotal, grandCount],
      ]
      return out
    }

    const materialsRows = buildAggregateRows('materials')
    const wsMaterials = XLSX.utils.aoa_to_sheet(materialsRows)
    wsMaterials['!cols'] = [{ wch: 6 }, { wch: 60 }, { wch: 10 }, { wch: 16 }, { wch: 16 }, { wch: 20 }]
    XLSX.utils.book_append_sheet(wb, wsMaterials, 'Материалы')

    const worksRows = buildAggregateRows('works')
    const wsWorks = XLSX.utils.aoa_to_sheet(worksRows)
    wsWorks['!cols'] = [{ wch: 6 }, { wch: 60 }, { wch: 10 }, { wch: 16 }, { wch: 16 }]
    XLSX.utils.book_append_sheet(wb, wsWorks, 'Работы')

    const tenderLabel = tender?.work_description
      ? `_${tender.work_description.slice(0, 30).replace(/[\\/:*?"<>|]/g, '')}`
      : ''
    const docLabel = selectedDocName === 'all' ? 'Объединённый' : selectedDocName.replace(/[\\/:*?"<>|]/g, '')
    XLSX.writeFile(wb, `ВОР_${docLabel}${tenderLabel}.xlsx`)
  }

  // Даты загрузки КП по каждому участнику. Сначала файлы КП (одним запросом),
  // затем — только для участников без файла — самая свежая строка расценок.
  // Ошибки глушим: подпись «загружено …» вспомогательная и не должна ронять вкладку.
  const loadKpUploadedAt = async (participants) => {
    if (!tenderId || participants.length === 0) return
    const map = {}
    try {
      const { data: files } = await supabase
        .from('tender_proposal_files')
        .select('counterparty_id, created_at')
        .eq('tender_id', tenderId)
        .eq('file_kind', 'commercial_proposal')
        .order('created_at', { ascending: false })
      for (const f of files || []) {
        if (!map[f.counterparty_id]) map[f.counterparty_id] = f.created_at
      }
      const withoutFile = participants
        .map(p => p.counterparty_id)
        .filter(id => id && !map[id])
      const rows = await Promise.all(withoutFile.map(id =>
        supabase
          .from('tender_counterparty_proposals')
          .select('counterparty_id, created_at')
          .eq('tender_id', tenderId)
          .eq('counterparty_id', id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
      ))
      for (const r of rows) {
        if (r?.data?.created_at) map[r.data.counterparty_id] = r.data.created_at
      }
    } catch (err) {
      console.warn('Не удалось получить даты загрузки КП:', err.message || err)
    }
    setKpUploadedAt(map)
  }

  const fetchTenderData = async () => {
    setLoading(true)
    try {
      const { data: tenderData, error: tenderError } = await supabase
        .from('tenders')
        .select('*, objects(name, status, address, map_link), winner:counterparties!winner_counterparty_id(id, name), tender_winners(counterparty_id, scope_note, counterparties(id, name)), cost_plan_responsible:contacts!cost_plan_responsible_id(id, full_name), vor_responsible:contacts!vor_responsible_id(id, full_name), materials_tender:tenders!parent_tender_id(id, status, materials_proposal_deadline, materials_proposal_link, responsible_contact:contacts!responsible_contact_id(id, full_name))')
        .eq('id', tenderId)
        .single()

      if (tenderError) throw tenderError
      // Reverse FK tenders!parent_tender_id возвращается массивом — сводим к одному.
      const normalizedTender = tenderData ? {
        ...tenderData,
        materials_tender: Array.isArray(tenderData.materials_tender)
          ? (tenderData.materials_tender[0] || null)
          : (tenderData.materials_tender || null)
      } : tenderData
      setTender(normalizedTender)
      setNotesDraft(tenderData?.notes || '')

      const { data: counterpartiesData, error: cpError } = await supabase
        .from('tender_counterparties')
        .select(`
          *,
          counterparties(
            id,
            name,
            work_type,
            inn,
            counterparty_contacts(id, full_name, position, phone, email)
          )
        `)
        .eq('tender_id', tenderId)
        .order('sort_order', { ascending: true })
        .order('invited_at', { ascending: true })

      if (cpError) throw cpError
      setTenderCounterparties(counterpartiesData || [])
      loadKpUploadedAt(counterpartiesData || [])
    } catch (error) {
      console.error('Ошибка загрузки данных тендера:', error.message)
      alert('Ошибка загрузки данных: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  const loadAuditLog = async () => {
    try {
      setLoadingAuditLog(true)
      setAuditLogError(null)
      // Постранично — у активного тендера история может перевалить за 1000 записей
      // (потолок PostgREST). Тай-брейк по id: changed_at не уникален.
      const PAGE = 1000
      const rows = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('tender_audit_log')
          .select('*')
          .eq('tender_id', tenderId)
          .order('changed_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, from + PAGE - 1)
        if (error) throw error
        if (data?.length) rows.push(...data)
        if (!data || data.length < PAGE) break
      }
      setAuditLog(rows)
    } catch (err) {
      console.error('Ошибка загрузки истории тендера:', err.message)
      setAuditLog([])
      setAuditLogError(err.message || 'Не удалось загрузить историю')
    } finally {
      setLoadingAuditLog(false)
    }
  }

  const handleSaveNotes = async () => {
    if (!tender) return
    // Служебные символы из Word/PDF/1С Postgres не принимает (22P05) — чистим до отправки.
    const oldValue = sanitizeUserText(tender.notes) || ''
    const newValue = sanitizeUserText(notesDraft) || ''
    if (oldValue === newValue) return
    try {
      setNotesSaving(true)
      // .select() отличает успешную запись от «0 строк» (истёкшая сессия: запрос уходит
      // как anon, RLS молча отсекает строку, ошибки при этом нет).
      const { data, error } = await supabase
        .from('tenders')
        .update({ notes: newValue || null })
        .eq('id', tender.id)
        .select('id')

      if (error) {
        console.error('Ошибка сохранения примечания тендера:', error)
        alert(isAuthError(error)
          ? SESSION_EXPIRED_MESSAGE
          : 'Не удалось сохранить примечание: ' + describeSupabaseError(error))
        return
      }
      if (!data || data.length === 0) {
        console.warn('Примечание тендера: UPDATE не затронул ни одной строки', { tenderId: tender.id })
        alert('Примечание не сохранено: тендер недоступен. Обычно это истёкшая сессия — обновите страницу (F5) и повторите.')
        return
      }

      const role = localStorage.getItem('userRole') || null
      // История вторична: ошибку пишем в консоль, пользователя не тревожим.
      const { error: logError } = await supabase.from('tender_audit_log').insert([{
        tender_id: tender.id,
        event_type: 'field_updated',
        field_name: 'notes',
        old_value: sanitizeDeep(oldValue) || null,
        new_value: sanitizeDeep(newValue) || null,
        description: 'Изменено: Примечание',
        changed_by_role: role,
        changed_by_name: userProfile?.full_name || null
      }])
      if (logError) console.error('Не удалось записать историю примечания:', describeSupabaseError(logError), logError)

      setTender(prev => prev ? { ...prev, notes: newValue } : prev)
      setNotesDraft(newValue)
      setNotesSavedAt(Date.now())
      loadAuditLog()
    } catch (err) {
      // Только исключения фронта — не выдаём их за отказ базы.
      console.error('Непредвиденная ошибка при сохранении примечания:', err)
      alert('Непредвиденная ошибка при сохранении примечания: ' + (err?.message || err))
    } finally {
      setNotesSaving(false)
    }
  }

  const formatDateTime = (dt) => {
    if (!dt) return ''
    const d = new Date(dt)
    const dd = String(d.getDate()).padStart(2, '0')
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const yyyy = d.getFullYear()
    const hh = String(d.getHours()).padStart(2, '0')
    const mi = String(d.getMinutes()).padStart(2, '0')
    return `${dd}.${mm}.${yyyy} ${hh}:${mi}`
  }

  const ROLE_LABEL = {
    employee: 'Сотрудник',
    contractor: 'Подрядчик',
    admin: 'Администратор'
  }

  const HISTORY_FIELD_LABELS = {
    work_description: 'Описание работ',
    start_date: 'Дата начала',
    end_date: 'Дата окончания',
    tender_package_link: 'Ссылка на тендерный пакет',
    summary_proposal_link: 'Ссылка на сводную КП',
    responsible_contact_id: 'Ответственный по тендеру',
    cost_plan_responsible_id: 'Ответственный за план затрат',
    vor_responsible_id: 'Ответственный за ВОРы и РД',
    object_id: 'Объект',
    notes: 'Примечание',
    participant_notes: 'Примечание участника',
    completion_letter_sent: 'Письмо о завершении'
  }

  const formatHistoryValue = (val) => {
    if (val === null || val === undefined) return '—'
    if (typeof val === 'string' || typeof val === 'number') return String(val)
    if (typeof val === 'object') {
      // Примечание участника хранится как { tc_id, cp_name, text } — показываем
      // сам текст. Проверка text должна идти раньше name, иначе вместо примечания
      // отобразилось бы имя контрагента.
      if (val.text !== undefined) return val.text || '—'
      if (val.name) return val.name
      return JSON.stringify(val)
    }
    return String(val)
  }

  const renderEventIcon = (eventType) => {
    switch (eventType) {
      case 'created': return '🟢'
      case 'status_changed': return '🔄'
      case 'winner_assigned': return '🏆'
      case 'field_updated': return '📝'
      case 'participant_added': return '➕'
      case 'participant_removed': return '➖'
      case 'participant_status': return '📞'
      default: return '•'
    }
  }

  const formatDate = (dateString) => {
    if (!dateString) return '-'
    return new Date(dateString).toLocaleDateString('ru-RU')
  }

  const formatDateRangeOrDash = (start, end) => {
    if (!start && !end) return '—'
    if (start && end) return `${formatDate(start)} — ${formatDate(end)}`
    return formatDate(start || end)
  }

  const getStatusBadgeClass = (status) => {
    const classes = {
      'Заявка на тендер': 'status-not-started',
      'Подготовка ВОР': 'status-waiting-vor',
      'Идет тендерная процедура': 'status-in-progress',
      'Подведение итогов': 'status-summarizing',
      'Завершен': 'status-completed',
      'Приостановка тендера': 'status-suspended',
      'Не начат': 'status-not-started',
      'Ожидание ВОР': 'status-waiting-vor',
      'Принято в работу': 'status-completed'
    }
    return classes[status] || ''
  }

  // Запись в журнал по действию с участником тендера (примечание, смена статуса).
  // Привязка к участнику — внутри JSONB (tc_id), как на странице списка тендеров:
  // отдельной колонки в tender_audit_log нет. История вторична, поэтому ошибку
  // только логируем — основное изменение уже сохранено.
  const logParticipantEvent = async (tenderCounterpartyId, eventType, payload) => {
    try {
      const role = localStorage.getItem('userRole') || null
      const { error } = await supabase.from('tender_audit_log').insert([{
        tender_id: tenderId,
        event_type: eventType,
        field_name: payload.fieldName,
        old_value: sanitizeDeep({ tc_id: tenderCounterpartyId, cp_name: payload.cpName || null, text: payload.oldText ?? '' }),
        new_value: sanitizeDeep({ tc_id: tenderCounterpartyId, cp_name: payload.cpName || null, text: payload.newText ?? '' }),
        description: sanitizeUserText(payload.description) || null,
        changed_by_role: role,
        changed_by_name: userProfile?.full_name || null,
      }])
      if (error) console.error('Не удалось записать историю по участнику:', describeSupabaseError(error), error)
    } catch (err) {
      console.error('Ошибка записи истории по участнику:', err?.message || err)
    }
  }

  const getCounterpartyStatusColor = (status) => {
    const colors = {
      'request_sent': '#6366f1',
      'declined': '#b91c1c',
      'proposal_provided': '#15803d',
      'accepted_for_work': '#4338ca'
    }
    return colors[status] || '#64748b'
  }

  const uniqueAvailableWorkTypes = useMemo(() => [...new Set(
    availableCounterparties
      .flatMap(c => (c.work_type || '').split(',').map(wt => wt.trim()))
      .filter(wt => wt !== '')
  )].sort((a, b) => a.localeCompare(b, 'ru')), [availableCounterparties])

  // task 415: фильтрация по категории ОС/ОГ убрана — только поиск + вид работ.
  const filteredAvailableCounterparties = useMemo(() => availableCounterparties.filter(cp => {
    if (participantWorkTypeFilter) {
      const types = (cp.work_type || '').split(',').map(wt => wt.trim())
      if (!types.includes(participantWorkTypeFilter)) return false
    }
    if (!participantSearchQuery.trim()) return true
    const query = participantSearchQuery.toLowerCase().trim()
    return (
      (cp.name && cp.name.toLowerCase().includes(query)) ||
      (cp.inn && cp.inn.toLowerCase().includes(query)) ||
      (cp.work_type && cp.work_type.toLowerCase().includes(query))
    )
  }), [availableCounterparties, participantWorkTypeFilter, participantSearchQuery])

  // Уже приглашённые в тендер: их показываем в списке с пометкой, но выбрать нельзя.
  const participantAddedIds = useMemo(
    () => new Set(tenderCounterparties.map(tc => tc.counterparty_id)),
    [tenderCounterparties]
  )
  const selectableAvailableCounterparties = useMemo(
    () => filteredAvailableCounterparties.filter(cp => !participantAddedIds.has(cp.id)),
    [filteredAvailableCounterparties, participantAddedIds]
  )

  const closeAddParticipantModal = () => {
    setShowAddParticipantModal(false)
    setParticipantSearchQuery('')
    setParticipantWorkTypeFilter('')
  }

  const handleOpenAddParticipantModal = async () => {
    setShowAddParticipantModal(true)
    setSelectedParticipants(new Set())
    setParticipantSearchQuery('')
    setParticipantWorkTypeFilter('')
    setLoadingCounterparties(true)

    try {
      // Постранично: без пагинации PostgREST режет на 1000 строк и хвост сортировки
      // по названию (буква «Ф» и далее) терялся. Тай-брейк по id — имена неуникальны.
      const PAGE = 1000
      const rows = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('counterparties')
          .select('id, name, work_type, inn, department')
          .eq('status', 'active')
          .is('deleted_at', null)   // удалённых не предлагаем к приглашению
          .order('name', { ascending: true })
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1)
        if (error) throw error
        if (data?.length) rows.push(...data)
        if (!data || data.length < PAGE) break
      }

      // Уже добавленных НЕ отфильтровываем — показываем их в списке с пометкой
      // «уже в тендере» (иначе кажется, что контрагент «не находится»).
      setAvailableCounterparties(rows)
    } catch (error) {
      console.error('Ошибка загрузки контрагентов:', error)
      alert('Ошибка загрузки списка контрагентов')
    } finally {
      setLoadingCounterparties(false)
    }
  }

  const handleToggleParticipant = (counterpartyId) => {
    setSelectedParticipants(prev => {
      const newSet = new Set(prev)
      if (newSet.has(counterpartyId)) {
        newSet.delete(counterpartyId)
      } else {
        newSet.add(counterpartyId)
      }
      return newSet
    })
  }

  const handleAddParticipants = async () => {
    if (selectedParticipants.size === 0) {
      alert('Выберите хотя бы одного контрагента')
      return
    }

    try {
      // Новые участники встают в конец списка. Без явного sort_order они брали
      // DEFAULT 0 (миграция 20260731), а у существующих после бэкфилла 10, 20, 30…
      // — и свежедобавленные оказывались первыми.
      // Максимум берём из базы: другой инженер мог переставить участников, пока
      // окно выбора было открыто.
      const { data: lastRow } = await supabase
        .from('tender_counterparties')
        .select('sort_order')
        .eq('tender_id', tenderId)
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle()
      const maxOrder = lastRow?.sort_order || 0
      const participantsToAdd = Array.from(selectedParticipants).map((counterpartyId, i) => ({
        tender_id: tenderId,
        counterparty_id: counterpartyId,
        status: 'request_sent',
        sort_order: maxOrder + (i + 1) * 10,
      }))

      const { error } = await supabase
        .from('tender_counterparties')
        .insert(participantsToAdd)

      if (error) throw error

      const role = localStorage.getItem('userRole') || null
      const logRows = participantsToAdd.map(p => {
        const cp = availableCounterparties.find(c => c.id === p.counterparty_id)
        const name = cp?.name || null
        return {
          tender_id: tenderId,
          event_type: 'participant_added',
          field_name: 'participants',
          old_value: null,
          new_value: { id: p.counterparty_id, name },
          description: `Добавлен участник: ${name || '—'}`,
          changed_by_role: role,
          changed_by_name: userProfile?.full_name || null
        }
      })
      if (logRows.length > 0) {
        await supabase.from('tender_audit_log').insert(logRows)
      }

      setShowAddParticipantModal(false)
      setSelectedParticipants(new Set())
      setParticipantSearchQuery('')
      fetchTenderData()
      loadAuditLog()
      alert(`Добавлено ${participantsToAdd.length} участников`)
    } catch (error) {
      console.error('Ошибка добавления участников:', error)
      alert('Ошибка добавления: ' + error.message)
    }
  }

  // task 427: перетаскивание участника внутри списка (общий порядок со страницей
  // тендеров — сохраняется в tender_counterparties.sort_order).
  const handleReorderParticipant = async (draggedId, targetId) => {
    const position = tcDragOver?.position || 'before'
    setDraggedTc(null)
    setTcDragOver(null)
    const pairs = reorderSiblings(tenderCounterparties, draggedId, targetId, position)
    if (!pairs) return
    setTenderCounterparties(prev => prev
      .map(tc => { const p = pairs.find(x => x.id === tc.id); return p ? { ...tc, sort_order: p.sort_order } : tc })
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)))
    try {
      await Promise.all(pairs.map(p =>
        supabase.from('tender_counterparties').update({ sort_order: p.sort_order }).eq('id', p.id)
      ))
    } catch (err) {
      alert('Не удалось сохранить порядок участников: ' + (err.message || err))
      fetchTenderData()
    }
  }

  const handleUpdateParticipantStatus = async (tenderCounterpartyId, newStatus) => {
    const tc = tenderCounterparties.find(x => x.id === tenderCounterpartyId)
    const oldStatus = tc?.status || 'request_sent'
    const cpName = tc?.counterparties?.name || null
    try {
      const { error } = await supabase
        .from('tender_counterparties')
        .update({ status: newStatus })
        .eq('id', tenderCounterpartyId)

      if (error) throw error

      // Отметка «КП предоставлено»/«Отказ» — результат работы с подрядчиком.
      // Пишем в журнал, чтобы она была видна в истории тендера и в отчёте
      // «Работа инженеров» (раньше смена статуса нигде не фиксировалась).
      if (oldStatus !== newStatus) {
        await logParticipantEvent(tenderCounterpartyId, 'participant_status', {
          fieldName: 'participant_status',
          cpName,
          oldText: PARTICIPANT_STATUS_LABEL[oldStatus] || oldStatus,
          newText: PARTICIPANT_STATUS_LABEL[newStatus] || newStatus,
          description: `Статус участника${cpName ? ` (${cpName})` : ''}: ${PARTICIPANT_STATUS_LABEL[oldStatus] || oldStatus} → ${PARTICIPANT_STATUS_LABEL[newStatus] || newStatus}`,
        })
      }

      setTenderCounterparties(prev =>
        prev.map(tc =>
          tc.id === tenderCounterpartyId
            ? { ...tc, status: newStatus }
            : tc
        )
      )
      loadAuditLog()
    } catch (error) {
      console.error('Ошибка обновления статуса:', error)
      alert('Ошибка обновления статуса: ' + error.message)
    }
  }

  const handleUpdateParticipantNotes = async (tenderCounterpartyId, notes) => {
    const cleanNotes = sanitizeUserText(notes) || ''
    const tc = tenderCounterparties.find(x => x.id === tenderCounterpartyId)
    const oldNotes = sanitizeUserText(tc?.notes || '') || ''
    const cpName = tc?.counterparties?.name || null
    try {
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
        return
      }
      if (!data || data.length === 0) {
        console.warn('Примечание участника: UPDATE не затронул ни одной строки', { tenderCounterpartyId })
        alert('Примечание не сохранено: строка участника недоступна. Обычно это истёкшая сессия или удалённый участник — обновите страницу (F5) и повторите.')
        return
      }

      // Тот же формат записи, что на странице списка тендеров: привязка к участнику
      // живёт внутри JSONB (tc_id), ключ текста — text.
      if (cleanNotes !== oldNotes) {
        await logParticipantEvent(tenderCounterpartyId, 'field_updated', {
          fieldName: 'participant_notes',
          cpName,
          oldText: oldNotes,
          newText: cleanNotes,
          description: cpName ? `Примечание участника: ${cpName}` : 'Примечание участника',
        })
      }

      setTenderCounterparties(prev =>
        prev.map(tc =>
          tc.id === tenderCounterpartyId ? { ...tc, notes: cleanNotes } : tc
        )
      )
      loadAuditLog()
    } catch (err) {
      console.error('Непредвиденная ошибка при сохранении примечания участника:', err)
      alert('Непредвиденная ошибка при сохранении примечания: ' + (err?.message || err))
    }
  }

  if (loading) {
    return <div className="loading">Загрузка...</div>
  }

  // Скоуп по объекту: руководитель, привязанный к объекту, не видит чужой тендер
  // даже по прямой ссылке.
  if (tender && scopedObjectIds.length > 0 && !scopedObjectIds.includes(tender.object_id)) {
    return (
      <AccessDenied
        title="Тендер недоступен"
        message="Этот тендер относится к другому объекту, вне вашего доступа. Обратитесь к администратору, если нужен доступ."
        backTo="/tenders"
      />
    )
  }

  if (!tender) {
    return (
      <div className="tender-detail-page">
        <div className="error-message">Тендер не найден</div>
        <button className="btn-secondary" onClick={() => navigate(-1)}>
          Назад
        </button>
      </div>
    )
  }

  // task 215: несколько победителей (с откатом на одиночного winner, если миграция не применена)
  const winnersList = (tender.tender_winners && tender.tender_winners.length > 0)
    ? tender.tender_winners.map(w => ({
        id: w.counterparty_id,
        name: w.counterparties?.name || '—',
        scope: w.scope_note || ''
      }))
    : (tender.winner ? [{ id: tender.winner.id, name: tender.winner.name, scope: '' }] : [])
  const winnerIds = new Set(winnersList.map(w => w.id))

  // task 245: блок статусов/сроков/ответственных показываем для основного строительства
  const isMainConstruction = tender.objects?.status === 'main_construction'
    && (tender.tender_type === 'main' || !tender.tender_type)

  const vorPhaseText = (() => {
    const s = tender.vor_status || 'not_started'
    if (s === 'completed') return tender.vor_link ? '✓ Готово' : '⚠ Завершён без ссылки'
    if (s === 'in_progress') return 'В работе'
    return 'Не начат'
  })()
  const costPlanPhaseText = (() => {
    const s = tender.cost_plan_status || 'not_started'
    if (s === 'not_required') return '— Не требуется'
    if (s === 'completed') return tender.cost_plan_link ? '✓ Готово' : '⚠ Завершён без ссылки'
    if (s === 'in_progress') return 'В работе'
    return 'Не начат'
  })()

  return (
    <div className="tender-detail-page">
      {/* Шапка */}
      <div className="tender-detail-header">
        <button className="btn-back" onClick={() => navigate(-1)} title="Назад к списку">
          ←
        </button>
        <div className="tender-detail-title">
          {/* У «прочего» объекта в реестре может не быть — тогда показываем
              наименование, вписанное вручную (миграция 20260825). */}
          <h2>{tenderObjectName(tender, 'Тендер')}</h2>
          {tender.objects?.address && (
            <p className="tender-object-address" style={{ margin: '0.25rem 0 0', color: 'var(--text-tertiary)', fontSize: '0.875rem' }}>
              {tender.objects.address}
            </p>
          )}
          {tender.objects?.map_link && (
            <div style={{ marginTop: '0.25rem' }}>
              <a
                href={tender.objects.map_link}
                target="_blank"
                rel="noopener noreferrer"
                title="Открыть в Яндекс.Картах"
                className="yandex-map-link"
              >
                <span aria-hidden>🗺️</span>
                <span>Месторасположение</span>
              </a>
            </div>
          )}
          {tender.work_description && (
            <p className="tender-work-description">
              <span className="tender-work-label">Выполняемые работы:</span> {tender.work_description}
            </p>
          )}
        </div>
        <div className="tender-header-right">
          {tender.created_at && (
            <span className="tender-created-at">Создан {formatDate(tender.created_at)}</span>
          )}
          <span className={`status-badge ${getStatusBadgeClass(tender.status)}`}>
            {tender.status}
          </span>
        </div>
      </div>

      {/* Информация о тендере */}
      <div className="tender-info-card">
        <div className="tender-info-grid">
          <div className="info-item">
            <span className="info-label">Дата начала работ</span>
            <span className="info-value">{formatDate(tender.start_date)}</span>
          </div>
          <div className="info-item">
            <span className="info-label">Дата окончания работ</span>
            <span className="info-value">{formatDate(tender.end_date)}</span>
          </div>
          <div className="info-item">
            <span className="info-label">Участников</span>
            <span className="info-value">{tenderCounterparties.length}</span>
          </div>
          {winnersList.length > 0 && (
            <div className="info-item winner">
              <span className="info-label">{winnersList.length > 1 ? 'Победители' : 'Победитель'}</span>
              <span className="info-value winner-name">
                {winnersList.map((w) => (
                  <span key={w.id} style={{ display: 'block' }}>
                    🏆 {w.name}{w.scope ? ` — ${w.scope}` : ''}
                  </span>
                ))}
              </span>
            </div>
          )}
          <div className="info-item">
            <span className="info-label">Тендерный пакет</span>
            <span className="info-value info-stack">
              {tender.tender_package_link && (
                <a href={tender.tender_package_link} target="_blank" rel="noopener noreferrer" className="info-link">
                  Открыть документ
                </a>
              )}
              <button
                type="button"
                onClick={() => setPackageDocsModalOpen(true)}
                style={{
                  alignSelf: 'flex-start',
                  background: 'none',
                  border: '1px dashed var(--border-color)',
                  borderRadius: '4px',
                  padding: '0.125rem 0.5rem',
                  marginTop: '0.25rem',
                  color: 'var(--text-tertiary)',
                  cursor: 'pointer',
                  fontSize: '0.75rem'
                }}
                title="Документы тендерного пакета"
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                  <PaperclipIcon size={12} />
                  Документы{packageDocCount ? ` (${packageDocCount})` : ''}
                </span>
              </button>
            </span>
          </div>
          {!isMainConstruction && (tender.cost_plan_start_date || tender.cost_plan_end_date || tender.cost_plan_responsible) && (
            <div className="info-item">
              <span className="info-label">Срок выполнения плана затрат</span>
              <span className="info-value">
                {formatDateRangeOrDash(tender.cost_plan_start_date, tender.cost_plan_end_date)}
                {tender.cost_plan_responsible?.full_name && (
                  <span className="info-sub"> · {tender.cost_plan_responsible.full_name}</span>
                )}
              </span>
            </div>
          )}
          {!isMainConstruction && (tender.vor_start_date || tender.vor_end_date || tender.vor_responsible) && (
            <div className="info-item">
              <span className="info-label">Срок подготовки ВОР</span>
              <span className="info-value">
                {formatDateRangeOrDash(tender.vor_start_date, tender.vor_end_date)}
                {tender.vor_responsible?.full_name && (
                  <span className="info-sub"> · {tender.vor_responsible.full_name}</span>
                )}
              </span>
            </div>
          )}

          {/* task 245/249/250: этапы — статус / срок (+ответственный) / ссылка по строкам */}
          {isMainConstruction && (
            <>
              <div className="info-item">
                <span className="info-label">ВОРы и РД</span>
                <span className="info-value info-stack">
                  <span>{vorPhaseText}</span>
                  {((tender.vor_start_date || tender.vor_end_date) || tender.vor_responsible?.full_name) && (
                    <span className="info-sub">
                      {formatDateRangeOrDash(tender.vor_start_date, tender.vor_end_date)}
                      {tender.vor_responsible?.full_name && ` · ${tender.vor_responsible.full_name}`}
                    </span>
                  )}
                  {tender.vor_link && (
                    <a href={tender.vor_link} target="_blank" rel="noopener noreferrer" className="info-link">Открыть документ</a>
                  )}
                  <button
                    type="button"
                    onClick={() => setVorDocsModalOpen(true)}
                    style={{
                      alignSelf: 'flex-start',
                      background: 'none',
                      border: '1px dashed var(--border-color)',
                      borderRadius: '4px',
                      padding: '0.125rem 0.5rem',
                      marginTop: '0.25rem',
                      color: 'var(--text-tertiary)',
                      cursor: 'pointer',
                      fontSize: '0.75rem'
                    }}
                    title="Документы ВОР и РД"
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                      <PaperclipIcon size={12} />
                      Документы{vorDocCount ? ` (${vorDocCount})` : ''}
                    </span>
                  </button>
                </span>
              </div>
              <div className="info-item">
                <span className="info-label">План затрат</span>
                <span className="info-value info-stack">
                  <span>{costPlanPhaseText}</span>
                  {((tender.cost_plan_start_date || tender.cost_plan_end_date) || tender.cost_plan_responsible?.full_name) && (
                    <span className="info-sub">
                      {formatDateRangeOrDash(tender.cost_plan_start_date, tender.cost_plan_end_date)}
                      {tender.cost_plan_responsible?.full_name && ` · ${tender.cost_plan_responsible.full_name}`}
                    </span>
                  )}
                  {tender.cost_plan_link && (
                    <a href={tender.cost_plan_link} target="_blank" rel="noopener noreferrer" className="info-link">Открыть документ</a>
                  )}
                </span>
              </div>
              <div className="info-item">
                <span className="info-label">Тендер на материалы</span>
                <span className="info-value info-stack">
                  {tender.materials_tender ? (
                    <>
                      <span>{tender.materials_tender.status || 'Не начат'}</span>
                      {(tender.materials_tender.materials_proposal_deadline || tender.materials_tender.responsible_contact?.full_name) && (
                        <span className="info-sub">
                          {tender.materials_tender.materials_proposal_deadline
                            ? `срок КП: ${formatDate(tender.materials_tender.materials_proposal_deadline)}`
                            : ''}
                          {tender.materials_tender.responsible_contact?.full_name
                            ? `${tender.materials_tender.materials_proposal_deadline ? ' · ' : ''}${tender.materials_tender.responsible_contact.full_name}`
                            : ''}
                        </span>
                      )}
                      {tender.materials_tender.materials_proposal_link && (
                        <a href={tender.materials_tender.materials_proposal_link} target="_blank" rel="noopener noreferrer" className="info-link">Открыть КП</a>
                      )}
                    </>
                  ) : (
                    <span className="info-sub">— не создан</span>
                  )}
                </span>
              </div>
              <div className="info-item">
                <span className="info-label">Сводная КП</span>
                <span className="info-value info-stack">
                  {tender.summary_proposal_link
                    ? <a href={tender.summary_proposal_link} target="_blank" rel="noopener noreferrer" className="info-link">Открыть документ</a>
                    : <span className="info-sub">—</span>}
                </span>
              </div>
            </>
          )}
        </div>

        {/* Итоговый документ (решение о выборе подрядчика) — при завершённом тендере.
            Взаимосвязан со вкладкой «Документы»: одна и та же запись tender_docs (is_final). */}
        {tender.status === 'Завершен' && (
          <TenderFinalDocBlock
            tenderId={tenderId}
            canEdit={canEditTenders}
            version={tenderDocsVersion}
            onChange={bumpTenderDocs}
          />
        )}

        <div className="tender-notes">
          <div className="tender-notes-header">
            <span className="info-label">Примечание</span>
            {notesSaving && <span className="tender-notes-status">Сохранение…</span>}
            {!notesSaving && notesSavedAt && (Date.now() - notesSavedAt < 2500) && (
              <span className="tender-notes-status saved">Сохранено</span>
            )}
          </div>
          <textarea
            className="tender-notes-textarea"
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            onBlur={handleSaveNotes}
            placeholder="Свободные заметки по тендеру: ход переговоров, особые условия, риски, договорённости…"
            rows={2}
            readOnly={!canEditTenders}
            disabled={!canEditTenders}
          />
        </div>
      </div>

      {/* Вкладки */}
      <div className="tender-tabs">
        <button
          className={`tender-tab ${activeTab === 'estimate' ? 'active' : ''}`}
          onClick={() => setActiveTab('estimate')}
        >
          ВОР
          {estimateItems.length > 0 && <span className="tab-count">{estimateItems.length}</span>}
        </button>
        {/* task 398: Расценки снабжения — между ВОР и Сравнение КП */}
        <button
          className={`tender-tab ${activeTab === 'supply' ? 'active' : ''}`}
          onClick={() => setActiveTab('supply')}
        >
          Расценки снабжения
          {(supplyRates.length || supplyRatesCount) > 0 && (
            <span className="tab-count">{supplyRates.length || supplyRatesCount}</span>
          )}
        </button>
        {/* task 346: Сравнение КП — между ВОР и Участники */}
        <button
          className={`tender-tab ${activeTab === 'proposals' ? 'active' : ''}`}
          onClick={() => setActiveTab('proposals')}
        >
          Сравнение КП
          {proposalsCount > 0 && <span className="tab-count">{proposalsCount}</span>}
        </button>
        <button
          className={`tender-tab ${activeTab === 'participants' ? 'active' : ''}`}
          onClick={() => setActiveTab('participants')}
        >
          Участники
          {tenderCounterparties.length > 0 && <span className="tab-count">{tenderCounterparties.length}</span>}
        </button>
        <button
          className={`tender-tab ${activeTab === 'documents' ? 'active' : ''}`}
          onClick={() => setActiveTab('documents')}
        >
          Документы
        </button>
        <button
          className={`tender-tab ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => setActiveTab('history')}
        >
          История
          {(auditLog.length || auditLogCount) > 0 && (
            <span className="tab-count">{auditLog.length || auditLogCount}</span>
          )}
        </button>
      </div>

      {/* Контент вкладок */}
      <div className="tender-tab-content">
        {/* Вкладка «Документы» тендера (согласования, ТЗ, сводки, итоговый документ) */}
        {activeTab === 'documents' && (
          <TenderDocumentsTab
            tenderId={tenderId}
            canEdit={canEditTenders}
            version={tenderDocsVersion}
            onChange={bumpTenderDocs}
          />
        )}
        {/* task 259: Вкладка Смета */}
        {activeTab === 'estimate' && (
          <div className="estimate-section">
            <div className="section-header">
              <h3>ВОР тендера</h3>
              <div className="section-actions">
                {canEditTenders && (
                  <label className="btn-primary estimate-import-label">
                    {/* task 348: всегда «Добавить ВОР» — несколько документов
                        могут сосуществовать (каждый со своим estimate_name). */}
                    {estimateItems.length > 0 || parsedEstimate ? '+ Добавить ВОР' : 'Импорт из Excel'}
                    <input
                      ref={estimateFileRef}
                      type="file"
                      accept=".xlsx,.xls"
                      onChange={handleEstimateFileSelect}
                      style={{ display: 'none' }}
                    />
                  </label>
                )}
                {canEditTenders && estimateItems.length > 0 && !parsedEstimate && (
                  <button
                    className="btn-secondary"
                    onClick={handleClearEstimate}
                    title={selectedDocName === 'all'
                      ? 'Удалить все ВОРы тендера'
                      : `Удалить ВОР «${selectedDocName}»`}
                  >
                    {selectedDocName === 'all' ? 'Удалить все ВОРы' : `Удалить «${selectedDocName}»`}
                  </button>
                )}
              </div>
            </div>

            {parsedEstimate && (
              <div className="estimate-verify-bar">
                <span>
                  Распознано <strong>{parsedEstimate.length}</strong> позиций. Проверьте корректность и сохраните.
                </span>
                <div className="estimate-verify-actions">
                  <button
                    className="btn-secondary"
                    onClick={() => { setParsedEstimate(null); setPendingWorkbook(null) }}
                    disabled={estimateSaving}
                  >
                    Отмена
                  </button>
                  <button
                    className="btn-primary"
                    onClick={handleSaveEstimate}
                    disabled={estimateSaving}
                  >
                    {estimateSaving ? 'Сохранение…' : 'Сохранить ВОР в тендер'}
                  </button>
                </div>
              </div>
            )}

            {(parsedEstimate || estimateItems.length > 0) ? (
              <>
                {/* task 348: документы ВОР — переключение между ними и
                    «Объединённый» (агрегированный из всех документов).
                    Скрыто во время предпросмотра (parsedEstimate) — там
                    показывается ещё не сохранённый документ. */}
                {!parsedEstimate && (
                  <DocTabsTree
                    docNames={docNames}
                    estimateItems={estimateItems}
                    selected={selectedDocName}
                    onSelect={setSelectedDocName}
                  />
                )}

                <div className="estimate-subtabs">
                  <div className="estimate-subtabs-left">
                    <button
                      className={`estimate-subtab ${estimateSubTab === 'source' ? 'active' : ''}`}
                      onClick={() => setEstimateSubTab('source')}
                    >Исходный ВОР</button>
                    <button
                      className={`estimate-subtab ${estimateSubTab === 'materials' ? 'active' : ''}`}
                      onClick={() => setEstimateSubTab('materials')}
                    >Материалы</button>
                    <button
                      className={`estimate-subtab ${estimateSubTab === 'works' ? 'active' : ''}`}
                      onClick={() => setEstimateSubTab('works')}
                    >Работы</button>
                  </div>
                  {estimateSubTab === 'source' && (
                    <div className="estimate-collapse-controls">
                      {estimateSectionKeys.length > 0 && (
                        <>
                          <button className="btn-secondary btn-sm" onClick={collapseAllSections}>
                            Свернуть всё
                          </button>
                          <button className="btn-secondary btn-sm" onClick={expandAllSections}>
                            Развернуть всё
                          </button>
                        </>
                      )}
                      {/* task 352: экспорт текущего вида в Excel (отдельный ВОР или объединённый) */}
                      <button
                        className="btn-secondary btn-sm estimate-export-btn"
                        onClick={handleExportEstimate}
                        title={selectedDocName === 'all'
                          ? 'Скачать объединённый ВОР (все документы)'
                          : `Скачать ВОР «${selectedDocName}»`}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="7 10 12 15 17 10" />
                          <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        Скачать Excel
                      </button>
                    </div>
                  )}
                </div>

                {estimateSubTab === 'source' && (
                  <EstimateTable
                    items={currentEstimate}
                    collapsedSections={collapsedSections}
                    onToggleSection={toggleSection}
                    onSwitchToDoc={selectedDocName === 'all' ? setSelectedDocName : undefined}
                  />
                )}
                {estimateSubTab === 'materials' && (
                  <AggregateTable items={currentEstimate} type="materials" />
                )}
                {estimateSubTab === 'works' && (
                  <AggregateTable items={currentEstimate} type="works" />
                )}
              </>
            ) : (
              <div className="empty-state">
                <p>ВОР ещё не загружен</p>
                <p className="hint">
                  Нажмите «Импорт из Excel» и загрузите исходный ВОР.
                  Ожидаемые столбцы: A — № п/п, B — КОД, C — Наименование затрат,
                  D — Ед. изм., E — Объём по виду работ, F — Общий расход.
                </p>
              </div>
            )}
          </div>
        )}

        {/* task 398: Вкладка «Расценки снабжения» — стоимость материалов по разделам ВОР */}
        {activeTab === 'supply' && (
          <div className="estimate-section">
            <div className="section-header">
              <h3>Расценки снабжения по материалам ВОР</h3>
            </div>

            {estimateItems.length === 0 ? (
              <div className="empty-state">
                <p>ВОР ещё не загружен</p>
                <p className="hint">
                  Сначала загрузите ВОР на вкладке «ВОР», затем здесь можно будет
                  по каждому разделу загрузить стоимость материалов от снабжения.
                </p>
              </div>
            ) : (
              <>
                <DocTabsTree
                  docNames={docNames}
                  estimateItems={estimateItems}
                  selected={supplySelectedDoc}
                  onSelect={setSupplySelectedDoc}
                />

                <div className="estimate-subtabs">
                  <div className="estimate-subtabs-left">
                    <span className="supply-tab-current">
                      {supplySelectedDoc === 'all'
                        ? 'Объединённый ВОР (все разделы)'
                        : `Раздел: ${supplySelectedDoc}`}
                      {supplyMatchStats && (
                        <span className={`supply-tab-match-hint${supplyMatchStats.matched < supplyMatchStats.total ? ' is-partial' : ''}`}>
                          {' '}— сопоставлено {supplyMatchStats.matched} из {supplyMatchStats.total} расценок
                        </span>
                      )}
                    </span>
                    {supplyMatchStats?.unmatched?.length > 0 && (
                      <details className="supply-unmatched">
                        <summary>не сопоставлено: {supplyMatchStats.unmatched.length}</summary>
                        <ul>
                          {supplyMatchStats.unmatched.slice(0, 30).map((r, i) => (
                            <li key={i} title={r.material_name}>{r.material_name}</li>
                          ))}
                          {supplyMatchStats.unmatched.length > 30 && (
                            <li>…и ещё {supplyMatchStats.unmatched.length - 30}</li>
                          )}
                        </ul>
                      </details>
                    )}
                  </div>
                  <div className="estimate-collapse-controls">
                    {supplySectionKeys.length > 0 && (
                      <>
                        <button
                          className="btn-secondary btn-sm"
                          onClick={() => setSupplyCollapsed(new Set(supplySectionKeys))}
                        >Свернуть всё</button>
                        <button
                          className="btn-secondary btn-sm"
                          onClick={() => setSupplyCollapsed(new Set())}
                        >Развернуть всё</button>
                      </>
                    )}
                    {canEditTenders && supplySelectedDoc !== 'all' && (
                      <>
                        <label
                          className="btn-primary btn-sm estimate-supply-import-btn"
                          title={`Загрузить стоимость материалов из Excel для раздела «${supplySelectedDoc}»`}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="17 8 12 3 7 8" />
                            <line x1="12" y1="3" x2="12" y2="15" />
                          </svg>
                          Загрузить стоимость материалов
                          {supplyTabRatesCount > 0 && (
                            <span className="estimate-supply-badge">{supplyTabRatesCount}</span>
                          )}
                          <input
                            ref={supplyFileRef}
                            type="file"
                            accept=".xlsx,.xls"
                            onChange={handleSupplyRatesFileSelect}
                            style={{ display: 'none' }}
                          />
                        </label>
                        {supplyTabRatesCount > 0 && (
                          <button
                            className="btn-secondary btn-sm"
                            onClick={handleClearSupplyRates}
                            title={`Удалить стоимость материалов для раздела «${supplySelectedDoc}»`}
                          >Очистить</button>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {supplySelectedDoc === 'all' && (
                  <p className="supply-tab-hint">
                    Выберите конкретный раздел слева, чтобы загрузить для него стоимость материалов
                    (Excel: A — наименование, B — ед. изм., C — цена). В объединённом виде показаны итоги по всем разделам.
                  </p>
                )}

                <EstimateTable
                  items={supplyEstimate}
                  collapsedSections={supplyCollapsed}
                  onToggleSection={toggleSupplySection}
                  onSwitchToDoc={supplySelectedDoc === 'all' ? setSupplySelectedDoc : undefined}
                  supplyCosts={supplyCosts}
                  showSupply
                  hideWorkVolume
                />
              </>
            )}
          </div>
        )}

        {/* task 346: Вкладка Сравнение КП */}
        {activeTab === 'proposals' && (
          <TenderProposalsCompare
            tenderId={tenderId}
            estimateItems={estimateItems}
            docNames={docNames}
            tenderCounterparties={tenderCounterparties}
            canEdit={canEditTenders}
            onCountChange={setProposalsCount}
            supplyRatesMap={supplyRatesMap}
          />
        )}

        {/* Вкладка Участники */}
        {activeTab === 'participants' && (
          <div className="participants-section">
            <div className="section-header">
              <h3>Участники тендера</h3>
              <div className="section-actions">
                {canEditTenders && (
                  <button
                    className="btn-primary"
                    onClick={handleOpenAddParticipantModal}
                  >
                    + Пригласить участников
                  </button>
                )}
              </div>
            </div>

            {tenderCounterparties.length === 0 ? (
              <div className="empty-state">
                <p>Участники еще не добавлены</p>
                <p className="hint">Нажмите «Пригласить участников» чтобы добавить контрагентов</p>
              </div>
            ) : (
              <div className="table-container">
                <table className="data-table" style={{ fontSize: '0.8125rem' }}>
                  <thead>
                    <tr>
                      {canEditTenders && <th style={{ width: '26px' }}></th>}
                      <th style={{ width: '40px' }}>№</th>
                      <th style={{ width: '16%', minWidth: '150px' }}>Наименование компании</th>
                      <th>Контакт</th>
                      <th style={{ width: '140px' }}>Телефон</th>
                      <th style={{ width: '190px' }}>Статус</th>
                      <th style={{ width: '280px' }}>КП / Документы</th>
                      {!hideNotes && <th style={{ minWidth: '350px', width: '35%' }}>Примечание</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {tenderCounterparties.map((tc, idx) => {
                      const firstContact = tc.counterparties?.counterparty_contacts?.[0]
                      const isWinner = winnerIds.has(tc.counterparty_id)
                      const winnerScope = winnersList.find(w => w.id === tc.counterparty_id)?.scope || ''
                      return (
                        <tr
                          key={tc.id}
                          className={`${draggedTc?.id === tc.id ? 'tc-dragging' : ''}${tcDragOver?.id === tc.id ? ` tc-drop-${tcDragOver.position}` : ''}`}
                          style={isWinner ? { background: 'rgba(22, 163, 74, 0.08)' } : {}}
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
                            handleReorderParticipant(draggedId, tc.id)
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
                                  setDraggedTc({ id: tc.id })
                                }}
                                onDragEnd={() => { setDraggedTc(null); setTcDragOver(null) }}
                              >⋮⋮</span>
                            </td>
                          )}
                          <td style={{ textAlign: 'center', fontWeight: 600, color: 'var(--text-tertiary)' }}>{idx + 1}</td>
                          <td>
                            <div style={{ fontWeight: 600, wordBreak: 'break-word' }}>
                              {isWinner && <span title="Победитель" style={{ marginRight: '0.25rem' }}>🏆</span>}
                              {tc.counterparties?.name}
                              {isWinner && winnerScope && (
                                <span style={{ marginLeft: '0.375rem', fontSize: '0.75rem', fontWeight: 400, color: 'var(--text-tertiary)' }}>
                                  — {winnerScope}
                                </span>
                              )}
                            </div>
                            {tc.counterparties?.work_type && (
                              <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.125rem' }}>{tc.counterparties.work_type}</div>
                            )}
                          </td>
                          <td>
                            {firstContact ? (
                              <div>
                                <div style={{ fontWeight: 500 }}>{firstContact.full_name}</div>
                                {firstContact.position && <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>{firstContact.position}</div>}
                              </div>
                            ) : <span style={{ color: 'var(--text-tertiary)' }}>—</span>}
                          </td>
                          <td>
                            {firstContact?.phone ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.125rem' }}>
                                {firstContact.phone.split(';').map((ph, i) => (
                                  ph.trim() && <a key={i} href={`tel:${ph.trim()}`} style={{ color: 'var(--primary-color)', textDecoration: 'none', fontSize: '0.8125rem', whiteSpace: 'nowrap' }}>{ph.trim()}</a>
                                ))}
                              </div>
                            ) : <span style={{ color: 'var(--text-tertiary)' }}>—</span>}
                          </td>
                          <td>
                            <select
                              value={tc.status || 'request_sent'}
                              onChange={(e) => handleUpdateParticipantStatus(tc.id, e.target.value)}
                              disabled={!canEditTenders}
                              style={{
                                padding: '0.25rem 0.5rem',
                                borderRadius: '4px',
                                border: '1px solid var(--border-color)',
                                background: 'var(--bg-secondary)',
                                color: getCounterpartyStatusColor(tc.status || 'request_sent'),
                                fontWeight: 600,
                                fontSize: '0.8125rem',
                                cursor: canEditTenders ? 'pointer' : 'default',
                                width: '100%'
                              }}
                            >
                              <option value="request_sent">Запрос отправлен</option>
                              <option value="accepted_for_work">Принято в работу</option>
                              <option value="proposal_provided">КП предоставлено</option>
                              <option value="declined">Отказ</option>
                            </select>
                            {kpUploadedAt[tc.counterparty_id] && (
                              <div
                                title="Когда КП загрузили на сайт"
                                style={{ marginTop: '0.25rem', fontSize: '0.6875rem', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}
                              >
                                КП загружено {formatKpUploadedAt(kpUploadedAt[tc.counterparty_id])}
                              </div>
                            )}
                          </td>
                          <td style={{ verticalAlign: 'top', padding: '0.5rem' }}>
                            <TenderCounterpartyFiles
                              tenderId={tenderId}
                              counterpartyId={tc.counterparty_id}
                              canEdit={canEditTenders}
                            />
                          </td>
                          {!hideNotes && (
                          <td style={{ verticalAlign: 'top', padding: '0.5rem' }}>
                            <textarea
                              value={tc.notes || ''}
                              onChange={(e) => {
                                setTenderCounterparties(prev =>
                                  prev.map(item => item.id === tc.id ? { ...item, notes: e.target.value } : item)
                                )
                                e.target.style.height = 'auto'
                                e.target.style.height = e.target.scrollHeight + 'px'
                              }}
                              onBlur={(e) => handleUpdateParticipantNotes(tc.id, e.target.value)}
                              ref={(el) => {
                                if (el && tc.notes) {
                                  el.style.height = 'auto'
                                  el.style.height = el.scrollHeight + 'px'
                                }
                              }}
                              placeholder="Даты обзвонов, комментарии..."
                              readOnly={!canEditTenders}
                              disabled={!canEditTenders}
                              style={{
                                width: '100%',
                                minHeight: '60px',
                                padding: '0.5rem',
                                fontSize: '0.8125rem',
                                border: '1px solid var(--border-color)',
                                borderRadius: '4px',
                                background: 'var(--bg-secondary)',
                                color: 'var(--text-primary)',
                                resize: 'none',
                                overflow: 'hidden',
                                fontFamily: 'inherit',
                                lineHeight: 1.5,
                                boxSizing: 'border-box',
                              }}
                            />
                          </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Вкладка История */}
        {activeTab === 'history' && (
          <div className="history-section">
            <div className="section-header">
              <h3>История изменений</h3>
            </div>
            {loadingAuditLog ? (
              <div className="empty-state">Загрузка истории...</div>
            ) : auditLogError ? (
              <div className="empty-state">
                <p>Не удалось загрузить историю</p>
                <p className="hint">Ошибка: {auditLogError}</p>
                <p className="hint">Проверьте, что таблица <code>tender_audit_log</code> создана (миграция <code>20260506_tender_audit_log.sql</code>) и доступна для текущего пользователя.</p>
              </div>
            ) : auditLog.length === 0 ? (
              <div className="empty-state">
                <p>Записей пока нет</p>
                <p className="hint">События будут появляться при создании тендера и изменении его данных</p>
              </div>
            ) : (
              <ul className="tender-history-timeline">
                {auditLog.map((event) => {
                  const fieldLabel = event.field_name ? (HISTORY_FIELD_LABELS[event.field_name] || event.field_name) : null
                  const oldStr = formatHistoryValue(event.old_value)
                  const newStr = formatHistoryValue(event.new_value)
                  const author = event.changed_by_name || ROLE_LABEL[event.changed_by_role] || event.changed_by_role || null
                  return (
                    <li key={event.id} className={`history-event history-event-${event.event_type}`}>
                      <div className="history-event-marker" aria-hidden>{renderEventIcon(event.event_type)}</div>
                      <div className="history-event-body">
                        <div className="history-event-title">
                          {event.description || event.event_type}
                        </div>
                        {(event.event_type === 'status_changed' || event.event_type === 'field_updated') && (
                          <div className="history-event-diff">
                            {event.event_type === 'field_updated' && fieldLabel && (
                              <span className="history-field-name">{fieldLabel}: </span>
                            )}
                            <span className="history-old">{oldStr}</span>
                            <span className="history-arrow">→</span>
                            <span className="history-new">{newStr}</span>
                          </div>
                        )}
                        <div className="history-event-meta">
                          <span>{formatDateTime(event.changed_at)}</span>
                          {author && <span> · автор: {author}</span>}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Modal: добавление участников */}
      {showAddParticipantModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '900px', maxHeight: '85vh' }}>
            <div className="modal-header">
              <h3>Выбрать контрагентов для приглашения в тендер</h3>
              <button className="modal-close" onClick={closeAddParticipantModal}>×</button>
            </div>

            <div style={{ padding: '1.5rem' }}>
              {loadingCounterparties ? (
                <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '3rem' }}>
                  Загрузка списка контрагентов...
                </p>
              ) : (
                <>
                  <div style={{ marginBottom: '1rem' }}>
                    <input
                      type="text"
                      placeholder="🔍 Поиск по названию, виду работ, ИНН..."
                      value={participantSearchQuery}
                      onChange={(e) => setParticipantSearchQuery(e.target.value)}
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
                      {uniqueAvailableWorkTypes.length > 0 && (
                        <FilterDropdown
                          label="Вид работ"
                          value={participantWorkTypeFilter}
                          onChange={(v) => setParticipantWorkTypeFilter(v)}
                          options={[
                            { value: '', label: 'Все виды работ' },
                            ...uniqueAvailableWorkTypes.map(wt => ({ value: wt, label: wt })),
                          ]}
                          searchable
                          searchPlaceholder="Поиск вида работ…"
                          allLabel="Все виды работ"
                        />
                      )}
                    </div>
                  </div>

                  {availableCounterparties.length === 0 ? (
                    <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '3rem' }}>
                      Нет активных контрагентов
                    </p>
                  ) : filteredAvailableCounterparties.length === 0 ? (
                    <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '3rem' }}>
                      Контрагенты не найдены по заданным критериям
                    </p>
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
                                  checked={selectableAvailableCounterparties.length > 0 && selectableAvailableCounterparties.every(cp => selectedParticipants.has(cp.id))}
                                  disabled={selectableAvailableCounterparties.length === 0}
                                  onChange={(e) => {
                                    setSelectedParticipants(prev => {
                                      const newSet = new Set(prev)
                                      if (e.target.checked) {
                                        selectableAvailableCounterparties.forEach(cp => newSet.add(cp.id))
                                      } else {
                                        selectableAvailableCounterparties.forEach(cp => newSet.delete(cp.id))
                                      }
                                      return newSet
                                    })
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
                            {filteredAvailableCounterparties.map((cp) => {
                              const isAdded = participantAddedIds.has(cp.id)
                              return (
                              <tr
                                key={cp.id}
                                style={{
                                  cursor: isAdded ? 'default' : 'pointer',
                                  opacity: isAdded ? 0.55 : 1,
                                  backgroundColor: !isAdded && selectedParticipants.has(cp.id) ? 'var(--hover-bg, #f0f9ff)' : ''
                                }}
                                onClick={() => { if (!isAdded) handleToggleParticipant(cp.id) }}
                                onMouseEnter={(e) => {
                                  if (!isAdded && !selectedParticipants.has(cp.id)) {
                                    e.currentTarget.style.backgroundColor = 'var(--hover-bg, #f9fafb)'
                                  }
                                }}
                                onMouseLeave={(e) => {
                                  if (!isAdded && !selectedParticipants.has(cp.id)) {
                                    e.currentTarget.style.backgroundColor = ''
                                  }
                                }}
                              >
                                <td onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    checked={!isAdded && selectedParticipants.has(cp.id)}
                                    disabled={isAdded}
                                    onChange={() => { if (!isAdded) handleToggleParticipant(cp.id) }}
                                    style={{ cursor: isAdded ? 'default' : 'pointer' }}
                                  />
                                </td>
                                <td style={{ fontWeight: 500 }}>
                                  {cp.name}
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
                                  {cp.work_type ? (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                                      {cp.work_type.split(',').map((wt, i) => (
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
                          {selectedParticipants.size > 0 && (
                            <span>Выбрано: <strong>{selectedParticipants.size}</strong></span>
                          )}
                        </div>
                        <button
                          onClick={handleAddParticipants}
                          disabled={selectedParticipants.size === 0}
                          style={{
                            backgroundColor: selectedParticipants.size > 0 ? 'var(--primary-color)' : '#9ca3af',
                            color: 'white',
                            border: 'none',
                            borderRadius: '8px',
                            padding: '0.75rem 2rem',
                            cursor: selectedParticipants.size > 0 ? 'pointer' : 'not-allowed',
                            fontSize: '1rem',
                            fontWeight: '600',
                            transition: 'all 0.2s',
                            boxShadow: selectedParticipants.size > 0 ? '0 4px 6px rgba(0, 0, 0, 0.1)' : 'none'
                          }}
                          onMouseEnter={(e) => {
                            if (selectedParticipants.size > 0) {
                              e.target.style.transform = 'scale(1.05)'
                              e.target.style.boxShadow = '0 6px 8px rgba(0, 0, 0, 0.15)'
                            }
                          }}
                          onMouseLeave={(e) => {
                            e.target.style.transform = 'scale(1)'
                            if (selectedParticipants.size > 0) {
                              e.target.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.1)'
                            }
                          }}
                        >
                          ✓ Пригласить выбранных ({selectedParticipants.size})
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* task 259: модал параметров импорта сметы */}
      {showEstimateModal && (
        <div className="modal-overlay">
          <div className="modal vor-import-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Импорт ВОР</h3>
              <button
                className="modal-close"
                onClick={() => { setShowEstimateModal(false); setPendingWorkbook(null) }}
              >×</button>
            </div>
            <form
              onSubmit={(e) => { e.preventDefault(); handleParseEstimate() }}
              className="vor-import-form"
            >
              {/* task 348: имя ВОРа — обязательное. На один тендер можно
                  загрузить несколько документов (Электрика, ОВ, ВК и т.п.). */}
              <div className="vor-import-field">
                <label>Название документа (системы) <span style={{ color: '#dc2626' }}>*</span></label>
                <input
                  type="text"
                  value={estDocName}
                  onChange={(e) => setEstDocName(e.target.value)}
                  placeholder="Например: Электрика, ОВ, ВК, Слаботочные системы"
                  required
                />
                {docNames.includes((estDocName || '').trim()) && (
                  <small style={{ color: '#dc2626', fontSize: '0.75rem', marginTop: '0.25rem' }}>
                    ⚠ ВОР с таким названием уже есть — будет перезаписан.
                  </small>
                )}
              </div>

              {/* Лист + диапазон строк — в одну линию */}
              <div className="vor-import-row">
                {estSheetNames.length > 1 && (
                  <div className="vor-import-field" style={{ flex: 2 }}>
                    <label>Лист Excel</label>
                    <select
                      value={estSelectedSheet}
                      onChange={(e) => {
                        const name = e.target.value
                        setEstSelectedSheet(name)
                        const autoEnd = detectEstimateEndRow(pendingWorkbook?.Sheets?.[name])
                        setEstEndRow(autoEnd)
                        setEstEndAuto(!!autoEnd)
                      }}
                    >
                      {estSheetNames.map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                )}
                <div className="vor-import-field">
                  <label>Со строки</label>
                  <input
                    type="number" min="1" value={estStartRow}
                    onChange={(e) => setEstStartRow(e.target.value)}
                    placeholder="2"
                  />
                </div>
                <div className="vor-import-field">
                  <label>По строку</label>
                  <input
                    type="number" min="1" value={estEndRow}
                    onChange={(e) => { setEstEndRow(e.target.value); setEstEndAuto(false) }}
                    placeholder="Все"
                  />
                  {estEndAuto && (
                    <small style={{ color: 'var(--primary-color)', fontSize: '0.7rem', marginTop: '0.25rem', display: 'block' }}>
                      авто: до строки «Итого»
                    </small>
                  )}
                </div>
              </div>

              {/* task 345: сопоставление полей со столбцами Excel */}
              <div className="vor-import-section">
                <div className="vor-import-section-head">
                  <span className="vor-import-section-title">Сопоставление столбцов</span>
                  <button
                    type="button"
                    className="vor-import-reset"
                    onClick={resetEstColumnMap}
                    title="Сбросить к A/B/C/D/E/F"
                  >Сбросить</button>
                </div>
                <p className="vor-import-hint">
                  Выберите, из какого столбца Excel брать значение для каждого поля.
                  Если задан общий «Объём» вместо раздельных — тип позиции определяется по
                  коду (Р → работа, иначе материал).
                </p>
                <div className="vor-column-map-grid">
                  {VOR_COLUMN_FIELDS.map(f => (
                    <label key={f.key} className="vor-column-map-row">
                      <span className="vor-column-map-label">{f.label}</span>
                      <select
                        className="vor-column-map-select"
                        value={estColumnMap[f.key] ?? ''}
                        onChange={(e) => updateEstColumnMap(f.key, e.target.value)}
                      >
                        <option value="">— не использовать</option>
                        {Array.from({ length: VOR_COLUMN_CHOICES_COUNT }, (_, idx) => {
                          const letter = XLSX.utils.encode_col(idx)
                          const preview = estColumnPreviews[idx]
                          return (
                            <option key={idx} value={idx}>
                              {letter}{preview ? ` — ${preview}` : ''}
                            </option>
                          )
                        })}
                      </select>
                    </label>
                  ))}
                </div>
              </div>

              <div className="vor-import-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => { setShowEstimateModal(false); setPendingWorkbook(null) }}
                >
                  Отмена
                </button>
                <button type="submit" className="btn-primary">Распознать</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* task 405: конфиг-модалка — выбор листа, диапазона и столбцов перед распознаванием */}
      {supplyConfig && (
        // Клик по подложке НЕ закрывает окно — только крестик/«Отмена»/импорт.
        <div className="modal-overlay">
          <div className="modal supply-import-modal">
            <div className="modal-header">
              <h3>Импорт расценок снабжения — «{supplyConfig.docName}»</h3>
              <button className="modal-close" onClick={() => setSupplyConfig(null)}>×</button>
            </div>
            <div className="supply-import-body">
              <p className="supply-import-file">
                Файл: <strong>{supplyConfig.fileName}</strong> · листов: {supplyConfig.sheetNames.length}
              </p>

              {supplyConfig.sheetNames.length > 1 && (
                <div className="vor-import-field">
                  <label>Лист Excel</label>
                  <select
                    value={supplyConfig.sheetName}
                    onChange={(e) => setSupplyConfig(prev => ({ ...prev, sheetName: e.target.value }))}
                  >
                    {supplyConfig.sheetNames.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              )}

              <div className="vor-import-row">
                <div className="vor-import-field">
                  <label>Со строки</label>
                  <input
                    type="number" min="1" value={supplyConfig.startRow}
                    onChange={(e) => setSupplyConfig(prev => ({ ...prev, startRow: e.target.value }))}
                    placeholder="1"
                  />
                </div>
                <div className="vor-import-field">
                  <label>По строку</label>
                  <input
                    type="number" min="1" value={supplyConfig.endRow}
                    onChange={(e) => setSupplyConfig(prev => ({ ...prev, endRow: e.target.value }))}
                    placeholder="Все"
                  />
                </div>
              </div>

              <div className="vor-import-section">
                <div className="vor-import-section-head">
                  <span className="vor-import-section-title">Сопоставление столбцов</span>
                  <button
                    type="button"
                    className="vor-import-reset"
                    onClick={() => setSupplyConfig(prev => ({ ...prev, columnMap: { ...SUPPLY_COLUMN_DEFAULTS } }))}
                  >Сбросить</button>
                </div>
                <div className="vor-column-map-grid">
                  {SUPPLY_COLUMN_FIELDS.map(f => (
                    <label key={f.key} className="vor-column-map-row">
                      <span className="vor-column-map-label">
                        {f.label} {f.required && <span style={{ color: '#dc2626' }}>*</span>}
                      </span>
                      <select
                        className="vor-column-map-select"
                        value={supplyConfig.columnMap[f.key] ?? ''}
                        onChange={(e) => {
                          const v = e.target.value === '' ? null : Number(e.target.value)
                          setSupplyConfig(prev => ({ ...prev, columnMap: { ...prev.columnMap, [f.key]: v } }))
                        }}
                      >
                        {!f.required && <option value="">— не использовать</option>}
                        {Array.from({ length: SUPPLY_COLUMN_COUNT }, (_, idx) => {
                          const letter = XLSX.utils.encode_col(idx)
                          const prev = supplyColumnPreviews[idx]
                          return (
                            <option key={idx} value={idx}>
                              {letter}{prev ? ` — ${prev}` : ''}
                            </option>
                          )
                        })}
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="supply-import-actions">
              <button className="btn-secondary" onClick={() => setSupplyConfig(null)}>Отмена</button>
              <button className="btn-primary" onClick={buildSupplyImportReport}>Распознать</button>
            </div>
          </div>
        </div>
      )}

      {/* task 398: отчёт по импорту расценок снабжения с разрешением конфликтов */}
      {supplyImportReport && (
        <div className="modal-overlay">
          <div className="modal supply-import-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Расценки снабжения — «{supplyImportReport.docName}»</h3>
              <button className="modal-close" onClick={cancelSupplyImport}>×</button>
            </div>
            <div className="supply-import-body">
              <p className="supply-import-file">
                Файл: <strong>{supplyImportReport.fileName}</strong> · найдено позиций: {supplyImportReport.totalParsed}
              </p>
              <div className="supply-import-stats">
                <div className="supply-stat new">
                  <span className="supply-stat-value">{supplyImportReport.newItems.length}</span>
                  <span className="supply-stat-label">Новых</span>
                </div>
                <div className="supply-stat same">
                  <span className="supply-stat-value">{supplyImportReport.sameItems.length}</span>
                  <span className="supply-stat-label">Без изменений</span>
                </div>
                <div className="supply-stat conflict">
                  <span className="supply-stat-value">{supplyImportReport.conflictItems.length}</span>
                  <span className="supply-stat-label">Требуют решения</span>
                </div>
              </div>

              {supplyImportReport.newItems.length > 0 && (
                <div className="supply-import-section">
                  <h4>Новые расценки ({supplyImportReport.newItems.length})</h4>
                  <p className="supply-import-hint">Будут добавлены автоматически.</p>
                  <div className="supply-new-list">
                    {supplyImportReport.newItems.slice(0, 6).map((it, idx) => (
                      <div key={idx} className="supply-new-row">
                        <span className="supply-new-name" title={it.material_name}>{it.material_name}</span>
                        <span className="supply-new-price">{fmtMoney(it.supply_price)}</span>
                      </div>
                    ))}
                    {supplyImportReport.newItems.length > 6 && (
                      <div className="supply-more">…и ещё {supplyImportReport.newItems.length - 6}</div>
                    )}
                  </div>
                </div>
              )}

              {supplyImportReport.conflictItems.length > 0 && (
                <div className="supply-import-section">
                  <h4>Изменение цены ({supplyImportReport.conflictItems.length})</h4>
                  <div className="supply-conflict-bulk">
                    <button className="btn-secondary btn-sm" onClick={() => supplyDecideAll('update')}>
                      Обновить все
                    </button>
                    <button className="btn-secondary btn-sm" onClick={() => supplyDecideAll('keep')}>
                      Оставить все
                    </button>
                  </div>
                  <div className="supply-conflict-list">
                    <div className="supply-conflict-row supply-conflict-head">
                      <span className="sc-name">Наименование</span>
                      <span className="sc-old">Текущая</span>
                      <span className="sc-new">Новая</span>
                      <span className="sc-diff">Разница</span>
                      <span className="sc-act">Действие</span>
                    </div>
                    {supplyImportReport.conflictItems.map((it, idx) => (
                      <div key={idx} className={`supply-conflict-row ${supplyConflictDecisions[idx]}`}>
                        <span className="sc-name" title={it.material_name}>{it.material_name}</span>
                        <span className="sc-old">{fmtMoney(it.existingPrice)}</span>
                        <span className="sc-new">{fmtMoney(it.newPrice)}</span>
                        <span className={`sc-diff ${it.difference > 0 ? 'up' : 'down'}`}>
                          {it.difference > 0 ? '+' : ''}{fmtMoney(it.difference)}
                          <small> ({it.percentDiff > 0 ? '+' : ''}{it.percentDiff.toFixed(1)}%)</small>
                        </span>
                        <span className="sc-act">
                          <label className={supplyConflictDecisions[idx] === 'keep' ? 'selected' : ''}>
                            <input
                              type="radio"
                              name={`sc-${idx}`}
                              checked={supplyConflictDecisions[idx] === 'keep'}
                              onChange={() => setSupplyDecision(idx, 'keep')}
                            />Оставить
                          </label>
                          <label className={supplyConflictDecisions[idx] === 'update' ? 'selected' : ''}>
                            <input
                              type="radio"
                              name={`sc-${idx}`}
                              checked={supplyConflictDecisions[idx] === 'update'}
                              onChange={() => setSupplyDecision(idx, 'update')}
                            />Обновить
                          </label>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="supply-import-actions">
              <button className="btn-secondary" onClick={cancelSupplyImport} disabled={supplyImporting}>
                Отмена
              </button>
              <button className="btn-primary" onClick={handleConfirmSupplyImport} disabled={supplyImporting}>
                {supplyImporting ? 'Применение…' : 'Применить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* task 396: документы «ВОРы и РД» */}
      {vorDocsModalOpen && (
        <VorDocsModal
          tenderId={tenderId}
          onClose={() => setVorDocsModalOpen(false)}
          onChange={refreshVorDocCount}
        />
      )}

      {/* task 397: документы «Тендерный пакет» */}
      {packageDocsModalOpen && (
        <VorDocsModal
          tenderId={tenderId}
          title="Документы тендерного пакета"
          category="tender_package"
          onClose={() => setPackageDocsModalOpen(false)}
          onChange={refreshPackageDocCount}
        />
      )}
    </div>
  )
}

export default TenderDetailPage
