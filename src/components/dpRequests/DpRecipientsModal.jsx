import { useEffect, useMemo, useState } from 'react'
import { IconClose, IconSearch } from '../icons/ToolbarIcons'
import { IconTrash } from '../icons/ActionIcons'
import { fetchEmployees, employeesById, employeeName } from '../../services/employees'
import { addDpRecipient, loadDpRecipients, removeDpRecipient } from '../../services/dpRequests'
import { dpErrorText } from '../../utils/dpRequests'

const SEARCH_LIMIT = 30

// Кому при новой заявке всплывает большое окно. Список ведёт администратор: «в дальнейшем буду добавлять пользователей» (решение
// пользователя 05.11.2026). Новому получателю окно придёт о заявках, созданных после добавления.
export default function DpRecipientsModal({ roleLabels, onClose }) {
  const [recipients, setRecipients] = useState(null)
  const [employees, setEmployees] = useState([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const reload = async () => setRecipients(await loadDpRecipients())

  useEffect(() => {
    let alive = true
    Promise.all([loadDpRecipients(), fetchEmployees()])
      .then(([list, staff]) => {
        if (!alive) return
        setRecipients(list)
        setEmployees(staff || [])
      })
      .catch((err) => { if (alive) { setRecipients([]); setError(dpErrorText(err)) } })
    return () => { alive = false }
  }, [])

  const byId = useMemo(() => employeesById(employees), [employees])
  const chosen = useMemo(() => new Set((recipients || []).map((r) => r.user_id)), [recipients])
  const found = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return employees
      .filter((e) => !chosen.has(e.user_id) && `${e.display_name || ''} ${e.email || ''}`.toLowerCase().includes(q))
      .slice(0, SEARCH_LIMIT)
  }, [employees, chosen, query])

  const run = async (action) => {
    setBusy(true)
    setError('')
    try {
      await action()
      await reload()
    } catch (err) {
      setError(dpErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  const roleOf = (userId) => {
    const role = byId.get(userId)?.role
    return role ? (roleLabels?.[role] || role) : ''
  }

  return (
    <div className="dpr-overlay">
      <div className="dpr-dialog is-narrow" role="dialog" aria-modal="true" aria-labelledby="dpr-recipients-title">
        <header className="dpr-dialog-head">
          <h3 id="dpr-recipients-title">Кому показывать окно о новой заявке</h3>
          <button type="button" className="dpr-x" aria-label="Закрыть" onClick={onClose}><IconClose size={18} /></button>
        </header>
        <div className="dpr-dialog-body">
          <p className="dpr-hint">
            Окно всплывает на любой странице сайта и закрывается только кнопкой. Новому получателю оно придёт о заявках, созданных после
            добавления. Чтобы открыть заявку из окна, его роли нужен просмотр раздела «Заявка на заключение ДП» (в «Правах доступа»).
          </p>
          {error && <p className="dpr-error" role="alert">{error}</p>}
          {recipients == null ? <p className="dpr-empty">Загрузка…</p> : (
            <ul className="dpr-recipients" aria-label="Получатели">
              {recipients.length === 0 && <li className="dpr-empty">Пока никого: о новых заявках никто не узнает.</li>}
              {recipients.map((r) => (
                <li key={r.user_id}>
                  <span className="dpr-recipient-name">{employeeName(byId, r.user_id)}</span>
                  <span className="dpr-hint">{roleOf(r.user_id)}</span>
                  <button
                    type="button"
                    className="dpr-file-btn is-danger"
                    aria-label={`Убрать: ${employeeName(byId, r.user_id)}`}
                    title="Убрать из списка"
                    disabled={busy}
                    onClick={() => run(() => removeDpRecipient(r.user_id))}
                  ><IconTrash size={14} /></button>
                </li>
              ))}
            </ul>
          )}
          <label className="dpr-field">
            <span className="dpr-label">Добавить сотрудника</span>
            <span className="dpr-search">
              <IconSearch size={15} />
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ФИО или почта" />
            </span>
          </label>
          {query.trim() && (
            <ul className="dpr-recipients" aria-label="Найденные сотрудники">
              {found.length === 0 && <li className="dpr-empty">Никого не нашлось.</li>}
              {found.map((e) => (
                <li key={e.user_id}>
                  <span className="dpr-recipient-name">{e.display_name}</span>
                  <span className="dpr-hint">{roleOf(e.user_id)}</span>
                  <button type="button" className="dpr-file-add" disabled={busy} onClick={() => run(() => addDpRecipient(e.user_id))}>Добавить</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer className="dpr-dialog-foot">
          <div className="dpr-dialog-buttons">
            <button type="button" className="btn-primary" onClick={onClose}>Готово</button>
          </div>
        </footer>
      </div>
    </div>
  )
}
