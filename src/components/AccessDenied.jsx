import { useNavigate } from 'react-router-dom'

// security fix: пользователь авторизован и роль загружена, но НЕТ права на раздел.
// Страница раздела при этом НЕ монтируется (никаких Supabase-запросов запрещённого раздела).
export default function AccessDenied() {
  const navigate = useNavigate()
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: '1rem', minHeight: '70vh', padding: '2rem', textAlign: 'center',
    }}>
      <div style={{ fontSize: '2.5rem' }} aria-hidden>⛔</div>
      <h1 style={{ fontSize: '1.25rem', margin: 0, color: 'var(--text-primary)' }}>
        Нет прав для просмотра раздела
      </h1>
      <p style={{ maxWidth: 460, color: 'var(--text-secondary)', margin: 0 }}>
        У вас нет прав для просмотра этого раздела. Обратитесь к администратору, если доступ нужен.
      </p>
      <button className="btn-primary" style={{ marginTop: '0.5rem' }} onClick={() => navigate('/general')}>
        Вернуться на главную
      </button>
    </div>
  )
}
