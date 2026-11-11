import { useEffect, useState } from 'react'
import { useRole } from '../../contexts/RoleContext'
import { vatText } from '../../utils/counterpartyVat'
import { phoneHref } from '../../utils/siteContacts'
import { companyFieldState, fieldGroups, sourceOf } from '../../utils/bidFormLinks'
import { loadFormFields, saveCompanyAnswers } from '../../services/contractorBids'
import ChangePasswordForm from '../ChangePasswordForm'
import { auth } from '../../api'
import './ContractorCompanyTab.css'

// «Моя компания» в кабинете подрядчика: что отдел знает о компании и кто вошёл. Сведения читает страница (нужны и шапке):
// contractor_org_card, поля — перечнем в базе (статус, примечания и служебные пометки сюда не приходят). Карточку правит отдел:
// название и ИНН — основа всех проверок.
//
// «Для анкеты тендеров» (миграция 20270115, просьба пользователя 11.11.2026: анкета под тендером и «Моя компания» — одни сведения):
// поля анкеты о компании. Из карточки — только показ; остальные подрядчик заполняет здесь или в анкете любого тендера — ответ один
// и сам стоит в анкете каждого тендера (bid_company_save поправляет и анкеты идущих тендеров). Новое поле о компании, которое заведёт
// администратор, появится здесь само; скрытое — пропадёт.
//
// preview — просмотр от имени подрядчика: сведения прочитаны из таблиц, учётки нет, пароль сменился бы у администратора.
const ROWS = [
  ['name', 'Название'],
  ['inn', 'ИНН'],
  ['kpp', 'КПП'],
  ['legal_address', 'Юридический адрес'],
  ['actual_address', 'Фактический адрес'],
  ['website', 'Сайт'],
  ['work_type', 'Виды работ'],
]
const ACCOUNT = [
  ['contact_name', 'ФИО'],
  ['contact_phone', 'Телефон'],
  ['contact_email', 'Почта для входа'],
]

function Row({ label, value }) {
  return (
    <div className="cab-org-row">
      <dt>{label}</dt>
      <dd>{value || '—'}</dd>
    </div>
  )
}

function Rows({ card, rows }) {
  return rows.map(([key, label]) => <Row key={key} label={label} value={card[key]} />)
}

// Контактные лица компании (counterparty_contacts): кого отдел знает, кроме вошедшего.
function ContactPersons({ contacts }) {
  return (
    <ul className="cab-org-contacts">
      {contacts.map((c, i) => (
        <li key={c.id || i} className="cab-org-contact">
          <div className="cab-org-contact-name">{c.full_name || '—'}</div>
          {c.position && <div className="cab-org-contact-sub">{c.position}</div>}
          {(c.phone || c.email) && (
            <div className="cab-org-contact-links">
              {c.phone && (phoneHref(c.phone) ? <a href={phoneHref(c.phone)}>{c.phone}</a> : <span>{c.phone}</span>)}
              {c.email && <a href={`mailto:${c.email}`}>{c.email}</a>}
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

// Поля анкеты о компании: ответ из карточки — показ, остальное — правка (сохраняется при уходе из поля, выбор — сразу).
function CompanyFormFields({ fields, card, answers, canEdit, onAnswers }) {
  const [draft, setDraft] = useState({})
  const [status, setStatus] = useState({})
  const [error, setError] = useState('')
  const valueOf = (f, st) => (f.id in draft ? draft[f.id] : st.value)
  const save = async (f, value) => {
    setStatus((s) => ({ ...s, [f.id]: 'saving' }))
    setError('')
    try {
      await saveCompanyAnswers({ [f.id]: value })
      onAnswers((prev) => {
        const next = { ...(prev || {}) }
        if (String(value).trim()) next[f.id] = { label: f.label, value: String(value).trim() }
        else delete next[f.id]
        return next
      })
      setDraft((d) => { const n = { ...d }; delete n[f.id]; return n })
      setStatus((s) => ({ ...s, [f.id]: 'saved' }))
    } catch (e) {
      setStatus((s) => ({ ...s, [f.id]: 'error' }))
      setError(e.message || String(e))
    }
  }
  return (
    <>
      {error && <div className="cab-note is-warn">Не сохранилось: {error}</div>}
      <dl className="cab-org-list cab-org-form">
        {fields.map((f) => {
          const st = companyFieldState(f, card, answers)
          const state = status[f.id]
          return (
            <div key={f.id} className={`cab-org-row${!st.value && !st.locked ? ' is-empty' : ''}`}>
              <dt>
                {f.label}
                {f.hint && <span className="cab-org-hint">{f.hint}</span>}
              </dt>
              <dd>
                {st.locked || !canEdit ? (
                  <>
                    <span>{st.value || '—'}</span>
                    {st.locked && <span className="cab-org-from">из карточки компании{sourceOf(f) ? ` · ${sourceOf(f).label}` : ''}</span>}
                  </>
                ) : f.kind === 'select' ? (
                  <select className="cab-org-input" value={valueOf(f, st)} aria-label={f.label}
                    onChange={(e) => { setDraft((d) => ({ ...d, [f.id]: e.target.value })); save(f, e.target.value) }}>
                    <option value="">— выберите —</option>
                    {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <textarea className="cab-org-input" rows={1} maxLength={2000} value={valueOf(f, st)} placeholder={f.hint || 'ответ'} aria-label={f.label}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.id]: e.target.value }))}
                    onBlur={() => { if (f.id in draft && draft[f.id] !== st.value) save(f, draft[f.id]) }} />
                )}
                {state && (
                  <span className={`cab-org-state is-${state}`} aria-live="polite">
                    {state === 'saving' ? 'сохраняем…' : state === 'error' ? 'не сохранено' : 'сохранено — подставится в анкету каждого тендера'}
                  </span>
                )}
                {!state && st.cardRaw && <span className="cab-org-from">в карточке: {st.cardRaw} — в анкете такого варианта нет</span>}
                {!state && !st.cardRaw && sourceOf(f) && canEdit && <span className="cab-org-from">в карточке компании не указано — укажите здесь</span>}
              </dd>
            </div>
          )
        })}
      </dl>
    </>
  )
}

export default function ContractorCompanyTab({ card, error, preview = false, companyAnswers, onCompanyAnswers }) {
  const { contractorInfo } = useRole()
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [passwordDone, setPasswordDone] = useState(false)
  // Поля анкеты о компании — те же, что в анкете тендера (активные). null — читаются или их нет.
  const [formFields, setFormFields] = useState(null)
  useEffect(() => {
    let cancelled = false
    loadFormFields()
      .then((list) => { if (!cancelled) setFormFields(list || []) })
      .catch(() => { if (!cancelled) setFormFields([]) })
    return () => { cancelled = true }
  }, [])

  if (card === undefined) return <div className="cab-state">Загрузка…</div>
  if (error) return <div className="cab-state cab-state-error">{error}</div>

  const shown = card || { name: contractorInfo?.name }
  const contacts = Array.isArray(shown.contacts) ? shown.contacts : []
  const companyFields = formFields ? fieldGroups(formFields).company : []
  // Сведения карточки, которые сами стоят в анкете, — подсказкой под карточкой; остальные поля о компании — разделом ниже.
  const fromCard = companyFields.filter((f) => companyFieldState(f, card, companyAnswers || null).locked)
  const linkedLabels = fromCard.map((f) => sourceOf(f)?.short || f.label)
  const ownFields = companyFields.filter((f) => !fromCard.includes(f))
  return (
    <div className="cab-org">
      <section className="cab-section">
        <h3>Компания</h3>
        <dl className="cab-org-list">
          {shown.counterparty_number != null && <Row label="Номер на сайте" value={shown.counterparty_number} />}
          <Rows card={shown} rows={ROWS} />
          {('vat_rate' in shown || 'vat_exempt' in shown) && <Row label="Ставка НДС" value={vatText(shown)} />}
        </dl>
        {linkedLabels.length > 0 && (
          <p className="cab-hint cab-org-linked">Сами подставляются в анкету каждого тендера: {linkedLabels.join(', ')}.</p>
        )}
      </section>
      {ownFields.length > 0 && companyAnswers !== undefined && (
        <section className="cab-section">
          <h3>Для анкеты тендеров</h3>
          <p className="cab-hint">
            {companyAnswers === null
              ? 'Эти поля пока заполняются в анкете каждого тендера.'
              : 'Заполните один раз — ответы сами встанут в анкету каждого тендера (и тех, где вы уже участвуете). Поменять можно здесь или в анкете любого тендера.'}
          </p>
          <CompanyFormFields fields={ownFields} card={card} answers={companyAnswers || {}}
            canEdit={!preview && companyAnswers !== null} onAnswers={onCompanyAnswers} />
        </section>
      )}
      {contacts.length > 0 && (
        <section className="cab-section">
          <h3>Контактные лица</h3>
          <ContactPersons contacts={contacts} />
        </section>
      )}
      {!preview && (
        <section className="cab-section">
          <h3>Учётная запись</h3>
          <dl className="cab-org-list"><Rows card={shown} rows={ACCOUNT} /></dl>
        </section>
      )}
      <p className="cab-hint">Чтобы изменить сведения, напишите на <a href="mailto:tender.osp@su10.ru">tender.osp@su10.ru</a>.</p>
      {auth.isSso && !preview && (
        <section className="cab-section">
          <h3>Пароль</h3>
          {/* Вход через СУ-10: пароль меняется в профиле СУ-10. */}
          {auth.ssoLinks.accountUrl
            ? <a className="cab-btn" href={auth.ssoLinks.accountUrl} target="_blank" rel="noopener noreferrer">Сменить пароль в СУ-10</a>
            : <p className="cab-hint">Пароль меняется в СУ-10 (auth.su10.ru).</p>}
        </section>
      )}
      {auth.isOwn && !auth.isSso && !preview && (
        <section className="cab-section">
          <h3>Пароль</h3>
          {passwordDone && <div className="cab-note is-ok">Пароль изменён, остальные входы завершены.</div>}
          {passwordOpen ? (
            <ChangePasswordForm
              className="cab-org-password"
              buttonClassName="cab-btn cab-btn-primary"
              fieldClassName="cab-org-field"
              errorClassName="cab-note is-warn"
              onDone={() => { setPasswordOpen(false); setPasswordDone(true) }}
            />
          ) : (
            <button type="button" className="cab-btn" onClick={() => { setPasswordOpen(true); setPasswordDone(false) }}>Сменить пароль</button>
          )}
        </section>
      )}
    </div>
  )
}
