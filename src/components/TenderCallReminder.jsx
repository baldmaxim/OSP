import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { isTuesday, weekKey } from '../utils/weeks'
import { tenderObjectName } from '../utils/tenderDepartments'
import './TenderCallReminder.css'

// Вторничное напоминание об обзвоне объектов по «висящим» тендерам.
//
// Зачем: тендеры на стадиях «Идет тендерная процедура» и «Подведение итогов»
// ждут ответа с объекта, и статус в системе устаревает молча. Раз в неделю, во
// вторник, инженеру показываем список таких тендеров — с ним и звонят.
//
// Показывается ТОЛЬКО во вторник и один раз за неделю: отметка о закрытии
// лежит в localStorage под ключом недели (понедельник), поэтому в следующий
// вторник окно приходит само, без всякой серверной механики. Ключ свой на каждое
// направление — закрыв напоминание в «Основном строительстве», инженер не должен
// пропустить гарантийные тендеры.
//
// Хранение в localStorage, а не в БД, сознательно: это подсказка в работе, а не
// учётная запись. Цена ошибки — лишний показ на другом компьютере.

const WATCHED_STATUSES = ['Идет тендерная процедура', 'Подведение итогов']

const IconPhone = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z" />
  </svg>
)

export default function TenderCallReminder({
  tenders,
  department,
  enabled = true,
  // Предпросмотр для администратора: открыть окно в любой день, не трогая
  // недельную отметку. Нужен, чтобы посмотреть на напоминание, не дожидаясь
  // вторника и не сбивая расписание живым пользователям.
  forceOpen = false,
  onCloseForced,
}) {
  const storageKey = `tenderCallReminder:${department || 'all'}`
  const thisWeek = weekKey(new Date())

  // Состояние читаем один раз при монтировании: в течение сессии окно либо
  // показано, либо закрыто, метаться не должно.
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(storageKey) === thisWeek } catch { return false }
  })

  const pending = useMemo(() => (tenders || [])
    .filter(t => !t.deleted_at && WATCHED_STATUSES.includes(t.status))
    // Сначала те, что ближе к финишу: по ним ответ нужнее.
    .sort((a, b) => {
      const w = (t) => (t.status === 'Подведение итогов' ? 0 : 1)
      if (w(a) !== w(b)) return w(a) - w(b)
      return (a.public_tender_number || 0) - (b.public_tender_number || 0)
    }), [tenders])

  // В режиме предпросмотра показываем всегда — иначе администратор увидит окно
  // только во вторник и только при непустом списке.
  if (!forceOpen && (!enabled || dismissed || !isTuesday() || pending.length === 0)) return null

  const close = (forWeek) => {
    if (forceOpen) { onCloseForced?.(); return }   // предпросмотр отметку не ставит
    if (forWeek) {
      try { localStorage.setItem(storageKey, thisWeek) } catch { /* приватный режим — переживём */ }
    }
    setDismissed(true)
  }

  return (
    <div className="modal-overlay" onClick={() => close(false)}>
      <div className="modal tcr-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="tcr-head">
          <span className="tcr-icon"><IconPhone /></span>
          <div>
            <h3>Вторник — обзвон по тендерам</h3>
            <p className="tcr-sub">
              Обзвоните объекты и уточните, есть ли результат. По итогам разговора
              обновите статус тендера — иначе в реестре он останется прежним.
            </p>
          </div>
          <button className="modal-close" onClick={() => close(false)} aria-label="Закрыть">×</button>
        </div>

        <div className="tcr-body">
          {forceOpen && (
            <div className="tcr-preview-note">
              Предпросмотр. Так окно увидят инженеры во вторник; сейчас оно
              открыто вручную и недельную отметку не ставит.
            </div>
          )}
          <div className="tcr-count">
            Ждут ответа: <b>{pending.length}</b>
          </div>
          {pending.length === 0 && (
            <p className="tcr-empty">
              Сейчас нет тендеров в статусах «Идет тендерная процедура» и
              «Подведение итогов» — в обычный вторник окно бы не появилось.
            </p>
          )}
          <ul className="tcr-list">
            {pending.map(t => (
              <li key={t.id} className="tcr-item">
                <Link to={`/tenders/${t.id}`} className="tcr-link" onClick={() => close(false)}>
                  {t.public_tender_number != null && <span className="tcr-num">№ {t.public_tender_number}</span>}
                  <span className="tcr-name">{t.work_description || 'Без наименования'}</span>
                </Link>
                <div className="tcr-meta">
                  <span className="tcr-object">{tenderObjectName(t)}</span>
                  <span className={`tcr-status${t.status === 'Подведение итогов' ? ' is-summing' : ''}`}>
                    {t.status}
                  </span>
                  {t.responsible_contact?.full_name && (
                    <span className="tcr-resp">{t.responsible_contact.full_name}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="tcr-actions">
          {forceOpen ? (
            <button type="button" className="btn-primary" onClick={() => close(false)}>Закрыть</button>
          ) : (
            <>
              <button type="button" className="btn-secondary" onClick={() => close(false)}>
                Напомнить сегодня ещё раз
              </button>
              <button type="button" className="btn-primary" onClick={() => close(true)}>
                Понятно, обзвоню
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
