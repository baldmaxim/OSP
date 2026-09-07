import { useEffect, useState } from 'react'
import { supabase } from '../../supabase'
import S3DocumentList from '../S3DocumentList'
import {
  DOC_CHECK_STATUSES,
  DOC_CHECK_STATUS_CLASS,
  DOC_CHECK_STATUS_LABEL,
  DOC_TYPE_TITLE,
  docTitle,
  fmtDocDate,
} from '../../utils/docCheckHelpers'

// Карточка заявки: данные, файлы, история.
//
// Статус здесь тоже переключается — на телефоне доску не потаскаешь, а работать
// с заявкой надо. Список колонок один и тот же (DOC_CHECK_STATUSES), поэтому
// доска и карточка не разойдутся.

const fmtDateTime = (v) => (v ? new Date(v).toLocaleString('ru-RU', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '')

const EVENT_LABEL = {
  created: 'Заявка создана',
  status_changed: 'Смена статуса',
  field_updated: 'Изменение поля',
  soft_deleted: 'Заявка удалена',
  restored: 'Заявка восстановлена',
}

export default function DocCheckDetailModal({ request, canEdit, onStatusChange, onEdit, onDelete, onClose }) {
  const [tab, setTab] = useState('info')
  const [history, setHistory] = useState([])
  const [historyLoaded, setHistoryLoaded] = useState(false)

  // История нужна редко — грузим только при открытии своей вкладки.
  useEffect(() => {
    if (tab !== 'history' || historyLoaded) return
    let cancelled = false
    const load = async () => {
      try {
        const { data, error } = await supabase
          .from('doc_check_request_audit_log')
          .select('*')
          .eq('request_id', request.id)
          .order('changed_at', { ascending: false })
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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal dc-detail-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3>{docTitle(request)}</h3>
            <p className="dc-detail-sub">{DOC_TYPE_TITLE[request.doc_type]}</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <div className="dc-detail-tabs">
          {[
            { key: 'info', label: 'Заявка' },
            { key: 'docs', label: 'Документы' },
            { key: 'history', label: 'История' },
          ].map(t => (
            <button
              key={t.key}
              type="button"
              className={`dc-detail-tab${tab === t.key ? ' is-active' : ''}`}
              onClick={() => setTab(t.key)}
            >{t.label}</button>
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
                  {DOC_CHECK_STATUSES.map(s => (
                    <button
                      key={s.value}
                      type="button"
                      className={`dc-status-opt ${DOC_CHECK_STATUS_CLASS[s.value]}${request.status === s.value ? ' is-current' : ''}`}
                      onClick={() => canEdit && request.status !== s.value && onStatusChange(request, s.value)}
                      disabled={!canEdit}
                    >{s.label}</button>
                  ))}
                </div>
              </div>
            </>
          )}

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
                          <span className="dc-history-event">{EVENT_LABEL[h.event_type] || h.event_type}</span>
                          <span className="dc-history-date">{fmtDateTime(h.changed_at)}</span>
                        </div>
                        {h.event_type === 'status_changed' ? (
                          <div className="dc-history-text">
                            {DOC_CHECK_STATUS_LABEL[h.old_value] || h.old_value || '—'}
                            {' → '}
                            {DOC_CHECK_STATUS_LABEL[h.new_value] || h.new_value || '—'}
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
