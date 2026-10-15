import { useState } from 'react'
import { useRole } from '../contexts/RoleContext'
import './ReloginModal.css'

// Свой вход: сессия закончилась (срок, выход на другом устройстве, смена пароля) — окно входа поверх страницы.
// Страница и набранное в формах остаются; после входа тем же пользователем работа продолжается. Вошли в
// другой вкладке — окно закрывается само (RoleContext, BroadcastChannel).
export default function ReloginModal() {
  const { ownAuth, sessionExpired, user, relogin, logout } = useRole()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  if (!ownAuth || !sessionExpired || !user) return null

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await relogin(password)
      setPassword('')
    } catch (err) {
      setError(/Invalid login credentials/i.test(err?.message || '') ? 'Неверный пароль' : (err?.message || 'Не удалось войти'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relogin-backdrop" role="dialog" aria-modal="true" aria-labelledby="relogin-title">
      <form className="relogin-card" onSubmit={submit}>
        <h2 id="relogin-title">Сессия закончилась</h2>
        <p>Введите пароль, чтобы продолжить: страница и несохранённые данные на месте.</p>
        <div className="relogin-email">{user.email}</div>
        {error && <div className="relogin-error">{error}</div>}
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Пароль"
          autoComplete="current-password" required autoFocus />
        <div className="relogin-actions">
          <button type="submit" className="relogin-primary" disabled={busy}>{busy ? 'Вход…' : 'Войти'}</button>
          <button type="button" className="relogin-secondary" onClick={() => logout().finally(() => window.location.assign('/login'))}>
            Выйти
          </button>
        </div>
      </form>
    </div>
  )
}
