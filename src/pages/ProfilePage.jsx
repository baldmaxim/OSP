import { useState, useEffect } from 'react'
import { useRole, ROLE_LABELS } from '../contexts/RoleContext'
import { supabase } from '../supabase'
import './ProfilePage.css'

function ProfilePage() {
  const { user, role, userProfile, updateProfile } = useRole()
  const [fullName, setFullName] = useState(userProfile.full_name || '')
  const [workPhone, setWorkPhone] = useState(userProfile.work_phone || '')
  const [workEmail, setWorkEmail] = useState(userProfile.work_email || '')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [userNumber, setUserNumber] = useState(null)

  // Синхронизируем при обновлении профиля из контекста
  useEffect(() => {
    setFullName(userProfile.full_name || '')
    setWorkPhone(userProfile.work_phone || '')
    setWorkEmail(userProfile.work_email || '')
  }, [userProfile])

  // Вычисляем УН (порядковый номер по дате создания)
  useEffect(() => {
    const fetchUserNumber = async () => {
      if (!user) return
      try {
        const { data, error } = await supabase
          .from('user_roles')
          .select('user_id, created_at')
          .order('created_at', { ascending: true })

        if (error) throw error
        const idx = (data || []).findIndex(u => u.user_id === user.id)
        setUserNumber(idx >= 0 ? idx + 1 : null)
      } catch (err) {
        console.error('Ошибка получения УН:', err.message)
      }
    }
    fetchUserNumber()
  }, [user])

  const handleSave = async (e) => {
    e.preventDefault()
    setSaving(true)
    setMessage('')
    try {
      await updateProfile({
        full_name: fullName.trim(),
        work_phone: workPhone.trim(),
        work_email: workEmail.trim()
      })
      setMessage('Сохранено')
      setTimeout(() => setMessage(''), 2000)
    } catch (err) {
      setMessage('Ошибка: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const createdDate = userProfile.created_at
    ? new Date(userProfile.created_at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : '—'

  return (
    <div className="profile-page">
      <div className="profile-card">
        <h2>Профиль</h2>

        <div className="profile-info">
          <div className="profile-row">
            <span className="profile-label">УН</span>
            <span className="profile-value profile-un">{userNumber ?? '—'}</span>
          </div>
          <div className="profile-row">
            <span className="profile-label">Email</span>
            <span className="profile-value">{user?.email || '—'}</span>
          </div>
          <div className="profile-row">
            <span className="profile-label">Роль</span>
            <span className="profile-value">{ROLE_LABELS[role] || role}</span>
          </div>
          <div className="profile-row">
            <span className="profile-label">Создан</span>
            <span className="profile-value">{createdDate}</span>
          </div>
        </div>

        <form onSubmit={handleSave} className="profile-form">
          <div className="profile-field">
            <label>ФИО</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Иванов Иван Иванович"
            />
          </div>

          <div className="profile-field">
            <label>Рабочий телефон</label>
            <input
              type="tel"
              value={workPhone}
              onChange={(e) => setWorkPhone(e.target.value)}
              placeholder="+7 (999) 123-45-67"
            />
          </div>

          <div className="profile-field">
            <label>Рабочая почта</label>
            <input
              type="email"
              value={workEmail}
              onChange={(e) => setWorkEmail(e.target.value)}
              placeholder="ivanov@company.ru"
            />
          </div>

          <div className="profile-actions">
            <button type="submit" className="btn-save" disabled={saving}>
              {saving ? 'Сохранение...' : 'Сохранить'}
            </button>
            {message && <span className={`profile-message ${message.startsWith('Ошибка') ? 'error' : 'success'}`}>{message}</span>}
          </div>
        </form>
      </div>
    </div>
  )
}

export default ProfilePage
