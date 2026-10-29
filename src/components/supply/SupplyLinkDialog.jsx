import { useEffect, useRef, useState } from 'react'
import { loadSupplyDocs, normalizeLinkUrl } from '../../services/supplyPricing'
import { IconUpload } from '../icons/BsmIcons'
import { IconTrash } from '../icons/ActionIcons'
import PaperclipIcon from '../icons/PaperclipIcon'

const LIST_MAX = 5
// Файл документа — не больше (счёт, КП и чек столько не весят; скан в хорошем качестве — до десятков МБ).
export const SUPPLY_DOC_MAX_BYTES = 50 * 1024 * 1024
const fmtSize = (n) => (n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} КБ` : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`)
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '')

// Документ (чек, счёт, КП поставщика) одной позиции или нескольким отмеченным сразу: ссылка (адрес или сетевой
// путь) или файл — загрузить с компьютера или выбрать уже загруженный к этому тендеру (миграция 20261025; без неё —
// только ссылка). targets — [{ key, name, estimateName, link }]: у кого документ уже есть — он заменяется; у всех
// один и тот же — подставлен. onSave({ url } | { docId } | { file }); «Убрать» — у тех, у кого документ есть.
// Удалить файл можно здесь же: он пропадёт у всех позиций, где он документ. Файл с компьютера — кнопкой или
// перетащить в окно (в любое место); initialFile — файл, перетащенный на ячейку «Документ» таблицы: окно открывается
// сразу с ним. offerLines — id файла → сколько его строк «в похожих ценах» (подпись в списке).
export default function SupplyLinkDialog({
  mainId, targets, busy, error, filesOn = false, initialFile = null, offerLines = null, onSave, onRemove, onDeleteFile, onClose,
}) {
  const first = targets[0]?.link
  const sameLink = targets.length > 0 && targets.every((t) => t.link && (t.link.url || null) === (first?.url || null)
    && (t.link.s3_document_id || null) === (first?.s3_document_id || null))
  const [mode, setMode] = useState(filesOn && (initialFile || (sameLink && first?.s3_document_id)) ? 'file' : 'link')
  const [value, setValue] = useState(sameLink && first?.url ? first.url : '')
  const [invalid, setInvalid] = useState('')
  const [docs, setDocs] = useState(null) // файлы документов поставщиков тендера
  const [docsError, setDocsError] = useState('')
  const [picked, setPicked] = useState(!initialFile && sameLink && first?.s3_document_id ? first.s3_document_id : '')
  const [file, setFile] = useState(filesOn ? initialFile : null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef(null)
  const fileRef = useRef(null)

  useEffect(() => {
    if (mode === 'link') {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [mode])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => {
    if (mode !== 'file' || docs) return
    let alive = true
    loadSupplyDocs(mainId)
      .then((list) => { if (alive) setDocs(list) })
      .catch((e) => { if (alive) { setDocs([]); setDocsError(e.message) } })
    return () => { alive = false }
  }, [mode, docs, mainId])

  const withLink = targets.filter((t) => t.link)
  const vors = [...new Set(targets.map((t) => t.estimateName))]
  const one = targets.length === 1

  const submit = (e) => {
    e.preventDefault()
    if (mode === 'link') {
      const res = normalizeLinkUrl(value)
      if (res.error) { setInvalid(res.error); return }
      setInvalid('')
      onSave({ url: res.url })
      return
    }
    if (file) {
      if (file.size > SUPPLY_DOC_MAX_BYTES) { setInvalid(`Файл больше ${fmtSize(SUPPLY_DOC_MAX_BYTES)}`); return }
      onSave({ file })
      return
    }
    if (!picked) { setInvalid('Выберите файл с компьютера или из уже загруженных'); return }
    onSave({ docId: picked })
  }

  const chooseFile = (f) => {
    setInvalid('')
    setFile(f || null)
    if (f) setPicked('')
  }
  // Перетащили файл в окно — вкладка «Файл» с этим файлом (перетаскивают и текст — его не берём).
  const withFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files')
  const drop = filesOn && !busy ? {
    onDragOver: (e) => { if (withFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOver(true) } },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false) },
    onDrop: (e) => {
      if (!withFiles(e)) return
      e.preventDefault()
      setDragOver(false)
      const f = e.dataTransfer.files?.[0]
      if (!f) return
      setMode('file')
      chooseFile(f)
    },
  } : null

  const removeDoc = async (doc) => {
    const ok = await onDeleteFile?.(doc)
    if (ok) {
      setDocs((list) => (list || []).filter((d) => d.id !== doc.id))
      if (picked === doc.id) setPicked('')
    }
  }

  return (
    <div className="sp-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <form className={`sp-modal sp-modal-wide${dragOver ? ' is-drop' : ''}`} role="dialog" aria-modal="true" aria-labelledby="sp-link-title" onSubmit={submit} {...drop}>
        <h3 id="sp-link-title">{one ? 'Документ к позиции' : `Документ — ${targets.length} позициям`}</h3>
        <div className="sp-modal-body">
          {one
            ? <p className="sp-modal-lead">{targets[0].name} <span className="sp-muted">· ВОР «{targets[0].estimateName}»</span></p>
            : (
              <ul className="sp-link-targets">
                {targets.slice(0, LIST_MAX).map((t) => <li key={t.key}>{t.name}</li>)}
                {targets.length > LIST_MAX && <li className="sp-muted">и ещё {targets.length - LIST_MAX}</li>}
              </ul>
            )}
          {!one && vors.length > 1 && <p className="sp-muted">ВОР: {vors.map((d) => `«${d}»`).join(', ')}</p>}

          {filesOn && (
            <div className="sp-filter sp-doc-mode" role="tablist" aria-label="Вид документа">
              {[['link', 'Ссылка'], ['file', 'Файл']].map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={mode === k} className={`sp-filter-btn${mode === k ? ' active' : ''}`}
                  onClick={() => { setMode(k); setInvalid('') }} disabled={busy}>{label}</button>
              ))}
            </div>
          )}

          {mode === 'link' ? (
            <label className="sp-link-field">
              <span>Чек, счёт или КП поставщика — ссылка https://… или сетевой путь \\сервер\папка</span>
              <input
                ref={inputRef}
                type="text"
                inputMode="url"
                value={value}
                onChange={(e) => { setValue(e.target.value); setInvalid('') }}
                placeholder="https://"
                aria-invalid={!!invalid}
                aria-describedby={invalid ? 'sp-link-invalid' : undefined}
                disabled={busy}
              />
            </label>
          ) : (
            <div className="sp-doc-files">
              <div className={`sp-doc-upload sp-doc-drop${dragOver ? ' is-over' : ''}${file ? ' has-file' : ''}`}>
                <input ref={fileRef} type="file" hidden onChange={(e) => { chooseFile(e.target.files?.[0]); e.target.value = '' }} />
                <button type="button" className="btn-secondary" onClick={() => fileRef.current?.click()} disabled={busy}>
                  <IconUpload size={16} /> Загрузить с компьютера
                </button>
                {file
                  ? <span className="sp-doc-chosen"><PaperclipIcon size={14} /> {file.name} <span className="sp-muted">· {fmtSize(file.size)}</span>
                    <button type="button" className="sp-link-btn" onClick={() => chooseFile(null)} disabled={busy}>убрать</button></span>
                  : <span className="sp-muted">или перетащите файл сюда · счёт, КП, чек — PDF, Excel, фото; до {fmtSize(SUPPLY_DOC_MAX_BYTES)}</span>}
              </div>
              <p className="sp-doc-list-title">или уже загруженный к этому тендеру:</p>
              {docs == null && <p className="sp-muted">Загружаем список файлов…</p>}
              {docsError && <p className="sp-error-text">Список файлов не загрузился: {docsError}</p>}
              {docs?.length === 0 && !docsError && <p className="sp-muted">Файлов документов поставщиков у тендера пока нет.</p>}
              {docs?.length > 0 && (
                <ul className="sp-doc-list" role="radiogroup" aria-label="Загруженные файлы">
                  {docs.map((d) => (
                    <li key={d.id} className={picked === d.id && !file ? 'is-picked' : undefined}>
                      <label>
                        <input type="radio" name="sp-doc" checked={picked === d.id && !file} disabled={busy}
                          onChange={() => { setPicked(d.id); setFile(null); setInvalid('') }} />
                        <span className="sp-doc-name">{d.file_name}</span>
                        <span className="sp-muted">{fmtDate(d.created_at)}{d.uploaded_by_name ? ` · ${d.uploaded_by_name}` : ''}{d.size_bytes ? ` · ${fmtSize(d.size_bytes)}` : ''}
                          {offerLines?.get(d.id) ? ` · в похожих ценах (строк с ценой: ${offerLines.get(d.id)})` : ''}</span>
                      </label>
                      {onDeleteFile && (
                        <button type="button" className="sp-icon-btn" onClick={() => removeDoc(d)} disabled={busy}
                          aria-label={`Удалить файл «${d.file_name}»`} title="Удалить файл — пропадёт у всех позиций, где он документ">
                          <IconTrash size={16} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {invalid && <p id="sp-link-invalid" className="sp-error-text" role="alert">{invalid}</p>}
          {error && <p className="sp-error-text" role="alert">{error}</p>}
          {!one && withLink.length > 0 && (
            <p className="sp-muted">У {withLink.length} из {targets.length} позиций документ уже есть — он будет заменён.</p>
          )}
        </div>
        <div className="sp-modal-actions">
          {withLink.length > 0 && (
            <button type="button" className="btn-secondary sp-link-remove" onClick={onRemove} disabled={busy}>
              {one ? 'Убрать документ' : `Убрать документ (${withLink.length})`}
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Отмена</button>
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Сохраняем…' : one ? 'Сохранить' : `Прикрепить к ${targets.length}`}</button>
        </div>
      </form>
    </div>
  )
}
