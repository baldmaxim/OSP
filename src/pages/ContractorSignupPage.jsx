import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import BrandLogo from '../components/BrandLogo'
import { contractorSignup, signupOpen } from '../api'
import { SIGNUP_LIMITS, digitsOnly, validateSignup } from '../utils/contractorSignupRules'
import './LoginPage.css'

// Регистрация подрядчика на сайте и всё, что к ней относится: заявка, подтверждение почты, подтверждение с почты компании,
// восстановление пароля. Сервер — server/osp-api/src/routes/signup.js; правила полей — utils/contractorSignupRules.js (здесь
// для удобства, решает сервер).
//
// Ссылка из письма — с токеном после «#»: он не уходит ни на сервер при открытии страницы, ни в журнал nginx, ни в заголовок
// Referer. Страница забирает его и убирает из адреса. Открытие ссылки ничего не меняет (её открывают и почтовые сканеры):
// подтверждает только нажатие кнопки. Подтверждение не выдаёт входа: дальше — почта и пароль.
//
// Пароль задаётся не в заявке, а по ссылке из письма: задаёт его хозяин почты, увидев, какую компанию подтверждает. Иначе чужой
// человек мог бы указать почту директора и свой пароль.

const TOKEN = /(?:^#|&)t=([A-Za-z0-9_-]{43})(?:&|$)/

function takeToken() {
  const m = TOKEN.exec(window.location.hash || '')
  if (window.location.hash) window.history.replaceState(null, '', window.location.pathname)
  return m ? m[1] : null
}

const passwordLength = (s) => [...String(s).normalize('NFC')].length

function Shell({ subtitle, children, footer = true }) {
  return (
    <div className="login-page">
      <div className="login-container">
        <div className="login-header">
          <BrandLogo className="brand-logo-lg" />
          <p>{subtitle}</p>
        </div>
        {children}
        {footer && (
          <div className="login-footer">
            <Link className="login-link login-link-muted" to="/partner">Вход для подрядчиков →</Link>
          </div>
        )}
      </div>
    </div>
  )
}

const friendly = (err) => {
  if (err?.code === 'too_many_attempts') {
    const min = Math.max(1, Math.ceil((err.retryAfterSec || 60) / 60))
    return `Слишком много попыток. Повторите через ${min} мин.`
  }
  return err?.message || 'Не удалось выполнить действие'
}

// ── Заявка ───────────────────────────────────────────────────────────────────────────────────────────
function RegisterView() {
  const [form, setForm] = useState({ companyName: '', inn: '', kpp: '', contactName: '', phone: '', email: '', consent: false, website: '' })
  const [errors, setErrors] = useState({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [sentTo, setSentTo] = useState('')
  const set = (key) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setForm((f) => ({ ...f, [key]: value }))
    setErrors((x) => (x[key] ? { ...x, [key]: '' } : x))
  }
  const isOrg = digitsOnly(form.inn).length !== 12

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    const checked = validateSignup(form)
    const found = {}
    if (!checked.ok) found[checked.field] = checked.message
    if (Object.keys(found).length) { setErrors(found); return }
    setBusy(true)
    try {
      await contractorSignup.register({
        companyName: form.companyName, inn: form.inn, kpp: isOrg ? (form.kpp || null) : null, contactName: form.contactName, phone: form.phone,
        email: form.email.trim(), consent: form.consent, ...(form.website ? { website: form.website } : {}),
      })
      setSentTo(form.email.trim())
    } catch (err) {
      if (err.field) setErrors({ [err.field]: err.message })
      else setError(friendly(err))
    } finally {
      setBusy(false)
    }
  }

  if (sentTo) {
    return (
      <Shell subtitle="Регистрация подрядчика">
        <div className="login-success" role="status">
          Заявка принята. На адрес {sentTo} отправлено письмо: откройте его, проверьте сведения и задайте пароль. Ссылка действует 24 часа.
        </div>
        <p className="login-note">Письма нет дольше 10 минут — проверьте папку «Спам» или отправьте заявку ещё раз.</p>
      </Shell>
    )
  }

  const field = (key, label, props = {}) => (
    <div className="form-field">
      <label htmlFor={`signup-${key}`}>{label}</label>
      <input id={`signup-${key}`} value={form[key]} onChange={set(key)} aria-invalid={errors[key] ? 'true' : undefined} {...props} />
      {props.hint && !errors[key] && <small className="login-field-hint">{props.hint}</small>}
      {errors[key] && <small className="login-field-error" role="alert">{errors[key]}</small>}
    </div>
  )

  return (
    <Shell subtitle="Регистрация подрядчика">
      {error && <div className="login-error" role="alert">{error}</div>}
      <form onSubmit={submit} className="login-form" noValidate>
        {field('companyName', 'Организация *', { type: 'text', required: true, autoFocus: true, autoComplete: 'organization', maxLength: SIGNUP_LIMITS.company, placeholder: 'ООО «Подрядчик»' })}
        {field('inn', 'ИНН *', { type: 'text', required: true, inputMode: 'numeric', autoComplete: 'off', maxLength: 12, placeholder: '10 цифр у организации, 12 у ИП' })}
        {isOrg && field('kpp', 'КПП', { type: 'text', inputMode: 'numeric', autoComplete: 'off', maxLength: 9 })}
        {field('contactName', 'Контактное лицо *', { type: 'text', required: true, autoComplete: 'name', maxLength: SIGNUP_LIMITS.person, placeholder: 'Фамилия Имя Отчество' })}
        {field('phone', 'Контактный телефон *', { type: 'tel', required: true, autoComplete: 'tel', maxLength: SIGNUP_LIMITS.phoneRaw, placeholder: '+7 ___ ___-__-__' })}
        {field('email', 'Рабочая почта *', { type: 'email', required: true, autoComplete: 'email', maxLength: SIGNUP_LIMITS.email, placeholder: 'ivanov@company.ru' })}
        {/* Ловушка для ботов: человек этого поля не видит. */}
        <div className="login-trap" aria-hidden="true">
          <label htmlFor="signup-website">Сайт</label>
          <input id="signup-website" type="text" tabIndex={-1} autoComplete="off" value={form.website} onChange={set('website')} />
        </div>
        <label className="login-consent">
          <input type="checkbox" checked={form.consent} onChange={set('consent')} aria-invalid={errors.consent ? 'true' : undefined} />
          <span>Согласен на обработку указанных персональных данных (ФИО, телефон, почта) для регистрации и участия в тендерах СУ-10</span>
        </label>
        {errors.consent && <small className="login-field-error" role="alert">{errors.consent}</small>}
        <button type="submit" className="login-button" disabled={busy}>{busy ? 'Отправка…' : 'Зарегистрироваться'}</button>
      </form>
      <p className="login-note">Пароль вы зададите по ссылке из письма. После этого откроется кабинет: активные тендеры, расценка и сведения о вашей компании.</p>
    </Shell>
  )
}

// ── Подтверждение почты: что подтверждается и пароль ─────────────────────────────────────────────────
// Сведения по ссылке — чтобы хозяин почты видел, за какую компанию его просят подтвердить.
function usePreview(token, kind) {
  const [info, setInfo] = useState(null)
  const [state, setState] = useState(token ? 'loading' : 'bad')
  const [error, setError] = useState('')
  useEffect(() => {
    if (!token) return undefined
    let cancelled = false
    contractorSignup.preview(token, kind)
      .then((data) => { if (!cancelled) { setInfo(data); setState('ready') } })
      .catch((err) => {
        if (cancelled) return
        if (err.code === 'OSP_SIGNUP_TOKEN') setState('bad')
        else { setError(friendly(err)); setState('failed') }
      })
    return () => { cancelled = true }
  }, [token, kind])
  return { info, state, setState, error, setError }
}

function ConfirmView() {
  const token = useMemo(takeToken, [])
  const navigate = useNavigate()
  const { info, state, setState, error, setError } = usePreview(token, 'confirm')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (passwordLength(password) < SIGNUP_LIMITS.passwordMin) { setError(`Пароль — не меньше ${SIGNUP_LIMITS.passwordMin} знаков. Удобно взять фразу из нескольких слов.`); return }
    if (password !== repeat) { setError('Пароль и повтор не совпадают'); return }
    setState('busy')
    try {
      const { status } = await contractorSignup.confirm(token, password)
      setPassword('')
      setRepeat('')
      setState(status === 'active' ? 'active' : 'review')
    } catch (err) {
      if (err.code === 'OSP_SIGNUP_TOKEN') setState('bad')
      else { setError(friendly(err)); setState('ready') }
    }
  }

  return (
    <Shell subtitle="Завершение регистрации">
      {error && <div className="login-error" role="alert">{error}</div>}
      {state === 'loading' && <p className="login-note">Проверяем ссылку…</p>}
      {(state === 'ready' || state === 'busy') && info && (
        <form onSubmit={submit} className="login-form" noValidate>
          <dl className="login-facts">
            <div><dt>Организация</dt><dd>{info.companyName}</dd></div>
            <div><dt>ИНН</dt><dd>{info.inn}</dd></div>
            {info.contactName && <div><dt>Контактное лицо</dt><dd>{info.contactName}</dd></div>}
            <div><dt>Почта</dt><dd>{info.email}</dd></div>
          </dl>
          <p className="login-note">Если заявку подавали не вы, закройте страницу: учётная запись не появится.</p>
          <div className="form-field">
            <label htmlFor="confirm-password">Придумайте пароль</label>
            <input id="confirm-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" maxLength={SIGNUP_LIMITS.password} placeholder={`Не меньше ${SIGNUP_LIMITS.passwordMin} знаков`} autoFocus required />
          </div>
          <div className="form-field">
            <label htmlFor="confirm-repeat">Повторите пароль</label>
            <input id="confirm-repeat" type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" maxLength={SIGNUP_LIMITS.password} required />
          </div>
          <button type="submit" className="login-button" disabled={state === 'busy'}>{state === 'busy' ? 'Проверяем…' : 'Завершить регистрацию'}</button>
        </form>
      )}
      {state === 'active' && (
        <>
          <div className="login-success" role="status">Регистрация завершена. Войдите с почтой и паролем.</div>
          <button type="button" className="login-button" onClick={() => navigate('/partner')}>Войти</button>
        </>
      )}
      {state === 'review' && (
        <div className="login-success" role="status">
          Почта подтверждена, заявка проходит проверку. Как только проверка закончится, мы напишем на этот адрес.
        </div>
      )}
      {state === 'bad' && (
        <div className="login-error" role="alert">
          Ссылка устарела или уже использована. Если вы уже завершили регистрацию, войдите; если нет — отправьте заявку ещё раз.
        </div>
      )}
    </Shell>
  )
}

// ── Подтверждение с почты компании ───────────────────────────────────────────────────────────────────
function ClaimView() {
  const token = useMemo(takeToken, [])
  const { info, state, setState, error, setError } = usePreview(token, 'claim')

  const run = async (decision) => {
    setState('busy')
    setError('')
    try {
      const { status } = await contractorSignup.claim(token, decision)
      setState(status)
    } catch (err) {
      if (err.code === 'OSP_SIGNUP_TOKEN') setState('bad')
      else { setError(friendly(err)); setState('ready') }
    }
  }

  return (
    <Shell subtitle="Запрос от имени вашей организации" footer={false}>
      {error && <div className="login-error" role="alert">{error}</div>}
      {state === 'loading' && <p className="login-note">Проверяем ссылку…</p>}
      {(state === 'ready' || state === 'busy') && info && (
        <>
          <dl className="login-facts">
            <div><dt>Организация</dt><dd>{info.companyName}</dd></div>
            <div><dt>ИНН</dt><dd>{info.inn}</dd></div>
            <div><dt>Кто просит доступ</dt><dd>{info.email}</dd></div>
          </dl>
          <p className="login-note">
            Этот человек получит доступ в кабинет подрядчика от имени вашей организации и увидит её цены и анкеты по тендерам.
            Подтверждайте, только если знаете его. Об открытом доступе узнают все контактные адреса организации.
          </p>
          <div className="login-actions">
            <button type="button" className="login-button" onClick={() => run('deny')} disabled={state === 'busy'}>Не знаю этого человека — отклонить</button>
            <button type="button" className="login-button login-button-ghost" onClick={() => run('approve')} disabled={state === 'busy'}>Это наш сотрудник — подтвердить</button>
          </div>
        </>
      )}
      {state === 'approved' && <div className="login-success" role="status">Спасибо, подтверждение принято.</div>}
      {state === 'denied' && <div className="login-success" role="status">Запрос отклонён, доступ не открыт. Заявку проверит отдел сопровождения подрядчиков.</div>}
      {state === 'bad' && <div className="login-error" role="alert">Ссылка устарела или уже использована. Вопросы — на tender.osp@su10.ru.</div>}
    </Shell>
  )
}

// ── Восстановление пароля ────────────────────────────────────────────────────────────────────────────
function ForgotView() {
  const [email, setEmail] = useState('')
  const [website, setWebsite] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!email.trim()) { setError('Укажите почту'); return }
    setBusy(true)
    try {
      await contractorSignup.forgot(email.trim(), website)
      setDone(true)
    } catch (err) {
      setError(friendly(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell subtitle="Восстановление пароля">
      {error && <div className="login-error" role="alert">{error}</div>}
      {done ? (
        <div className="login-success" role="status">
          Если для этого адреса есть учётная запись, зарегистрированная на сайте, на него отправлено письмо со ссылкой. Ссылка действует час.
          Если учётную запись выдал отдел — обратитесь к вашему менеджеру.
        </div>
      ) : (
        <form onSubmit={submit} className="login-form" noValidate>
          <div className="form-field">
            <label htmlFor="forgot-email">Почта</label>
            <input id="forgot-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={SIGNUP_LIMITS.email} autoFocus required />
          </div>
          <div className="login-trap" aria-hidden="true">
            <label htmlFor="forgot-website">Сайт</label>
            <input id="forgot-website" type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
          </div>
          <button type="submit" className="login-button" disabled={busy}>{busy ? 'Отправка…' : 'Отправить письмо'}</button>
        </form>
      )}
    </Shell>
  )
}

function ResetView() {
  const token = useMemo(takeToken, [])
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [state, setState] = useState(token ? 'ready' : 'bad')

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (passwordLength(password) < SIGNUP_LIMITS.passwordMin) { setError(`Пароль — не меньше ${SIGNUP_LIMITS.passwordMin} знаков. Удобно взять фразу из нескольких слов.`); return }
    if (password !== repeat) { setError('Пароль и повтор не совпадают'); return }
    setBusy(true)
    try {
      await contractorSignup.reset(token, password)
      setPassword('')
      setRepeat('')
      setState('done')
    } catch (err) {
      if (err.code === 'OSP_SIGNUP_TOKEN') setState('bad')
      else setError(friendly(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell subtitle="Новый пароль">
      {error && <div className="login-error" role="alert">{error}</div>}
      {state === 'ready' && (
        <form onSubmit={submit} className="login-form" noValidate>
          <div className="form-field">
            <label htmlFor="reset-password">Новый пароль</label>
            <input id="reset-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" maxLength={SIGNUP_LIMITS.password} placeholder={`Не меньше ${SIGNUP_LIMITS.passwordMin} знаков`} autoFocus required />
          </div>
          <div className="form-field">
            <label htmlFor="reset-repeat">Повторите пароль</label>
            <input id="reset-repeat" type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" maxLength={SIGNUP_LIMITS.password} required />
          </div>
          <button type="submit" className="login-button" disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить пароль'}</button>
        </form>
      )}
      {state === 'done' && (
        <>
          <div className="login-success" role="status">Пароль изменён, все прежние входы завершены.</div>
          <button type="button" className="login-button" onClick={() => navigate('/partner')}>Войти</button>
        </>
      )}
      {state === 'bad' && <div className="login-error" role="alert">Ссылка устарела или уже использована. Запросите письмо ещё раз на странице входа.</div>}
    </Shell>
  )
}

const VIEWS = { register: RegisterView, confirm: ConfirmView, claim: ClaimView, forgot: ForgotView, reset: ResetView }

export default function ContractorSignupPage({ view = 'register' }) {
  useEffect(() => {
    document.title = 'Регистрация подрядчика — СУ-10'
  }, [])
  // Закрыта — страницы заявки и письма о пароле не показываем; ссылки из уже отправленных писем проверит сервер.
  if ((view === 'register' || view === 'forgot') && !signupOpen()) {
    return (
      <Shell subtitle="Регистрация подрядчика">
        <p className="login-note">
          Регистрация на сайте сейчас закрыта. Если вашей организации нужен доступ в кабинет, обратитесь в отдел сопровождения подрядчиков:
          tender.osp@su10.ru.
        </p>
      </Shell>
    )
  }
  const View = VIEWS[view] || RegisterView
  return <View />
}
