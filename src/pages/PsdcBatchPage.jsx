import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import * as XLSX from 'xlsx'
import PizZip from 'pizzip'
import { useRole } from '../contexts/RoleContext'
import {
  applyBatch, buildPsdcErrorCopy, cancelPsdc, createPsdcBatch, downloadPsdcErrorCopy, fetchMatchableDocuments,
  getBatchIssues, getBatchItems, getPsdc, listPsdcBatches, saveBytes, setBatchDocuments, setBatchNotes, stagePsdcFile,
} from '../services/psdc'
import { buildDocumentMatcher, matchFileName } from '../utils/psdcMatching'
import { formatDecimal } from '../utils/psdcWorkbook'
import { DOC_TYPE_SHORT } from '../utils/contractAmendments'
import { IconDownload, IconFileSpreadsheet, IconUpload } from '../components/icons/BsmIcons'
import { IconSearch } from '../components/icons/ToolbarIcons'
import PsdcIssues from '../components/psdc/PsdcIssues'
import '../components/ContractRegistry.css'
import '../components/psdc/Psdc.css'

// Массовая загрузка существующих ПСДЦ. Файлы не меняются: связь «файл → документ»
// хранится в пакете (автосопоставление по имени, ручной выбор или таблица
// сопоставления). Каждый файл проверяется и применяется независимо и целиком.

const PAGE = 100
const UPLOAD_CONCURRENCY = 3
const METHOD_LABEL = { auto: 'Автоматически', manual: 'Вручную', table: 'По таблице' }

const FILTERS = [
  { key: 'all', label: 'Все' },
  { key: 'unmapped', label: 'Не сопоставлено' },
  { key: 'ready', label: 'Готовы к применению' },
  { key: 'errors', label: 'Ошибки' },
  { key: 'conflict', label: 'Конфликты' },
  { key: 'blocked', label: 'Недоступно для применения' },
  { key: 'applied', label: 'Применено' },
]

function describe(item) {
  const doc = item.document
  if (item.state === 'applied') return { match: 'Применено', matchCls: 'is-applied' }
  if (!doc) return { match: 'Не сопоставлено', matchCls: 'is-muted', note: item.match_note }
  if (item.conflict) return { match: 'Конфликт: документ назначен нескольким файлам', matchCls: 'is-error' }
  if (item.document_has_applied) return { match: 'ПСДЦ уже существует', matchCls: 'is-warning', note: 'Удалите или замените её в карточке документа' }
  if (item.lock_reason) return { match: item.lock_reason, matchCls: 'is-warning' }
  return { match: METHOD_LABEL[item.match_method] || 'Сопоставлено', matchCls: 'is-ok' }
}

const isReady = (item) => item.state === 'validated' && item.document && !item.conflict && !item.document_has_applied && !item.lock_reason

// Фильтры не взаимоисключающие: файл с ошибками без документа виден и в
// «Ошибки», и в «Не сопоставлено».
const FILTER_MATCH = {
  all: () => true,
  unmapped: (item) => item.state !== 'applied' && !item.document,
  ready: isReady,
  errors: (item) => item.state === 'invalid' || item.state === 'uploaded',
  conflict: (item) => item.state !== 'applied' && item.conflict,
  blocked: (item) => item.state !== 'applied' && !!item.document && !item.conflict && (item.document_has_applied || !!item.lock_reason),
  applied: (item) => item.state === 'applied',
}

function documentLabel(doc) {
  if (!doc) return ''
  const number = doc.contract_number ? `№ ${doc.contract_number}` : 'без номера'
  const root = doc.root_display_id ? ` · к договору ID ${doc.root_display_id}${doc.root_contract_number ? ` (№ ${doc.root_contract_number})` : ''}` : ''
  return `ID ${doc.display_id} · ${number}${root}`
}

function DocumentPicker({ docs, onPick, onClose }) {
  const [query, setQuery] = useState('')
  const inputRef = useRef(null)
  useEffect(() => { inputRef.current?.focus() }, [])
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const out = []
    for (const d of docs) {
      const hay = `${d.display_id} ${d.contract_number || ''} ${d.counterparties?.name || ''}`.toLowerCase()
      if (String(d.display_id) === q || hay.includes(q)) out.push(d)
      if (out.length >= 30) break
    }
    return out.sort((a, b) => (String(a.display_id) === q ? -1 : String(b.display_id) === q ? 1 : 0))
  }, [docs, query])

  return (
    <div className="psdc-picker">
      <div className="psdc-picker-input">
        <IconSearch size={14} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            if (e.key === 'Enter' && results[0]) onPick(results[0])
          }}
          placeholder="ID, № договора/ДС или контрагент"
        />
        <button type="button" className="psdc-link" onClick={onClose}>Отмена</button>
      </div>
      {query.trim() && (
        <ul className="psdc-picker-list">
          {results.length === 0 && <li className="psdc-hint">Ничего не найдено</li>}
          {results.map((d) => (
            <li key={d.id}>
              <button type="button" onClick={() => onPick(d)}>
                <span className="mono">ID {d.display_id}</span>
                <span className={`ds-type-badge is-${d.record_type}`}>{DOC_TYPE_SHORT[d.record_type]}</span>
                <span>{d.contract_number ? `№ ${d.contract_number}` : 'без номера'}</span>
                <span className="psdc-hint">{d.counterparties?.name || ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PsdcBatchPage() {
  const { canEdit, scopedObjectIds } = useRole()
  const canEditContracts = canEdit('contracts')
  const [params, setParams] = useSearchParams()
  const batchId = params.get('batch')
  // Пакет хранится в адресе: переживает обновление страницы, прочие параметры не трогаем.
  const selectBatch = (id) => setParams((prev) => {
    const next = new URLSearchParams(prev)
    if (id) next.set('batch', id)
    else next.delete('batch')
    return next
  })

  const [batches, setBatches] = useState([])
  const [items, setItems] = useState([])
  const [docs, setDocs] = useState([])
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState(null)
  const [progress, setProgress] = useState(null) // { label, done, total }
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [picking, setPicking] = useState(null)
  const [expanded, setExpanded] = useState(null) // { id, psdc }
  const [batchIssues, setBatchIssues] = useState(null)
  const [uploadFailures, setUploadFailures] = useState([])
  const localBytes = useRef(new Map())
  const fileInput = useRef(null)
  const tableInput = useRef(null)

  const busy = !!progress

  useEffect(() => {
    listPsdcBatches().then(setBatches).catch((e) => setNotice({ kind: 'error', text: e.message }))
    fetchMatchableDocuments()
      .then((rows) => setDocs(rows.filter((d) => scopedObjectIds.length === 0 || scopedObjectIds.includes(d.object_id))))
      .catch((e) => setNotice({ kind: 'error', text: `Не удалось загрузить документы: ${e.message}` }))
  }, [scopedObjectIds])

  const matcher = useMemo(() => buildDocumentMatcher(docs), [docs])

  const reload = useCallback(async () => {
    if (!batchId) { setItems([]); return }
    setLoading(true)
    try {
      setItems(await getBatchItems(batchId))
    } catch (e) {
      setNotice({ kind: 'error', text: e.message })
    } finally {
      setLoading(false)
    }
  }, [batchId])

  useEffect(() => {
    setPage(0)
    setExpanded(null)
    setBatchIssues(null)
    setUploadFailures([])
    reload()
  }, [reload])

  const counts = useMemo(() => Object.fromEntries(
    FILTERS.map((f) => [f.key, items.filter(FILTER_MATCH[f.key]).length]),
  ), [items])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter((item) => {
      if (!FILTER_MATCH[filter](item)) return false
      if (!q) return true
      const doc = item.document
      return `${item.source_filename} ${doc ? `${doc.display_id} ${doc.contract_number || ''} ${doc.counterparty || ''}` : ''}`.toLowerCase().includes(q)
    })
  }, [items, filter, search])

  const pageItems = filtered.slice(page * PAGE, (page + 1) * PAGE)
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE))

  const handleCreateBatch = async () => {
    const title = window.prompt('Название пакета (необязательно)', `Пакет от ${new Date().toLocaleDateString('ru-RU')}`)
    if (title === null) return
    try {
      const id = await createPsdcBatch(title)
      setBatches(await listPsdcBatches())
      selectBatch(id)
    } catch (e) {
      setNotice({ kind: 'error', text: e.message })
    }
  }

  // Автосопоставление: однозначные совпадения назначаются, остальным пишется причина.
  const autoMatch = async (targets) => {
    const unmapped = targets.filter((item) => !item.document && item.state !== 'applied')
    if (!unmapped.length) return { assigned: 0, left: 0 }
    const assign = []
    const notes = []
    for (const item of unmapped) {
      const res = matchFileName(item.source_filename, matcher)
      if (res.status === 'unique') assign.push({ psdc_id: item.id, document_id: res.doc.id, method: 'auto' })
      else notes.push({ psdc_id: item.id, note: res.reason })
    }
    setProgress({ label: 'Сопоставление', done: 0, total: assign.length })
    const results = assign.length ? await setBatchDocuments(assign, (done, total) => setProgress({ label: 'Сопоставление', done, total })) : []
    const failed = results.filter((r) => !r.ok)
    for (const f of failed) notes.push({ psdc_id: f.psdc_id, note: f.error })
    if (notes.length) await setBatchNotes(notes)
    return { assigned: results.length - failed.length, left: notes.length }
  }

  const handleFiles = async (event) => {
    const files = [...(event.target.files || [])]
    event.target.value = ''
    if (!files.length || !batchId) return
    const failures = []
    let done = 0
    setNotice(null)
    setProgress({ label: 'Загрузка и проверка файлов', done, total: files.length })
    const queue = [...files]
    const worker = async () => {
      while (queue.length) {
        const file = queue.shift()
        try {
          const result = await stagePsdcFile(file, { batchId })
          if (result.bytes) localBytes.current.set(result.psdcId, result.bytes)
        } catch (e) {
          failures.push({ file: file.name, message: e.message })
        }
        done++
        setProgress({ label: 'Загрузка и проверка файлов', done, total: files.length })
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker))
      const fresh = await getBatchItems(batchId)
      const matched = await autoMatch(fresh)
      await reload()
      setUploadFailures(failures)
      setNotice({
        kind: failures.length ? 'warning' : 'success',
        text: `Загружено файлов: ${files.length - failures.length} из ${files.length}. Автоматически сопоставлено: ${matched.assigned}, требуют выбора документа: ${matched.left}.`,
      })
    } catch (e) {
      setNotice({ kind: 'error', text: e.message })
    } finally {
      setProgress(null)
    }
  }

  const handleAutoMatch = async () => {
    try {
      const matched = await autoMatch(items)
      await reload()
      setNotice({ kind: 'success', text: `Сопоставлено автоматически: ${matched.assigned}. Без однозначного совпадения: ${matched.left}.` })
    } catch (e) {
      setNotice({ kind: 'error', text: e.message })
    } finally {
      setProgress(null)
    }
  }

  const mapOne = async (item, documentId) => {
    setPicking(null)
    try {
      const [res] = await setBatchDocuments([{ psdc_id: item.id, document_id: documentId, method: 'manual' }])
      if (!res.ok) setNotice({ kind: 'error', text: `${item.source_filename}: ${res.error}` })
      await reload()
    } catch (e) {
      setNotice({ kind: 'error', text: e.message })
    }
  }

  const applyItems = async (targets) => {
    const ids = targets.map((t) => t.id)
    if (!ids.length) return
    if (!window.confirm(`Применить ПСДЦ для ${ids.length} файл(ов)?\n\nСумма каждого сопоставленного документа станет итогом его ПСДЦ. Каждый файл применяется целиком и независимо от остальных.`)) return
    setProgress({ label: 'Применение', done: 0, total: ids.length })
    try {
      const results = await applyBatch(ids, (done, total) => setProgress({ label: 'Применение', done, total }))
      const failed = results.filter((r) => !r.ok)
      await reload()
      setNotice({
        kind: failed.length ? 'warning' : 'success',
        text: `Применено: ${results.length - failed.length}. Не применено: ${failed.length}.${failed.length ? ` Первая причина: ${failed[0].error}` : ''}`,
      })
    } catch (e) {
      setNotice({ kind: 'error', text: e.message })
    } finally {
      setProgress(null)
    }
  }

  const cancelItem = async (item) => {
    if (!window.confirm(`Убрать файл «${item.source_filename}» из пакета? Документы не изменятся.`)) return
    try {
      await cancelPsdc(item.id)
      await reload()
    } catch (e) {
      setNotice({ kind: 'error', text: e.message })
    }
  }

  const toggleDetails = async (item) => {
    if (expanded?.id === item.id) { setExpanded(null); return }
    try {
      setExpanded({ id: item.id, psdc: await getPsdc(item.id) })
    } catch (e) {
      setNotice({ kind: 'error', text: e.message })
    }
  }

  // Отдельная таблица «Имя файла | ID документа» на весь пакет. Файлы ПСДЦ не меняются.
  const downloadMappingTable = () => {
    const rows = [['Имя файла', 'ID документа'], ...items.filter((i) => i.state !== 'applied').map((i) => [i.source_filename, i.document ? i.document.display_id : ''])]
    const ws = XLSX.utils.aoa_to_sheet(rows)
    ws['!cols'] = [{ wch: 60 }, { wch: 16 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Сопоставление')
    saveBytes(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), 'Сопоставление_ПСДЦ.xlsx')
  }

  const uploadMappingTable = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' })
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' })
      const byName = new Map()
      for (const item of items) {
        if (item.state === 'applied') continue
        if (!byName.has(item.source_filename)) byName.set(item.source_filename, [])
        byName.get(item.source_filename).push(item)
      }
      const problems = []
      const assign = []
      aoa.slice(1).forEach((row, idx) => {
        const name = String(row[0] || '').trim()
        const id = String(row[1] || '').trim().replace(/\s/g, '')
        if (!name || !id) return
        const matches = byName.get(name)
        if (!matches) problems.push(`Строка ${idx + 2}: файла «${name}» нет в пакете`)
        else if (matches.length > 1) problems.push(`Строка ${idx + 2}: в пакете несколько файлов «${name}» — сопоставьте их вручную`)
        else if (!/^\d+$/.test(id)) problems.push(`Строка ${idx + 2}: некорректный ID документа «${id}»`)
        else if (String(matches[0].document?.display_id ?? '') !== id) assign.push({ psdc_id: matches[0].id, display_id: id, method: 'table' })
      })
      setProgress({ label: 'Сопоставление по таблице', done: 0, total: assign.length })
      const results = await setBatchDocuments(assign, (done, total) => setProgress({ label: 'Сопоставление по таблице', done, total }))
      const nameById = new Map(items.map((i) => [i.id, i.source_filename]))
      results.filter((r) => !r.ok).forEach((r) => problems.push(`${nameById.get(r.psdc_id)}: ${r.error}`))
      await reload()
      setNotice({
        kind: problems.length ? 'warning' : 'success',
        text: `Сопоставлено по таблице: ${results.filter((r) => r.ok).length}.${problems.length ? ` Проблемы (${problems.length}): ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? '…' : ''}` : ''}`,
      })
    } catch (e) {
      setNotice({ kind: 'error', text: `Не удалось прочитать таблицу сопоставления: ${e.message}` })
    } finally {
      setProgress(null)
    }
  }

  // ZIP из отдельных исправляемых копий — без склейки разных ПСДЦ в одну книгу.
  const downloadErrorZip = async () => {
    const invalid = items.filter((i) => i.state === 'invalid')
    if (!invalid.length) return
    const zip = new PizZip()
    const used = new Set()
    const skipped = []
    setProgress({ label: 'Подготовка файлов с ошибками', done: 0, total: invalid.length })
    try {
      for (let i = 0; i < invalid.length; i++) {
        try {
          const { bytes, fileName } = await buildPsdcErrorCopy(invalid[i], localBytes.current.get(invalid[i].id))
          let name = fileName
          for (let n = 2; used.has(name); n++) name = fileName.replace(/\.xlsx$/i, ` (${n}).xlsx`)
          used.add(name)
          zip.file(name, bytes)
        } catch (e) {
          skipped.push(`${invalid[i].source_filename}: ${e.message}`)
        }
        setProgress({ label: 'Подготовка файлов с ошибками', done: i + 1, total: invalid.length })
      }
      if (used.size) saveBytes(zip.generate({ type: 'uint8array', compression: 'DEFLATE' }), 'ПСДЦ_с_ошибками.zip', 'application/zip')
      setNotice({
        kind: skipped.length ? 'warning' : 'success',
        text: `В архиве файлов: ${used.size}.${skipped.length ? ` Без копии (${skipped.length}): ${skipped.slice(0, 3).join('; ')}` : ''}`,
      })
    } finally {
      setProgress(null)
    }
  }

  const readyItems = items.filter(isReady)

  return (
    <div className="contract-registry psdc-batch-page">
      <div className="registry-header">
        <h2>
          <IconFileSpreadsheet size={22} /> Массовая загрузка ПСДЦ
        </h2>
        <Link to="/contracts" className="btn-secondary psdc-btn">К реестру договоров</Link>
      </div>

      <p className="psdc-hint psdc-batch-intro">
        Выберите сразу много XLSX. Файлы не меняются: документ определяется по имени файла (ID документа или № договора/ДС),
        выбирается вручную или задаётся отдельной таблицей «Имя файла | ID документа». Каждый файл проверяется и применяется
        независимо и только целиком; до применения суммы документов не меняются.
      </p>

      <div className="psdc-batch-bar">
        <select
          value={batchId || ''}
          onChange={(e) => selectBatch(e.target.value)}
          disabled={busy}
          aria-label="Пакет загрузки"
        >
          <option value="">— выберите пакет —</option>
          {batches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title || 'Без названия'} · {new Date(b.created_at).toLocaleDateString('ru-RU')}{b.created_by_name ? ` · ${b.created_by_name}` : ''}
            </option>
          ))}
        </select>
        {canEditContracts && <button type="button" className="btn-secondary psdc-btn" onClick={handleCreateBatch} disabled={busy}>Новый пакет</button>}
        {batchId && canEditContracts && (
          <>
            <button type="button" className="btn-primary psdc-btn" onClick={() => fileInput.current?.click()} disabled={busy}>
              <IconUpload size={15} /> Добавить файлы
            </button>
            <input ref={fileInput} type="file" accept=".xlsx" multiple hidden onChange={handleFiles} />
          </>
        )}
      </div>

      {progress && (
        <div className="psdc-progress" role="status">
          <span>{progress.label}: {progress.done} из {progress.total}</span>
          <div className="psdc-progress-track"><div style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
        </div>
      )}
      {notice && <div className={`psdc-notice is-${notice.kind}`}>{notice.text}</div>}
      {uploadFailures.length > 0 && (
        <div className="psdc-notice is-error">
          Не удалось загрузить: {uploadFailures.map((f) => `${f.file} — ${f.message}`).join('; ')}
        </div>
      )}

      {!batchId ? (
        <div className="psdc-empty-block">
          <p><strong>Пакет не выбран</strong></p>
          <p className="psdc-hint">Создайте новый пакет или откройте ранее созданный — состояние пакета сохраняется между обновлениями страницы.</p>
        </div>
      ) : (
        <>
          <div className="psdc-batch-tools">
            <div className="psdc-filter-chips">
              {FILTERS.map((f) => (
                <button key={f.key} type="button" className={`qfilter${filter === f.key ? ' active' : ''}`} onClick={() => { setFilter(f.key); setPage(0) }}>
                  {f.label} <span className="psdc-chip-count">{counts[f.key]}</span>
                </button>
              ))}
            </div>
            <div className="psdc-batch-search">
              <IconSearch size={14} />
              <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0) }} placeholder="Файл, ID, № документа, контрагент" />
            </div>
          </div>

          <div className="psdc-batch-actions">
            {canEditContracts && (
              <>
                <button type="button" className="btn-primary psdc-btn" disabled={busy || !readyItems.length} onClick={() => applyItems(readyItems)}>
                  Применить все проверенные ({readyItems.length})
                </button>
                <button type="button" className="btn-secondary psdc-btn" disabled={busy || !counts.unmapped} onClick={handleAutoMatch}>
                  Автосопоставление ({counts.unmapped})
                </button>
                <button type="button" className="btn-secondary psdc-btn" disabled={busy || !items.length} onClick={downloadMappingTable}>
                  <IconDownload size={15} /> Таблица сопоставления
                </button>
                <button type="button" className="btn-secondary psdc-btn" disabled={busy || !items.length} onClick={() => tableInput.current?.click()}>
                  <IconUpload size={15} /> Загрузить таблицу
                </button>
                <input ref={tableInput} type="file" accept=".xlsx" hidden onChange={uploadMappingTable} />
              </>
            )}
            <button type="button" className="btn-secondary psdc-btn" disabled={busy || !counts.errors} onClick={downloadErrorZip}>
              <IconDownload size={15} /> Файлы с ошибками (ZIP)
            </button>
            <button
              type="button"
              className="btn-secondary psdc-btn"
              disabled={busy || !counts.errors}
              onClick={async () => {
                if (batchIssues) { setBatchIssues(null); return }
                try { setBatchIssues(await getBatchIssues(batchId)) } catch (e) { setNotice({ kind: 'error', text: e.message }) }
              }}
            >
              {batchIssues ? 'Скрыть ошибки файлов' : 'Ошибки всех файлов'}
            </button>
          </div>

          {batchIssues && (
            <div className="psdc-card">
              <PsdcIssues issues={batchIssues} showFile emptyText="Ошибок в файлах нет." />
            </div>
          )}

          <div className="psdc-rows-scroll psdc-batch-table-wrap">
            <table className="psdc-batch-table">
              <thead>
                <tr>
                  <th>Файл</th>
                  <th>Связанный документ</th>
                  <th>Тип документа</th>
                  <th>Сопоставление</th>
                  <th>Проверка</th>
                  <th className="num">Итог ПСДЦ</th>
                  <th>Ошибки</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {loading && !items.length && <tr><td colSpan={8} className="psdc-hint">Загрузка…</td></tr>}
                {!loading && !filtered.length && <tr><td colSpan={8} className="psdc-hint">Файлов нет</td></tr>}
                {pageItems.map((item) => {
                  const info = describe(item)
                  const editable = canEditContracts && item.state !== 'applied' && !busy
                  return (
                    <Fragment key={item.id}>
                      <tr className={item.state === 'applied' ? 'is-applied' : ''}>
                        <td className="psdc-batch-file">
                          {item.source_filename}
                          {item.duplicate_file && <span className="psdc-diff-tag is-deleted" title="В пакете есть файл с тем же содержимым">дубль файла</span>}
                        </td>
                        <td className="psdc-batch-doc">
                          {picking === item.id ? (
                            <DocumentPicker docs={docs} onPick={(d) => mapOne(item, d.id)} onClose={() => setPicking(null)} />
                          ) : (
                            <>
                              {item.document ? (
                                <Link to={`/contracts/${item.document.id}`} target="_blank" rel="noopener noreferrer">{documentLabel(item.document)}</Link>
                              ) : <span className="psdc-hint">—</span>}
                              {item.document?.counterparty && <div className="psdc-hint">{item.document.counterparty}</div>}
                              {editable && (
                                <div className="psdc-row-links">
                                  <button type="button" className="psdc-link" onClick={() => setPicking(item.id)}>{item.document ? 'Изменить' : 'Выбрать документ'}</button>
                                  {item.document && <button type="button" className="psdc-link" onClick={() => mapOne(item, null)}>Снять</button>}
                                </div>
                              )}
                            </>
                          )}
                        </td>
                        <td>{item.document ? DOC_TYPE_SHORT[item.document.record_type] : ''}</td>
                        <td>
                          <span className={`psdc-status ${info.matchCls}`}>{info.match}</span>
                          {info.note && <div className="psdc-hint">{info.note}</div>}
                        </td>
                        <td>
                          {item.state === 'applied' && <span className="psdc-status is-applied">Применено</span>}
                          {item.state === 'validated' && <span className="psdc-status is-ok">Проверено</span>}
                          {item.state === 'invalid' && <span className="psdc-status is-error">Ошибки: {item.error_count}</span>}
                          {item.state === 'uploaded' && <span className="psdc-status is-muted">Не проверено</span>}
                          {item.warning_count > 0 && <div className="psdc-hint">Предупреждений: {item.warning_count}</div>}
                        </td>
                        <td className="num strong">{item.total != null ? formatDecimal(item.total) : '—'}</td>
                        <td className="psdc-batch-issues">
                          {(item.first_issues || []).filter((i) => i.severity === 'error').slice(0, 2).map((i, idx) => (
                            <div key={idx}><span className="mono">{i.cell || (i.excel_row ? `стр. ${i.excel_row}` : '')}</span> {i.message}</div>
                          ))}
                          {item.error_count > 2 && <div className="psdc-hint">и ещё {item.error_count - 2}</div>}
                        </td>
                        <td className="psdc-batch-row-actions">
                          {canEditContracts && isReady(item) && (
                            <button type="button" className="btn-primary psdc-btn psdc-btn-sm" disabled={busy} onClick={() => applyItems([item])}>Применить</button>
                          )}
                          {item.state === 'invalid' && (
                            <button type="button" className="btn-secondary psdc-btn psdc-btn-sm" disabled={busy}
                              onClick={() => downloadPsdcErrorCopy(item, localBytes.current.get(item.id)).catch((e) => setNotice({ kind: 'error', text: e.message }))}>
                              Файл с ошибками
                            </button>
                          )}
                          <button type="button" className="psdc-link" onClick={() => toggleDetails(item)}>{expanded?.id === item.id ? 'Скрыть' : 'Подробнее'}</button>
                          {editable && <button type="button" className="psdc-link is-danger" onClick={() => cancelItem(item)}>Убрать</button>}
                        </td>
                      </tr>
                      {expanded?.id === item.id && (
                        <tr className="psdc-batch-details">
                          <td colSpan={8}>
                            <div className="psdc-batch-details-grid">
                              <div><span className="psdc-hint">Секций</span> {expanded.psdc.section_count ?? '—'}</div>
                              <div><span className="psdc-hint">Процессов</span> {expanded.psdc.process_count ?? '—'}</div>
                              <div><span className="psdc-hint">Материалы</span> {formatDecimal(expanded.psdc.total_material) || '—'}</div>
                              <div><span className="psdc-hint">Работы</span> {formatDecimal(expanded.psdc.total_work) || '—'}</div>
                              <div><span className="psdc-hint">Итого</span> <strong>{formatDecimal(expanded.psdc.total) || '—'}</strong></div>
                              <div><span className="psdc-hint">НДС</span> {expanded.psdc.vat_amount != null ? formatDecimal(expanded.psdc.vat_amount) : 'после сопоставления'}</div>
                            </div>
                            <PsdcIssues issues={expanded.psdc.issues} emptyText="Ошибок и предупреждений нет." />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>

          {pages > 1 && (
            <div className="psdc-pager">
              <button type="button" className="btn-secondary psdc-btn psdc-btn-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Назад</button>
              <span>Страница {page + 1} из {pages} · файлов {filtered.length}</span>
              <button type="button" className="btn-secondary psdc-btn psdc-btn-sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Вперёд</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default PsdcBatchPage
