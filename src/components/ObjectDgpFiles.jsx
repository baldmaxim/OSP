import { useCallback, useEffect, useRef, useState } from 'react'
import { deleteDocument, fetchDocuments, requestDownloadUrl, uploadFile } from '../services/s3'
import { formatAmount } from '../utils/money'
import {
  DGP_BY_KIND, DGP_KINDS, dgpNotes, parseDgpNotes, planDgpUpload, readDgpWorkbook,
} from '../utils/dgpWorkbook'
import { IconDownload, IconTrash } from './icons/ActionIcons'
import './ObjectDgpFiles.css'

// Вкладка «Смета» карточки объекта: ДГП (единый ПСДЦ договора генподряда) — комплектный и полный.
// Одна кнопка «Загрузить ДГП»: можно выбрать один или оба файла сразу, вид каждого определяется по шапке
// таблицы (utils/dgpWorkbook.js). Не определился, оба одного вида — человек выбирает вид в окне.
// Файлы — s3_documents объекта (owner_type 'object') с категориями dgp_compact / dgp_full; заголовок и
// сумма из файла — в notes, чтобы показывать их без скачивания. Новый файл того же вида заменяет прежний:
// сначала загружается новый, потом удаляется старый — сбой не оставляет вид без файла.

const ACCEPT = '.xlsx,.xlsm,.xls'

function formatBytes(bytes) {
  if (bytes == null) return ''
  const units = ['Б', 'КБ', 'МБ', 'ГБ']
  let v = Number(bytes)
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toLocaleString('ru-RU', { maximumFractionDigits: i === 0 ? 0 : 1 })} ${units[i]}`
}

const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '')

function DgpCard({ kind, docs, canEdit, busy, onDownload, onRemove }) {
  const meta = DGP_BY_KIND[kind]
  const doc = docs[0] || null
  const info = parseDgpNotes(doc?.notes)
  return (
    <section className={`dgp-card${doc ? '' : ' is-empty'}`} aria-label={`ДГП — ${meta.label.toLowerCase()}`}>
      <header className="dgp-card-head">
        <span className="dgp-card-kind">{meta.label}</span>
        <span className="dgp-card-hint">{meta.hint}</span>
      </header>
      {!doc ? (
        <p className="dgp-card-empty">Не загружен</p>
      ) : (
        <>
          {info?.title && <div className="dgp-card-title">{info.title}</div>}
          {info?.subtitle && <div className="dgp-card-subtitle">{info.subtitle}</div>}
          {info?.total != null && (
            <div className="dgp-card-total">
              <span className="dgp-card-total-label">{info.totalLabel || 'Сумма'}</span>
              <span className="dgp-card-total-value">{formatAmount(info.total)} ₽</span>
            </div>
          )}
          <div className="dgp-card-file">
            <span className="dgp-card-file-name" title={doc.file_name}>{doc.file_name}</span>
            <span className="dgp-card-file-meta">
              {[formatBytes(doc.size_bytes), formatDate(doc.created_at), doc.uploaded_by_name].filter(Boolean).join(' · ')}
            </span>
          </div>
          <div className="dgp-card-actions">
            <button type="button" className="btn-secondary-sm dgp-btn" onClick={() => onDownload(doc)} disabled={busy}>
              <IconDownload size={14} /> Скачать
            </button>
            {canEdit && (
              <button type="button" className="btn-danger-sm dgp-btn" onClick={() => onRemove(doc)} disabled={busy}
                aria-label={`Удалить ${meta.label.toLowerCase()} ДГП`}>
                <IconTrash size={14} /> Удалить
              </button>
            )}
          </div>
          {docs.length > 1 && (
            <p className="dgp-card-extra">Есть ещё {docs.length - 1} прежн. файл(а) этого вида — прежний не удалился при замене.</p>
          )}
        </>
      )}
    </section>
  )
}

// Окно выбора вида: вид не определился или два файла одного вида.
function DgpKindDialog({ items, current, onCancel, onConfirm }) {
  const [assign, setAssign] = useState(() => items.map(i => i.kind || ''))
  const valid = assign.every(Boolean) && new Set(assign).size === assign.length
  const sameKind = items.length > 1 && items.every(i => i.info.kind)
    && new Set(items.map(i => i.info.kind)).size < items.length
  return (
    <div className="modal-overlay">
      <div className="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="dgp-dialog-title">
        <div className="modal-header">
          <h3 id="dgp-dialog-title">Вид ДГП</h3>
          <button type="button" onClick={onCancel} aria-label="Закрыть">×</button>
        </div>
        <div className="dgp-dialog-body">
          <p className="dgp-dialog-note">
            {sameKind
              ? 'Оба файла похожи на один вид ДГП. Укажите, какой из них комплектный, а какой полный.'
              : 'Вид ДГП не удалось определить по шапке таблицы. Укажите его.'}
          </p>
          {items.map((item, idx) => {
            const replaced = assign[idx] ? current[assign[idx]]?.[0] : null
            return (
              <div key={idx} className="dgp-dialog-row">
                <div className="dgp-dialog-file" title={item.file.name}>{item.file.name}</div>
                {item.info.title && <div className="dgp-dialog-title">{item.info.title}</div>}
                <div className="dgp-dialog-kinds" role="radiogroup" aria-label={`Вид файла ${item.file.name}`}>
                  {DGP_KINDS.map(k => (
                    <label key={k.kind} className={`dgp-kind-option${assign[idx] === k.kind ? ' is-active' : ''}`}>
                      <input
                        type="radio"
                        name={`dgp-kind-${idx}`}
                        value={k.kind}
                        checked={assign[idx] === k.kind}
                        onChange={() => setAssign(prev => prev.map((v, j) => (j === idx ? k.kind : v)))}
                      />
                      {k.label}
                    </label>
                  ))}
                </div>
                {replaced && <div className="dgp-dialog-replace">заменит «{replaced.file_name}»</div>}
              </div>
            )
          })}
          <div className="modal-footer">
            <button type="button" className="btn-cancel" onClick={onCancel}>Отмена</button>
            <button type="button" className="btn-save" disabled={!valid} onClick={() => onConfirm(assign)}>Загрузить</button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ObjectDgpFiles({ objectId, canEdit }) {
  const inputRef = useRef(null)
  const [docs, setDocs] = useState({ compact: [], full: [] })
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('') // «Читаем файл…» / «Загружаем…»
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(null) // [{ file, info, kind }] — ждут выбора вида

  const load = useCallback(async () => {
    try {
      const lists = await Promise.all(DGP_KINDS.map(k => fetchDocuments('object', objectId, k.category)))
      setDocs(Object.fromEntries(DGP_KINDS.map((k, i) => [k.kind, lists[i]])))
    } catch (err) {
      console.error('Ошибка загрузки ДГП объекта:', err.message)
      setError('Не удалось загрузить список ДГП: ' + err.message)
    } finally {
      setLoading(false)
    }
  }, [objectId])

  useEffect(() => { load() }, [load])

  const upload = async (items, assign) => {
    setStatus('Загружаем…')
    setError(null)
    const failed = []
    for (let i = 0; i < items.length; i++) {
      const { file, info } = items[i]
      const meta = DGP_BY_KIND[assign[i]]
      const previous = docs[meta.kind] || []
      try {
        await uploadFile({
          file,
          ownerType: 'object',
          ownerId: objectId,
          category: meta.category,
          notes: dgpNotes({ ...info, detected: info.kind === meta.kind }),
        })
      } catch (err) {
        failed.push(`${file.name}: ${err.message || err}`)
        continue
      }
      for (const old of previous) {
        try { await deleteDocument(old) } catch (err) { console.error('Прежний ДГП не удалён:', err.message) }
      }
    }
    setStatus('')
    if (failed.length) setError('Не загрузилось: ' + failed.join('; '))
    await load()
  }

  const handleFiles = async (e) => {
    const files = Array.from(e.target.files || [])
    if (inputRef.current) inputRef.current.value = ''
    if (!files.length) return
    if (files.length > DGP_KINDS.length) {
      alert('Можно выбрать не больше двух файлов: комплектный и полный ДГП.')
      return
    }
    setStatus('Читаем файл…')
    setError(null)
    const items = []
    for (const file of files) {
      try {
        const info = await readDgpWorkbook(await file.arrayBuffer())
        items.push({ file, info, kind: info.kind })
      } catch (err) {
        setStatus('')
        setError(`«${file.name}»: ${err.message}. Нужен файл Excel с единым ПСДЦ.`)
        return
      }
    }
    setStatus('')
    const plan = planDgpUpload(items.map(i => ({ name: i.file.name, kind: i.kind })))
    if (!plan.ok) {
      setPending(items.map((item, idx) => ({ ...item, kind: plan.assign[idx] })))
      return
    }
    const replacing = plan.assign
      .map((kind, idx) => ({ kind, item: items[idx], old: docs[kind]?.[0] }))
      .filter(r => r.old)
    if (replacing.length && !window.confirm(
      'Заменить загруженный ДГП?\n' + replacing
        .map(r => `${DGP_BY_KIND[r.kind].label}: «${r.old.file_name}» → «${r.item.file.name}»`).join('\n'),
    )) return
    await upload(items, plan.assign)
  }

  const handleDownload = async (doc) => {
    try {
      const { presigned_url } = await requestDownloadUrl(doc.s3_key, { fileName: doc.file_name, download: true })
      const a = document.createElement('a')
      a.href = presigned_url
      a.download = doc.file_name || ''
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch (err) {
      setError('Не удалось скачать: ' + (err.message || err))
    }
  }

  const handleRemove = async (doc) => {
    if (!window.confirm(`Удалить ДГП «${doc.file_name}»?`)) return
    setStatus('Удаляем…')
    setError(null)
    try {
      await deleteDocument(doc)
    } catch (err) {
      setError('Не удалось удалить: ' + (err.message || err))
    }
    setStatus('')
    await load()
  }

  const busy = !!status
  const count = DGP_KINDS.filter(k => docs[k.kind]?.length).length

  return (
    <div className="dgp-block">
      <div className="dgp-head">
        <div className="dgp-head-text">
          <span className="dgp-head-title">ДГП — единый ПСДЦ</span>
          <span className="dgp-head-meta">{loading ? 'загрузка…' : `${count} из ${DGP_KINDS.length}`}</span>
        </div>
        <div className="dgp-head-actions">
          {status && <span className="dgp-status" role="status">{status}</span>}
          {canEdit && (
            <>
              <button type="button" className="btn-add-label dgp-upload" onClick={() => inputRef.current?.click()} disabled={busy}
                title="Можно выбрать оба файла сразу — вид каждого определяется сам">
                Загрузить ДГП
              </button>
              <input ref={inputRef} type="file" accept={ACCEPT} multiple hidden onChange={handleFiles}
                aria-label="Файлы ДГП" data-testid="dgp-input" />
            </>
          )}
        </div>
      </div>
      {canEdit && (
        <p className="dgp-hint">До двух файлов: комплектный и полный. Вид определяется по шапке таблицы; новый файл того же вида заменяет прежний.</p>
      )}
      {error && <div className="dgp-error" role="alert">{error}</div>}
      <div className="dgp-cards">
        {DGP_KINDS.map(k => (
          <DgpCard key={k.kind} kind={k.kind} docs={docs[k.kind] || []} canEdit={canEdit} busy={busy}
            onDownload={handleDownload} onRemove={handleRemove} />
        ))}
      </div>

      {pending && (
        <DgpKindDialog
          items={pending}
          current={docs}
          onCancel={() => setPending(null)}
          onConfirm={(assign) => {
            const items = pending
            setPending(null)
            upload(items, assign)
          }}
        />
      )}
    </div>
  )
}
