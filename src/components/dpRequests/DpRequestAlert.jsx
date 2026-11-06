import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useRole } from '../../contexts/RoleContext'
import { ackDpAlerts, fetchDpAlerts, isDpAlertRecipient } from '../../services/dpRequests'
import { formatAmount } from '../../utils/money'
import {
  DP_ALERTS_EVENT, DP_CREATED_EVENT, DP_REQUEST_PARAM, DP_ROLE_LABEL, newRequestsLabel,
} from '../../utils/dpRequests'
import { IconDpRequest } from '../icons/NavIcons'
import './DpRequestAlert.css'

// Большое окно о новой заявке на ДП (решение пользователя 05.11.2026: «большое всплывать») — на любой странице сайта, только у
// получателей из списка (dp_request_alert_recipients, ведёт администратор на странице заявок).
//
// Уведомление — строка в базе у каждого получателя, поэтому его не потерять: кто был не на сайте, увидит окно при входе, на любом
// компьютере. Окно закрывается только кнопкой: щелчок мимо и Escape его не гасят, иначе заявку можно пропустить случайно. Пропало
// соединение или не записалось «прочитано» — окно вернётся при следующей проверке.
//
// Опрашивает только получатель и только открытая вкладка. Остальные — один запрос при входе и раз в 10 минут: вдруг их добавили.
const POLL_MS = 30_000
const RECIPIENT_RECHECK_MS = 10 * 60_000

export default function DpRequestAlert() {
  const { user, canView, previewActive } = useRole()
  const userId = user?.id || null
  const navigate = useNavigate()
  const canOpen = canView('dp_requests')
  const [alerts, setAlerts] = useState([])
  const recipient = useRef({ yes: false, checkedAt: 0 })
  const knownIds = useRef(new Set())
  const closeRef = useRef(null)
  const hiddenIds = useRef(new Set()) // закрытые на этой вкладке: ответ на запрос, ушедший до закрытия, их не вернёт

  const check = useCallback(async () => {
    if (!userId || document.visibilityState !== 'visible') return
    try {
      if (Date.now() - recipient.current.checkedAt >= RECIPIENT_RECHECK_MS) {
        recipient.current = { yes: await isDpAlertRecipient(userId), checkedAt: Date.now() }
      }
      if (!recipient.current.yes) return
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

  useEffect(() => {
    // Просмотр от имени роли — чужие глаза: своё окно не показываем и «прочитано» не ставим.
    if (!userId || previewActive) {
      setAlerts([])
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

  const open = alerts.length > 0
  useEffect(() => {
    if (open) closeRef.current?.focus()
  }, [open])

  const dismiss = useCallback((requestIds) => {
    for (const id of requestIds) hiddenIds.current.add(id)
    setAlerts((prev) => prev.filter((a) => !requestIds.includes(a.request_id)))
    ackDpAlerts(requestIds).catch((err) => {
      // Не записалось — при следующей проверке окно вернётся: лучше показать ещё раз, чем потерять заявку.
      for (const id of requestIds) hiddenIds.current.delete(id)
      console.warn('Отметка о прочтении заявки на ДП не сохранилась:', err?.message || err)
    })
  }, [])

  const openRequest = (requestId) => {
    dismiss([requestId])
    navigate(`/dp-requests?${DP_REQUEST_PARAM}=${requestId}`)
  }

  // Фокус не уходит за окно: щелчок мимо его не снимает, Tab ходит только по кнопкам окна.
  const keepFocus = (e) => {
    if (e.key !== 'Tab') return
    const buttons = [...e.currentTarget.querySelectorAll('button')]
    const at = buttons.indexOf(document.activeElement)
    e.preventDefault()
    buttons[(at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
  }

  if (!open) return null
  return createPortal(
    <div className="dpa-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) e.preventDefault() }}>
      <div className="dpa-dialog" role="alertdialog" aria-modal="true" aria-labelledby="dpa-title" onKeyDown={keepFocus}>
        <header className="dpa-head">
          <span className="dpa-icon"><IconDpRequest /></span>
          <div>
            <h2 id="dpa-title">{alerts.length === 1 ? 'Новая заявка на ДП' : `Заявки на ДП: ${newRequestsLabel(alerts.length)}`}</h2>
            <p>Создана заявка на договор подряда.</p>
          </div>
        </header>
        <div className="dpa-list">
          {alerts.map((a) => (
            <article key={a.request_id} className="dpa-card">
              <div className="dpa-card-title">
                <span className="dpa-num">№ {a.request_number}</span>
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
          <button ref={closeRef} type="button" className="dpa-close" onClick={() => dismiss(alerts.map((a) => a.request_id))}>
            Понятно
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
