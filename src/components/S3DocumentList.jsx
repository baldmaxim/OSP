import { useCallback, useEffect, useRef, useState } from 'react'
import { useRole } from '../contexts/RoleContext'
import { deleteDocument, fetchDocuments, uploadFile } from '../services/s3'
import { downloadS3File } from './FileDownload'
import S3DocumentPreview from './S3DocumentPreview'
import DocListZipButton from './DocListZipButton'
import {
  filesCountLabel, folderDateForUpload, groupDocsByDay, hasFolderDate, localTime, todayKey, uploadedOtherDay,
} from '../utils/docDateFolders'
import './S3DocumentList.css'

// Универсальный список S3-документов для произвольной сущности.
// Использование:
//   <S3DocumentList ownerType="tender" ownerId={tenderId} title="Документы" />
// Права: сотрудники (isEmployee) могут загружать/удалять; подрядчики — только просмотр.
// canEdit можно явно переопределить пропом (например, для разделов с другой политикой). canDelete — удаление и
// переименование (по умолчанию = canEdit): сервер меняет файлы по праву правки раздела, а загружать бывает можно и с
// просмотром (файлы договора — server/osp-api/src/routes/s3Presign.js, CHANGE_RULES). canDeleteDoc(doc) — ещё и по самому
// файлу (файл задачи меняют загрузивший, постановщик и администратор).
// downloadAllOwner — кнопка «Скачать всё» (все файлы списка одним ZIP «<владелец> — <title>.zip», DocListZipButton);
// без пропа кнопки нет. Видна всем, кто видит список: скачивание — по тому же праву, что и одного файла.
// dateFolders — файлы по папкам дня загрузки (utils/docDateFolders.js): новая папка открыта, прежние свёрнуты; «Загрузить»
// кладёт в папку сегодняшнего дня. В уже существующую папку (19.11.2026) — кнопкой «+ в папку» у папки или перетаскиванием
// файлов на папку; брошенное на список вне папок — в сегодняшнюю. Прежняя папка — только когда в базе есть
// s3_documents.folder_date (20270220), иначе у прежних папок кнопки нет, а брошенное на них ложится в сегодняшнюю.
// Без пропа — плоский список, как прежде, без перетаскивания.
// Несколько файлов за раз: ошибка одного не останавливает остальные; в конце — список незагруженных. На кнопке — ход:
// «Файл 2 из 5 · 45 %» (повтор — «попытка 2 из 3»); встала отправка или молчит сервер — ошибка этого файла (src/api/storagePut.js),
// а не вечная «Загрузка».

// Аккуратные inline SVG-иконки (вместо эмодзи, которые на части систем рендерятся криво).
const Icon = ({ children }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)
const EyeIcon = () => <Icon><circle cx="12" cy="12" r="3" /><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /></Icon>
const DownloadIcon = () => <Icon><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></Icon>
const TrashIcon = () => <Icon><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></Icon>
const UploadIcon = () => <Icon><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" /></Icon>
const FolderIcon = () => <Icon><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></Icon>
const ChevronIcon = () => <Icon><path d="m9 6 6 6-6 6" /></Icon>
const PlusIcon = () => <Icon><path d="M12 5v14" /><path d="M5 12h14" /></Icon>

// Ход загрузки на кнопке: «Загрузка: 45 %», несколько файлов — «Файл 2 из 5 · 45 %»; подтверждение — «сохранение»;
// отправка повторяется после обрыва — «попытка 2 из 3», чтобы повтор не выглядел зависанием.
function progressLabel(p) {
  if (!p) return 'Загрузка…'
  const pct = p.size > 0 ? Math.min(100, Math.floor((p.loaded * 100) / p.size)) : 0
  const retry = p.stage === 'send' && p.attempt > 1 ? ` · попытка ${p.attempt} из ${p.attempts}` : ''
  const step = p.stage === 'save' ? 'сохранение' : p.stage === 'send' ? `${pct} %${retry}` : 'подготовка'
  return p.total > 1 ? `Файл ${p.done + 1} из ${p.total} · ${step}` : `Загрузка: ${step}`
}

// Перетаскивают файлы (а не текст или строку таблицы).
const dragsFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files')

// Ключ «бросили на список вне папок» — в папку сегодняшнего дня.
const DROP_LIST = '__list__'

// Сколько незагруженных файлов перечислять в сообщении.
const FAILED_SHOWN = 10

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

export default function S3DocumentList({ ownerType, ownerId, title = 'Документы', canEdit: canEditProp, canDelete: canDeleteProp, canDeleteDoc = null, category = null, excludeCategory = null, downloadAllOwner = null, dateFolders = false, onChange }) {
  const { isEmployee } = useRole()
  const canEdit = canEditProp !== undefined ? canEditProp : isEmployee
  const canDelete = canDeleteProp !== undefined ? canDeleteProp : canEdit

  const [documents, setDocuments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [uploading, setUploading] = useState(false)
  // { done, total, stage, loaded, size } — пока идёт загрузка: какой файл по счёту и сколько его отправлено.
  const [uploadProgress, setUploadProgress] = useState(null)
  // Папка, в которую выбирают файлы кнопкой «+ в папку» (null — «Загрузить», папка сегодняшнего дня).
  const pickFolderRef = useRef(null)
  // Куда сейчас тянут файлы: ключ папки, DROP_LIST или null. Счётчик — dragenter/dragleave вложенных элементов.
  const [dropKey, setDropKey] = useState(null)
  const dragDepth = useRef(0)
  // Папки, раскрытые или свёрнутые вручную: день → true/false; остальные — по умолчанию (открыта только новая).
  const [folderOpen, setFolderOpen] = useState({})
  const [previewDoc, setPreviewDoc] = useState(null)
  const fileInputRef = useRef(null)

  const reload = useCallback(async () => {
    if (!ownerId) return
    setLoading(true)
    setError(null)
    try {
      const list = await fetchDocuments(ownerType, ownerId, category)
      // Служебные категории (напр. шаблон согласования) не показываем в общем списке.
      setDocuments(excludeCategory ? list.filter((d) => d.doc_category !== excludeCategory) : list)
    } catch (e) {
      setError(e.message || 'Не удалось загрузить список документов')
    } finally {
      setLoading(false)
    }
  }, [ownerType, ownerId, category, excludeCategory])

  useEffect(() => { reload() }, [reload])

  // Загрузка списка файлов в папку folderKey (null — сегодняшняя). Прежняя папка — днём в folder_date, сегодняшняя — без него.
  const uploadFiles = async (files, folderKey = null) => {
    if (files.length === 0 || uploading) return
    const folderDate = dateFolders ? folderDateForUpload(folderKey) : null
    setUploading(true)
    setUploadProgress({ done: 0, total: files.length, stage: 'prepare', loaded: 0, size: files[0].size })
    const failed = []
    try {
      for (const [i, file] of files.entries()) {
        const onProgress = ({ stage, loaded, attempt, attempts }) => setUploadProgress({ done: i, total: files.length, stage, loaded, size: file.size, attempt, attempts })
        try {
          await uploadFile({ file, ownerType, ownerId, category, folderDate, onProgress })
        } catch (err) {
          failed.push({ name: file.name, message: err?.message || String(err) })
        }
        setUploadProgress({ done: i + 1, total: files.length, stage: 'prepare', loaded: 0, size: files[i + 1]?.size || 0 })
      }
    } finally {
      setUploading(false)
      setUploadProgress(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
    // Загруженные показываем и тогда, когда часть файлов не прошла; папку, куда клали, — раскрытой.
    if (failed.length < files.length) {
      if (dateFolders) setFolderOpen((prev) => ({ ...prev, [folderKey || todayKey()]: true }))
      await reload()
      onChange?.()
    }
    if (failed.length === 1 && files.length === 1) {
      alert('Ошибка загрузки: ' + failed[0].message)
    } else if (failed.length) {
      const lines = failed.slice(0, FAILED_SHOWN).map((f) => `• ${f.name}: ${f.message}`)
      if (failed.length > FAILED_SHOWN) lines.push(`…и ещё ${failed.length - FAILED_SHOWN}`)
      alert(`Не загружено ${failed.length} из ${files.length}:\n${lines.join('\n')}`)
    }
  }

  const handlePickFiles = (e) => {
    const files = Array.from(e.target.files || [])
    const folderKey = pickFolderRef.current
    pickFolderRef.current = null
    uploadFiles(files, folderKey)
  }

  const pickInto = (folderKey) => {
    pickFolderRef.current = folderKey
    fileInputRef.current?.click()
  }

  // Перетаскивание (только список с папками и у кого есть загрузка). Папка под указателем — по data-folder-key её строк; прежняя
  // папка без колонки в базе не принимает — брошенное ложится в сегодняшнюю, и подсвечивается весь список.
  const canFolderDate = dateFolders && hasFolderDate(documents)
  const today = todayKey()
  const dropEnabled = dateFolders && canEdit && !!ownerId
  const dropTargetOf = (e) => {
    const key = e.target?.closest?.('[data-folder-key]')?.getAttribute('data-folder-key')
    return key && (key === today || canFolderDate) ? key : DROP_LIST
  }
  const dropHandlers = dropEnabled ? {
    onDragEnter: (e) => {
      if (!dragsFiles(e)) return
      e.preventDefault()
      dragDepth.current += 1
      setDropKey(dropTargetOf(e))
    },
    onDragOver: (e) => {
      if (!dragsFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = uploading ? 'none' : 'copy'
      const key = dropTargetOf(e)
      setDropKey((prev) => (prev === key ? prev : key))
    },
    onDragLeave: (e) => {
      if (!dragsFiles(e)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDropKey(null)
    },
    onDrop: (e) => {
      if (!dragsFiles(e)) return
      e.preventDefault()
      const key = dropTargetOf(e)
      dragDepth.current = 0
      setDropKey(null)
      uploadFiles(Array.from(e.dataTransfer.files || []), key === DROP_LIST ? null : key)
    },
  } : {}
  // Промахнулись мимо списка — браузер открыл бы файл вместо страницы (и всё несохранённое пропало бы): пока список с
  // перетаскиванием на экране, брошенный мимо файл просто не принимается. Попавший в список уже обработан (defaultPrevented).
  useEffect(() => {
    if (!dropEnabled) return undefined
    const refuse = (e) => {
      if (e.defaultPrevented || !dragsFiles(e)) return
      e.preventDefault()
      if (e.type === 'dragover') e.dataTransfer.dropEffect = 'none'
    }
    window.addEventListener('dragover', refuse)
    window.addEventListener('drop', refuse)
    return () => {
      window.removeEventListener('dragover', refuse)
      window.removeEventListener('drop', refuse)
    }
  }, [dropEnabled])

  const dropFolderLabel = dropKey && dropKey !== DROP_LIST
    ? (groupDocsByDay(documents).find((f) => f.key === dropKey)?.label || '')
    : ''

  const toggleFolder = (key, open) => setFolderOpen((prev) => ({ ...prev, [key]: !open }))

  const renderRow = (doc, when) => (
    <tr key={doc.id}>
      <td className="s3-doc-name">{doc.file_name}</td>
      <td>{formatBytes(doc.size_bytes)}</td>
      <td>{doc.uploaded_by_name || '—'}</td>
      <td className="s3-doc-when" title={dateFolders ? `Загружен ${formatDateTime(doc.created_at)}` : undefined}>{when}</td>
      <td className="s3-doc-actions">
        <button type="button" title="Просмотр" aria-label="Просмотр" onClick={() => setPreviewDoc(doc)}><EyeIcon /></button>
        <button type="button" title="Скачать" aria-label="Скачать" onClick={() => handleDownload(doc)}><DownloadIcon /></button>
        {canDelete && (!canDeleteDoc || canDeleteDoc(doc)) && (
          <button
            type="button"
            title="Удалить"
            aria-label="Удалить"
            className="s3-doc-btn-danger"
            onClick={() => handleDelete(doc)}
          ><TrashIcon /></button>
        )}
      </td>
    </tr>
  )

  const handleDownload = async (doc) => {
    try {
      await downloadS3File(doc.s3_key, doc.file_name)
    } catch (err) {
      alert('Ошибка скачивания: ' + (err.message || err))
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

  const handleRenamed = (doc) => {
    setDocuments(prev => prev.map(d => (d.id === doc.id ? { ...d, file_name: doc.file_name } : d)))
    onChange?.()
  }

  return (
    <div
      className={`s3-doc-list${dropKey === DROP_LIST ? ' is-drop-target' : ''}${dropKey ? ' is-dragging' : ''}`}
      {...dropHandlers}
    >
      <div className="s3-doc-toolbar">
        <h3 className="s3-doc-title">{title}</h3>
        <div className="s3-doc-toolbar-actions">
          {downloadAllOwner != null && !loading && documents.length > 0 && (
            <DocListZipButton docs={documents} ownerName={downloadAllOwner} title={title} />
          )}
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
                onClick={() => pickInto(null)}
                disabled={uploading || !ownerId}
                aria-live="polite"
                title={dateFolders
                  ? 'Можно выбрать несколько файлов — они лягут в папку с сегодняшней датой. В прежнюю папку — «+ в папку» или перетащите файлы на неё'
                  : undefined}
              >
                <UploadIcon />
                {!uploading ? 'Загрузить' : progressLabel(uploadProgress)}
              </button>
            </>
          )}
        </div>
      </div>

      {loading && <div className="s3-doc-empty">Загрузка списка…</div>}
      {error && <div className="s3-doc-error">Ошибка: {error}</div>}
      {!loading && !error && documents.length === 0 && (
        <div className="s3-doc-empty">{dropEnabled ? 'Документы не загружены — нажмите «Загрузить» или перетащите файлы сюда' : 'Документы не загружены'}</div>
      )}
      {dropKey && (
        <div className="s3-doc-drop-hint" role="status">
          {dropFolderLabel ? `Отпустите — файлы лягут в папку ${dropFolderLabel}` : 'Отпустите — файлы лягут в папку с сегодняшней датой'}
        </div>
      )}

      {!loading && documents.length > 0 && (
        <table className="s3-doc-table">
          <thead>
            <tr>
              <th>Название</th>
              <th>Размер</th>
              <th>Кто загрузил</th>
              <th>{dateFolders ? 'Время' : 'Когда'}</th>
              <th className="s3-doc-actions-col">Действия</th>
            </tr>
          </thead>
          {dateFolders ? groupDocsByDay(documents).map((folder, i) => {
            const open = folderOpen[folder.key] ?? i === 0
            // В прежнюю папку — только с колонкой folder_date; в сегодняшнюю — всегда; «Без даты» — нет.
            const canAddHere = canEdit && !!folder.key && (folder.key === today || canFolderDate)
            return (
              <tbody
                key={folder.key || 'no-date'}
                className={`s3-doc-folder${dropKey && dropKey === folder.key ? ' is-drop-target' : ''}`}
                data-folder-key={folder.key || undefined}
              >
                <tr className="s3-doc-folder-row">
                  <td colSpan={5}>
                    <div className="s3-doc-folder-head">
                      <button
                        type="button"
                        className={`s3-doc-folder-toggle${open ? ' is-open' : ''}`}
                        aria-expanded={open}
                        onClick={() => toggleFolder(folder.key, open)}
                      >
                        <span className="s3-doc-folder-chevron"><ChevronIcon /></span>
                        <FolderIcon />
                        <span className="s3-doc-folder-date">{folder.label}</span>
                        <span className="s3-doc-folder-count">{filesCountLabel(folder.docs.length)}</span>
                      </button>
                      {canAddHere && (
                        <button
                          type="button"
                          className="s3-doc-folder-add"
                          onClick={() => pickInto(folder.key)}
                          disabled={uploading}
                          aria-label={`Загрузить файлы в папку ${folder.label}`}
                          title={`Загрузить файлы в папку ${folder.label} (или перетащите их на папку)`}
                        >
                          <PlusIcon />
                          <span>в папку</span>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                {open && folder.docs.map((doc) => renderRow(doc, uploadedOtherDay(doc) ? formatDateTime(doc.created_at) : localTime(doc.created_at)))}
              </tbody>
            )
          }) : (
            <tbody>
              {documents.map((doc) => renderRow(doc, formatDateTime(doc.created_at)))}
            </tbody>
          )}
        </table>
      )}

      {previewDoc && (
        <S3DocumentPreview doc={previewDoc} onClose={() => setPreviewDoc(null)} onRenamed={canDelete && (!canDeleteDoc || canDeleteDoc(previewDoc)) ? handleRenamed : undefined} />
      )}
    </div>
  )
}
