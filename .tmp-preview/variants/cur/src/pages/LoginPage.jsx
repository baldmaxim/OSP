import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRole } from '../contexts/RoleContext'
import BrandLogo from '../components/BrandLogo'
import { takeAuthRedirectResult } from '../utils/authRedirect'
import './LoginPage.css'

// Приём заявок подрядчиков на доступ в кабинет. Временно остановлен (2026-09-18):
// ссылка «Подать заявку» скрыта, форма не открывается. Уже поданные заявки и вход
// подтверждённых подрядчиков работают как раньше. Чтобы возобновить — true.
const CONTRACTOR_SIGNUP_OPEN = false

// variant: 'employee' — вход для сотрудников (+ регистрация); 'contractor' — вход для
// подрядчиков (выбор организации). Экран выбора роли убран, у каждого входа свой URL.
function LoginPage({ variant = 'employee' }) {
  const navigate = useNavigate()
  const { loginWithPassword, loginAsContractor, signUp, resendConfirmation, isLoggedIn, isEmployee } = useRole()
  const isContractorVariant = variant === 'contractor'

  // 'employee' | 'contractor' | 'register'. Для варианта подрядчика — всегда 'contractor'.
  const [mode, setMode] = useState(isContractorVariant ? 'contractor' : 'employee')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [successMessage, setSuccessMessage] = useState('')
  // Почта не подтверждена / ссылка из письма не сработала — предлагаем новое письмо.
  const [showResend, setShowResend] = useState(false)
  const [resending, setResending] = useState(false)
  // Заявка подрядчика: организацию пишем текстом. Справочник контрагентов —
  // коммерческая информация, наружу его не отдаём; связывает заявку с карточкой
  // администратор при подтверждении.
  const [companyName, setCompanyName] = useState('')
  const [companyInn, setCompanyInn] = useState('')
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')

  useEffect(() => {
    if (isLoggedIn) {
      navigate(isEmployee ? '/general/objects' : '/contractor')
    }
  }, [isLoggedIn, isEmployee, navigate])

  // Вернулись по ссылке из письма: говорим, чем кончилось. Раньше ошибку ссылки
  // (устарела, уже использована) никто не показывал — человек видел обычную форму
  // входа, считал почту подтверждённой и снова получал «Email не подтверждён».
  useEffect(() => {
    const result = takeAuthRedirectResult()
    if (!result) return
    if (result.kind === 'confirmed') {
      setSuccessMessage('Почта подтверждена. Войдите со своим email и паролем — доступ откроет администратор, если он ещё не открыт.')
    } else {
      setError(result.code === 'otp_expired'
        ? 'Ссылка из письма устарела или уже использована (каждое новое письмо отменяет предыдущее). Отправьте письмо ещё раз и перейдите по новой ссылке сразу.'
        : `Не удалось подтвердить почту по ссылке${result.description ? `: ${result.description}` : ''}. Отправьте письмо ещё раз.`)
      setShowResend(true)
    }
  }, [])

  const handleResend = async () => {
    const target = email.trim()
    if (!target) {
      setError('Введите email в поле ниже и нажмите «Отправить письмо ещё раз».')
      return
    }
    setResending(true)
    try {
      await resendConfirmation(target, { contractor: isContractorVariant })
      setError('')
      setShowResend(false)
      setSuccessMessage(`Письмо отправлено на ${target}. Откройте его и перейдите по ссылке сразу — она действует ограниченное время. Если письма нет, проверьте «Спам».`)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setResending(false)
    }
  }

  const isNotConfirmedError = (err) => /Email not confirmed/i.test(err?.message || '')

  const handleEmployeeLogin = async (e) => {
    e.preventDefault()
    setError('')
    setSuccessMessage('')
    setLoading(true)
    try {
      await loginWithPassword(email, password)
      // Стартовую страницу выбирает HomeRedirect по правам роли.
      navigate('/')
    } catch (err) {
      if (err.message === 'PENDING_APPROVAL') {
        setSuccessMessage('Ваша заявка отправлена. Ожидайте подтверждения администратором.')
      } else {
        setError(getErrorMessage(err))
        if (isNotConfirmedError(err)) setShowResend(true)
      }
    } finally {
      setLoading(false)
    }
  }

  const handleContractorLogin = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      // Организацию не выбираем: она берётся из привязки логина в базе.
      await loginAsContractor(email, password)
      navigate('/contractor')
    } catch (err) {
      if (err.message === 'PENDING_APPROVAL') {
        setSuccessMessage('Ваша заявка отправлена. Ожидайте подтверждения администратором.')
      } else if (err.message === 'NO_COUNTERPARTY') {
        setError('Логин не привязан к организации. Обратитесь к вашему менеджеру в отделе сопровождения подрядчиков — он свяжет учётную запись с компанией.')
      } else {
        setError(getErrorMessage(err))
        if (isNotConfirmedError(err)) setShowResend(true)
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
      setSuccessMessage(data.needsEmailConfirmation
        ? `Регистрация принята. На адрес ${email} отправлено письмо со ссылкой для подтверждения — ` +
          'перейдите по ней, чтобы активировать аккаунт. После подтверждения вход откроется, когда ' +
          'администратор одобрит заявку.'
        // Подтверждение почты выключено в Supabase — письма нет, ждём только администратора.
        : 'Регистрация принята. Войдите со своим email и паролем — вход откроется, когда администратор одобрит заявку.'
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

  const handleContractorSignUp = async (e) => {
    e.preventDefault()
    setError('')
    setSuccessMessage('')
    if (!CONTRACTOR_SIGNUP_OPEN) {
      setError('Регистрация подрядчиков временно приостановлена.')
      return
    }
    if (!companyName.trim()) { setError('Укажите название организации'); return }
    if (password.length < 6) { setError('Пароль должен быть не менее 6 символов'); return }
    if (password !== passwordConfirm) { setError('Пароли не совпадают'); return }
    setLoading(true)
    try {
      const company = [companyName.trim(), companyInn.trim() && `ИНН ${companyInn.trim()}`]
        .filter(Boolean).join(', ')
      const data = await signUp(email, password, {
        kind: 'contractor',
        company,
        full_name: contactName.trim() || null,
        phone: contactPhone.trim() || null,
      })
      const alreadyRegistered =
        data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0
      if (alreadyRegistered) {
        setError('Этот email уже зарегистрирован. Войдите или воспользуйтесь ссылкой подтверждения из ранее отправленного письма.')
        return
      }
      setSuccessMessage(data.needsEmailConfirmation
        ? `Заявка принята. На адрес ${email} отправлено письмо со ссылкой для подтверждения — ` +
          'перейдите по ней и войдите. После этого отдел сопровождения подрядчиков свяжет вашу ' +
          'учётную запись с организацией и откроет доступ в кабинет.'
        : 'Заявка принята. Войдите со своим email и паролем — после этого отдел сопровождения ' +
          'подрядчиков свяжет вашу учётную запись с организацией и откроет доступ в кабинет.'
      )
      setMode('contractor')
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
    if (msg === 'ACCOUNT_BLOCKED') return 'Доступ к системе заблокирован. Обратитесь к администратору.'
    if (msg.includes('Invalid login credentials')) return 'Неверный email или пароль'
    if (msg.includes('Email not confirmed')) return 'Email не подтверждён: перейдите по ссылке из письма. Если ссылка не сработала или письма нет — отправьте его ещё раз.'
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
    setShowResend(false)
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

        {showResend && (
          <div className="login-resend">
            <button type="button" className="login-resend-btn" onClick={handleResend} disabled={resending}>
              {resending ? 'Отправка…' : 'Отправить письмо ещё раз'}
            </button>
          </div>
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
            {/* Организацию не выбираем: кабинет открывается для компании, к
                которой логин привязан в системе. */}
            <button type="submit" className="login-button" disabled={loading}>
              {loading ? 'Вход...' : 'Войти как подрядчик'}
            </button>
          </form>
        )}

        {/* Заявка подрядчика на доступ в кабинет */}
        {mode === 'contractor_register' && CONTRACTOR_SIGNUP_OPEN && (
          <form onSubmit={handleContractorSignUp} className="login-form">
            <div className="form-field">
              <label>Организация *</label>
              <input
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="ТОО «Подрядчик»"
                required
                autoFocus
              />
            </div>
            <div className="form-field">
              <label>ИНН / БИН</label>
              <input
                type="text"
                value={companyInn}
                onChange={(e) => setCompanyInn(e.target.value)}
                placeholder="Чтобы вас не спутали с тёзкой"
              />
            </div>
            <div className="form-field">
              <label>Контактное лицо</label>
              <input
                type="text"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                placeholder="Фамилия Имя Отчество"
              />
            </div>
            <div className="form-field">
              <label>Телефон</label>
              <input
                type="tel"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                placeholder="+7 ___ ___ __ __"
              />
            </div>
            <div className="form-field">
              <label>Email *</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email@example.com"
                required
              />
            </div>
            <div className="form-field">
              <label>Пароль *</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Не менее 6 символов"
                required
              />
            </div>
            <div className="form-field">
              <label>Повторите пароль *</label>
              <input
                type="password"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                placeholder="Ещё раз"
                required
              />
            </div>
            <p className="login-note">
              Доступ откроется после проверки: мы сверим организацию со своим реестром
              контрагентов и свяжем с ней вашу учётную запись.
            </p>
            <button type="submit" className="login-button" disabled={loading}>
              {loading ? 'Отправка…' : 'Отправить заявку'}
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
            <>
              {!CONTRACTOR_SIGNUP_OPEN ? (
                <p className="login-note login-signup-paused">
                  Регистрация новых подрядчиков временно приостановлена. Если вашей организации
                  нужен доступ в кабинет, обратитесь в отдел сопровождения подрядчиков.
                </p>
              ) : mode === 'contractor_register' ? (
                <button type="button" className="login-link" onClick={() => switchMode('contractor')}>
                  Уже есть доступ? Войти
                </button>
              ) : (
                <button type="button" className="login-link" onClick={() => switchMode('contractor_register')}>
                  Первый раз здесь? Подать заявку на доступ
                </button>
              )}
              <button type="button" className="login-link login-link-muted" onClick={() => navigate('/login')}>
                Вход для сотрудников →
              </button>
            </>
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
