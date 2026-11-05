import { useCallback, useEffect, useState } from 'react'
import { contractorSignupsAdmin, db } from '../../api'
import { TemporaryPasswordDialog } from './AccountModals'
import '../../pages/AdminPage.css'
import './ContractorSignupsTab.css'

// «Администрирование» → «Регистрации подрядчиков». Сервер — server/osp-api/src/routes/signup.js, только администратор. Компанию
// в ЧС одобрить нельзя — сервер откажет.
//   Режим manual (сейчас): сюда приходит каждая заявка. Почта заявителя не подтверждена, причины — подсказки, что проверить.
//   «Открыть доступ» → окно с выбором контрагента → временный пароль один раз; передаёт его администратор.
//   Режим email: только заявки с подтверждённой почтой, которые нельзя решить автоматически: ЧС и связи с ним, нет почты в
//   карточке, отказ по ссылке.
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
  new_company: 'Новая компания: такого ИНН в реестре нет',
  contact_matches: 'Компания в реестре, почта совпала с контактом в её карточке',
  contact_differs: 'Компания в реестре, почта не из её карточки: проверьте по телефону из карточки',
  account_exists: 'С этой почтой уже есть учётная запись: открыть доступ нельзя',
}
const fmt = (v) => {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '—' : `${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
}

// Название без формы собственности и кавычек — с него начинается поиск контрагента: в реестре бывает компания без ИНН.
const nameForSearch = (name) => String(name || '')
  .replace(/(^|[\s"«»„“”'])(ооо|оао|зао|пао|ао|нао|ип|тоо)(?=$|[\s"«»„“”'])/giu, ' ')
  .replace(/["«»„“”']/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

// Окно «Открыть доступ» (режим manual): кому, что проверить, к какому контрагенту привязать. Компания с этим ИНН в реестре есть —
// сервер привяжет к ней; нет — новый контрагент или выбранный администратором: по ИНН его не нашли, а компания в реестре может быть.
function ApproveDialog({ row, onClose, onApproved }) {
  const known = Boolean(row.counterparty_id)
  const [query, setQuery] = useState(() => (known ? '' : nameForSearch(row.company_name)))
  const [found, setFound] = useState([])
  const [target, setTarget] = useState(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // Реестр большой, весь его не грузим.
  useEffect(() => {
    const q = query.trim()
    if (known || q.length < 2) { setFound([]); return undefined }
    let cancelled = false
    const t = setTimeout(async () => {
      const { data } = await db.from('counterparties').select('id, name, inn, status').is('deleted_at', null).ilike('name', `%${q}%`).order('name').limit(20)
      if (!cancelled) setFound(data || [])
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [known, query])

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setSaving(true)
    try {
      onApproved(await contractorSignupsAdmin.decide(row.id, 'approve', { counterpartyId: target?.id ?? null }))
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <div className="adm-drawer-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose() }}>
      <aside className="adm-drawer" role="dialog" aria-modal="true" aria-label="Открыть доступ">
        <header className="adm-drawer-header">
          <div>
            <h3>Открыть доступ</h3>
            <p className="adm-drawer-sub">{row.company_name}, ИНН {row.inn}</p>
          </div>
          <button type="button" className="adm-drawer-close" onClick={onClose} aria-label="Закрыть" disabled={saving}>×</button>
        </header>
        <form className="adm-drawer-body" onSubmit={submit}>
          {error && <div className="adm-drawer-error" role="alert">{error}</div>}
          <div className="adm-drawer-field">
            <span>Кому</span>
            <div>{row.contact_name}</div>
            <div className="css-muted">{row.email}</div>
            <div className="css-muted">{row.phone}</div>
          </div>
          <p className="adm-drawer-note">
            Заявку мог подать кто угодно: ИНН общедоступен, а почту и телефон заявитель указал сам. Проверьте его по контактам из карточки
            компании или из открытых источников, а не из заявки.
          </p>
          <div className="adm-drawer-field">
            <span>Контрагент</span>
            {known ? (
              <div className="adm-drawer-requested">{row.counterparty_name || 'Компания с этим ИНН из реестра'}</div>
            ) : target ? (
              <div className="adm-drawer-requested">
                {target.name}{' '}
                <button type="button" className="btn-ghost" onClick={() => setTarget(null)}>Изменить</button>
              </div>
            ) : (
              <>
                <div className="adm-drawer-requested">
                  Такого ИНН в реестре нет: будет заведён новый контрагент «{row.company_name}». Если компания в реестре есть без ИНН, выберите её:
                </div>
                <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Начните вводить название…" aria-label="Поиск контрагента" />
                {found.length > 0 && (
                  <ul className="adm-account-found">
                    {found.map((c) => (
                      <li key={c.id}>
                        <button type="button" disabled={c.status === 'blacklist'} onClick={() => setTarget(c)}>
                          {c.name}{c.inn ? `, ИНН ${c.inn}` : ''}{c.status === 'blacklist' ? ' — чёрный список' : ''}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
          <footer className="adm-drawer-footer">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Отмена</button>
            <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Открываем…' : 'Открыть доступ'}</button>
          </footer>
          <p className="adm-drawer-note">Письма заявителю нет: появится временный пароль, его передадите вы. Показывается один раз.</p>
        </form>
      </aside>
    </div>
  )
}

export default function ContractorSignupsTab({ notify = () => {} }) {
  const [tab, setTab] = useState('review')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [unavailable, setUnavailable] = useState(false)
  const [busy, setBusy] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [approving, setApproving] = useState(null)
  const [issued, setIssued] = useState(null)
  const manual = data?.mode === 'manual'

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

  const approved = async (row, result) => {
    setApproving(null)
    if (result.temporaryPassword) setIssued({ email: row.email, password: result.temporaryPassword })
    notify('ok', 'Доступ открыт')
    await load()
  }

  const decide = async (row, decision) => {
    if (decision === 'approve' && manual) { setApproving(row); return }
    const name = `«${row.company_name}» (${row.email})`
    const refuseText = manual
      ? `Отказать ${name}? Письма заявителю нет: если нужно, сообщите ему сами.`
      : `Отказать ${name}? Заявителю придёт письмо без причины.`
    if (!window.confirm(decision === 'approve' ? `Открыть доступ ${name}?` : refuseText)) return
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
        <p className="css-note">
          {manual ? 'Приём заявок на сайте сейчас закрыт: нужен OSP_CONTRACTOR_SIGNUP=1.' : 'Регистрация на сайте сейчас закрыта: нужны OSP_CONTRACTOR_SIGNUP=1 и настроенная почта.'}
        </p>
      )}
      <nav className="css-tabs" role="tablist">
        {TABS.filter((t) => !manual || t.key !== 'claim').map((t) => (
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
                <th>{!canDecide ? 'Решение' : manual ? 'Что проверить' : 'Почему здесь'}</th>
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
      {approving && <ApproveDialog row={approving} onClose={() => setApproving(null)} onApproved={(result) => approved(approving, result)} />}
      {issued && <TemporaryPasswordDialog email={issued.email} password={issued.password} onClose={() => setIssued(null)} />}
    </div>
  )
}
