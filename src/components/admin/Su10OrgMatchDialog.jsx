import { useEffect, useState } from 'react'
import { su10Orgs } from '../../api'
import { REASON_TEXT, FLAG_TEXT, counterpartyLabel } from '../../utils/su10Orgs'
import './Su10OrgsTab.css'

// Окно «Сопоставить…»: организация СУ-10 → контрагент ОСП. Подсказки (ИНН, название, домен почты) — с сервера
// (server/osp-api/src/lib/orgMatch.js); это подсказки, решает администратор. Поиск — по названию, ИНН, «№ 12».
// «Создать контрагента» — название и ИНН из реестра СУ-10 (можно поправить); контрагент с тем же ИНН уже есть — сервер
// откажет и назовёт его, окно предложит связать с ним. Ошибка связи открыла бы подрядчику чужую историю — поэтому у
// каждой подсказки видно, почему она предложена, а пометки «проверьте» требуют подтверждения.
export default function Su10OrgMatchDialog({ org, onClose, onDone, notify }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState(org.name || '')
  const [inn, setInn] = useState(org.inn || '')
  const [taken, setTaken] = useState(null) // { counterpartyId, number }

  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      setError('')
      su10Orgs.candidates(org.id, q.trim())
        .then((d) => { if (alive) setData(d) })
        .catch((err) => { if (alive) setError(err.message || 'Не удалось загрузить подсказки') })
    }, q.trim() ? 300 : 0)
    return () => { alive = false; clearTimeout(t) }
  }, [org.id, q])

  const done = (text) => {
    notify?.('ok', text)
    onDone?.()
  }
  const fail = (err) => {
    if (err.code === 'inn_taken') {
      setTaken({ counterpartyId: err.counterpartyId, number: err.number })
      return
    }
    notify?.('err', err.message || 'Не удалось выполнить действие')
  }

  const link = async (cand) => {
    const warn = cand.flags?.filter((f) => f === 'hint_name' || f === 'checksum' || f === 'claimed' || f === 'duplicate') || []
    if (warn.length && !window.confirm(`Проверьте: ${warn.map((f) => FLAG_TEXT[f]).join('; ')}.\nСвязать «${org.name}» с ${counterpartyLabel(cand.counterparty)}?`)) return
    setBusy(true)
    try {
      const r = await su10Orgs.link(org.id, cand.counterparty.id)
      done(`Организация связана с ${counterpartyLabel(cand.counterparty)}${r.revoked ? ` — закрыто сессий: ${r.revoked}` : ''}`)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }
  const linkById = async (counterpartyId) => {
    setBusy(true)
    try {
      await su10Orgs.link(org.id, counterpartyId)
      done('Организация связана с найденным контрагентом')
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }
  const create = async () => {
    const cleanInn = inn.replace(/\s+/g, '')
    if (cleanInn && !/^(\d{10}|\d{12})$/.test(cleanInn)) { notify?.('err', 'ИНН — 10 или 12 цифр'); return }
    setBusy(true)
    setTaken(null)
    try {
      const r = await su10Orgs.createCounterparty(org.id, { name: name.trim() || null, inn: cleanInn })
      done(`Создан контрагент ${counterpartyLabel(r.counterparty)} и связан с организацией`)
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const cands = data?.candidates || []
  return (
    <div className="so-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="so-dialog" role="dialog" aria-modal="true" aria-label={`Сопоставить: ${org.name}`}>
        <div className="so-dialog-head">
          <div>
            <h3>Сопоставить: {org.name}</h3>
            <span className="so-sub">Организация СУ-10{org.inn ? ` · ИНН ${org.inn}` : ' · ИНН в реестре СУ-10 не указан'}</span>
          </div>
          <button type="button" className="so-close" aria-label="Закрыть" onClick={onClose} disabled={busy}>×</button>
        </div>
        <p className="so-hint">Связь открывает сотрудникам этой организации историю выбранного контрагента: тендеры, заявки, договоры.
          Проверьте ИНН в карточке контрагента, если он не совпал с реестром СУ-10.</p>
        <input className="so-search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск: название, ИНН или «№ 12»" aria-label="Поиск контрагента" />
        {error ? <p className="so-error">{error}</p>
          : !data ? <p className="so-muted">Загрузка подсказок…</p>
            : cands.length === 0 ? <p className="so-muted">{q.trim() ? 'Ничего не нашлось.' : 'Подсказок нет — найдите контрагента поиском или создайте нового.'}</p>
              : (
                <ul className="so-cands">
                  {cands.map((c) => {
                    const blocked = c.counterparty.status === 'blacklist' || (c.linkedTo && c.linkedTo !== org.id)
                    return (
                      <li key={c.counterparty.id} className={`so-cand${c.confident ? ' is-confident' : ''}`}>
                        <div className="so-cand-main">
                          <span className="so-name">{counterpartyLabel(c.counterparty)}</span>
                          <span className="so-sub">{c.counterparty.inn ? `ИНН ${c.counterparty.inn}` : 'ИНН не указан'}</span>
                          <div className="so-chips">
                            {c.confident && <span className="so-chip is-ok">ИНН совпал</span>}
                            {(c.reasons || []).map((r) => <span key={r} className="so-chip">{REASON_TEXT[r] || r}</span>)}
                            {(c.flags || []).map((f) => <span key={f} className={`so-chip ${f === 'main_record' ? 'is-ok' : 'is-warn'}`}>{FLAG_TEXT[f] || f}</span>)}
                            {c.linkedTo && c.linkedTo !== org.id && <span className="so-chip is-bad">уже связан с другой организацией</span>}
                          </div>
                        </div>
                        <div className="so-actions">
                          <button type="button" className="btn-primary" disabled={busy || blocked} onClick={() => link(c)}
                            title={blocked ? 'Контрагент в чёрном списке или уже связан' : undefined}>Связать</button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
        <div className="so-create">
          <div className="so-label">Контрагента в ОСП нет — создать из реестра СУ-10</div>
          <div className="so-create-row">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={255} placeholder="Название" aria-label="Название контрагента" />
            <input className="so-inn-input" value={inn} onChange={(e) => setInn(e.target.value.replace(/[^\d\s]/g, '').slice(0, 14))} placeholder="ИНН (необязательно)" aria-label="ИНН" inputMode="numeric" />
            <button type="button" className="btn-secondary" disabled={busy || !name.trim()} onClick={create}>Создать контрагента</button>
          </div>
          {taken && (
            <p className="so-warn">Контрагент с таким ИНН уже есть (№ {taken.number ?? '—'}).{' '}
              <button type="button" className="btn-soft" disabled={busy} onClick={() => linkById(taken.counterpartyId)}>Связать с ним</button>
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
