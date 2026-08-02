import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRole } from '../contexts/RoleContext'
import BrandLogo from '../components/BrandLogo'
import { fetchAllActiveCounterparties } from '../utils/fetchAllRows'
import './LoginPage.css'

// variant: 'employee' — вход для сотрудников (+ регистрация); 'contractor' — вход для
// подрядчиков (выбор организации). Экран выбора роли убран, у каждого входа свой URL.
function LoginPage({ variant = 'employee' }) {
  const navigate = useNavigate()
  const { loginWithPassword, loginAsContractor, signUp, isLoggedIn, isEmployee } = useRole()
  const isContractorVariant = variant === 'contractor'

  // 'employee' | 'contractor' | 'register'. Для варианта подрядчика — всегда 'contractor'.
  const [mode, setMode] = useState(isContractorVariant ? 'contractor' : 'employee')
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
      // Постранично — активных контрагентов >1000 (потолок PostgREST), иначе часть
      // не попадёт в выпадашку выбора.
      const data = await fetchAllActiveCounterparties('id, name')
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
      const data = await signUp(email, password)
      // Supabase не отдаёт ошибку, если email уже зарегистрирован (защита от перебора адресов):
      // возвращается user с пустым массивом identities. Отличаем этот случай, чтобы не обещать
      // письмо, которого не будет.
      const alreadyRegistered =
        data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0
      if (alreadyRegistered) {
        setError('Этот email уже зарегистрирован. Войдите или воспользуйтесь ссылкой подтверждения из ранее отправленного письма.')
        return
      }
      // Подтверждение почты включено: сразу войти нельзя — нужно перейти по ссылке из письма,
      // а затем дождаться одобрения администратором.
      setSuccessMessage(
        `Регистрация принята. На адрес ${email} отправлено письмо со ссылкой для подтверждения — ` +
        'перейдите по ней, чтобы активировать аккаунт. После подтверждения вход откроется, когда ' +
        'администратор одобрит заявку.'
      )
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
    // Лимит писем встроенного почтовика Supabase (код over_email_send_rate_limit /
    // текст «email rate limit exceeded»). Считаются письма за последний час на весь
    // проект, а не число аккаунтов — поясняем это, чтобы не путали с лимитом на юзеров.
    if (msg.toLowerCase().includes('rate limit')) {
      return 'Отправлено слишком много писем-подтверждений за короткое время. ' +
        'Это ограничение почтового сервера (считаются письма за последний час, ' +
        'а не число аккаунтов). Подождите около часа и попробуйте снова.'
    }
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
          <BrandLogo className="brand-logo-lg" />
          <p>{isContractorVariant ? 'Кабинет подрядчика' : 'Тендерная площадка'}</p>
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

        {/* Переключение регистрации и перекрёстные ссылки между двумя входами */}
        <div className="login-footer">
          {isContractorVariant ? (
            <button type="button" className="login-link" onClick={() => navigate('/login')}>
              Вход для сотрудников →
            </button>
          ) : mode === 'register' ? (
            <button type="button" className="login-link" onClick={() => switchMode('employee')}>
              Уже есть аккаунт? Войти
            </button>
          ) : (
            <>
              <button type="button" className="login-link" onClick={() => switchMode('register')}>
                Регистрация сотрудника
              </button>
              <button type="button" className="login-link login-link-muted" onClick={() => navigate('/partner')}>
                Вход для подрядчиков →
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default LoginPage
