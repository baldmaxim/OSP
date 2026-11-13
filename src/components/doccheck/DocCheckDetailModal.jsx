import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { db } from '../../api'
import { fetchAllRows } from '../../utils/fetchAllRows'
import FilterDropdown from '../FilterDropdown'
import DocCheckDiscussion from './DocCheckDiscussion'
import DocCheckFiles from './DocCheckFiles'
import { IconCheck, IconLink } from '../icons/ActionIcons'
import { IconUser } from '../icons/ToolbarIcons'
import { employeeName } from '../../services/employees'
import { fetchComments, fetchRequestAuthor, takePrefetched } from '../../services/docCheckCard'
import { safeHttpUrl } from '../../utils/publicTenders'
import { talkTimes } from '../../utils/docCheckTalkRead'
import {
  NO_CARD_COUNTS,
  DOC_CHECK_COLOR_LABEL,
  DOC_CHECK_PRIORITY_LABEL,
  DOC_CHECK_STATUS_CLASS,
  DOC_CHECK_STATUS_LABEL,
  DOC_TYPE_LABEL,
  DOC_TYPE_TITLE,
  FIELD_LABEL,
  assigneeStaffOptions,
  availableStatuses,
  avatarTone,
  cardCountsById,
  cardTitle,
  dueState,
  fmtDocDate,
  fmtDocDateTime as fmtDateTime,
  fileCategoryLabel,
  formatBytes,
  initials,
  postedChatFileIds,
  psdcStaffOptions,
  requestIdLabel,
  shownAssigneeIds,
  shownPsdcResponsible,
} from '../../utils/docCheckHelpers'

// Карточка заявки: две вкладки — «Общая» и «История» (11.11.2026, решение пользователя: шагов нет, «Документы» и «Обсуждение» —
// не вкладки, а части «Общей»).
//
// «Общая»: слева сведения — две колонки разделов (03.11: «визуальное разделение, читаемый текст»). В левой — примечание,
// «Документы» и срок: раздел «Документы» — объект, контрагент, номер и дата, под ними файлы двумя частями, «Понятийное
// соглашение» и «Загружаемые документы» (DocCheckFiles; прежняя вкладка «Документы»). Файлы меняет право правки раздела, а свою
// заявку, пока она в «Новых», — и её автор с правом создания (рукстрой, экономист объекта; 12.11.2026): так пускают база
// (s3_documents_doc_check_guard) и osp-api, отдел взял заявку в работу — автор пишет в обсуждение. В правой — то, что меняется в работе:
// статус, исполнители, — и создание. Справа от сведений — переписка (DocCheckDiscussion), со своей прокруткой. Окно постоянной
// высоты: вкладки разной длины его не дёргают.
//
// Исполнителей назначают прямо здесь, выбором в разделе «Исполнители» (11.11.2026: «сразу, без изменения заявки») — каждая
// отметка сразу пишется в заявку и в историю, как смена исполнителей в форме; право — то же, правка раздела.
//
// Статус здесь тоже переключается — на телефоне доску не потаскаешь, а работать
// с заявкой надо. Список колонок один и тот же (availableStatuses), поэтому
// доска и карточка не разойдутся.
//
// Закрывается только «×» и «Закрыть», как карточка задачи: щелчок мимо окна (или
// выделение текста, отпущенное за его краем) уносил бы недописанное сообщение.
//
// 12.11.2026 (решения пользователя; миграция 20270216, hasChatFields): окно больше, переписка шире; файлы в переписке
// (DocCheckDiscussion); под исполнителями — «Согласование ПСДЦ»: ответственный — один из экономистов ОСП, необязателен,
// назначает право правки раздела (юрист ОСП) — сразу, без формы, как исполнителей. Историю заявки пишет база: файлы — кто
// прикрепил, открепил, переименовал, перенёс; файл, брошенный мимо частей окна, браузер не открывает вместо заявки.

const EVENT_LABEL = {
  created: 'Заявка создана',
  status_changed: 'Смена статуса',
  field_updated: 'Изменение поля',
  soft_deleted: 'Заявка удалена',
  restored: 'Заявка восстановлена',
  archived: 'Заявка в архиве',
  unarchived: 'Заявка возвращена из архива',
  file_attached: 'Файл прикреплён',
  file_removed: 'Файл откреплён',
  file_renamed: 'Файл переименован',
  file_moved: 'Файл перенесён',
  file_replaced: 'Файл заменён',
}
const FILE_EVENTS = new Set(['file_attached', 'file_removed', 'file_renamed', 'file_moved', 'file_replaced'])

// Файл, брошенный мимо частей окна (документы, переписка), браузер не открывает вместо заявки: недописанное не теряется.
const withFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files')
const blockStrayDrop = {
  onDragOver: (e) => { if (withFiles(e) && !e.defaultPrevented) { e.preventDefault(); e.dataTransfer.dropEffect = 'none' } },
  onDrop: (e) => { if (withFiles(e) && !e.defaultPrevented) e.preventDefault() },
}

// Строка истории о файле: что и где (описание пишет база), размер — если он есть.
function fileHistoryText(h) {
  const file = h.new_value || h.old_value || {}
  const size = h.event_type === 'file_attached' || h.event_type === 'file_removed' ? formatBytes(file.size_bytes) : ''
  const text = h.description || [fileCategoryLabel(file.category), file.file_name].filter(Boolean).join(': ')
  return size ? `${text} · ${size}` : text
}

// Значение поля в истории — словами, а не кодом базы.
function historyValue(field, value, ctx) {
  if (value == null || value === '' || (Array.isArray(value) && !value.length)) return '—'
  if (field === 'assignee_ids') return value.map(id => employeeName(ctx.employees, id)).join(', ')
  if (field === 'psdc_responsible_id') return employeeName(ctx.employees, value)
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
function Box({ title, aside, className = '', children }) {
  return (
    <section className={`dc-box ${className}`.trim()}>
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
  request, employees, objects, counterparties, canEdit, canCreateOwn = false, hasBoardFields, hasCardFields, hasChatFields = false, currentUserId, deletion,
  refreshKey, onStatusChange, onAssign, onPsdcAssign, onEdit, onDelete, onClose, onCardCounts,
  talkReadMark = Number.POSITIVE_INFINITY, onTalkSeen,
}) {
  const [tab, setTab] = useState('general')
  // Граница «прочитано» на момент открытия окна (окно у каждой заявки своё — key в DocCheckRequestsPage): сообщения коллег
  // позже неё подсвечены, пока окно открыто, хотя заявка уже отмечена прочитанной. Ответил сам — всё до ответа прочитано.
  const [openReadMark] = useState(talkReadMark)
  // Файлы меняли — после закрытия окна перечитать, сколько их у заявки (скрепка на карточке доски).
  const filesChanged = useRef(false)
  const markFilesChanged = useCallback(() => { filesChanged.current = true }, [])
  const close = () => onClose(filesChanged.current)

  // Автор своей заявки в «Новых» (право создания без права правки) меняет её файлы. Чья заявка — спрашиваем у базы: на доске
  // автора нет. Не узнали (нет колонки, сбой) — только просмотр, как раньше. Заявку взяли в работу при открытом окне — база
  // откажет, причина придёт сообщением.
  const authorCandidate = !canEdit && canCreateOwn && !!currentUserId && request.status === 'new' && !request.deleted_at
  const [authorId, setAuthorId] = useState(null)
  useEffect(() => {
    if (!authorCandidate) return undefined
    let cancelled = false
    fetchRequestAuthor(request.id)
      .then(id => { if (!cancelled) setAuthorId(id) })
      .catch(err => console.warn('Не удалось узнать автора заявки:', err.message))
    return () => { cancelled = true }
  }, [authorCandidate, request.id])
  const authorFiles = authorCandidate && authorId === currentUserId
  const [history, setHistory] = useState([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [comments, setComments] = useState([])
  const [cardState, setCardState] = useState('loading') // loading | ready | error

  // Сообщения — сразу: переписка стоит на «Общей». Перечитываются и при возврате на вкладку браузера (refreshKey): сообщения
  // коллег. Ответ, прочитанный до своего сообщения, отбрасывается — иначе вернул бы прежний список.
  const loadSeq = useRef(0)
  const loadCard = useCallback(async () => {
    const seq = ++loadSeq.current
    try {
      // Нажали на карточку — переписка уже читается (prefetchCard); иначе — свой запрос.
      const rows = await (takePrefetched(request.id, 'comments') || fetchComments(request.id))
      if (seq !== loadSeq.current) return
      setComments(rows)
      setCardState('ready')
    } catch (err) {
      if (seq !== loadSeq.current) return
      console.warn('Не удалось загрузить обсуждение заявки:', err.message)
      setCardState(prev => (prev === 'ready' ? prev : 'error'))
    }
  }, [request.id])
  const retryCard = useCallback(() => { setCardState('loading'); loadCard() }, [loadCard])
  useEffect(() => { if (hasCardFields) loadCard() }, [hasCardFields, loadCard, refreshKey])

  const changeComments = useCallback((update) => { loadSeq.current += 1; setComments(update) }, [])

  // Число сообщений на карточке доски — сразу, без перечитывания всей доски.
  useEffect(() => {
    if (cardState !== 'ready') return
    onCardCounts(request.id, cardCountsById(comments, currentUserId).get(request.id) || NO_CARD_COUNTS)
  }, [cardState, comments, request.id, currentUserId, onCardCounts])

  // Переписка на экране (вкладка «Общая») — сообщения коллег прочитаны: подсветка на карточке доски гаснет.
  const times = useMemo(() => talkTimes(comments, currentUserId), [comments, currentUserId])
  useEffect(() => {
    if (cardState !== 'ready' || tab !== 'general' || !times.lastOther || !onTalkSeen) return
    onTalkSeen(request.id, times.lastOther)
  }, [cardState, tab, times, request.id, onTalkSeen])
  const unreadAfter = Math.max(openReadMark, times.lastMine)

  // История — при каждом переходе на свою вкладку (и при возврате на вкладку браузера): её пишет база (20270216), и сделанное
  // в окне — файлы, исполнители, ответственный за ПСДЦ — видно сразу. Пока читается — прежний список. Постранично: потолок
  // 1000 строк на ответ.
  useEffect(() => {
    if (tab !== 'history') return undefined
    let cancelled = false
    fetchAllRows((from, to) => db
      .from('doc_check_request_audit_log')
      .select('*')
      .eq('request_id', request.id)
      .order('changed_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to))
      .then(rows => { if (!cancelled) setHistory(rows) })
      .catch(err => console.warn('Не удалось загрузить историю заявки:', err.message))
      .finally(() => { if (!cancelled) setHistoryLoaded(true) })
    return () => { cancelled = true }
  }, [tab, request.id, refreshKey])

  // Контрагентов — тысячи: собираем только для вкладки истории, и один раз.
  const ctx = useMemo(() => (tab !== 'history' ? null : {
    employees,
    objects: new Map(objects.map(o => [o.id, o.name])),
    counterparties: new Map(counterparties.map(c => [c.id, c.name])),
  }), [tab, employees, objects, counterparties])
  const due = dueState(request)
  const shownIds = shownAssigneeIds(request, employees)
  const people = shownIds.map(id => ({ key: id, name: employeeName(employees, id), tone: avatarTone(id) }))
  const statuses = availableStatuses(hasBoardFields)
  const mail = safeHttpUrl(request.email_link)
  const isDeleted = !!request.deleted_at
  const canAssign = canEdit && hasBoardFields && !isDeleted
  const lawyerOptions = useMemo(() => (canAssign ? assigneeStaffOptions(employees) : []), [canAssign, employees])
  // Согласование ПСДЦ — с миграцией 20270216: ответственный — экономист ОСП; назначает право правки раздела (юрист ОСП).
  const psdcId = shownPsdcResponsible(request, employees)
  const canPsdc = canAssign && hasChatFields && !!onPsdcAssign
  const psdcOptions = useMemo(() => (canPsdc
    ? [{ value: '', label: 'Не назначен' }, ...psdcStaffOptions(employees)] : []), [canPsdc, employees])
  // Файлы, отправленные в переписке, — третьей частью «Документов»; число изменилось — список файлов перечитывается.
  const postedIds = useMemo(() => postedChatFileIds(comments), [comments])

  const tabs = [
    { key: 'general', label: 'Общая' },
    { key: 'history', label: 'История' },
  ]

  return (
    <div className="modal-overlay">
      <div className="modal dc-detail-modal" role="dialog" aria-modal="true" aria-label={cardTitle(request)} {...blockStrayDrop}>
        <div className="modal-header dc-detail-head">
          <div className="dc-detail-heading">
            <h3>{cardTitle(request)}</h3>
            <p className="dc-detail-sub">
              {request.request_number != null && (
                <span className="dc-chip dc-chip--id" title="Номер заявки — не меняется">{requestIdLabel(request)}</span>
              )}
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
            </button>
          ))}
        </div>

        <div className={`dc-detail-body${tab === 'general' ? ` dc-general${hasCardFields ? ' has-talk' : ''}` : ''}`}>
          {tab === 'general' && (
            <div className="dc-general-main">
              <div className="dc-info">
                <div className="dc-info-col">
                  {request.notes && (
                    <Box title="Примечание">
                      <p className="dc-box-text">{request.notes}</p>
                    </Box>
                  )}

                  <Box title="Документы" className="dc-docs">
                    <dl className="dc-kv">
                      <Row label="Объект">{request.objects?.name || '—'}</Row>
                      <Row label="Контрагент">{request.counterparties?.name || '—'}</Row>
                      <Row label="Номер">{request.doc_number || '—'}</Row>
                      <Row label="Дата документа" className="ui-num">{fmtDocDate(request.doc_date) || '—'}</Row>
                      {/* Ссылку на письмо при создании больше не вводят (11.11.2026) — строка только у заявок, где она есть. */}
                      {hasCardFields && request.email_link && (
                        <Row label="Письмо">
                          {mail ? (
                            <a className="dc-detail-mail" href={mail} target="_blank" rel="noopener noreferrer" title={request.email_link}>
                              <IconLink size={14} />Открыть письмо
                            </a>
                          ) : '—'}
                        </Row>
                      )}
                    </dl>
                    <DocCheckFiles
                      requestId={request.id}
                      canEdit={(canEdit && !isDeleted) || authorFiles}
                      note={authorFiles ? 'Пока заявка в «Новых заявках», файлы можно добавить и удалить. Потом их меняет отдел.' : null}
                      onChange={markFilesChanged}
                      postedChatIds={postedIds}
                    />
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
                      {canAssign && (
                        <div className="dc-assign">
                          <FilterDropdown
                            label=""
                            multiple
                            searchable
                            searchPlaceholder="Поиск юриста…"
                            allLabel="Назначить"
                            icon={<IconUser size={15} />}
                            value={shownIds}
                            onChange={(ids) => onAssign(request, ids)}
                            options={lawyerOptions}
                            formatTrigger={() => (people.length ? 'Назначить или снять' : 'Назначить исполнителя')}
                            triggerTitle="Отметьте юристов ОСП — назначение сохраняется сразу"
                            className="dc-assign-picker"
                          />
                        </div>
                      )}
                    </Box>
                  )}

                  {hasChatFields && (
                    <Box title="Согласование ПСДЦ" className="dc-psdc">
                      {psdcId ? (
                        <ul className="dc-detail-people">
                          <li>
                            <span className={`dc-avatar dc-avatar--t${avatarTone(psdcId)}`} aria-hidden="true">
                              {initials(employeeName(employees, psdcId))}
                            </span>
                            <span className="dc-person-name">{employeeName(employees, psdcId)}</span>
                            <span className="dc-person-role">экономист ОСП</span>
                          </li>
                        </ul>
                      ) : <p className="dc-box-text dc-box-empty">Ответственный не назначен</p>}
                      {canPsdc && (
                        <div className="dc-assign">
                          <FilterDropdown
                            label=""
                            searchable
                            searchPlaceholder="Поиск экономиста…"
                            allLabel="Не назначен"
                            icon={<IconUser size={15} />}
                            value={psdcId || ''}
                            onChange={(id) => { if ((id || null) !== psdcId) onPsdcAssign(request, id || null) }}
                            options={psdcOptions}
                            formatTrigger={() => (psdcId ? 'Сменить или снять' : 'Назначить ответственного')}
                            triggerTitle="Экономист ОСП — ответственный за согласование ПСДЦ; сохраняется сразу"
                            className="dc-assign-picker dc-psdc-picker"
                          />
                        </div>
                      )}
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
              </div>
            </div>
          )}

          {tab === 'general' && hasCardFields && (
            <aside className="dc-general-talk">
              <DocCheckDiscussion
                requestId={request.id}
                comments={comments}
                onCommentsChange={changeComments}
                currentUserId={currentUserId}
                unreadAfter={unreadAfter}
                canWrite={!isDeleted}
                state={cardState}
                onRetry={retryCard}
                chatFiles={hasChatFields}
                onFilesSent={markFilesChanged}
              />
            </aside>
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
                        ) : FILE_EVENTS.has(h.event_type) ? (
                          <div className="dc-history-text">{fileHistoryText(h)}</div>
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
