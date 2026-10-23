import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { db } from '../api'
import { useRole } from '../contexts/RoleContext'
import { fetchAllRows } from '../utils/fetchAllRows'
import { requestDownloadUrl } from '../services/s3'
import { buildProposalWorkbook, matchProposalRows } from '../utils/contractorProposal'
import S3DocumentPreview from '../components/S3DocumentPreview'
import { loadCabinetTenders, requestParticipation } from '../services/contractorBids'
import { phoneHref } from '../utils/siteContacts'
import './ContractorCabinetPage.css'

const ContractClausesTab = lazy(() => import('../components/ContractClausesTab'))
const BidWorkspace = lazy(() => import('../components/contractor/BidWorkspace'))

// Кабинет подрядчика: тендеры (пакет документов, расценка ВОР на сайте, анкета, загрузка КП) и договоры
// (документы + согласование условий).
//
// Тендеры (миграция 20261102): открытые — как на /public/tenders — и те, где организация участник или подала
// заявку (bid_contractor_tenders). Расценивать на сайте может участник или подавший заявку; участником делает
// инженер. Без миграции — как раньше: только приглашения.
//
// Организация берётся из user_roles.counterparty_id (RoleContext), а не из
// выбора на форме входа. Доступ к данным ограничен политиками БД (миграции
// 20260913/20260914) — интерфейс не «прячет чужое», его просто не отдают.

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

const DOC_SECTION_LABEL = {
  tender_package: 'Тендерный пакет',
  rd: 'Рабочая документация',
  vor_statement: 'Ведомость объёмов работ',
  vor: 'ВОР и рабочая документация',
}

function formatDate(value) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ru-RU')
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

  const tab = searchParams.get('tab') === 'contracts' ? 'contracts' : 'tenders'
  const setTab = (next) => setSearchParams(next === 'tenders' ? {} : { tab: next }, { replace: true })

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  // Тендеры
  const [invitations, setInvitations] = useState([])
  const [activeTenderId, setActiveTenderId] = useState(null)
  const [estimateItems, setEstimateItems] = useState([])
  const [tenderDocs, setTenderDocs] = useState([])
  const [tenderBusy, setTenderBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadNote, setUploadNote] = useState(null)   // { kind: 'ok'|'warn', text }

  // Договоры
  const [contracts, setContracts] = useState([])
  const [activeContractId, setActiveContractId] = useState(null)
  const [contractDocs, setContractDocs] = useState([])
  const [clauseContractIds, setClauseContractIds] = useState(() => new Set())

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
      if (err?.code !== '42501') throw err
    }
    const { data, error } = await db
      .from('tender_counterparties')
      .select('tender_id, status, notes, tenders(id, public_tender_number, work_description, status, tender_start_date, tender_end_date, objects(name, address))')
      .eq('counterparty_id', cpId)
    if (error) throw error
    const list = (data || [])
      .filter(p => p.tenders)
      .map(p => ({ ...p.tenders, participationStatus: p.status, participationNote: p.notes, access: 'invited' }))
      .sort((a, b) => (b.tender_end_date || '').localeCompare(a.tender_end_date || ''))
    return { list, bids: false }
  }, [cpId])

  // ── Загрузка: тендеры и договоры организации ──────────────────────────────
  const loadAll = useCallback(async () => {
    if (!cpId) { setLoading(false); return }
    setLoading(true)
    setLoadError('')
    try {
      const [tenderList, ownContracts, partyRows] = await Promise.all([
        loadTenderList(),
        db
          .from('contracts')
          .select('id, display_id, contract_number, contract_date, work_name, status, contract_amount, currency, objects(name), deleted_at')
          .eq('counterparty_id', cpId)
          .is('deleted_at', null),
        db
          .from('contract_counterparties')
          .select('contract_id')
          .eq('counterparty_id', cpId),
      ])
      const invites = tenderList.list
      setBidsEnabled(tenderList.bids)
      setInvitations(invites)
      setActiveTenderId(prev => (prev && invites.some(t => t.id === prev) ? prev : (invites.find(t => t.access) || invites[0])?.id || null))

      // Договоры: основная сторона + многосторонние (в contract_counterparties).
      const extraIds = [...new Set((partyRows.data || []).map(r => r.contract_id))]
      const known = new Set((ownContracts.data || []).map(c => c.id))
      const missing = extraIds.filter(id => !known.has(id))
      let extra = []
      if (missing.length > 0) {
        const { data } = await db
          .from('contracts')
          .select('id, display_id, contract_number, contract_date, work_name, status, contract_amount, currency, objects(name), deleted_at')
          .in('id', missing)
          .is('deleted_at', null)
        extra = data || []
      }
      const allContracts = [...(ownContracts.data || []), ...extra]
        .sort((a, b) => (b.contract_date || '').localeCompare(a.contract_date || ''))
      setContracts(allContracts)
      setActiveContractId(prev => prev || allContracts[0]?.id || null)

      // По каким договорам загружен текст — там доступно согласование.
      if (allContracts.length > 0) {
        const { data: clauses } = await db
          .from('contract_clauses')
          .select('contract_id')
          .in('contract_id', allContracts.map(c => c.id))
        setClauseContractIds(new Set((clauses || []).map(r => r.contract_id)))
      }
    } catch (err) {
      console.error('Кабинет подрядчика:', err)
      setLoadError(err.message || 'Не удалось загрузить данные кабинета.')
    } finally {
      setLoading(false)
    }
  }, [cpId, loadTenderList])

  useEffect(() => { loadAll() }, [loadAll])

  // ── Выбранный тендер: смета, документы, дата загрузки КП ──────────────────
  const activeTender = useMemo(
    () => invitations.find(t => t.id === activeTenderId) || null,
    [invitations, activeTenderId])

  // Файлы и смета — только тендера, к которому у организации есть доступ (участник или заявка).
  const activeAccess = activeTender?.access || null
  const loadTenderDetails = useCallback(async () => {
    if (!activeTenderId || !cpId || !activeAccess || activeAccess === 'rejected') { setEstimateItems([]); setTenderDocs([]); return }
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
  }, [activeTenderId, cpId, activeAccess])

  useEffect(() => { loadTenderDetails() }, [loadTenderDetails])

  // ── Документы выбранного договора ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    if (!activeContractId) { setContractDocs([]); return }
    db
      .from('s3_documents')
      .select('id, owner_id, doc_category, file_name, s3_key, mime_type, size_bytes, created_at')
      .eq('owner_type', 'contract')
      .eq('owner_id', activeContractId)
      .order('created_at', { ascending: false })
      .then(({ data }) => { if (!cancelled) setContractDocs(data || []) })
    return () => { cancelled = true }
  }, [activeContractId])

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
      const { presigned_url } = await requestDownloadUrl(doc.s3_key, { fileName: doc.file_name, download: true })
      const a = document.createElement('a')
      a.href = presigned_url
      a.download = doc.file_name
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
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
      const { error: statusError } = await db
        .from('tender_counterparties')
        .update({ status: 'proposal_provided' })
        .eq('tender_id', activeTender.id)
        .eq('counterparty_id', cpId)
      if (statusError) console.error('Статус участия:', statusError.message)

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
      setUploadNote({ kind: 'warn', text: 'Не удалось загрузить КП: ' + (err.message || err) })
    } finally {
      setUploading(false)
    }
  }

  const handleDecline = async () => {
    if (!activeTender || !cpId) return
    if (!window.confirm('Отказаться от участия в этом тендере? Отметку увидит отдел сопровождения подрядчиков.')) return
    try {
      const { error } = await db
        .from('tender_counterparties')
        .update({ status: 'declined' })
        .eq('tender_id', activeTender.id)
        .eq('counterparty_id', cpId)
      if (error) throw error
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

  // Список: свои тендеры (участник или заявка), затем открытые. Без миграции — одна группа приглашений.
  const listGroups = bidsEnabled
    ? [
        { key: 'mine', title: 'Мои тендеры', items: invitations.filter(t => t.access) },
        { key: 'open', title: 'Открытые тендеры', items: invitations.filter(t => !t.access) },
      ].filter(g => g.items.length)
    : [{ key: 'all', title: '', items: invitations }]

  const activeContract = contracts.find(c => c.id === activeContractId) || null
  const deadline = daysLeft(activeTender?.tender_end_date)

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
          aria-selected={tab === 'contracts'}
          className={`cab-tab${tab === 'contracts' ? ' is-active' : ''}`}
          onClick={() => setTab('contracts')}
        >
          Договоры
          {contracts.length > 0 && <span className="cab-tab-count">{contracts.length}</span>}
        </button>
      </nav>

      {loading ? (
        <div className="cab-state">Загрузка…</div>
      ) : loadError ? (
        <div className="cab-state cab-state-error">{loadError}</div>
      ) : tab === 'tenders' ? (
        invitations.length === 0 ? (
          <div className="cab-state">
            {bidsEnabled
              ? 'Открытых тендеров сейчас нет. Как только отдел объявит тендер, он появится здесь.'
              : 'Приглашений в тендеры пока нет. Как только вас пригласят, тендер появится здесь.'}
          </div>
        ) : (
          <div className="cab-body">
            <aside className="cab-list">
              {listGroups.map(g => (
                <div key={g.key} className="cab-list-group">
                  {bidsEnabled && <div className="cab-list-title">{g.title} <span>{g.items.length}</span></div>}
                  {g.items.map(t => {
                    const left = daysLeft(t.tender_end_date)
                    const chip = t.access ? ACCESS_LABEL[t.access] : null
                    return (
                      <button
                        key={t.id}
                        type="button"
                        className={`cab-card${t.id === activeTenderId ? ' is-active' : ''}`}
                        onClick={() => { setActiveTenderId(t.id); setUploadNote(null) }}
                      >
                        <span className="cab-card-top">
                          <span className="cab-card-num">
                            {t.public_tender_number ? `Тендер № ${t.public_tender_number}` : 'Тендер'}
                          </span>
                          {bidsEnabled ? (
                            chip && <span className={`cab-chip ${ACCESS_CLASS[t.access] || ''}`}>{chip}</span>
                          ) : (
                            <span className={`cab-chip ${PARTICIPATION_CLASS[t.participationStatus] || ''}`}>
                              {PARTICIPATION_LABEL[t.participationStatus] || t.participationStatus}
                            </span>
                          )}
                        </span>
                        <span className="cab-card-obj">{t.objects?.name || 'Объект не указан'}</span>
                        <span className="cab-card-work">{t.work_description}</span>
                        <span className="cab-card-foot">
                          {t.tender_start_date ? `${formatDate(t.tender_start_date)} — ` : 'до '}{formatDate(t.tender_end_date)}
                          {t.isOpen !== false && left != null && left >= 0 && left <= 3 && <b className="cab-soon"> · осталось {left} дн.</b>}
                          {left != null && left < 0 && <b className="cab-late"> · срок истёк</b>}
                          {t.pricedCount > 0 && <span className="cab-card-priced"> · расценено {t.pricedCount}</span>}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))}
            </aside>

            <main className="cab-main">
              {!activeTender ? (
                <div className="cab-state">Выберите тендер слева.</div>
              ) : (
                <>
                  <div className="cab-head-block">
                    <div className="cab-head-top">
                      <span className="cab-card-num">
                        {activeTender.public_tender_number ? `Тендер № ${activeTender.public_tender_number}` : 'Тендер'}
                      </span>
                      {bidsEnabled && activeTender.access && (
                        <span className={`cab-chip ${ACCESS_CLASS[activeTender.access] || ''}`}>{ACCESS_LABEL[activeTender.access]}</span>
                      )}
                      {bidsEnabled && activeTender.isOpen === false && <span className="cab-chip is-off">Приём предложений закрыт</span>}
                    </div>
                    <h2>{activeTender.objects?.name || 'Объект не указан'}</h2>
                    <p className="cab-work">{activeTender.work_description}</p>
                    <div className="cab-facts">
                      <span><b>Приём КП:</b> {formatDate(activeTender.tender_start_date)} — {formatDate(activeTender.tender_end_date)}</span>
                      {deadline != null && activeTender.isOpen !== false && (
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
                          Откроются файлы ВОР и расценка на сайте. Отдел увидит вашу организацию и решит, включить ли
                          её в участники тендера.
                        </span>
                      </div>
                      {activeTender.isOpen ? (
                        <button type="button" className={`cab-btn cab-btn-primary${joining ? ' is-busy' : ''}`} disabled={joining} onClick={handleJoin}>
                          {joining ? 'Подаём заявку…' : 'Участвовать и расценить'}
                        </button>
                      ) : (
                        <span className="cab-muted">Приём предложений закрыт.</span>
                      )}
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
                  {activeTender.access && activeTender.access !== 'rejected' && (
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
                          canEdit={activeTender.isOpen === true && CAN_PRICE.has(activeTender.access)}
                          counterpartyName={contractorInfo?.name || ''}
                          tenderNumbers={tenderNumbers}
                          onSummary={handleBidSummary}
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

                  {activeTender.access === 'invited' && activeTender.participationStatus && activeTender.participationStatus !== 'declined' && (
                    <div className="cab-decline">
                      <button type="button" className="cab-btn cab-btn-ghost" onClick={handleDecline}>
                        Отказаться от участия
                      </button>
                    </div>
                  )}
                </>
              )}
            </main>
          </div>
        )
      ) : (
        contracts.length === 0 ? (
          <div className="cab-state">Договоров с вашей организацией пока нет.</div>
        ) : (
          <div className="cab-body">
            <aside className="cab-list">
              {contracts.map(c => (
                <button
                  key={c.id}
                  type="button"
                  className={`cab-card${c.id === activeContractId ? ' is-active' : ''}`}
                  onClick={() => setActiveContractId(c.id)}
                >
                  <span className="cab-card-top">
                    <span className="cab-card-num">{c.contract_number ? `Договор № ${c.contract_number}` : 'Договор без номера'}</span>
                    {clauseContractIds.has(c.id) && <span className="cab-chip is-accent">Согласование</span>}
                  </span>
                  <span className="cab-card-obj">{c.objects?.name || 'Объект не указан'}</span>
                  {c.work_name && <span className="cab-card-work">{c.work_name}</span>}
                  <span className="cab-card-foot">от {formatDate(c.contract_date)}</span>
                </button>
              ))}
            </aside>

            <main className="cab-main">
              {!activeContract ? (
                <div className="cab-state">Выберите договор слева.</div>
              ) : (
                <>
                  <div className="cab-head-block">
                    <h2>{activeContract.contract_number ? `Договор № ${activeContract.contract_number}` : 'Договор без номера'}</h2>
                    <p className="cab-work">{activeContract.work_name || '—'}</p>
                    <div className="cab-facts">
                      <span><b>Объект:</b> {activeContract.objects?.name || '—'}</span>
                      <span><b>Дата:</b> {formatDate(activeContract.contract_date)}</span>
                      {activeContract.display_id != null && <span><b>ID:</b> {activeContract.display_id}</span>}
                    </div>
                  </div>

                  <section className="cab-section">
                    <h3>Документы договора</h3>
                    {contractDocs.length === 0 ? (
                      <p className="cab-muted">Файлы по договору пока не опубликованы.</p>
                    ) : (
                      <ul className="cab-docs">
                        {contractDocs.map(d => {
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
                    )}
                  </section>

                  {clauseContractIds.has(activeContract.id) ? (
                    <section className="cab-section cab-section-flush">
                      <h3>Согласование условий</h3>
                      <Suspense fallback={<p className="cab-muted">Загрузка протокола…</p>}>
                        <ContractClausesTab
                          key={activeContract.id}
                          contractId={activeContract.id}
                          contract={activeContract}
                          side="contractor"
                          counterpartyId={cpId}
                          canEdit={false}
                        />
                      </Suspense>
                    </section>
                  ) : (
                    <section className="cab-section">
                      <h3>Согласование условий</h3>
                      <p className="cab-muted">
                        Текст договора ещё не отправлен на согласование. Когда специалист СУ-10 его загрузит,
                        здесь появится протокол разногласий: по каждому пункту можно будет предложить свою редакцию.
                      </p>
                    </section>
                  )}
                </>
              )}
            </main>
          </div>
        )
      )}

      {previewDoc && <S3DocumentPreview doc={previewDoc} onClose={() => setPreviewDoc(null)} />}
    </div>
  )
}

export default ContractorCabinetPage
