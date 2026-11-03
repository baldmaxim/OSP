import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import BreakableId from '../BreakableId'
import { formatMoney } from '../../utils/estimateImport'
import { effectiveDocumentAmount } from '../../utils/contractAmendments'
import { buildObjectTree, docTitle, searchContractChoices } from '../../utils/counterpartyDocs'
import { amendmentLabel, dcWorkState, summarizeDcRequests } from '../../utils/dcRequestContracts'
import {
  attachContract, detachContract, loadContractChoices, loadCounterpartyDcRequests, loadCounterpartyDocs,
} from '../../services/counterpartyContracts'
import { employeeName, employeesById, fetchEmployees } from '../../services/employees'

// Низ «Общей информации» карточки контрагента: объект (только те, где у контрагента есть договор или заявка) →
// договоры → под договором ДС и заявки на ДС. Что показывать под договорами — выбор в заголовке столбца «Документ»
// (запоминается в браузере). Договоры и ДС — по праву раздела «Договоры и ДС», заявки — «Заявок на ДС».

// Держать в согласии со STATUS_OPTIONS в ContractsPage.jsx.
const STATUS_LABEL = {
  new_request: 'Новая заявка',
  in_work: 'В работе',
  awaiting_paper_sign: 'Ожидание подписания',
  paused: 'Приостановка',
  completed: 'Завершено',
}

const VIEW_STORAGE_KEY = 'counterparties:childView'
const VIEW_ALL = 'all'
const VIEW_DS = 'ds'
const VIEW_REQUESTS = 'requests'

function readStoredView() {
  try {
    const v = localStorage.getItem(VIEW_STORAGE_KEY)
    return v === VIEW_DS || v === VIEW_REQUESTS ? v : VIEW_ALL
  } catch { return VIEW_ALL }
}
function storeView(view) {
  try { localStorage.setItem(VIEW_STORAGE_KEY, view) } catch { /* выбор просто не запомнится */ }
}

// ФИО тех, кто прикрепил договор, — только администратору; справочник один на все карточки.
let employeesPromise = null
const loadEmployeeMap = () => {
  employeesPromise ||= fetchEmployees().then(employeesById).catch((err) => { employeesPromise = null; throw err })
  return employeesPromise
}

const fmtDateTime = (ts) => {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '' : `${d.toLocaleDateString('ru-RU')}, ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
}

const dash = <span className="muted-dash">—</span>

function StatusBadge({ status }) {
  const value = status || 'new_request'
  return <span className={`cpg-cstatus cpg-cstatus-${value}`}>{STATUS_LABEL[value] || value}</span>
}

function WorkBadge({ req }) {
  const s = dcWorkState(req)
  return <span className={`cpg-dcr-state ${s.className}`}>{s.label}</span>
}

const docLink = (doc, children) => (
  <a href={`/contracts/${doc.id}`} target="_blank" rel="noopener noreferrer" className="cpg-doc-link"
     title="Открыть карточку документа в новой вкладке">{children}</a>
)

// Договор в разделе только благодаря ручной привязке: администратору — пометка (кто и когда прикрепил),
// с правом правки — «открепить».
function ManualControls({ doc, link, isAdmin, canEdit, names, onDetach }) {
  if (!link) return null
  const t = docTitle(doc)
  const who = names ? employeeName(names, link.created_by, 'не записан') : ''
  const title = ['Прикреплён к контрагенту вручную', who && `прикрепил: ${who}`, link.created_at && fmtDateTime(link.created_at)]
    .filter(Boolean).join(' · ')
  return (
    <>
      {isAdmin && <span className="cpg-manual" title={title}>добавлен вручную</span>}
      {canEdit && (
        <button type="button" className="cpg-icon-btn cpg-detach" onClick={() => onDetach(doc)}
                title="Открепить договор от контрагента" aria-label={`Открепить ${t.kind.toLowerCase()} ${t.num} от контрагента`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      )}
    </>
  )
}

// Выбор договора из реестра: поиск по номеру, предмету, объекту и контрагенту.
function AttachPicker({ excludeIds, onPick, onClose }) {
  const [query, setQuery] = useState('')
  const [choices, setChoices] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    loadContractChoices()
      .then((list) => { if (alive) setChoices(list) })
      .catch((err) => { if (alive) setError(err?.message || 'ошибка запроса') })
    return () => { alive = false }
  }, [])

  const found = useMemo(() => (choices ? searchContractChoices(choices, query, excludeIds) : []), [choices, query, excludeIds])

  const pick = async (choice) => {
    setBusy(true)
    if (!(await onPick(choice))) setBusy(false)
  }

  return (
    <div className="cpg-attach">
      <div className="cpg-attach-row">
        <input
          type="text"
          className="cpg-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
          placeholder="№ договора, предмет, объект или контрагент"
          aria-label="Поиск договора в реестре «Договоры и ДС»"
          disabled={busy}
          autoFocus
        />
        <button type="button" className="cpg-link-btn" onClick={onClose}>Отмена</button>
      </div>
      {error ? (
        <div className="cpg-muted cpg-attach-note">Не удалось загрузить реестр договоров: {error}</div>
      ) : query.trim() && (
        <ul className="cpg-search-results">
          {!choices ? (
            <li className="cpg-muted cpg-search-empty">Загрузка реестра договоров…</li>
          ) : found.length === 0 ? (
            <li className="cpg-muted cpg-search-empty">Не найдено в реестре «Договоры и ДС»</li>
          ) : found.map((c) => {
            const t = docTitle(c)
            return (
              <li key={c.id}>
                <button type="button" className="cpg-search-option cpg-choice" onClick={() => pick(c)} disabled={busy}>
                  <span className="cpg-search-name">{t.num}{t.date ? ` от ${t.date}` : ''}{c.work_name ? ` · ${c.work_name}` : ''}</span>
                  <span className="cpg-search-inn">{[c.objects?.name, c.counterparties?.name].filter(Boolean).join(' · ')}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// Выбор в заголовке столбца: что показывать под договорами. Варианта, которого у контрагента нет, выбрать нельзя.
function ViewSelect({ view, onChange, amendments, requests }) {
  return (
    <select
      className="cpg-child-view"
      value={view}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Что показывать под договорами: ДС или заявки на ДС"
      title="Что показывать под договорами"
    >
      <option value={VIEW_ALL}>ДС и заявки на ДС</option>
      <option value={VIEW_DS} disabled={amendments === 0}>ДС ({amendments})</option>
      <option value={VIEW_REQUESTS} disabled={requests === 0}>Заявки на ДС ({requests})</option>
    </select>
  )
}

const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return many
  if (b === 1) return one
  return b >= 2 && b <= 4 ? few : many
}

const objectMeta = ({ contracts, amendments, requests }) => [
  contracts > 0 && `${contracts} ${plural(contracts, 'договор', 'договора', 'договоров')}`,
  amendments > 0 && `${amendments} ДС`,
  requests > 0 && `${requests} ${plural(requests, 'заявка', 'заявки', 'заявок')}`,
].filter(Boolean).join(' · ')

const requestsMeta = (requests, linked) => {
  const s = summarizeDcRequests(requests)
  return `заявок: ${s.total} · отработано: ${s.done}${linked ? ` · в ДС: ${s.inDs}` : ''}`
}

const requestNo = (req) => (req.request_number != null ? `Заявка № ${req.request_number}` : 'Заявка')

const requestDsLabel = (req) => (req.ds_number ? amendmentLabel({ contract_number: req.ds_number }) : 'без № ДС')

// Сумма заявки: утверждённая, а пока её нет — поданная.
function requestAmount(req) {
  const num = (v) => (v != null && v !== '' ? Number(v) : null)
  const approved = num(req.amount_after)
  if (approved != null) return { value: approved, label: 'утверждено' }
  const submitted = num(req.amount_before)
  return submitted != null ? { value: submitted, label: 'подано' } : null
}

function RequestAmount({ req }) {
  const amount = requestAmount(req)
  if (!amount) return dash
  return <>{formatMoney(amount.value)}<div className="cpg-sum-actual">{amount.label}</div></>
}

// В какое ДС занесена заявка — ссылка на ДС реестра.
function RequestDs({ req, docs }) {
  if (!req.amendment_id) return <span className="cpg-muted">не занесена в ДС</span>
  const doc = docs.get(req.amendment_id)
  return (
    <span className="cpg-muted">
      в{' '}
      <a href={`/contracts/${req.amendment_id}`} target="_blank" rel="noopener noreferrer" className="cpg-doc-link cpg-dcr-ds"
         title="Заявка занесена в это ДС — открыть карточку ДС в новой вкладке">
        {doc ? amendmentLabel(doc) : 'ДС'}
      </a>
    </span>
  )
}

// Подпись договора или ДС в строке и на карточке телефона.
function DocLabel({ doc, depth = -1, children }) {
  const t = docTitle(doc)
  return (
    <div className="cpg-doc-cell" style={depth >= 0 ? { paddingLeft: `${0.75 + depth * 0.75}rem` } : undefined}>
      <span className="cpg-doc-kind">{t.kind}</span>
      {docLink(doc, <BreakableId value={t.num} />)}
      {t.date && <span className="cpg-doc-date">от {t.date}</span>}
      {children}
    </div>
  )
}

function RequestLabel({ req, objectKey, indent = true }) {
  const otherObject = req.objects?.name && (req.object_id || '') !== objectKey
  return (
    <div className="cpg-doc-cell" style={indent ? { paddingLeft: '0.75rem' } : undefined}>
      <span className="cpg-doc-kind">{requestNo(req)}</span>
      <span className="cpg-req-ds"><BreakableId value={requestDsLabel(req)} /></span>
      {otherObject && <div className="cpg-req-object">объект заявки: {req.objects.name}</div>}
    </div>
  )
}

const Text = ({ value }) => (value ? <div className="cpg-work">{value}</div> : null)

function RequestRow({ req, objectKey, docs, linked }) {
  return (
    <tr className="is-req">
      <td><RequestLabel req={req} objectKey={objectKey} /></td>
      <td><Text value={req.works_description} /></td>
      <td className="cpg-num"><RequestAmount req={req} /></td>
      <td>
        <WorkBadge req={req} />
        {linked && <div className="cpg-req-in-ds"><RequestDs req={req} docs={docs} /></div>}
      </td>
    </tr>
  )
}

function ContractRows({ group, objectKey, showDs, showRequests, details, docs, linked, manualProps }) {
  const { root, children, actual, requests } = group
  const amount = effectiveDocumentAmount(root)
  return (
    <>
      <tr className="is-contract">
        <td>
          <DocLabel doc={root}>
            {details && <ManualControls {...manualProps(root)} />}
          </DocLabel>
          {showRequests && requests.length > 0 && <div className="cpg-group-meta">{requestsMeta(requests, linked)}</div>}
        </td>
        <td><Text value={details && root.work_name} /></td>
        <td className="cpg-num">
          {details && amount != null ? formatMoney(amount, root.currency || 'RUB') : dash}
          {details && actual != null && (
            <div className="cpg-sum-actual" title="Сумма договора с завершёнными ДС">
              <span>с учётом ДС</span> <span>{formatMoney(actual, root.currency || 'RUB')}</span>
            </div>
          )}
        </td>
        <td>{details ? <StatusBadge status={root.status} /> : dash}</td>
      </tr>
      {showDs && children.map(({ doc, depth }) => {
        const dsAmount = effectiveDocumentAmount(doc)
        return (
          <tr key={doc.id} className="is-ds">
            <td><DocLabel doc={doc} depth={depth} /></td>
            <td><Text value={doc.work_name} /></td>
            <td className="cpg-num">{dsAmount != null ? formatMoney(dsAmount, doc.currency || 'RUB') : dash}</td>
            <td><StatusBadge status={doc.status} /></td>
          </tr>
        )
      })}
      {showRequests && requests.map(req => (
        <RequestRow key={req.id} req={req} objectKey={objectKey} docs={docs} linked={linked} />
      ))}
    </>
  )
}

function TreeTable({ objects, viewSelect, showDs, showRequests, details, docs, linked, manualProps }) {
  return (
    <div className="cpg-table-wrap">
      <table className="cpg-contracts-table">
        <colgroup>
          <col className="cpg-col-doc" />
          <col />
          <col className="cpg-col-sum" />
          <col className="cpg-col-status" />
        </colgroup>
        <thead>
          <tr>
            <th>
              <div className="cpg-th-doc">
                <span>Документ</span>
                {viewSelect}
              </div>
            </th>
            <th>Предмет / описание</th>
            <th className="cpg-num">Сумма</th>
            <th>Статус</th>
          </tr>
        </thead>
        {objects.map(o => (
          <tbody key={o.key} className="cpg-object-group">
            <tr className="cpg-object-row">
              <th colSpan={4} scope="rowgroup">
                <span className="cpg-object-name">{o.name || 'Объект не указан'}</span>{' '}
                <span className="cpg-object-meta">{objectMeta(o.counts)}</span>
              </th>
            </tr>
            {o.groups.map(g => (
              <ContractRows key={g.root.id} group={g} objectKey={o.key} showDs={showDs} showRequests={showRequests}
                details={details} docs={docs} linked={linked} manualProps={manualProps} />
            ))}
            {showRequests && o.loose.length > 0 && (
              <>
                <tr className="cpg-nocontract-row">
                  <td colSpan={4}>
                    <span className="cpg-nocontract">{linked ? 'Договор не указан' : 'Заявки'}</span>{' '}
                    <span className="cpg-group-meta">{requestsMeta(o.loose, linked)}</span>
                  </td>
                </tr>
                {o.loose.map(req => (
                  <RequestRow key={req.id} req={req} objectKey={o.key} docs={docs} linked={linked} />
                ))}
              </>
            )}
          </tbody>
        ))}
      </table>
    </div>
  )
}

function RequestCardRow({ req, objectKey, docs, linked }) {
  return (
    <div className="cpg-contract-card-row is-req">
      <div className="cpg-contract-card-head">
        <RequestLabel req={req} objectKey={objectKey} indent={false} />
        <WorkBadge req={req} />
      </div>
      <Text value={req.works_description} />
      {requestAmount(req) && <div className="cpg-contract-card-sum"><RequestAmount req={req} /></div>}
      {linked && <RequestDs req={req} docs={docs} />}
    </div>
  )
}

function TreeCards({ objects, showDs, showRequests, details, docs, linked, manualProps }) {
  return (
    <div className="cpg-object-cards">
      {objects.map(o => (
        <section key={o.key} className="cpg-object-card">
          <div className="cpg-object-row-phone">
            <span className="cpg-object-name">{o.name || 'Объект не указан'}</span>
            <span className="cpg-object-meta">{objectMeta(o.counts)}</span>
          </div>
          <ul className="cpg-contract-cards">
            {o.groups.map(({ root, children, actual, requests }) => {
              const amount = effectiveDocumentAmount(root)
              return (
                <li key={root.id} className="cpg-contract-card">
                  <div className="cpg-contract-card-row">
                    <div className="cpg-contract-card-head">
                      <DocLabel doc={root}>
                        {details && <ManualControls {...manualProps(root)} />}
                      </DocLabel>
                      {details && <StatusBadge status={root.status} />}
                    </div>
                    <Text value={details && root.work_name} />
                    {details && amount != null && (
                      <div className="cpg-contract-card-sum">
                        {formatMoney(amount, root.currency || 'RUB')}
                        {actual != null && <span className="cpg-sum-actual"> · с учётом ДС {formatMoney(actual, root.currency || 'RUB')}</span>}
                      </div>
                    )}
                    {showRequests && requests.length > 0 && <div className="cpg-group-meta">{requestsMeta(requests, linked)}</div>}
                  </div>
                  {showDs && children.map(({ doc }) => {
                    const dsAmount = effectiveDocumentAmount(doc)
                    return (
                      <div key={doc.id} className="cpg-contract-card-row is-ds">
                        <div className="cpg-contract-card-head">
                          <DocLabel doc={doc} />
                          <StatusBadge status={doc.status} />
                        </div>
                        <Text value={doc.work_name} />
                        {dsAmount != null && <div className="cpg-contract-card-sum">{formatMoney(dsAmount, doc.currency || 'RUB')}</div>}
                      </div>
                    )
                  })}
                  {showRequests && requests.map(req => (
                    <RequestCardRow key={req.id} req={req} objectKey={o.key} docs={docs} linked={linked} />
                  ))}
                </li>
              )
            })}
            {showRequests && o.loose.length > 0 && (
              <li className="cpg-contract-card">
                <div className="cpg-contract-card-row">
                  <span className="cpg-nocontract">{linked ? 'Договор не указан' : 'Заявки'}</span>
                  <div className="cpg-group-meta">{requestsMeta(o.loose, linked)}</div>
                </div>
                {o.loose.map(req => (
                  <RequestCardRow key={req.id} req={req} objectKey={o.key} docs={docs} linked={linked} />
                ))}
              </li>
            )}
          </ul>
        </section>
      ))}
    </div>
  )
}

const EMPTY_REQUESTS = { loading: false, error: '', requests: [], docs: new Map(), linked: false }
const EMPTY_DOCS = { loading: false, error: '', docs: [], manual: new Map(), linksSupported: false }

// Монтируется заново на каждого контрагента (key в CounterpartyGeneralTab): открытый выбор договора не
// переезжает в карточку другой компании.
export default function CounterpartyContracts({
  counterpartyId, isPhone, canEdit, isAdmin, canViewContracts = true, canViewDcRequests = false, onLinkChange,
}) {
  const [docsState, setDocsState] = useState({ ...EMPTY_DOCS, loading: canViewContracts })
  const [reqState, setReqState] = useState({ ...EMPTY_REQUESTS, loading: canViewDcRequests })
  const [picking, setPicking] = useState(false)
  const [names, setNames] = useState(null)
  const [storedView, setStoredView] = useState(readStoredView)
  // Карточку переключили на другого контрагента, пока шёл запрос, — опоздавший ответ не показываем.
  const docsRequestRef = useRef(0)
  const reqRequestRef = useRef(0)

  const loadDocs = useCallback(async ({ quiet = false } = {}) => {
    if (!canViewContracts) return
    const request = ++docsRequestRef.current
    if (!quiet) setDocsState(s => ({ ...s, loading: true, error: '', docs: [] }))
    try {
      const data = await loadCounterpartyDocs(counterpartyId)
      if (request === docsRequestRef.current) setDocsState({ loading: false, error: '', ...data })
    } catch (err) {
      console.error('Договоры контрагента:', err?.message || err)
      if (request === docsRequestRef.current) setDocsState(s => ({ ...s, loading: false, error: err?.message || 'ошибка запроса', docs: [] }))
    }
  }, [counterpartyId, canViewContracts])

  const loadRequests = useCallback(async () => {
    if (!canViewDcRequests) return
    const request = ++reqRequestRef.current
    setReqState(s => ({ ...s, loading: true, error: '' }))
    try {
      const data = await loadCounterpartyDcRequests(counterpartyId)
      if (request === reqRequestRef.current) setReqState({ loading: false, error: '', ...data })
    } catch (err) {
      console.error('Заявки на ДС контрагента:', err?.message || err)
      if (request === reqRequestRef.current) setReqState(s => ({ ...s, loading: false, error: err?.message || 'ошибка запроса', requests: [] }))
    }
  }, [counterpartyId, canViewDcRequests])

  useEffect(() => { loadDocs() }, [loadDocs])
  useEffect(() => { loadRequests() }, [loadRequests])

  const hasManual = docsState.manual.size > 0
  useEffect(() => {
    if (!isAdmin || !hasManual || names) return
    loadEmployeeMap().then(setNames).catch(() => {})
  }, [isAdmin, hasManual, names])

  const objects = useMemo(
    () => buildObjectTree(docsState.docs, reqState.requests, reqState.docs),
    [docsState.docs, reqState.requests, reqState.docs],
  )
  const shownIds = useMemo(() => new Set(docsState.docs.map(d => d.id)), [docsState.docs])
  const totals = useMemo(() => objects.reduce((sum, o) => ({
    contracts: sum.contracts + o.counts.contracts,
    amendments: sum.amendments + o.counts.amendments,
  }), { contracts: 0, amendments: 0 }), [objects])
  const summary = useMemo(() => summarizeDcRequests(reqState.requests), [reqState.requests])

  const attach = async (choice) => {
    try {
      await attachContract(counterpartyId, choice.id)
    } catch (err) {
      alert('Не удалось прикрепить договор: ' + (err?.message || err))
      return false
    }
    onLinkChange?.('contract_linked', choice)
    setPicking(false)
    await loadDocs({ quiet: true })
    return true
  }

  const detach = async (doc) => {
    const t = docTitle(doc)
    if (!window.confirm(`Открепить договор ${t.num} от контрагента? Сам договор останется в реестре «Договоры и ДС».`)) return
    try {
      await detachContract(counterpartyId, doc.id)
    } catch (err) {
      alert('Не удалось открепить договор: ' + (err?.message || err))
      return
    }
    onLinkChange?.('contract_unlinked', doc)
    await loadDocs({ quiet: true })
  }

  if (docsState.loading || reqState.loading) return <div className="cpg-muted">Загрузка договоров и заявок…</div>
  if (docsState.error) {
    return (
      <div className="cpg-muted">
        Не удалось загрузить договоры: {docsState.error}{' '}
        <button type="button" className="cpg-link-btn" onClick={() => loadDocs()}>Повторить</button>
      </div>
    )
  }

  const { linked } = reqState
  const canAttach = canEdit && canViewContracts && docsState.linksSupported
  const manualProps = (doc) => ({
    doc, link: docsState.manual.get(doc.id), isAdmin, canEdit, names, onDetach: detach,
  })

  // Выбранного вида у этого контрагента нет — показываем всё, иначе под договорами было бы пусто.
  const canChoose = canViewContracts && canViewDcRequests && (totals.amendments > 0 || summary.total > 0)
  const view = !canChoose
    || (storedView === VIEW_DS && totals.amendments === 0)
    || (storedView === VIEW_REQUESTS && summary.total === 0)
    ? VIEW_ALL : storedView
  const changeView = (next) => { setStoredView(next); storeView(next) }
  const showDs = view !== VIEW_REQUESTS
  const showRequests = view !== VIEW_DS
  const viewSelect = canChoose && (
    <ViewSelect view={view} onChange={changeView} amendments={totals.amendments} requests={summary.total} />
  )

  const visibleObjects = objects.filter(o => o.groups.length > 0 || (showRequests && o.loose.length > 0))
  const empty = objects.length === 0
  const countText = [
    objects.some(o => o.key !== '') && `Объектов: ${objects.filter(o => o.key !== '').length}`,
    canViewContracts && `Договоров: ${totals.contracts}`,
    canViewContracts && totals.amendments > 0 && `ДС: ${totals.amendments}`,
    summary.total > 0 && `Заявок на ДС: ${summary.total}`,
    summary.total > 0 && `отработано: ${summary.done}`,
    summary.total > 0 && linked && `занесено в ДС: ${summary.inDs}`,
  ].filter(Boolean).join(' · ')

  const treeProps = { objects: visibleObjects, showDs, showRequests, details: canViewContracts, docs: reqState.docs, linked, manualProps }

  return (
    <>
      <div className="cpg-contracts-bar">
        <span className="cpg-contracts-count">
          {empty
            ? `Договоров${canViewDcRequests ? ', ДС и заявок на ДС' : ' и ДС'} с этим контрагентом нет.`
            : countText}
        </span>
        <span className="cpg-contracts-actions">
          {isPhone && viewSelect}
          {canAttach && !picking && (
            <button type="button" className="cpg-link-btn cpg-attach-btn" onClick={() => setPicking(true)}>
              + Прикрепить договор
            </button>
          )}
          {summary.total > 0 && (
            <a href={`/dc-requests?counterparty=${counterpartyId}`} target="_blank" rel="noopener noreferrer" className="cpg-link-btn cpg-attach-btn"
               title="Заявки этого контрагента в реестре «Заявка на ДС» (новая вкладка)">Открыть в реестре заявок</a>
          )}
        </span>
      </div>
      {picking && <AttachPicker excludeIds={shownIds} onPick={attach} onClose={() => setPicking(false)} />}
      {!canViewContracts && (
        <div className="cpg-muted cpg-attach-note cpg-tree-note">Договоры показаны только подписью: нет доступа к разделу «Договоры и ДС».</div>
      )}
      {reqState.error && (
        <div className="cpg-muted cpg-attach-note cpg-tree-note">
          Не удалось загрузить заявки на ДС: {reqState.error}{' '}
          <button type="button" className="cpg-link-btn" onClick={loadRequests}>Повторить</button>
        </div>
      )}
      {canViewDcRequests && !reqState.error && !linked && summary.total > 0 && (
        <div className="cpg-muted cpg-attach-note cpg-tree-note">
          Договор и ДС у заявок появятся после обновления базы (миграция 20261109_contracts_dc_requests).
        </div>
      )}

      {empty ? null : isPhone
        ? <TreeCards {...treeProps} />
        : <TreeTable {...treeProps} viewSelect={viewSelect} />}
    </>
  )
}
