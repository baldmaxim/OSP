import { useState } from 'react'
import { useRole } from '../../contexts/RoleContext'
import { vatText } from '../../utils/counterpartyVat'
import { phoneHref } from '../../utils/siteContacts'
import ChangePasswordForm from '../ChangePasswordForm'
import { auth } from '../../api'
import './ContractorCompanyTab.css'

// «Моя компания» в кабинете подрядчика: что отдел знает о компании и кто вошёл. Сведения читает страница (нужны и шапке):
// contractor_org_card, поля — перечнем в базе (статус, примечания и служебные пометки сюда не приходят). Только просмотр:
// название и ИНН — основа всех проверок, поэтому правит их отдел.
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

export default function ContractorCompanyTab({ card, error, preview = false }) {
  const { contractorInfo } = useRole()
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [passwordDone, setPasswordDone] = useState(false)

  if (card === undefined) return <div className="cab-state">Загрузка…</div>
  if (error) return <div className="cab-state cab-state-error">{error}</div>

  const shown = card || { name: contractorInfo?.name }
  const contacts = Array.isArray(shown.contacts) ? shown.contacts : []
  return (
    <div className="cab-org">
      <section className="cab-section">
        <h3>Компания</h3>
        <dl className="cab-org-list">
          {shown.counterparty_number != null && <Row label="Номер на сайте" value={shown.counterparty_number} />}
          <Rows card={shown} rows={ROWS} />
          {('vat_rate' in shown || 'vat_exempt' in shown) && <Row label="Ставка НДС" value={vatText(shown)} />}
        </dl>
      </section>
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
      {auth.isOwn && !preview && (
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
