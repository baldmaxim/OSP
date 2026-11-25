import { useCallback, useEffect, useState } from 'react'
import { loadSupplyList, decideSupplyAccess } from '../../services/contractorBids'
import './BidRequestsBlock.css'

// Цены снабжения для подрядчиков на сайте (решение пользователя 24.11.2026, миграция 20270301) — в раскрытой строке реестра тендеров:
// подрядчики тендера с учёткой кабинета (участник или заявка не отклонена), сколько позиций расценили и сколько из них — ценами
// снабжения. Взять наши цены материалов подрядчик может только после того, как инженер разрешит (по просьбе подрядчика или сам).
// Цен здесь нет. Нет функции (база не обновлена) или подрядчиков на сайте нет — блока нет.

const STATUS = {
  requested: { text: 'просит цены снабжения', cls: 'is-requested' },
  granted: { text: 'цены снабжения разрешены', cls: 'is-granted' },
  denied: { text: 'цены снабжения запрещены', cls: 'is-denied' },
}
const ACCESS = { invited: 'участник', accepted: 'участник по заявке', pending: 'заявка ждёт решения' }

const fmt = (v) => {
  if (!v) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU')
}

export default function BidSupplyAccessBlock({ tenderId, canEdit, onDecided, reloadKey = 0 }) {
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setRows(await loadSupplyList([tenderId]))
      setError('')
    } catch (e) {
      setError(e.message || String(e))
      setRows([])
    }
  }, [tenderId])
  useEffect(() => { load() }, [load, reloadKey])

  const decide = async (r, allow) => {
    const name = r.counterparty_name || 'организации'
    if (allow && !window.confirm(`Разрешить «${name}» взять цены снабжения материалов этого тендера? Подрядчик увидит цены снабжения по позициям ВОР (без поставщиков и документов).`)) return
    setBusy(r.counterparty_id)
    setError('')
    try {
      await decideSupplyAccess(tenderId, r.counterparty_id, allow)
      await load()
      onDecided?.({ counterpartyId: r.counterparty_id, name: r.counterparty_name || null, allow })
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(null)
    }
  }

  if (!rows || rows.length === 0) return error ? <div className="bidreq-error">{error}</div> : null

  const asking = rows.filter((r) => r.status === 'requested').length
  return (
    <div className="bidreq bidsup">
      <div className="bidreq-title">
        Подрядчики на сайте: цены снабжения
        {asking > 0 && <span className="bidreq-count">{asking} просят разрешение</span>}
      </div>
      {error && <div className="bidreq-error">{error}</div>}
      <ul className="bidreq-list">
        {rows.map((r) => {
          const st = STATUS[r.status]
          return (
            <li key={r.counterparty_id} className={`bidreq-item${st ? ` ${st.cls}` : ''}`}>
              <div className="bidreq-org">
                <b>{r.counterparty_name || 'Организация'}</b>
                {r.counterparty_inn && <span> · ИНН {r.counterparty_inn}</span>}
                {st && <span className={`bidsup-chip ${st.cls}`}>{st.text}</span>}
                <span className="bidreq-meta">
                  {ACCESS[r.access] || r.access}
                  {' · '}расценено на сайте: {r.priced}{r.from_supply > 0 ? `, из них ценами снабжения ${r.from_supply}` : ''}
                  {r.status === 'requested' && r.requested_at && ` · просьба ${fmt(r.requested_at)}${r.requested_by_name ? ` (${r.requested_by_name})` : ''}`}
                  {(r.status === 'granted' || r.status === 'denied') && r.decided_at && ` · решение ${fmt(r.decided_at)}${r.decided_by_name ? ` (${r.decided_by_name})` : ''}`}
                </span>
              </div>
              {canEdit && (
                <div className="bidreq-actions">
                  {r.status !== 'granted' && (
                    <button type="button" className="btn-primary" disabled={busy === r.counterparty_id} onClick={() => decide(r, true)}>
                      Разрешить цены снабжения
                    </button>
                  )}
                  {(r.status === 'requested' || r.status === 'granted') && (
                    <button type="button" className="btn-secondary" disabled={busy === r.counterparty_id} onClick={() => decide(r, false)}>
                      {r.status === 'granted' ? 'Запретить' : 'Отказать'}
                    </button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
