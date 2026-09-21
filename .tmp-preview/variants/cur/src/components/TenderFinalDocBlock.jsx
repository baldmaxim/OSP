import { useState, useEffect, useCallback, useRef } from 'react'
import { useRole } from '../contexts/RoleContext'
import { uploadFile, deleteDocument, requestDownloadUrl } from '../services/s3'
import { fetchTenderFinalDoc, ensureTenderFinalDoc, deleteTenderDoc } from '../services/tenderDocs'
import './TenderDocumentsTab.css'

// Блок «Итоговый документ» в зоне победителя (статус тендера «Завершен»).
// Это документ о выборе подрядчика. Взаимосвязан с вкладкой «Документы»: работает с той же
// записью tender_docs (is_final=true), поэтому загруженное здесь видно во вкладке (выделено),
// и наоборот. version/onChange синхронизируют оба места.

const MAX_FILE_SIZE_MB = 50
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024
const BLOCKED_EXTENSIONS = ['exe', 'msi', 'bat', 'cmd', 'scr', 'ps1', 'sh', 'dll', 'com', 'jar', 'vbs', 'vbe', 'wsf', 'pif', 'hta', 'cpl', 'msc', 'reg']

function formatSize(bytes) {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}
function validateFile(file) {
  const ext = (String(file.name || '').split('.').pop() || '').toLowerCase()
  if (BLOCKED_EXTENSIONS.includes(ext)) return 'исполняемые файлы запрещены'
  if (file.size === 0) return 'файл пустой'
  if (file.size > MAX_FILE_SIZE) return `превышает лимит ${MAX_FILE_SIZE_MB} МБ`
  return null
}

export default function TenderFinalDocBlock({ tenderId, canEdit = false, version = 0, onChange }) {
  const { user, userProfile } = useRole()
  const currentUserName = userProfile?.full_name || user?.email || null

  const [doc, setDoc] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const d = await fetchTenderFinalDoc(tenderId)
      setDoc(d)
    } catch (err) {
      console.error('Ошибка загрузки итогового документа:', err.message)
    }
  }, [tenderId])

  useEffect(() => { load() }, [load, version])

  const materials = [
    ...((doc?.links) || []).map((l) => ({ kind: 'link', id: `l-${l.id}`, title: l.title, url: l.url })),
    ...((doc?.files) || []).map((f) => ({ kind: 'file', id: `f-${f.id}`, s3: f })),
  ]

  const notify = () => { if (onChange) onChange() }

  const handleDownload = async (s3doc) => {
    try {
      const { presigned_url } = await requestDownloadUrl(s3doc.s3_key, { fileName: s3doc.file_name, download: true })
      const a = document.createElement('a')
      a.href = presigned_url; a.download = s3doc.file_name || ''; a.target = '_blank'; a.rel = 'noopener noreferrer'
      document.body.appendChild(a); a.click(); a.remove()
    } catch (e) {
      alert('Не удалось получить файл: ' + e.message)
    }
  }

  const onFilesPicked = async (fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length) return
    setError('')
    setUploading(true)
    try {
      const card = await ensureTenderFinalDoc(tenderId, { userId: user?.id || null, userName: currentUserName })
      const problems = []
      for (const f of files) {
        const reason = validateFile(f)
        if (reason) { problems.push(`${f.name} — ${reason}`); continue }
        try {
          await uploadFile({ file: f, ownerType: 'tender', ownerId: card.id })
        } catch (upErr) {
          problems.push(`${f.name} — не удалось загрузить`)
        }
      }
      if (problems.length) setError(problems.join('; '))
      await load()
      notify()
    } catch (err) {
      setError('Не удалось загрузить: ' + err.message)
    } finally {
      setUploading(false)
    }
  }

  const handleRemoveFile = async (s3doc) => {
    if (!window.confirm(`Удалить файл «${s3doc.file_name}»?`)) return
    try {
      await deleteDocument(s3doc)
      // Если у итоговой карточки не осталось ни файлов, ни ссылок — убираем и её,
      // чтобы блок вернулся к состоянию «нет итогового документа».
      const remainingFiles = (doc?.files || []).filter((f) => f.id !== s3doc.id)
      const remainingLinks = doc?.links || []
      if (doc && remainingFiles.length === 0 && remainingLinks.length === 0) {
        await deleteTenderDoc({ ...doc, files: [] }) // файлы уже удалены выше
      }
      await load()
      notify()
    } catch (err) {
      alert('Не удалось удалить файл: ' + err.message)
    }
  }

  const hasMaterials = materials.length > 0

  return (
    <div className="tender-final-doc">
      <div className="tfd-head">
        <span className="tfd-title">
          Итоговый документ
          <span className="tfd-badge">о выборе подрядчика</span>
        </span>
      </div>
      <p className="tfd-subtitle">Протокол/решение о выборе подрядчика. Отображается и во вкладке «Документы» тендера.</p>

      {hasMaterials ? (
        <div className="tfd-materials">
          {materials.map((m) => m.kind === 'link' ? (
            <a key={m.id} href={m.url} target="_blank" rel="noopener noreferrer" className="tfd-material" title={m.url}>
              <span aria-hidden>🔗</span>
              <span className="tfd-mat-name">{m.title || 'Открыть ссылку'}</span>
            </a>
          ) : (
            <div key={m.id} className="tfd-material" style={{ cursor: 'default' }}>
              <button type="button" className="tfd-material" style={{ border: 'none', background: 'transparent', padding: 0, flex: 1 }} onClick={() => handleDownload(m.s3)} title={`Скачать ${m.s3.file_name}`}>
                <span aria-hidden>📎</span>
                <span className="tfd-mat-name">{m.s3.file_name}</span>
                {m.s3.size_bytes != null && <span className="tfd-mat-size">{formatSize(m.s3.size_bytes)}</span>}
              </button>
              {canEdit && (
                <button type="button" className="tfd-mat-remove" onClick={() => handleRemoveFile(m.s3)} title="Удалить файл" aria-label="Удалить файл">×</button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="tfd-empty">Итоговый документ ещё не прикреплён.</p>
      )}

      {canEdit && (
        <div className="tfd-actions">
          <button type="button" className="tfd-upload-btn" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="m17 8-5-5-5 5" />
              <path d="M12 3v12" />
            </svg>
            {uploading ? 'Загрузка…' : (hasMaterials ? 'Добавить файл' : 'Загрузить итоговый документ')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => { onFilesPicked(e.target.files); e.target.value = '' }}
          />
        </div>
      )}

      {error && <p className="tfd-error">{error}</p>}
    </div>
  )
}
