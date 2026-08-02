import { useState } from 'react'
import { useRole } from '../contexts/RoleContext'
import { setProposalReview } from '../services/tenderProposalFiles'
import './KpReviewModal.css'

// task 431: модалка проверки КП аналитиком-экономистом.
// Проставляет результат проверки одного файла КП: «проверено, ОК» (approved) или
// «есть замечания» (has_remarks) с текстом замечаний. Используется и внутри тендера
// (TenderCounterpartyFiles), и на вкладке «Проверка КП» (KpReviewPage).
export default function KpReviewModal({ file, onClose, onSaved }) {
  const { userProfile, user } = useRole()
  const reviewer = userProfile?.full_name || user?.email || ''

  const [status, setStatus] = useState(
    file.review_status === 'has_remarks' ? 'has_remarks' : 'approved'
  )
  const [note, setNote] = useState(file.review_note || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const fileName = file.s3?.file_name || file.version_label || 'КП'
  const noteRequired = status === 'has_remarks' && !note.trim()

  const save = async (nextStatus) => {
    const finalStatus = nextStatus || status
    if (finalStatus === 'has_remarks' && !note.trim()) {
      setError('Укажите замечания по КП.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const updated = await setProposalReview(file.id, { status: finalStatus, note, reviewer })
      onSaved?.(updated)
      onClose()
    } catch (e) {
      setError(e.message || 'Не удалось сохранить проверку')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="kprm-overlay" onClick={onClose}>
      <div className="kprm-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="kprm-header">
          <h3 className="kprm-title">Проверка КП</h3>
          <button type="button" className="kprm-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <div className="kprm-body">
          <div className="kprm-file" title={fileName}>
            <span className="kprm-file-icon" aria-hidden>📄</span>
            <span className="kprm-file-name">{fileName}</span>
          </div>

          <div className="kprm-options">
            <label className={`kprm-option${status === 'approved' ? ' is-active' : ''}`}>
              <input
                type="radio"
                name="kprm-status"
                checked={status === 'approved'}
                onChange={() => setStatus('approved')}
              />
              <span className="kprm-option-dot kprm-ok" aria-hidden />
              <span>Проверено, замечаний нет</span>
            </label>
            <label className={`kprm-option${status === 'has_remarks' ? ' is-active' : ''}`}>
              <input
                type="radio"
                name="kprm-status"
                checked={status === 'has_remarks'}
                onChange={() => setStatus('has_remarks')}
              />
              <span className="kprm-option-dot kprm-warn" aria-hidden />
              <span>Есть замечания</span>
            </label>
          </div>

          {status === 'has_remarks' && (
            <label className="kprm-field">
              <span className="kprm-field-label">Замечания по КП</span>
              <textarea
                className="kprm-textarea"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={4}
                placeholder="Опишите замечания — их направят контрагенту"
                autoFocus
              />
            </label>
          )}

          {error && <div className="kprm-error">{error}</div>}
        </div>

        <div className="kprm-footer">
          {file.review_status !== 'pending' && (
            <button
              type="button"
              className="kprm-btn-ghost kprm-footer-left"
              onClick={() => save('pending')}
              disabled={saving}
              title="Снять отметку о проверке и вернуть КП в очередь"
            >Вернуть на проверку</button>
          )}
          <button type="button" className="kprm-btn-secondary" onClick={onClose} disabled={saving}>
            Отмена
          </button>
          <button
            type="button"
            className="kprm-btn-primary"
            onClick={() => save()}
            disabled={saving || noteRequired}
          >{saving ? 'Сохранение…' : 'Сохранить'}</button>
        </div>
      </div>
    </div>
  )
}
