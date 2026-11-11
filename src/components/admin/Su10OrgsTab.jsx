import { useCallback, useEffect, useMemo, useState } from 'react'
import { su10Orgs } from '../../api'
import {
  ORG_FILTERS, STATE_TEXT, KIND_TEXT, filterOrgs, hiddenUnlinked, orgStatus, counterpartyLabel, employeesWithoutException,
} from '../../utils/su10Orgs'
import Su10OrgMatchDialog from './Su10OrgMatchDialog'
import './Su10OrgsTab.css'

// «Администрирование» → «Организации СУ-10» (server/osp-api/src/routes/orgAdmin.js). Реестр организаций СУ-10 и связь каждой
// организации-подрядчика с контрагентом ОСП: по ней сервер ставит подрядчику контрагента при входе через СУ-10. Связывает
// администратор (решение пользователя 11.11.2026: автоматической связи нет); подсказки — в окне «Сопоставить…».
// Отвязка, чёрный список и удаление контрагента закрывают сессии его подрядчиков сразу. Сотрудник ОСП входит только со своей
// организацией СУ-10; исключение вносит суперадминистратор (с причиной). Вкладка работает и до переключения на вход через
// СУ-10 — связи тогда ни на что не влияют. СУ-10 не ответил — ненавязчивая строка, список — из прежней сверки.
const formatDateTime = (ts) => {
  if (!ts) return null
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function ExceptionForm({ employee, onSubmit, onCancel, busy }) {
  const [reason, setReason] = useState('')
  return (
    <form className="so-exc-form" onSubmit={(e) => { e.preventDefault(); onSubmit(reason.trim()) }}>
      <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Причина (обязательно)" aria-label={`Причина исключения: ${employee.fullName || ''}`} />
      <button type="submit" className="btn-soft" disabled={busy || reason.trim().length < 3}>Допустить</button>
      <button type="button" className="btn-soft" onClick={onCancel} disabled={busy}>Отмена</button>
    </form>
  )
}

export default function Su10OrgsTab({ notify, isSuperAdmin: superFromPage = false }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [registryNote, setRegistryNote] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState('unlinked')
  const [query, setQuery] = useState('')
  const [matchOrg, setMatchOrg] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [excFor, setExcFor] = useState(null) // subject

  const load = useCallback(async () => {
    setError('')
    try {
      setData(await su10Orgs.list())
    } catch (err) {
      setError(err.unavailable ? 'Вкладка на этом сервере не включена: нет миграции 20270201 или служебного клиента СУ-10.' : (err.message || 'Не удалось загрузить организации'))
    } finally {
      setLoading(false)
    }
  }, [])

  // Реестр СУ-10 перечитывается при открытии вкладки (сервер — не чаще раза в 15 с) и по кнопке.
  const refresh = useCallback(async ({ quiet = false } = {}) => {
    setRefreshing(true)
    try {
      const r = await su10Orgs.refresh()
      setRegistryNote(r.held ? `Сверка реестра отложена предохранителем (${(r.reasons || []).join(', ')}): большие изменения в реестре СУ-10 — сообщите администратору портала.`
        : quiet ? '' : `Реестр СУ-10 сверен: организаций — ${r.orgs}`)
    } catch (err) {
      setRegistryNote(err.unavailable ? '' : 'СУ-10 сейчас не ответил — список из прежней сверки.')
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { refresh({ quiet: true }).finally(load) }, [refresh, load])

  const keycloak = data?.mode === 'keycloak'
  const superAdmin = Boolean(data?.isSuperadmin ?? superFromPage)
  const orgs = useMemo(() => data?.orgs || [], [data])
  const counts = useMemo(() => Object.fromEntries(ORG_FILTERS.map((f) => [f.key, filterOrgs(orgs, { filter: f.key, keycloak }).length])), [orgs, keycloak])
  const shown = useMemo(() => filterOrgs(orgs, { filter, query, keycloak }), [orgs, filter, query, keycloak])
  const hidden = filter === 'unlinked' && !query ? hiddenUnlinked(orgs, keycloak) : 0
  const orgName = useMemo(() => new Map(orgs.map((o) => [o.id, o.name])), [orgs])

  const act = async (key, fn, okText) => {
    setBusyId(key)
    try {
      const r = await fn()
      notify?.('ok', typeof okText === 'function' ? okText(r) : okText)
      setExcFor(null)
      await load()
    } catch (err) {
      notify?.('err', err.message || 'Не удалось выполнить действие')
    } finally {
      setBusyId(null)
    }
  }
  const unlink = (o) => {
    const n = o.contractorsAffected || 0
    const text = `Отвязать «${o.name}» от ${counterpartyLabel(o.counterparty)}?\n\n`
      + `Подрядчики этой организации сразу потеряют доступ к порталу (сессии закроются, вход — «организация не сопоставлена»)`
      + `${n ? `: учёток портала с этим контрагентом — ${n}` : ''}.`
    if (!window.confirm(text)) return
    act(o.id, () => su10Orgs.unlink(o.id), (r) => `Связь снята${r.revoked ? ` — закрыто сессий: ${r.revoked}` : ''}`)
  }

  const reg = data?.registry
  return (
    <div className="so-tab">
      <div className="so-toolbar">
        <div className="so-switch" role="tablist" aria-label="Какие организации показать">
          {ORG_FILTERS.map((f) => (
            <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} className={filter === f.key ? 'is-active' : ''} onClick={() => setFilter(f.key)}>
              {f.label}<span className="so-count">{counts[f.key] ?? 0}</span>
            </button>
          ))}
        </div>
        <input className="so-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск: организация, контрагент, ИНН" aria-label="Поиск организации" />
        <button type="button" className="btn-secondary" onClick={() => refresh().then(load)} disabled={refreshing}>{refreshing ? 'Сверяем…' : 'Сверить с СУ-10'}</button>
      </div>
      {registryNote && <p className="so-note">{registryNote}</p>}
      {reg && (
        <p className="so-hint">
          {reg.generation ? `Реестр СУ-10 сверен: ${formatDateTime(reg.at) || '—'}.` : 'Реестр СУ-10 ещё не сверялся.'}
          {reg.error ? ' Последняя попытка не удалась — список из прежней сверки.' : ''}
          {' '}Подрядчик входит, только если его организация связана здесь с контрагентом; сотрудник ОСП — только со своей организацией СУ-10.
          {!keycloak && ' Вход через СУ-10 ещё не включён: связи можно готовить заранее, на вход по паролю они не влияют.'}
        </p>
      )}

      {loading ? <p className="so-muted">Загрузка…</p>
        : error ? <p className="so-error">{error} <button type="button" className="btn-soft" onClick={load}>Повторить</button></p>
          : shown.length === 0 ? <p className="so-muted">{filter === 'unlinked' ? 'Организаций без связи нет.' : 'Ничего не нашлось.'}{hidden ? ` Ещё ${hidden} без учёток и заявок — фильтр «Все».` : ''}</p>
            : (
              <>
                {hidden > 0 && <p className="so-hint">Показаны подрядчики, у которых есть учётки с доступом к порталу или заявки. Ещё {hidden} — в «Все».</p>}
                <div className="so-table-wrap">
                  <table className="so-table">
                    <thead>
                      <tr>
                        <th>Организация СУ-10</th>
                        <th className="so-inn">ИНН (СУ-10)</th>
                        <th>Вид и состояние</th>
                        <th className="so-num">Учёток с доступом</th>
                        <th>Контрагент ОСП</th>
                        <th className="so-actions-col">Действия</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((o) => {
                        const status = orgStatus(o)
                        const busy = busyId === o.id
                        const noExc = employeesWithoutException(o)
                        return (
                          <tr key={o.id}>
                            <td>
                              <span className="so-name">{o.name}</span>
                              {Array.isArray(o.employees) && o.kind !== 'own' && o.employees.length > 0 && (
                                <ul className="so-employees">
                                  {o.employees.map((e) => (
                                    <li key={e.subject}>
                                      <span className={`so-chip ${e.exception ? 'is-ok' : 'is-bad'}`}>{e.exception ? 'исключение' : 'сотрудник ОСП — не войдёт'}</span>
                                      <span>{e.fullName || 'без имени'}</span>
                                      {superAdmin && !e.exception && (excFor === e.subject
                                        ? <ExceptionForm employee={e} busy={busyId === e.subject} onCancel={() => setExcFor(null)}
                                          onSubmit={(reason) => act(e.subject, () => su10Orgs.addException(e.subject, reason), 'Исключение внесено')} />
                                        : <button type="button" className="btn-soft" onClick={() => setExcFor(e.subject)}>Допустить…</button>)}
                                    </li>
                                  ))}
                                </ul>
                              )}
                              {noExc.length > 0 && !superAdmin && <span className="so-sub">Допустить сотрудника может только суперадминистратор.</span>}
                            </td>
                            <td className="so-inn">{o.inn || '—'}</td>
                            <td>
                              <span className="so-chip">{KIND_TEXT[o.kind] || 'вид не указан'}</span>{' '}
                              <span className={`so-chip ${o.state === 'active' ? '' : 'is-bad'}`}>{STATE_TEXT[o.state] || o.state}</span>
                              {o.requests > 0 && <span className="so-sub">заявок на доступ: {o.requests}</span>}
                            </td>
                            <td className="so-num" data-label="Учёток с доступом">{o.accounts}</td>
                            <td>
                              {o.counterparty ? (
                                <>
                                  <span className="so-name">{counterpartyLabel(o.counterparty)}</span>
                                  {o.counterparty.inn && <span className="so-sub">ИНН {o.counterparty.inn}</span>}
                                  {status === 'broken' && (
                                    <span className="so-chips"><span className="so-chip is-bad">
                                      {o.counterparty.deleted ? 'контрагент удалён' : o.counterparty.status === 'blacklist' ? 'контрагент в чёрном списке' : 'связь не действует'}
                                    </span></span>
                                  )}
                                </>
                              ) : o.kind === 'own' ? <span className="so-muted">своя — не связывается</span> : <span className="so-muted">не связана</span>}
                            </td>
                            <td>
                              <div className="so-actions">
                                {o.kind === 'contractor' && o.state === 'active' && !o.counterparty && (
                                  <button type="button" className="btn-primary" disabled={busy} onClick={() => setMatchOrg(o)}>Сопоставить…</button>
                                )}
                                {o.counterparty && (
                                  <button type="button" className="btn-soft so-danger" disabled={busy} onClick={() => unlink(o)}>Отвязать</button>
                                )}
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

      {superAdmin && (data?.exceptions || []).length > 0 && (
        <>
          <h4 className="so-section-title">Исключения: сотрудники с «не своей» организацией</h4>
          <ul className="so-employees">
            {data.exceptions.map((e) => (
              <li key={e.subject}>
                <span className="so-name">{e.fullName || 'без имени'}</span>
                <span className="so-muted">{e.orgId ? orgName.get(e.orgId) || 'организация не в реестре' : 'без организации'} · {e.reason}</span>
                <button type="button" className="btn-soft so-danger" disabled={busyId === e.subject}
                  onClick={() => { if (window.confirm('Снять исключение? Сессии этого сотрудника закроются, войти он не сможет.')) act(e.subject, () => su10Orgs.removeException(e.subject), 'Исключение снято') }}>
                  Снять
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {matchOrg && (
        <Su10OrgMatchDialog org={matchOrg} notify={notify} onClose={() => setMatchOrg(null)}
          onDone={() => { setMatchOrg(null); load() }} />
      )}
    </div>
  )
}
