import { useCallback, useEffect, useState } from 'react'
import { loadBidRequests, decideBidRequest } from '../../services/contractorBids'
import './BidRequestsBlock.css'

// Заявки подрядчиков с сайта (кабинет подрядчика, миграция 20261102) в раскрытой строке тендера: организация,
// кто подал и когда. Инженер решает, сделать ли подрядчика участником тендера (строка в списке участников ниже)
// или отклонить. Пока решения нет, подрядчик уже может расценивать на сайте. Принятые — уже в списке участников,
// здесь не показываются. Нет таблицы (база не обновлена) — блока нет.

const fmt = (v) => {
  if (!v) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : `${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
}

export default function BidRequestsBlock({ tenderId, canEdit, onDecided }) {
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const list = await loadBidRequests([tenderId])
      setRows(list === null ? null : list.filter((r) => r.status !== 'accepted'))
    } catch (e) {
      setError(e.message || String(e))
      setRows([])
    }
  }, [tenderId])
  useEffect(() => { load() }, [load])

  const decide = async (r, accept) => {
    const name = r.counterparties?.name || 'организацию'
    if (!accept && !window.confirm(`Отклонить заявку «${name}»? Подрядчик больше не сможет менять цены этого тендера.`)) return
    setBusy(r.id)
    setError('')
    try {
      await decideBidRequest(r.id, accept)
      await load()
      onDecided?.({ request: r, accepted: accept })
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(null)
    }
  }

  if (!rows || rows.length === 0) return error ? <div className="bidreq-error">{error}</div> : null

  const pending = rows.filter((r) => r.status === 'pending')
  return (
    <div className="bidreq">
      <div className="bidreq-title">
        Заявки с сайта{pending.length > 0 && <span className="bidreq-count">{pending.length} ждут решения</span>}
      </div>
      {error && <div className="bidreq-error">{error}</div>}
      <ul className="bidreq-list">
        {rows.map((r) => (
          <li key={r.id} className={`bidreq-item is-${r.status}`}>
            <div className="bidreq-org">
              <b>{r.counterparties?.name || 'Организация'}</b>
              {r.counterparties?.inn && <span> · ИНН {r.counterparties.inn}</span>}
              <span className="bidreq-meta">
                {r.requested_by_name ? `${r.requested_by_name}, ` : ''}{fmt(r.requested_at)}
                {r.status === 'rejected' && ` · отклонена${r.decided_by_name ? ` (${r.decided_by_name})` : ''}`}
              </span>
            </div>
            {canEdit && (
              <div className="bidreq-actions">
                <button type="button" className="btn-primary" disabled={busy === r.id} onClick={() => decide(r, true)}>
                  Сделать участником
                </button>
                {r.status === 'pending' && (
                  <button type="button" className="btn-secondary" disabled={busy === r.id} onClick={() => decide(r, false)}>
                    Отклонить
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
