import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useRole } from '../../contexts/RoleContext'
import { ROLES } from '../../contexts/roleConstants'
import { ackAssignAlerts, ackDpAlerts, fetchAssignAlerts, fetchDpAlerts, isDpAlertRecipient } from '../../services/dpRequests'
import { DOC_CHECK_STATUS_LABEL } from '../../utils/docCheckHelpers'
import { formatAmount } from '../../utils/money'
import {
  DP_ALERTS_EVENT, DP_CREATED_EVENT, DP_ROLE_LABEL, isAssignAlertsMissing, newRequestsLabel, requestsLabel,
} from '../../utils/dpRequests'
import { IconDpRequest } from '../icons/NavIcons'
import './DpRequestAlert.css'

// Большое окно по заявкам на заключение ДП — на любой странице сайта. Два повода, одно окно (два окна поверх друг друга спорили бы
// за фокус):
//  • новая заявка (решение пользователя 05.11.2026: «большое всплывать») — у получателей из списка (dp_request_alert_recipients,
//    ведёт администратор на доске «Заявки на проверку ДП/ДС»). С 19.11.2026 заявка на заключение ДП — карточка этой доски
//    (doc_type 'dp_conclusion', миграция 20270219): уведомление заводит база при её создании. Номер — «ID» доски;
//  • назначение исполнителем (решение пользователя 23.11.2026: «большое уведомление … у ответственного при его назначении»;
//    ответственный — исполнитель заявки на доске, только «Заключение ДП»; миграция 20270225) — у юриста ОСП, которого добавили в
//    исполнители. Уведомление заводит база; сняли с заявки до прочтения — окна нет. Договор реестра база создаёт сама, когда заявку
//    берут в работу, — окно даёт его ID и ссылку.
//
// Уведомление — строка в базе у каждого человека, поэтому его не потерять: кто был не на сайте, увидит окно при входе, на любом
// компьютере. Окно закрывается только кнопкой: щелчок мимо и Escape его не гасят, иначе заявку можно пропустить случайно. Пропало
// соединение или не записалось «прочитано» — окно вернётся при следующей проверке.
//
// Опрашивают только получатель и юрист ОСП (исполнителем назначают только юриста), только открытая вкладка. Остальные — один запрос
// при входе и раз в 10 минут: вдруг их добавили в получатели. Функций окна исполнителю нет (база раньше 20270225) — не спрашиваем
// до перезагрузки.
const POLL_MS = 30_000
const RECIPIENT_RECHECK_MS = 10 * 60_000

export default function DpRequestAlert() {
  const { user, role, canView, previewActive } = useRole()
  const userId = user?.id || null
  const isLawyer = role === ROLES.LAWYER
  const navigate = useNavigate()
  const canOpen = canView('doc_check_requests')
  const canOpenContract = canView('contracts')
  const [alerts, setAlerts] = useState([])
  const [assigned, setAssigned] = useState([])
  const recipient = useRef({ yes: false, checkedAt: 0 })
  const knownIds = useRef(new Set())
  const closeRef = useRef(null)
  // Закрытые на этой вкладке: ответ на запрос, ушедший до закрытия, их не вернёт.
  const hiddenIds = useRef(new Set())
  const hiddenAssigned = useRef(new Set())
  const assignOff = useRef(false)

  const checkNew = useCallback(async () => {
    try {
      if (Date.now() - recipient.current.checkedAt >= RECIPIENT_RECHECK_MS) {
        recipient.current = { yes: await isDpAlertRecipient(userId), checkedAt: Date.now() }
      }
      if (!recipient.current.yes) {
        setAlerts([])
        return
      }
      const rows = await fetchDpAlerts()
      const visible = rows.filter((r) => !hiddenIds.current.has(r.request_id))
      if (visible.some((r) => !knownIds.current.has(r.request_id))) {
        window.dispatchEvent(new CustomEvent(DP_ALERTS_EVENT))
      }
      knownIds.current = new Set(visible.map((r) => r.request_id))
      setAlerts(visible)
    } catch (err) {
      console.warn('Уведомления о заявках на ДП не загружены:', err?.message || err)
    }
  }, [userId])

  const checkAssigned = useCallback(async () => {
    if (!isLawyer || assignOff.current) {
      setAssigned([])
      return
    }
    try {
      const rows = await fetchAssignAlerts()
      setAssigned(rows.filter((r) => !hiddenAssigned.current.has(r.request_id)))
    } catch (err) {
      if (isAssignAlertsMissing(err)) {
        assignOff.current = true
        return
      }
      console.warn('Уведомления о назначении исполнителем не загружены:', err?.message || err)
    }
  }, [isLawyer])

  const check = useCallback(async () => {
    if (!userId || document.visibilityState !== 'visible') return
    await Promise.all([checkNew(), checkAssigned()])
  }, [userId, checkNew, checkAssigned])

  useEffect(() => {
    // Просмотр от имени роли — чужие глаза: своё окно не показываем и «прочитано» не ставим.
    if (!userId || previewActive) {
      setAlerts([])
      setAssigned([])
      return undefined
    }
    recipient.current = { yes: false, checkedAt: 0 }
    check()
    const timer = setInterval(check, POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') check() }
    // Только что создали заявку: человек может сам быть получателем, а в списке его могли и добавить.
    const onCreated = () => { recipient.current.checkedAt = 0; check() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener(DP_CREATED_EVENT, onCreated)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener(DP_CREATED_EVENT, onCreated)
    }
  }, [userId, previewActive, check])

  const open = alerts.length > 0 || assigned.length > 0
  useEffect(() => {
    if (open) closeRef.current?.focus()
  }, [open])

  // Погасить: новые заявки и назначения — каждые своей функцией. Не записалось — при следующей проверке окно вернётся: лучше
  // показать ещё раз, чем потерять заявку.
  const dismiss = useCallback((newIds, assignedIds) => {
    if (newIds.length) {
      for (const id of newIds) hiddenIds.current.add(id)
      setAlerts((prev) => prev.filter((a) => !newIds.includes(a.request_id)))
      ackDpAlerts(newIds).catch((err) => {
        for (const id of newIds) hiddenIds.current.delete(id)
        console.warn('Отметка о прочтении заявки на ДП не сохранилась:', err?.message || err)
      })
    }
    if (assignedIds.length) {
      for (const id of assignedIds) hiddenAssigned.current.add(id)
      setAssigned((prev) => prev.filter((a) => !assignedIds.includes(a.request_id)))
      ackAssignAlerts(assignedIds).catch((err) => {
        for (const id of assignedIds) hiddenAssigned.current.delete(id)
        console.warn('Отметка о прочтении назначения не сохранилась:', err?.message || err)
      })
    }
  }, [])

  // Переход гасит заявку в обоих списках: окно не должно остаться поверх открытой карточки.
  const leaveFor = (requestId, to) => {
    dismiss(alerts.some((a) => a.request_id === requestId) ? [requestId] : [],
      assigned.some((a) => a.request_id === requestId) ? [requestId] : [])
    navigate(to)
  }
  const openRequest = (requestId) => leaveFor(requestId, `/doc-check-requests?request=${encodeURIComponent(requestId)}`)
  const openContract = (requestId, contractId) => leaveFor(requestId, `/contracts/${encodeURIComponent(contractId)}`)

  // Фокус не уходит за окно: щелчок мимо его не снимает, Tab ходит только по кнопкам окна.
  const keepFocus = (e) => {
    if (e.key !== 'Tab') return
    const buttons = [...e.currentTarget.querySelectorAll('button')]
    const at = buttons.indexOf(document.activeElement)
    e.preventDefault()
    buttons[(at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
  }

  if (!open) return null
  const both = alerts.length > 0 && assigned.length > 0
  const title = both
    ? 'Заявки на заключение ДП'
    : assigned.length > 0
      ? (assigned.length === 1 ? 'Вас назначили исполнителем' : `Вас назначили исполнителем: ${requestsLabel(assigned.length)}`)
      : (alerts.length === 1 ? 'Новая заявка на заключение ДП' : `Заявки на заключение ДП: ${newRequestsLabel(alerts.length)}`)
  const lead = both
    ? 'Вас назначили исполнителем и есть новые заявки — всё в «Заявках на проверку ДП/ДС».'
    : assigned.length > 0
      ? `${assigned.length === 1 ? 'Заявка' : 'Заявки'} на заключение ДП в «Заявках на проверку ДП/ДС». Договор в «Реестре по договорам» создаётся сам, когда заявку берут в работу.`
      : 'Создана заявка на договор подряда — она в «Заявках на проверку ДП/ДС», колонка «Новые заявки».'

  return createPortal(
    <div className="dpa-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) e.preventDefault() }}>
      <div className="dpa-dialog" role="alertdialog" aria-modal="true" aria-labelledby="dpa-title" onKeyDown={keepFocus}>
        <header className="dpa-head">
          <span className="dpa-icon"><IconDpRequest /></span>
          <div>
            <h2 id="dpa-title">{title}</h2>
            <p>{lead}</p>
          </div>
        </header>
        <div className="dpa-list">
          {assigned.length > 0 && both && <h3 className="dpa-section">Вы — исполнитель</h3>}
          {assigned.map((a) => (
            <article key={`as-${a.request_id}`} className="dpa-card dpa-card--assigned" data-kind="assigned">
              <div className="dpa-card-title">
                {a.request_number != null && <span className="dpa-num">ID {a.request_number}</span>}
                <span className="dpa-object">{a.object_name || 'Объект не указан'}</span>
                <span className="dpa-actions">
                  {canOpenContract && a.contract_id && (
                    <button type="button" className="dpa-open" onClick={() => openContract(a.request_id, a.contract_id)}>Открыть договор</button>
                  )}
                  {canOpen && (
                    <button type="button" className="dpa-open" onClick={() => openRequest(a.request_id)}>Открыть заявку</button>
                  )}
                </span>
              </div>
              <dl className="dpa-facts">
                {a.counterparty_name && (
                  <>
                    <dt>Контрагент</dt>
                    <dd>{a.counterparty_name}</dd>
                  </>
                )}
                <dt>Статус</dt>
                <dd>{DOC_CHECK_STATUS_LABEL[a.status] || a.status || '—'}</dd>
                <dt>Договор</dt>
                <dd>
                  {a.contract_display_id != null
                    ? <>в «Реестре по договорам», ID {a.contract_display_id}</>
                    : a.status === 'new'
                      ? 'появится в «Реестре по договорам», когда заявку возьмут в работу'
                      : 'в реестре не создан'}
                </dd>
                {a.notes && (
                  <>
                    <dt>Примечание</dt>
                    <dd className="dpa-reason">{a.notes}</dd>
                  </>
                )}
                {a.created_by_name && (
                  <>
                    <dt>Создал(а)</dt>
                    <dd>{a.created_by_name}</dd>
                  </>
                )}
                {a.assigned_by_name && (
                  <>
                    <dt>Назначил(а)</dt>
                    <dd>{a.assigned_by_name}</dd>
                  </>
                )}
              </dl>
            </article>
          ))}
          {alerts.length > 0 && both && <h3 className="dpa-section">Новые заявки</h3>}
          {alerts.map((a) => (
            <article key={a.request_id} className="dpa-card" data-kind="new">
              <div className="dpa-card-title">
                {a.request_number != null && <span className="dpa-num">ID {a.request_number}</span>}
                <span className="dpa-object">{a.object_name || 'Объект не указан'}</span>
                {canOpen && (
                  <button type="button" className="dpa-open" onClick={() => openRequest(a.request_id)}>Открыть заявку</button>
                )}
              </div>
              <dl className="dpa-facts">
                {a.contract_title && (
                  <>
                    <dt>Договор</dt>
                    <dd>{a.contract_title}</dd>
                  </>
                )}
                {a.amount != null && (
                  <>
                    <dt>Сумма</dt>
                    <dd className="dpa-amount">{formatAmount(Number(a.amount))} ₽</dd>
                  </>
                )}
                {a.responsible_name && (
                  <>
                    <dt>Ответственный</dt>
                    <dd>
                      {a.responsible_name}
                      {DP_ROLE_LABEL[a.responsible_role] && <small> · {DP_ROLE_LABEL[a.responsible_role]}</small>}
                    </dd>
                  </>
                )}
                {a.reason && (
                  <>
                    <dt>Примечание</dt>
                    <dd className="dpa-reason">{a.reason}</dd>
                  </>
                )}
                {a.created_by_name && (
                  <>
                    <dt>Создал(а)</dt>
                    <dd>{a.created_by_name}</dd>
                  </>
                )}
              </dl>
            </article>
          ))}
        </div>
        <footer className="dpa-foot">
          <button
            ref={closeRef}
            type="button"
            className="dpa-close"
            onClick={() => dismiss(alerts.map((a) => a.request_id), assigned.map((a) => a.request_id))}
          >
            Понятно
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
