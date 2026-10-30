import React, { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react'
import { db } from '../api'
import TenderProposalUploadModal from './TenderProposalUploadModal'
import VirtualTableBody from './VirtualTableBody'
import { normalizeKey, normalizeUnit } from '../utils/parseProposalExcel'
import { supplyUnitPrice, supplyTotal } from '../utils/supplyRateHelpers'
import { fetchAllRowsParallel } from '../utils/fetchAllRows'
import './TenderProposalsCompare.css'

// task 410: порог включения виртуализации <tbody> в детальной таблице сравнения.
const VIRTUALIZE_FROM = 150

// Общая пустая карта для значений по умолчанию: `new Map()` в параметрах давал бы
// новую ссылку на каждый рендер и сбивал memo().
const EMPTY_MAP = new Map()

// Только колонки, которые реально нужны сравнению. `*` тянул ещё примечания
// участника и служебные поля, а встроенный join counterparties(id, name)
// повторял название контрагента в каждой из десятков тысяч строк.
const BASE_COLUMNS = 'id, counterparty_id, estimate_item_id, unit_price_materials, unit_price_works, total_materials, total_works, total_cost, proposal_date, created_at'
// Пометка «учтено в другой позиции» (task 401) — колонки миграции 20260606, а её нет ни в одной базе портала
// (ни в Supabase, ни в базе Яндекса): выборка с ними отвечала 42703, и с 11.09 «Сравнение КП» было пустым у всех
// тендеров. Колонок нет — КП читаются без них, пометки «учтено» нет. Ответ базы запоминается на всю вкладку.
const COVERAGE_COLUMNS = 'covered_elsewhere, coverage_note'
let coverageColumns = null // null — ещё не спрашивали, true — есть, false — нет
const proposalColumns = () => (coverageColumns === false ? BASE_COLUMNS : `${BASE_COLUMNS}, ${COVERAGE_COLUMNS}`)
const isCoverageMissing = (err) => ['42703', 'PGRST204'].includes(String(err?.code || ''))
  && /covered_elsewhere|coverage_note/.test(String(err?.message || ''))

// Все КП тендера одним запросом — функция tender_compare_proposals (миграция 20261123): ответ — одно значение json,
// потолок PostgREST в 1000 строк его не касается. Страницами у крупного тендера выходило 20+ запросов через шлюз, и
// каждый заново отбирал и сортировал все КП тендера. Строка ответа — массив полей в этом порядке (как в функции);
// пометка «учтено» — только если её колонки есть в базе (coverage). Нет функции (база не обновлена) — страницами,
// как раньше; ответ «функции нет» запоминается на всю вкладку.
const ROW_FIELDS = ['id', 'counterparty_id', 'estimate_item_id', 'unit_price_materials', 'unit_price_works',
  'total_materials', 'total_works', 'total_cost', 'proposal_date', 'created_at', 'covered_elsewhere', 'coverage_note']
let compareRpc = null // null — ещё не спрашивали, false — функции нет
const isRpcMissing = (err) => ['PGRST202', '42883'].includes(String(err?.code || ''))

async function fetchProposalsRpc(tenderId) {
  if (compareRpc === false) return null
  // GET: функция только читает — шлюз пропускает её и в режиме «только чтение».
  const { data, error } = await db.rpc('tender_compare_proposals', { p_tender: tenderId }, { get: true })
  if (error) {
    if (isRpcMissing(error)) compareRpc = false
    else console.warn('КП одним запросом не загрузились, читаем страницами:', error.message)
    return null
  }
  if (!Array.isArray(data?.rows)) {
    compareRpc = false
    return null
  }
  compareRpc = true
  const coverage = data.coverage === true
  const n = coverage ? ROW_FIELDS.length : ROW_FIELDS.length - 2
  const rows = new Array(data.rows.length)
  for (let i = 0; i < rows.length; i++) {
    const src = data.rows[i]
    const row = {}
    for (let f = 0; f < n; f++) row[ROW_FIELDS[f]] = src[f]
    rows[i] = row
  }
  return { rows, coverage }
}

// Прежний путь: страницами по 1000 строк, по 8 одновременно (у крупного тендера страниц 20+, каждая — запрос
// через шлюз; больше одновременных — меньше ожидания по кругу).
const fetchProposalsPaged = (tenderId) => fetchAllRowsParallel((from, to, withCount) => db
  .from('tender_counterparty_proposals')
  .select(proposalColumns(), withCount ? { count: 'exact' } : undefined)
  .eq('tender_id', tenderId)
  .order('id', { ascending: true })
  .range(from, to), { concurrency: 8 })

// Загруженные КП по тендеру живут между переключениями вкладок: вкладка
// размонтируется при уходе, и раньше каждый возврат заново качал все КП.
// При возврате данные показываются сразу, а свежие подтягиваются в фоне.
const proposalsCache = new Map() // tenderId → { rows, names: Map<cpId, name> }

// task 346 + 349: вкладка «Сравнение КП» в тендере.
// Структура:
//   1) Tree-tabs: «Объединённый КП» + дочерние по ВОРам (как во вкладке ВОР).
//   2) Расширенные summary-карточки: Материалы / Работы / Итого по каждому КП.
//   3) Sub-tabs: «Исходный КП» / «Материалы» / «Работы».

// Форматтер создаётся один раз: конструктор Intl.NumberFormat дорогой (~0,4 мс), а
// fmtMoney зовётся на каждую денежную ячейку — на открытии вкладки это давало секунды.
const MONEY_FMT = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 })
const fmtMoney = (n) => {
  if (n == null || n === '' || isNaN(n)) return ''
  return MONEY_FMT.format(n)
}

const fmtDate = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ru-RU')
}

// task 432/КП: момент фактической загрузки КП на сайт (created_at строк предложения).
// Отличается от proposal_date — та вводится вручную в модалке («КП от …»).
const fmtDateTime = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ru-RU') + ', ' +
    d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

// Подпись «загружено дд.мм.гггг, чч:мм» под названием контрагента в шапке колонки.
const UploadedAt = ({ at, className }) => (
  at ? <div className={className} title="Когда КП загрузили на сайт">загружено {fmtDateTime(at)}</div> : null
)

// «Р»/«р-…» → работа, иначе материал.
const isWorkRow = (it) => {
  const c = String(it.code || '').trim().toLowerCase()
  return c === 'р' || c.startsWith('р-') || c.startsWith('р ') || c.startsWith('раб')
}

function TenderProposalsCompare({
  tenderId,
  estimateItems,
  docNames,
  tenderCounterparties,
  canEdit,
  onCountChange,
  // task 408: карта расценок снабжения (supplyKey → цена/ед) из TenderDetailPage.
  // Используется только для отображения колонки «Цена от снабжения»; в расчёты
  // КП подрядчиков, выбор минимума/победителя и итоги НЕ входит.
  supplyRatesMap = new Map(),
}) {
  const cached = tenderId ? proposalsCache.get(tenderId) : null
  const [proposals, setProposalsState] = useState(() => cached?.rows || [])
  const [cpNames, setCpNames] = useState(() => cached?.names || new Map())
  const [loading, setLoading] = useState(() => !cached)
  // selectedDoc = 'all' для объединённого вида, либо конкретное имя ВОРа.
  const [selectedDoc, setSelectedDoc] = useState('all')
  const [subTab, setSubTab] = useState('source') // 'source' | 'materials' | 'works'
  const [showUploadModal, setShowUploadModal] = useState(false)
  const [coverageOn, setCoverageOn] = useState(coverageColumns !== false)

  // Если активный ВОР пропал — переключаемся на 'all'.
  useEffect(() => {
    if (selectedDoc === 'all') return
    if (!docNames.includes(selectedDoc)) setSelectedDoc('all')
  }, [docNames, selectedDoc])

  // Обновление списка КП вместе с кэшем вкладки.
  const setProposals = useCallback((updater) => {
    setProposalsState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      const entry = proposalsCache.get(tenderId)
      proposalsCache.set(tenderId, { rows: next, names: entry?.names || new Map() })
      return next
    })
  }, [tenderId])

  // Названия контрагентов: сначала из участников тендера (уже загружены
  // страницей), недостающие — одним запросом.
  // Через ref: смена списка участников (например, статуса) не должна
  // перезапускать загрузку всех КП тендера.
  const tenderCounterpartiesRef = useRef(tenderCounterparties)
  tenderCounterpartiesRef.current = tenderCounterparties
  const resolveNames = useCallback(async (rows) => {
    const names = new Map()
    for (const tc of tenderCounterpartiesRef.current || []) {
      if (tc.counterparty_id && tc.counterparties?.name) names.set(tc.counterparty_id, tc.counterparties.name)
    }
    const missing = [...new Set(rows.map((p) => p.counterparty_id))].filter((id) => id && !names.has(id))
    for (let i = 0; i < missing.length; i += 100) {
      const { data, error } = await db.from('counterparties').select('id, name').in('id', missing.slice(i, i + 100))
      if (error) throw error
      for (const cp of data || []) names.set(cp.id, cp.name)
    }
    return names
  }, [])

  const loadProposals = useCallback(async ({ silent = false } = {}) => {
    if (!tenderId) return
    if (!silent) setLoading(true)
    try {
      let all
      const viaRpc = await fetchProposalsRpc(tenderId)
      if (viaRpc) {
        all = viaRpc.rows
        coverageColumns = viaRpc.coverage
        setCoverageOn(viaRpc.coverage)
      } else {
        // task 399: пагинация — Supabase отдаёт максимум 1000 строк за запрос.
        // Страницы идут параллельно, тай-брейк по id — однозначный порядок страниц.
        try {
          all = await fetchProposalsPaged(tenderId)
          if (coverageColumns === null) coverageColumns = true
        } catch (err) {
          if (coverageColumns === false || !isCoverageMissing(err)) throw err
          coverageColumns = false
          setCoverageOn(false)
          all = await fetchProposalsPaged(tenderId)
        }
      }
      const names = await resolveNames(all)
      proposalsCache.set(tenderId, { rows: all, names })
      setCpNames(names)
      setProposalsState(all)
    } catch (err) {
      console.error('Ошибка загрузки КП:', err.message)
      if (!silent) setProposalsState([])
    } finally {
      if (!silent) setLoading(false)
    }
  }, [tenderId, resolveNames])

  // При возврате на вкладку кэш показывается сразу, свежие данные — в фоне.
  const hadCacheOnMount = useRef(!!cached)
  useEffect(() => { loadProposals({ silent: hadCacheOnMount.current }) }, [loadProposals])

  // Точечно подмешиваем изменённые строки КП вместо перезагрузки всех КП тендера.
  const mergeProposalRows = useCallback((changed = [], removedIds = []) => {
    if (!changed.length && !removedIds.length) return
    const removed = new Set(removedIds)
    const byKey = new Map(changed.map((r) => [`${r.estimate_item_id}__${r.counterparty_id}`, r]))
    setProposals((prev) => {
      const next = []
      for (const p of prev) {
        if (removed.has(p.id)) continue
        const key = `${p.estimate_item_id}__${p.counterparty_id}`
        if (byKey.has(key)) {
          next.push(byKey.get(key))
          byKey.delete(key)
        } else {
          next.push(p)
        }
      }
      for (const r of byKey.values()) next.push(r)
      return next
    })
  }, [setProposals])

  // Уникальные контрагенты с КП — общее число для счётчика на табе.
  const proposalsCount = useMemo(() => {
    const set = new Set(proposals.map(p => p.counterparty_id))
    return set.size
  }, [proposals])
  useEffect(() => { onCountChange?.(proposalsCount) }, [proposalsCount, onCountChange])

  // Позиции выбранного scope (без секций). 'all' = все ВОРы.
  const itemsOfScope = useMemo(() => estimateItems.filter(it => {
    if (it.is_section) return false
    if (selectedDoc === 'all') return true
    return (it.estimate_name || 'Основная смета') === selectedDoc
  }), [estimateItems, selectedDoc])

  const itemIds = useMemo(() => new Set(itemsOfScope.map(it => it.id)), [itemsOfScope])

  // Контрагенты в текущем scope.
  const counterpartiesInScope = useMemo(() => {
    const map = new Map() // cp_id → { id, name, latestDate, uploadedAt }
    for (const p of proposals) {
      if (!itemIds.has(p.estimate_item_id)) continue
      const cur = map.get(p.counterparty_id)
      const date = p.proposal_date || null
      // Дата загрузки на сайт — самая свежая created_at среди строк этого КП.
      const uploaded = p.created_at || null
      if (!cur) {
        map.set(p.counterparty_id, {
          id: p.counterparty_id,
          name: cpNames.get(p.counterparty_id) || p.counterparty_id,
          latestDate: date,
          uploadedAt: uploaded,
        })
      } else {
        if (date && (!cur.latestDate || date > cur.latestDate)) cur.latestDate = date
        if (uploaded && (!cur.uploadedAt || uploaded > cur.uploadedAt)) cur.uploadedAt = uploaded
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  }, [proposals, itemIds, cpNames])

  // КП по позиции: estimate_item_id → Map(counterparty_id → строка КП), все ВОРы. Строка таблицы берёт карту своей
  // позиции один раз, а расчёты ниже идут по КП, которые есть, а не по «позиция × подрядчик»: раньше на каждую клетку
  // склеивался ключ «позиция__подрядчик» — на 12 тыс. позиций × 10 подрядчиков это 120 тыс. строк-ключей в каждом
  // расчёте. Подрядчики карты позиции из scope — всегда в counterpartiesInScope.
  const proposalsByItem = useMemo(() => {
    const m = new Map()
    for (const p of proposals) {
      let row = m.get(p.estimate_item_id)
      if (!row) {
        row = new Map()
        m.set(p.estimate_item_id, row)
      }
      row.set(p.counterparty_id, p)
    }
    return m
  }, [proposals])

  // Итоги по контрагенту + разбивка по ВОРам + покрытие позиций (task 355).
  // matTotal/matCovered — сколько позиций МАТЕРИАЛОВ (с material_consumption > 0)
  //   и сколько из них реально расценено (unit_price_materials > 0).
  // Если matCovered < matTotal — есть «дыры», итог нерепрезентативный → подсветка.
  // Аналогично работы. Сколько позиций требует расценки — одинаково у всех подрядчиков:
  // считается один раз по ВОРам и раздаётся каждому (и там, где его КП нет).
  const totalsByCp = useMemo(() => {
    const m = new Map()
    for (const cp of counterpartiesInScope) {
      m.set(cp.id, {
        totalMat: 0, totalWork: 0, totalCost: 0, byDoc: new Map(),
        matCoveredAll: 0, matTotalAll: 0, workCoveredAll: 0, workTotalAll: 0,
      })
    }
    const docTotals = new Map() // ВОР → { matTotal, workTotal }
    let matTotalAll = 0, workTotalAll = 0
    for (const it of itemsOfScope) {
      const docName = it.estimate_name || 'Основная смета'
      let dt = docTotals.get(docName)
      if (!dt) {
        dt = { matTotal: 0, workTotal: 0 }
        docTotals.set(docName, dt)
      }
      // task 403: покрытие считаем на уровне строки по фактически
      // проставленному объёму (а НЕ по КОДу). Раньше (task 399) объём брался
      // строго из поля, выбранного по isWorkRow: если КОД и заполненный
      // столбец объёма расходились (КОД «материал», а объём в work_volume,
      // или наоборот), позиция не попадала ни в matTotal, ни в workTotal —
      // и молча выпадала из подсчёта непокрытых, хотя стоимость показывалась.
      // Теперь бакет определяется наличием объёма, а «расценено» — по total_cost
      // (любая ненулевая стоимость, в какой бы столбец цена ни попала) или
      // ручной пометке «учтено». Это убирает и ложный пропуск (403), и старый
      // ложный оранжевый (399, цена «не в той» колонке → total_cost > 0).
      const hasMatVol = Number(it.material_consumption) > 0
      const hasWorkVol = Number(it.work_volume) > 0
      if (hasMatVol) { dt.matTotal++; matTotalAll++ }
      if (hasWorkVol) { dt.workTotal++; workTotalAll++ }

      const row = proposalsByItem.get(it.id)
      if (!row) continue
      for (const [cpId, p] of row) {
        const t = m.get(cpId)
        if (!t) continue
        let cur = t.byDoc.get(docName)
        if (!cur) {
          cur = { mat: 0, work: 0, matTotal: 0, matCovered: 0, workTotal: 0, workCovered: 0 }
          t.byDoc.set(docName, cur)
        }
        const m_ = Number(p.total_materials) || 0
        const w_ = Number(p.total_works) || 0
        const c_ = Number(p.total_cost) || 0
        t.totalMat += m_; t.totalWork += w_; t.totalCost += c_
        cur.mat += m_
        cur.work += w_
        // task 401 + 403: расценена, если есть ненулевая стоимость или пометка
        // «учтено в другой позиции».
        const rated = c_ > 0 || !!p.covered_elsewhere
        if (hasMatVol && rated) { cur.matCovered++; t.matCoveredAll++ }
        if (hasWorkVol && rated) { cur.workCovered++; t.workCoveredAll++ }
      }
    }
    for (const t of m.values()) {
      t.matTotalAll = matTotalAll
      t.workTotalAll = workTotalAll
      for (const [docName, dt] of docTotals) {
        let cur = t.byDoc.get(docName)
        if (!cur) {
          cur = { mat: 0, work: 0, matTotal: 0, matCovered: 0, workTotal: 0, workCovered: 0 }
          t.byDoc.set(docName, cur)
        }
        cur.matTotal = dt.matTotal
        cur.workTotal = dt.workTotal
      }
    }
    return m
  }, [counterpartiesInScope, itemsOfScope, proposalsByItem])

  // Минимум по сравниваемой метрике (для подсветки).
  const minTotalCost = useMemo(() => {
    let min = Infinity
    for (const cp of counterpartiesInScope) {
      const t = totalsByCp.get(cp.id)?.totalCost || 0
      if (t > 0 && t < min) min = t
    }
    return min === Infinity ? 0 : min
  }, [counterpartiesInScope, totalsByCp])

  // Минимум по строке (для подсветки в исходном виде).
  const minByItem = useMemo(() => {
    const m = new Map()
    for (const it of itemsOfScope) {
      const row = proposalsByItem.get(it.id)
      if (!row) continue
      let min = Infinity
      for (const p of row.values()) {
        const v = Number(p.total_cost) || 0
        if (v > 0 && v < min) min = v
      }
      if (min !== Infinity) m.set(it.id, min)
    }
    return m
  }, [itemsOfScope, proposalsByItem])

  // task 409: итоги по материалам от снабжения по каждому ВОРу (для верхней сводной
  // таблицы). Σ(объём × цена за ед. снабжения) по материалам документа; missing —
  // есть ли материалы с объёмом, но без цены снабжения (для жёлтой подсветки).
  const supplyByDoc = useMemo(() => {
    const byDoc = new Map() // docName → { total, missing }
    const hasData = supplyRatesMap.size > 0
    for (const it of estimateItems) {
      if (it.is_section || isWorkRow(it)) continue
      const doc = it.estimate_name || 'Основная смета'
      let cur = byDoc.get(doc)
      if (!cur) { cur = { total: 0, missing: false }; byDoc.set(doc, cur) }
      const price = supplyUnitPrice(supplyRatesMap, it.estimate_name, it.cost_name)
      const cost = supplyTotal(price, it.material_consumption)
      if (cost != null) cur.total += cost
      if (hasData && price == null && Number(it.material_consumption) > 0) cur.missing = true
    }
    return byDoc
  }, [estimateItems, supplyRatesMap])

  // Агрегация для «Материалы» / «Работы» — по name+unit внутри каждого ВОРа.
  // В режиме «Объединённый КП» группируем по estimate_name + считаем подытоги.
  // В режиме конкретного ВОРа — одна группа без явного заголовка.
  // task 350: на «Объединённом» хочется видеть Σ по каждому ВОРу + общий ИТОГО.
  // Строка: позиции с объёмом (itemsTotal, volItemIds) — общие для всех подрядчиков; cpData — только у подрядчиков с
  // КП в строке (нет записи — у подрядчика в строке ничего, а позиции с объёмом всё равно требуют расценки).
  const aggregatedGroups = useMemo(() => {
    if (subTab === 'source') return []
    const wantWork = subTab === 'works'
    // groupKey (estimate_name) → { name, rowsMap: Map<key, row>, subtotalByCp: Map<cpId, number>,
    //   itemsTotal, coveredByCp: Map<cpId, number> }
    const groups = new Map()
    for (const it of itemsOfScope) {
      const isWork = isWorkRow(it)
      if (wantWork && !isWork) continue
      if (!wantWork && isWork) continue
      // task 403: объём с fallback на «другое» поле — если объём проставлен не в
      // том столбце, что подразумевает КОД, позиция всё равно учитывается
      // (иначе vol=0 → выпадает из счётчиков покрытия, хотя стоимость есть).
      const vol = isWork
        ? (Number(it.work_volume) || 0) || (Number(it.material_consumption) || 0)
        : (Number(it.material_consumption) || 0) || (Number(it.work_volume) || 0)
      const props = proposalsByItem.get(it.id)
      if (vol <= 0 && !props) continue

      const groupName = it.estimate_name || 'Основная смета'
      let group = groups.get(groupName)
      if (!group) {
        group = { name: groupName, rowsMap: new Map(), subtotalByCp: new Map(), itemsTotal: 0, coveredByCp: new Map() }
        groups.set(groupName, group)
      }

      const name = (it.cost_name || '').trim()
      const unit = (it.unit || '').trim()
      const rowKey = `${normalizeKey(name)}|${normalizeUnit(unit)}`
      let row = group.rowsMap.get(rowKey)
      if (!row) {
        // task 355: счётчики покрытия строки. task 401 (вкладки Материалы/Работы): позиции, которые можно пометить
        // «учтено» из агрегированной ячейки, — volItemIds (у подрядчика — из его byItem, см. AggregateCoverControl).
        row = { name, unit, totalVol: 0, itemsTotal: 0, volItemIds: [], cpData: new Map() }
        group.rowsMap.set(rowKey, row)
      }
      row.totalVol += vol
      // Учитываем только позиции с положительным объёмом — иначе они не
      // требуют расценки и не должны подсвечиваться как «дыра».
      if (vol > 0) {
        row.itemsTotal += 1
        row.volItemIds.push(it.id)
        group.itemsTotal += 1
      }
      if (!props) continue

      for (const [cpId, p] of props) {
        let cur = row.cpData.get(cpId)
        if (!cur) {
          cur = { totalCost: 0, weightedPriceSum: 0, weightedVolSum: 0, itemsCovered: 0, byItem: new Map() }
          row.cpData.set(cpId, cur)
        }
        const price = isWork ? (Number(p.unit_price_works) || 0) : (Number(p.unit_price_materials) || 0)
        const cost = isWork ? (Number(p.total_works) || 0) : (Number(p.total_materials) || 0)
        cur.totalCost += cost
        cur.weightedPriceSum += price * vol
        cur.weightedVolSum += vol
        if (vol > 0) {
          cur.byItem.set(it.id, p)
          // task 401 + 403: расценена по факту ненулевой стоимости (в какой бы
          // столбец цена ни попала) или ручной пометке «учтено».
          if ((Number(p.total_cost) || 0) > 0 || p.covered_elsewhere) {
            cur.itemsCovered += 1
            group.coveredByCp.set(cpId, (group.coveredByCp.get(cpId) || 0) + 1)
          }
        }

        // Подытог по ВОРу
        group.subtotalByCp.set(cpId, (group.subtotalByCp.get(cpId) || 0) + cost)
      }
    }

    // Сортируем группы по имени ВОРа, строки внутри — по наименованию.
    const out = []
    const sortedGroupNames = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'ru'))
    for (const gName of sortedGroupNames) {
      const g = groups.get(gName)
      const rows = [...g.rowsMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'))
      out.push({ name: g.name, rows, subtotalByCp: g.subtotalByCp, itemsTotal: g.itemsTotal, coveredByCp: g.coveredByCp })
    }
    return out
  }, [itemsOfScope, proposalsByItem, subTab])

  // Удалить все КП контрагента в scope.
  const handleClearCpProposals = async (cpId, cpName) => {
    const where = selectedDoc === 'all' ? 'для всего тендера' : `для ВОРа «${selectedDoc}»`
    if (!window.confirm(`Удалить КП контрагента «${cpName}» ${where}?`)) return
    try {
      if (selectedDoc === 'all') {
        // Весь тендер: удаляем по tender_id, без огромного IN-списка
        // estimate_item_id (иначе URL переполняется → «Failed to fetch»).
        const { error } = await db
          .from('tender_counterparty_proposals')
          .delete()
          .eq('tender_id', tenderId)
          .eq('counterparty_id', cpId)
        if (error) throw error
      } else {
        // Конкретный ВОР: ограничиваем позициями этого ВОРа, но режем IN на
        // чанки — длинный список UUID в URL роняет запрос (task 402).
        const ids = itemsOfScope.map(it => it.id)
        if (ids.length === 0) return
        const CHUNK_DEL = 100
        for (let i = 0; i < ids.length; i += CHUNK_DEL) {
          const chunk = ids.slice(i, i + CHUNK_DEL)
          const { error } = await db
            .from('tender_counterparty_proposals')
            .delete()
            .eq('counterparty_id', cpId)
            .in('estimate_item_id', chunk)
          if (error) throw error
        }
      }

      const { data: remaining } = await db
        .from('tender_counterparty_proposals')
        .select('id')
        .eq('tender_id', tenderId)
        .eq('counterparty_id', cpId)
        .limit(1)
      if (!remaining || remaining.length === 0) {
        await db
          .from('tender_counterparties')
          .update({ status: 'request_sent' })
          .eq('tender_id', tenderId)
          .eq('counterparty_id', cpId)
      }
      await loadProposals()
    } catch (err) {
      alert('Ошибка удаления: ' + err.message)
    }
  }

  // task 401: пометка позиции «учтено в другой позиции» (без отдельной цены).
  // Нерасценённая позиция может вообще не иметь строки в proposals — поэтому
  // ставим флаг через upsert по UNIQUE(estimate_item_id, counterparty_id).
  // После записи в список подмешиваются только изменённые строки — раньше каждый
  // клик «учтено» перекачивал все КП тендера (десятки тысяч строк).
  const handleToggleCovered = useCallback(async (itemId, cpId, checked, note) => {
    try {
      if (checked) {
        const { data, error } = await db
          .from('tender_counterparty_proposals')
          .upsert({
            tender_id: tenderId,
            counterparty_id: cpId,
            estimate_item_id: itemId,
            covered_elsewhere: true,
            coverage_note: note || null,
          }, { onConflict: 'estimate_item_id,counterparty_id' })
          .select(proposalColumns())
        if (error) throw error
        mergeProposalRows(data || [])
      } else {
        // Снятие флага: если строка была создана только ради пометки (без цен) —
        // удаляем её, иначе просто сбрасываем флаг, чтобы не плодить «нулевые» КП.
        const p = proposalsByItem.get(itemId)?.get(cpId)
        const isFlagOnly = p && !(Number(p.total_cost) > 0) &&
          !(Number(p.unit_price_materials) > 0) && !(Number(p.unit_price_works) > 0)
        if (isFlagOnly) {
          const { error } = await db
            .from('tender_counterparty_proposals').delete().eq('id', p.id)
          if (error) throw error
          mergeProposalRows([], [p.id])
        } else if (p) {
          const { data, error } = await db
            .from('tender_counterparty_proposals')
            .update({ covered_elsewhere: false, coverage_note: null })
            .eq('id', p.id)
            .select(proposalColumns())
          if (error) throw error
          mergeProposalRows(data || [])
        }
      }
    } catch (err) {
      alert('Ошибка: ' + err.message)
      loadProposals({ silent: true })
    }
  }, [tenderId, proposalsByItem, mergeProposalRows, loadProposals])

  // task 401 (вкладки Материалы/Работы): пакетная пометка «учтено» для всех
  // нерасценённых позиций агрегированной строки у одного контрагента.
  // coverItems — [{itemId, proposalId, hasPrice, covered, note}].
  const handleToggleCoveredBatch = useCallback(async (cpId, coverItems, checked, note) => {
    try {
      if (checked) {
        // Помечаем только позиции без цены, которые ещё не помечены; при смене
        // примечания обновляем его и у уже помеченных.
        const toFlag = coverItems.filter(c => !c.hasPrice && (!c.covered || (c.note || '') !== (note || '')))
        if (toFlag.length > 0) {
          const { data, error } = await db
            .from('tender_counterparty_proposals')
            .upsert(
              toFlag.map(c => ({
                tender_id: tenderId,
                counterparty_id: cpId,
                estimate_item_id: c.itemId,
                covered_elsewhere: true,
                coverage_note: note || null,
              })),
              { onConflict: 'estimate_item_id,counterparty_id' }
            )
            .select(proposalColumns())
          if (error) throw error
          mergeProposalRows(data || [])
        }
      } else {
        // Снятие: flag-only строки (без цен) удаляем, у остальных сбрасываем флаг.
        const covered = coverItems.filter(c => c.covered)
        const flagOnlyIds = []
        const pricedIds = []
        for (const c of covered) {
          if (c.proposalId == null) continue
          ;(c.hasPrice ? pricedIds : flagOnlyIds).push(c.proposalId)
        }
        // Порции по 100 id — длинный IN-список в URL роняет запрос (task 402).
        for (let i = 0; i < flagOnlyIds.length; i += 100) {
          const chunk = flagOnlyIds.slice(i, i + 100)
          const { error } = await db
            .from('tender_counterparty_proposals').delete().in('id', chunk)
          if (error) throw error
          mergeProposalRows([], chunk)
        }
        for (let i = 0; i < pricedIds.length; i += 100) {
          const { data, error } = await db
            .from('tender_counterparty_proposals')
            .update({ covered_elsewhere: false, coverage_note: null })
            .in('id', pricedIds.slice(i, i + 100))
            .select(proposalColumns())
          if (error) throw error
          mergeProposalRows(data || [])
        }
      }
    } catch (err) {
      alert('Ошибка: ' + err.message)
      loadProposals({ silent: true })
    }
  }, [tenderId, mergeProposalRows, loadProposals])

  // Счётчики для tabs (контрагенты с КП в этом ВОРе).
  // Раньше — O(docs × proposals × items) из-за вложенного .find() на каждый proposal:
  // на крупных тендерах давало заметный фриз при открытии вкладки. Теперь один
  // проход: item.id → estimate_name (Map), затем один проход по proposals.
  const cpCountByDoc = useMemo(() => {
    const docByItemId = new Map(
      estimateItems.map(i => [i.id, i.estimate_name || 'Основная смета'])
    )
    const sets = new Map(docNames.map(n => [n, new Set()]))
    for (const p of proposals) {
      const doc = docByItemId.get(p.estimate_item_id)
      const set = doc != null ? sets.get(doc) : undefined
      if (set) set.add(p.counterparty_id)
    }
    const out = new Map()
    for (const [name, set] of sets) out.set(name, set.size)
    return out
  }, [docNames, estimateItems, proposals])

  if (docNames.length === 0) {
    return (
      <div className="proposals-empty">
        <p>В тендере нет ни одного ВОРа.</p>
        <p className="hint">Сначала загрузите ВОР во вкладке «ВОР», затем сравнивайте КП.</p>
      </div>
    )
  }

  return (
    <div className="proposals-section">
      {/* Toolbar */}
      <div className="proposals-toolbar">
        <h3 className="proposals-title">Сравнение КП</h3>
        {canEdit && (
          <button className="btn-primary" onClick={() => setShowUploadModal(true)}>
            + Загрузить КП
          </button>
        )}
      </div>

      {/* Tree-tabs: Объединённый + дочерние ВОРы (как во вкладке ВОР) */}
      <div className="proposals-doc-tree">
        <button
          type="button"
          className={`proposals-doc-tab proposals-doc-tab-parent ${selectedDoc === 'all' ? 'active' : ''}`}
          onClick={() => setSelectedDoc('all')}
        >
          <span className="proposals-doc-tab-parent-icon" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7h18" /><path d="M3 12h18" /><path d="M3 17h18" />
            </svg>
          </span>
          <span className="proposals-doc-tab-label">Объединённый КП</span>
          <span className="proposals-doc-tab-count">{proposalsCount}</span>
          <span className="proposals-doc-tab-parent-hint">
            по {docNames.length}{' '}
            {docNames.length === 1 ? 'ВОРу' : docNames.length < 5 ? 'ВОРам' : 'ВОРам'}
          </span>
        </button>
        <div className="proposals-doc-tabs-children">
          {docNames.map((name, i) => {
            const isLast = i === docNames.length - 1
            return (
              <button
                key={name}
                type="button"
                className={`proposals-doc-tab proposals-doc-tab-child ${selectedDoc === name ? 'active' : ''} ${isLast ? 'is-last' : ''}`}
                onClick={() => setSelectedDoc(name)}
              >
                <span className="proposals-doc-tab-branch" aria-hidden />
                <span className="proposals-doc-tab-label">{name}</span>
                <span className="proposals-doc-tab-count">{cpCountByDoc.get(name) || 0}</span>
              </button>
            )
          })}
        </div>
      </div>

      {loading ? (
        <div className="proposals-empty"><p>Загрузка…</p></div>
      ) : itemsOfScope.length === 0 ? (
        <div className="proposals-empty"><p>В выбранном ВОРе нет позиций.</p></div>
      ) : counterpartiesInScope.length === 0 ? (
        <div className="proposals-empty">
          <p>Для выбранного {selectedDoc === 'all' ? 'тендера' : 'ВОРа'} ещё не загружено ни одного КП.</p>
          {canEdit && (
            <p className="hint">Нажмите «+ Загрузить КП», чтобы добавить первое предложение.</p>
          )}
        </div>
      ) : (
        <>
          {/* task 354: сводная сопоставительная матрица «ВОР × контрагенты».
              Строки — ВОРы, колонки — каждый контрагент (Мат / Раб / Итого).
              Если контрагент не давал КП по ВОРу — клетка пустая (—). */}
          <SummaryMatrixTable
            docNames={docNames}
            selectedDoc={selectedDoc}
            counterpartiesInScope={counterpartiesInScope}
            totalsByCp={totalsByCp}
            canEdit={canEdit}
            onClearCp={handleClearCpProposals}
            supplyByDoc={supplyByDoc}
          />

          {/* Sub-tabs */}
          <div className="proposals-subtabs">
            <button
              className={`proposals-subtab ${subTab === 'source' ? 'active' : ''}`}
              onClick={() => setSubTab('source')}
            >Исходный КП</button>
            <button
              className={`proposals-subtab ${subTab === 'materials' ? 'active' : ''}`}
              onClick={() => setSubTab('materials')}
            >Материалы</button>
            <button
              className={`proposals-subtab ${subTab === 'works' ? 'active' : ''}`}
              onClick={() => setSubTab('works')}
            >Работы</button>
          </div>

          {subTab === 'source' && (
            <SourceTable
              itemsOfScope={itemsOfScope}
              counterpartiesInScope={counterpartiesInScope}
              proposalsByItem={proposalsByItem}
              minByItem={minByItem}
              totalsByCp={totalsByCp}
              minTotalCost={minTotalCost}
              showDocColumn={selectedDoc === 'all'}
              canEdit={canEdit && coverageOn}
              onToggleCovered={handleToggleCovered}
              supplyRatesMap={supplyRatesMap}
            />
          )}
          {(subTab === 'materials' || subTab === 'works') && (
            <AggregateView
              kind={subTab}
              groups={aggregatedGroups}
              counterpartiesInScope={counterpartiesInScope}
              totalsByCp={totalsByCp}
              showGroupHeaders={selectedDoc === 'all'}
              canEdit={canEdit && coverageOn}
              onToggleCovered={handleToggleCoveredBatch}
              supplyRatesMap={supplyRatesMap}
            />
          )}
        </>
      )}

      {showUploadModal && (
        <TenderProposalUploadModal
          tenderId={tenderId}
          tenderCounterparties={tenderCounterparties}
          estimateItems={estimateItems}
          docNames={docNames}
          onClose={() => setShowUploadModal(false)}
          onSaved={() => { setShowUploadModal(false); loadProposals() }}
        />
      )}
    </div>
  )
}

// ===== Подкомпонент: сводная матрица «ВОР × контрагенты» (task 354) =====
// Строки — ВОРы текущего scope. Колонки — каждый контрагент с 3 sub-cells
// (Материалы / Работы / Итого). Если КП по ВОРу не подавалось — клетка «—».
// Минимальный «Итого» по строке ВОРа подсвечен зелёным. В footer — Σ по
// контрагенту с подсветкой минимального общего предложения.
function SummaryMatrixTable({
  docNames, selectedDoc, counterpartiesInScope, totalsByCp, canEdit, onClearCp,
  supplyByDoc = new Map(),
}) {
  // ВОРы для строк: в режиме «Объединённый» — все, иначе только выбранный.
  const docsToShow = useMemo(
    () => (selectedDoc === 'all' ? docNames : [selectedDoc]),
    [selectedDoc, docNames]
  )
  // task 409: итог снабжения по материалам в текущем scope (сумма показанных ВОРов).
  const supplyGrand = docsToShow.reduce((s, d) => s + (supplyByDoc.get(d)?.total || 0), 0)

  // Минимальный totalCost по тендеру — для подсветки итоговой строки.
  const minTotalCost = useMemo(() => {
    let min = Infinity
    for (const cp of counterpartiesInScope) {
      const v = totalsByCp.get(cp.id)?.totalCost || 0
      if (v > 0 && v < min) min = v
    }
    return min === Infinity ? 0 : min
  }, [counterpartiesInScope, totalsByCp])

  // Минимум по строке ВОРа — для подсветки лучшего контрагента в ВОР'е.
  const minByDoc = useMemo(() => {
    const m = new Map()
    for (const docName of docsToShow) {
      let min = Infinity
      for (const cp of counterpartiesInScope) {
        const v = totalsByCp.get(cp.id)?.byDoc.get(docName)
        const total = (v?.mat || 0) + (v?.work || 0)
        if (total > 0 && total < min) min = total
      }
      if (min !== Infinity) m.set(docName, min)
    }
    return m
  }, [docsToShow, counterpartiesInScope, totalsByCp])

  if (counterpartiesInScope.length === 0) return null

  return (
    <div className="proposals-summary-matrix-wrap">
      <table className="proposals-summary-matrix-table">
        <thead>
          <tr>
            <th rowSpan={2} className="psmt-th-doc">ВОР</th>
            <th rowSpan={2} className="psmt-th-cp psmt-th-supply" title="Итог по материалам от снабжения (объём × цена за ед.). Не КП подрядчика.">Снабжение<br />материалы, ₽</th>
            {counterpartiesInScope.map(cp => (
              <th key={cp.id} colSpan={3} className="psmt-th-cp">
                <div className="psmt-th-cp-name" title={cp.name}>{cp.name}</div>
                {cp.latestDate && <div className="psmt-th-cp-date">КП от {fmtDate(cp.latestDate)}</div>}
                <UploadedAt at={cp.uploadedAt} className="psmt-th-cp-uploaded" />
                {canEdit && (
                  <button
                    type="button"
                    className="psmt-th-cp-remove"
                    onClick={() => onClearCp(cp.id, cp.name)}
                    title={`Удалить КП «${cp.name}» в текущем scope`}
                    aria-label="Удалить"
                  >×</button>
                )}
              </th>
            ))}
          </tr>
          <tr>
            {counterpartiesInScope.map(cp => (
              <React.Fragment key={cp.id}>
                <th className="psmt-th-sub">Материалы, ₽</th>
                <th className="psmt-th-sub">Работы, ₽</th>
                <th className="psmt-th-sub psmt-th-sub-total">Итого, ₽</th>
              </React.Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {docsToShow.map(docName => {
            const minDoc = minByDoc.get(docName)
            return (
              <tr key={docName}>
                <td className="psmt-td-doc" title={docName}>{docName}</td>
                {(() => {
                  const sd = supplyByDoc.get(docName)
                  const sTotal = sd?.total || 0
                  return (
                    <td className={`psmt-td-num psmt-td-supply${sd?.missing ? ' supply-price-missing' : ''}`}>
                      {sTotal > 0 ? fmtMoney(sTotal) : '—'}
                    </td>
                  )
                })()}
                {counterpartiesInScope.map(cp => {
                  const v = totalsByCp.get(cp.id)?.byDoc.get(docName)
                  const mat = v?.mat || 0
                  const work = v?.work || 0
                  const total = mat + work
                  const isMin = total > 0 && minDoc != null && total === minDoc
                  // task 355: подсветка неполного покрытия по этому ВОРу.
                  const hasPart = (v?.mat || v?.work || 0) > 0
                  const matIncomplete = hasPart && v && v.matTotal > 0 && v.matCovered < v.matTotal
                  const workIncomplete = hasPart && v && v.workTotal > 0 && v.workCovered < v.workTotal
                  const matTip = matIncomplete ? `Расценено ${v.matCovered} из ${v.matTotal} позиций материалов` : null
                  const workTip = workIncomplete ? `Расценено ${v.workCovered} из ${v.workTotal} позиций работ` : null
                  return (
                    <React.Fragment key={cp.id}>
                      <td
                        className={`psmt-td-num psmt-td-mat${matIncomplete ? ' is-incomplete' : ''}`}
                        title={matTip || undefined}
                      >
                        {mat > 0 ? fmtMoney(mat) : '—'}
                      </td>
                      <td
                        className={`psmt-td-num${workIncomplete ? ' is-incomplete' : ''}`}
                        title={workTip || undefined}
                      >
                        {work > 0 ? fmtMoney(work) : '—'}
                      </td>
                      <td
                        className={`psmt-td-num psmt-td-total${isMin ? ' is-min' : ''}${(matIncomplete || workIncomplete) ? ' is-incomplete' : ''}`}
                        title={
                          (matIncomplete || workIncomplete)
                            ? `Итог нерепрезентативный: ${[matTip, workTip].filter(Boolean).join('; ')}`
                            : undefined
                        }
                      >
                        {total > 0 ? fmtMoney(total) : '—'}
                      </td>
                    </React.Fragment>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="psmt-tf-row">
            <td className="psmt-tf-label">ИТОГО, ₽</td>
            <td className="psmt-tf-num psmt-td-supply">{supplyGrand > 0 ? fmtMoney(supplyGrand) : '—'}</td>
            {counterpartiesInScope.map(cp => {
              const t = totalsByCp.get(cp.id) || {
                totalMat: 0, totalWork: 0, totalCost: 0,
                matCoveredAll: 0, matTotalAll: 0, workCoveredAll: 0, workTotalAll: 0,
              }
              const isMin = t.totalCost > 0 && t.totalCost === minTotalCost
              // task 355: общий итог подсвечен если хоть где-то материалы/работы недорасценены.
              const matIncomplete = t.matTotalAll > 0 && t.matCoveredAll < t.matTotalAll
              const workIncomplete = t.workTotalAll > 0 && t.workCoveredAll < t.workTotalAll
              const matTip = matIncomplete
                ? `Расценено ${t.matCoveredAll} из ${t.matTotalAll} позиций материалов по всем ВОРам`
                : null
              const workTip = workIncomplete
                ? `Расценено ${t.workCoveredAll} из ${t.workTotalAll} позиций работ по всем ВОРам`
                : null
              return (
                <React.Fragment key={cp.id}>
                  <td
                    className={`psmt-tf-num psmt-td-mat${matIncomplete ? ' is-incomplete' : ''}`}
                    title={matTip || undefined}
                  >
                    {fmtMoney(t.totalMat)}
                  </td>
                  <td
                    className={`psmt-tf-num${workIncomplete ? ' is-incomplete' : ''}`}
                    title={workTip || undefined}
                  >
                    {fmtMoney(t.totalWork)}
                  </td>
                  <td
                    className={`psmt-tf-num psmt-tf-total${isMin ? ' is-min' : ''}${(matIncomplete || workIncomplete) ? ' is-incomplete' : ''}`}
                    title={
                      (matIncomplete || workIncomplete)
                        ? `Итог нерепрезентативный: ${[matTip, workTip].filter(Boolean).join('; ')}`
                        : undefined
                    }
                  >
                    {fmtMoney(t.totalCost)}
                  </td>
                </React.Fragment>
              )
            })}
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// ===== Ячейка «Итого» в «Исходном КП» с пометкой «учтено в др. позиции» (task 401) =====
// Если позиция нерасценена этим контрагентом (есть объём, но нет цены),
// сотрудник может пометить её «учтено» со свободным примечанием — оранжевый
// в сводке/агрегате уходит, стоимость остаётся «—». Подрядчики видят пометку
// только для чтения.
function SourceTotalCell({ it, cp, p, isMin, canEdit, onToggleCovered }) {
  // task 403: «требует расценки» — если есть любой объём (в любом столбце);
  // «расценена» — по факту ненулевой стоимости (в какой бы столбец цена ни
  // попала) или ручной пометке «учтено». Раньше брались строго по КОДу
  // (isWorkRow) поле объёма и поле цены — позиция с объёмом «не в том» столбце
  // давала vol=0 → не подсвечивалась, хотя стоимость показывалась.
  const requiresRate = (Number(it.work_volume) || 0) > 0 || (Number(it.material_consumption) || 0) > 0
  const total = p ? Number(p.total_cost) || 0 : 0
  const covered = !!p?.covered_elsewhere
  const rated = !!p && (total > 0 || covered)
  const uncovered = requiresRate && !rated

  const [note, setNote] = useState(p?.coverage_note || '')
  useEffect(() => { setNote(p?.coverage_note || '') }, [p?.coverage_note])

  // Позиция расценена (ненулевая стоимость) — обычное отображение.
  if (total > 0) {
    return <td className={`td-price td-total${isMin ? ' is-min' : ''}`}>{fmtMoney(total)}</td>
  }

  // Не требует расценки (нет объёма) и не помечена — как раньше.
  if (!uncovered && !covered) {
    return <td className="td-price td-total">{p ? fmtMoney(total) : '—'}</td>
  }

  if (!canEdit) {
    return (
      <td className={`td-price td-total${covered ? ' is-covered-elsewhere' : ''}`}>
        {covered
          ? <span className="covered-badge" title={p?.coverage_note || ''}>учтено</span>
          : '—'}
      </td>
    )
  }

  const saveNote = () => {
    if ((p?.coverage_note || '') !== note) onToggleCovered(it.id, cp.id, true, note)
  }

  return (
    <td className={`td-price td-total td-covered-cell${covered ? ' is-covered-elsewhere' : ''}`}>
      <label className="covered-check" title="Учтено в другой позиции — закрыть без цены">
        <input
          type="checkbox"
          checked={covered}
          onChange={(e) => onToggleCovered(it.id, cp.id, e.target.checked, note)}
        />
        <span>учтено</span>
      </label>
      {covered && (
        <input
          type="text"
          className="covered-note-input"
          placeholder="учтено в…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={saveNote}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        />
      )}
    </td>
  )
}

// ===== Подкомпонент: «Исходный КП» =====
// Контрагенты — колонками. Для каждого 5 sub-cells:
//   Ц.мат / Стоим.мат / Ц.раб / Стоим.раб / Итого.
const SourceTable = memo(function SourceTable({
  itemsOfScope, counterpartiesInScope, proposalsByItem,
  minByItem, totalsByCp, minTotalCost, showDocColumn,
  canEdit, onToggleCovered, supplyRatesMap = EMPTY_MAP,
}) {
  // task 408/409: снабжение по позиции — ЦЕНА ЗА ЕД. (загруженная) + ИТОГО (объём×цена).
  // Базовый ориентир, НЕ КП подрядчика — в min/итоги/победителя не входит.
  // Считается один раз на набор позиций, а не на каждую отрисовку каждой строки.
  const supply = useMemo(() => {
    // Нерасценён снабжением = материал с объёмом, но без цены за ед. снабжения.
    // Подсвечиваем только когда расценки снабжения вообще загружены — иначе
    // в тендере без снабжения подсветилась бы вся таблица.
    const hasSupplyData = supplyRatesMap.size > 0
    const unit = new Array(itemsOfScope.length)
    const total = new Array(itemsOfScope.length)
    const missing = new Array(itemsOfScope.length)
    let grand = 0
    itemsOfScope.forEach((it, i) => {
      const u = isWorkRow(it) ? null : supplyUnitPrice(supplyRatesMap, it.estimate_name, it.cost_name)
      const t = supplyTotal(u, it.material_consumption)
      unit[i] = u
      total[i] = t
      missing[i] = hasSupplyData && !isWorkRow(it) && Number(it.material_consumption) > 0 && u == null
      grand += t || 0
    })
    return { unit, total, missing, grand }
  }, [itemsOfScope, supplyRatesMap])
  const supplyGrandTotal = supply.grand
  // task 410: строки создаются по индексу — при большом числе позиций VirtualTableBody
  // вызывает renderRow только для окна вокруг вьюпорта, а не для всех позиций × КП.
  const scrollRef = useRef(null)
  const renderRow = (idx) => {
    const it = itemsOfScope[idx]
    const minPrice = minByItem.get(it.id)
    const supplyUnit = supply.unit[idx]
    const supplyCost = supply.total[idx]
    const supplyMissing = supply.missing[idx]
    const itemProposals = proposalsByItem.get(it.id)
    return (
      <tr key={it.id} className={supplyMissing ? 'supply-row-missing' : undefined}>
        <td className="td-num">{idx + 1}</td>
        {showDocColumn && <td className="td-doc">{it.estimate_name || '—'}</td>}
        <td className="td-code">{it.code || '—'}</td>
        <td className="td-name" title={it.cost_name}>{it.cost_name}</td>
        <td className="td-unit">{it.unit || '—'}</td>
        <td className="td-vol">{fmtMoney(it.work_volume)}</td>
        <td className="td-vol">{fmtMoney(it.material_consumption)}</td>
        <td className={`td-price td-supply td-cp-first${supplyMissing ? ' supply-price-missing' : ''}`}>
          {supplyUnit != null ? fmtMoney(supplyUnit) : '—'}
        </td>
        <td className={`td-price td-supply td-supply-total${supplyMissing ? ' supply-price-missing' : ''}`}>
          {supplyCost != null ? fmtMoney(supplyCost) : '—'}
        </td>
        {counterpartiesInScope.map(cp => {
          const p = itemProposals?.get(cp.id)
          const total = p ? Number(p.total_cost) || 0 : 0
          const isMin = total > 0 && minPrice != null && total === minPrice
          // task 401: строка, существующая только ради пометки «учтено»,
          // не имеет цен — показываем «—» во всех денежных ячейках.
          const flagOnly = !!p?.covered_elsewhere && total <= 0
          const cell = (v) => (p && !flagOnly ? fmtMoney(v) : '—')
          return (
            <React.Fragment key={cp.id}>
              <td className="td-price td-cp-first">{cell(p?.unit_price_materials)}</td>
              <td className="td-price td-sum">{cell(p?.total_materials)}</td>
              <td className="td-price">{cell(p?.unit_price_works)}</td>
              <td className="td-price td-sum">{cell(p?.total_works)}</td>
              <SourceTotalCell
                it={it} cp={cp} p={p} isMin={isMin}
                canEdit={canEdit} onToggleCovered={onToggleCovered}
              />
            </React.Fragment>
          )
        })}
      </tr>
    )
  }
  const totalCols = (showDocColumn ? 7 : 6) + 2 + counterpartiesInScope.length * 5
  const virtualize = itemsOfScope.length > VIRTUALIZE_FROM
  return (
    <div ref={scrollRef} className={`proposals-table-wrap${virtualize ? ' proposals-virtual' : ''}`}>
      <table className="proposals-table">
        <thead>
          <tr>
            <th rowSpan={2} className="th-num">№</th>
            {showDocColumn && <th rowSpan={2} className="th-doc">ВОР</th>}
            <th rowSpan={2} className="th-code">КОД</th>
            <th rowSpan={2} className="th-name">Наименование</th>
            <th rowSpan={2} className="th-unit">Ед.</th>
            <th rowSpan={2} className="th-vol">Объём раб.</th>
            <th rowSpan={2} className="th-vol">Объём мат.</th>
            <th colSpan={2} className="th-cp th-supply-group" title="Базовый ориентир от снабжения — не КП подрядчика">Снабжение</th>
            {counterpartiesInScope.map(cp => (
              <th key={cp.id} colSpan={5} className="th-cp">
                <div className="th-cp-name" title={cp.name}>{cp.name}</div>
                {cp.latestDate && <div className="th-cp-date">КП от {fmtDate(cp.latestDate)}</div>}
                <UploadedAt at={cp.uploadedAt} className="th-cp-uploaded" />
              </th>
            ))}
          </tr>
          <tr>
            <th className="th-sub th-supply" title="Загруженная цена за единицу от снабжения">Цена/ед, ₽</th>
            <th className="th-sub th-sub-total th-supply" title="Итого от снабжения = Объём мат. × Цена/ед.">Итого, ₽</th>
            {counterpartiesInScope.map(cp => (
              <React.Fragment key={cp.id}>
                <th className="th-sub" title="Цена материала за ед.">Ц.мат, ₽/ед</th>
                <th className="th-sub" title="Стоимость материалов = Ц.мат × Объём мат.">Стоим.мат, ₽</th>
                <th className="th-sub" title="Цена работ за ед.">Ц.раб, ₽/ед</th>
                <th className="th-sub" title="Стоимость работ = Ц.раб × Объём раб.">Стоим.раб, ₽</th>
                <th className="th-sub th-sub-total" title="Итого по позиции">Итого, ₽</th>
              </React.Fragment>
            ))}
          </tr>
        </thead>
        {virtualize
          ? <VirtualTableBody rowCount={itemsOfScope.length} renderRow={renderRow} colSpan={totalCols} scrollRef={scrollRef} rowHeight={33} />
          : <tbody>{itemsOfScope.map((_, idx) => renderRow(idx))}</tbody>}
        <tfoot>
          <tr className="proposals-total-row">
            <td colSpan={showDocColumn ? 7 : 6} style={{ textAlign: 'right' }}>ИТОГО, ₽:</td>
            <td className="td-total-cp td-supply td-cp-first" />
            <td className="td-total-cp td-supply td-supply-total" title="Итого по материалам от снабжения (не КП подрядчика)">
              {supplyGrandTotal > 0 ? fmtMoney(supplyGrandTotal) : '—'}
            </td>
            {counterpartiesInScope.map(cp => {
              const total = totalsByCp.get(cp.id)?.totalCost || 0
              const isMin = total > 0 && total === minTotalCost
              return (
                <td key={cp.id} colSpan={5} className={`td-total-cp${isMin ? ' is-min' : ''}`}>
                  {fmtMoney(total)}
                </td>
              )
            })}
          </tr>
        </tfoot>
      </table>
    </div>
  )
})

// ===== Ячейка «Стоимость» агрегированной строки с пометкой «учтено» (task 401) =====
// Агрегированная строка объединяет несколько позиций ВОРа. Если у контрагента
// часть из них без цены («дыра», оранжевая ячейка), сотрудник может пакетно
// пометить их «учтено в другой позиции» — оранжевый уходит, стоимость
// остаётся от расценённых позиций (или бейдж «учтено», если расценённых нет).
// Позиции строки с объёмом и КП подрядчика по ним — [{itemId, proposalId, hasPrice, covered, note}]; считаются только
// для показанных ячеек (окно виртуализации), а не для всех строк × подрядчиков.
const coverItemsOf = (r, d) => r.volItemIds.map((itemId) => {
  const p = d?.byItem.get(itemId)
  // task 403: «расценена» определяем по total_cost (не по типовой цене),
  // иначе позиция с ценой «не в той» колонке ложно считалась бы дырой.
  return {
    itemId,
    proposalId: p?.id ?? null,
    hasPrice: (Number(p?.total_cost) || 0) > 0,
    covered: !!p?.covered_elsewhere,
    note: p?.coverage_note || '',
  }
})

function AggregateCoverControl({
  r, d, cp, total, isMin, isIncomplete, hasPrice, incompleteTip, canEdit, onToggleCovered,
}) {
  const coverItems = useMemo(() => coverItemsOf(r, d), [r, d])
  const noPrice = coverItems.filter(c => !c.hasPrice)
  const hasHoleCandidates = noPrice.length > 0
  const allCovered = hasHoleCandidates && noPrice.every(c => c.covered)
  const firstNote = coverItems.find(c => c.covered && c.note)?.note || ''

  const [note, setNote] = useState(firstNote)
  useEffect(() => { setNote(firstNote) }, [firstNote])

  const moneyPart = hasPrice
    ? fmtMoney(total)
    : (allCovered ? <span className="covered-badge" title={note || ''}>учтено</span> : '—')

  const cls = `td-price td-total${isMin ? ' is-min' : ''}`
    + `${isIncomplete ? ' is-incomplete' : ''}`
    + `${allCovered && !hasPrice ? ' is-covered-elsewhere' : ''}`

  // Подрядчик или строка без позиций-кандидатов — без управления.
  if (!canEdit || !hasHoleCandidates) {
    return <td className={cls} title={incompleteTip || undefined}>{moneyPart}</td>
  }

  const saveNote = () => {
    if (allCovered && firstNote !== note) onToggleCovered(cp.id, coverItems, true, note)
  }

  return (
    <td className={`${cls} td-covered-cell`} title={incompleteTip || undefined}>
      <div className="td-total-money">{moneyPart}</div>
      <label className="covered-check" title="Учтено в другой позиции — закрыть без цены">
        <input
          type="checkbox"
          checked={allCovered}
          onChange={(e) => onToggleCovered(cp.id, coverItems, e.target.checked, note)}
        />
        <span>учтено</span>
      </label>
      {allCovered && (
        <input
          type="text"
          className="covered-note-input"
          placeholder="учтено в…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={saveNote}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        />
      )}
    </td>
  )
}

// ===== Подкомпонент: «Материалы» / «Работы» (агрегированный) =====
// task 350: в режиме «Объединённый» рендерим по группам ВОРов с подытогами,
// потом общий ИТОГО. В режиме одного ВОРа — плоский список (одна группа,
// заголовок группы скрывается).
const AggregateView = memo(function AggregateView({ kind, groups, counterpartiesInScope, totalsByCp, showGroupHeaders, canEdit, onToggleCovered, supplyRatesMap = EMPTY_MAP }) {
  const isMaterials = kind === 'materials'
  const totalKey = isMaterials ? 'totalMat' : 'totalWork'
  const scrollRef = useRef(null)

  // task 408: колонка «Цена от снабжения» только в «Материалах» (у работ расценок
  // снабжения нет). Стоимость по строке = цена снабжения × Σ объём этой позиции.
  // Базовый ориентир, НЕ КП подрядчика — в min/итоги контрагентов не входит.
  const showSupply = isMaterials
  // Подсвечиваем нерасценённые только когда расценки снабжения загружены.
  const hasSupplyData = supplyRatesMap.size > 0
  // task 409: цена за ед. (загруженная) и итог (цена × Σ объём) по агрегированной строке.
  const supplyUnitOfRow = (groupName, r) => supplyUnitPrice(supplyRatesMap, groupName, r.name)
  const supplyCostOfRow = (groupName, r) => supplyTotal(supplyUnitOfRow(groupName, r), r.totalVol)
  const supplyGroupCost = new Map() // group.name → Σ стоимость снабжения
  const supplyGroupMissing = new Map() // group.name → есть ли нерасценённые позиции
  let supplyGrand = 0
  if (showSupply) {
    for (const g of groups) {
      let cost = 0, missing = false
      for (const r of g.rows) {
        const c = supplyCostOfRow(g.name, r)
        if (c != null) cost += c
        if (supplyUnitOfRow(g.name, r) == null && Number(r.totalVol) > 0 && hasSupplyData) missing = true
      }
      supplyGroupCost.set(g.name, cost)
      supplyGroupMissing.set(g.name, missing)
      supplyGrand += cost
    }
  }

  // Минимум по строке (среди контрагентов с непустыми ценами) — для подсветки.
  const computeMinByRow = (row) => {
    let min = Infinity
    for (const d of row.cpData.values()) {
      const v = d.totalCost || 0
      if (v > 0 && v < min) min = v
    }
    return min === Infinity ? null : min
  }
  // Минимум по подытогу группы — подсветка лучшего контрагента ПО ЭТОМУ ВОРу.
  const computeMinSubtotal = (group) => {
    let min = Infinity
    for (const cp of counterpartiesInScope) {
      const v = group.subtotalByCp.get(cp.id) || 0
      if (v > 0 && v < min) min = v
    }
    return min === Infinity ? null : min
  }

  if (groups.length === 0) {
    return (
      <div className="proposals-empty">
        <p>{isMaterials ? 'Материалов нет в выбранном scope.' : 'Работ нет в выбранном scope.'}</p>
      </div>
    )
  }

  // Минимальный итог по контрагенту (общий ИТОГО снизу).
  const allTotals = counterpartiesInScope.map(c => totalsByCp.get(c.id)?.[totalKey] || 0)
  const minTotal = allTotals.length > 0
    ? Math.min(...allTotals.filter(v => v > 0).concat(Infinity))
    : Infinity

  // Плоский список строк тела: заголовок ВОРа → позиции → подытог. Строки создаются
  // только для окна вокруг вьюпорта: на тысячах агрегированных позиций × подрядчиков
  // полная отрисовка занимала десятки секунд и вешала вкладку.
  const entries = []
  groups.forEach((group, gi) => {
    if (showGroupHeaders) entries.push({ type: 'header', group, gi })
    group.rows.forEach((r, ri) => entries.push({ type: 'row', group, gi, r, ri }))
    if (showGroupHeaders) entries.push({ type: 'subtotal', group, gi, minSub: computeMinSubtotal(group) })
  })
  const aggCols = 4 + (showSupply ? 2 : 0) + counterpartiesInScope.length * 2
  const virtualize = entries.length > VIRTUALIZE_FROM
  const renderEntry = (e) => {
    const { group } = e
    if (e.type === 'header') {
      return (
        <tr key={`h:${e.gi}`} className={`proposals-group-header${showSupply && supplyGroupMissing.get(group.name) ? ' supply-group-missing' : ''}`}>
          <td colSpan={4 + (showSupply ? 2 : 0) + counterpartiesInScope.length * 2}>
            <span className="proposals-group-header-label">ВОР</span>
            <span className="proposals-group-header-name">{group.name}</span>
            <span className="proposals-group-header-count">
              {group.rows.length} {isMaterials ? 'позиций материалов' : 'позиций работ'}
            </span>
            {showSupply && supplyGroupMissing.get(group.name) && (
              <span className="proposals-group-supply-warn" title="В группе есть материалы без цены от снабжения">⚠ есть нерасценённые снабжением</span>
            )}
          </td>
        </tr>
      )
    }
    if (e.type === 'subtotal') {
      const { minSub } = e
      return (
        <tr key={`s:${e.gi}`} className="proposals-group-subtotal">
          <td colSpan={4} style={{ textAlign: 'right' }}>
            Подытог по «{group.name}», ₽:
          </td>
          {showSupply && (
            <>
              <td className={`td-group-subtotal td-supply td-cp-first${supplyGroupMissing.get(group.name) ? ' supply-price-missing' : ''}`} />
              <td className={`td-group-subtotal td-supply td-supply-total${supplyGroupMissing.get(group.name) ? ' supply-price-missing' : ''}`}>
                {supplyGroupCost.get(group.name) > 0 ? fmtMoney(supplyGroupCost.get(group.name)) : '—'}
              </td>
            </>
          )}
          {counterpartiesInScope.map(cp => {
            const v = group.subtotalByCp.get(cp.id) || 0
            const isMin = v > 0 && minSub != null && v === minSub
            // task 355: подсветка если в группе есть нерасценённые позиции.
            const incompleteTotal = group.itemsTotal
            const incompleteCovered = group.coveredByCp.get(cp.id) || 0
            const isIncomplete = incompleteTotal > 0 && incompleteCovered < incompleteTotal
            return (
              <td
                key={cp.id}
                colSpan={2}
                className={`td-group-subtotal${isMin ? ' is-min' : ''}${isIncomplete ? ' is-incomplete' : ''}`}
                title={isIncomplete
                  ? `Расценено ${incompleteCovered} из ${incompleteTotal} позиций — подытог неполный`
                  : undefined}
              >
                {v > 0 ? fmtMoney(v) : '—'}
              </td>
            )
          })}
        </tr>
      )
    }
    const { r, ri } = e
    const minCost = computeMinByRow(r)
    const supplyUnit = showSupply ? supplyUnitOfRow(group.name, r) : null
    const supplyCost = showSupply ? supplyCostOfRow(group.name, r) : null
    const supplyMissing = showSupply && hasSupplyData && supplyUnit == null && Number(r.totalVol) > 0
    return (
      <tr key={`r:${e.gi}|${ri}`} className={supplyMissing ? 'supply-row-missing' : undefined}>
        <td className="td-num">{ri + 1}</td>
        <td className="td-name" title={r.name}>{r.name}</td>
        <td className="td-unit">{r.unit || '—'}</td>
        <td className="td-vol">{fmtMoney(r.totalVol)}</td>
        {showSupply && (
          <>
            <td className={`td-price td-supply td-cp-first${supplyMissing ? ' supply-price-missing' : ''}`}>
              {supplyUnit != null ? fmtMoney(supplyUnit) : '—'}
            </td>
            <td className={`td-price td-supply td-supply-total${supplyMissing ? ' supply-price-missing' : ''}`}>
              {supplyCost != null ? fmtMoney(supplyCost) : '—'}
            </td>
          </>
        )}
        {counterpartiesInScope.map(cp => {
          const d = r.cpData.get(cp.id)
          const avgPrice = d && d.weightedVolSum > 0 ? d.weightedPriceSum / d.weightedVolSum : 0
          const total = d?.totalCost || 0
          const isMin = total > 0 && minCost != null && total === minCost
          // task 355: подсветка нерасценённой позиции у контрагента.
          // Если itemsTotal > itemsCovered — есть «дыра» в покрытии
          // (одно и то же название с разными подключёнными позициями).
          const covered = d?.itemsCovered || 0
          const isIncomplete = r.itemsTotal > covered
          const hasPrice = total > 0
          const incompleteTip = isIncomplete
            ? `Расценено ${covered} из ${r.itemsTotal} позиций — итог неполный`
            : null
          return (
            <React.Fragment key={cp.id}>
              <td
                className={`td-price td-cp-first${isIncomplete ? ' is-incomplete' : ''}`}
                title={incompleteTip || undefined}
              >
                {hasPrice ? fmtMoney(avgPrice) : '—'}
              </td>
              <AggregateCoverControl
                r={r} d={d} cp={cp} total={total} isMin={isMin}
                isIncomplete={isIncomplete} hasPrice={hasPrice}
                incompleteTip={incompleteTip}
                canEdit={canEdit} onToggleCovered={onToggleCovered}
              />
            </React.Fragment>
          )
        })}
      </tr>
    )
  }

  return (
    <div ref={scrollRef} className={`proposals-table-wrap${virtualize ? ' proposals-virtual' : ''}`}>
      <table className="proposals-table proposals-table-aggregate">
        <thead>
          <tr>
            <th rowSpan={2} className="th-num">№</th>
            <th rowSpan={2} className="th-name">Наименование</th>
            <th rowSpan={2} className="th-unit">Ед.</th>
            <th rowSpan={2} className="th-vol">Σ Объём</th>
            {showSupply && (
              <th colSpan={2} className="th-cp th-supply-group" title="Базовый ориентир от снабжения — не КП подрядчика">Снабжение</th>
            )}
            {counterpartiesInScope.map(cp => (
              <th key={cp.id} colSpan={2} className="th-cp">
                <div className="th-cp-name" title={cp.name}>{cp.name}</div>
                {cp.latestDate && <div className="th-cp-date">КП от {fmtDate(cp.latestDate)}</div>}
                <UploadedAt at={cp.uploadedAt} className="th-cp-uploaded" />
              </th>
            ))}
          </tr>
          <tr>
            {showSupply && (
              <>
                <th className="th-sub th-supply" title="Загруженная цена за единицу от снабжения">Цена/ед, ₽</th>
                <th className="th-sub th-sub-total th-supply" title="Итого от снабжения = цена/ед × Σ объём">Итого, ₽</th>
              </>
            )}
            {counterpartiesInScope.map(cp => (
              <React.Fragment key={cp.id}>
                <th className="th-sub" title="Средняя цена за ед. (взвешенная по объёму)">Цена/ед, ₽</th>
                <th className="th-sub th-sub-total" title="Сумма стоимостей по всем позициям">Стоимость, ₽</th>
              </React.Fragment>
            ))}
          </tr>
        </thead>
        {virtualize
          ? <VirtualTableBody rowCount={entries.length} renderRow={(i) => renderEntry(entries[i])} colSpan={aggCols} scrollRef={scrollRef} rowHeight={40} />
          : <tbody>{entries.map(renderEntry)}</tbody>}
        <tfoot>
          <tr className="proposals-total-row">
            <td colSpan={4} style={{ textAlign: 'right' }}>
              ОБЩИЙ ИТОГО по {isMaterials ? 'материалам' : 'работам'}, ₽:
            </td>
            {showSupply && (
              <td className="td-total-cp td-supply td-cp-first" />
            )}
            {showSupply && (
              <td className="td-total-cp td-supply td-supply-total" title="Итого по материалам от снабжения (не КП подрядчика)">
                {supplyGrand > 0 ? fmtMoney(supplyGrand) : '—'}
              </td>
            )}
            {counterpartiesInScope.map(cp => {
              const total = totalsByCp.get(cp.id)?.[totalKey] || 0
              const isMin = total > 0 && total === minTotal
              return (
                <td key={cp.id} colSpan={2} className={`td-total-cp${isMin ? ' is-min' : ''}`}>
                  {fmtMoney(total)}
                </td>
              )
            })}
          </tr>
        </tfoot>
      </table>
      <small className="proposals-aggregate-hint">
        {showGroupHeaders
          ? 'Строки сгруппированы по ВОРам. Внутри группы одинаковые наименования суммируются. Подытог — сумма по группе для каждого контрагента, ИТОГО снизу — по всем группам.'
          : 'В таблице суммированы одинаковые наименования из всех позиций ВОРа. Цена за единицу — средневзвешенная по объёму.'}
      </small>
    </div>
  )
})

export default TenderProposalsCompare
