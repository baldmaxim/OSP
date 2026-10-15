import { useState } from 'react'
import { useRole } from '../contexts/RoleContext'

// Смена пароля своего входа (tender.su10.ru). forced — временный пароль от администратора: без смены дальше
// не пустит. Правила нового пароля проверяет сервер (не короче 15 знаков, не из списка распространённых, не
// почта и не ФИО); здесь — только длина и совпадение, чтобы не гонять запрос впустую.
const MIN_LENGTH = 15
const length = (s) => [...String(s).normalize('NFC')].length

export default function ChangePasswordForm({ forced = false, onDone, className = 'login-form', buttonClassName = 'login-button',
  fieldClassName = 'form-field', errorClassName = 'login-error' }) {
  const { changePassword } = useRole()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (length(next) < MIN_LENGTH) { setError(`Новый пароль — не меньше ${MIN_LENGTH} знаков. Удобно взять фразу из нескольких слов.`); return }
    if (next !== repeat) { setError('Новый пароль и повтор не совпадают'); return }
    setSaving(true)
    try {
      await changePassword(current, next)
      onDone?.()
    } catch (err) {
      setError(err?.message || 'Не удалось сменить пароль')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className={className}>
      {forced && (
        <p className="login-note">
          Вы вошли с временным паролем. Придумайте свой — не меньше {MIN_LENGTH} знаков; удобно взять фразу из
          нескольких слов, её легко запомнить и трудно подобрать.
        </p>
      )}
      {error && <div className={errorClassName}>{error}</div>}
      <div className={fieldClassName}>
        <label>{forced ? 'Временный пароль' : 'Текущий пароль'}</label>
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required autoFocus={forced} />
      </div>
      <div className={fieldClassName}>
        <label>Новый пароль</label>
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password"
          placeholder={`Не меньше ${MIN_LENGTH} знаков`} required />
      </div>
      <div className={fieldClassName}>
        <label>Повторите новый пароль</label>
        <input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
      </div>
      <button type="submit" className={buttonClassName} disabled={saving}>
        {saving ? 'Сохранение…' : 'Сменить пароль'}
      </button>
    </form>
  )
}
