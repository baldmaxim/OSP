import { useEffect, useState } from 'react'
import { loadOrgCard } from '../../services/contractorBids'
import { useRole } from '../../contexts/RoleContext'
import ChangePasswordForm from '../ChangePasswordForm'
import { auth } from '../../api'
import './ContractorCompanyTab.css'

// «Моя компания» в кабинете подрядчика: что отдел знает о компании и кто вошёл (contractor_org_card, поля — перечнем в базе:
// статус, примечания и служебные пометки сюда не приходят). Только просмотр: название и ИНН — основа всех проверок,
// поэтому правит их отдел.
const ROWS = [
  ['name', 'Название'],
  ['inn', 'ИНН'],
  ['kpp', 'КПП'],
  ['legal_address', 'Юридический адрес'],
  ['actual_address', 'Фактический адрес'],
  ['website', 'Сайт'],
  ['work_type', 'Виды работ'],
]
const CONTACT = [
  ['contact_name', 'Контактное лицо'],
  ['contact_phone', 'Контактный телефон'],
  ['contact_email', 'Почта для входа'],
]

function Rows({ card, rows }) {
  return (
    <dl className="cab-org-list">
      {rows.map(([key, label]) => (
        <div key={key} className="cab-org-row">
          <dt>{label}</dt>
          <dd>{card[key] || '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

export default function ContractorCompanyTab() {
  const { contractorInfo } = useRole()
  const [card, setCard] = useState(undefined)
  const [error, setError] = useState('')
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [passwordDone, setPasswordDone] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadOrgCard()
      .then((row) => { if (!cancelled) setCard(row) })
      .catch((e) => { if (!cancelled) { setCard(null); setError(e.message || String(e)) } })
    return () => { cancelled = true }
  }, [])

  if (card === undefined) return <div className="cab-state">Загрузка…</div>
  if (error) return <div className="cab-state cab-state-error">{error}</div>

  const shown = card || { name: contractorInfo?.name }
  return (
    <div className="cab-org">
      <section className="cab-section">
        <h3>Компания</h3>
        <Rows card={shown} rows={ROWS} />
      </section>
      <section className="cab-section">
        <h3>Контакт</h3>
        <Rows card={shown} rows={CONTACT} />
        <p className="cab-hint">Чтобы изменить сведения, напишите на <a href="mailto:tender.osp@su10.ru">tender.osp@su10.ru</a>.</p>
      </section>
      {auth.isOwn && (
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
