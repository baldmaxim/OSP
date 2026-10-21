import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatMoney } from '../../utils/estimateImport'
import { DOC_TYPE, effectiveDocumentAmount } from '../../utils/contractAmendments'
import { docTitle, groupCounterpartyDocs, searchContractChoices } from '../../utils/counterpartyDocs'
import {
  attachContract, detachContract, loadContractChoices, loadCounterpartyDocs,
} from '../../services/counterpartyContracts'
import { employeeName, employeesById, fetchEmployees } from '../../services/employees'

// Держать в согласии со STATUS_OPTIONS в ContractsPage.jsx.
const STATUS_LABEL = {
  new_request: 'Новая заявка',
  in_work: 'В работе',
  awaiting_paper_sign: 'Ожидание подписания',
  paused: 'Приостановка',
  completed: 'Завершено',
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

function StatusBadge({ status }) {
  const value = status || 'new_request'
  return <span className={`cpg-cstatus cpg-cstatus-${value}`}>{STATUS_LABEL[value] || value}</span>
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

// Монтируется заново на каждого контрагента (key в CounterpartyGeneralTab): открытый выбор договора не
// переезжает в карточку другой компании.
export default function CounterpartyContracts({ counterpartyId, isPhone, canEdit, isAdmin, onLinkChange }) {
  const [state, setState] = useState({ loading: true, error: '', docs: [], manual: new Map(), linksSupported: false })
  const [picking, setPicking] = useState(false)
  const [names, setNames] = useState(null)
  // Карточку переключили на другого контрагента, пока шёл запрос, — опоздавший ответ не показываем.
  const requestRef = useRef(0)

  const load = useCallback(async ({ quiet = false } = {}) => {
    const request = ++requestRef.current
    if (!quiet) setState(s => ({ ...s, loading: true, error: '', docs: [] }))
    try {
      const data = await loadCounterpartyDocs(counterpartyId)
      if (request === requestRef.current) setState({ loading: false, error: '', ...data })
    } catch (err) {
      console.error('Договоры контрагента:', err?.message || err)
      if (request === requestRef.current) setState(s => ({ ...s, loading: false, error: err?.message || 'ошибка запроса', docs: [] }))
    }
  }, [counterpartyId])

  useEffect(() => { load() }, [load])

  const hasManual = state.manual.size > 0
  useEffect(() => {
    if (!isAdmin || !hasManual || names) return
    loadEmployeeMap().then(setNames).catch(() => {})
  }, [isAdmin, hasManual, names])

  const groups = useMemo(() => groupCounterpartyDocs(state.docs), [state.docs])
  const shownIds = useMemo(() => new Set(state.docs.map(d => d.id)), [state.docs])

  const attach = async (choice) => {
    try {
      await attachContract(counterpartyId, choice.id)
    } catch (err) {
      alert('Не удалось прикрепить договор: ' + (err?.message || err))
      return false
    }
    onLinkChange?.('contract_linked', choice)
    setPicking(false)
    await load({ quiet: true })
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
    await load({ quiet: true })
  }

  if (state.loading) return <div className="cpg-muted">Загрузка договоров…</div>
  if (state.error) {
    return (
      <div className="cpg-muted">
        Не удалось загрузить договоры: {state.error}{' '}
        <button type="button" className="cpg-link-btn" onClick={() => load()}>Повторить</button>
      </div>
    )
  }

  const contractsCount = groups.filter(g => g.root.record_type === DOC_TYPE.CONTRACT).length
  const amendmentsCount = state.docs.length - contractsCount
  const canAttach = canEdit && state.linksSupported
  const manualProps = (doc) => ({
    doc, link: state.manual.get(doc.id), isAdmin, canEdit, names, onDetach: detach,
  })

  return (
    <>
      <div className="cpg-contracts-bar">
        <span className="cpg-contracts-count">
          {groups.length === 0
            ? 'Договоров и ДС с этим контрагентом нет.'
            : `Договоров: ${contractsCount}${amendmentsCount > 0 ? ` · ДС: ${amendmentsCount}` : ''}`}
        </span>
        {canAttach && !picking && (
          <button type="button" className="cpg-link-btn cpg-attach-btn" onClick={() => setPicking(true)}>
            + Прикрепить договор
          </button>
        )}
      </div>
      {picking && <AttachPicker excludeIds={shownIds} onPick={attach} onClose={() => setPicking(false)} />}

      {groups.length === 0 ? null : isPhone ? (
        <ul className="cpg-contract-cards">
          {groups.map(({ root, children, actual }) => (
            <li key={root.id} className="cpg-contract-card">
              {[{ doc: root, depth: -1 }, ...children].map(({ doc, depth }) => {
                const t = docTitle(doc)
                const amount = effectiveDocumentAmount(doc)
                return (
                  <div key={doc.id} className={`cpg-contract-card-row${depth >= 0 ? ' is-ds' : ''}`}>
                    <div className="cpg-contract-card-head">
                      <div>
                        <span className="cpg-doc-kind">{t.kind}</span>
                        {docLink(doc, `${t.num}${t.date ? ` от ${t.date}` : ''}`)}
                        {depth < 0 && <ManualControls {...manualProps(doc)} />}
                      </div>
                      <StatusBadge status={doc.status} />
                    </div>
                    {depth < 0 && doc.objects?.name && <div className="cpg-contract-card-obj">{doc.objects.name}</div>}
                    {amount != null && (
                      <div className="cpg-contract-card-sum">
                        {formatMoney(amount, doc.currency || 'RUB')}
                        {depth < 0 && actual != null && <span className="cpg-sum-actual"> · с учётом ДС {formatMoney(actual, doc.currency || 'RUB')}</span>}
                      </div>
                    )}
                  </div>
                )
              })}
            </li>
          ))}
        </ul>
      ) : (
        <div className="cpg-table-wrap">
          <table className="cpg-contracts-table">
            <colgroup>
              <col className="cpg-col-doc" />
              <col className="cpg-col-obj" />
              <col />
              <col className="cpg-col-sum" />
              <col className="cpg-col-status" />
            </colgroup>
            <thead>
              <tr>
                <th>Документ</th>
                <th>Объект</th>
                <th>Предмет</th>
                <th className="cpg-num">Сумма</th>
                <th>Статус</th>
              </tr>
            </thead>
            {groups.map(({ root, children, actual }) => (
              <tbody key={root.id} className="cpg-contract-group">
                {[{ doc: root, depth: -1 }, ...children].map(({ doc, depth }) => {
                  const t = docTitle(doc)
                  const amount = effectiveDocumentAmount(doc)
                  return (
                    <tr key={doc.id} className={depth >= 0 ? 'is-ds' : undefined}>
                      <td>
                        <div className="cpg-doc-cell" style={depth >= 0 ? { paddingLeft: `${0.75 + depth * 0.75}rem` } : undefined}>
                          <span className="cpg-doc-kind">{t.kind}</span>
                          {docLink(doc, t.num)}
                          {t.date && <span className="cpg-doc-date">от {t.date}</span>}
                          {depth < 0 && <ManualControls {...manualProps(doc)} />}
                        </div>
                      </td>
                      <td>{depth < 0 ? (doc.objects?.name || <span className="muted-dash">—</span>) : null}</td>
                      <td>
                        {doc.work_name
                          ? <div className="cpg-work" title={doc.work_name}>{doc.work_name}</div>
                          : depth < 0 ? <span className="muted-dash">—</span> : null}
                      </td>
                      <td className="cpg-num">
                        {amount != null ? formatMoney(amount, doc.currency || 'RUB') : <span className="muted-dash">—</span>}
                        {depth < 0 && actual != null && (
                          <div className="cpg-sum-actual" title="Сумма договора с завершёнными ДС">
                            с учётом ДС {formatMoney(actual, doc.currency || 'RUB')}
                          </div>
                        )}
                      </td>
                      <td><StatusBadge status={doc.status} /></td>
                    </tr>
                  )
                })}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </>
  )
}
