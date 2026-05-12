import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRole } from '../contexts/RoleContext'
import { supabase } from '../supabase'
import './LoginPage.css'

function LoginPage() {
  const navigate = useNavigate()
  const { loginWithPassword, loginAsContractor, signUp, isLoggedIn, isEmployee } = useRole()

  const [mode, setMode] = useState('employee') // 'employee' | 'contractor' | 'register'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [successMessage, setSuccessMessage] = useState('')

  // Подрядчик — выбор организации
  const [counterparties, setCounterparties] = useState([])
  const [selectedCounterparty, setSelectedCounterparty] = useState('')
  const [loadingCounterparties, setLoadingCounterparties] = useState(false)

  useEffect(() => {
    if (isLoggedIn) {
      navigate(isEmployee ? '/general/objects' : '/contractor/proposals')
    }
  }, [isLoggedIn, isEmployee, navigate])

  useEffect(() => {
    if (mode === 'contractor') {
      fetchCounterparties()
    }
  }, [mode])

  const fetchCounterparties = async () => {
    setLoadingCounterparties(true)
    try {
      const { data, error } = await supabase
        .from('counterparties')
        .select('id, name')
        .eq('status', 'active')
        .order('name')
      if (error) throw error
      setCounterparties(data || [])
    } catch (err) {
      console.error('Ошибка загрузки контрагентов:', err)
    } finally {
      setLoadingCounterparties(false)
    }
  }

  const handleEmployeeLogin = async (e) => {
    e.preventDefault()
    setError('')
    setSuccessMessage('')
    setLoading(true)
    try {
      await loginWithPassword(email, password)
      navigate('/general/objects')
    } catch (err) {
      if (err.message === 'PENDING_APPROVAL') {
        setSuccessMessage('Ваша заявка отправлена. Ожидайте подтверждения администратором.')
      } else {
        setError(getErrorMessage(err))
      }
    } finally {
      setLoading(false)
    }
  }

  const handleContractorLogin = async (e) => {
    e.preventDefault()
    setError('')
    if (!selectedCounterparty) {
      setError('Выберите организацию')
      return
    }
    setLoading(true)
    try {
      const cp = counterparties.find(c => c.id === selectedCounterparty)
      await loginAsContractor(email, password, cp.id, cp.name)
      navigate('/contractor/proposals')
    } catch (err) {
      if (err.message === 'PENDING_APPROVAL') {
        setSuccessMessage('Ваша заявка отправлена. Ожидайте подтверждения администратором.')
      } else {
        setError(getErrorMessage(err))
      }
    } finally {
      setLoading(false)
    }
  }

  const handleSignUp = async (e) => {
    e.preventDefault()
    setError('')
    setSuccessMessage('')
    if (password.length < 6) {
      setError('Пароль должен быть не менее 6 символов')
      return
    }
    if (password !== passwordConfirm) {
      setError('Пароли не совпадают')
      return
    }
    setLoading(true)
    try {
      await signUp(email, password)
      setSuccessMessage('Регистрация успешна! Теперь вы можете войти.')
      setMode('employee')
      setPassword('')
      setPasswordConfirm('')
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  const getErrorMessage = (err) => {
    const msg = err.message || ''
    if (msg === 'PENDING_APPROVAL') return 'Ваша заявка отправлена. Ожидайте подтверждения администратором.'
    if (msg.includes('Invalid login credentials')) return 'Неверный email или пароль'
    if (msg.includes('Email not confirmed')) return 'Email не подтверждён'
    if (msg.includes('User already registered')) return 'Пользователь уже зарегистрирован'
    if (msg.includes('Password should be at least')) return 'Пароль слишком короткий'
    return msg || 'Произошла ошибка'
  }

  const switchMode = (newMode) => {
    setMode(newMode)
    setError('')
    setSuccessMessage('')
  }

  return (
    <div className="login-page">
      <div className="login-container">
        <div className="login-header">
          <h1>ОСП</h1>
          <p>Отдел сопровождения подрядчиков</p>
        </div>

        {/* Табы выбора режима */}
        <div className="login-tabs">
          <button
            className={`login-tab ${mode === 'employee' ? 'active' : ''}`}
            onClick={() => switchMode('employee')}
          >
            Сотрудник
          </button>
          <button
            className={`login-tab ${mode === 'contractor' ? 'active' : ''}`}
            onClick={() => switchMode('contractor')}
          >
            Подрядчик
          </button>
          <button
            className={`login-tab ${mode === 'register' ? 'active' : ''}`}
            onClick={() => switchMode('register')}
          >
            Регистрация
          </button>
        </div>

        {successMessage && (
          <div className="login-success">{successMessage}</div>
        )}

        {error && (
          <div className="login-error">{error}</div>
        )}

        {/* Форма входа сотрудника */}
        {mode === 'employee' && (
          <form onSubmit={handleEmployeeLogin} className="login-form">
            <div className="form-field">
              <label>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email@example.com"
                required
                autoFocus
              />
            </div>
            <div className="form-field">
              <label>Пароль</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Введите пароль"
                required
              />
            </div>
            <button type="submit" className="login-button" disabled={loading}>
              {loading ? 'Вход...' : 'Войти'}
            </button>
          </form>
        )}

        {/* Форма входа подрядчика */}
        {mode === 'contractor' && (
          <form onSubmit={handleContractorLogin} className="login-form">
            <div className="form-field">
              <label>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email@example.com"
                required
                autoFocus
              />
            </div>
            <div className="form-field">
              <label>Пароль</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Введите пароль"
                required
              />
            </div>
            <div className="form-field">
              <label>Организация</label>
              {loadingCounterparties ? (
                <div className="field-loading">Загрузка...</div>
              ) : (
                <select
                  value={selectedCounterparty}
                  onChange={(e) => setSelectedCounterparty(e.target.value)}
                  required
                >
                  <option value="">-- Выберите организацию --</option>
                  {counterparties.map(cp => (
                    <option key={cp.id} value={cp.id}>{cp.name}</option>
                  ))}
                </select>
              )}
            </div>
            <button type="submit" className="login-button" disabled={loading}>
              {loading ? 'Вход...' : 'Войти как подрядчик'}
            </button>
          </form>
        )}

        {/* Форма регистрации */}
        {mode === 'register' && (
          <form onSubmit={handleSignUp} className="login-form">
            <div className="form-field">
              <label>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email@example.com"
                required
                autoFocus
              />
            </div>
            <div className="form-field">
              <label>Пароль</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Минимум 6 символов"
                required
                minLength={6}
              />
            </div>
            <div className="form-field">
              <label>Повторите пароль</label>
              <input
                type="password"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                placeholder="Введите пароль ещё раз"
                required
                minLength={6}
              />
              {passwordConfirm && password !== passwordConfirm && (
                <small style={{ color: '#dc2626', fontSize: '0.75rem', marginTop: '0.25rem', display: 'block' }}>
                  Пароли не совпадают
                </small>
              )}
            </div>
            <button type="submit" className="login-button" disabled={loading || (passwordConfirm && password !== passwordConfirm)}>
              {loading ? 'Регистрация...' : 'Зарегистрироваться'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

export default LoginPage
