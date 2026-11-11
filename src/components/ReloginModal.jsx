import { useState } from 'react'
import { useRole } from '../contexts/RoleContext'
import { ssoLoginHref } from '../pages/SsoScreens'
import './ReloginModal.css'

// Свой вход: сессия закончилась (срок, выход на другом устройстве, смена пароля) — окно входа поверх страницы.
// Страница и набранное в формах остаются; после входа тем же пользователем работа продолжается. Вошли в
// другой вкладке — окно закрывается само (RoleContext, BroadcastChannel).
// Вход через СУ-10: «Войти заново» открывает вход СУ-10 в маленьком окне (часто без пароля — вход СУ-10 ещё жив); окно
// сообщает вкладкам и закрывается (/auth/done). Окна заблокированы — обычный переход на вход с возвратом на эту страницу.
export default function ReloginModal() {
  const { ownAuth, ssoAuth, sessionExpired, user, relogin, logout } = useRole()
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

  const ssoAgain = () => {
    const popup = window.open(ssoLoginHref('/auth/done'), 'osp-relogin', 'popup,width=520,height=720')
    if (!popup) window.location.assign(ssoLoginHref(`${window.location.pathname}${window.location.search}`))
  }
  const signOut = () => logout().then(() => window.location.assign('/login'), (err) => alert(err.message))

  if (ssoAuth) {
    return (
      <div className="relogin-backdrop" role="dialog" aria-modal="true" aria-labelledby="relogin-title">
        <div className="relogin-card">
          <h2 id="relogin-title">Вход закончился</h2>
          <p>Войдите заново через СУ-10 — в отдельном окне. Страница и несохранённые данные на месте.</p>
          <div className="relogin-email">{user.email}</div>
          <div className="relogin-actions">
            <button type="button" className="relogin-primary" onClick={ssoAgain} autoFocus>Войти заново</button>
            <button type="button" className="relogin-secondary" onClick={signOut}>Выйти</button>
          </div>
        </div>
      </div>
    )
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
          <button type="button" className="relogin-secondary" onClick={signOut}>
            Выйти
          </button>
        </div>
      </form>
    </div>
  )
}
