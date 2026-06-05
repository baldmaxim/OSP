import { useCallback, useEffect, useRef, useState } from 'react'
import { useRole } from '../contexts/RoleContext'
import { deleteDocument, fetchDocuments, requestDownloadUrl, uploadFile } from '../services/s3'
import S3DocumentPreview from './S3DocumentPreview'
import './S3DocumentList.css'

// Универсальный список S3-документов для произвольной сущности.
// Использование:
//   <S3DocumentList ownerType="tender" ownerId={tenderId} title="Документы" />
// Права: сотрудники (isEmployee) могут загружать/удалять; подрядчики — только просмотр.
// canEdit можно явно переопределить пропом (например, для разделов с другой политикой).

function formatBytes(bytes) {
  if (bytes == null) return '—'
  if (bytes === 0) return '0 Б'
  const units = ['Б', 'КБ', 'МБ', 'ГБ']
  let v = Number(bytes)
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${dd}.${mm}.${yyyy} ${hh}:${mi}`
}

export default function S3DocumentList({ ownerType, ownerId, title = 'Документы', canEdit: canEditProp, category = null, onChange }) {
  const { isEmployee } = useRole()
  const canEdit = canEditProp !== undefined ? canEditProp : isEmployee

  const [documents, setDocuments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [previewDoc, setPreviewDoc] = useState(null)
  const fileInputRef = useRef(null)

  const reload = useCallback(async () => {
    if (!ownerId) return
    setLoading(true)
    setError(null)
    try {
      const list = await fetchDocuments(ownerType, ownerId, category)
      setDocuments(list)
    } catch (e) {
      setError(e.message || 'Не удалось загрузить список документов')
    } finally {
      setLoading(false)
    }
  }, [ownerType, ownerId, category])

  useEffect(() => { reload() }, [reload])

  const handlePickFiles = async (e) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    setUploading(true)
    try {
      for (const file of files) {
        await uploadFile({ file, ownerType, ownerId, category })
      }
      await reload()
      onChange?.()
    } catch (err) {
      alert('Ошибка загрузки: ' + (err.message || err))
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleDownload = async (doc) => {
    try {
      const { presigned_url } = await requestDownloadUrl(doc.s3_key)
      const a = document.createElement('a')
      a.href = presigned_url
      a.download = doc.file_name
      a.target = '_blank'
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (err) {
      alert('Ошибка получения ссылки: ' + (err.message || err))
    }
  }

  const handleDelete = async (doc) => {
    if (!window.confirm(`Удалить файл «${doc.file_name}»?`)) return
    try {
      await deleteDocument(doc)
      setDocuments(prev => prev.filter(d => d.id !== doc.id))
      onChange?.()
    } catch (err) {
      alert('Ошибка удаления: ' + (err.message || err))
    }
  }

  return (
    <div className="s3-doc-list">
      <div className="s3-doc-toolbar">
        <h3 className="s3-doc-title">{title}</h3>
        {canEdit && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={handlePickFiles}
            />
            <button
              type="button"
              className="s3-doc-btn-primary"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || !ownerId}
            >
              {uploading ? 'Загрузка…' : '📤 Загрузить'}
            </button>
          </>
        )}
      </div>

      {loading && <div className="s3-doc-empty">Загрузка списка…</div>}
      {error && <div className="s3-doc-error">Ошибка: {error}</div>}
      {!loading && !error && documents.length === 0 && (
        <div className="s3-doc-empty">Документы не загружены</div>
      )}

      {!loading && documents.length > 0 && (
        <table className="s3-doc-table">
          <thead>
            <tr>
              <th>Название</th>
              <th>Размер</th>
              <th>Кто загрузил</th>
              <th>Когда</th>
              <th className="s3-doc-actions-col">Действия</th>
            </tr>
          </thead>
          <tbody>
            {documents.map(doc => (
              <tr key={doc.id}>
                <td className="s3-doc-name">{doc.file_name}</td>
                <td>{formatBytes(doc.size_bytes)}</td>
                <td>{doc.uploaded_by_name || '—'}</td>
                <td>{formatDateTime(doc.created_at)}</td>
                <td className="s3-doc-actions">
                  <button type="button" title="Просмотр" onClick={() => setPreviewDoc(doc)}>👁️</button>
                  <button type="button" title="Скачать" onClick={() => handleDownload(doc)}>⬇️</button>
                  {canEdit && (
                    <button
                      type="button"
                      title="Удалить"
                      className="s3-doc-btn-danger"
                      onClick={() => handleDelete(doc)}
                    >🗑️</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {previewDoc && (
        <S3DocumentPreview doc={previewDoc} onClose={() => setPreviewDoc(null)} />
      )}
    </div>
  )
}
