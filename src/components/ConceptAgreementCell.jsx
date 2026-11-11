import { useRef, useState } from 'react'
import { uploadFile, deleteDocument } from '../services/s3'
import S3DocumentPreview from './S3DocumentPreview'
import AnchoredPopover from './AnchoredPopover'
import './ConceptAgreementCell.css'

// «Понятийное соглашение» договора — документы-основания для заключения договора
// (с визой акционера). Согласований может быть НЕСКОЛЬКО, поэтому это список файлов,
// хранящихся в S3 как s3_documents(owner_type='contract', doc_category='concept_agreement').
//
// В реестре — отметкой рядом с путями документа (11.11.2026: реестр разгружен, раньше в каждой строке стояли имена
// файлов и «+ Понятийное соглашение»): есть файлы — зелёное «ПС» (несколько — с числом), нажатие открывает список:
// имя — просмотр, корзина — удалить, «Добавить ещё»; нет — у права правки серое «+ ПС» (сразу выбор файла), без
// права — ничего. Пропсы: files — массив s3_documents; contractId; canEdit; onChanged — перечитать файлы
// этого договора (async; «Загрузка…» держится, пока список не обновится).

const CATEGORY = 'concept_agreement'

const IconDoc = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
)
const IconPlus = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
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

export default function ConceptAgreementCell({ files = [], contractId, canEdit = false, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [previewDoc, setPreviewDoc] = useState(null)
  const [listAnchor, setListAnchor] = useState(null)
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
    await onChanged?.()
    setBusy(false)
    if (failed.length) alert('Не удалось загрузить: ' + failed.join(', '))
  }

  const remove = async (doc) => {
    if (!window.confirm(`Удалить понятийное соглашение «${doc.file_name || ''}»?`)) return
    // Последний файл — окно списка закрывается: на его месте будет «+ ПС».
    if (files.length <= 1) setListAnchor(null)
    setBusy(true)
    try {
      await deleteDocument(doc)
      await onChanged?.()
    } catch (err) {
      alert('Ошибка удаления: ' + (err.message || err))
    } finally {
      setBusy(false)
    }
  }

  if (!files.length && !canEdit) return null
  const names = files.map(f => f.file_name || 'без имени').join('\n')

  return (
    <span className="ca">
      <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={onFiles} />

      {/* Отметка с файлами остаётся той же кнопкой и во время загрузки: к ней привязано открытое окно списка. */}
      {files.length > 0 ? (
        <button
          type="button"
          className={`ca-mark is-on${busy ? ' is-busy' : ''}`}
          title={busy ? 'Загрузка…' : `Понятийное соглашение:\n${names}`}
          aria-label={`Понятийное соглашение: ${files.length}`}
          aria-expanded={!!listAnchor}
          onClick={(e) => { e.stopPropagation(); setListAnchor(listAnchor ? null : e.currentTarget) }}
        >
          <IconDoc /> ПС{files.length > 1 && <span className="ca-mark-count">{files.length}</span>}{busy && '…'}
        </button>
      ) : busy ? (
        <span className="ca-mark is-busy">Загрузка…</span>
      ) : (
        <button
          type="button"
          className="ca-mark is-add"
          title="Прикрепить понятийное соглашение (можно несколько)"
          aria-label="Прикрепить понятийное соглашение"
          onClick={(e) => { e.stopPropagation(); pick() }}
        ><IconPlus /> ПС</button>
      )}

      {listAnchor && files.length > 0 && (
        <AnchoredPopover anchor={listAnchor} onClose={() => setListAnchor(null)} label="Понятийное соглашение" className="ca-pop">
          <div className="ca-pop-title">Понятийное соглашение</div>
          <ul className="ca-pop-list">
            {files.map(doc => (
              <li className="ca-has" key={doc.id}>
                <button
                  type="button"
                  className="ca-chip"
                  title={`Открыть: ${doc.file_name || ''}`}
                  onClick={() => { setListAnchor(null); setPreviewDoc(doc) }}
                >
                  <IconDoc />
                  <span className="ca-chip-label">{doc.file_name || 'Понятийное соглашение'}</span>
                </button>
                {canEdit && (
                  <button type="button" className="ca-mini ca-danger" onClick={() => remove(doc)} disabled={busy} title="Удалить" aria-label={`Удалить ${doc.file_name || ''}`}>
                    <IconTrash />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {canEdit && (
            <button type="button" className="ca-add" onClick={() => { setListAnchor(null); pick() }} disabled={busy}>
              <IconPlus /> Добавить ещё
            </button>
          )}
        </AnchoredPopover>
      )}

      {previewDoc && (
        <S3DocumentPreview doc={previewDoc} onClose={() => setPreviewDoc(null)} onRenamed={canEdit ? () => onChanged?.() : undefined} />
      )}
    </span>
  )
}
