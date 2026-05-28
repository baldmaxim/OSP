import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import TenderCounterpartyFiles from '../components/TenderCounterpartyFiles'
import '../components/TenderDetail.css'

// task 261: числа выводим с округлением до сотых
const fmtNum = (v) => (v === null || v === undefined || v === '')
  ? '—'
  : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(v)

// task 260: КОД «Р»/«Р-» → работы, «мат.»/иное → материалы (как в Анализ КП/БСМ)
const isWorkItem = (it) => {
  const c = (it.code || '').trim().toUpperCase()
  return c.startsWith('Р')
}

const sectionKey = (it, idx) => (it.id != null ? `id:${it.id}` : `idx:${idx}`)

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

// task 260/262: смета с многоуровневой группировкой/сворачиванием (как в Excel)
function EstimateTable({ items, collapsedSections, onToggleSection }) {
  const lvlOf = makeLevelOf(items)
  const collapseStack = [] // активные свёрнутые заголовки: их уровни
  const rendered = []
  // task 347: иерархическая нумерация — работы 1, 2, 3…; материалы под ними
  // 1.1, 1.2, 1.3… Разделы/подразделы не считаются. Счётчики инкрементятся
  // в порядке обхода (для всех элементов, видимых или скрытых под свёрнутой
  // секцией) — чтобы нумерация была стабильна при сворачивании.
  let workCount = 0
  let matCount = 0
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx]
    const L = lvlOf(it)
    while (collapseStack.length && L <= collapseStack[collapseStack.length - 1]) collapseStack.pop()
    const hidden = collapseStack.length > 0
    const next = items[idx + 1]
    const isHeader = !!next && lvlOf(next) > L
    const key = sectionKey(it, idx)
    const collapsed = collapsedSections.has(key)
    const isSectionLike = it.is_section || isHeader

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
            <td colSpan={5} style={indent}>{it.cost_name}</td>
          </tr>
        )
      } else {
        rendered.push(
          <tr key={it.id || idx}>
            <td className="estimate-num">{displayNum}</td>
            <td>{it.code || '—'}</td>
            <td style={indent}>{it.cost_name}</td>
            <td>{it.unit || '—'}</td>
            <td className="estimate-num-cell">{fmtNum(it.work_volume)}</td>
            <td className="estimate-num-cell">{fmtNum(it.material_consumption)}</td>
          </tr>
        )
      }
    }
    if (isHeader && collapsed && !hidden) collapseStack.push(L)
  }
  return (
    <div className="table-container">
      <table className="data-table estimate-table">
        <thead>
          <tr>
            <th style={{ width: '64px' }}>№</th>
            <th style={{ width: '110px' }}>КОД</th>
            <th>Наименование затрат</th>
            <th style={{ width: '90px' }}>Ед. изм.</th>
            <th style={{ width: '130px' }}>Объём работ</th>
            <th style={{ width: '130px' }}>Объём материалов</th>
          </tr>
        </thead>
        <tbody>{rendered}</tbody>
      </table>
    </div>
  )
}

// task 260: подвкладки «Материалы»/«Работы» — суммирование объёмов по наименованию
function AggregateTable({ items, type }) {
  const map = new Map()
  for (const it of items) {
    if (it.is_section) continue
    const work = isWorkItem(it)
    if (type === 'works' && !work) continue
    if (type === 'materials' && work) continue
    const name = (it.cost_name || '').trim()
    if (!name) continue
    const unit = (it.unit || '').trim()
    const key = `${name.toLowerCase()}∣${unit.toLowerCase()}`
    const vol = type === 'works' ? it.work_volume : it.material_consumption
    const cur = map.get(key) || { name, unit, total: 0, count: 0 }
    cur.total += Number(vol) || 0
    cur.count += 1
    map.set(key, cur)
  }
  const rows = [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  const grandTotal = rows.reduce((s, r) => s + r.total, 0)
  const grandCount = rows.reduce((s, r) => s + r.count, 0)
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
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="estimate-total-row">
            <td colSpan={3}>Итого{type === 'works' ? ' по работам' : ' по материалам'}</td>
            <td className="estimate-num">{grandCount}</td>
            <td className="estimate-num-cell">{fmtNum(grandTotal)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function TenderDetailPage() {
  const { tenderId } = useParams()
  const navigate = useNavigate()
  const { userProfile, canEdit } = useRole()
  // task 333: гейт add/edit/delete для раздела «tenders»
  const canEditTenders = canEdit('tenders')

  const [tender, setTender] = useState(null)
  const [tenderCounterparties, setTenderCounterparties] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('estimate') // 'estimate' | 'participants' | 'history'

  // task 259: смета тендера (импорт из Excel → проверка → сохранение)
  const [estimateItems, setEstimateItems] = useState([])
  const estimateFileRef = useRef(null)
  const [pendingWorkbook, setPendingWorkbook] = useState(null)
  const [estSheetNames, setEstSheetNames] = useState([])
  const [estSelectedSheet, setEstSelectedSheet] = useState('')
  const [estStartRow, setEstStartRow] = useState('2')
  const [estEndRow, setEstEndRow] = useState('')
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

  // Состояния для добавления участников
  const [showAddParticipantModal, setShowAddParticipantModal] = useState(false)
  const [availableCounterparties, setAvailableCounterparties] = useState([])
  const [selectedParticipants, setSelectedParticipants] = useState(new Set())
  const [loadingCounterparties, setLoadingCounterparties] = useState(false)
  const [participantSearchQuery, setParticipantSearchQuery] = useState('')
  const [participantWorkTypeFilter, setParticipantWorkTypeFilter] = useState('')
  const [participantDepartmentFilter, setParticipantDepartmentFilter] = useState('')

  // История изменений тендера
  const [auditLog, setAuditLog] = useState([])
  const [loadingAuditLog, setLoadingAuditLog] = useState(false)
  const [auditLogError, setAuditLogError] = useState(null)

  // Примечание тендера (inline-редактирование)
  const [notesDraft, setNotesDraft] = useState('')
  const [notesSaving, setNotesSaving] = useState(false)
  const [notesSavedAt, setNotesSavedAt] = useState(null)

  useEffect(() => {
    if (tenderId) {
      fetchTenderData()
      loadAuditLog()
      fetchEstimateItems()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenderId])

  // task 259: загрузка сохранённой сметы тендера
  const fetchEstimateItems = async () => {
    try {
      const { data, error } = await supabase
        .from('tender_estimate_items')
        .select('*')
        .eq('tender_id', tenderId)
        .order('row_number', { ascending: true })
      if (error) throw error
      setEstimateItems(data || [])
    } catch (err) {
      console.error('Ошибка загрузки сметы:', err.message)
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
      setEstEndRow('')
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
        if (!name) continue

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
      let { error: insErr } = await supabase
        .from('tender_estimate_items')
        .insert(payload)
      // Подстраховка: миграция outline_level ещё не применена — сохраняем без него
      if (insErr && /outline_level/i.test(insErr.message || '')) {
        const stripped = payload.map(({ outline_level, ...rest }) => rest) // eslint-disable-line no-unused-vars
        const retry = await supabase.from('tender_estimate_items').insert(stripped)
        insErr = retry.error
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
    if (selectedDocName === 'all') return estimateItems
    return estimateItems.filter(it => (it.estimate_name || 'Основная смета') === selectedDocName)
  }, [parsedEstimate, estimateItems, selectedDocName])

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

      if (cpError) throw cpError
      setTenderCounterparties(counterpartiesData || [])
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
      const { data, error } = await supabase
        .from('tender_audit_log')
        .select('*')
        .eq('tender_id', tenderId)
        .order('changed_at', { ascending: false })
      if (error) throw error
      setAuditLog(data || [])
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
    const oldValue = tender.notes || ''
    const newValue = notesDraft || ''
    if (oldValue === newValue) return
    try {
      setNotesSaving(true)
      const { error } = await supabase
        .from('tenders')
        .update({ notes: newValue || null })
        .eq('id', tender.id)
      if (error) throw error

      const role = localStorage.getItem('userRole') || null
      await supabase.from('tender_audit_log').insert([{
        tender_id: tender.id,
        event_type: 'field_updated',
        field_name: 'notes',
        old_value: oldValue || null,
        new_value: newValue || null,
        description: 'Изменено: Примечание',
        changed_by_role: role,
        changed_by_name: userProfile?.full_name || null
      }])

      setTender(prev => prev ? { ...prev, notes: newValue } : prev)
      setNotesSavedAt(Date.now())
      loadAuditLog()
    } catch (err) {
      console.error('Ошибка сохранения примечания:', err.message)
      alert('Ошибка сохранения примечания: ' + err.message)
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
    notes: 'Примечание'
  }

  const formatHistoryValue = (val) => {
    if (val === null || val === undefined) return '—'
    if (typeof val === 'string' || typeof val === 'number') return String(val)
    if (typeof val === 'object') {
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

  const filteredAvailableCounterparties = useMemo(() => availableCounterparties.filter(cp => {
    if (participantWorkTypeFilter) {
      const types = (cp.work_type || '').split(',').map(wt => wt.trim())
      if (!types.includes(participantWorkTypeFilter)) return false
    }
    if (participantDepartmentFilter) {
      const depts = (cp.department || '').split(',').map(d => d.trim())
      if (!depts.includes(participantDepartmentFilter)) return false
    }
    if (!participantSearchQuery.trim()) return true
    const query = participantSearchQuery.toLowerCase().trim()
    return (
      (cp.name && cp.name.toLowerCase().includes(query)) ||
      (cp.inn && cp.inn.toLowerCase().includes(query)) ||
      (cp.work_type && cp.work_type.toLowerCase().includes(query))
    )
  }), [availableCounterparties, participantWorkTypeFilter, participantDepartmentFilter, participantSearchQuery])

  const closeAddParticipantModal = () => {
    setShowAddParticipantModal(false)
    setParticipantSearchQuery('')
    setParticipantWorkTypeFilter('')
    setParticipantDepartmentFilter('')
  }

  const handleOpenAddParticipantModal = async () => {
    setShowAddParticipantModal(true)
    setSelectedParticipants(new Set())
    setParticipantSearchQuery('')
    setParticipantWorkTypeFilter('')
    setParticipantDepartmentFilter('')
    setLoadingCounterparties(true)

    try {
      const { data, error } = await supabase
        .from('counterparties')
        .select('id, name, work_type, inn, department')
        .eq('status', 'active')
        .order('name')

      if (error) throw error

      const existingIds = tenderCounterparties.map(tc => tc.counterparty_id)
      const available = (data || []).filter(c => !existingIds.includes(c.id))

      setAvailableCounterparties(available)
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
      const participantsToAdd = Array.from(selectedParticipants).map(counterpartyId => ({
        tender_id: tenderId,
        counterparty_id: counterpartyId,
        status: 'request_sent'
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

  const handleUpdateParticipantStatus = async (tenderCounterpartyId, newStatus) => {
    try {
      const { error } = await supabase
        .from('tender_counterparties')
        .update({ status: newStatus })
        .eq('id', tenderCounterpartyId)

      if (error) throw error

      setTenderCounterparties(prev =>
        prev.map(tc =>
          tc.id === tenderCounterpartyId
            ? { ...tc, status: newStatus }
            : tc
        )
      )
    } catch (error) {
      console.error('Ошибка обновления статуса:', error)
      alert('Ошибка обновления статуса: ' + error.message)
    }
  }

  const handleUpdateParticipantNotes = async (tenderCounterpartyId, notes) => {
    try {
      const { error } = await supabase
        .from('tender_counterparties')
        .update({ notes })
        .eq('id', tenderCounterpartyId)

      if (error) throw error

      setTenderCounterparties(prev =>
        prev.map(tc =>
          tc.id === tenderCounterpartyId ? { ...tc, notes } : tc
        )
      )
    } catch (error) {
      console.error('Ошибка сохранения примечания:', error)
    }
  }

  if (loading) {
    return <div className="loading">Загрузка...</div>
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
          <h2>{tender.objects?.name || 'Тендер'}</h2>
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
          {tender.tender_package_link && (
            <div className="info-item">
              <span className="info-label">Тендерный пакет</span>
              <a href={tender.tender_package_link} target="_blank" rel="noopener noreferrer" className="info-link">
                Открыть документ
              </a>
            </div>
          )}
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
        <button
          className={`tender-tab ${activeTab === 'participants' ? 'active' : ''}`}
          onClick={() => setActiveTab('participants')}
        >
          Участники
          {tenderCounterparties.length > 0 && <span className="tab-count">{tenderCounterparties.length}</span>}
        </button>
        <button
          className={`tender-tab ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => setActiveTab('history')}
        >
          История
          {auditLog.length > 0 && <span className="tab-count">{auditLog.length}</span>}
        </button>
      </div>

      {/* Контент вкладок */}
      <div className="tender-tab-content">
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
                {!parsedEstimate && docNames.length > 0 && (
                  <div className="estimate-doc-tabs" role="tablist" aria-label="Документы ВОР">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={selectedDocName === 'all'}
                      className={`estimate-doc-tab ${selectedDocName === 'all' ? 'active' : ''}`}
                      onClick={() => setSelectedDocName('all')}
                      title="Объединённый ВОР — все документы вместе"
                    >
                      <span className="estimate-doc-tab-label">Объединённый ВОР</span>
                      <span className="estimate-doc-tab-count">{estimateItems.length}</span>
                    </button>
                    <span className="estimate-doc-tabs-sep" aria-hidden />
                    {docNames.map(name => {
                      const count = estimateItems.filter(it =>
                        (it.estimate_name || 'Основная смета') === name
                      ).length
                      return (
                        <button
                          key={name}
                          type="button"
                          role="tab"
                          aria-selected={selectedDocName === name}
                          className={`estimate-doc-tab ${selectedDocName === name ? 'active' : ''}`}
                          onClick={() => setSelectedDocName(name)}
                          title={`Открыть ВОР «${name}»`}
                        >
                          <span className="estimate-doc-tab-label">{name}</span>
                          <span className="estimate-doc-tab-count">{count}</span>
                        </button>
                      )
                    })}
                  </div>
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
                  {estimateSubTab === 'source' && estimateSectionKeys.length > 0 && (
                    <div className="estimate-collapse-controls">
                      <button className="btn-secondary btn-sm" onClick={collapseAllSections}>
                        Свернуть всё
                      </button>
                      <button className="btn-secondary btn-sm" onClick={expandAllSections}>
                        Развернуть всё
                      </button>
                    </div>
                  )}
                </div>

                {estimateSubTab === 'source' && (
                  <EstimateTable
                    items={currentEstimate}
                    collapsedSections={collapsedSections}
                    onToggleSection={toggleSection}
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
                      <th style={{ width: '40px' }}>№</th>
                      <th>Наименование контрагента</th>
                      <th>Контакт</th>
                      <th style={{ width: '140px' }}>Телефон</th>
                      <th style={{ width: '190px' }}>Статус</th>
                      <th style={{ width: '280px' }}>КП / Документы</th>
                      <th style={{ minWidth: '350px', width: '35%' }}>Примечание</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tenderCounterparties.map((tc, idx) => {
                      const firstContact = tc.counterparties?.counterparty_contacts?.[0]
                      const isWinner = winnerIds.has(tc.counterparty_id)
                      const winnerScope = winnersList.find(w => w.id === tc.counterparty_id)?.scope || ''
                      return (
                        <tr key={tc.id} style={isWinner ? { background: 'rgba(22, 163, 74, 0.08)' } : {}}>
                          <td style={{ textAlign: 'center', fontWeight: 600, color: 'var(--text-tertiary)' }}>{idx + 1}</td>
                          <td>
                            <div style={{ fontWeight: 600 }}>
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
                          </td>
                          <td style={{ verticalAlign: 'top', padding: '0.5rem' }}>
                            <TenderCounterpartyFiles
                              tenderId={tenderId}
                              counterpartyId={tc.counterparty_id}
                              canEdit={canEditTenders}
                            />
                          </td>
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
                      <select
                        value={participantDepartmentFilter}
                        onChange={(e) => setParticipantDepartmentFilter(e.target.value)}
                        style={{
                          padding: '0.375rem 0.75rem',
                          fontSize: '0.8125rem',
                          border: '1px solid var(--border-color)',
                          borderRadius: '4px',
                          background: 'var(--bg-secondary)',
                          color: 'var(--text-primary)',
                          cursor: 'pointer',
                        }}
                      >
                        <option value="">Все категории</option>
                        <option value="Основное строительство">Основное строительство</option>
                        <option value="Гарантийный отдел">Гарантийный отдел</option>
                      </select>

                      {uniqueAvailableWorkTypes.length > 0 && (
                        <select
                          value={participantWorkTypeFilter}
                          onChange={(e) => setParticipantWorkTypeFilter(e.target.value)}
                          style={{
                            padding: '0.375rem 0.75rem',
                            fontSize: '0.8125rem',
                            border: '1px solid var(--border-color)',
                            borderRadius: '4px',
                            background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)',
                            cursor: 'pointer',
                          }}
                        >
                          <option value="">Все виды работ</option>
                          {uniqueAvailableWorkTypes.map(workType => (
                            <option key={workType} value={workType}>{workType}</option>
                          ))}
                        </select>
                      )}

                      {(participantDepartmentFilter || participantWorkTypeFilter) && (
                        <button
                          onClick={() => { setParticipantDepartmentFilter(''); setParticipantWorkTypeFilter('') }}
                          style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '0.8125rem' }}
                        >Сбросить</button>
                      )}
                    </div>
                  </div>

                  {availableCounterparties.length === 0 ? (
                    <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '3rem' }}>
                      Все активные контрагенты уже добавлены в тендер
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
                                  checked={filteredAvailableCounterparties.length > 0 && filteredAvailableCounterparties.every(cp => selectedParticipants.has(cp.id))}
                                  onChange={(e) => {
                                    setSelectedParticipants(prev => {
                                      const newSet = new Set(prev)
                                      if (e.target.checked) {
                                        filteredAvailableCounterparties.forEach(cp => newSet.add(cp.id))
                                      } else {
                                        filteredAvailableCounterparties.forEach(cp => newSet.delete(cp.id))
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
                                padding: '0.75rem',
                                width: '80px',
                                textAlign: 'center'
                              }}>Категория</th>
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
                            {filteredAvailableCounterparties.map((cp) => (
                              <tr
                                key={cp.id}
                                style={{
                                  cursor: 'pointer',
                                  backgroundColor: selectedParticipants.has(cp.id) ? 'var(--hover-bg, #f0f9ff)' : ''
                                }}
                                onClick={() => handleToggleParticipant(cp.id)}
                                onMouseEnter={(e) => {
                                  if (!selectedParticipants.has(cp.id)) {
                                    e.currentTarget.style.backgroundColor = 'var(--hover-bg, #f9fafb)'
                                  }
                                }}
                                onMouseLeave={(e) => {
                                  if (!selectedParticipants.has(cp.id)) {
                                    e.currentTarget.style.backgroundColor = ''
                                  }
                                }}
                              >
                                <td onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    checked={selectedParticipants.has(cp.id)}
                                    onChange={() => handleToggleParticipant(cp.id)}
                                    style={{ cursor: 'pointer' }}
                                  />
                                </td>
                                <td style={{ fontWeight: 500 }}>{cp.name}</td>
                                <td style={{ textAlign: 'center' }}>
                                  {cp.department ? (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', alignItems: 'center' }}>
                                      {cp.department.split(',').map((d, i) => {
                                        const dept = d.trim()
                                        const isCon = dept === 'Основное строительство'
                                        return (
                                          <span key={i} style={{
                                            padding: '0.1rem 0.35rem',
                                            fontSize: '0.6875rem',
                                            fontWeight: 700,
                                            borderRadius: '3px',
                                            background: isCon ? 'rgba(37,99,235,0.12)' : 'rgba(234,88,12,0.12)',
                                            color: isCon ? '#2563eb' : '#ea580c',
                                            border: `1px solid ${isCon ? 'rgba(37,99,235,0.25)' : 'rgba(234,88,12,0.25)'}`,
                                          }}>{isCon ? 'ОС' : 'ГО'}</span>
                                        )
                                      })}
                                    </div>
                                  ) : '-'}
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
                            ))}
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
                      onChange={(e) => setEstSelectedSheet(e.target.value)}
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
                    onChange={(e) => setEstEndRow(e.target.value)}
                    placeholder="Все"
                  />
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
    </div>
  )
}

export default TenderDetailPage
