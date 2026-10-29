import { useCallback, useEffect, useRef, useState } from 'react'
import { deleteDocument, fetchDocuments, uploadFile } from '../services/s3'
import { downloadS3File } from './FileDownload'
import { formatAmount } from '../utils/money'
import { plural } from '../utils/taskHelpers'
import {
  DGP_CATEGORIES, DGP_CATEGORY, DGP_FEATURES, DGP_MAX_FILES, dgpContractKey, dgpNotes, dgpReplaced,
  dgpRevisionFromText, dgpRevisionLabel, orderDgpDocs, readDgpWorkbook,
} from '../utils/dgpWorkbook'
import { IconDownload, IconTrash } from './icons/ActionIcons'
import './ObjectDgpFiles.css'

// Вкладка «Смета» карточки объекта: ДГП — файлы единого ПСДЦ договора генподряда, любого вида и сколько угодно.
// Вид не выбирается: из файла читается паспорт — заголовок, договор, учтённые ДС, цена договора — и состав
// (история изменений, материалы и работы, ресурсы КП, основные материалы, части НДС), utils/dgpWorkbook.js.
// Файлы — s3_documents объекта (owner_type 'object', категория dgp; прежние dgp_compact / dgp_full — в том же
// списке), паспорт — JSON в notes, чтобы показывать его без скачивания. Файл с тем же именем заменяет прежний:
// сначала загружается новый, потом удаляется старый — сбой не оставляет без файла. Прежняя редакция того же
// договора (учтено меньше ДС) не удаляется сама — уходит вниз списка с пометкой.

const ACCEPT = '.xlsx,.xlsm,.xls'
const FEATURE_BY_KEY = Object.fromEntries(DGP_FEATURES.map(f => [f.key, f]))

function formatBytes(bytes) {
  if (bytes == null) return ''
  const units = ['Б', 'КБ', 'МБ', 'ГБ']
  let v = Number(bytes)
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toLocaleString('ru-RU', { maximumFractionDigits: i === 0 ? 0 : 1 })} ${units[i]}`
}

const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '')

// Договор и ДС — плашками, только если их нет в заголовке и подзаголовке файла.
function passportChips(info) {
  const head = `${info.title} ${info.subtitle}`
  const chips = []
  if (info.contract && !dgpContractKey(head).includes(dgpContractKey(info.contract.number))) {
    chips.push(`Договор № ${info.contract.number}${info.contract.date ? ` от ${info.contract.date}` : ''}`)
  }
  const inHead = dgpRevisionFromText(head)
  if (info.revision && !(inHead && inHead.to === info.revision.to && inHead.from === info.revision.from)) {
    chips.push(dgpRevisionLabel(info.revision))
  }
  return chips
}

function DgpCard({ item, canEdit, busy, onDownload, onRemove }) {
  const { doc, info, newer } = item
  const chips = passportChips(info)
  return (
    <section className={`dgp-card${newer ? ' is-old' : ''}`} aria-label={`ДГП ${doc.file_name}`}>
      <div className="dgp-card-top">
        <div className="dgp-card-title">{info.title || doc.file_name}</div>
        {newer && (
          <span className="dgp-badge" title={`Загружена более новая редакция: ${dgpRevisionLabel(newer.revision)}`}>
            прежняя редакция
          </span>
        )}
      </div>
      {info.subtitle && <div className="dgp-card-subtitle" title={info.subtitle}>{info.subtitle}</div>}
      {info.total != null && (
        <div className="dgp-card-total">
          <span className="dgp-card-total-label">
            {info.totalLabel || 'Цена договора'}
            {info.priceBasis ? ` · действует по ДС №${info.priceBasis}` : ''}
          </span>
          <span className="dgp-card-total-value">{formatAmount(info.total)} ₽</span>
        </div>
      )}
      {(chips.length > 0 || info.features.length > 0) && (
        <ul className="dgp-chips" aria-label="Паспорт и состав">
          {chips.map(c => <li key={c} className="dgp-chip">{c}</li>)}
          {info.features.map(k => (
            <li key={k} className="dgp-chip is-feature" title={FEATURE_BY_KEY[k].hint}>{FEATURE_BY_KEY[k].label}</li>
          ))}
        </ul>
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
            aria-label={`Удалить ${doc.file_name}`}>
            <IconTrash size={14} /> Удалить
          </button>
        )}
      </div>
    </section>
  )
}

export default function ObjectDgpFiles({ objectId, canEdit }) {
  const inputRef = useRef(null)
  const [docs, setDocs] = useState([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('') // «Читаем файл…» / «Загружаем…»
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const lists = await Promise.all(DGP_CATEGORIES.map(c => fetchDocuments('object', objectId, c)))
      setDocs(lists.flat())
    } catch (err) {
      console.error('Ошибка загрузки ДГП объекта:', err.message)
      setError('Не удалось загрузить список ДГП: ' + err.message)
    } finally {
      setLoading(false)
    }
  }, [objectId])

  useEffect(() => { load() }, [load])

  const handleFiles = async (e) => {
    const files = Array.from(e.target.files || [])
    if (inputRef.current) inputRef.current.value = ''
    if (!files.length) return
    if (files.length > DGP_MAX_FILES) {
      alert(`Можно выбрать не больше ${DGP_MAX_FILES} файлов за раз.`)
      return
    }
    setStatus('Читаем файл…')
    setError(null)
    const items = []
    for (const file of files) {
      try {
        items.push({ file, info: await readDgpWorkbook(await file.arrayBuffer(), file.name) })
      } catch (err) {
        setStatus('')
        setError(`«${file.name}»: ${err.message}. Нужен файл Excel с единым ПСДЦ.`)
        return
      }
    }
    setStatus('')

    const strange = items.filter(i => !i.info.recognized)
    if (strange.length && !window.confirm(
      strange.map(i => `«${i.file.name}»`).join(', ')
        + (strange.length > 1 ? ' не похожи' : ' не похож')
        + ' на единый ПСДЦ: в файле не нашлось ни цены договора, ни знакомых колонок. Всё равно загрузить?',
    )) return
    const replacing = items.flatMap(i => dgpReplaced(i.file.name, docs).map(old => ({ item: i, old })))
    if (replacing.length && !window.confirm(
      'Заменить загруженный ДГП с тем же именем?\n'
        + replacing.map(r => `«${r.old.file_name}» от ${formatDate(r.old.created_at)}`).join('\n'),
    )) return

    setStatus('Загружаем…')
    const failed = []
    for (const { file, info } of items) {
      try {
        await uploadFile({ file, ownerType: 'object', ownerId: objectId, category: DGP_CATEGORY, notes: dgpNotes(info) })
      } catch (err) {
        failed.push(`${file.name}: ${err.message || err}`)
        continue
      }
      for (const old of dgpReplaced(file.name, docs)) {
        try { await deleteDocument(old) } catch (err) { console.error('Прежний ДГП не удалён:', err.message) }
      }
    }
    setStatus('')
    if (failed.length) setError('Не загрузилось: ' + failed.join('; '))
    await load()
  }

  const handleDownload = async (doc) => {
    try {
      await downloadS3File(doc.s3_key, doc.file_name)
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
  const items = orderDgpDocs(docs)

  return (
    <div className="dgp-block">
      <div className="dgp-head">
        <div className="dgp-head-text">
          <span className="dgp-head-title">ДГП — единый ПСДЦ</span>
          <span className="dgp-head-meta">
            {loading ? 'загрузка…' : items.length ? `${items.length} ${plural(items.length, 'файл', 'файла', 'файлов')}` : ''}
          </span>
        </div>
        <div className="dgp-head-actions">
          {status && <span className="dgp-status" role="status">{status}</span>}
          {canEdit && (
            <>
              <button type="button" className="btn-add-label dgp-upload" onClick={() => inputRef.current?.click()} disabled={busy}
                title="Можно выбрать несколько файлов сразу">
                Загрузить ДГП
              </button>
              <input ref={inputRef} type="file" accept={ACCEPT} multiple hidden onChange={handleFiles}
                aria-label="Файлы ДГП" data-testid="dgp-input" />
            </>
          )}
        </div>
      </div>
      {canEdit && (
        <p className="dgp-hint">
          Любой вид единого ПСДЦ, можно несколько файлов. Договор, учтённые ДС, цена и состав читаются из файла;
          файл с тем же именем заменяет прежний.
        </p>
      )}
      {error && <div className="dgp-error" role="alert">{error}</div>}
      {!loading && items.length === 0 ? (
        <p className="dgp-empty">ДГП не загружен</p>
      ) : (
        <div className="dgp-cards">
          {items.map(item => (
            <DgpCard key={item.doc.id} item={item} canEdit={canEdit} busy={busy}
              onDownload={handleDownload} onRemove={handleRemove} />
          ))}
        </div>
      )}
    </div>
  )
}
