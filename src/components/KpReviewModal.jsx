import { useState, useRef } from 'react'
import { useRole } from '../contexts/RoleContext'
import { setProposalReview } from '../services/tenderProposalFiles'
import './KpReviewModal.css'

// task 431: модалка проверки КП аналитиком-экономистом.
// Проставляет результат проверки одного файла КП: «проверено, ОК» (approved) или
// «есть замечания» (has_remarks). При замечаниях можно указать текст и/или приложить
// файл с замечаниями. Используется и внутри тендера (TenderCounterpartyFiles), и на
// вкладке «Проверка КП» (KpReviewPage).

const IconPaperclip = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
)

export default function KpReviewModal({ file, onClose, onSaved }) {
  const { userProfile, user } = useRole()
  const reviewer = userProfile?.full_name || user?.email || ''

  const [status, setStatus] = useState(
    file.review_status === 'has_remarks' ? 'has_remarks' : 'approved'
  )
  const [note, setNote] = useState(file.review_note || '')
  // Файл замечаний: новый выбранный File и/или флаг снятия уже прикреплённого.
  const [remarksFile, setRemarksFile] = useState(null)
  const [removeExisting, setRemoveExisting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const fileRef = useRef(null)

  const fileName = file.s3?.file_name || file.version_label || 'КП'
  const existingRemarks = file.review_note_s3 || null
  const existingAttached = !!(existingRemarks && !removeExisting)
  const hasAttachment = existingAttached || !!remarksFile
  // has_remarks валиден, если есть ХОТЯ БЫ текст ИЛИ файл замечаний.
  const missingContent = status === 'has_remarks' && !note.trim() && !hasAttachment

  const pickFile = (e) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setRemarksFile(f)
    setRemoveExisting(false)
  }

  const save = async (nextStatus) => {
    const finalStatus = nextStatus || status
    if (finalStatus === 'has_remarks' && !note.trim() && !hasAttachment) {
      setError('Опишите замечания или приложите файл.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const updated = await setProposalReview(file.id, {
        status: finalStatus,
        note,
        reviewer,
        remarksFile,
        removeRemarksFile: removeExisting,
        tenderId: file.tender_id,
        currentRemarksDoc: existingRemarks,
      })
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
            <>
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

              <div className="kprm-field">
                <span className="kprm-field-label">Файл с замечаниями (необязательно)</span>
                <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={pickFile} />

                {remarksFile ? (
                  <div className="kprm-attach">
                    <IconPaperclip />
                    <span className="kprm-attach-name" title={remarksFile.name}>{remarksFile.name}</span>
                    <button type="button" className="kprm-attach-remove" onClick={() => setRemarksFile(null)}>
                      Убрать
                    </button>
                  </div>
                ) : existingAttached ? (
                  <div className="kprm-attach">
                    <IconPaperclip />
                    <span className="kprm-attach-name" title={existingRemarks.file_name}>{existingRemarks.file_name}</span>
                    <button type="button" className="kprm-attach-link" onClick={() => fileRef.current?.click()}>
                      Заменить
                    </button>
                    <button type="button" className="kprm-attach-remove" onClick={() => setRemoveExisting(true)}>
                      Удалить
                    </button>
                  </div>
                ) : (
                  <button type="button" className="kprm-attach-btn" onClick={() => fileRef.current?.click()}>
                    <IconPaperclip /> Приложить файл
                  </button>
                )}

                {removeExisting && !remarksFile && existingRemarks && (
                  <div className="kprm-attach-hint">
                    Прикреплённый файл будет удалён.{' '}
                    <button type="button" className="kprm-attach-link" onClick={() => setRemoveExisting(false)}>
                      Отменить
                    </button>
                  </div>
                )}
              </div>
            </>
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
            disabled={saving || missingContent}
          >{saving ? 'Сохранение…' : 'Сохранить'}</button>
        </div>
      </div>
    </div>
  )
}
