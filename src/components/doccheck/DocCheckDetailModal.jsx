import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { db } from '../../api'
import S3DocumentList from '../S3DocumentList'
import DocCheckDiscussion from './DocCheckDiscussion'
import DocCheckSteps from './DocCheckSteps'
import { IconCheck, IconLink } from '../icons/ActionIcons'
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
  availableStatuses,
  avatarTone,
  cardTitle,
  dueState,
  fmtDocDate,
  fmtDocDateTime as fmtDateTime,
  initials,
  shownAssigneeIds,
} from '../../utils/docCheckHelpers'

// Карточка заявки: данные, шаги, обсуждение, файлы, история.
//
// Вкладка «Заявка» (03.11, решение пользователя: «более красивым и понятным, визуальное разделение, читаемый текст») —
// две колонки: слева примечание и документ, справа то, что меняется в работе (статус, исполнители, срок). Окно постоянной
// высоты: вкладки разной длины его не дёргают.
//
// Статус здесь тоже переключается — на телефоне доску не потаскаешь, а работать
// с заявкой надо. Список колонок один и тот же (availableStatuses), поэтому
// доска и карточка не разойдутся.
//
// Закрывается только «×» и «Закрыть», как карточка задачи: щелчок мимо окна (или
// выделение текста, отпущенное за его краем) уносил бы недописанное сообщение.

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
  if (field === 'created_at') return fmtDateTime(value) || value
  if (field === 'object_id') return ctx.objects.get(value) || 'объект удалён'
  if (field === 'counterparty_id') return ctx.counterparties.get(value) || 'контрагент удалён'
  return String(value)
}

// Раздел окна: заголовок полосой и содержимое. Разделы отделены друг от друга рамкой.
function Box({ title, aside, children }) {
  return (
    <section className="dc-box">
      <h4 className="dc-box-head">{title}{aside != null && <span className="dc-box-aside">{aside}</span>}</h4>
      {children}
    </section>
  )
}

// Строка «подпись — значение».
function Row({ label, className, children }) {
  return (
    <div className="dc-row-kv">
      <dt>{label}</dt>
      <dd className={className}>{children}</dd>
    </div>
  )
}

export default function DocCheckDetailModal({
  request, employees, objects, counterparties, canEdit, hasBoardFields, hasCardFields, currentUserId, deletion, refreshKey,
  onStatusChange, onEdit, onDelete, onClose, onCardCounts,
}) {
  const [tab, setTab] = useState('info')
  // Открывали файлы — после закрытия окна перечитать, сколько их у заявки.
  const docsOpened = useRef(false)
  if (tab === 'docs') docsOpened.current = true
  const close = () => onClose(docsOpened.current)
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

  // Контрагентов — тысячи: собираем только для вкладки истории, и один раз.
  const ctx = useMemo(() => (tab !== 'history' ? null : {
    employees,
    objects: new Map(objects.map(o => [o.id, o.name])),
    counterparties: new Map(counterparties.map(c => [c.id, c.name])),
  }), [tab, employees, objects, counterparties])
  const due = dueState(request)
  const people = shownAssigneeIds(request, employees)
    .map(id => ({ key: id, name: employeeName(employees, id), tone: avatarTone(id) }))
  const statuses = availableStatuses(hasBoardFields)
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
        <div className="modal-header dc-detail-head">
          <div className="dc-detail-heading">
            <h3>{cardTitle(request)}</h3>
            <p className="dc-detail-sub">
              <span className={`dc-status-chip ${DOC_CHECK_STATUS_CLASS[request.status] || ''}`}>
                {DOC_CHECK_STATUS_LABEL[request.status] || request.status}
              </span>
              <span>{DOC_TYPE_TITLE[request.doc_type]}</span>
              {request.archived_at && <span className="dc-detail-flag">в архиве</span>}
              {isDeleted && <span className="dc-detail-flag is-deleted">удалена</span>}
            </p>
          </div>
          <button className="modal-close" onClick={close} aria-label="Закрыть">×</button>
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
            <div className="dc-info">
              <div className="dc-info-col">
                {request.notes && (
                  <Box title="Примечание">
                    <p className="dc-box-text">{request.notes}</p>
                  </Box>
                )}

                <Box title="Документ">
                  <dl className="dc-kv">
                    <Row label="Объект">{request.objects?.name || '—'}</Row>
                    <Row label="Контрагент">{request.counterparties?.name || '—'}</Row>
                    <Row label="Номер">{request.doc_number || '—'}</Row>
                    <Row label="Дата документа" className="ui-num">{fmtDocDate(request.doc_date) || '—'}</Row>
                    {hasCardFields && (
                      <Row label="Письмо">
                        {mail ? (
                          <a className="dc-detail-mail" href={mail} target="_blank" rel="noopener noreferrer" title={request.email_link}>
                            <IconLink size={14} />Открыть письмо
                          </a>
                        ) : '—'}
                      </Row>
                    )}
                  </dl>
                </Box>

                {hasBoardFields && (
                  <Box title="Срок и приоритет">
                    <dl className="dc-kv">
                      <Row label="Срок" className={request.due_date ? `ui-num dc-due-text is-${due}` : 'ui-num'}>
                        {fmtDocDate(request.due_date) || '—'}{due === 'overdue' ? ' · срок прошёл' : ''}
                      </Row>
                      <Row label="Приоритет">{DOC_CHECK_PRIORITY_LABEL[request.priority] || '—'}</Row>
                      {request.labels?.length > 0 && (
                        <Row label="Метки" className="dc-card-chips">
                          {request.labels.map(l => <span key={l} className="dc-chip dc-chip--label">{l}</span>)}
                        </Row>
                      )}
                    </dl>
                  </Box>
                )}

                <Box title={isDeleted ? 'Создание и удаление' : 'Создание'}>
                  <dl className="dc-kv">
                    <Row label="Заявку создал">{request.created_by_name || '—'}</Row>
                    <Row label="Создана" className="ui-num">{fmtDateTime(request.created_at)}</Row>
                    {isDeleted && <Row label="Удалил">{deletion?.name || 'не записано'}</Row>}
                    {isDeleted && <Row label="Удалена" className="ui-num">{fmtDateTime(request.deleted_at)}</Row>}
                  </dl>
                </Box>
              </div>

              <div className="dc-info-col">
                <Box title="Статус">
                  <div className="dc-status-list">
                    {statuses.map(s => {
                      const current = request.status === s.value
                      return (
                        <button
                          key={s.value}
                          type="button"
                          aria-pressed={current}
                          className={`dc-status-opt ${DOC_CHECK_STATUS_CLASS[s.value]}${current ? ' is-current' : ''}`}
                          onClick={() => canEdit && !current && onStatusChange(request, s.value)}
                          disabled={!canEdit || isDeleted}
                        >
                          <span className="dc-status-dot" aria-hidden="true">{current && <IconCheck size={11} />}</span>
                          <span>{s.label}</span>
                        </button>
                      )
                    })}
                  </div>
                </Box>

                {hasBoardFields && (
                  <Box title="Исполнители" aside={people.length > 0 ? people.length : null}>
                    {people.length ? (
                      <ul className="dc-detail-people">
                        {people.map(p => (
                          <li key={p.key}>
                            <span className={`dc-avatar dc-avatar--t${p.tone}`} aria-hidden="true">{initials(p.name)}</span>
                            <span className="dc-person-name">{p.name}</span>
                          </li>
                        ))}
                      </ul>
                    ) : <p className="dc-box-text dc-box-empty">Не назначены</p>}
                  </Box>
                )}
              </div>
            </div>
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
                            <span className="dc-history-old">{DOC_CHECK_STATUS_LABEL[h.old_value] || h.old_value || '—'}</span>
                            {' → '}
                            {DOC_CHECK_STATUS_LABEL[h.new_value] || h.new_value || '—'}
                          </div>
                        ) : h.event_type === 'field_updated' ? (
                          <div className="dc-history-text">
                            <span className="dc-history-old">{historyValue(h.field_name, h.old_value, ctx)}</span>
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
            {/* Удалённую не правят и не удаляют снова: вторая запись истории подменила бы, кто её удалил. Вернуть — «Восстановить» в списке. */}
            {!isDeleted && <button type="button" className="btn-danger-soft" onClick={() => onDelete(request)}>Удалить</button>}
            {!isDeleted && <button type="button" className="btn-secondary" onClick={() => onEdit(request)}>Изменить</button>}
            <button type="button" className="btn-primary" onClick={close}>Закрыть</button>
          </div>
        )}
      </div>
    </div>
  )
}
