import { useRole } from '../contexts/RoleContext'

// security fix: экран ошибки прав доступа (fail-closed). Показывается, когда роль/права
// не удалось загрузить из Supabase — вместо молчаливой выдачи admin или внутренних страниц.
export default function AccessError({ message }) {
  const { logout } = useRole()
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: '1rem', height: '100vh', padding: '2rem', textAlign: 'center',
    }}>
      <div style={{ fontSize: '2.5rem' }} aria-hidden>🔒</div>
      <h1 style={{ fontSize: '1.25rem', margin: 0, color: 'var(--text-primary)' }}>
        Нет доступа
      </h1>
      <p style={{ maxWidth: 460, color: 'var(--text-secondary)', margin: 0 }}>
        {message || 'Не удалось загрузить права доступа. Обновите страницу или обратитесь к администратору.'}
      </p>
      <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
        <button className="btn-primary" onClick={() => window.location.reload()}>
          Повторить
        </button>
        <button className="btn-secondary" onClick={() => { logout().finally(() => window.location.assign('/login')) }}>
          Выйти
        </button>
      </div>
    </div>
  )
}
