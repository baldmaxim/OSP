import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { db } from '../../api'
import { chunkList } from '../../utils/inChunks'
import { formatMoney } from '../../utils/estimateImport'
import { DOC_TYPE, effectiveDocumentAmount } from '../../utils/contractAmendments'
import { docTitle, groupCounterpartyDocs } from '../../utils/counterpartyDocs'

// Держать в согласии со STATUS_OPTIONS в ContractsPage.jsx.
const STATUS_LABEL = {
  new_request: 'Новая заявка',
  in_work: 'В работе',
  awaiting_paper_sign: 'Ожидание подписания',
  paused: 'Приостановка',
  completed: 'Завершено',
}

const DOC_FIELDS = 'id, display_id, record_type, parent_contract_id, root_contract_id, status, deleted_at, '
  + 'contract_number, contract_date, contract_amount, psdc_total, currency, work_name, objects(name)'

// В адрес уходят два списка id (id.in и root_contract_id.in) — порция меньше обычной.
const ROOT_CHUNK = 50

// Договоры и ДС, где контрагент — сторона: основной контрагент договора (contracts.counterparty_id) или одна
// из сторон (contract_counterparties). ДС берутся всем деревом договора: сторону ДС не переназначает.
async function loadCounterpartyDocs(counterpartyId) {
  const [direct, parties] = await Promise.all([
    db.from('contracts').select('id, root_contract_id').eq('counterparty_id', counterpartyId).is('deleted_at', null),
    db.from('contract_counterparties').select('contracts(id, root_contract_id, deleted_at)').eq('counterparty_id', counterpartyId),
  ])
  if (direct.error) throw direct.error
  if (parties.error) throw parties.error
  const roots = new Set()
  for (const d of direct.data || []) roots.add(d.root_contract_id || d.id)
  for (const p of parties.data || []) {
    const c = p.contracts
    if (c && !c.deleted_at) roots.add(c.root_contract_id || c.id)
  }
  if (roots.size === 0) return []
  const parts = await Promise.all(chunkList([...roots], ROOT_CHUNK).map(async (ids) => {
    const list = ids.join(',')
    const { data, error } = await db
      .from('contracts')
      .select(DOC_FIELDS)
      .or(`id.in.(${list}),root_contract_id.in.(${list})`)
      .is('deleted_at', null)
    if (error) throw error
    return data || []
  }))
  const byId = new Map()
  for (const row of parts.flat()) byId.set(row.id, row)
  return [...byId.values()]
}

function StatusBadge({ status }) {
  const value = status || 'new_request'
  return <span className={`cpg-cstatus cpg-cstatus-${value}`}>{STATUS_LABEL[value] || value}</span>
}

export default function CounterpartyContracts({ counterpartyId, isPhone }) {
  const [state, setState] = useState({ loading: true, error: '', docs: [] })
  // Карточку переключили на другого контрагента, пока шёл запрос, — опоздавший ответ не показываем.
  const requestRef = useRef(0)

  const load = useCallback(async () => {
    const request = ++requestRef.current
    setState({ loading: true, error: '', docs: [] })
    try {
      const docs = await loadCounterpartyDocs(counterpartyId)
      if (request === requestRef.current) setState({ loading: false, error: '', docs })
    } catch (err) {
      console.error('Договоры контрагента:', err?.message || err)
      if (request === requestRef.current) setState({ loading: false, error: err?.message || 'ошибка запроса', docs: [] })
    }
  }, [counterpartyId])

  useEffect(() => { load() }, [load])

  const groups = useMemo(() => groupCounterpartyDocs(state.docs), [state.docs])

  const contractsCount = groups.filter(g => g.root.record_type === DOC_TYPE.CONTRACT).length
  const amendmentsCount = state.docs.length - contractsCount

  if (state.loading) return <div className="cpg-muted">Загрузка договоров…</div>
  if (state.error) {
    return (
      <div className="cpg-muted">
        Не удалось загрузить договоры: {state.error}{' '}
        <button type="button" className="cpg-link-btn" onClick={load}>Повторить</button>
      </div>
    )
  }
  if (groups.length === 0) return <div className="cpg-muted">Договоров и ДС с этим контрагентом нет.</div>

  const docLink = (doc, children) => (
    <a href={`/contracts/${doc.id}`} target="_blank" rel="noopener noreferrer" className="cpg-doc-link"
       title="Открыть карточку документа в новой вкладке">{children}</a>
  )

  return (
    <>
      <div className="cpg-contracts-count">
        Договоров: {contractsCount}{amendmentsCount > 0 ? ` · ДС: ${amendmentsCount}` : ''}
      </div>
      {isPhone ? (
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
