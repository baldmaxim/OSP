import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { renameDocument, requestDownloadUrl } from '../services/s3'
import { composeFileName, fileNameProblem, splitFileName } from '../utils/fileRename'
import { previewKind } from '../utils/filePreview'
import { downloadS3File } from './FileDownload'
import { IconDownload, IconPencil } from './icons/ActionIcons'
import './S3DocumentList.css'

// Word и Excel — отдельными частями: библиотеки крупные, грузятся, только когда открыт такой файл.
const DocxPreview = lazy(() => import('./DocxPreview'))
const SheetPreview = lazy(() => import('./SheetPreview'))

// Модалка просмотра S3-документа. PDF и изображения рендерятся прямо в окне
// (iframe / <img>); Word (.docx) и Excel — с 13.11.2026 тоже (DocxPreview, SheetPreview), с кнопкой
// «Скачать» в шапке. Для остальных типов — fallback с кнопкой скачать.
// Стили живут в S3DocumentList.css — импортируем здесь, чтобы компонент
// можно было использовать независимо от S3DocumentList.
// onRenamed(строка s3_documents) — передаёт родитель тому, кому можно менять файлы этого списка: есть — в шапке кнопка
// «Переименовать», и родитель обновляет имя у себя. Меняется только подпись файла, просмотр не перезагружается.

export default function S3DocumentPreview({ doc, onClose, onRenamed }) {
  const [url, setUrl] = useState(null)
  const [error, setError] = useState(null)
  const [fileName, setFileName] = useState(doc.file_name)
  const [draft, setDraft] = useState(null) // введённое имя без расширения; null — имя не правится
  const [saving, setSaving] = useState(false)
  const [renameError, setRenameError] = useState(null)
  const inputRef = useRef(null)
  const editing = draft !== null
  const kind = previewKind(doc.mime_type, doc.file_name)
  const pdf = kind === 'pdf'
  const img = kind === 'image'
  // Word и Excel файл читают сами (по ключу), ссылка окну не нужна.
  const office = kind === 'docx' || kind === 'sheet'
  const { ext } = splitFileName(fileName)

  // Без предпросмотра ссылка — на скачивание под именем файла (иначе браузер сохранит ключ хранилища «uuid-имя»).
  // Ссылка PDF и картинки от имени не зависит: переименование не перезагружает просмотр.
  const linkName = pdf || img ? null : doc.file_name
  useEffect(() => {
    let cancelled = false
    setUrl(null)
    setError(null)
    if (office) return undefined
    requestDownloadUrl(doc.s3_key, linkName ? { fileName: linkName, download: true } : {})
      .then(({ presigned_url }) => { if (!cancelled) setUrl(presigned_url) })
      .catch(e => { if (!cancelled) setError(e.message || 'Не удалось получить ссылку') })
    return () => { cancelled = true }
  }, [doc.s3_key, linkName, office])

  useEffect(() => {
    setFileName(doc.file_name)
    setDraft(null)
    setRenameError(null)
  }, [doc.s3_key, doc.file_name])

  // Скачать — не уходя со страницы (FileDownload): прежняя ссылка открывала вкладку, и окно мигало.
  // Ссылка — свежая: полученная при открытии могла истечь, пока окно было открыто.
  const download = () => {
    downloadS3File(doc.s3_key, fileName).catch(e => setError(e.message || 'Не удалось скачать файл'))
  }

  const startRename = () => {
    setRenameError(null)
    setDraft(splitFileName(fileName).stem)
  }
  const cancelRename = () => {
    if (saving) return
    setDraft(null)
    setRenameError(null)
  }
  const saveRename = async (e) => {
    e.preventDefault()
    if (saving) return
    const next = composeFileName(draft, ext)
    if (next === fileName) { cancelRename(); return }
    const problem = fileNameProblem(next, fileName)
    if (problem) { setRenameError(problem); return }
    setSaving(true)
    setRenameError(null)
    try {
      const saved = await renameDocument(doc, next)
      setFileName(saved.file_name)
      setDraft(null)
      onRenamed(saved)
    } catch (err) {
      setRenameError(err.message || 'Не удалось переименовать файл')
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  // Escape во время правки имени снимает только правку, окно остаётся.
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'Escape') return
      if (editing) cancelRename()
      else onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  })

  // Пока окно превью открыто, страница позади не прокручивается: иначе колесо мыши
  // над модалкой скроллило список позади (scroll chaining). Ширину исчезнувшего
  // скроллбара компенсируем padding'ом, чтобы контент под модалкой не «дёргался».
  useEffect(() => {
    const { body } = document
    const prevOverflow = body.style.overflow
    const prevPaddingRight = body.style.paddingRight
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth
    body.style.overflow = 'hidden'
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`
    return () => {
      body.style.overflow = prevOverflow
      body.style.paddingRight = prevPaddingRight
    }
  }, [])

  return (
    // s3-doc-preview — окно почти во весь экран (S3DocumentList.css): каркас .s3-doc-modal общий с другими окнами.
    // Щелчок мимо окна во время правки имени не закрывает его: иначе пропал бы недописанный ввод.
    <div className="s3-doc-modal-overlay s3-doc-preview-overlay" onClick={editing ? undefined : onClose}>
      <div className="s3-doc-modal s3-doc-preview" onClick={(e) => e.stopPropagation()}>
        <div className="s3-doc-modal-header">
          {editing ? (
            // stopPropagation: Escape в поле не должен дойти до окна-родителя (у документа свои обработчики).
            <form
              className="s3-doc-rename"
              onSubmit={saveRename}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancelRename() } }}
            >
              <span className="s3-doc-rename-field">
                <input
                  ref={inputRef}
                  className="s3-doc-rename-input"
                  value={draft}
                  onChange={(e) => { setDraft(e.target.value); setRenameError(null) }}
                  disabled={saving}
                  aria-label="Новое имя файла"
                  aria-invalid={!!renameError}
                />
                {ext && <span className="s3-doc-rename-ext">{ext}</span>}
              </span>
              <button type="submit" className="s3-doc-btn-primary" disabled={saving}>{saving ? 'Сохраняем…' : 'Сохранить'}</button>
              <button type="button" className="s3-doc-rename-cancel" onClick={cancelRename} disabled={saving}>Отмена</button>
              {renameError && <span className="s3-doc-rename-error" role="alert">{renameError}</span>}
            </form>
          ) : (
            <div className="s3-doc-preview-name">
              <span className="s3-doc-modal-title" title={fileName}>{fileName}</span>
              {onRenamed && (
                <button type="button" className="s3-doc-rename-btn" onClick={startRename}>
                  <IconPencil size={14} /> Переименовать
                </button>
              )}
              {office && (
                <button type="button" className="s3-doc-rename-btn" onClick={download}>
                  <IconDownload size={14} /> Скачать
                </button>
              )}
            </div>
          )}
          <button type="button" className="s3-doc-modal-close" onClick={onClose} aria-label="Закрыть">✕</button>
        </div>
        <div className="s3-doc-modal-body">
          {error && <div className="s3-doc-error" style={{ margin: 'auto' }}>Ошибка: {error}</div>}
          {office && (
            <Suspense fallback={<div className="s3-doc-empty" style={{ margin: 'auto' }}>Открываем…</div>}>
              {kind === 'docx' ? <DocxPreview s3Key={doc.s3_key} /> : <SheetPreview s3Key={doc.s3_key} />}
            </Suspense>
          )}
          {!office && !url && !error && <div className="s3-doc-empty" style={{ margin: 'auto' }}>Получение ссылки…</div>}
          {url && pdf && (
            <iframe src={url} className="s3-doc-modal-frame" title={fileName} />
          )}
          {url && !pdf && img && (
            <img src={url} className="s3-doc-modal-img" alt={fileName} />
          )}
          {url && !pdf && !img && !office && (
            <div className="s3-doc-preview-fallback">
              <p>Предпросмотр для этого типа файла не поддерживается.</p>
              <button type="button" className="s3-doc-btn-primary" onClick={download}>
                <IconDownload /> Скачать «{fileName}»
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
