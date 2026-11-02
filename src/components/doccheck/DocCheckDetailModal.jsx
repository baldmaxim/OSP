import { useCallback, useEffect, useRef, useState } from 'react'
import { db } from '../../api'
import S3DocumentList from '../S3DocumentList'
import DocCheckAvatars from './DocCheckAvatars'
import DocCheckDiscussion from './DocCheckDiscussion'
import DocCheckSteps from './DocCheckSteps'
import { IconLink } from '../icons/ActionIcons'
import { employeeName } from '../../services/employees'
import { fetchCardDetails } from '../../services/docCheckCard'
import { safeHttpUrl } from '../../utils/publicTenders'
import {
  DOC_CHECK_COLOR_LABEL,
  DOC_CHECK_PRIORITY_LABEL,
  DOC_CHECK_STATUS_CLASS,
  DOC_CHECK_STATUS_LABEL,
  DOC_TYPE_LABEL,
  DOC_TYPE_TITLE,
  FIELD_LABEL,
  assigneeNames,
  availableStatuses,
  cardTitle,
  dueState,
  fmtDocDate,
} from '../../utils/docCheckHelpers'

// Карточка заявки: данные, шаги, обсуждение, файлы, история.
//
// Статус здесь тоже переключается — на телефоне доску не потаскаешь, а работать
// с заявкой надо. Список колонок один и тот же (availableStatuses), поэтому
// доска и карточка не разойдутся.
//
// Закрывается только «×» и «Закрыть», как карточка задачи: щелчок мимо окна (или
// выделение текста, отпущенное за его краем) уносил бы недописанное сообщение.

const fmtDateTime = (v) => (v ? new Date(v).toLocaleString('ru-RU', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '')

const EVENT_LABEL = {
  created: 'Заявка создана',
  status_changed: 'Смена статуса',
  field_updated: 'Изменение поля',
  soft_deleted: 'Заявка удалена',
  restored: 'Заявка восстановлена',
  archived: 'Заявка в архиве',
  unarchived: 'Заявка возвращена из архива',
}

// Значение поля в истории — словами, а не кодом базы.
function historyValue(field, value, ctx) {
  if (value == null || value === '' || (Array.isArray(value) && !value.length)) return '—'
  if (field === 'assignee_ids') return value.map(id => employeeName(ctx.employees, id)).join(', ')
  if (field === 'labels' || field === 'manual_assignees') return value.join(', ')
  if (field === 'priority') return DOC_CHECK_PRIORITY_LABEL[value] || value
  if (field === 'color') return DOC_CHECK_COLOR_LABEL[value] || value
  if (field === 'doc_type') return DOC_TYPE_LABEL[value] || value
  if (field === 'due_date' || field === 'doc_date') return fmtDocDate(value) || value
  if (field === 'object_id') return ctx.objects.get(value) || 'объект удалён'
  if (field === 'counterparty_id') return ctx.counterparties.get(value) || 'контрагент удалён'
  return String(value)
}

export default function DocCheckDetailModal({
  request, employees, objects, counterparties, canEdit, hasBoardFields, hasCardFields, currentUserId, refreshKey,
  onStatusChange, onEdit, onDelete, onClose, onCardCounts,
}) {
  const [tab, setTab] = useState('info')
  const [history, setHistory] = useState([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [steps, setSteps] = useState([])
  const [comments, setComments] = useState([])
  const [cardState, setCardState] = useState('loading') // loading | ready | error

  // Шаги и сообщения нужны сразу: их число — на вкладках. Перечитываются и при возврате на вкладку браузера (refreshKey):
  // правки коллег. Ответ, прочитанный до своей правки, отбрасывается — иначе вернул бы прежний список.
  const loadSeq = useRef(0)
  const loadCard = useCallback(async () => {
    const seq = ++loadSeq.current
    try {
      const details = await fetchCardDetails(request.id)
      if (seq !== loadSeq.current) return
      setSteps(details.steps)
      setComments(details.comments)
      setCardState('ready')
    } catch (err) {
      if (seq !== loadSeq.current) return
      console.warn('Не удалось загрузить шаги и обсуждение заявки:', err.message)
      setCardState(prev => (prev === 'ready' ? prev : 'error'))
    }
  }, [request.id])
  useEffect(() => { if (hasCardFields) loadCard() }, [hasCardFields, loadCard, refreshKey])

  const changeSteps = useCallback((update) => { loadSeq.current += 1; setSteps(update) }, [])
  const changeComments = useCallback((update) => { loadSeq.current += 1; setComments(update) }, [])

  // Счётчики на карточке доски — сразу, без перечитывания всей доски.
  useEffect(() => {
    if (cardState !== 'ready') return
    onCardCounts(request.id, {
      stepsTotal: steps.length,
      stepsDone: steps.filter(s => s.is_done).length,
      commentsCount: comments.length,
    })
  }, [cardState, steps, comments, request.id, onCardCounts])

  // История нужна редко — грузим только при открытии своей вкладки.
  useEffect(() => {
    if (tab !== 'history' || historyLoaded) return
    let cancelled = false
    const load = async () => {
      try {
        const { data, error } = await db
          .from('doc_check_request_audit_log')
          .select('*')
          .eq('request_id', request.id)
          .order('changed_at', { ascending: false })
          .order('id', { ascending: true })
        if (error) throw error
        if (!cancelled) setHistory(data || [])
      } catch (err) {
        console.warn('Не удалось загрузить историю заявки:', err.message)
      } finally {
        if (!cancelled) setHistoryLoaded(true)
      }
    }
    load()
    return () => { cancelled = true }
  }, [tab, historyLoaded, request.id])

  const ctx = {
    employees,
    objects: new Map(objects.map(o => [o.id, o.name])),
    counterparties: new Map(counterparties.map(c => [c.id, c.name])),
  }
  const due = dueState(request)
  const people = assigneeNames(request, id => employeeName(employees, id))
  const mail = safeHttpUrl(request.email_link)
  const isDeleted = !!request.deleted_at
  const isAssignee = !!currentUserId && (request.assignee_ids || []).includes(currentUserId)
  const stepsDone = steps.filter(s => s.is_done).length

  const tabs = [
    { key: 'info', label: 'Заявка' },
    ...(hasCardFields ? [
      { key: 'steps', label: 'Шаги', count: steps.length > 0 ? `${stepsDone}/${steps.length}` : null },
      { key: 'discussion', label: 'Обсуждение', count: comments.length > 0 ? comments.length : null },
    ] : []),
    { key: 'docs', label: 'Документы' },
    { key: 'history', label: 'История' },
  ]

  const cardUnavailable = cardState === 'loading'
    ? <p className="dc-muted">Загрузка…</p>
    : (
      <p className="dc-muted">
        Не удалось загрузить.{' '}
        <button type="button" className="dc-retry" onClick={loadCard}>Повторить</button>
      </p>
    )

  return (
    <div className="modal-overlay">
      <div className="modal dc-detail-modal" role="dialog" aria-modal="true" aria-label={cardTitle(request)}>
        <div className="modal-header">
          <div>
            <h3>{cardTitle(request)}</h3>
            <p className="dc-detail-sub">
              {DOC_TYPE_TITLE[request.doc_type]}
              {request.archived_at ? ' · в архиве' : ''}
            </p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <div className="dc-detail-tabs" role="tablist">
          {tabs.map(t => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`dc-detail-tab${tab === t.key ? ' is-active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              {t.count != null && <span className="dc-tab-count">{t.count}</span>}
            </button>
          ))}
        </div>

        <div className="dc-detail-body">
          {tab === 'info' && (
            <>
              <dl className="dc-detail-grid">
                <div><dt>Объект</dt><dd>{request.objects?.name || '—'}</dd></div>
                <div><dt>Контрагент</dt><dd>{request.counterparties?.name || '—'}</dd></div>
                <div><dt>Номер</dt><dd>{request.doc_number || '—'}</dd></div>
                <div><dt>Дата документа</dt><dd>{fmtDocDate(request.doc_date) || '—'}</dd></div>
                {hasCardFields && (
                  <div className="dc-detail-wide">
                    <dt>Письмо</dt>
                    <dd>
                      {mail ? (
                        <a className="dc-detail-mail" href={mail} target="_blank" rel="noopener noreferrer" title={request.email_link}>
                          <IconLink size={14} />Открыть письмо
                        </a>
                      ) : '—'}
                    </dd>
                  </div>
                )}
                {hasBoardFields && (
                  <>
                    <div className="dc-detail-wide">
                      <dt>Исполнители</dt>
                      <dd className="dc-detail-people">
                        {people.length ? (
                          <>
                            <DocCheckAvatars ids={request.assignee_ids} manual={request.manual_assignees} employees={employees} max={6} />
                            <span>{people.join(', ')}</span>
                          </>
                        ) : 'Не назначены'}
                      </dd>
                    </div>
                    <div>
                      <dt>Срок</dt>
                      <dd className={request.due_date ? `dc-due-text is-${due}` : ''}>
                        {fmtDocDate(request.due_date) || '—'}{due === 'overdue' ? ' · срок прошёл' : ''}
                      </dd>
                    </div>
                    <div><dt>Приоритет</dt><dd>{DOC_CHECK_PRIORITY_LABEL[request.priority] || '—'}</dd></div>
                    {request.labels?.length > 0 && (
                      <div className="dc-detail-wide">
                        <dt>Метки</dt>
                        <dd className="dc-card-chips">
                          {request.labels.map(l => <span key={l} className="dc-chip dc-chip--label">{l}</span>)}
                        </dd>
                      </div>
                    )}
                  </>
                )}
                <div><dt>Заявку создал</dt><dd>{request.created_by_name || '—'}</dd></div>
                <div><dt>Создана</dt><dd>{fmtDateTime(request.created_at)}</dd></div>
              </dl>

              {request.notes && (
                <div className="dc-detail-notes">
                  <h4>Примечание</h4>
                  <p>{request.notes}</p>
                </div>
              )}

              <div className="dc-detail-status">
                <h4>Статус</h4>
                <div className="dc-status-list">
                  {availableStatuses(hasBoardFields).map(s => (
                    <button
                      key={s.value}
                      type="button"
                      aria-pressed={request.status === s.value}
                      className={`dc-status-opt ${DOC_CHECK_STATUS_CLASS[s.value]}${request.status === s.value ? ' is-current' : ''}`}
                      onClick={() => canEdit && request.status !== s.value && onStatusChange(request, s.value)}
                      disabled={!canEdit}
                    >{s.label}</button>
                  ))}
                </div>
              </div>
            </>
          )}

          {tab === 'steps' && (cardState !== 'ready' ? cardUnavailable : (
            <DocCheckSteps
              requestId={request.id}
              steps={steps}
              onStepsChange={changeSteps}
              onReload={loadCard}
              canArrange={canEdit && !isDeleted}
              canTick={(canEdit || isAssignee) && !isDeleted}
            />
          ))}

          {tab === 'discussion' && (cardState !== 'ready' ? cardUnavailable : (
            <DocCheckDiscussion
              requestId={request.id}
              comments={comments}
              onCommentsChange={changeComments}
              currentUserId={currentUserId}
              canWrite={!isDeleted}
            />
          ))}

          {tab === 'docs' && (
            <S3DocumentList
              ownerType="doc_check_request"
              ownerId={request.id}
              title="Файлы документа"
              canEdit={canEdit}
            />
          )}

          {tab === 'history' && (
            !historyLoaded ? <p className="dc-muted">Загрузка…</p>
              : history.length === 0 ? <p className="dc-muted">Изменений пока нет</p>
                : (
                  <ul className="dc-history">
                    {history.map(h => (
                      <li key={h.id}>
                        <div className="dc-history-head">
                          <span className="dc-history-event">
                            {h.event_type === 'field_updated' && FIELD_LABEL[h.field_name]
                              ? FIELD_LABEL[h.field_name]
                              : (EVENT_LABEL[h.event_type] || h.event_type)}
                          </span>
                          <span className="dc-history-date">{fmtDateTime(h.changed_at)}</span>
                        </div>
                        {h.event_type === 'status_changed' ? (
                          <div className="dc-history-text">
                            {DOC_CHECK_STATUS_LABEL[h.old_value] || h.old_value || '—'}
                            {' → '}
                            {DOC_CHECK_STATUS_LABEL[h.new_value] || h.new_value || '—'}
                          </div>
                        ) : h.event_type === 'field_updated' ? (
                          <div className="dc-history-text">
                            {historyValue(h.field_name, h.old_value, ctx)}
                            {' → '}
                            {historyValue(h.field_name, h.new_value, ctx)}
                          </div>
                        ) : h.description ? (
                          <div className="dc-history-text">{h.description}</div>
                        ) : null}
                        <div className="dc-history-who">{h.changed_by_name || 'Неизвестный пользователь'}</div>
                      </li>
                    ))}
                  </ul>
                )
          )}
        </div>

        {canEdit && (
          <div className="dc-detail-actions">
            <button type="button" className="btn-danger-soft" onClick={() => onDelete(request)}>Удалить</button>
            <button type="button" className="btn-secondary" onClick={() => onEdit(request)}>Изменить</button>
            <button type="button" className="btn-primary" onClick={onClose}>Закрыть</button>
          </div>
        )}
      </div>
    </div>
  )
}
