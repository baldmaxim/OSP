import { useCallback, useEffect, useRef, useState } from 'react'
import { deleteDocument, fetchDocuments, uploadFile } from '../../services/s3'
import { takePrefetched } from '../../services/docCheckCard'
import { downloadS3File } from '../FileDownload'
import S3DocumentPreview from '../S3DocumentPreview'
import PaperclipIcon from '../icons/PaperclipIcon'
import { IconDownload, IconTrash } from '../icons/ActionIcons'
import { DOC_CHECK_CHAT_CATEGORY, DOC_CHECK_CONCEPT_CATEGORY, fmtDocDateTime, formatBytes } from '../../utils/docCheckHelpers'

// Файлы заявки на проверку ДП/ДС — в разделе «Документы» вкладки «Общая» (11.11.2026, решение пользователя: вкладки
// «Документы» больше нет, раздел разделён на две части). 1 — «Понятийное соглашение» (doc_category DOC_CHECK_CONCEPT_CATEGORY),
// 2 — «Загружаемые документы»: всё остальное, в том числе файлы, загруженные до разделения (у них категории нет).
//
// Список — строками, а не таблицей общего S3DocumentList: раздел стоит в колонке окна шириной около 28rem. Имя файла открывает
// просмотр (там же — переименовать, если можно менять), рядом — скачать и удалить. Файл можно перетащить на свою часть.
// Права — как у прежней вкладки: менять файлы может право правки раздела (база — s3_documents_doc_check_guard), скачать — любой,
// кто видит заявку; автор своей заявки в «Новых» — тоже менять (canEdit решает окно, note — пояснение ему). Один запрос на все части.
//
// Файлы обсуждения (20270216) — не документы заявки: в двух частях их нет. Отправленные в переписке — третьей частью «Из
// обсуждения», только просмотр и скачивание (отправленный файл не меняется и не удаляется никем); черновики вложений (сообщение
// не ушло) не показываются. Какие отправлены — postedChatIds (из сообщений); число изменилось — список перечитывается.

const OWNER = 'doc_check_request'
export const DOC_CHECK_FILE_PARTS = [
  { key: 'concept', title: 'Понятийное соглашение', category: DOC_CHECK_CONCEPT_CATEGORY, empty: 'Не загружено' },
  { key: 'files', title: 'Загружаемые документы', category: null, empty: 'Документы не загружены' },
  { key: 'chat', title: 'Из обсуждения', category: DOC_CHECK_CHAT_CATEGORY, readOnly: true },
]
const partOf = (doc) => (doc.doc_category === DOC_CHECK_CONCEPT_CATEGORY ? 'concept'
  : doc.doc_category === DOC_CHECK_CHAT_CATEGORY ? 'chat' : 'files')
const NO_POSTED = new Set()

const carriesFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files')

export default function DocCheckFiles({ requestId, canEdit, note = null, onChange, postedChatIds = NO_POSTED }) {
  const [docs, setDocs] = useState([])
  const [state, setState] = useState('loading') // loading | ready | error
  const [uploading, setUploading] = useState(null) // ключ части, куда грузим
  const [over, setOver] = useState(null)
  const [preview, setPreview] = useState(null)
  const inputs = useRef({})

  const load = useCallback(async () => {
    try {
      // Нажали на карточку — файлы уже читаются (prefetchCard); иначе — свой запрос.
      const list = await (takePrefetched(requestId, 'files') || fetchDocuments(OWNER, requestId))
      setDocs(list)
      setState('ready')
    } catch (err) {
      console.warn('Не удалось загрузить файлы заявки:', err.message)
      setState(prev => (prev === 'ready' ? prev : 'error'))
    }
  }, [requestId])
  useEffect(() => { load() }, [load])
  // Отправили файлы в переписке — перечитать (часть «Из обсуждения»), если их ещё нет среди прочитанных. При открытии окна
  // переписка и файлы читаются разом, и файлы переписки уже в списке — второй запрос не нужен (13.11.2026: окно открывалось
  // с лишним чтением файлов).
  const docsRef = useRef(docs)
  docsRef.current = docs
  useEffect(() => {
    if (state !== 'ready' || !postedChatIds.size) return
    const known = new Set(docsRef.current.map(d => d.id))
    if ([...postedChatIds].some(id => !known.has(id))) load()
  }, [postedChatIds, state, load])

  // Файлы — по одному: не загрузившийся не мешает остальным, причина — одним сообщением в конце.
  const upload = async (part, fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length || uploading) return
    setUploading(part.key)
    const failed = []
    for (const file of files) {
      try {
        const row = await uploadFile({ file, ownerType: 'doc_check_request', ownerId: requestId, category: part.category })
        if (row) setDocs(prev => [row, ...prev.filter(d => d.id !== row.id)])
      } catch (err) {
        failed.push(`${file.name}: ${err.message || err}`)
      }
    }
    setUploading(null)
    if (failed.length < files.length) onChange?.()
    if (failed.length) alert(`Не все файлы загрузились:\n${failed.join('\n')}`)
    load()
  }

  const remove = async (doc) => {
    if (!window.confirm(`Удалить файл «${doc.file_name}»?`)) return
    try {
      await deleteDocument(doc)
      setDocs(prev => prev.filter(d => d.id !== doc.id))
      onChange?.()
    } catch (err) {
      alert('Не удалось удалить файл: ' + (err.message || err))
    }
  }

  const download = async (doc) => {
    try {
      await downloadS3File(doc.s3_key, doc.file_name)
    } catch (err) {
      alert('Не удалось скачать файл: ' + (err.message || err))
    }
  }

  const renamed = (doc) => {
    setDocs(prev => prev.map(d => (d.id === doc.id ? { ...d, file_name: doc.file_name } : d)))
    onChange?.()
  }

  const dropProps = (part) => (canEdit ? {
    onDragOver: (e) => { if (carriesFiles(e)) { e.preventDefault(); setOver(part.key) } },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null) },
    onDrop: (e) => { if (!carriesFiles(e)) return; e.preventDefault(); setOver(null); upload(part, e.dataTransfer.files) },
  } : {})

  return (
    <div className="dc-files">
      {note && <p className="dc-files-note">{note}</p>}
      {state === 'error' && (
        <p className="dc-files-note">
          Не удалось загрузить список файлов.{' '}
          <button type="button" className="dc-retry" onClick={() => { setState('loading'); load() }}>Повторить</button>
        </p>
      )}
      {DOC_CHECK_FILE_PARTS.map((part, i) => {
        const list = docs.filter(d => partOf(d) === part.key && (part.key !== 'chat' || postedChatIds.has(d.id)))
        if (part.readOnly && !list.length) return null
        const editable = canEdit && !part.readOnly
        return (
          <section
            key={part.key}
            className={`dc-files-part${over === part.key ? ' is-over' : ''}`}
            data-part={part.key}
            aria-label={part.title}
            {...(editable ? dropProps(part) : {})}
          >
            <div className="dc-files-head">
              <span className="dc-files-num" aria-hidden="true">{i + 1}</span>
              <span className="dc-files-title">{part.title}</span>
              {list.length > 0 && <span className="dc-files-count">{list.length}</span>}
              {editable && (
                <>
                  <button
                    type="button"
                    className="dc-files-add"
                    disabled={!!uploading || state === 'loading'}
                    onClick={() => inputs.current[part.key]?.click()}
                  >{uploading === part.key ? 'Загрузка…' : '+ Загрузить'}</button>
                  <input
                    ref={(el) => { inputs.current[part.key] = el }}
                    type="file"
                    hidden
                    multiple
                    aria-label={`Загрузить: ${part.title}`}
                    onChange={(e) => { upload(part, e.target.files); e.target.value = '' }}
                  />
                </>
              )}
            </div>
            {state === 'loading' ? (
              <p className="dc-files-empty">Загрузка…</p>
            ) : state === 'error' ? null : list.length === 0 ? (
              <p className="dc-files-empty">{part.empty}{editable ? ' · можно перетащить файл сюда' : ''}</p>
            ) : (
              <ul className="dc-files-list">
                {list.map(doc => (
                  <li key={doc.id} className="dc-file">
                    <span className="dc-file-icon" aria-hidden="true"><PaperclipIcon size={14} /></span>
                    <div className="dc-file-main">
                      <button type="button" className="dc-file-name" title={`Открыть: ${doc.file_name}`} onClick={() => setPreview(doc)}>
                        {doc.file_name}
                      </button>
                      <span className="dc-file-meta">
                        {[doc.uploaded_by_name, fmtDocDateTime(doc.created_at), formatBytes(doc.size_bytes)].filter(Boolean).join(' · ')}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="dc-icon-btn dc-file-btn"
                      aria-label={`Скачать ${doc.file_name}`}
                      title="Скачать"
                      onClick={() => download(doc)}
                    ><IconDownload size={15} /></button>
                    {editable && (
                      <button
                        type="button"
                        className="dc-icon-btn dc-file-btn dc-file-del"
                        aria-label={`Удалить ${doc.file_name}`}
                        title="Удалить"
                        onClick={() => remove(doc)}
                      ><IconTrash size={15} /></button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}
      {preview && (
        <S3DocumentPreview
          doc={preview}
          onClose={() => setPreview(null)}
          onRenamed={canEdit && partOf(preview) !== 'chat' ? renamed : undefined}
        />
      )}
    </div>
  )
}
