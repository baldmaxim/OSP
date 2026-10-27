import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadCounterpartyDcRequests } from '../../services/counterpartyContracts'
import { amendmentLabel, contractLabel, dcWorkState, groupDcRequestsByContract, summarizeDcRequests } from '../../utils/dcRequestContracts'
import { formatAmount } from '../../utils/money'

// «Заявки на ДС» во «Общей информации» карточки контрагента (миграция 20261109): заявки контрагента по его
// договорам — какие отработаны (этап «Завершено») и какие занесены в ДС реестра «Договоры и ДС». Договор и ДС
// заявке выбирают (или они подставляются сами) в реестре заявок. Без колонок договора в базе — одним списком.

// Сумма заявки: утверждённая, а пока её нет — поданная.
function RequestAmount({ req }) {
  const approved = req.amount_after != null && req.amount_after !== '' ? Number(req.amount_after) : null
  const submitted = req.amount_before != null && req.amount_before !== '' ? Number(req.amount_before) : null
  if (approved != null) return <>{formatAmount(approved)}<div className="cpg-sum-actual">утверждено</div></>
  if (submitted != null) return <>{formatAmount(submitted)}<div className="cpg-sum-actual">подано</div></>
  return <span className="muted-dash">—</span>
}

function WorkBadge({ req }) {
  const s = dcWorkState(req)
  return <span className={`cpg-dcr-state ${s.className}`}>{s.label}</span>
}

function AmendmentCell({ req, docs }) {
  if (!req.amendment_id) return <span className="cpg-muted">не занесена</span>
  const doc = docs.get(req.amendment_id)
  return (
    <a href={`/contracts/${req.amendment_id}`} target="_blank" rel="noopener noreferrer" className="cpg-doc-link cpg-dcr-ds"
       title="Заявка занесена в это ДС — открыть карточку ДС в новой вкладке">
      {doc ? amendmentLabel(doc) : 'ДС'}
    </a>
  )
}

const requestNo = (req) => (req.request_number != null ? `№ ${req.request_number}` : '')

export default function CounterpartyDcRequests({ counterpartyId, isPhone }) {
  const [state, setState] = useState({ loading: true, error: '', requests: [], docs: new Map(), linked: false })
  const requestRef = useRef(0)

  const load = useCallback(async () => {
    const request = ++requestRef.current
    setState(s => ({ ...s, loading: true, error: '' }))
    try {
      const data = await loadCounterpartyDcRequests(counterpartyId)
      if (request === requestRef.current) setState({ loading: false, error: '', ...data })
    } catch (err) {
      console.error('Заявки на ДС контрагента:', err?.message || err)
      if (request === requestRef.current) setState(s => ({ ...s, loading: false, error: err?.message || 'ошибка запроса', requests: [] }))
    }
  }, [counterpartyId])

  useEffect(() => { load() }, [load])

  const groups = useMemo(() => groupDcRequestsByContract(state.requests, state.docs), [state.requests, state.docs])
  const summary = useMemo(() => summarizeDcRequests(state.requests), [state.requests])

  if (state.loading) return <div className="cpg-muted">Загрузка заявок на ДС…</div>
  if (state.error) {
    return (
      <div className="cpg-muted">
        Не удалось загрузить заявки на ДС: {state.error}{' '}
        <button type="button" className="cpg-link-btn" onClick={load}>Повторить</button>
      </div>
    )
  }

  const registryLink = (
    <a href={`/dc-requests?counterparty=${counterpartyId}`} target="_blank" rel="noopener noreferrer" className="cpg-link-btn cpg-attach-btn"
       title="Заявки этого контрагента в реестре «Заявка на ДС» (новая вкладка)">Открыть в реестре заявок</a>
  )

  if (summary.total === 0) {
    return <div className="cpg-dcr-bar"><span className="cpg-dcr-count">Заявок на ДС с этим контрагентом нет.</span></div>
  }

  const groupTitle = (g) => (g.contract
    ? <a href={`/contracts/${g.contract.id}`} target="_blank" rel="noopener noreferrer" className="cpg-doc-link"
         title="Открыть карточку договора в новой вкладке">Договор {contractLabel(g.contract)}</a>
    : <span className="cpg-dcr-nocontract">{state.linked ? 'Договор не указан' : 'Заявки'}</span>)
  const groupMeta = (g) => {
    const s = summarizeDcRequests(g.requests)
    return `заявок: ${s.total} · отработано: ${s.done}${state.linked ? ` · в ДС: ${s.inDs}` : ''}`
  }

  return (
    <>
      <div className="cpg-dcr-bar">
        <span className="cpg-dcr-count">
          Заявок на ДС: {summary.total} · отработано: {summary.done}{state.linked ? ` · занесено в ДС: ${summary.inDs}` : ''}
        </span>
        {registryLink}
      </div>
      {!state.linked && (
        <div className="cpg-muted cpg-attach-note">
          Договор и ДС у заявок появятся после обновления базы (миграция 20261109_contracts_dc_requests).
        </div>
      )}

      {isPhone ? (
        <ul className="cpg-contract-cards">
          {groups.map(g => (
            <li key={g.contract?.id || 'none'} className="cpg-contract-card">
              <div className="cpg-contract-card-row">
                <div className="cpg-contract-card-head"><div>{groupTitle(g)}</div></div>
                <div className="cpg-contract-card-obj">{groupMeta(g)}</div>
              </div>
              {g.requests.map(req => (
                <div key={req.id} className="cpg-contract-card-row is-ds">
                  <div className="cpg-contract-card-head">
                    <div>
                      <span className="cpg-doc-kind">Заявка {requestNo(req)}</span>
                      <div>{req.ds_number ? `№ ДС ${req.ds_number}` : 'без № ДС'}</div>
                    </div>
                    <WorkBadge req={req} />
                  </div>
                  {req.works_description && <div className="cpg-work cpg-contract-card-obj">{req.works_description}</div>}
                  {state.linked && <div className="cpg-contract-card-sum"><AmendmentCell req={req} docs={state.docs} /></div>}
                </div>
              ))}
            </li>
          ))}
        </ul>
      ) : (
        <div className="cpg-table-wrap">
          <table className="cpg-contracts-table cpg-dcr-table">
            <colgroup>
              <col className="cpg-col-dcr-no" />
              <col className="cpg-col-dcr-ds" />
              <col className="cpg-col-dcr-obj" />
              <col />
              <col className="cpg-col-sum" />
              <col className="cpg-col-status" />
              {state.linked && <col className="cpg-col-dcr-in-ds" />}
            </colgroup>
            <thead>
              <tr>
                <th>Заявка</th>
                <th>№ ДС</th>
                <th>Объект</th>
                <th>Описание ДС</th>
                <th className="cpg-num">Сумма, руб.</th>
                <th>Статус</th>
                {state.linked && <th>В ДС</th>}
              </tr>
            </thead>
            {groups.map(g => (
              <tbody key={g.contract?.id || 'none'} className="cpg-contract-group">
                <tr className="cpg-dcr-group">
                  <td colSpan={state.linked ? 7 : 6}>
                    {groupTitle(g)}
                    <span className="cpg-dcr-group-meta">{groupMeta(g)}</span>
                  </td>
                </tr>
                {g.requests.map(req => (
                  <tr key={req.id}>
                    <td className="cpg-mono">{requestNo(req) || <span className="muted-dash">—</span>}</td>
                    <td>{req.ds_number || <span className="muted-dash">—</span>}</td>
                    <td>{req.objects?.name || <span className="muted-dash">—</span>}</td>
                    <td>
                      {req.works_description
                        ? <div className="cpg-work" title={req.works_description}>{req.works_description}</div>
                        : <span className="muted-dash">—</span>}
                    </td>
                    <td className="cpg-num"><RequestAmount req={req} /></td>
                    <td><WorkBadge req={req} /></td>
                    {state.linked && <td><AmendmentCell req={req} docs={state.docs} /></td>}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </>
  )
}
