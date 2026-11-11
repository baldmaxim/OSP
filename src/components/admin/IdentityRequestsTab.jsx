import { useCallback, useEffect, useMemo, useState } from 'react'
import { identityAdmin } from '../../api'
import { ORG_RESULT_TEXT, counterpartyLabel } from '../../utils/su10Orgs'
import Su10OrgMatchDialog from './Su10OrgMatchDialog'
import './IdentityRequestsTab.css'
import './Su10OrgsTab.css'

// «Администрирование» → «Заявки на доступ» (вход через СУ-10). Заявка появляется, когда человеку выдали доступ к порталу на
// auth.su10.ru/manage (сверка группы — раз в 5 минут или по «Проверить СУ-10») или когда он вошёл, а связи с учёткой портала
// нет. Администратор ОСП решает: привязать к существующему пользователю (подсказки — похожие по почте и ФИО), создать нового
// (роль, объекты, организация) или отклонить. Пароли и блокировку учётки СУ-10 ведёт auth.su10.ru/manage, не портал.
// Роль «Администратор» и связи администраторов — только у суперадминистратора (так же проверяет сервер и база).
// Организация СУ-10 человека (server/osp-api/src/lib/auth/orgs.js): подрядчику контрагент — только из связи организации
// («Организации СУ-10»), выбрать вручную нельзя; сотрудник войдёт, только если организация своя (или есть исключение).

const MATCH_LABEL = { email: 'почта', name: 'ФИО', email_local: 'почта до «@»' }
const formatDateTime = (ts) => {
  if (!ts) return null
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Организация СУ-10 человека: что о ней известно и связана ли она с контрагентом.
function OrgLine({ org, onMatch }) {
  if (!org) return null
  const canMatch = org.result === 'unmapped' && org.org?.kind === 'contractor' && org.org?.state === 'active' && !org.counterparty
  const tone = org.result === 'counterparty' || org.result === 'own' ? 'is-ok' : org.result === 'unknown_subject' ? '' : 'is-warn'
  return (
    <div className="so-org-line">
      <span className="ir-label">Организация СУ-10:</span>
      {org.org && <span className="so-name">{org.org.name}</span>}
      <span className={`so-chip ${tone}`}>{ORG_RESULT_TEXT[org.result] || org.result}</span>
      {org.counterparty && <span>→ {counterpartyLabel(org.counterparty)}</span>}
      {canMatch && onMatch && <button type="button" className="btn-soft" onClick={onMatch}>Сопоставить…</button>}
    </div>
  )
}

function CreateForm({ request, roleOptions, objectOptions, counterpartyOptions, onNeedCounterparties, onSubmit, onCancel, busy, orgsEnabled, onMatch }) {
  const [role, setRole] = useState('')
  const [objectIds, setObjectIds] = useState([])
  const [counterpartyId, setCounterpartyId] = useState('')
  const [fullName, setFullName] = useState(request.fullName || '')
  useEffect(() => { if (role === 'contractor' && !orgsEnabled) onNeedCounterparties?.() }, [role, onNeedCounterparties, orgsEnabled])
  const org = request.org || null
  // С организациями СУ-10 подрядчику контрагент ставит сервер из связи; без связи создать подрядчика нельзя.
  const contractorBlocked = orgsEnabled && role === 'contractor' && org?.result !== 'counterparty' && org?.result !== 'unknown_subject'
  const submit = (e) => {
    e.preventDefault()
    onSubmit({ role, objectIds, counterpartyId: role === 'contractor' && !orgsEnabled ? counterpartyId || null : null, fullName: fullName.trim() || null })
  }
  return (
    <form className="ir-form" onSubmit={submit}>
      <label className="ir-field">
        <span>ФИО</span>
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={200} placeholder="Фамилия Имя" />
      </label>
      <label className="ir-field">
        <span>Роль</span>
        <select value={role} onChange={(e) => setRole(e.target.value)} required>
          <option value="">Выберите роль…</option>
          {roleOptions.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          <option value="contractor">Подрядчик</option>
        </select>
      </label>
      {role === 'contractor' && orgsEnabled ? (
        <div className="ir-field">
          <span>Организация</span>
          {org?.result === 'counterparty' ? <span className="so-name">{counterpartyLabel(org.counterparty)} — по связи организации СУ-10</span>
            : org?.result === 'unknown_subject' ? <span className="so-muted">Организация человека в СУ-10 будет определена при создании.</span>
              : (
                <span className="so-warn">
                  {ORG_RESULT_TEXT[org?.result] || 'Организация не определена'} — подрядчика не создать, пока организация не связана с контрагентом.
                  {org?.result === 'unmapped' && onMatch && <> <button type="button" className="btn-soft" onClick={onMatch}>Сопоставить…</button></>}
                </span>
              )}
        </div>
      ) : role === 'contractor' ? (
        <label className="ir-field">
          <span>Организация</span>
          <select value={counterpartyId} onChange={(e) => setCounterpartyId(e.target.value)} required>
            <option value="">Выберите организацию…</option>
            {counterpartyOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      ) : (
        <label className="ir-field">
          <span>Объекты (пусто — все)</span>
          <select multiple value={objectIds} onChange={(e) => setObjectIds([...e.target.selectedOptions].map((o) => o.value))} size={Math.min(6, Math.max(3, objectOptions.length))}>
            {objectOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
      )}
      {orgsEnabled && role && role !== 'contractor' && org && !['own', 'unknown_subject'].includes(org.result) && (
        <p className="so-warn">Учётка СУ-10 не в своей организации ({ORG_RESULT_TEXT[org.result] || org.result}): сотрудник не войдёт без исключения
          суперадминистратора — «Организации СУ-10».</p>
      )}
      <div className="ir-form-actions">
        <button type="submit" className="btn-primary" disabled={busy || !role || contractorBlocked}>{busy ? 'Создаём…' : 'Создать пользователя'}</button>
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>Отмена</button>
      </div>
    </form>
  )
}

function LinkPicker({ users, onPick, onCancel, busy, isSuperAdmin }) {
  const [q, setQ] = useState('')
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (s.length < 2) return []
    return users.filter((u) => `${u.full_name || ''} ${u.email || ''}`.toLowerCase().includes(s)).slice(0, 20)
  }, [q, users])
  return (
    <div className="ir-form">
      <label className="ir-field">
        <span>Привязать к пользователю портала</span>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="ФИО или почта, от 2 букв" />
      </label>
      {shown.length > 0 && (
        <ul className="ir-pick">
          {shown.map((u) => {
            const locked = u.role === 'admin' && !isSuperAdmin
            return (
              <li key={u.user_id}>
                <span className="ir-pick-name">{u.full_name || 'Без имени'}</span>
                <span className="ir-muted">{u.email}</span>
                <button type="button" className="btn-soft" disabled={busy || locked} title={locked ? 'Связь администратора — только суперадминистратор' : undefined}
                  onClick={() => onPick(u.user_id)}>Привязать</button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="ir-form-actions">
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>Отмена</button>
      </div>
    </div>
  )
}

export default function IdentityRequestsTab({ roleOptions, objectOptions, counterpartyOptions, onNeedCounterparties, users, isSuperAdmin, notify, onChanged, onPendingCount }) {
  const [status, setStatus] = useState('pending')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [syncNote, setSyncNote] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [open, setOpen] = useState(null) // { id, kind: 'create' | 'link' }
  const [busyId, setBusyId] = useState(null)
  const [matchOrg, setMatchOrg] = useState(null) // организация СУ-10 для «Сопоставить…»

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const d = await identityAdmin.list(status)
      setData(d)
      onPendingCount?.(d.pending || 0)
    } catch (err) {
      setError(err.message || 'Не удалось загрузить заявки')
    } finally {
      setLoading(false)
    }
  }, [status, onPendingCount])

  // Сверка с СУ-10: при открытии вкладки (тихо) и по кнопке. Сбой — ненавязчивая строка, страница работает и без СУ-10.
  const sync = useCallback(async ({ quiet = false } = {}) => {
    setSyncing(true)
    try {
      const r = await identityAdmin.sync()
      if (!quiet) setSyncNote(r.held ? 'Сверка отложена предохранителем: большие изменения в группе СУ-10 — сообщите администратору портала.'
        : `Сверено с СУ-10: новых заявок — ${r.created ?? 0}${r.withdrawn ? `, снято — ${r.withdrawn}` : ''}`)
      else setSyncNote('')
    } catch (err) {
      setSyncNote(err.code === 'kc_sync_unavailable' ? 'Сверка с СУ-10 не настроена — заявки появляются только при входе.'
        : 'СУ-10 сейчас не ответил — заявки покажутся при следующей сверке.')
    } finally {
      setSyncing(false)
    }
  }, [])

  useEffect(() => { sync({ quiet: true }).finally(load) }, [sync, load])

  const roleChoices = useMemo(() => roleOptions.filter((r) => isSuperAdmin || r.key !== 'admin'), [roleOptions, isSuperAdmin])

  const act = async (id, fn, okText) => {
    setBusyId(id)
    try {
      await fn()
      notify?.('ok', okText)
      setOpen(null)
      await load()
      onChanged?.()
    } catch (err) {
      if (err.code === 'email_taken') notify?.('err', 'Учётная запись с такой почтой уже есть — привяжите заявку к ней')
      else if (err.code === 'org_unmapped' || err.code === 'org_not_own' || err.code === 'org_lookup_failed') {
        notify?.('err', err.message)
        await load()
      } else notify?.('err', err.message || 'Не удалось выполнить действие')
    } finally {
      setBusyId(null)
    }
  }

  const requests = data?.requests || []
  return (
    <div className="ir-tab">
      <div className="ir-toolbar">
        <div className="ir-switch" role="tablist">
          <button type="button" className={status === 'pending' ? 'is-active' : ''} onClick={() => setStatus('pending')}>Ждут решения</button>
          <button type="button" className={status === 'rejected' ? 'is-active' : ''} onClick={() => setStatus('rejected')}>Отклонённые</button>
        </div>
        <button type="button" className="btn-secondary" onClick={() => sync().then(load)} disabled={syncing}>
          {syncing ? 'Проверяем…' : 'Проверить СУ-10'}
        </button>
      </div>
      {syncNote && <p className="ir-note">{syncNote}</p>}
      <p className="ir-hint">Учётки, пароли и блокировку СУ-10 ведёт auth.su10.ru/manage. Здесь — кто этот человек в портале: роль, объекты, организация.</p>

      {loading ? <p className="ir-muted">Загрузка…</p>
        : error ? <p className="ir-error">{error} <button type="button" className="btn-soft" onClick={load}>Повторить</button></p>
          : requests.length === 0 ? <p className="ir-muted">{status === 'pending' ? 'Новых заявок нет.' : 'Отклонённых заявок нет.'}</p>
            : (
              <ul className="ir-list">
                {requests.map((q) => {
                  const busy = busyId === q.id
                  const first = formatDateTime(q.firstSeenAt)
                  const last = formatDateTime(q.lastSeenAt)
                  return (
                    <li key={q.id} className="ir-card">
                      <div className="ir-head">
                        <div>
                          <div className="ir-name">{q.fullName || 'Без имени'}</div>
                          <div className="ir-muted">{q.email || 'почта не указана'}</div>
                        </div>
                        <div className="ir-meta">
                          <span className="ir-chip">{q.origin === 'kc_sync' ? 'доступ выдан в СУ-10' : 'вход'}</span>
                          <span className="ir-muted">{first ? `входы: ${first}${last && last !== first ? ` — ${last}` : ''}` : 'ещё не входил(а)'}</span>
                        </div>
                      </div>

                      {data?.orgsEnabled && (
                        <OrgLine org={q.org} onMatch={q.org?.org ? () => setMatchOrg({ id: q.org.org.id, name: q.org.org.name, inn: q.org.org.inn }) : null} />
                      )}

                      {q.similar?.length > 0 && (
                        <div className="ir-similar">
                          <div className="ir-label">Похожие пользователи портала</div>
                          <ul>
                            {q.similar.map((u) => {
                              const locked = u.isAdmin && !isSuperAdmin
                              return (
                                <li key={u.userId}>
                                  <span className="ir-pick-name">{u.fullName || 'Без имени'}</span>
                                  <span className="ir-muted">{u.email}</span>
                                  <span className="ir-chip">{u.match.map((m) => MATCH_LABEL[m] || m).join(', ')}</span>
                                  <span className="ir-muted">{u.role || 'без роли'}{u.lastLoginAt ? ` · вход ${formatDateTime(u.lastLoginAt)}` : ''}</span>
                                  {status === 'pending' && (
                                    <button type="button" className="btn-soft" disabled={busy || locked}
                                      title={locked ? 'Связь администратора — только суперадминистратор' : undefined}
                                      onClick={() => act(q.id, () => identityAdmin.link(q.id, u.userId), 'Заявка привязана к пользователю')}>
                                      Привязать
                                    </button>
                                  )}
                                </li>
                              )
                            })}
                          </ul>
                        </div>
                      )}

                      {status === 'pending' ? (
                        open?.id === q.id ? (
                          open.kind === 'create' ? (
                            <CreateForm request={q} roleOptions={roleChoices} objectOptions={objectOptions} counterpartyOptions={counterpartyOptions}
                              onNeedCounterparties={onNeedCounterparties} busy={busy} onCancel={() => setOpen(null)} orgsEnabled={Boolean(data?.orgsEnabled)}
                              onMatch={q.org?.org ? () => setMatchOrg({ id: q.org.org.id, name: q.org.org.name, inn: q.org.org.inn }) : null}
                              onSubmit={(input) => act(q.id, () => identityAdmin.createUser(q.id, input), 'Пользователь создан')} />
                          ) : (
                            <LinkPicker users={users} isSuperAdmin={isSuperAdmin} busy={busy} onCancel={() => setOpen(null)}
                              onPick={(userId) => act(q.id, () => identityAdmin.link(q.id, userId), 'Заявка привязана к пользователю')} />
                          )
                        ) : (
                          <div className="ir-actions">
                            <button type="button" className="btn-primary" onClick={() => setOpen({ id: q.id, kind: 'create' })}>Создать пользователя</button>
                            <button type="button" className="btn-secondary" onClick={() => setOpen({ id: q.id, kind: 'link' })}>Привязать к существующему</button>
                            <button type="button" className="btn-soft ir-danger" disabled={busy}
                              onClick={() => act(q.id, () => identityAdmin.reject(q.id), 'Заявка отклонена')}>Отклонить</button>
                          </div>
                        )
                      ) : (
                        <div className="ir-actions">
                          <button type="button" className="btn-secondary" disabled={busy}
                            onClick={() => act(q.id, () => identityAdmin.reopen(q.id), 'Заявка открыта заново')}>Открыть заново</button>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
      {matchOrg && (
        <Su10OrgMatchDialog org={matchOrg} notify={notify} onClose={() => setMatchOrg(null)}
          onDone={() => { setMatchOrg(null); load() }} />
      )}
    </div>
  )
}
