import { useEffect, useRef, useState } from 'react'
import { loadSupplyDocs, normalizeLinkUrl } from '../../services/supplyPricing'
import { IconUpload } from '../icons/BsmIcons'
import { IconTrash } from '../icons/ActionIcons'

const LIST_MAX = 5
// Файл документа — не больше (счёт, КП и чек столько не весят; скан в хорошем качестве — до десятков МБ).
export const SUPPLY_DOC_MAX_BYTES = 50 * 1024 * 1024
const fmtSize = (n) => (n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} КБ` : `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`)
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '')

// Документ (чек, счёт, КП поставщика) строки таблицы или нескольких отмеченных: ссылка (адрес или сетевой путь) или файл —
// загрузить с компьютера или выбрать уже загруженный к этому тендеру (миграция 20261025; без неё — только ссылка). targets —
// [{ key, name, estimateName, link }]: каждая позиция каждого ВОР этих строк; у кого документ уже есть — он заменяется; у всех один и
// тот же — подставлен. rowCount — сколько строк таблицы, title — наименование первой. onSave({ url } | { docId, doc } | { file }):
// файл с компьютера (кнопкой или перетащить в окно) не ждёт подтверждения — сразу открывается окно всех расценок. «Убрать» — у тех, у
// кого документ есть. Удалить файл можно здесь же: он пропадёт у всех позиций, где он документ.
export default function SupplyLinkDialog({
  mainId, targets, rowCount = targets.length, title = targets[0]?.name, busy, error, filesOn = false, onSave, onRemove, onDeleteFile, onClose,
}) {
  const first = targets[0]?.link
  const sameLink = targets.length > 0 && targets.every((t) => t.link && (t.link.url || null) === (first?.url || null)
    && (t.link.s3_document_id || null) === (first?.s3_document_id || null))
  // Обычно прикладывают файл: вкладка «Ссылка» — сразу, только если у позиции уже стоит ссылка.
  const [mode, setMode] = useState(filesOn && !(sameLink && first?.url) ? 'file' : 'link')
  const [value, setValue] = useState(sameLink && first?.url ? first.url : '')
  const [invalid, setInvalid] = useState('')
  const [docs, setDocs] = useState(null) // файлы документов поставщиков тендера
  const [docsError, setDocsError] = useState('')
  const [picked, setPicked] = useState(sameLink && first?.s3_document_id ? first.s3_document_id : '')
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
  const one = rowCount === 1
  const names = [...new Set(targets.map((t) => t.name))]

  const submit = (e) => {
    e.preventDefault()
    if (mode === 'link') {
      const res = normalizeLinkUrl(value)
      if (res.error) { setInvalid(res.error); return }
      setInvalid('')
      onSave({ url: res.url })
      return
    }
    if (!picked) { setInvalid('Выберите файл с компьютера или из уже загруженных'); return }
    onSave({ docId: picked, doc: docs?.find((d) => d.id === picked) || null })
  }

  const chooseFile = (f) => {
    if (!f) return
    if (f.size > SUPPLY_DOC_MAX_BYTES) { setMode('file'); setInvalid(`Файл больше ${fmtSize(SUPPLY_DOC_MAX_BYTES)}`); return }
    setInvalid('')
    onSave({ file: f })
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
      chooseFile(e.dataTransfer.files?.[0])
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
        <h3 id="sp-link-title">{one ? 'Документ к позиции' : `Документ — ${rowCount} позициям`}</h3>
        <div className="sp-modal-body">
          {one
            ? <p className="sp-modal-lead">{title} <span className="sp-muted">· {vors.length > 1 ? `ВОР: ${vors.length}` : `ВОР «${vors[0]}»`}</span></p>
            : (
              <ul className="sp-link-targets">
                {names.slice(0, LIST_MAX).map((n) => <li key={n}>{n}</li>)}
                {names.length > LIST_MAX && <li className="sp-muted">и ещё {names.length - LIST_MAX}</li>}
              </ul>
            )}

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
              <div className={`sp-doc-upload sp-doc-drop${dragOver ? ' is-over' : ''}`}>
                <input ref={fileRef} type="file" hidden onChange={(e) => { chooseFile(e.target.files?.[0]); e.target.value = '' }} />
                <button type="button" className="btn-secondary" onClick={() => fileRef.current?.click()} disabled={busy}>
                  <IconUpload size={16} /> Загрузить с компьютера
                </button>
                <span className="sp-muted">или перетащите файл сюда · счёт, КП, чек — PDF, Excel, фото; до {fmtSize(SUPPLY_DOC_MAX_BYTES)}</span>
              </div>
              <p className="sp-muted sp-doc-hint">Сразу откроется окно расценок: цены из счёта подберутся к позициям сами.</p>
              <p className="sp-doc-list-title">или уже загруженный к этому тендеру:</p>
              {docs == null && <p className="sp-muted">Загружаем список файлов…</p>}
              {docsError && <p className="sp-error-text">Список файлов не загрузился: {docsError}</p>}
              {docs?.length === 0 && !docsError && <p className="sp-muted">Файлов документов поставщиков у тендера пока нет.</p>}
              {docs?.length > 0 && (
                <ul className="sp-doc-list" role="radiogroup" aria-label="Загруженные файлы">
                  {docs.map((d) => (
                    <li key={d.id} className={picked === d.id ? 'is-picked' : undefined}>
                      <label>
                        <input type="radio" name="sp-doc" checked={picked === d.id} disabled={busy}
                          onChange={() => { setPicked(d.id); setInvalid('') }} />
                        <span className="sp-doc-name">{d.file_name}</span>
                        <span className="sp-muted">{fmtDate(d.created_at)}{d.uploaded_by_name ? ` · ${d.uploaded_by_name}` : ''}{d.size_bytes ? ` · ${fmtSize(d.size_bytes)}` : ''}</span>
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
          {!one && withLink.length > 0 && <p className="sp-muted">У части позиций документ уже есть — он будет заменён.</p>}
        </div>
        <div className="sp-modal-actions">
          {withLink.length > 0 && (
            <button type="button" className="btn-secondary sp-link-remove" onClick={onRemove} disabled={busy}>
              Убрать документ
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Отмена</button>
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Сохраняем…' : one ? 'Сохранить' : `Прикрепить к ${rowCount}`}</button>
        </div>
      </form>
    </div>
  )
}
