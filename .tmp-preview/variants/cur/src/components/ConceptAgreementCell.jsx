import { useRef, useState } from 'react'
import { uploadFile, deleteDocument } from '../services/s3'
import S3DocumentPreview from './S3DocumentPreview'
import './ConceptAgreementCell.css'

// «Понятийное соглашение» договора — документы-основания для заключения договора
// (с визой акционера). Согласований может быть НЕСКОЛЬКО, поэтому это список файлов,
// хранящихся в S3 как s3_documents(owner_type='contract', doc_category='concept_agreement').
// Показывается под № договора в реестре: список файлов + добавить / предпросмотр / удалить.
// Пропсы: files — массив s3_documents; contractId; canEdit; onChanged — колбэк перезагрузки.

const CATEGORY = 'concept_agreement'

const IconDoc = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
)
const IconPlus = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
)
const IconTrash = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
  </svg>
)
const IconEye = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" />
  </svg>
)

export default function ConceptAgreementCell({ files = [], contractId, canEdit = false, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [previewDoc, setPreviewDoc] = useState(null)
  const fileRef = useRef(null)

  const pick = () => { if (!busy) fileRef.current?.click() }

  const onFiles = async (e) => {
    const picked = Array.from(e.target.files || [])
    e.target.value = ''
    if (!picked.length) return
    setBusy(true)
    const failed = []
    for (const file of picked) {
      try {
        await uploadFile({ file, ownerType: 'contract', ownerId: contractId, category: CATEGORY })
      } catch (err) {
        console.error('ПС не загружено:', file.name, err?.message)
        failed.push(file.name)
      }
    }
    setBusy(false)
    if (failed.length) alert('Не удалось загрузить: ' + failed.join(', '))
    onChanged?.()
  }

  const remove = async (doc) => {
    if (!window.confirm(`Удалить понятийное соглашение «${doc.file_name || ''}»?`)) return
    setBusy(true)
    try {
      await deleteDocument(doc)
      onChanged?.()
    } catch (err) {
      alert('Ошибка удаления: ' + (err.message || err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ca">
      <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={onFiles} />

      {files.map(doc => (
        <div className="ca-has" key={doc.id}>
          <span className="ca-chip" title={`Понятийное соглашение: ${doc.file_name || ''}`}>
            <IconDoc />
            <span className="ca-chip-label">{doc.file_name || 'Понятийное соглашение'}</span>
          </span>
          <span className="ca-actions">
            <button type="button" className="ca-mini ca-preview" onClick={() => setPreviewDoc(doc)} title="Предпросмотр" aria-label="Предпросмотр">
              <IconEye />
            </button>
            {canEdit && (
              <button type="button" className="ca-mini ca-danger" onClick={() => remove(doc)} title="Удалить" aria-label="Удалить">
                <IconTrash />
              </button>
            )}
          </span>
        </div>
      ))}

      {busy && <span className="ca-busy">Загрузка…</span>}

      {canEdit && !busy && (
        <button type="button" className="ca-add" onClick={pick} title="Прикрепить понятийное соглашение (можно несколько)">
          <IconPlus />
          <span className="ca-chip-label">{files.length ? 'Ещё соглашение' : 'Понятийное соглашение'}</span>
        </button>
      )}

      {previewDoc && (
        <S3DocumentPreview doc={previewDoc} onClose={() => setPreviewDoc(null)} />
      )}
    </div>
  )
}
