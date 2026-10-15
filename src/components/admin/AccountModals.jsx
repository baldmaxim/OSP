import { useEffect, useState } from 'react'
import { db } from '../../api'
import { useRole } from '../../contexts/RoleContext'

// Свой вход (tender.su10.ru): писем портал не отправляет, поэтому учётки заводит администратор — почта, ФИО,
// роль (для подрядчика — организация). Сервер создаёт учётку уже подтверждённой и одобренной и выдаёт
// временный пароль: он показывается один раз, при первом входе человек меняет его на свой.

export function AddUserDrawer({ roleOptions, onClose, onCreated }) {
  const { adminCreateUser } = useRole()
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState(roleOptions[0]?.key || 'engineer')
  const [query, setQuery] = useState('')
  const [found, setFound] = useState([])
  const [counterparty, setCounterparty] = useState(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const contractor = role === 'contractor'

  // Организация — поиском по названию: реестр контрагентов большой, весь его не грузим.
  useEffect(() => {
    if (!contractor || query.trim().length < 2) { setFound([]); return undefined }
    let cancelled = false
    const t = setTimeout(async () => {
      const { data } = await db.from('counterparties').select('id, name').ilike('name', `%${query.trim()}%`).order('name').limit(20)
      if (!cancelled) setFound(data || [])
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [contractor, query])

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (contractor && !counterparty) { setError('Для подрядчика выберите организацию'); return }
    setSaving(true)
    try {
      const result = await adminCreateUser({ email: email.trim(), fullName: fullName.trim(), role, counterpartyId: contractor ? counterparty.id : null })
      onCreated(result)
    } catch (err) {
      setError(err?.message || 'Не удалось создать учётную запись')
      setSaving(false)
    }
  }

  return (
    <div className="adm-drawer-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose() }}>
      <aside className="adm-drawer" role="dialog" aria-modal="true" aria-label="Новый пользователь">
        <header className="adm-drawer-header">
          <div>
            <h3>Новый пользователь</h3>
            <p className="adm-drawer-sub">Учётная запись с временным паролем</p>
          </div>
          <button type="button" className="adm-drawer-close" onClick={onClose} aria-label="Закрыть" disabled={saving}>×</button>
        </header>
        <form className="adm-drawer-body" onSubmit={submit}>
          {error && <div className="adm-drawer-error">{error}</div>}
          <label className="adm-drawer-field">
            <span>Email (логин)</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@su10.ru" required autoFocus />
          </label>
          <label className="adm-drawer-field">
            <span>ФИО</span>
            <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Фамилия Имя Отчество" required />
          </label>
          <label className="adm-drawer-field">
            <span>Роль</span>
            <select value={role} onChange={(e) => { setRole(e.target.value); setCounterparty(null) }}>
              {roleOptions.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
              <option value="contractor">Подрядчик</option>
            </select>
          </label>
          {contractor && (
            <div className="adm-drawer-field">
              <span>Организация (кабинет подрядчика)</span>
              {counterparty ? (
                <div className="adm-drawer-requested">
                  {counterparty.name}{' '}
                  <button type="button" className="btn-ghost" onClick={() => setCounterparty(null)}>Изменить</button>
                </div>
              ) : (
                <>
                  <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Начните вводить название…" />
                  {found.length > 0 && (
                    <ul className="adm-account-found">
                      {found.map((c) => (
                        <li key={c.id}><button type="button" onClick={() => setCounterparty(c)}>{c.name}</button></li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}
          <p className="adm-drawer-note">
            Подразделения и телефон можно указать потом в карточке пользователя. Временный пароль появится после
            создания — один раз.
          </p>
          <footer className="adm-drawer-footer">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Отмена</button>
            <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Создание…' : 'Создать'}</button>
          </footer>
        </form>
      </aside>
    </div>
  )
}

export function TemporaryPasswordDialog({ email, password, onClose }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="adm-drawer-overlay">
      <aside className="adm-drawer" role="dialog" aria-modal="true" aria-label="Временный пароль">
        <header className="adm-drawer-header">
          <div>
            <h3>Временный пароль</h3>
            <p className="adm-drawer-sub">{email}</p>
          </div>
        </header>
        <div className="adm-drawer-body">
          <div className="adm-temp-password" aria-label="Временный пароль">{password}</div>
          <footer className="adm-drawer-footer">
            <button type="button" className="btn-secondary" onClick={copy}>{copied ? 'Скопировано' : 'Скопировать'}</button>
            <button type="button" className="btn-primary" onClick={onClose}>Готово</button>
          </footer>
          <p className="adm-drawer-note">
            Пароль показывается один раз — после закрытия окна его не увидеть. Передайте его человеку лично или
            по телефону. При первом входе он сменит пароль на свой; прежние сессии этого пользователя закрыты.
          </p>
        </div>
      </aside>
    </div>
  )
}
