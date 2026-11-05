import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { db } from '../api'
import { useRole } from '../contexts/RoleContext'
import { fetchAllRows } from '../utils/fetchAllRows'
import { downloadS3File } from '../components/FileDownload'
import { buildProposalWorkbook, matchProposalRows } from '../utils/contractorProposal'
import S3DocumentPreview from '../components/S3DocumentPreview'
import ClampText from '../components/ClampText'
import IconTile from '../components/IconTile'
import PersonName from '../components/PersonName'
import { IconHardHat, IconChevronDown } from '../components/icons/TenderHubIcons'
import { IconSearch } from '../components/icons/ToolbarIcons'
import { loadCabinetTenders, requestParticipation, setParticipationStatus } from '../services/contractorBids'
import { phoneHref } from '../utils/siteContacts'
import { breakAfterDash, formatDateRange } from '../utils/dateRange'
import '../components/Tenders.css'
import '../components/TendersRegistryPolish.css'
import '../styles/fonts.css'
import '../styles/workUi.css'
import './ContractorCabinetPage.css'

const BidWorkspace = lazy(() => import('../components/contractor/BidWorkspace'))
const ContractorCompanyTab = lazy(() => import('../components/contractor/ContractorCompanyTab'))

// Кабинет подрядчика: идущие тендеры и своя компания.
//
// Решения пользователя 03.11.2026: раздела договоров нет, истории участия нет — только тендеры, по которым идёт приём;
// список — как реестр «Тендеры — Основное строительство» (те же стили .tenders-page.ui-work.tp-dense), без того, что подрядчику
// видеть нельзя: участников и КП, ВОРов и РД, плана затрат, тендера на материалы, сводной КП, примечаний. Тендер открывается
// заметной кнопкой «Открыть тендер» (адрес ?tender=<id>, назад — кнопкой браузера): его документы, расценка и анкета.
//
// Тендеры (миграция 20261102): открытые — как на /public/tenders — и те, где организация участник или подала заявку
// (bid_contractor_tenders); функция отдаёт и прошлые, страница их отбрасывает (isCurrentTender). Расценивать на сайте может
// участник или подавший заявку; участником делает инженер. Без миграции — как раньше: только приглашения.
//
// Организация берётся из user_roles.counterparty_id (RoleContext), а не из выбора на форме входа. Доступ к данным ограничен
// политиками БД (миграции 20260913/20260914) — интерфейс не «прячет чужое», его просто не отдают. Сведения о тендерах и
// организации — функциями с перечнем полей (миграция 20261201): правило по строкам колонки не ограничивает.
//
// Подрядчик, зарегистрировавшийся на сайте (contractorInfo.selfRegistered, миграции 20261203 и 20261204): только тендеры, расценка
// и своя компания. Файлов, сметы и загрузки КП нет — сервер их не отдаёт, интерфейс их и не запрашивает.

// Идёт приём предложений — то же условие, что bid_tender_open в базе.
const TENDER_OPEN_STATUS = 'Идет тендерная процедура'

const PARTICIPATION_LABEL = {
  request_sent: 'Приглашение отправлено',
  proposal_provided: 'КП загружено',
  accepted_for_work: 'Принято в работу',
  declined: 'Отказ от участия',
}
const PARTICIPATION_CLASS = {
  request_sent: 'is-wait',
  proposal_provided: 'is-done',
  accepted_for_work: 'is-done',
  declined: 'is-off',
}

// Доступ организации к тендеру (bid_access): участник, заявка с сайта или ничего.
const ACCESS_LABEL = {
  invited: 'Участник',
  accepted: 'Участник',
  pending: 'Заявка на рассмотрении',
  rejected: 'Заявка отклонена',
}
const ACCESS_CLASS = { invited: 'is-done', accepted: 'is-done', pending: 'is-wait', rejected: 'is-off' }
const CAN_PRICE = new Set(['invited', 'pending', 'accepted'])

// Строка bid_contractor_tenders → вид тендера кабинета (как прежние приглашения).
const fromCabinetRow = (r) => ({
  id: r.id,
  public_tender_number: r.public_tender_number,
  work_description: r.work_description,
  status: r.tender_status,
  tender_start_date: r.tender_start_date,
  tender_end_date: r.tender_end_date,
  start_date: r.start_date,
  end_date: r.end_date,
  tender_package_link: r.tender_package_link,
  objects: { name: r.object_name, address: r.object_address },
  responsible_name: r.responsible_name,
  responsible_phone: r.responsible_phone,
  participationStatus: r.invite_status,
  access: r.access,
  isOpen: r.is_open,
  pricedCount: r.priced_count,
  pricedTotal: r.priced_total == null ? 0 : Number(r.priced_total),
})
const isHttp = (url) => /^https?:\/\//i.test(String(url || '').trim())
// Без функции кабинета (база раньше миграции, просмотр от имени роли) признака нет — по статусу тендера.
const isCurrentTender = (t) => t.isOpen ?? t.status === TENDER_OPEN_STATUS

// Плашка участия в строке реестра и в шапке тендера.
function participationChip(tender, bidsEnabled) {
  if (!bidsEnabled || tender.participationStatus === 'declined') {
    return tender.participationStatus
      ? { label: PARTICIPATION_LABEL[tender.participationStatus] || tender.participationStatus, cls: PARTICIPATION_CLASS[tender.participationStatus] || '' }
      : null
  }
  return tender.access ? { label: ACCESS_LABEL[tender.access], cls: ACCESS_CLASS[tender.access] || '' } : null
}

// Поиск реестра: №, объект, адрес, описание — как у сотрудника.
const tenderSearchText = (t) => [t.public_tender_number, t.objects?.name, t.objects?.address, t.work_description]
  .map((v) => String(v ?? '').toLowerCase().replace(/ё/g, 'е')).join(' ')
const SORTERS = {
  public_tender_number: (t) => t.public_tender_number,
  tender_end_date: (t) => t.tender_end_date,
}

const DOC_SECTION_LABEL = {
  tender_package: 'Тендерный пакет',
  rd: 'Рабочая документация',
  vor_statement: 'Ведомость объёмов работ',
  vor: 'ВОР и рабочая документация',
}

function formatDateTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.toLocaleDateString('ru-RU')}, ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
}
function formatBytes(n) {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} Б`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} КБ`
  return `${(n / 1024 / 1024).toFixed(1)} МБ`
}
// Сколько дней осталось до даты (отрицательное — просрочено).
function daysLeft(dateStr) {
  if (!dateStr) return null
  const end = new Date(dateStr)
  if (Number.isNaN(end.getTime())) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  end.setHours(0, 0, 0, 0)
  return Math.round((end - today) / 86400000)
}

function ContractorCabinetPage() {
  const navigate = useNavigate()
  const { contractorInfo, isContractor, userProfile, logout } = useRole()
  const [searchParams, setSearchParams] = useSearchParams()

  const selfRegistered = contractorInfo?.selfRegistered === true
  const tab = searchParams.get('tab') === 'company' ? 'company' : 'tenders'
  const setTab = (next) => setSearchParams(next === 'tenders' ? {} : { tab: next }, { replace: true })
  // Открытый тендер — в адресе: кнопка «назад» браузера возвращает к реестру, ссылку можно открыть в новой вкладке.
  const activeTenderId = tab === 'tenders' ? searchParams.get('tender') : null

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  // Тендеры
  const [invitations, setInvitations] = useState([])
  const [estimateItems, setEstimateItems] = useState([])
  const [tenderDocs, setTenderDocs] = useState([])
  const [tenderBusy, setTenderBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadNote, setUploadNote] = useState(null)   // { kind: 'ok'|'warn', text }

  // Реестр: вкладка, поиск, сортировка, раскрытые адреса (как в реестре сотрудника).
  const [onlyMine, setOnlyMine] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [sort, setSort] = useState({ key: 'tender_end_date', dir: 'asc' })
  const [openAddressIds, setOpenAddressIds] = useState(() => new Set())

  const [previewDoc, setPreviewDoc] = useState(null)

  const cpId = contractorInfo?.id || null
  const [bidsEnabled, setBidsEnabled] = useState(false)
  const [joining, setJoining] = useState(false)

  // Тендеры кабинета: открытые + свои (миграция 20261102), без неё — только приглашения. Отказ 42501 — просмотр
  // от имени роли (запросы идут под администратором, у него нет организации): тогда тоже приглашения.
  const loadTenderList = useCallback(async () => {
    try {
      const rows = await loadCabinetTenders()
      if (rows) return { list: rows.map(fromCabinetRow), bids: true }
    } catch (err) {
      if (err?.code !== '42501' || selfRegistered) throw err
    }
    const { data, error } = await db
      .from('tender_counterparties')
      .select('tender_id, status, tenders(id, public_tender_number, work_description, status, tender_start_date, tender_end_date, start_date, end_date, objects(name, address))')
      .eq('counterparty_id', cpId)
    if (error) throw error
    const list = (data || [])
      .filter(p => p.tenders)
      .map(p => ({ ...p.tenders, participationStatus: p.status, access: 'invited' }))
      .sort((a, b) => (b.tender_end_date || '').localeCompare(a.tender_end_date || ''))
    return { list, bids: false }
  }, [cpId, selfRegistered])

  // ── Загрузка: идущие тендеры организации; прошлые в кабинете не показываются ──
  const loadAll = useCallback(async () => {
    if (!cpId) { setLoading(false); return }
    setLoading(true)
    setLoadError('')
    try {
      const tenderList = await loadTenderList()
      setBidsEnabled(tenderList.bids)
      setInvitations(tenderList.list.filter(isCurrentTender))
    } catch (err) {
      console.error('Кабинет подрядчика:', err)
      setLoadError(err.message || 'Не удалось загрузить данные кабинета.')
    } finally {
      setLoading(false)
    }
  }, [cpId, loadTenderList])

  useEffect(() => { loadAll() }, [loadAll])
  // Итог загрузки КП относится к открытому тендеру.
  useEffect(() => { setUploadNote(null) }, [activeTenderId])

  // ── Выбранный тендер: смета, документы, дата загрузки КП ──────────────────
  const activeTender = useMemo(
    () => invitations.find(t => t.id === activeTenderId) || null,
    [invitations, activeTenderId])

  // Файлы и смета — только тендера, к которому у организации есть доступ (участник или заявка).
  const activeAccess = activeTender?.access || null
  const loadTenderDetails = useCallback(async () => {
    if (selfRegistered || !activeTenderId || !cpId || !activeAccess || activeAccess === 'rejected') { setEstimateItems([]); setTenderDocs([]); return }
    setTenderBusy(true)
    try {
      const [items, docs, lastProposal] = await Promise.all([
        fetchAllRows((from, to) => db
          .from('tender_estimate_items')
          .select('*')
          .eq('tender_id', activeTenderId)
          .order('row_number', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to)),
        db
          .from('s3_documents')
          .select('id, owner_id, doc_category, file_name, s3_key, mime_type, size_bytes, created_at')
          .eq('owner_type', 'tender')
          .eq('owner_id', activeTenderId)
          .in('doc_category', ['tender_package', 'rd', 'vor_statement', 'vor'])
          .order('created_at', { ascending: false }),
        db
          .from('tender_counterparty_proposals')
          .select('created_at')
          .eq('tender_id', activeTenderId)
          .eq('counterparty_id', cpId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])
      setEstimateItems(items || [])
      setTenderDocs(docs.data || [])
      setInvitations(prev => prev.map(t => t.id === activeTenderId
        ? { ...t, uploadedAt: lastProposal?.data?.created_at || null }
        : t))
    } catch (err) {
      console.error('Загрузка тендера:', err)
    } finally {
      setTenderBusy(false)
    }
  }, [activeTenderId, cpId, activeAccess, selfRegistered])

  useEffect(() => { loadTenderDetails() }, [loadTenderDetails])

  // ── Действия ──────────────────────────────────────────────────────────────
  const pricedItems = useMemo(() => estimateItems.filter(i => !i.is_section), [estimateItems])

  const handleDownloadTemplate = () => {
    if (!activeTender || estimateItems.length === 0) return
    const { workbook, fileName } = buildProposalWorkbook(estimateItems, {
      tenderName: activeTender.objects?.name || `Тендер ${activeTender.public_tender_number || ''}`.trim(),
      counterpartyName: contractorInfo?.name || '',
    })
    XLSX.writeFile(workbook, fileName)
  }

  const handleDownloadDoc = async (doc) => {
    try {
      await downloadS3File(doc.s3_key, doc.file_name)
    } catch (err) {
      alert('Не удалось скачать файл: ' + (err.message || err))
    }
  }

  const handleUploadProposal = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !activeTender || !cpId) return
    setUploading(true)
    setUploadNote(null)
    try {
      const buffer = await file.arrayBuffer()
      const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const excelData = XLSX.utils.sheet_to_json(sheet, { header: 1 })

      const { rows, skippedAmbiguous } = matchProposalRows(excelData, estimateItems)

      if (rows.length === 0) {
        setUploadNote({
          kind: 'warn',
          text: skippedAmbiguous > 0
            ? 'В файле нет служебного столбца «ID (не изменять)», а в тендере несколько ВОРов — определить позиции невозможно. Скачайте шаблон на этой странице и заполните его.'
            : 'В файле не нашлось ни одной позиции из ВОР этого тендера. Заполните шаблон, скачанный на этой странице.',
        })
        return
      }

      // Перезагрузка КП заменяет предыдущее целиком.
      await db
        .from('tender_counterparty_proposals')
        .delete()
        .eq('tender_id', activeTender.id)
        .eq('counterparty_id', cpId)

      const payload = rows.map(r => ({ ...r, tender_id: activeTender.id, counterparty_id: cpId }))
      const { error } = await db.from('tender_counterparty_proposals').insert(payload)
      if (error) throw error

      // Статус участия — значение ENUM tender_counterparty_status.
      await setParticipationStatus(activeTender.id, cpId, 'proposal_provided')
        .catch((statusError) => console.error('Статус участия:', statusError.message))

      setUploadNote({
        kind: skippedAmbiguous > 0 ? 'warn' : 'ok',
        text: skippedAmbiguous > 0
          ? `Загружено позиций: ${rows.length}. Пропущено строк: ${skippedAmbiguous} — их не удалось привязать к позициям ВОР.`
          : `Коммерческое предложение принято: ${rows.length} позиций.`,
      })
      await loadAll()
      await loadTenderDetails()
    } catch (err) {
      console.error('Загрузка КП:', err)
      setUploadNote({
        kind: 'warn',
        text: err?.code === '42501'
          ? 'Не удалось загрузить КП: приём предложений по этому тендеру закрыт.'
          : 'Не удалось загрузить КП: ' + (err.message || err),
      })
    } finally {
      setUploading(false)
    }
  }

  const handleDecline = async () => {
    if (!activeTender || !cpId) return
    if (!window.confirm('Отказаться от участия в этом тендере? Отметку увидит отдел сопровождения подрядчиков.')) return
    try {
      await setParticipationStatus(activeTender.id, cpId, 'declined')
      await loadAll()
    } catch (err) {
      alert('Не удалось изменить статус: ' + (err.message || err))
    }
  }

  // Участвовать в открытом тендере: заявка с сайта (инженер решит, сделать ли участником), расценка — сразу.
  const handleJoin = async () => {
    if (!activeTender || joining) return
    setJoining(true)
    try {
      const access = await requestParticipation(activeTender.id)
      setInvitations(prev => prev.map(t => (t.id === activeTender.id ? { ...t, access } : t)))
    } catch (err) {
      alert('Не удалось подать заявку: ' + (err.message || err))
    } finally {
      setJoining(false)
    }
  }

  // Сводка расценки из рабочего места — в карточку списка без перечитывания.
  const handleBidSummary = useCallback(({ priced, total }) => {
    setInvitations(prev => prev.map(t => (t.id === activeTenderId && (t.pricedCount !== priced || t.pricedTotal !== total)
      ? { ...t, pricedCount: priced, pricedTotal: total } : t)))
  }, [activeTenderId])

  const tenderNumbers = useMemo(() => new Map(invitations.map(t => [t.id, t.public_tender_number])), [invitations])

  const mineCount = useMemo(() => invitations.filter(t => t.access || t.participationStatus).length, [invitations])
  const registryRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase().replace(/ё/g, 'е')
    const rows = invitations.filter(t => (!onlyMine || t.access || t.participationStatus) && (!q || tenderSearchText(t).includes(q)))
    const value = SORTERS[sort.key]
    const sign = sort.dir === 'asc' ? 1 : -1
    // Пустое значение — в конце при любом направлении.
    return [...rows].sort((a, b) => {
      const av = value(a)
      const bv = value(b)
      if (av == null || av === '') return bv == null || bv === '' ? 0 : 1
      if (bv == null || bv === '') return -1
      return av < bv ? -sign : av > bv ? sign : 0
    })
  }, [invitations, onlyMine, searchQuery, sort])

  const toggleSort = (key) => setSort(prev => ({ key, dir: prev.key === key && prev.dir === 'asc' ? 'desc' : 'asc' }))
  const sortIndicator = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '')
  const toggleAddress = (id) => setOpenAddressIds(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const tenderHref = (id) => `?tender=${encodeURIComponent(id)}`

  const handleLogout = async () => {
    await logout()
    navigate('/partner')
  }

  if (!isContractor) return null

  const docsBySection = tenderDocs.reduce((acc, d) => {
    const key = d.doc_category || 'tender_package'
    ;(acc[key] = acc[key] || []).push(d)
    return acc
  }, {})

  const deadline = daysLeft(activeTender?.tender_end_date)
  const activeChip = activeTender ? participationChip(activeTender, bidsEnabled) : null

  return (
    <div className="cab-page">
      <header className="cab-header">
        <div className="cab-brand">
          <span className="cab-logo">СУ_10</span>
          <div className="cab-brand-text">
            <span className="cab-title">Кабинет подрядчика</span>
            <span className="cab-company">{contractorInfo?.name || '—'}</span>
          </div>
        </div>
        <div className="cab-header-right">
          {userProfile?.full_name && <span className="cab-user">{userProfile.full_name}</span>}
          <button type="button" className="cab-logout" onClick={handleLogout}>Выйти</button>
        </div>
      </header>

      <nav className="cab-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'tenders'}
          className={`cab-tab${tab === 'tenders' ? ' is-active' : ''}`}
          onClick={() => setTab('tenders')}
        >
          Тендеры
          {invitations.length > 0 && <span className="cab-tab-count">{invitations.length}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'company'}
          className={`cab-tab${tab === 'company' ? ' is-active' : ''}`}
          onClick={() => setTab('company')}
        >
          Моя компания
        </button>
      </nav>

      {loading ? (
        <div className="cab-state">Загрузка…</div>
      ) : loadError ? (
        <div className="cab-state cab-state-error">{loadError}</div>
      ) : tab === 'company' ? (
        <Suspense fallback={<div className="cab-state">Загрузка…</div>}>
          <ContractorCompanyTab />
        </Suspense>
      ) : activeTenderId ? (
        <main className="cab-main cab-tender">
          <Link to="/contractor" className="cab-back">← Все тендеры</Link>
          {!activeTender ? (
            <div className="cab-state">Этот тендер недоступен: приём предложений по нему закрыт.</div>
          ) : (
                <>
                  <div className="cab-head-block">
                    <div className="cab-head-top">
                      <span className="cab-card-num">
                        {activeTender.public_tender_number ? `Тендер № ${activeTender.public_tender_number}` : 'Тендер'}
                      </span>
                      {activeChip && <span className={`cab-chip ${activeChip.cls}`}>{activeChip.label}</span>}
                    </div>
                    <h2>{activeTender.objects?.name || 'Объект не указан'}</h2>
                    <p className="cab-work">{activeTender.work_description}</p>
                    <div className="cab-facts">
                      <span><b>Приём КП:</b> {formatDateRange(activeTender.tender_start_date, activeTender.tender_end_date) || '—'}</span>
                      {deadline != null && (
                        <span className={deadline < 0 ? 'cab-late' : deadline <= 3 ? 'cab-soon' : undefined}>
                          {deadline < 0 ? 'Срок подачи истёк' : `Осталось дней: ${deadline}`}
                        </span>
                      )}
                      {activeTender.objects?.address && <span><b>Адрес:</b> {activeTender.objects.address}</span>}
                      {activeTender.responsible_name && (
                        <span>
                          <b>Ответственный:</b> {activeTender.responsible_name}
                          {activeTender.responsible_phone && (
                            <>, {phoneHref(activeTender.responsible_phone)
                              ? <a href={phoneHref(activeTender.responsible_phone)}>{activeTender.responsible_phone}</a>
                              : activeTender.responsible_phone}</>
                          )}
                        </span>
                      )}
                      {isHttp(activeTender.tender_package_link) && (
                        <span><a href={activeTender.tender_package_link.trim()} target="_blank" rel="noopener noreferrer">Тендерный пакет</a></span>
                      )}
                      {activeTender.uploadedAt && <span><b>КП загружено:</b> {formatDateTime(activeTender.uploadedAt)}</span>}
                    </div>
                  </div>

                  {/* Участие: открытый тендер без заявки — «Участвовать»; заявка — что дальше. */}
                  {bidsEnabled && !activeTender.access && (
                    <section className="cab-section cab-join">
                      <div className="cab-step-text">
                        <b>Хотите участвовать?</b>
                        <span>
                          {selfRegistered ? 'Откроется расценка на сайте.' : 'Откроются файлы ВОР и расценка на сайте.'} Отдел увидит вашу организацию и решит, включить ли
                          её в участники тендера.
                        </span>
                      </div>
                      <button type="button" className={`cab-btn cab-btn-primary${joining ? ' is-busy' : ''}`} disabled={joining} onClick={handleJoin}>
                        {joining ? 'Подаём заявку…' : 'Участвовать и расценить'}
                      </button>
                    </section>
                  )}
                  {bidsEnabled && activeTender.access === 'pending' && (
                    <div className="cab-note is-ok">
                      Заявка подана: отдел решит, включить ли вашу организацию в участники. Расценивать можно уже сейчас —
                      цены сохраняются сами и сразу видны отделу.
                    </div>
                  )}
                  {bidsEnabled && activeTender.access === 'rejected' && (
                    <div className="cab-note is-warn">
                      Отдел не включил вашу организацию в участники этого тендера. Введённые цены сохранены, менять их нельзя.
                    </div>
                  )}

                  {/* Документы тендера: пакет и ВОР/РД */}
                  {!selfRegistered && activeTender.access && activeTender.access !== 'rejected' && (
                  <section className="cab-section">
                    <h3>Документы тендера</h3>
                    {tenderBusy && tenderDocs.length === 0 ? (
                      <p className="cab-muted">Загрузка…</p>
                    ) : tenderDocs.length === 0 ? (
                      <p className="cab-muted">Документы ещё не опубликованы.</p>
                    ) : (
                      Object.entries(docsBySection).map(([cat, docs]) => (
                        <div key={cat} className="cab-docs-group">
                          <div className="cab-docs-title">{DOC_SECTION_LABEL[cat] || cat}</div>
                          <ul className="cab-docs">
                            {docs.map(d => {
                              const mime = (d.mime_type || '').toLowerCase()
                              const canPreview = mime === 'application/pdf' || mime.startsWith('image/')
                              return (
                                <li key={d.id} className="cab-doc">
                                  <span className="cab-doc-name" title={d.file_name}>{d.file_name}</span>
                                  <span className="cab-doc-meta">{formatBytes(d.size_bytes)}</span>
                                  {canPreview && (
                                    <button type="button" className="cab-doc-btn" onClick={() => setPreviewDoc(d)}>Открыть</button>
                                  )}
                                  <button type="button" className="cab-doc-btn" onClick={() => handleDownloadDoc(d)}>Скачать</button>
                                </li>
                              )
                            })}
                          </ul>
                        </div>
                      ))
                    )}
                  </section>
                  )}

                  {/* Расценка ВОР на сайте */}
                  {bidsEnabled && activeTender.access && (
                    <section className="cab-section">
                      <h3>Расценка</h3>
                      <Suspense fallback={<p className="cab-muted">Загрузка расценки…</p>}>
                        <BidWorkspace
                          key={activeTender.id}
                          tender={{ ...activeTender, object_name: activeTender.objects?.name }}
                          canEdit={CAN_PRICE.has(activeTender.access)}
                          counterpartyName={contractorInfo?.name || ''}
                          tenderNumbers={tenderNumbers}
                          onSummary={handleBidSummary}
                          serverPositions={selfRegistered}
                        />
                      </Suspense>
                    </section>
                  )}

                  {/* Подача КП по шаблону — прежний путь: смета во вкладке «ВОР» карточки (в новых тендерах её нет) */}
                  {(!bidsEnabled || pricedItems.length > 0) && activeTender.access === 'invited' && (
                  <section className="cab-section">
                    <h3>Коммерческое предложение</h3>
                    {pricedItems.length === 0 ? (
                      <p className="cab-muted">Смета тендера ещё не опубликована — шаблон появится позже.</p>
                    ) : (
                      <>
                        <ol className="cab-steps">
                          <li>
                            <div className="cab-step-text">
                              <b>Скачайте шаблон</b>
                              <span>Excel со сметой тендера — {pricedItems.length} позиций. Заполните два столбца с ценами.</span>
                            </div>
                            <button type="button" className="cab-btn" onClick={handleDownloadTemplate}>Скачать шаблон</button>
                          </li>
                          <li>
                            <div className="cab-step-text">
                              <b>Загрузите заполненный файл</b>
                              <span>Повторная загрузка полностью заменяет предыдущее предложение.</span>
                            </div>
                            <label className={`cab-btn cab-btn-primary${uploading ? ' is-busy' : ''}`}>
                              {uploading ? 'Загрузка…' : 'Загрузить КП'}
                              <input type="file" accept=".xlsx,.xls" hidden disabled={uploading} onChange={handleUploadProposal} />
                            </label>
                          </li>
                        </ol>
                        {uploadNote && (
                          <div className={`cab-note ${uploadNote.kind === 'ok' ? 'is-ok' : 'is-warn'}`}>{uploadNote.text}</div>
                        )}
                        <p className="cab-hint">
                          Не меняйте порядок столбцов и не удаляйте служебный столбец «ID (не изменять)» —
                          по нему цены возвращаются на свои позиции.
                        </p>
                      </>
                    )}
                  </section>
                  )}

                  {/* Состав сметы — первые позиции, чтобы понять объём работ */}
                  {pricedItems.length > 0 && (
                    <section className="cab-section">
                      <h3>Состав работ ({pricedItems.length})</h3>
                      <div className="cab-table-wrap">
                        <table className="cab-table">
                          <thead>
                            <tr><th>№</th><th>Наименование</th><th>Ед.</th><th className="num">Объём</th></tr>
                          </thead>
                          <tbody>
                            {pricedItems.slice(0, 15).map(i => (
                              <tr key={i.id}>
                                <td>{i.row_number}</td>
                                <td>{i.cost_name}</td>
                                <td>{i.unit || '—'}</td>
                                <td className="num">{i.work_volume ?? '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {pricedItems.length > 15 && (
                        <p className="cab-muted">…и ещё {pricedItems.length - 15} позиций — полный список в шаблоне.</p>
                      )}
                    </section>
                  )}

                  {!selfRegistered && activeTender.access === 'invited' && activeTender.participationStatus && activeTender.participationStatus !== 'declined' && (
                    <div className="cab-decline">
                      <button type="button" className="cab-btn cab-btn-ghost" onClick={handleDecline}>
                        Отказаться от участия
                      </button>
                    </div>
                  )}
                </>
          )}
        </main>
      ) : invitations.length === 0 ? (
        <div className="cab-state">
          {bidsEnabled
            ? 'Открытых тендеров сейчас нет. Как только отдел объявит тендер, он появится здесь.'
            : 'Приглашений в тендеры пока нет. Как только вас пригласят, тендер появится здесь.'}
        </div>
      ) : (
        <div className="tenders-page ui-work tp-dense cab-registry">
          <div className="page-header page-header-tenders hdr-tone--sky">
            <h2>
              <IconTile tone="sky" className="page-icon-tile"><IconHardHat size={17} /></IconTile>
              Открытые тендеры
            </h2>
          </div>
          <div className="tender-tabs">
            <button type="button" className={`tender-tab ${!onlyMine ? 'active' : ''}`} onClick={() => setOnlyMine(false)}>
              Все тендеры
              <span className="tender-tab-count">{invitations.length}</span>
            </button>
            <button type="button" className={`tender-tab ${onlyMine ? 'active' : ''}`} onClick={() => setOnlyMine(true)}>
              Участвую
              {mineCount > 0 && <span className="tender-tab-count">{mineCount}</span>}
            </button>
          </div>
          <div className="tp-filters">
            <div className="tenders-search-wrap ui-search">
              <IconSearch />
              <input
                type="search"
                className="tp-search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="№, объект, адрес, описание"
                aria-label="Поиск по номеру тендера, объекту, адресу и описанию работ"
              />
            </div>
          </div>
          <div className="table-container">
            <table className="data-table tenders-registry tp-grid">
              <colgroup>
                <col className="tp-c-num" />
                <col className="tp-c-object" />
                <col className="tp-c-desc" />
                <col className="tp-c-status" />
                <col className="tp-c-period" />
                <col className="cab-c-works" />
                <col className="tp-c-resp" />
                <col className="tp-c-package" />
                <col className="cab-c-open" />
              </colgroup>
              <thead>
                <tr>
                  <th className="sortable-th" onClick={() => toggleSort('public_tender_number')} title="Номер тендера. Нажмите для сортировки">
                    №{sortIndicator('public_tender_number')}
                  </th>
                  <th>Объект</th>
                  <th>Описание работ</th>
                  <th>Ваше участие</th>
                  <th className="sortable-th" onClick={() => toggleSort('tender_end_date')} title="Приём предложений. Нажмите для сортировки">
                    Срок тендерных<br />процедур{sortIndicator('tender_end_date')}
                  </th>
                  <th>Срок<br />работ</th>
                  <th>Ответственный<br />по тендеру</th>
                  <th>Тендерный<br />пакет</th>
                  <th><span className="ui-sr-only">Открыть</span></th>
                </tr>
              </thead>
              <tbody>
                {registryRows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="no-data">
                      {searchQuery.trim() ? 'По запросу ничего не найдено.' : 'Вы пока не участвуете в открытых тендерах.'}
                    </td>
                  </tr>
                ) : registryRows.map(t => {
                  const left = daysLeft(t.tender_end_date)
                  const chip = participationChip(t, bidsEnabled)
                  const number = t.public_tender_number ?? '—'
                  const phone = t.responsible_phone
                  const works = formatDateRange(t.start_date, t.end_date)
                  return (
                    <tr key={t.id} className={left != null && left < 0 ? 'overdue-row' : ''}>
                      <td className="tp-num" data-label="№">{number}</td>
                      <td data-label="Объект">
                        <span className="row-link primary cab-object">{t.objects?.name || 'Объект не указан'}</span>
                        {t.objects?.address ? (
                          <>
                            <button
                              type="button"
                              className={`tp-addr-toggle${openAddressIds.has(t.id) ? ' is-open' : ''}`}
                              aria-expanded={openAddressIds.has(t.id)}
                              aria-controls={`cab-addr-${t.id}`}
                              onClick={() => toggleAddress(t.id)}
                            >
                              <IconChevronDown size={12} />
                              {openAddressIds.has(t.id) ? 'Скрыть адрес' : 'Показать адрес'}
                            </button>
                            <div id={`cab-addr-${t.id}`} className="tp-addr-block" hidden={!openAddressIds.has(t.id)}>
                              <div className="tp-obj-address">{t.objects.address}</div>
                            </div>
                          </>
                        ) : null}
                      </td>
                      <td className="tender-desc-cell" data-label="Описание работ">
                        <ClampText
                          text={t.work_description}
                          empty=""
                          wrap={(body) => (
                            <Link to={tenderHref(t.id)} className="row-link primary tender-desc-link ui-title-link">{body}</Link>
                          )}
                        />
                      </td>
                      <td data-label="Ваше участие">
                        {chip
                          ? <span className={`cab-chip ${chip.cls}`}>{chip.label}</span>
                          : <span className="cab-muted">Не участвуете</span>}
                        {t.pricedCount > 0 && <div className="cab-priced">расценено {t.pricedCount}</div>}
                      </td>
                      <td className={`tender-period-cell ui-num${left != null && left < 0 ? ' is-overdue' : ''}`} data-label="Срок тендерных процедур">
                        {breakAfterDash(formatDateRange(t.tender_start_date, t.tender_end_date)) || '—'}
                        {left != null && left >= 0 && left <= 3 && <div className="cab-soon">осталось {left} дн.</div>}
                      </td>
                      <td className="ui-num" data-label="Срок работ">{breakAfterDash(works) || '—'}</td>
                      <td data-label="Ответственный">
                        {t.responsible_name ? <PersonName full={t.responsible_name} /> : <span className="tp-dash">—</span>}
                        {phone && (
                          <div className="tp-sub-line ui-num">
                            {phoneHref(phone) ? <a href={phoneHref(phone)} className="link">{phone}</a> : phone}
                          </div>
                        )}
                      </td>
                      <td data-label="Тендерный пакет">
                        {isHttp(t.tender_package_link)
                          ? <a href={t.tender_package_link.trim()} target="_blank" rel="noopener noreferrer" className="link">Открыть</a>
                          : <span className="tp-dash">—</span>}
                      </td>
                      <td className="cab-open-cell">
                        <Link to={tenderHref(t.id)} className="cab-open-btn" aria-label={`Открыть тендер № ${number}`}>Открыть тендер</Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {previewDoc && <S3DocumentPreview doc={previewDoc} onClose={() => setPreviewDoc(null)} />}
    </div>
  )
}

export default ContractorCabinetPage
