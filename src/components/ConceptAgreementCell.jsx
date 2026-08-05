import { useRef, useState } from 'react'
import { supabase } from '../supabase'
import { uploadFile, deleteDocument, requestDownloadUrl } from '../services/s3'
import './ConceptAgreementCell.css'

// «Понятийное соглашение» договора — документ-основание для заключения договора
// (с визой акционера). Один файл на договор, хранится в S3 (owner_type='contract'),
// ссылка в contracts.concept_agreement_s3_document_id. Показывается под № договора
// в реестре: открыть / прикрепить / заменить / удалить.

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
const IconReplace = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 3v5h-5" /><path d="M3 21v-5h5" />
    <path d="M21 8A9 9 0 0 0 6.6 4.6L3 8" /><path d="M3 16a9 9 0 0 0 14.4 3.4L21 16" />
  </svg>
)
const IconTrash = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
  </svg>
)

export default function ConceptAgreementCell({ contract, canEdit = false, onChanged }) {
  const doc = contract.concept_agreement || null
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)

  const pick = () => { if (!busy) fileRef.current?.click() }

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    let uploaded = null
    try {
      uploaded = await uploadFile({ file, ownerType: 'contract', ownerId: contract.id })
      const { error } = await supabase
        .from('contracts')
        .update({ concept_agreement_s3_document_id: uploaded.id })
        .eq('id', contract.id)
      if (error) throw error
      // Старый файл (при замене) больше не нужен — убираем из S3.
      if (doc?.id && doc?.s3_key) {
        try { await deleteDocument(doc) } catch { /* best effort */ }
      }
      onChanged?.()
    } catch (err) {
      if (uploaded) { try { await deleteDocument(uploaded) } catch { /* best effort */ } }
      alert('Ошибка загрузки понятийного соглашения: ' + (err.message || err))
    } finally {
      setBusy(false)
    }
  }

  const open = async () => {
    if (!doc?.s3_key) return
    try {
      const { presigned_url } = await requestDownloadUrl(doc.s3_key)
      window.open(presigned_url, '_blank', 'noopener')
    } catch (err) {
      alert('Не удалось открыть файл: ' + (err.message || err))
    }
  }

  const remove = async () => {
    if (!doc) return
    if (!window.confirm('Удалить понятийное соглашение?')) return
    setBusy(true)
    try {
      const { error } = await supabase
        .from('contracts')
        .update({ concept_agreement_s3_document_id: null })
        .eq('id', contract.id)
      if (error) throw error
      if (doc.id && doc.s3_key) { try { await deleteDocument(doc) } catch { /* best effort */ } }
      onChanged?.()
    } catch (err) {
      alert('Ошибка удаления: ' + (err.message || err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ca">
      <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={onFile} />
      {busy ? (
        <span className="ca-busy">Загрузка…</span>
      ) : doc ? (
        <div className="ca-has">
          <button type="button" className="ca-chip" onClick={open} title={`Понятийное соглашение: ${doc.file_name || ''}`}>
            <IconDoc />
            <span className="ca-chip-label">Понятийное соглашение</span>
          </button>
          {canEdit && (
            <span className="ca-actions">
              <button type="button" className="ca-mini" onClick={pick} title="Заменить файл" aria-label="Заменить">
                <IconReplace />
              </button>
              <button type="button" className="ca-mini ca-danger" onClick={remove} title="Удалить" aria-label="Удалить">
                <IconTrash />
              </button>
            </span>
          )}
        </div>
      ) : canEdit ? (
        <button type="button" className="ca-add" onClick={pick} title="Прикрепить понятийное соглашение">
          <IconPlus />
          <span className="ca-chip-label">Понятийное соглашение</span>
        </button>
      ) : null}
    </div>
  )
}
