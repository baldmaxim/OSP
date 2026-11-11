import { useCallback, useEffect, useMemo, useState } from 'react'
import { su10Orgs } from '../../api'
import { STATE_TEXT, REASON_TEXT } from '../../utils/su10Orgs'
import '../admin/Su10OrgsTab.css'

// Карточка контрагента → «Организация СУ-10» (только администратор; сервер — server/osp-api/src/routes/orgAdmin.js).
// Связанная организация СУ-10 (её сотрудники входят подрядчиками этого контрагента) или «Связать…» с выбором из реестра СУ-10:
// путь для нового контрагента, заведённого в ОСП. Похожие по ИНН и названию — первыми; это подсказка, решает администратор.
// Вкладка выключена на сервере (нет миграции или служебного клиента СУ-10) — блока нет.
export default function CounterpartySu10Org({ counterpartyId }) {
  const [data, setData] = useState(null)
  const [off, setOff] = useState(false)
  const [picking, setPicking] = useState(false)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null) // { kind: 'ok' | 'err', text }

  const load = useCallback(async () => {
    try {
      setData(await su10Orgs.ofCounterparty(counterpartyId))
    } catch (err) {
      if (err.unavailable || err.status === 403) setOff(true)
      else setMessage({ kind: 'err', text: err.message || 'Не удалось загрузить организацию СУ-10' })
    }
  }, [counterpartyId])
  useEffect(() => { setData(null); setOff(false); setPicking(false); setMessage(null); load() }, [load])

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase().replace(/ё/g, 'е')
    const list = data?.orgs || []
    return (s ? list.filter((o) => `${o.name} ${o.inn || ''}`.toLowerCase().replace(/ё/g, 'е').includes(s)) : list).slice(0, 30)
  }, [data, q])

  if (off) return null
  const run = async (fn, okText) => {
    setBusy(true)
    setMessage(null)
    try {
      const r = await fn()
      setMessage({ kind: 'ok', text: typeof okText === 'function' ? okText(r) : okText })
      setPicking(false)
      await load()
    } catch (err) {
      setMessage({ kind: 'err', text: err.message || 'Не удалось выполнить действие' })
    } finally {
      setBusy(false)
    }
  }
  const unlink = () => {
    if (!window.confirm(`Отвязать организацию СУ-10 «${data.link.name}»? Подрядчики этой организации сразу потеряют доступ к порталу.`)) return
    run(() => su10Orgs.unlink(data.link.orgId), (r) => `Связь снята${r.revoked ? ` — закрыто сессий: ${r.revoked}` : ''}`)
  }
  const link = (o) => {
    if (!window.confirm(`Связать контрагента с организацией СУ-10 «${o.name}»? Её сотрудники будут входить подрядчиками этого контрагента и увидят его историю.`)) return
    run(() => su10Orgs.link(o.id, counterpartyId), 'Организация СУ-10 связана')
  }

  return (
    <section className="cpg-section so-cp-block">
      <h4 className="cpg-section-title">Организация СУ-10</h4>
      {!data ? <div className="cpg-muted">{message ? '' : 'Загрузка…'}</div>
        : data.link ? (
          <div className="so-org-line">
            <span className="so-name">{data.link.name}</span>
            {data.link.inn && <span className="so-muted">ИНН {data.link.inn}</span>}
            <span className={`so-chip ${data.link.state === 'active' ? 'is-ok' : 'is-bad'}`}>{STATE_TEXT[data.link.state] || data.link.state}</span>
            <button type="button" className="so-btn so-danger" disabled={busy} onClick={unlink}>Отвязать</button>
          </div>
        ) : (
          <>
            <div className="cpg-muted">Не связан: сотрудники подрядчика не смогут войти через СУ-10 с этим контрагентом.</div>
            {!picking ? (
              <button type="button" className="so-btn" onClick={() => setPicking(true)} disabled={!data.orgs?.length}
                title={data.orgs?.length ? undefined : 'В реестре СУ-10 нет свободных организаций-подрядчиков'}>Связать…</button>
            ) : (
              <div className="so-pick">
                <input className="so-search-input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Организация СУ-10: название или ИНН" aria-label="Поиск организации СУ-10" />
                <ul className="so-cands">
                  {shown.map((o) => (
                    <li key={o.id} className="so-cand">
                      <div className="so-cand-main">
                        <span className="so-name">{o.name}</span>
                        {o.inn && <span className="so-sub">ИНН {o.inn}</span>}
                        {o.reasons?.length > 0 && <div className="so-chips">{o.reasons.map((r) => <span key={r} className="so-chip">{REASON_TEXT[r] || r}</span>)}</div>}
                      </div>
                      <button type="button" className="so-btn" disabled={busy} onClick={() => link(o)}>Связать</button>
                    </li>
                  ))}
                  {shown.length === 0 && <li className="so-muted">Ничего не нашлось.</li>}
                </ul>
                <button type="button" className="so-btn" onClick={() => setPicking(false)} disabled={busy}>Отмена</button>
              </div>
            )}
          </>
        )}
      {message && <p className={message.kind === 'err' ? 'so-error' : 'so-note'}>{message.text}</p>}
    </section>
  )
}
