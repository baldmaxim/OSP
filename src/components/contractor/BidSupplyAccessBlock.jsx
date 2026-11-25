import { useCallback, useEffect, useState } from 'react'
import { loadSupplyList, decideSupplyAccess, grantSupplyItems } from '../../services/contractorBids'
import BidSupplyItemsDialog from './BidSupplyItemsDialog'
import './BidRequestsBlock.css'

// Цены снабжения для подрядчиков на сайте — в раскрытой строке «Тендеров на материалы» (решение пользователя 25.11.2026, миграция
// 20270303; раньше — в реестре тендеров основного строительства, тендер целиком). Видит и решает только инженер ОСП или администратор
// (страница блок другим не показывает, база им отказывает). tenderId — основной тендер (цены снабжения и расценка подрядчика — его).
// Подрядчики тендера с учёткой кабинета (участник или заявка не отклонена), сколько позиций открыто и сколько расценили. Открывать —
// по позициям («Выбрать позиции…», окно со списком) или маленькой кнопкой «все сразу» (все нынешние позиции с ценой снабжения).
// Цен в блоке нет. Нет функции (база не обновлена) или подрядчиков на сайте нет — блока нет.

const STATUS = {
  requested: { text: 'просит цены снабжения', cls: 'is-requested' },
  granted: { text: 'цены снабжения открыты', cls: 'is-granted' },
  denied: { text: 'цены снабжения запрещены', cls: 'is-denied' },
}
const ACCESS = { invited: 'участник', accepted: 'участник по заявке', pending: 'заявка ждёт решения' }

const fmt = (v) => {
  if (!v) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU')
}

export default function BidSupplyAccessBlock({ tenderId, tenderNumber, onDecided, reloadKey = 0, emptyText = '' }) {
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState('')
  const [picking, setPicking] = useState(null) // строка подрядчика, для которой открыто окно позиций

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

  const finish = async (r, text) => {
    await load()
    onDecided?.({ counterpartyId: r.counterparty_id, name: r.counterparty_name || null, text })
  }

  const run = async (r, fn) => {
    setBusy(r.counterparty_id)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(null)
    }
  }

  const grantAll = (r) => run(r, async () => {
    const name = r.counterparty_name || 'организации'
    if (!window.confirm(`Открыть «${name}» цены снабжения всех ${r.supply_items} позиций с ценой снабжения? Подрядчик увидит цены (без поставщиков) и счета к ценам, которые возьмёт. Позиции, которые снабжение расценит позже, сами не откроются.`)) return
    const n = await grantSupplyItems(tenderId, r.counterparty_id, { all: true })
    await finish(r, n > 0 ? `открыты все позиции (${n})` : 'запрещены')
  })

  const deny = (r) => run(r, async () => {
    const name = r.counterparty_name || 'организации'
    if (r.status === 'granted' && !window.confirm(`Закрыть «${name}» цены снабжения всех позиций? Цены, которые подрядчик уже взял, останутся у него, но без счетов.`)) return
    await decideSupplyAccess(tenderId, r.counterparty_id, false)
    await finish(r, r.status === 'granted' ? 'запрещены' : 'отказано')
  })

  if (rows === null) return emptyText ? <p className="bsi-empty">Загрузка…</p> : null
  if (rows.length === 0) return error ? <div className="bidreq-error">{error}</div> : (emptyText ? <p className="bsi-empty">{emptyText}</p> : null)

  const asking = rows.filter((r) => r.status === 'requested').length
  return (
    <div className="bidreq bidsup">
      <div className="bidreq-title">
        Подрядчики на сайте
        {asking > 0 && <span className="bidreq-count">{asking} просят</span>}
      </div>
      {error && <div className="bidreq-error">{error}</div>}
      <ul className="bidreq-list">
        {rows.map((r) => {
          const st = STATUS[r.status]
          const isBusy = busy === r.counterparty_id
          const total = r.supply_items ?? 0
          const open = r.granted_items ?? 0
          return (
            <li key={r.counterparty_id} className={`bidreq-item${st ? ` ${st.cls}` : ''}`}>
              <div className="bidreq-org">
                <b>{r.counterparty_name || 'Организация'}</b>
                {r.counterparty_inn && <span> · ИНН {r.counterparty_inn}</span>}
                {st && <span className={`bidsup-chip ${st.cls}`}>{st.text}</span>}
                <span className="bidreq-meta">
                  {ACCESS[r.access] || r.access}
                  {' · '}открыто позиций: {open} из {total}
                  {' · '}расценено на сайте: {r.priced}{r.from_supply > 0 ? `, из них ценами снабжения ${r.from_supply}` : ''}
                  {r.status === 'requested' && r.requested_at && ` · просьба ${fmt(r.requested_at)}${r.requested_by_name ? ` (${r.requested_by_name})` : ''}`}
                  {(r.status === 'granted' || r.status === 'denied') && r.decided_at && ` · решение ${fmt(r.decided_at)}${r.decided_by_name ? ` (${r.decided_by_name})` : ''}`}
                </span>
              </div>
              <div className="bidreq-actions">
                <button type="button" className="btn-primary" disabled={isBusy || total === 0} onClick={() => setPicking(r)}
                  title={total === 0 ? 'Снабжение ещё не расценило материалы этого тендера' : 'Отметить позиции, цены снабжения которых увидит подрядчик'}>
                  Выбрать позиции…
                </button>
                {total > 0 && open < total && (
                  <button type="button" className="btn-secondary bidsup-all" disabled={isBusy} onClick={() => grantAll(r)}
                    title="Открыть цены снабжения всех нынешних позиций сразу">
                    все сразу
                  </button>
                )}
                {(r.status === 'requested' || r.status === 'granted') && (
                  <button type="button" className="btn-secondary" disabled={isBusy} onClick={() => deny(r)}>
                    {r.status === 'granted' ? 'Закрыть все' : 'Отказать'}
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      {picking && (
        <BidSupplyItemsDialog
          tenderId={tenderId}
          tenderNumber={tenderNumber}
          counterparty={picking}
          onClose={() => setPicking(null)}
          onSaved={async (n) => {
            const r = picking
            setPicking(null)
            await finish(r, n > 0 ? `открыто позиций: ${n}` : 'запрещены')
          }}
        />
      )}
    </div>
  )
}
