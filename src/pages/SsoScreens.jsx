import { useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRole } from '../contexts/RoleContext'
import { auth } from '../api'
import BrandLogo from '../components/BrandLogo'
import './LoginPage.css'

// Вход через СУ-10 (AUTH_MODE=keycloak): страницы портала вокруг входа на auth.su10.ru. Вход и пароли — в СУ-10, страница только
// переводит туда и объясняет итог. Сервер — server/osp-api/src/routes/oidc.js.
//
//   /login, /partner    — сразу переход на вход СУ-10; с ?sso_error= или после выхода — текст и кнопка, без автоперехода
//                         (иначе ошибка входа зациклилась бы);
//   /no-access          — у учётки СУ-10 нет доступа к порталу (или заявка отклонена);
//   /access-requested   — заявка отправлена администратору ОСП;
//   /auth/done          — окно повторного входа: сообщает вкладкам «вошёл» и закрывается.

// Путь, куда вернуться после входа: только свой путь (не «//», не «/\», не API) — как проверяет и сервер.
export function safeReturnUrl(raw) {
  const v = typeof raw === 'string' ? raw : ''
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\') || v.length > 500) return '/'
  if (v === '/api' || v.startsWith('/api/') || v.startsWith('/login') || v.startsWith('/partner')) return '/'
  return v
}

export const ssoLoginHref = (returnUrl = '/') => `/api/auth/oidc/login?returnUrl=${encodeURIComponent(safeReturnUrl(returnUrl))}`

const ERRORS = {
  state: 'Вход начали в другой вкладке или он устарел. Войдите ещё раз.',
  unavailable: 'СУ-10 сейчас не отвечает. Повторите вход через несколько минут.',
  disabled: 'Учётная запись в портале ОСП заблокирована или ожидает одобрения. Обратитесь к администратору ОСП.',
  access_denied: 'Вход отменён.',
  login_required: 'Нужно войти в СУ-10.',
  temporarily_unavailable: 'СУ-10 временно недоступен. Повторите вход через несколько минут.',
  config: 'Вход через СУ-10 настроен с ошибкой. Сообщите администратору портала.',
}
const errorText = (code) => ERRORS[code] || 'Не удалось завершить вход через СУ-10. Войдите ещё раз; если повторится — сообщите администратору ОСП.'

function Shell({ title, children }) {
  return (
    <div className="login-page">
      <div className="login-container">
        <div className="login-header">
          <BrandLogo className="brand-logo-lg" />
          <p>{title}</p>
        </div>
        {children}
      </div>
    </div>
  )
}

export function SsoLogin({ variant = 'employee' }) {
  const { isLoggedIn, isEmployee, authLoading } = useRole()
  const navigate = useNavigate()
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const ssoError = params.get('sso_error')
  // После выхода (или пока он идёт) — без автоперехода: живой ещё вход СУ-10 вернул бы человека обратно.
  const afterLogout = params.get('sso') === 'logout' || auth.isLeaving
  const href = ssoLoginHref(params.get('returnUrl') || '/')

  useEffect(() => {
    if (isLoggedIn) navigate(isEmployee ? '/general' : '/contractor', { replace: true })
  }, [isLoggedIn, isEmployee, navigate])
  useEffect(() => {
    if (!authLoading && !isLoggedIn && !ssoError && !afterLogout) window.location.assign(href)
  }, [authLoading, isLoggedIn, ssoError, afterLogout, href])

  return (
    <Shell title={variant === 'contractor' ? 'Кабинет подрядчика' : 'Тендерная площадка'}>
      {ssoError && <div className="login-error" role="alert">{errorText(ssoError)}</div>}
      {afterLogout && <div className="login-success">Вы вышли из портала.</div>}
      {!ssoError && !afterLogout && <p className="login-note">Переходим на страницу входа СУ-10…</p>}
      <a className="login-button sso-button" href={href}>Войти через СУ-10</a>
      <p className="login-note sso-note">
        Вход — почтой и паролем СУ-10 (ФОТ). Нет учётки или забыли пароль — обратитесь к администратору доступа СУ-10.
      </p>
    </Shell>
  )
}

function SignOutButton() {
  const { logout } = useRole()
  return (
    <button type="button" className="login-button login-button-ghost" onClick={() => logout()}>
      Выйти
    </button>
  )
}

export function NoAccessPage() {
  return (
    <Shell title="Нет доступа">
      <div className="login-error" role="alert">Нет доступа к Тендер ОСП. Запросите доступ у администратора.</div>
      <p className="login-note">
        Если доступ уже выдали, войдите ещё раз. Войти под другой учётной записью — «Выйти», затем снова «Войти».
      </p>
      <div className="login-actions">
        <a className="login-button sso-button" href={ssoLoginHref('/')}>Войти ещё раз</a>
        <SignOutButton />
      </div>
    </Shell>
  )
}

export function AccessRequestedPage() {
  return (
    <Shell title="Заявка отправлена">
      <div className="login-success">Заявка отправлена администратору ОСП. Вход откроется после её одобрения.</div>
      <div className="login-actions">
        <a className="login-button sso-button" href={ssoLoginHref('/')}>Проверить ещё раз</a>
        <SignOutButton />
      </div>
    </Shell>
  )
}

// Окно повторного входа (ReloginModal): вход прошёл — вкладки узнают через BroadcastChannel, окно закрывается. Открыли
// не окном (окна заблокированы) — просто на главную.
export function AuthDonePage() {
  useEffect(() => {
    try {
      const channel = new BroadcastChannel('osp-auth')
      channel.postMessage({ event: 'SIGNED_IN' })
      channel.close()
    } catch { /* без канала вкладки сверятся сами при следующем запросе */ }
    if (window.opener && !window.opener.closed) window.close()
    else window.location.replace('/')
  }, [])
  return (
    <Shell title="Вход выполнен">
      <p className="login-note">Вход выполнен — окно можно закрыть.</p>
    </Shell>
  )
}
