import { useState } from 'react'
import { supabase } from '../supabase'
import { uploadFile, deleteDocument, requestDownloadUrl } from '../services/s3'

// task 357: модалка «Подписание акта» для строки гарантии.
//   Позволяет указать фактическую дату начала гарантии и прикрепить файл акта.
//   Файл живёт в s3_documents (owner_type='object'), привязка — через новое поле
//   object_warranties.actual_start_document_id. В общем реестре документов
//   объекта файл НЕ отображается — он принадлежит только строке гарантии.

function WarrantyActSignModal({ warranty, objectId, onClose, onSaved }) {
  const existing = warranty.actual_start_doc || null
  const [signDate, setSignDate] = useState(warranty.start_date || '')
  const [file, setFile] = useState(null)
  const [saving, setSaving] = useState(false)

  const handleFileChange = (e) => {
    const f = e.target.files?.[0] || null
    setFile(f)
  }

  const handleDownload = async () => {
    if (!existing) return
    try {
      const { presigned_url } = await requestDownloadUrl(existing.s3_key)
      window.open(presigned_url, '_blank', 'noopener')
    } catch (err) {
      alert('Не удалось получить ссылку на скачивание: ' + err.message)
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!signDate) return alert('Укажите дату подписания акта')
    if (!existing && !file) return alert('Прикрепите файл подписанного акта')

    setSaving(true)
    try {
      let newDocId = existing?.id || null

      // Если выбран новый файл — загружаем, при наличии старого подменяем.
      if (file) {
        const uploaded = await uploadFile({
          file,
          ownerType: 'object',
          ownerId: objectId,
          notes: 'Акт подписания гарантии'
        })
        newDocId = uploaded.id

        // Если был старый акт — удалить после успешной загрузки нового.
        if (existing) {
          try { await deleteDocument(existing) } catch { /* лучшее усилие */ }
        }
      }

      const { error } = await supabase
        .from('object_warranties')
        .update({ start_date: signDate, actual_start_document_id: newDocId })
        .eq('id', warranty.id)
      if (error) throw error
      onSaved()
    } catch (err) {
      alert('Ошибка: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleUnlink = async () => {
    if (!window.confirm('Открепить акт и сбросить фактическую дату начала?')) return
    setSaving(true)
    try {
      // Сначала обнуляем ссылку в гарантии (чтобы ON DELETE SET NULL не сработал
      // при удалении s3_documents, на случай race — порядок безопаснее).
      const { error: upErr } = await supabase
        .from('object_warranties')
        .update({ start_date: null, actual_start_document_id: null })
        .eq('id', warranty.id)
      if (upErr) throw upErr

      if (existing) {
        try { await deleteDocument(existing) } catch { /* лучшее усилие */ }
      }
      onSaved()
    } catch (err) {
      alert('Ошибка: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{existing ? 'Изменить акт подписания' : 'Подписать акт'}</h3>
          <button onClick={onClose}>×</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="form-row">
            <label>Гарантия</label>
            <div className="warranty-act-info">{warranty.work_name}</div>
          </div>
          <div className="form-row">
            <label>Дата подписания акта *</label>
            <input
              type="date"
              value={signDate}
              onChange={(e) => setSignDate(e.target.value)}
              required
            />
            <small className="form-hint">
              С этой даты гарантия начинает действовать. Срок будет рассчитан автоматически.
            </small>
          </div>

          {existing && (
            <div className="form-row">
              <label>Текущий акт</label>
              <div className="warranty-act-current">
                <span className="warranty-act-current-icon" aria-hidden>📄</span>
                <button
                  type="button"
                  className="warranty-act-current-link"
                  onClick={handleDownload}
                  title="Скачать текущий акт"
                >
                  {existing.file_name}
                </button>
              </div>
            </div>
          )}

          <div className="form-row">
            <label>{existing ? 'Заменить файл (опционально)' : 'Файл акта *'}</label>
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
              onChange={handleFileChange}
            />
            {file && (
              <small className="form-hint">
                Выбран: <strong>{file.name}</strong> ({Math.ceil(file.size / 1024)} KB)
              </small>
            )}
          </div>

          <div className="modal-footer">
            {existing && (
              <button
                type="button"
                className="btn-cancel warranty-act-unlink-btn"
                onClick={handleUnlink}
                disabled={saving}
                title="Удалить акт и сбросить дату начала"
              >
                🗑️ Открепить
              </button>
            )}
            <button type="button" className="btn-cancel" onClick={onClose} disabled={saving}>Отмена</button>
            <button type="submit" className="btn-save" disabled={saving}>
              {saving ? 'Сохранение…' : 'Сохранить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default WarrantyActSignModal
