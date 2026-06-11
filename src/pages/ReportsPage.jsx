import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import './ReportsPage.css'

// «В работе» — только активная процедура; «Не начат» сюда не входит.
const isInWork = (x) => x.status === 'Идет тендерная процедура'
const isClosed = (x) => x.status === 'Завершен'

function groupByResp(rows) {
  const map = new Map()
  for (const x of rows) {
    if (!isInWork(x) && !isClosed(x)) continue
    const id = x.responsible_contact_id || '_unassigned'
    const name = x.responsible_contact?.full_name || 'Не назначен'
    if (!map.has(id)) map.set(id, { id, name, inWork: 0, completed: 0 })
    const r = map.get(id)
    if (isClosed(x)) r.completed += 1
    else r.inWork += 1
  }
  return Array.from(map.values())
    .map(r => ({ ...r, total: r.inWork + r.completed }))
    .sort((a, b) => b.total - a.total)
}

// Динамика по месяцам создания (реальные created_at). Окно = periodMonths.
function buildDynamics(rows, periodMonths) {
  const now = new Date()
  const months = []
  for (let i = periodMonths - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('ru-RU', { month: 'short' }),
      total: 0, inWork: 0, closed: 0,
    })
  }
  const idx = new Map(months.map((m, i) => [m.key, i]))
  for (const x of rows) {
    if (!x.created_at) continue
    const i = idx.get(String(x.created_at).slice(0, 7))
    if (i == null) continue
    months[i].total += 1
    if (isClosed(x)) months[i].closed += 1
    else if (isInWork(x)) months[i].inWork += 1
  }
  return months
}

// task: фильтруемая тендерная аналитика (используется в useMemo). ЕДИНАЯ выборка
// `rows` (период по created_at + отдел + ответственный + объект) — от неё считаются
// ВСЕ блоки дашборда (KPI/donut/динамика/внимание/отделы/ответственные).
function computeTenderStats(allRows, { dept = 'all', respId = 'all', objectId = 'all', periodMonths = 6 }) {
  const today = new Date().toISOString().split('T')[0]
  // Период: 'all' — без фильтра по дате (все тендеры); иначе — созданные за последние
  // periodMonths месяцев (включая текущий). График ограничиваем 12 месяцами.
  const allPeriod = periodMonths === 'all'
  let rows = allRows
  if (!allPeriod) {
    const now = new Date()
    const cutoff = new Date(now.getFullYear(), now.getMonth() - (periodMonths - 1), 1)
    const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-01`
    rows = allRows.filter(x => x.created_at && String(x.created_at).slice(0, 10) >= cutoffStr)
  }
  if (dept !== 'all') rows = rows.filter(x => x.objects?.status === dept)
  if (objectId !== 'all') rows = rows.filter(x => String(x.object_id) === String(objectId))
  if (respId !== 'all') rows = rows.filter(x => (x.responsible_contact_id || '_unassigned') === respId)

  const open = rows.filter(isInWork).length
  const closed = rows.filter(isClosed).length
  const deptBlock = (st) => {
    const r = rows.filter(x => x.objects?.status === st)
    return {
      total: r.length, open: r.filter(isInWork).length, closed: r.filter(isClosed).length,
      unassigned: r.filter(x => !x.responsible_contact_id).length, byResp: groupByResp(r),
    }
  }
  return {
    total: rows.length,
    open,
    closed,
    notStarted: Math.max(0, rows.length - open - closed),
    overdue: rows.filter(x => isInWork(x) && x.end_date && x.end_date < today).length,
    unassigned: rows.filter(x => !x.responsible_contact_id).length,
    byResponsible: groupByResp(rows),
    dynamics: buildDynamics(rows, allPeriod ? 12 : periodMonths),
    byDept: {
      main_construction: deptBlock('main_construction'),
      warranty_service: deptBlock('warranty_service'),
    },
  }
}

function ReportsPage() {
  const { scopedObjectId } = useRole()
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState(null)
  const [activeTab, setActiveTab] = useState('tenders')
  // null = обзор, 'construction' | 'warranty' = детализация по выбранному отделу
  const [tDeptView, setTDeptView] = useState(null)
  // task: сырые основные тендеры + момент загрузки (для фильтрации без повторных запросов)
  const [rawTenders, setRawTenders] = useState([])
  const [loadedAt, setLoadedAt] = useState(null)
  // Фильтры тендерного дашборда
  const [fDept, setFDept] = useState('all')
  const [fResp, setFResp] = useState('all')
  const [fObject, setFObject] = useState('all')
  const [fPeriod, setFPeriod] = useState(6)

  useEffect(() => {
    fetchStats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedObjectId])

  // task: тендерная аналитика пересчитывается на клиенте при смене фильтров.
  const tStats = useMemo(
    () => computeTenderStats(rawTenders, { dept: fDept, respId: fResp, objectId: fObject, periodMonths: fPeriod }),
    [rawTenders, fDept, fResp, fObject, fPeriod]
  )
  // Списки для дропдаунов фильтров — из сырых тендеров.
  const objectOptions = useMemo(() => {
    const m = new Map()
    for (const x of rawTenders) {
      if (x.object_id && x.objects?.name) m.set(x.object_id, x.objects.name)
    }
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  }, [rawTenders])
  const respOptions = useMemo(() => {
    const m = new Map()
    for (const x of rawTenders) {
      if (x.responsible_contact_id && x.responsible_contact?.full_name) {
        m.set(x.responsible_contact_id, x.responsible_contact.full_name)
      }
    }
    return Array.from(m, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  }, [rawTenders])
  const fActive = fDept !== 'all' || fResp !== 'all' || fObject !== 'all' || fPeriod !== 6
  const resetFilters = () => { setFDept('all'); setFResp('all'); setFObject('all'); setFPeriod(6) }

  const fetchStats = async () => {
    try {
      setLoading(true)

      let tendersQ = supabase
        .from('tenders')
        .select(`
          id, object_id, status, end_date, created_at, responsible_contact_id, tender_type, deleted_at,
          cost_plan_status, cost_plan_responsible_id, cost_plan_end_date,
          vor_status, vor_responsible_id, vor_end_date,
          materials_proposal_deadline,
          winner_counterparty_id,
          objects(id, name, status),
          responsible_contact:contacts!responsible_contact_id(id, full_name),
          cost_plan_responsible:contacts!cost_plan_responsible_id(id, full_name),
          vor_responsible:contacts!vor_responsible_id(id, full_name),
          winner:counterparties!winner_counterparty_id(id, name)
        `)
      if (scopedObjectId) tendersQ = tendersQ.eq('object_id', scopedObjectId)
      const { data: tendersRaw } = await tendersQ

      let contractsQ = supabase
        .from('contracts')
        .select('id, object_id, status, contract_amount, counterparty_id, objects(status)')
      if (scopedObjectId) contractsQ = contractsQ.eq('object_id', scopedObjectId)
      const { data: contracts } = await contractsQ

      // Отчёт по тендерам считаем только по основным тендерам, не по дочерним на материалы.
      // Если миграция tender_type не применена, x.tender_type === undefined — учитываем как main.
      const allTenders = (tendersRaw || []).filter(x => !x.deleted_at)
      const t = allTenders.filter(x => !x.tender_type || x.tender_type === 'main')
      const materialsTenders = allTenders.filter(x => x.tender_type === 'materials')
      const c = contracts || []
      const today = new Date().toISOString().split('T')[0]

      // «В работе» считаем только статус 'Идет тендерная процедура' —
      // «Не начат» сюда не входит (task 288).
      const isInWork = (x) => x.status === 'Идет тендерная процедура'
      const isClosed = (x) => x.status === 'Завершен'

      const tConst = t.filter(x => x.objects?.status === 'main_construction')
      const tWar = t.filter(x => x.objects?.status === 'warranty_service')
      const cConst = c.filter(x => x.objects?.status === 'main_construction')
      const cWar = c.filter(x => x.objects?.status === 'warranty_service')

      // Группировка по ответственным — в работу попадают только активные
      // процедуры, завершённые отдельно. Тендеры со статусом «Не начат» не
      // учитываются в total ответственного (но видны в KPI «Всего»).
      const groupByResponsible = (rows) => {
        const map = new Map()
        for (const x of rows) {
          if (!isInWork(x) && !isClosed(x)) continue
          const id = x.responsible_contact_id || '_unassigned'
          const name = x.responsible_contact?.full_name || 'Не назначен'
          if (!map.has(id)) {
            map.set(id, { id, name, inWork: 0, completed: 0 })
          }
          const row = map.get(id)
          if (isClosed(x)) row.completed += 1
          else row.inWork += 1
        }
        return Array.from(map.values())
          .map(r => ({ ...r, total: r.inWork + r.completed }))
          .sort((a, b) => b.total - a.total)
      }

      const unassignedCount = (rows) => rows.filter(x => !x.responsible_contact_id).length

      const sumAmount = (rows) => rows.reduce((acc, r) => acc + (Number(r.contract_amount) || 0), 0)

      // Общая группировка по ответственному с произвольным предикатом «завершено»
      // и произвольным getter ответственного — реюзается для materials/cost-plans/vor.
      const groupByResponsibleGeneric = (rows, getRespId, getRespName, isDoneFn) => {
        const map = new Map()
        for (const x of rows) {
          const id = getRespId(x) || '_unassigned'
          const name = getRespName(x) || 'Не назначен'
          if (!map.has(id)) map.set(id, { id, name, inWork: 0, completed: 0 })
          const row = map.get(id)
          if (isDoneFn(x)) row.completed += 1
          else row.inWork += 1
        }
        return Array.from(map.values())
          .map(r => ({ ...r, total: r.inWork + r.completed }))
          .sort((a, b) => b.total - a.total)
      }

      // === Тендеры на материалы ===
      const isMaterialsClosed = (x) => x.status === 'Завершён' || x.status === 'Завершен'
      const isMaterialsOpen = (x) => !isMaterialsClosed(x)
      const isMaterialsInWork = (x) => x.status === 'В работе'
      const isMaterialsNotStarted = (x) => x.status === 'Не начат' || (!isMaterialsClosed(x) && !isMaterialsInWork(x))
      const mat = {
        total: materialsTenders.length,
        open: materialsTenders.filter(isMaterialsOpen).length,
        closed: materialsTenders.filter(isMaterialsClosed).length,
        notStarted: materialsTenders.filter(isMaterialsNotStarted).length,
        inWork: materialsTenders.filter(isMaterialsInWork).length,
        overdue: materialsTenders.filter(x =>
          isMaterialsOpen(x) && x.materials_proposal_deadline && x.materials_proposal_deadline < today
        ).length,
        unassigned: materialsTenders.filter(x => !x.responsible_contact_id).length,
        byResp: groupByResponsibleGeneric(
          materialsTenders,
          (x) => x.responsible_contact_id,
          (x) => x.responsible_contact?.full_name,
          isMaterialsClosed
        ),
      }

      // === Планы затрат (только основные тендеры основного строительства) ===
      const cpRows = tConst
      const isCpDone = (x) => x.cost_plan_status === 'completed'
      const cp = {
        total: cpRows.length,
        notStarted: cpRows.filter(x => !x.cost_plan_status || x.cost_plan_status === 'not_started').length,
        inProgress: cpRows.filter(x => x.cost_plan_status === 'in_progress').length,
        completed: cpRows.filter(isCpDone).length,
        overdue: cpRows.filter(x => !isCpDone(x) && x.cost_plan_end_date && x.cost_plan_end_date < today).length,
        unassigned: cpRows.filter(x => !x.cost_plan_responsible_id).length,
        byResp: groupByResponsibleGeneric(
          cpRows,
          (x) => x.cost_plan_responsible_id,
          (x) => x.cost_plan_responsible?.full_name,
          isCpDone
        ),
      }

      // === Победители тендеров ===
      // Считаем только завершённые основные тендеры с указанным победителем.
      const winnerTenders = t.filter(x => isClosed(x) && x.winner_counterparty_id)
      const contractsByCounterparty = (c || []).reduce((acc, contract) => {
        const cpId = contract.counterparty_id
        if (!cpId) return acc
        if (!acc[cpId]) acc[cpId] = { signed: 0, signedAmount: 0, total: 0, totalAmount: 0 }
        const amount = Number(contract.contract_amount) || 0
        acc[cpId].total += 1
        acc[cpId].totalAmount += amount
        if (contract.status === 'signed') {
          acc[cpId].signed += 1
          acc[cpId].signedAmount += amount
        }
        return acc
      }, {})

      const winnerMap = new Map()
      for (const x of winnerTenders) {
        const id = x.winner_counterparty_id
        const name = x.winner?.name || 'Контрагент удалён'
        if (!winnerMap.has(id)) {
          winnerMap.set(id, {
            id,
            name,
            wins: 0,
            winsConst: 0,
            winsWar: 0,
            signedContracts: 0,
            signedAmount: 0,
          })
        }
        const row = winnerMap.get(id)
        row.wins += 1
        if (x.objects?.status === 'main_construction') row.winsConst += 1
        else if (x.objects?.status === 'warranty_service') row.winsWar += 1
        const cStats = contractsByCounterparty[id]
        if (cStats) {
          row.signedContracts = cStats.signed
          row.signedAmount = cStats.signedAmount
        }
      }
      const winners = {
        total: winnerTenders.length,
        unique: winnerMap.size,
        totalAmount: Array.from(winnerMap.values()).reduce((s, r) => s + r.signedAmount, 0),
        rows: Array.from(winnerMap.values()).sort((a, b) => b.wins - a.wins || b.signedAmount - a.signedAmount),
      }

      // === ВОРы и РД ===
      const vorRows = tConst
      const isVorDone = (x) => x.vor_status === 'completed'
      const vor = {
        total: vorRows.length,
        notStarted: vorRows.filter(x => !x.vor_status || x.vor_status === 'not_started').length,
        inProgress: vorRows.filter(x => x.vor_status === 'in_progress').length,
        completed: vorRows.filter(isVorDone).length,
        overdue: vorRows.filter(x => !isVorDone(x) && x.vor_end_date && x.vor_end_date < today).length,
        unassigned: vorRows.filter(x => !x.vor_responsible_id).length,
        byResp: groupByResponsibleGeneric(
          vorRows,
          (x) => x.vor_responsible_id,
          (x) => x.vor_responsible?.full_name,
          isVorDone
        ),
      }

      // Динамика тендеров по месяцам создания (реальные created_at). Последние 6 месяцев.
      // Для каждого месяца: всего создано + сколько из них сейчас в работе / завершено.
      const now = new Date()
      const dynMonths = []
      for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
        dynMonths.push({
          key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
          label: d.toLocaleDateString('ru-RU', { month: 'short' }),
          total: 0, inWork: 0, closed: 0,
        })
      }
      const dynIdx = new Map(dynMonths.map((m, i) => [m.key, i]))
      for (const x of t) {
        if (!x.created_at) continue
        const i = dynIdx.get(String(x.created_at).slice(0, 7))
        if (i == null) continue
        dynMonths[i].total += 1
        if (isClosed(x)) dynMonths[i].closed += 1
        else if (isInWork(x)) dynMonths[i].inWork += 1
      }

      const tClosedCount = t.filter(isClosed).length
      const tOpenCount = t.filter(isInWork).length

      // task: сохраняем сырые тендеры для клиентской фильтрации дашборда + момент загрузки.
      setRawTenders(t)
      setLoadedAt(new Date())

      setStats({
        // Тендеры — общие
        tTotal: t.length,
        tOpen: tOpenCount,
        tClosed: tClosedCount,
        // «Не начат»/прочие = всего − в работе − завершено (для donut статусов).
        tNotStarted: Math.max(0, t.length - tOpenCount - tClosedCount),
        // Просроченные: открытая процедура с прошедшим сроком (end_date) — реальное поле.
        tOverdue: t.filter(x => isInWork(x) && x.end_date && x.end_date < today).length,
        tDynamics: dynMonths,
        tUnassigned: unassignedCount(t),
        // По отделам тендеры
        tOpenConst: tConst.filter(isInWork).length,
        tClosedConst: tConst.filter(isClosed).length,
        tTotalConst: tConst.length,
        tUnassignedConst: unassignedCount(tConst),
        tOpenWar: tWar.filter(isInWork).length,
        tClosedWar: tWar.filter(isClosed).length,
        tTotalWar: tWar.length,
        tUnassignedWar: unassignedCount(tWar),
        // По ответственным
        byResponsible: groupByResponsible(t),
        byResponsibleConst: groupByResponsible(tConst),
        byResponsibleWar: groupByResponsible(tWar),
        // Договоры — общие
        cTotal: c.length,
        cPending: c.filter(x => x.status === 'pending').length,
        cSigned: c.filter(x => x.status === 'signed').length,
        cAmountTotal: sumAmount(c),
        cAmountSigned: sumAmount(c.filter(x => x.status === 'signed')),
        // По отделам договоры
        cPendingConst: cConst.filter(x => x.status === 'pending').length,
        cSignedConst: cConst.filter(x => x.status === 'signed').length,
        cTotalConst: cConst.length,
        cAmountConst: sumAmount(cConst),
        cPendingWar: cWar.filter(x => x.status === 'pending').length,
        cSignedWar: cWar.filter(x => x.status === 'signed').length,
        cTotalWar: cWar.length,
        cAmountWar: sumAmount(cWar),
        // Тендеры на материалы
        mat,
        // Планы затрат
        cp,
        // ВОРы и РД
        vor,
        // Победители тендеров
        winners,
      })
    } catch (err) {
      console.error('Ошибка загрузки отчётов:', err.message)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="reports-page">
        <div className="reports-header"><h2>Отчёты</h2></div>
        <div className="reports-loading">Загрузка...</div>
      </div>
    )
  }
  if (!stats) return null
  const s = stats

  const pct = (a, b) => b > 0 ? Math.round((a / b) * 100) : 0
  const fmtMoney = (n) => {
    if (!n) return '0 ₽'
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(n) + ' ₽'
  }

  // Данные текущего отдела (для детального вида) — из отфильтрованного tStats.
  const deptData = tDeptView === 'construction'
    ? { title: 'Основное строительство', icon: '🏗️', accent: 'dept-card--construction', ...tStats.byDept.main_construction }
    : tDeptView === 'warranty'
      ? { title: 'Гарантийный отдел', icon: '🛡️', accent: 'dept-card--warranty', ...tStats.byDept.warranty_service }
      : null

  const reportTabs = [
    { key: 'tenders', label: 'Тендеры', icon: '🏗️', count: s.tTotal },
    { key: 'winners', label: 'Победители', icon: '🏆', count: s.winners.unique },
    { key: 'materials', label: 'Материалы', icon: '📦', count: s.mat.total },
    { key: 'cost_plans', label: 'Планы затрат', icon: '💰', count: s.cp.total },
    { key: 'vors', label: 'ВОРы и РД', icon: '📐', count: s.vor.total },
    { key: 'contracts', label: 'Договоры', icon: '📝', count: s.cTotal },
  ]
  const updatedLabel = loadedAt
    ? `Обновлено: сегодня, ${loadedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
    : null

  return (
    <div className="reports-page">
      <div className="reports-header">
        <div>
          <h2>Отчёты</h2>
          <div className="reports-subtitle">Аналитика по тендерам</div>
        </div>
        <div className="report-toolbar">
          {updatedLabel && <span className="reports-updated">{updatedLabel}</span>}
          <button type="button" className="reports-export" title="Экспорт — скоро" disabled>
            <span aria-hidden>⬆</span> Экспорт
          </button>
        </div>
      </div>

      {/* Верхние разделы аналитики — компактные вкладки */}
      <nav className="reports-tabs" aria-label="Разделы отчётов">
        {reportTabs.map(tab => (
          <button
            key={tab.key}
            type="button"
            className={`reports-tab ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => {
              setActiveTab(tab.key)
              if (tab.key !== 'tenders') setTDeptView(null)
            }}
            aria-pressed={activeTab === tab.key}
          >
            <span className="reports-tab-icon" aria-hidden>{tab.icon}</span>
            <span className="reports-tab-label">{tab.label}</span>
            <span className="reports-tab-count">{tab.count}</span>
          </button>
        ))}
      </nav>

      {/* Фильтр-бар — компактные inline-чипы (только для вкладки «Тендеры») */}
      {activeTab === 'tenders' && (
        <div className="reports-filters">
          <label className={`rf-chip ${fPeriod !== 6 ? 'is-active' : ''}`}>
            <span className="rf-chip-key">Период:</span>
            <select className="rf-chip-select" value={fPeriod}
              onChange={(e) => { const v = e.target.value; setFPeriod(v === 'all' ? 'all' : Number(v)) }}>
              <option value="all">Все</option>
              <option value={1}>1 мес.</option>
              <option value={3}>3 мес.</option>
              <option value={6}>6 мес.</option>
              <option value={12}>12 мес.</option>
            </select>
          </label>
          <label className={`rf-chip ${fDept !== 'all' ? 'is-active' : ''}`}>
            <span className="rf-chip-key">Отдел:</span>
            <select className="rf-chip-select" value={fDept} onChange={(e) => { setFDept(e.target.value); setTDeptView(null) }}>
              <option value="all">Все</option>
              <option value="main_construction">Основное строительство</option>
              <option value="warranty_service">Гарантийный отдел</option>
            </select>
          </label>
          <label className={`rf-chip ${fResp !== 'all' ? 'is-active' : ''}`}>
            <span className="rf-chip-key">Ответственный:</span>
            <select className="rf-chip-select" value={fResp} onChange={(e) => setFResp(e.target.value)}>
              <option value="all">Все</option>
              <option value="_unassigned">Не назначен</option>
              {respOptions.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <label className={`rf-chip ${fObject !== 'all' ? 'is-active' : ''}`}>
            <span className="rf-chip-key">Объект:</span>
            <select className="rf-chip-select" value={fObject} onChange={(e) => setFObject(e.target.value)}>
              <option value="all">Все</option>
              {objectOptions.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          {fActive && (
            <button type="button" className="rf-reset" onClick={resetFilters}>✕ Сбросить</button>
          )}
        </div>
      )}

      <div className="reports-content">
        {activeTab === 'tenders' && !deptData && (
          <>
            {/* KPI по тендерам */}
            <div className="kpi-grid kpi-grid--5">
              <div className="kpi-card kpi-card--ico">
                <span className="kpi-ico kpi-ico--blue" aria-hidden>🏗️</span>
                <div className="kpi-body">
                  <div className="kpi-label">Всего тендеров</div>
                  <div className="kpi-value">{tStats.total}</div>
                </div>
              </div>
              <div className="kpi-card kpi-card--ico">
                <span className="kpi-ico kpi-ico--cyan" aria-hidden>⏳</span>
                <div className="kpi-body">
                  <div className="kpi-label">В работе</div>
                  <div className="kpi-value accent-info">{tStats.open}</div>
                  <div className="kpi-foot">{pct(tStats.open, tStats.total)}% от всех</div>
                </div>
              </div>
              <div className="kpi-card kpi-card--ico kpi-card--success">
                <span className="kpi-ico kpi-ico--green" aria-hidden>✓</span>
                <div className="kpi-body">
                  <div className="kpi-label">Завершено</div>
                  <div className="kpi-value accent-success">{tStats.closed}</div>
                  <div className="kpi-foot">{pct(tStats.closed, tStats.total)}% завершения</div>
                </div>
              </div>
              <div className={`kpi-card kpi-card--ico ${tStats.unassigned > 0 ? 'kpi-card--warn' : ''}`}>
                <span className="kpi-ico kpi-ico--amber" aria-hidden>👤</span>
                <div className="kpi-body">
                  <div className="kpi-label">Без ответственного</div>
                  <div className={`kpi-value ${tStats.unassigned > 0 ? 'accent-warn' : ''}`}>{tStats.unassigned}</div>
                  <div className="kpi-foot">требуют назначения</div>
                </div>
              </div>
              <div className={`kpi-card kpi-card--ico ${tStats.overdue > 0 ? 'kpi-card--danger' : ''}`}>
                <span className="kpi-ico kpi-ico--red" aria-hidden>⚠️</span>
                <div className="kpi-body">
                  <div className="kpi-label">Просроченные</div>
                  <div className={`kpi-value ${tStats.overdue > 0 ? 'accent-danger' : ''}`}>{tStats.overdue}</div>
                  <div className="kpi-foot">срок процедуры прошёл</div>
                </div>
              </div>
            </div>

            {/* Dashboard: статусы + динамика + требует внимания */}
            <div className="dash-grid">
              <section className="dash-card">
                <header className="dash-card-head"><h3>Статусы тендеров</h3></header>
                <StatusDonut
                  total={tStats.total}
                  segments={[
                    { label: 'В работе', value: tStats.open, color: '#2563eb' },
                    { label: 'Завершено', value: tStats.closed, color: '#16a34a' },
                    { label: 'Не начато', value: tStats.notStarted, color: '#94a3b8' },
                  ]}
                />
              </section>

              <section className="dash-card">
                <header className="dash-card-head">
                  <h3>Динамика тендеров</h3>
                  <span className="dash-card-meta">создано / в работе / завершено · {fPeriod === 'all' ? 'последние 12 мес.' : `${fPeriod} мес.`}</span>
                </header>
                <BarChart
                  data={tStats.dynamics}
                  series={[
                    { key: 'total', label: 'Создано', color: '#2563eb' },
                    { key: 'inWork', label: 'В работе', color: '#f59e0b' },
                    { key: 'closed', label: 'Завершено', color: '#16a34a' },
                  ]}
                />
              </section>

              <section className="dash-card dash-card--attention">
                <header className="dash-card-head"><h3>Требует внимания</h3></header>
                <div className="attn-list">
                  <AttentionItem icon="👤" tone="warn" label="Без ответственного" value={tStats.unassigned}
                    hint="назначьте ответственного" onClick={() => setFResp('_unassigned')} />
                  <AttentionItem icon="⚠️" tone="danger" label="Просроченные" value={tStats.overdue}
                    hint="срок процедуры прошёл" />
                  <AttentionItem icon="🕓" tone="muted" label="Не начато" value={tStats.notStarted}
                    hint="ожидают старта процедуры" />
                </div>
              </section>
            </div>

            {/* Компактная summary-таблица по отделам (только реальные отделы) */}
            <section className="report-section">
              <header className="section-head">
                <h3>По отделам</h3>
                <span className="section-meta">нажмите строку для деталей</span>
              </header>
              <table className="dense-table dept-table">
                <thead>
                  <tr>
                    <th>Отдел</th>
                    <th className="num">Всего</th>
                    <th className="num">В работе</th>
                    <th className="num">Завершено</th>
                    <th className="bar-col">Завершение</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { view: 'construction', icon: '🏗️', name: 'Основное строительство', data: tStats.byDept.main_construction, show: fDept === 'all' || fDept === 'main_construction' },
                    { view: 'warranty', icon: '🛡️', name: 'Гарантийный отдел', data: tStats.byDept.warranty_service, show: fDept === 'all' || fDept === 'warranty_service' },
                  ].filter(d => d.show).map(d => (
                    <tr key={d.view} className="dept-row" onClick={() => setTDeptView(d.view)}
                      role="button" tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTDeptView(d.view) } }}>
                      <td>
                        <span className="dept-row-name"><span className="dept-row-ico" aria-hidden>{d.icon}</span>{d.name}</span>
                      </td>
                      <td className="num strong">{d.data.total}</td>
                      <td className="num">{d.data.open}</td>
                      <td className="num accent-success">{d.data.closed}</td>
                      <td className="bar-col"><ProgressBar value={d.data.closed} total={d.data.total} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="report-section">
              {(() => {
                const realResp = tStats.byResponsible.filter(r => r.id !== '_unassigned')
                return (
                  <>
                    <header className="section-head">
                      <h3>По ответственным</h3>
                      <span className="section-meta">{realResp.length}</span>
                    </header>
                    {tStats.unassigned > 0 && (
                      <div className="resp-warning">
                        <span aria-hidden>⚠️</span>
                        <span><strong>{tStats.unassigned}</strong> тендеров без ответственного — требуют назначения</span>
                      </div>
                    )}
                    {realResp.length === 0 ? (
                      <div className="section-empty">Нет назначенных ответственных за период</div>
                    ) : (
                      <ResponsibleTable rows={realResp} />
                    )}
                  </>
                )
              })()}
            </section>
          </>
        )}

        {activeTab === 'tenders' && deptData && (
          <>
            <div className="reports-breadcrumb">
              <button className="reports-back" onClick={() => setTDeptView(null)}>
                ← Все отделы
              </button>
              <span className="reports-breadcrumb-sep">·</span>
              <span className="reports-breadcrumb-current">
                <span aria-hidden style={{ marginRight: '0.375rem' }}>{deptData.icon}</span>
                {deptData.title}
              </span>
            </div>

            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-label">Всего</div>
                <div className="kpi-value">{deptData.total}</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">В работе</div>
                <div className="kpi-value">{deptData.open}</div>
                <div className="kpi-foot">{pct(deptData.open, deptData.total)}% от всех</div>
              </div>
              <div className="kpi-card kpi-card--success">
                <div className="kpi-label">Завершено</div>
                <div className="kpi-value accent-success">{deptData.closed}</div>
                <div className="kpi-foot">{pct(deptData.closed, deptData.total)}% завершения</div>
              </div>
              <div className={`kpi-card ${deptData.unassigned > 0 ? 'kpi-card--warn' : ''}`}>
                <div className="kpi-label">Без ответственного</div>
                <div className={`kpi-value ${deptData.unassigned > 0 ? 'accent-warn' : ''}`}>{deptData.unassigned}</div>
                <div className="kpi-foot">требуют назначения</div>
              </div>
            </div>

            <section className="report-section">
              <header className="section-head">
                <h3>По ответственным</h3>
                <span className="section-meta">{deptData.byResp.length}</span>
              </header>
              {deptData.byResp.length === 0 ? (
                <div className="section-empty">В этом отделе тендеров нет</div>
              ) : (
                <ResponsibleTable rows={deptData.byResp} />
              )}
            </section>
          </>
        )}

        {activeTab === 'winners' && (
          <>
            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-label">Завершённых тендеров с победителем</div>
                <div className="kpi-value">{s.winners.total}</div>
              </div>
              <div className="kpi-card kpi-card--success">
                <div className="kpi-label">Уникальных победителей</div>
                <div className="kpi-value accent-success">{s.winners.unique}</div>
                <div className="kpi-foot">подрядчиков-победителей</div>
              </div>
              <div className="kpi-card kpi-card-wide">
                <div className="kpi-label">Сумма заключённых договоров</div>
                <div className="kpi-value">{fmtMoney(s.winners.totalAmount)}</div>
                <div className="kpi-foot">по победителям тендеров</div>
              </div>
            </div>

            <section className="report-section">
              <header className="section-head">
                <h3>Рейтинг победителей</h3>
                <span className="section-meta">{s.winners.rows.length}</span>
              </header>
              {s.winners.rows.length === 0 ? (
                <div className="section-empty">Победителей пока нет. Назначьте победителя у завершённого тендера.</div>
              ) : (
                <WinnersTable rows={s.winners.rows} fmtMoney={fmtMoney} />
              )}
            </section>
          </>
        )}

        {activeTab === 'materials' && (
          <>
            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-label">Всего тендеров</div>
                <div className="kpi-value">{s.mat.total}</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Не начато</div>
                <div className="kpi-value">{s.mat.notStarted}</div>
                <div className="kpi-foot">{pct(s.mat.notStarted, s.mat.total)}%</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">В работе</div>
                <div className="kpi-value accent-warn">{s.mat.inWork}</div>
                <div className="kpi-foot">{pct(s.mat.inWork, s.mat.total)}%</div>
              </div>
              <div className="kpi-card kpi-card--success">
                <div className="kpi-label">Завершено</div>
                <div className="kpi-value accent-success">{s.mat.closed}</div>
                <div className="kpi-foot">{pct(s.mat.closed, s.mat.total)}% завершения</div>
              </div>
              <div className={`kpi-card ${s.mat.overdue > 0 ? 'kpi-card--danger' : ''}`}>
                <div className="kpi-label">Просрочено (КП)</div>
                <div className={`kpi-value ${s.mat.overdue > 0 ? 'accent-danger' : ''}`}>{s.mat.overdue}</div>
                <div className="kpi-foot">срок предоставления КП прошёл</div>
              </div>
            </div>

            <section className="report-section">
              <header className="section-head">
                <h3>По ответственным</h3>
                <span className="section-meta">{s.mat.byResp.length}</span>
              </header>
              {s.mat.byResp.length === 0 ? (
                <div className="section-empty">Тендеров на материалы пока нет</div>
              ) : (
                <ResponsibleTable rows={s.mat.byResp} />
              )}
            </section>
          </>
        )}

        {activeTab === 'cost_plans' && (
          <>
            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-label">Всего тендеров</div>
                <div className="kpi-value">{s.cp.total}</div>
                <div className="kpi-foot">только основное строительство</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Не начато</div>
                <div className="kpi-value">{s.cp.notStarted}</div>
                <div className="kpi-foot">{pct(s.cp.notStarted, s.cp.total)}%</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">В работе</div>
                <div className="kpi-value accent-warn">{s.cp.inProgress}</div>
                <div className="kpi-foot">{pct(s.cp.inProgress, s.cp.total)}%</div>
              </div>
              <div className="kpi-card kpi-card--success">
                <div className="kpi-label">Завершено</div>
                <div className="kpi-value accent-success">{s.cp.completed}</div>
                <div className="kpi-foot">{pct(s.cp.completed, s.cp.total)}% готовности</div>
              </div>
              <div className={`kpi-card ${s.cp.overdue > 0 ? 'kpi-card--danger' : ''}`}>
                <div className="kpi-label">Просрочено</div>
                <div className={`kpi-value ${s.cp.overdue > 0 ? 'accent-danger' : ''}`}>{s.cp.overdue}</div>
                <div className="kpi-foot">срок плана прошёл</div>
              </div>
            </div>

            <section className="report-section">
              <header className="section-head">
                <h3>По ответственным за план затрат</h3>
                <span className="section-meta">{s.cp.byResp.length}</span>
              </header>
              {s.cp.byResp.length === 0 ? (
                <div className="section-empty">Тендеров основного строительства пока нет</div>
              ) : (
                <ResponsibleTable rows={s.cp.byResp} />
              )}
            </section>
          </>
        )}

        {activeTab === 'vors' && (
          <>
            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-label">Всего тендеров</div>
                <div className="kpi-value">{s.vor.total}</div>
                <div className="kpi-foot">только основное строительство</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">Не начато</div>
                <div className="kpi-value">{s.vor.notStarted}</div>
                <div className="kpi-foot">{pct(s.vor.notStarted, s.vor.total)}%</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">В работе</div>
                <div className="kpi-value accent-warn">{s.vor.inProgress}</div>
                <div className="kpi-foot">{pct(s.vor.inProgress, s.vor.total)}%</div>
              </div>
              <div className="kpi-card kpi-card--success">
                <div className="kpi-label">Завершено</div>
                <div className="kpi-value accent-success">{s.vor.completed}</div>
                <div className="kpi-foot">{pct(s.vor.completed, s.vor.total)}% готовности</div>
              </div>
              <div className={`kpi-card ${s.vor.overdue > 0 ? 'kpi-card--danger' : ''}`}>
                <div className="kpi-label">Просрочено</div>
                <div className={`kpi-value ${s.vor.overdue > 0 ? 'accent-danger' : ''}`}>{s.vor.overdue}</div>
                <div className="kpi-foot">срок ВОР прошёл</div>
              </div>
            </div>

            <section className="report-section">
              <header className="section-head">
                <h3>По ответственным за ВОР</h3>
                <span className="section-meta">{s.vor.byResp.length}</span>
              </header>
              {s.vor.byResp.length === 0 ? (
                <div className="section-empty">Тендеров основного строительства пока нет</div>
              ) : (
                <ResponsibleTable rows={s.vor.byResp} />
              )}
            </section>
          </>
        )}

        {activeTab === 'contracts' && (
          <>
            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-label">Всего договоров</div>
                <div className="kpi-value">{s.cTotal}</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-label">На стадии заключения</div>
                <div className="kpi-value">{s.cPending}</div>
                <div className="kpi-foot">{pct(s.cPending, s.cTotal)}% от всех</div>
              </div>
              <div className="kpi-card kpi-card--success">
                <div className="kpi-label">Заключено</div>
                <div className="kpi-value accent-success">{s.cSigned}</div>
                <div className="kpi-foot">{pct(s.cSigned, s.cTotal)}% заключено</div>
              </div>
              <div className="kpi-card kpi-card-wide">
                <div className="kpi-label">Сумма заключённых</div>
                <div className="kpi-value">{fmtMoney(s.cAmountSigned)}</div>
                <div className="kpi-foot">всего по договорам: {fmtMoney(s.cAmountTotal)}</div>
              </div>
            </div>

            <section className="report-section">
              <header className="section-head">
                <h3>По отделам</h3>
              </header>
              <table className="dense-table">
                <thead>
                  <tr>
                    <th>Отдел</th>
                    <th className="num">На стадии</th>
                    <th className="num">Заключено</th>
                    <th className="num">Всего</th>
                    <th className="num">Сумма</th>
                    <th className="bar-col">Готовность</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Основное строительство</td>
                    <td className="num">{s.cPendingConst}</td>
                    <td className="num">{s.cSignedConst}</td>
                    <td className="num strong">{s.cTotalConst}</td>
                    <td className="num">{fmtMoney(s.cAmountConst)}</td>
                    <td className="bar-col">
                      <ProgressBar value={s.cSignedConst} total={s.cTotalConst} />
                    </td>
                  </tr>
                  <tr>
                    <td>Гарантийный отдел</td>
                    <td className="num">{s.cPendingWar}</td>
                    <td className="num">{s.cSignedWar}</td>
                    <td className="num strong">{s.cTotalWar}</td>
                    <td className="num">{fmtMoney(s.cAmountWar)}</td>
                    <td className="bar-col">
                      <ProgressBar value={s.cSignedWar} total={s.cTotalWar} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </section>
          </>
        )}
      </div>
    </div>
  )
}

// task: donut статусов на чистом SVG (без зависимостей). segments суммируются в total.
function StatusDonut({ total, segments }) {
  const sum = segments.reduce((a, seg) => a + seg.value, 0) || 1
  const R = 54
  const C = 2 * Math.PI * R
  let offset = 0
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 140 140" className="donut-svg" role="img" aria-label="Статусы тендеров">
        <circle cx="70" cy="70" r={R} fill="none" stroke="var(--border-color)" strokeWidth="18" opacity="0.3" />
        {segments.filter(seg => seg.value > 0).map((seg, i) => {
          const len = (seg.value / sum) * C
          const el = (
            <circle key={i} cx="70" cy="70" r={R} fill="none" stroke={seg.color} strokeWidth="18"
              strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset}
              transform="rotate(-90 70 70)" />
          )
          offset += len
          return el
        })}
        <text x="70" y="66" textAnchor="middle" className="donut-num">{total}</text>
        <text x="70" y="86" textAnchor="middle" className="donut-cap">Всего</text>
      </svg>
      <ul className="donut-legend">
        {segments.map((seg, i) => (
          <li key={i}>
            <span className="legend-dot" style={{ background: seg.color }} />
            <span className="legend-label">{seg.label}</span>
            <span className="legend-val">{seg.value}</span>
            <span className="legend-pct">{Math.round((seg.value / sum) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// task: grouped bar chart динамики на чистом SVG (без зависимостей).
// data — [{label,total,inWork,closed}]; series — [{key,label,color}].
function BarChart({ data, series }) {
  const W = 520, H = 190
  const pad = { l: 24, r: 10, t: 22, b: 22 }
  const iw = W - pad.l - pad.r
  const ih = H - pad.t - pad.b
  const max = Math.max(1, ...data.flatMap(d => series.map(se => d[se.key])))
  const n = data.length || 1
  const groupW = iw / n
  const barGap = 3
  const barW = Math.max(4, (groupW * 0.66 - barGap * (series.length - 1)) / series.length)
  const y = (v) => pad.t + (1 - v / max) * ih
  return (
    <div className="bars-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="bars-svg" role="img" aria-label="Динамика тендеров">
        {[0, 0.5, 1].map((g) => {
          const yy = pad.t + g * ih
          return <line key={g} x1={pad.l} x2={W - pad.r} y1={yy} y2={yy} stroke="var(--border-color)" strokeWidth="1" opacity="0.45" />
        })}
        {data.map((d, i) => {
          const gx = pad.l + i * groupW + (groupW - (barW * series.length + barGap * (series.length - 1))) / 2
          return (
            <g key={i}>
              {series.map((se, j) => {
                const v = d[se.key]
                const bx = gx + j * (barW + barGap)
                const by = y(v)
                return (
                  <g key={se.key}>
                    <rect x={bx} y={by} width={barW} height={Math.max(0, pad.t + ih - by)} rx="2" fill={se.color} />
                    {v > 0 && <text x={bx + barW / 2} y={by - 3} textAnchor="middle" className="bar-val" fill={se.color}>{v}</text>}
                  </g>
                )
              })}
              <text x={pad.l + i * groupW + groupW / 2} y={H - 6} textAnchor="middle" className="bar-x">{d.label}</text>
            </g>
          )
        })}
      </svg>
      <ul className="bars-legend">
        {series.map(se => (
          <li key={se.key}><span className="legend-dot" style={{ background: se.color }} />{se.label}</li>
        ))}
      </ul>
    </div>
  )
}

// task: action-item «требует внимания» — кликабельный (применяет фильтр) с шевроном.
function AttentionItem({ icon, tone, label, value, hint, onClick }) {
  return (
    <button type="button" className={`attn-item attn-item--${tone}${onClick ? ' is-clickable' : ''}`}
      onClick={onClick} disabled={!onClick}>
      <span className="attn-ico" aria-hidden>{icon}</span>
      <div className="attn-body">
        <div className="attn-label">{label}</div>
        <div className="attn-hint">{hint}</div>
      </div>
      <div className="attn-val">{value}</div>
      {onClick && <span className="attn-chev" aria-hidden>›</span>}
    </button>
  )
}

function ResponsibleTable({ rows }) {
  return (
    <table className="dense-table">
      <thead>
        <tr>
          <th className="num" style={{ width: '40px' }}>#</th>
          <th>Ответственный</th>
          <th className="num">В работе</th>
          <th className="num">Завершено</th>
          <th className="num">Всего</th>
          <th className="bar-col">Завершение</th>
        </tr>
      </thead>
      <tbody>
        {/* «Не назначен» исключаем из таблицы сотрудников — он показан плашкой выше. */}
        {rows.filter(r => r.id !== '_unassigned').map((r, idx) => (
          <tr key={r.id}>
            <td className="num muted">{idx + 1}</td>
            <td>{r.name}</td>
            <td className="num">{r.inWork}</td>
            <td className="num">{r.completed}</td>
            <td className="num strong">{r.total}</td>
            <td className="bar-col">
              <ProgressBar value={r.completed} total={r.total} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function WinnersTable({ rows, fmtMoney }) {
  const maxWins = Math.max(...rows.map(r => r.wins), 1)
  return (
    <table className="dense-table">
      <thead>
        <tr>
          <th style={{ width: '44px' }} className="num">#</th>
          <th>Контрагент</th>
          <th className="num">Побед</th>
          <th className="num">Стр-во</th>
          <th className="num">Гарантия</th>
          <th className="num">Договоров</th>
          <th className="num">Сумма</th>
          <th className="bar-col">Доля побед</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, idx) => (
          <tr key={r.id}>
            <td className="num" style={{ fontWeight: 600, color: idx < 3 ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
              {idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : idx + 1}
            </td>
            <td style={{ fontWeight: 500 }}>{r.name}</td>
            <td className="num strong">{r.wins}</td>
            <td className="num">{r.winsConst || '—'}</td>
            <td className="num">{r.winsWar || '—'}</td>
            <td className="num">{r.signedContracts || '—'}</td>
            <td className="num">{r.signedAmount > 0 ? fmtMoney(r.signedAmount) : '—'}</td>
            <td className="bar-col">
              <ProgressBar value={r.wins} total={maxWins} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ProgressBar({ value, total }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div className="bar-with-pct">
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="bar-pct">{pct}%</span>
    </div>
  )
}

export default ReportsPage
