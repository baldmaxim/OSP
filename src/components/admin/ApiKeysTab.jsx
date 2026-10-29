import { useCallback, useEffect, useRef, useState } from 'react'
import { apiKeys } from '../../api'
import {
  KEY_STATUS, NAME_MAX, NOTE_MAX, accessEditable, callReasonText, curlExample, formatDate, formatDateTime, keyFormError,
  keyPatch, resourceLabel, usageText,
} from '../../utils/apiKeys'
import './ApiKeysTab.css'

// «Администрирование» → «Доступ к API»: ключи для смежных систем (реестр расценок /api/rates/*). Выпуск, права,
// срок, отзыв, журнал вызовов. Сам ключ виден один раз — в окне после выпуска; в списке — только первые знаки.
// Ключи из настроек сервера (RATES_API_KEYS) тоже здесь: их можно переименовать и отозвать, права — строкой на сервере.

const HELP_KEY = 'osp:apiKeysHelpHidden'
const CALLS_PAGE = 100

const Icon = ({ children, size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
const IconEdit = () => <Icon><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></Icon>
const IconBan = () => <Icon><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></Icon>
const IconTrash = () => <Icon><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></Icon>
const IconList = () => <Icon><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></Icon>
const IconInfo = () => <Icon size={18}><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></Icon>
const IconPlus = () => <Icon><path d="M12 5v14M5 12h14" /></Icon>

function readHelpHidden() {
  try { return localStorage.getItem(HELP_KEY) === '1' } catch { return false }
}

function StatusBadge({ keyRow }) {
  const s = KEY_STATUS[keyRow.status] || { label: keyRow.status, tone: 'off' }
  let title = ''
  if (keyRow.status === 'revoked') {
    title = [`Отозван ${formatDateTime(keyRow.revokedAt)}`, keyRow.revokedByName, keyRow.revokeReason].filter(Boolean).join(' · ')
  } else if (keyRow.status === 'removed') {
    title = 'Ключа больше нет в строке RATES_API_KEYS на сервере — он не действует'
  } else if (keyRow.status === 'expired') {
    title = `Последний день действия — ${formatDate(keyRow.expiresOn)}`
  }
  return <span className={`ak-status ak-status-${s.tone}`} title={title || undefined}>{s.label}</span>
}

function ScopeChips({ scopes, resources }) {
  return (
    <div className="ak-chips">
      {scopes.map((code) => <span key={code} className={`ak-chip ak-chip-${code}`}>{resourceLabel(resources, code)}</span>)}
    </div>
  )
}

// Выпуск и правка ключа — одно окно. keyRow — правка, без него — выпуск.
function KeyDrawer({ keyRow = null, resources, today, onClose, onSaved }) {
  const editing = Boolean(keyRow)
  const editableAccess = !editing || accessEditable(keyRow)
  const [form, setForm] = useState(() => ({
    name: keyRow?.name || '',
    scopes: keyRow ? [...keyRow.scopes] : [],
    expiresOn: keyRow?.expiresOn || '',
    note: keyRow?.note || '',
  }))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  const toggleScope = (code) => set({ scopes: form.scopes.includes(code) ? form.scopes.filter((c) => c !== code) : [...form.scopes, code] })

  const submit = async (e) => {
    e.preventDefault()
    const problem = keyFormError(form, today, { scopesRequired: editableAccess })
    if (problem) { setError(problem); return }
    setError('')
    setSaving(true)
    try {
      if (editing) {
        const patch = keyPatch(keyRow, form, { accessEditable: editableAccess })
        const saved = Object.keys(patch).length ? await apiKeys.update(keyRow.id, patch) : keyRow
        onSaved(saved)
      } else {
        onSaved(await apiKeys.issue({
          name: form.name.trim(), scopes: form.scopes, expiresOn: form.expiresOn || null, note: form.note.trim() || null,
        }))
      }
    } catch (err) {
      setError(err?.message || 'Не удалось сохранить')
      setSaving(false)
    }
  }

  return (
    <div className="adm-drawer-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose() }}>
      <aside className="adm-drawer ak-drawer" role="dialog" aria-modal="true" aria-label={editing ? 'Изменить ключ' : 'Выпустить ключ доступа'}>
        <header className="adm-drawer-header">
          <div>
            <h3>{editing ? 'Ключ доступа' : 'Выпустить ключ доступа'}</h3>
            <p className="adm-drawer-sub">{editing ? <code>{keyRow.prefix}…</code> : 'Ключ покажется один раз — сразу после выпуска'}</p>
          </div>
          <button type="button" className="adm-drawer-close" onClick={onClose} aria-label="Закрыть" disabled={saving}>×</button>
        </header>
        <form className="adm-drawer-body" onSubmit={submit} noValidate>
          {error && <div className="adm-drawer-error" role="alert">{error}</div>}
          <label className="adm-drawer-field">
            <span>Название <b className="ak-req">*</b></span>
            <input type="text" value={form.name} maxLength={NAME_MAX} autoFocus={!editing}
              onChange={(e) => set({ name: e.target.value })} placeholder="Например: Тендерный отдел — расчёты для заказчиков" />
          </label>

          <fieldset className="ak-scopes" disabled={!editableAccess}>
            <legend>Права <b className="ak-req">*</b></legend>
            {resources.map((r) => (
              <label key={r.code} className={`ak-scope ${form.scopes.includes(r.code) ? 'is-on' : ''}`}>
                <input type="checkbox" checked={form.scopes.includes(r.code)} onChange={() => toggleScope(r.code)} />
                <span className="ak-scope-text">
                  <span className="ak-scope-title">{r.label}</span>
                  <span className="ak-scope-hint">{r.hint} · <code>{r.path}</code></span>
                </span>
              </label>
            ))}
            <p className="adm-drawer-note">
              Только чтение: записать или изменить что-либо через API нельзя. Не отмеченный раздел ключ получить не
              сможет (ответ 403).
            </p>
          </fieldset>

          <label className="adm-drawer-field">
            <span>Действует до</span>
            <input type="date" value={form.expiresOn} min={today || undefined} disabled={!editableAccess}
              onChange={(e) => set({ expiresOn: e.target.value })} />
            <small className="ak-field-hint">Включительно, по московскому времени. Пусто — бессрочно.</small>
          </label>

          {editing && !editableAccess && (
            <p className="ak-locked">
              {keyRow.source === 'env'
                ? 'Права и срок этого ключа задаёт строка RATES_API_KEYS в настройках сервера. Чтобы управлять ими здесь — выпустите новый ключ, а этот отзовите.'
                : 'Ключ отозван: права и срок больше не меняются. Можно поправить название и примечание.'}
            </p>
          )}

          <label className="adm-drawer-field">
            <span>Примечание</span>
            <textarea className="ak-textarea" rows={3} value={form.note} maxLength={NOTE_MAX}
              onChange={(e) => set({ note: e.target.value })} placeholder="Кому выдан, контакт, для какой программы" />
          </label>

          <footer className="adm-drawer-footer">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Отмена</button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Сохранение…' : editing ? 'Сохранить' : 'Выпустить ключ'}
            </button>
          </footer>
        </form>
      </aside>
    </div>
  )
}

// Ключ после выпуска: один раз, закрыть — только кнопкой.
function SecretDialog({ issued, onClose }) {
  const [copied, setCopied] = useState('')
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const copy = async (what, text) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
    } catch {
      setCopied('')
    }
  }
  const resource = issued.key.scopes[0] || 'health'
  return (
    <div className="ak-modal-overlay">
      <div className="ak-modal" role="dialog" aria-modal="true" aria-label="Ключ выпущен">
        <h3>Ключ выпущен: {issued.key.name}</h3>
        <p className="ak-warn">
          Ключ показывается один раз — после закрытия окна его не увидеть ни здесь, ни в базе. Потеряли — отзовите и
          выпустите новый.
        </p>
        <div className="ak-secret" data-testid="api-key-secret">{issued.secret}</div>
        <div className="ak-modal-actions-left">
          <button type="button" className="btn-secondary" onClick={() => copy('key', issued.secret)}>
            {copied === 'key' ? 'Ключ скопирован' : 'Скопировать ключ'}
          </button>
          <button type="button" className="btn-secondary" onClick={() => copy('curl', curlExample(origin, resource, issued.secret))}>
            {copied === 'curl' ? 'Пример скопирован' : 'Скопировать пример запроса'}
          </button>
        </div>
        <p className="adm-drawer-note">
          Передайте ключ получателю лично или защищённым каналом — не в общем чате и не открытым письмом. Он передаёт его
          в заголовке <code>X-API-Key</code>; проверка — <code>{origin}/api/rates/health</code>.
        </p>
        <div className="ak-modal-actions">
          <button type="button" className="btn-primary" onClick={onClose}>Я сохранил ключ</button>
        </div>
      </div>
    </div>
  )
}

function ConfirmDialog({ action, keyRow, onClose, onDone }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const revoke = action === 'revoke'
  const live = keyRow.status === 'active'
  const run = async () => {
    setBusy(true)
    setError('')
    try {
      if (revoke) onDone(await apiKeys.revoke(keyRow.id, reason.trim()))
      else { await apiKeys.remove(keyRow.id); onDone(null) }
    } catch (err) {
      setError(err?.message || 'Не удалось выполнить')
      setBusy(false)
    }
  }
  return (
    <div className="ak-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="ak-modal ak-modal-narrow" role="dialog" aria-modal="true" aria-label={revoke ? 'Отозвать ключ' : 'Удалить ключ'}>
        <h3>{revoke ? 'Отозвать ключ' : 'Удалить ключ'} «{keyRow.name}»?</h3>
        {error && <div className="adm-drawer-error" role="alert">{error}</div>}
        <p className="adm-drawer-note">
          {revoke
            ? 'Ключ перестанет работать сразу, вернуть его нельзя — только выпустить новый. Ключ и журнал его вызовов останутся в списке.'
            : `Ключ исчезнет из списка${live ? ' и сразу перестанет работать' : ''}. Журнал его вызовов сохранится.`}
        </p>
        {revoke && (
          <label className="adm-drawer-field">
            <span>Причина</span>
            <input type="text" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Необязательно: например, ключ попал в общий чат" />
          </label>
        )}
        <div className="ak-modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Отмена</button>
          <button type="button" className="btn-primary ak-btn-danger" onClick={run} disabled={busy}>
            {busy ? 'Выполняется…' : revoke ? 'Отозвать' : 'Удалить'}
          </button>
        </div>
      </div>
    </div>
  )
}

function CallsView({ keys, resources, keyFilter, setKeyFilter }) {
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [rows, setRows] = useState([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const requestRef = useRef(0)
  const rowsRef = useRef([])

  const load = useCallback(async ({ more = false } = {}) => {
    const n = ++requestRef.current
    setLoading(true)
    setError('')
    try {
      const before = more && rowsRef.current.length ? rowsRef.current[rowsRef.current.length - 1].id : null
      const page = await apiKeys.calls({ keyId: keyFilter || null, errorsOnly, before, limit: CALLS_PAGE })
      if (n !== requestRef.current) return
      const next = more ? [...rowsRef.current, ...page.calls] : page.calls
      rowsRef.current = next
      setRows(next)
      setHasMore(page.hasMore)
    } catch (err) {
      if (n === requestRef.current) setError(err?.message || 'Не удалось загрузить журнал')
    } finally {
      if (n === requestRef.current) setLoading(false)
    }
  }, [keyFilter, errorsOnly])
  // Новый отбор — журнал заново.
  useEffect(() => { load() }, [load])

  return (
    <div className="ak-calls">
      <div className="ak-toolbar">
        <label className="ak-filter">
          <span>Ключ</span>
          <select value={keyFilter} onChange={(e) => setKeyFilter(e.target.value)} aria-label="Ключ">
            <option value="">Все ключи</option>
            {keys.map((k) => <option key={k.id} value={k.id}>{k.name} ({k.prefix}…)</option>)}
          </select>
        </label>
        <label className="ak-check">
          <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />
          Только отказы и ошибки
        </label>
        <button type="button" className="btn-soft" onClick={() => load()} disabled={loading}>Обновить</button>
        <span className="ak-toolbar-hint">Журнал хранится 90 дней</span>
      </div>
      {error && <div className="adm-drawer-error" role="alert">{error}</div>}
      <div className="ak-table-wrap">
        <table className="ak-table ak-calls-table">
          <thead>
            <tr>
              <th>Время</th>
              <th>Ключ</th>
              <th>Ресурс</th>
              <th>Ответ</th>
              <th className="ak-num">Строк</th>
              <th className="ak-num">Время ответа</th>
              <th>Адрес</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr><td colSpan={7} className="ak-empty">{keyFilter || errorsOnly ? 'Вызовов по отбору нет' : 'Вызовов пока не было'}</td></tr>
            )}
            {rows.map((c) => {
              const reason = callReasonText(c)
              return (
                <tr key={c.id}>
                  <td className="ak-nowrap ak-tabular">{formatDateTime(c.at)}</td>
                  <td>
                    <div className="ak-name">{c.keyName}{c.keyDeleted && <span className="ak-muted"> (удалён)</span>}</div>
                    <code className="ak-prefix">{c.keyPrefix}…</code>
                  </td>
                  <td>{c.resource === 'health' ? 'проверка ключа' : c.resource === 'other' ? 'другой адрес' : resourceLabel(resources, c.resource)}</td>
                  <td>
                    <span className={`ak-code ${c.status < 400 ? 'ak-code-ok' : c.status < 500 ? 'ak-code-warn' : 'ak-code-err'}`}>{c.status}</span>
                    {reason && <span className="ak-reason">{reason}</span>}
                  </td>
                  <td className="ak-num ak-tabular">{c.rows ?? '—'}</td>
                  <td className="ak-num ak-tabular">{c.ms === null || c.ms === undefined ? '—' : `${c.ms} мс`}</td>
                  <td className="ak-tabular ak-muted">{c.ip || '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {loading && <div className="admin-loading">Загрузка…</div>}
      {hasMore && !loading && (
        <div className="ak-more"><button type="button" className="btn-soft" onClick={() => load({ more: true })}>Показать ещё</button></div>
      )}
    </div>
  )
}

export default function ApiKeysTab({ notify = () => {} }) {
  const [data, setData] = useState(null) // { resources, keys, today }
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null) // Error из apiKeysClient
  const [view, setView] = useState('keys')
  const [drawer, setDrawer] = useState(null) // { mode: 'issue' } | { mode: 'edit', key }
  const [issued, setIssued] = useState(null) // { key, secret } — до закрытия окна
  const [confirm, setConfirm] = useState(null) // { action: 'revoke' | 'delete', key }
  const [keyFilter, setKeyFilter] = useState('')
  const [helpHidden, setHelpHidden] = useState(readHelpHidden)

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true)
    try {
      setData(await apiKeys.list())
      setLoadError(null)
    } catch (err) {
      setLoadError(err)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { load() }, [load])

  const resources = data?.resources || []
  const keys = data?.keys || []
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const activeCount = keys.filter((k) => k.status === 'active').length

  const hideHelp = () => {
    setHelpHidden(true)
    try { localStorage.setItem(HELP_KEY, '1') } catch { /* приватный режим */ }
  }
  const replaceKey = (key) => setData((d) => (d ? { ...d, keys: d.keys.map((k) => (k.id === key.id ? key : k)) } : d))

  if (loading && !data) return <div className="admin-loading">Загрузка ключей…</div>
  if (loadError && !data) {
    return (
      <div className="ak-unavailable" role="status">
        <p className="ak-unavailable-title">
          {loadError.unavailable ? 'Раздел работает на портале tender.su10.ru' : 'Не удалось загрузить ключи'}
        </p>
        <p className="ak-unavailable-text">
          {loadError.unavailable
            ? 'Ключи API выпускает и проверяет сервер нового портала. Откройте «Администрирование» на tender.su10.ru.'
            : loadError.message}
        </p>
        {!loadError.unavailable && <button type="button" className="btn-soft" onClick={() => load()}>Повторить</button>}
      </div>
    )
  }

  return (
    <div className="ak-pane">
      <div className="ak-head">
        <div>
          <h3 className="ak-title">Ключи доступа</h3>
          <p className="ak-subtitle">
            Машинный доступ смежных систем к реестру расценок — только чтение. Действующих: {activeCount} из {keys.length}.
          </p>
        </div>
        <button type="button" className="btn-primary ak-issue" onClick={() => setDrawer({ mode: 'issue' })}>
          <IconPlus /> Выпустить ключ
        </button>
      </div>

      {!helpHidden && (
        <div className="ak-help" role="note">
          <span className="ak-help-icon"><IconInfo /></span>
          <div className="ak-help-body">
            <p className="ak-help-title">Как пользоваться ключом</p>
            <p>
              Ключ передаётся в заголовке <code>X-API-Key</code> (если программа не умеет заголовки — параметром
              {' '}<code>?key=</code>). Адреса: {resources.map((r, i) => (
                <span key={r.code}>{i ? ', ' : ''}<code>{origin}{r.path}</code></span>
              ))}; проверка ключа — <code>{origin}/api/rates/health</code>. Не чаще 60 запросов в минуту на ключ, до 1000
              строк на страницу. Ключ показывается один раз при выпуске — восстановить его нельзя, только выпустить новый.
            </p>
          </div>
          <button type="button" className="adm-drawer-close ak-help-close" onClick={hideHelp} aria-label="Скрыть подсказку">×</button>
        </div>
      )}

      <div className="ak-views" role="tablist" aria-label="Ключи и журнал">
        <button type="button" role="tab" aria-selected={view === 'keys'} className={`ak-view ${view === 'keys' ? 'active' : ''}`} onClick={() => setView('keys')}>
          Ключи <span className="ak-count">{keys.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={view === 'calls'} className={`ak-view ${view === 'calls' ? 'active' : ''}`} onClick={() => setView('calls')}>
          Журнал вызовов
        </button>
      </div>

      {view === 'keys' && (
        <div className="ak-table-wrap">
          <table className="ak-table ak-keys-table">
            <thead>
              <tr>
                <th>Название</th>
                <th>Права</th>
                <th>Срок</th>
                <th>Статус</th>
                <th>Использование</th>
                <th>Выпущен</th>
                <th className="ak-actions-col"><span className="ak-sr">Действия</span></th>
              </tr>
            </thead>
            <tbody>
              {keys.length === 0 && (
                <tr><td colSpan={7} className="ak-empty">Ключей пока нет. Выпустите первый — кнопка «Выпустить ключ».</td></tr>
              )}
              {keys.map((k) => (
                <tr key={k.id} className={k.status === 'active' ? '' : 'ak-row-off'}>
                  <td className="ak-name-cell">
                    <div className="ak-name">{k.name}</div>
                    <code className="ak-prefix" title="Первые знаки ключа">{k.prefix}…</code>
                    {k.source === 'env' && <span className="ak-tag" title="Ключ задан строкой RATES_API_KEYS на сервере">из настроек сервера</span>}
                    {k.note && <div className="ak-note">{k.note}</div>}
                  </td>
                  <td><ScopeChips scopes={k.scopes} resources={resources} /></td>
                  <td className="ak-nowrap ak-tabular">{k.expiresOn ? `до ${formatDate(k.expiresOn)}` : 'бессрочно'}</td>
                  <td><StatusBadge keyRow={k} /></td>
                  <td className="ak-usage">
                    <div className="ak-tabular">{usageText(k)}</div>
                    {k.errorsDay > 0 && <div className="ak-usage-err ak-tabular">отказов: {k.errorsDay}</div>}
                    {k.lastUsedAt && <div className="ak-muted ak-tabular" title="Последний вызов">{formatDateTime(k.lastUsedAt)}</div>}
                  </td>
                  <td className="ak-issued">
                    <div className="ak-tabular">{formatDateTime(k.createdAt)}</div>
                    <div className="ak-muted">{k.createdByName || '—'}</div>
                  </td>
                  <td className="ak-actions">
                    <button type="button" className="adm-iconbtn" aria-label={`Журнал вызовов: ${k.name}`} title="Журнал вызовов"
                      onClick={() => { setKeyFilter(k.id); setView('calls') }}><IconList /></button>
                    <button type="button" className="adm-iconbtn" aria-label={`Изменить: ${k.name}`} title="Изменить"
                      onClick={() => setDrawer({ mode: 'edit', key: k })}><IconEdit /></button>
                    {k.status !== 'revoked' && (
                      <button type="button" className="adm-iconbtn adm-iconbtn-danger" aria-label={`Отозвать: ${k.name}`} title="Отозвать"
                        onClick={() => setConfirm({ action: 'revoke', key: k })}><IconBan /></button>
                    )}
                    <button type="button" className="adm-iconbtn adm-iconbtn-danger" aria-label={`Удалить: ${k.name}`} title="Удалить из списка"
                      onClick={() => setConfirm({ action: 'delete', key: k })}><IconTrash /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === 'calls' && <CallsView keys={keys} resources={resources} keyFilter={keyFilter} setKeyFilter={setKeyFilter} />}

      {drawer && (
        <KeyDrawer
          keyRow={drawer.mode === 'edit' ? drawer.key : null}
          resources={resources}
          today={data?.today}
          onClose={() => setDrawer(null)}
          onSaved={(result) => {
            setDrawer(null)
            if (drawer.mode === 'edit') {
              replaceKey(result)
              notify('ok', 'Ключ сохранён')
            } else {
              setData((d) => ({ ...d, keys: [result.key, ...d.keys] }))
              setIssued(result)
            }
          }}
        />
      )}
      {issued && <SecretDialog issued={issued} onClose={() => { setIssued(null); load({ silent: true }) }} />}
      {confirm && (
        <ConfirmDialog
          action={confirm.action}
          keyRow={confirm.key}
          onClose={() => setConfirm(null)}
          onDone={(key) => {
            setConfirm(null)
            if (confirm.action === 'revoke') {
              replaceKey(key)
              notify('ok', 'Ключ отозван')
            } else {
              setData((d) => ({ ...d, keys: d.keys.filter((k) => k.id !== confirm.key.id) }))
              if (keyFilter === confirm.key.id) setKeyFilter('')
              notify('ok', 'Ключ удалён из списка')
            }
            load({ silent: true })
          }}
        />
      )}
    </div>
  )
}
