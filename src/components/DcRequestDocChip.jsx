import { useEffect, useRef, useState } from 'react'
import { describeDocument, renameDocument } from '../services/s3'
import { composeFileName, fileNameProblem, splitFileName } from '../utils/fileRename'

// Строка файла в «Заявках на ДС». Надпись — описание файла, а его нет — имя (решение пользователя 03.11: на копии прода
// 15.10 описание есть у 804 файлов из 892). Нажатие правит то, что написано в строке; двойное нажатие скачивает файл.
// Без права правки нажатие открывает просмотр PDF и картинки. Ввод — состояние этой строки, не страницы: набор текста
// не перерисовывает реестр.
// details — размер и кто загрузил (для подсказки); onChanged(строка s3_documents) — родитель обновляет файл у себя.

// Первое нажатие ждёт второго: иначе двойное успело бы открыть правку или просмотр.
const DOUBLE_CLICK_MS = 300
const NOTE_MAX = 500 // как DOC_NOTE_MAX на сервере

function pressHint(canEdit, previewable) {
  if (canEdit) return 'Нажмите — изменить название, дважды — скачать'
  return previewable ? 'Нажмите — просмотр, дважды — скачать' : 'Дважды нажмите — скачать'
}

export default function DcRequestDocChip({ doc, details, canEdit, onPreview, onDownload, onDelete, onChanged }) {
  const [draft, setDraft] = useState(null) // введённая надпись; null — не правится
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState(null)
  const inputRef = useRef(null)
  const pressTimer = useRef(null)
  const editing = draft !== null

  const mime = (doc.mime_type || '').toLowerCase()
  const previewable = mime === 'application/pdf' || mime.startsWith('image/')
  const { stem, ext } = splitFileName(doc.file_name)

  useEffect(() => () => clearTimeout(pressTimer.current), [])

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  const press = () => {
    clearTimeout(pressTimer.current)
    pressTimer.current = setTimeout(() => {
      if (canEdit) {
        setProblem(null)
        setDraft(doc.notes || stem)
      } else if (previewable) {
        onPreview(doc)
      }
    }, DOUBLE_CLICK_MS)
  }

  const doublePress = () => {
    clearTimeout(pressTimer.current)
    onDownload(doc)
  }

  const cancel = () => {
    if (saving) return
    setDraft(null)
    setProblem(null)
  }

  const save = async (e) => {
    e.preventDefault()
    if (saving) return
    let write
    if (doc.notes) {
      const next = draft.trim()
      if (next === doc.notes) { cancel(); return }
      write = () => describeDocument(doc, next)
    } else {
      const next = composeFileName(draft, ext)
      if (next === doc.file_name) { cancel(); return }
      const bad = fileNameProblem(next, doc.file_name)
      if (bad) { setProblem(bad); return }
      write = () => renameDocument(doc, next)
    }
    setSaving(true)
    setProblem(null)
    try {
      const saved = await write()
      setDraft(null)
      onChanged(saved)
    } catch (err) {
      // Поле остаётся открытым: набранное не пропадает, причина видна.
      setProblem(err.message || 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <div className="dcr-doc-chip is-editing">
        {/* Строка бывает и внутри окна (итог проверки): Escape снимает только правку. */}
        <form
          className="dcr-doc-edit"
          onSubmit={save}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel() } }}
        >
          <span className="dcr-doc-edit-field">
            <input
              ref={inputRef}
              className="dcr-doc-edit-input"
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setProblem(null) }}
              readOnly={saving}
              maxLength={doc.notes ? NOTE_MAX : undefined}
              placeholder={doc.notes ? 'Пусто — в строке будет имя файла' : undefined}
              title={doc.notes ? `Имя файла: ${doc.file_name}` : undefined}
              aria-label={doc.notes ? 'Описание файла' : 'Новое имя файла'}
              aria-invalid={!!problem}
            />
            {!doc.notes && ext && <span className="dcr-doc-edit-ext">{ext}</span>}
          </span>
          <button type="submit" className="dcr-doc-edit-btn is-primary" disabled={saving}>{saving ? '…' : 'ОК'}</button>
          <button type="button" className="dcr-doc-edit-btn" onClick={cancel} disabled={saving}>Отмена</button>
          {problem && <span className="dcr-doc-edit-error" role="alert">{problem}</span>}
        </form>
      </div>
    )
  }

  const tooltip = [doc.file_name, doc.notes, details, pressHint(canEdit, previewable)].filter(Boolean).join('\n')
  return (
    <div className="dcr-doc-chip">
      <button type="button" className="dcr-doc-chip-main" onClick={press} onDoubleClick={doublePress} title={tooltip}>
        <svg
          className="dcr-doc-chip-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        {doc.notes
          ? <span className="dcr-doc-chip-desc">{doc.notes}</span>
          : <span className="dcr-doc-chip-desc dcr-doc-chip-desc-empty">{doc.file_name}</span>}
      </button>
      {previewable && (
        <button
          type="button"
          className="dcr-doc-chip-action"
          onClick={() => onPreview(doc)}
          title="Просмотр"
          aria-label="Просмотр"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className="dcr-doc-chip-action"
        onClick={() => onDownload(doc)}
        title="Скачать"
        aria-label="Скачать"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </button>
      {canEdit && (
        <button
          type="button"
          className="dcr-doc-chip-del"
          onClick={() => onDelete(doc)}
          title="Удалить"
          aria-label="Удалить"
        >×</button>
      )}
    </div>
  )
}
