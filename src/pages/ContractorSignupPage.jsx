import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import BrandLogo from '../components/BrandLogo'
import { GlobeIcon, MaxLogo, TelegramLogo } from '../components/icons/ChannelIcons'
import { auth, contractorSignup, signupManual, signupOpen } from '../api'
import { TENDER_MAILBOX } from '../utils/siteContacts'
import {
  PHONE_PROBLEM, SIGNUP_LIMITS, cleanKppInput, digitsOnly, emailProblem, guessLegalForm, legalFormOf, legalFormsForInn, normalizePhone, parsePhoneInput,
  splitLegalForm, validateSignup,
} from '../utils/contractorSignupRules'
import { PHONE_EXT_MAX, formatPhone, joinPhoneExt } from '../utils/phoneFormat'
import './LoginPage.css'

// Регистрация подрядчика на сайте и всё, что к ней относится: заявка, подтверждение почты, подтверждение с почты компании,
// восстановление пароля. Сервер — server/osp-api/src/routes/signup.js; правила полей — utils/contractorSignupRules.js (здесь
// для удобства, решает сервер). В режиме «вручную» (signupManual) от всего этого остаётся заявка: её решает администратор,
// письмо не уходит, временный пароль передаёт отдел.
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

// Каналы СУ-10 (05.11.2026, решение пользователя). Подпись короткая: все три должны встать в одну строку карточки.
const CHANNELS = [
  { href: 'https://max.ru/id7736255508_biz', label: 'MAX', title: 'Канал СУ-10 в MAX', Icon: MaxLogo },
  { href: 'https://t.me/su10official', label: 'Telegram', title: 'Канал СУ-10 в Telegram', Icon: TelegramLogo },
  { href: 'https://su10.ru', label: 'Сайт su10.ru', title: 'Официальный сайт СУ-10', Icon: GlobeIcon },
]

function Shell({ subtitle, children, footer = true }) {
  return (
    <div className="login-page">
      <div className="login-container">
        <div className="login-header">
          <BrandLogo className="brand-logo-lg" />
          <p>{subtitle}</p>
        </div>
        {/* Почта — над формой: форма длинная, а написать может понадобиться, ещё не дойдя до её конца. */}
        <p className="login-contact">
          Контакт для связи:{' '}
          <a href={`mailto:${TENDER_MAILBOX}?subject=${encodeURIComponent('Регистрация подрядчика')}`}>{TENDER_MAILBOX}</a>
        </p>
        {children}
        <nav className="login-channels" aria-label="Каналы СУ-10">
          {CHANNELS.map(({ href, label, title, Icon }) => (
            <a key={href} className="login-channel" href={href} target="_blank" rel="noopener noreferrer" title={title} aria-label={title}>
              <Icon />
              {label}
            </a>
          ))}
        </nav>
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

// Показать в поле очищенное значение, не сдвигая курсор: он остаётся после того же по счёту значимого знака (иначе правка в середине
// номера уносила бы его в конец). Значение записывается сразу: React видит то же, что в состоянии, и поле не трогает.
function showKeepingCaret(el, shown, clean) {
  const before = clean(el.value.slice(0, el.selectionStart)).length
  el.value = shown
  let pos = 0
  for (let seen = 0; seen < before && pos < shown.length; pos += 1) if (/[\dA-Z]/.test(shown[pos])) seen += 1
  el.setSelectionRange(pos, pos)
}

// В поле — номер без кода страны: «+7» стоит перед полем.
const shownPhone = (digits) => formatPhone(`7${digits}`).slice(2)

// Человек убрал форму в списке («—»): название остаётся как есть и сама форма больше не подставляется.
const NO_FORM = 'нет'

// ── Заявка ───────────────────────────────────────────────────────────────────────────────────────────
function RegisterView() {
  const [form, setForm] = useState({ companyName: '', inn: '', kpp: '', contactName: '', phone: '', phoneExt: '', email: '', consent: false, website: '' })
  // Форма, которую назвал сам человек: словом в названии или в списке. Пусто — определяется по ИНН.
  const [namedForm, setNamedForm] = useState('')
  const [errors, setErrors] = useState({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [sentTo, setSentTo] = useState('')
  const manual = signupManual()
  const setField = (key, value) => {
    setForm((f) => ({ ...f, [key]: value }))
    setErrors((x) => (x[key] ? { ...x, [key]: '' } : x))
  }
  const set = (key) => (e) => setField(key, e.target.type === 'checkbox' ? e.target.checked : e.target.value)
  // Без maxLength: он обрезал бы вставленное «ИНН 7707083893» до очистки. Предел держит сама очистка.
  const setCleaned = (key, clean) => (e) => {
    const value = clean(e.target.value)
    showKeepingCaret(e.target, value, clean)
    setField(key, value)
  }
  const digitsUpTo = (limit) => (text) => digitsOnly(text).slice(0, limit)
  const legal = legalFormOf(namedForm || guessLegalForm(form.inn))
  const isOrg = legal ? legal.innLength === 10 : form.inn.length !== 12
  // ИНН ограничивает только форма, названная человеком: догадка сама идёт от ИНН и его 12 цифр не обрежет.
  const innLength = legalFormOf(namedForm)?.innLength
  const formOptions = legalFormsForInn(form.inn)

  const onLegalForm = (e) => {
    setNamedForm(e.target.value || NO_FORM)
    setErrors((x) => ({ ...x, companyName: '', inn: '', kpp: '' }))
  }
  const onCompanyName = (e) => {
    const text = e.target.value
    // Форму из слова берём, только пока её никто не назвал: иначе у «ООО СЗ Инвест» вторым словом сменилась бы форма.
    const found = namedForm ? null : splitLegalForm(text)
    if (found) setNamedForm(found.form)
    else if (!text.trim()) setNamedForm('')
    setField('companyName', found ? found.name : text)
  }
  const onPhone = (e) => {
    const { number, ext } = parsePhoneInput(e.target.value)
    showKeepingCaret(e.target, shownPhone(number), digitsOnly)
    setField('phone', number)
    if (ext) setField('phoneExt', ext)
  }
  const onPhoneBlur = () => {
    if (form.phone && !normalizePhone(`+7${form.phone}`)) setErrors((x) => ({ ...x, phone: PHONE_PROBLEM }))
  }
  const onEmailBlur = () => {
    const problem = form.email.trim() && emailProblem(form.email)
    if (problem) setErrors((x) => ({ ...x, email: problem }))
  }

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    const request = {
      legalForm: legal?.code ?? '', companyName: form.companyName, inn: form.inn, kpp: isOrg ? (form.kpp || null) : null, contactName: form.contactName,
      phone: form.phone ? joinPhoneExt(`+7${form.phone}`, form.phoneExt) : '',
      email: form.email.trim(), consent: form.consent, ...(form.website ? { website: form.website } : {}),
    }
    const checked = validateSignup(request)
    if (!checked.ok) { setErrors({ [checked.field]: checked.message }); return }
    setBusy(true)
    try {
      await contractorSignup.register(request)
      setSentTo(form.email.trim())
    } catch (err) {
      if (err.field) setErrors({ [err.field]: err.message })
      else setError(friendly(err))
    } finally {
      setBusy(false)
    }
  }

  if (sentTo && manual) {
    return (
      <Shell subtitle="Заявка на регистрацию">
        <div className="login-success" role="status">
          Заявка принята. Отдел сопровождения подрядчиков проверит её и свяжется с вашей организацией: передаст временный пароль для входа с почтой {sentTo}.
        </div>
      </Shell>
    )
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
    <Shell subtitle={manual ? 'Заявка на регистрацию' : 'Регистрация подрядчика'}>
      {error && <div className="login-error" role="alert">{error}</div>}
      <form onSubmit={submit} className="login-form" noValidate>
        <div className="form-field">
          <label htmlFor="signup-companyName">Организация *</label>
          <div className="login-input-group">
            {/* Выбирать не нужно: форма встаёт сама. Список — только поправить, при известном ИНН в нём лишь подходящие формы. */}
            <select aria-label="Форма организации" value={legal?.code ?? ''} onChange={onLegalForm}>
              <option value="">—</option>
              {legal && !formOptions.includes(legal) && <option value={legal.code}>{legal.code}</option>}
              {formOptions.map((f) => <option key={f.code} value={f.code}>{f.code}</option>)}
            </select>
            <input
              id="signup-companyName" type="text" required autoFocus autoComplete="organization" maxLength={SIGNUP_LIMITS.company}
              value={form.companyName} onChange={onCompanyName} aria-invalid={errors.companyName ? 'true' : undefined}
              placeholder="Например, ООО Ромашка"
            />
          </div>
          {errors.companyName
            ? <small className="login-field-error" role="alert">{errors.companyName}</small>
            : (
              <small className="login-field-hint">
                {form.companyName.trim()
                  ? `В заявке: ${legal ? `${legal.code} ` : ''}${form.companyName.trim()}`
                  : legal ? `Форма: ${legal.code}` : 'Форма определится сама — из названия или по ИНН'}
                {legal && !namedForm && ' · определена по ИНН, если не так — выберите другую'}
                {legal?.code === 'СЗ' && ' · СЗ — самозанятый'}
              </small>
            )}
        </div>
        {field('inn', 'ИНН *', { type: 'text', required: true, inputMode: 'numeric', autoComplete: 'off', onChange: setCleaned('inn', digitsUpTo(innLength ?? 12)), placeholder: innLength ? `${innLength} цифр` : '10 или 12 цифр' })}
        {isOrg && field('kpp', 'КПП', { type: 'text', autoComplete: 'off', autoCapitalize: 'characters', onChange: setCleaned('kpp', cleanKppInput), placeholder: `${SIGNUP_LIMITS.kpp} знаков` })}
        {field('contactName', 'Контактное лицо *', { type: 'text', required: true, autoComplete: 'name', maxLength: SIGNUP_LIMITS.person, placeholder: 'Фамилия Имя Отчество' })}
        <div className="form-field">
          <label htmlFor="signup-phone">Контактный телефон *</label>
          <div className="login-phone">
            <div className="login-input-group login-phone-number">
              <span className="login-input-affix" aria-hidden="true">+7</span>
              <input
                id="signup-phone" type="tel" inputMode="numeric" required autoComplete="tel-national"
                value={shownPhone(form.phone)} onChange={onPhone} onBlur={onPhoneBlur} aria-invalid={errors.phone ? 'true' : undefined}
                placeholder="(916)123-45-67"
              />
            </div>
            <div className="login-input-group login-phone-ext">
              <label className="login-input-affix" htmlFor="signup-phoneExt">доб.</label>
              <input
                id="signup-phoneExt" type="tel" inputMode="numeric" autoComplete="off"
                value={form.phoneExt} onChange={setCleaned('phoneExt', digitsUpTo(PHONE_EXT_MAX))}
              />
            </div>
          </div>
          {errors.phone && <small className="login-field-error" role="alert">{errors.phone}</small>}
        </div>
        {field('email', 'Рабочая почта *', { type: 'email', required: true, autoComplete: 'email', maxLength: SIGNUP_LIMITS.email, onBlur: onEmailBlur, placeholder: 'ivanov@company.ru' })}
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
        <button type="submit" className="login-button" disabled={busy}>{busy ? 'Отправка…' : manual ? 'Отправить заявку' : 'Зарегистрироваться'}</button>
      </form>
      <p className="login-note">
        {manual
          ? 'Заявку проверит отдел сопровождения подрядчиков. После одобрения вам передадут временный пароль, при первом входе вы смените его на свой. В кабинете — активные тендеры, расценка и сведения о вашей компании.'
          : 'Пароль вы зададите по ссылке из письма. После этого откроется кабинет: активные тендеры, расценка и сведения о вашей компании.'}
      </p>
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
  // Вход через СУ-10: регистрации и паролей на сайте нет — учётку заводит администратор доступа СУ-10.
  if (auth.isSso) {
    return (
      <Shell subtitle="Регистрация подрядчика">
        <p className="login-note">
          Учётку подрядчику заводит администратор доступа СУ-10 — обратитесь к контактному лицу в ОСП ({TENDER_MAILBOX}).
          Забыли пароль — временный выдаёт тот же администратор.
        </p>
      </Shell>
    )
  }
  // Без писем восстановить пароль самому нельзя: временный выдаёт отдел.
  if (view === 'forgot' && signupManual()) {
    return (
      <Shell subtitle="Восстановление пароля">
        <p className="login-note">Забыли пароль — обратитесь к вашему менеджеру или на tender.osp@su10.ru: вам выдадут временный.</p>
      </Shell>
    )
  }
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
