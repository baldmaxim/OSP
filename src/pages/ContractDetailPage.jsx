import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import { useRole } from '../contexts/RoleContext'
import '../components/ContractRegistry.css'

const STATUS_LABEL = {
  new_request: 'Новая заявка',
  in_work: 'В работе',
  paused: 'Приостановка',
  completed: 'Завершено',
}

const EVENT_LABEL = {
  created: '🆕 Создание',
  status_changed: '🔄 Смена статуса',
  field_updated: '✏️ Изменение полей',
  soft_deleted: '🗑️ В корзину',
  restored: '↩ Восстановление',
}

function ContractDetailPage() {
  const { contractId } = useParams()
  const navigate = useNavigate()
  const { userProfile } = useRole()
  const [contract, setContract] = useState(null)
  const [attachments, setAttachments] = useState([])
  const [auditLog, setAuditLog] = useState([])
  const [loading, setLoading] = useState(true)
  const [notesDraft, setNotesDraft] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)

  const fetchContract = useCallback(async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('contracts')
        .select('*, objects(name), counterparties(name, inn, kpp, legal_address, actual_address, website, work_type), tenders(work_description), responsible:contacts!responsible_contact_id(id, full_name, position)')
        .eq('id', contractId)
        .single()

      if (error) throw error
      setContract(data)
      setNotesDraft(data?.notes || '')

      // Приложения
      const { data: caRows } = await supabase
        .from('contract_attachments')
        .select('object_contract_attachments(id, name, link, sort_order)')
        .eq('contract_id', contractId)
      const list = (caRows || [])
        .map(r => r.object_contract_attachments)
        .filter(Boolean)
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
      setAttachments(list)

      // История (task 187)
      const { data: logRows } = await supabase
        .from('contract_audit_log')
        .select('*')
        .eq('contract_id', contractId)
        .order('changed_at', { ascending: false })
      setAuditLog(logRows || [])
    } catch (err) {
      console.error('Ошибка загрузки договора:', err.message)
    } finally {
      setLoading(false)
    }
  }, [contractId])

  useEffect(() => {
    fetchContract()
  }, [fetchContract])

  const formatDate = (dateStr) => {
    if (!dateStr) return '—'
    return new Date(dateStr).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })
  }

  const formatAmount = (amount) => {
    if (!amount) return '—'
    return Number(amount).toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' руб.'
  }

  const formatDateTime = (ts) => {
    if (!ts) return ''
    const d = new Date(ts)
    return d.toLocaleDateString('ru-RU') + ', ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  }

  // Task 185: сохранение примечания
  const handleSaveNotes = async () => {
    const next = notesDraft.trim() || null
    if ((contract?.notes || null) === next) return
    setSavingNotes(true)
    try {
      const { error } = await supabase
        .from('contracts')
        .update({ notes: next })
        .eq('id', contractId)
      if (error) throw error
      // запись в аудит-лог
      try {
        const role = localStorage.getItem('userRole') || null
        await supabase.from('contract_audit_log').insert([{
          contract_id: contractId,
          event_type: 'field_updated',
          field_name: 'notes',
          old_value: contract?.notes ?? null,
          new_value: next,
          description: next
            ? (contract?.notes ? 'Примечание обновлено' : 'Добавлено примечание')
            : 'Примечание удалено',
          changed_by_role: role,
          changed_by_name: userProfile?.full_name || null,
        }])
      } catch (logErr) {
        console.error('Не удалось записать в аудит-лог:', logErr.message)
      }
      setContract(prev => ({ ...prev, notes: next }))
      fetchContract()
    } catch (err) {
      console.error('Ошибка сохранения примечания:', err.message)
      alert('Ошибка: ' + err.message)
    } finally {
      setSavingNotes(false)
    }
  }

  if (loading) {
    return <div className="contract-registry"><div className="loading" style={{ padding: '3rem', textAlign: 'center' }}>Загрузка...</div></div>
  }

  if (!contract) {
    return <div className="contract-registry"><div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-tertiary)' }}>Договор не найден</div></div>
  }

  const cp = contract.counterparties || {}
  const statusLabel = STATUS_LABEL[contract.status] || contract.status
  const isDeleted = !!contract.deleted_at

  return (
    <div className="contract-registry contract-detail">
      <div className="registry-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button onClick={() => navigate('/contracts')} style={{ background: 'none', border: 'none', fontSize: '1.25rem', cursor: 'pointer', color: 'var(--text-secondary)' }}>←</button>
          <div>
            <h2 style={{ margin: 0 }}>
              Договор № {contract.contract_number}
              {isDeleted && <span className="deleted-marker"> (удалён)</span>}
            </h2>
            <span style={{ fontSize: '0.8125rem', color: 'var(--text-tertiary)' }}>
              от {formatDate(contract.contract_date)} · <span className={`status-badge-inline status-${contract.status}`}>{statusLabel}</span>
            </span>
          </div>
        </div>
      </div>

      <div className="contract-detail-grid">
        {/* Основная информация */}
        <div className="contract-section">
          <h3>Основная информация</h3>
          <div className="info-rows">
            <InfoRow label="№ договора" value={contract.contract_number} />
            <InfoRow label="Дата" value={formatDate(contract.contract_date)} />
            <InfoRow label="Объект" value={contract.objects?.name} />
            <InfoRow label="Описание работ" value={contract.work_name || contract.tenders?.work_description} />
            <InfoRow label="Сумма" value={formatAmount(contract.contract_amount)} />
            <InfoRow label="Статус" value={statusLabel} />
            <InfoRow label="Ответственный" value={contract.responsible?.full_name} />
            {contract.document_link && (
              <InfoRow
                label="Документ"
                value={<a href={contract.document_link} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary-color)' }}>Открыть на Google Drive</a>}
              />
            )}
          </div>
        </div>

        {/* Реквизиты контрагента */}
        <div className="contract-section">
          <h3>Реквизиты контрагента</h3>
          <div className="info-rows">
            <InfoRow label="Наименование" value={cp.name} />
            <InfoRow label="ИНН" value={cp.inn} mono />
            <InfoRow label="КПП" value={cp.kpp} mono />
            <InfoRow label="Юр. адрес" value={cp.legal_address} />
            <InfoRow label="Факт. адрес" value={cp.actual_address} />
            {cp.website && (
              <InfoRow label="Сайт" value={<a href={cp.website} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary-color)' }}>{cp.website}</a>} />
            )}
          </div>
        </div>

        {/* Сроки работ */}
        <div className="contract-section">
          <h3>Сроки работ</h3>
          <div className="info-rows">
            <InfoRow label="Начало работ" value={formatDate(contract.work_start_date)} />
            <InfoRow label="Окончание работ" value={formatDate(contract.work_end_date)} />
          </div>
        </div>

        {/* Гарантия */}
        <div className="contract-section">
          <h3>Гарантийные условия</h3>
          <div className="info-rows">
            <InfoRow label="Срок гарантии" value={contract.warranty_period} />
            <InfoRow label="Гарантийное удержание" value={contract.warranty_retention_percent ? `${contract.warranty_retention_percent}%` : null} />
            <InfoRow label="Срок удержания" value={contract.warranty_retention_period} />
          </div>
        </div>

        {/* Приложения */}
        {attachments.length > 0 && (
          <div className="contract-section contract-section-wide">
            <h3>Приложения ({attachments.length})</h3>
            <ul className="attachments-readonly">
              {attachments.map(a => (
                <li key={a.id}>
                  {a.link
                    ? <a href={a.link} target="_blank" rel="noopener noreferrer">{a.name}</a>
                    : <span>{a.name}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Task 185: примечание */}
        <div className="contract-section contract-section-wide">
          <h3>Примечание</h3>
          <textarea
            className="contract-notes"
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            placeholder="Свободный текст: важные нюансы, договорённости, статус согласования и т.п."
            rows={4}
          />
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', alignItems: 'center' }}>
            <button
              type="button"
              className="btn-primary"
              onClick={handleSaveNotes}
              disabled={savingNotes || (contract.notes || '') === notesDraft.trim()}
            >
              {savingNotes ? 'Сохранение…' : 'Сохранить'}
            </button>
            {contract.notes && contract.notes !== notesDraft && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setNotesDraft(contract.notes || '')}
              >
                Отменить
              </button>
            )}
          </div>
        </div>

        {/* Task 187: история */}
        <div className="contract-section contract-section-wide">
          <h3>История изменений ({auditLog.length})</h3>
          {auditLog.length === 0 ? (
            <div className="muted-dash" style={{ padding: '0.5rem 0' }}>Истории пока нет.</div>
          ) : (
            <ul className="audit-list">
              {auditLog.map(ev => (
                <li key={ev.id} className="audit-item">
                  <div className="audit-meta">
                    <span className="audit-type">{EVENT_LABEL[ev.event_type] || ev.event_type}</span>
                    <span className="audit-date">{formatDateTime(ev.changed_at)}</span>
                  </div>
                  <div className="audit-desc">{ev.description || '—'}</div>
                  {(ev.changed_by_name || ev.changed_by_role) && (
                    <div className="audit-who">
                      {ev.changed_by_name || 'без имени'}
                      {ev.changed_by_role ? ` (${ev.changed_by_role})` : ''}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function InfoRow({ label, value, mono }) {
  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className={`info-value${mono ? ' mono' : ''}`}>{value || '—'}</span>
    </div>
  )
}

export default ContractDetailPage
