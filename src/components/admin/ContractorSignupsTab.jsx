import { useCallback, useEffect, useState } from 'react'
import { contractorSignupsAdmin } from '../../api'
import './ContractorSignupsTab.css'

// «Администрирование» → «Регистрации подрядчиков»: заявки с подтверждённой почтой. Обычно решения не требуется: новая компания
// получает доступ сразу, компанию из реестра подтверждают с её почты. Сюда попадает всё, что нельзя решить автоматически:
// ЧС и связи с ним, нет почты в карточке, отказ по ссылке. Компанию в ЧС одобрить нельзя — сервер откажет. Сервер —
// server/osp-api/src/routes/signup.js, только администратор.
const TABS = [
  { key: 'review', label: 'Ждут решения' },
  { key: 'claim', label: 'Ждут подтверждения компании' },
  { key: 'active', label: 'Доступ открыт' },
  { key: 'refused', label: 'Отказано' },
]
const REASONS = {
  inn_blacklisted: 'ИНН в чёрном списке',
  affiliate_blacklisted: 'Связана с компанией из чёрного списка',
  contact_blacklisted: 'Почта или телефон — у компании из чёрного списка',
  domain_blacklisted: 'Домен почты — у компании из чёрного списка',
  name_blacklisted: 'Название совпало с компанией из чёрного списка',
  no_company_mail: 'Компания в реестре, но в её карточке нет почты',
  claim_limit: 'Слишком много запросов на почту компании',
  claim_denied: 'Компания отклонила запрос со своей почты',
  claim_expired: 'Компания не ответила за 7 дней',
  claim_recheck: 'Компанию подтвердили, но проверка не прошла повторно',
  company_unverified: 'Этот ИНН уже занят компанией, созданной другой регистрацией: проверьте, кто настоящий',
  company_account_blocked: 'У компании есть заблокированная учётка',
  company_deleted: 'Компания удалена из реестра',
  previously_refused: 'Этой почте или ИНН уже отказывали',
  daily_new_limit: 'Превышен предел новых компаний за сутки',
  email_deleted: 'Учётку с этой почтой раньше удалил администратор',
}
const fmt = (v) => {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '—' : `${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
}

export default function ContractorSignupsTab({ notify = () => {} }) {
  const [tab, setTab] = useState('review')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [unavailable, setUnavailable] = useState(false)
  const [busy, setBusy] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)

  const load = useCallback(async () => {
    setError('')
    try {
      setData(await contractorSignupsAdmin.list({ status: tab }))
      setUnavailable(false)
    } catch (err) {
      setData(null)
      if (err.unavailable) setUnavailable(true)
      else setError(err.message)
    }
  }, [tab])
  useEffect(() => { setData(null); load() }, [load])

  const more = async () => {
    const last = data?.items?.at(-1)
    if (!last) return
    setLoadingMore(true)
    try {
      const next = await contractorSignupsAdmin.list({ status: tab, before: last.created_at })
      setData((d) => ({ ...next, items: [...d.items, ...next.items] }))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoadingMore(false)
    }
  }

  const decide = async (row, decision) => {
    const name = `«${row.company_name}» (${row.email})`
    if (!window.confirm(decision === 'approve' ? `Открыть доступ ${name}?` : `Отказать ${name}? Заявителю придёт письмо без причины.`)) return
    setBusy(row.id)
    setError('')
    try {
      await contractorSignupsAdmin.decide(row.id, decision)
      notify('ok', decision === 'approve' ? 'Доступ открыт' : 'Заявка отклонена')
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  if (unavailable) {
    return <p className="css-note">Заявки хранит свой вход нового портала (tender.su10.ru). Если вы там, примените миграцию 20261203.</p>
  }

  const canDecide = tab === 'review' || tab === 'claim'
  return (
    <div className="css-tab">
      {data && data.open === false && (
        <p className="css-note">Регистрация на сайте сейчас закрыта: нужны OSP_CONTRACTOR_SIGNUP=1 и настроенная почта.</p>
      )}
      <nav className="css-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`css-tabbtn${tab === t.key ? ' is-active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>
      {error && <div className="adm-drawer-error" role="alert">{error}</div>}
      {!data && !error && <p className="css-note">Загрузка…</p>}
      {data && data.items.length === 0 && <p className="css-note">Заявок нет.</p>}
      {data && data.items.length > 0 && (
        <div className="css-table-wrap">
          <table className="css-table">
            <thead>
              <tr>
                <th>Заявка</th>
                <th>Компания</th>
                <th>Контакт</th>
                <th>{canDecide ? 'Почему здесь' : 'Решение'}</th>
                {canDecide && <th aria-label="Действия" />}
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id}>
                  <td className="css-nowrap">{fmt(r.created_at)}</td>
                  <td>
                    <div className="css-strong">{r.company_name}</div>
                    <div className="css-muted">ИНН {r.inn}{r.kpp ? `, КПП ${r.kpp}` : ''}</div>
                    {r.counterparty_name && <div className="css-muted">В реестре: {r.counterparty_name}</div>}
                  </td>
                  <td>
                    <div>{r.contact_name}</div>
                    <div className="css-muted">{r.email}</div>
                    <div className="css-muted">{r.phone}</div>
                  </td>
                  <td>
                    {canDecide ? (
                      (r.reasons || []).length
                        ? <ul className="css-reasons">{r.reasons.map((x) => <li key={x}>{REASONS[x] || x}</li>)}</ul>
                        : <span className="css-muted">Письмо на почту компании отправлено, до {fmt(r.claim_expires_at)}</span>
                    ) : (
                      <span className="css-muted">{fmt(r.decided_at)}{r.decided_by ? ', администратор' : ', автоматически'}</span>
                    )}
                  </td>
                  {canDecide && (
                    <td>
                      <div className="css-actions">
                        <button type="button" className="btn-primary" disabled={busy === r.id} onClick={() => decide(r, 'approve')}>Открыть доступ</button>
                        <button type="button" className="btn-secondary" disabled={busy === r.id} onClick={() => decide(r, 'refuse')}>Отказать</button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.hasMore && (
        <button type="button" className="btn-secondary css-more" disabled={loadingMore} onClick={more}>{loadingMore ? 'Загрузка…' : 'Показать ещё'}</button>
      )}
    </div>
  )
}
