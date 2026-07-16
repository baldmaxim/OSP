import { useState, useEffect, useMemo, useRef } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../supabase'
import {
  parseByPosition,
  parseByAggregate,
  getColumnPreviews,
  mergeAggregateRecords,
} from '../utils/parseProposalExcel'
import { addProposalFile } from '../services/tenderProposalFiles'

// task 346: модалка загрузки одного КП.
// Поток: выбрать (контрагент, ВОР, формат) → файл → лист/диапазон + column-mapping
// → preview → сохранить (DELETE по этому ВОРу + INSERT).

const COLUMN_COUNT = 26

// task 348: добавлены опциональные code/name — позволяют парсеру корректно
// обрабатывать материалы (у них в Excel часто нет №) и сверять наименование.
const A_FIELDS = [
  { key: 'num',           label: '№ п/п',           default: 0 },
  { key: 'code',          label: 'КОД (Р/мат.)',    default: 1 },
  { key: 'name',          label: 'Наименование',    default: 2 },
  { key: 'priceMaterial', label: 'Цена материалов', default: 6 },
  { key: 'priceWork',     label: 'Цена работ',      default: 7 },
  { key: 'note',          label: 'Примечание',      default: null },
]
const A_DEFAULTS = Object.fromEntries(A_FIELDS.map(f => [f.key, f.default]))

const B_FIELDS = [
  { key: 'name',  label: 'Наименование', default: 0 },
  { key: 'unit',  label: 'Ед. изм.',     default: 1 },
  { key: 'price', label: 'Цена за ед.',  default: 2 },
  { key: 'kind',  label: 'Тип (мат/раб)', default: null },
]
const B_DEFAULTS = Object.fromEntries(B_FIELDS.map(f => [f.key, f.default]))

function loadMap(key, defaults) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return { ...defaults }
    const parsed = JSON.parse(raw)
    const out = { ...defaults }
    for (const k of Object.keys(defaults)) {
      const v = parsed[k]
      if (v === null) out[k] = null
      else if (Number.isInteger(v) && v >= 0 && v < COLUMN_COUNT) out[k] = v
    }
    return out
  } catch {
    return { ...defaults }
  }
}

function TenderProposalUploadModal({
  tenderId,
  tenderCounterparties,
  estimateItems,
  docNames,
  onClose,
  onSaved,
}) {
  // Только участники, что не отказались.
  const activeParticipants = useMemo(
    () => (tenderCounterparties || []).filter(tc => tc.status !== 'declined'),
    [tenderCounterparties]
  )

  const [counterpartyId, setCounterpartyId] = useState(
    activeParticipants[0]?.counterparty_id || ''
  )
  const [docName, setDocName] = useState(docNames[0] || '')
  const [format, setFormat] = useState('A') // 'A' | 'B'
  const [kindHint, setKindHint] = useState('auto') // для формата B: auto | materials | works | column
  // task 347: дата предоставления КП — обязательное поле. Дефолт — сегодня.
  const [proposalDate, setProposalDate] = useState(() => {
    const d = new Date()
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
  })

  const fileRef = useRef(null)
  const savedFileRef = useRef(null) // task 367: store File object for S3 upload
  const [workbook, setWorkbook] = useState(null)
  const [sheetNames, setSheetNames] = useState([])
  const [sheetName, setSheetName] = useState('')
  const [sheetNameWork, setSheetNameWork] = useState('') // task 367: second sheet for works (format B)
  const [startRow, setStartRow] = useState('2')
  const [endRow, setEndRow] = useState('')

  const [mapA, setMapA] = useState(() => loadMap('tender-proposal-cols-a', A_DEFAULTS))
  const [mapB, setMapB] = useState(() => loadMap('tender-proposal-cols-b', B_DEFAULTS))

  const [preview, setPreview] = useState(null) // { records, warnings, unmatched }
  const [saving, setSaving] = useState(false)

  // persist mapping
  useEffect(() => {
    try { localStorage.setItem('tender-proposal-cols-a', JSON.stringify(mapA)) } catch { /* localStorage недоступен — игнорируем */ }
  }, [mapA])
  useEffect(() => {
    try { localStorage.setItem('tender-proposal-cols-b', JSON.stringify(mapB)) } catch { /* localStorage недоступен — игнорируем */ }
  }, [mapB])

  const columnPreviews = useMemo(
    () => getColumnPreviews(workbook, sheetName, COLUMN_COUNT),
    [workbook, sheetName]
  )

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    savedFileRef.current = file // task 367: save for S3 upload
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
      setWorkbook(wb)
      setSheetNames(wb.SheetNames || [])
      setSheetName(wb.SheetNames?.[0] || '')
      setSheetNameWork('') // task 367: reset second sheet
      setStartRow('2')
      setEndRow('')
      setPreview(null)
    } catch (err) {
      alert('Ошибка чтения файла: ' + err.message)
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  const handleRecognize = () => {
    if (!workbook || !sheetName) {
      alert('Сначала выберите файл и лист.')
      return
    }
    const rowRange = { start: startRow, end: endRow }
    if (format === 'A') {
      const result = parseByPosition({
        workbook, sheetName, columnMap: mapA, rowRange,
        estimateItems, docName,
      })
      setPreview(result)
    } else {
      // task 367: two-sheet support for format B
      if (sheetNameWork) {
        // Two-sheet mode: parse each sheet with forced type
        const rMat = parseByAggregate({
          workbook, sheetName, columnMap: mapB, rowRange,
          estimateItems, docName, kindHint: 'materials',
        })
        const rWork = parseByAggregate({
          workbook, sheetName: sheetNameWork, columnMap: mapB, rowRange,
          estimateItems, docName, kindHint: 'works',
        })
        setPreview({
          records: mergeAggregateRecords(rMat.records, rWork.records),
          warnings: [...rMat.warnings, ...rWork.warnings],
          unmatched: [...rMat.unmatched, ...rWork.unmatched],
        })
      } else {
        // Single-sheet mode
        const result = parseByAggregate({
          workbook, sheetName, columnMap: mapB, rowRange,
          estimateItems, docName, kindHint,
        })
        setPreview(result)
      }
    }
  }

  const handleSave = async () => {
    if (!preview || preview.records.length === 0) {
      alert('Нечего сохранять. Распознайте файл.')
      return
    }
    if (!counterpartyId) {
      alert('Выберите контрагента.')
      return
    }
    if (!proposalDate) {
      alert('Укажите дату предоставления КП.')
      return
    }
    setSaving(true)
    try {
      // ID позиций только этого ВОРа.
      const itemIdsOfVor = estimateItems
        .filter(it => (it.estimate_name || 'Основная смета') === docName && !it.is_section)
        .map(it => it.id)

      // task 367: batch DELETE to avoid URL size limit with large ВОР
      const CHUNK_DEL = 100
      for (let i = 0; i < itemIdsOfVor.length; i += CHUNK_DEL) {
        const chunk = itemIdsOfVor.slice(i, i + CHUNK_DEL)
        const { error } = await supabase
          .from('tender_counterparty_proposals')
          .delete()
          .eq('counterparty_id', counterpartyId)
          .in('estimate_item_id', chunk)
        if (error) throw error
      }

      const payload = preview.records.map(r => ({
        ...r,
        tender_id: tenderId,
        counterparty_id: counterpartyId,
        proposal_date: proposalDate, // task 347
      }))

      // task 367: batch INSERT to handle large proposals safely
      const CHUNK_INS = 500
      let insErr = null
      for (let i = 0; i < payload.length; i += CHUNK_INS) {
        const chunk = payload.slice(i, i + CHUNK_INS)
        let { error: chunkErr } = await supabase
          .from('tender_counterparty_proposals')
          .insert(chunk)
        // Подстраховка: миграция proposal_date ещё не применена — повторяем без поля.
        if (chunkErr && /proposal_date/i.test(chunkErr.message || '')) {
          const stripped = chunk.map(({ proposal_date, ...rest }) => rest) // eslint-disable-line no-unused-vars
          const retry = await supabase.from('tender_counterparty_proposals').insert(stripped)
          chunkErr = retry.error
        }
        if (chunkErr) {
          insErr = chunkErr
          break
        }
      }
      if (insErr) throw insErr

      // Обновляем статус участника на 'proposal_provided' (валидное значение ENUM).
      const { error: statusErr } = await supabase
        .from('tender_counterparties')
        .update({ status: 'proposal_provided' })
        .eq('tender_id', tenderId)
        .eq('counterparty_id', counterpartyId)
      if (statusErr) console.warn('Не удалось обновить статус участника:', statusErr.message)

      // task 367: save source Excel file to S3 (non-fatal on error)
      if (savedFileRef.current) {
        try {
          await addProposalFile({
            tenderId,
            counterpartyId,
            file: savedFileRef.current,
            fileKind: 'commercial_proposal',
          })
        } catch (fileErr) {
          console.warn('Не удалось сохранить исходный файл КП:', fileErr.message)
        }
      }

      const cpName = activeParticipants.find(p => p.counterparty_id === counterpartyId)
        ?.counterparties?.name || 'контрагент'
      alert(`КП сохранён: ${payload.length} позиций для «${cpName}» / «${docName}»`)
      onSaved?.()
    } catch (err) {
      console.error('Ошибка сохранения КП:', err)
      alert('Ошибка сохранения: ' + (err.message || err))
    } finally {
      setSaving(false)
    }
  }

  if (activeParticipants.length === 0) {
    return (
      // Клик по подложке НЕ закрывает окно — закрытие только крестиком/сохранением.
      <div className="modal-overlay">
        <div className="modal vor-import-modal" style={{ maxWidth: '480px' }}>
          <div className="modal-header">
            <h3>Загрузка КП</h3>
            <button className="modal-close" onClick={onClose}>×</button>
          </div>
          <div style={{ padding: '1.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
            В тендере нет приглашённых участников. Сначала добавьте контрагентов
            во вкладке «Участники», затем загружайте КП.
          </div>
        </div>
      </div>
    )
  }
  if (docNames.length === 0) {
    return (
      <div className="modal-overlay">
        <div className="modal vor-import-modal" style={{ maxWidth: '480px' }}>
          <div className="modal-header">
            <h3>Загрузка КП</h3>
            <button className="modal-close" onClick={onClose}>×</button>
          </div>
          <div style={{ padding: '1.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
            В тендере нет ни одного ВОРа. Сначала загрузите ВОР во вкладке «ВОР»,
            затем сравнивайте КП.
          </div>
        </div>
      </div>
    )
  }

  const currentFields = format === 'A' ? A_FIELDS : B_FIELDS
  const currentMap = format === 'A' ? mapA : mapB
  const setCurrentMap = format === 'A' ? setMapA : setMapB
  const updateCurrent = (key, value) => {
    setCurrentMap(prev => ({
      ...prev,
      [key]: value === '' ? null : Number(value),
    }))
  }

  return (
    <div className="modal-overlay">
      <div className="modal vor-import-modal">
        <div className="modal-header">
          <h3>Загрузить КП от участника</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); handleRecognize() }}
          className="vor-import-form"
        >
          {/* Контрагент + ВОР + Дата КП */}
          <div className="vor-import-row">
            <div className="vor-import-field" style={{ flex: 2 }}>
              <label>Контрагент *</label>
              <select
                value={counterpartyId}
                onChange={(e) => setCounterpartyId(e.target.value)}
                required
              >
                {activeParticipants.map(tc => (
                  <option key={tc.counterparty_id} value={tc.counterparty_id}>
                    {tc.counterparties?.name || tc.counterparty_id}
                  </option>
                ))}
              </select>
            </div>
            <div className="vor-import-field" style={{ flex: 2 }}>
              <label>ВОР *</label>
              <select
                value={docName}
                onChange={(e) => setDocName(e.target.value)}
                required
              >
                {docNames.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div className="vor-import-field" style={{ flex: 1 }}>
              <label>Дата КП *</label>
              <input
                type="date"
                value={proposalDate}
                onChange={(e) => setProposalDate(e.target.value)}
                required
              />
            </div>
          </div>

          {/* Формат */}
          <div className="vor-import-section">
            <div className="vor-import-section-head">
              <span className="vor-import-section-title">Формат КП</span>
            </div>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <label className="proposal-format-card" style={{ flex: 1, minWidth: 220 }}>
                <input
                  type="radio"
                  name="proposal-format"
                  value="A"
                  checked={format === 'A'}
                  onChange={() => { setFormat('A'); setPreview(null) }}
                />
                <span>
                  <strong>По позициям ВОР</strong>
                  <small>Excel совпадает построчно с нашим ВОРом, матчинг по № п/п</small>
                </span>
              </label>
              <label className="proposal-format-card" style={{ flex: 1, minWidth: 220 }}>
                <input
                  type="radio"
                  name="proposal-format"
                  value="B"
                  checked={format === 'B'}
                  onChange={() => { setFormat('B'); setPreview(null) }}
                />
                <span>
                  <strong>По агрегатам (Материалы / Работы)</strong>
                  <small>Матчинг по наименованию и ед.изм; цена применяется ко всем совпадениям</small>
                </span>
              </label>
            </div>
            {/* task 367: hide kindHint in two-sheet mode, show in single-sheet mode */}
            {format === 'B' && !sheetNameWork && (
              <div style={{ marginTop: '0.75rem' }}>
                <label className="vor-import-field" style={{ display: 'block' }}>
                  <span style={{
                    fontSize: '0.6875rem', fontWeight: 600,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                    color: 'var(--text-tertiary)',
                    display: 'block', marginBottom: '0.3125rem',
                  }}>Тип строк</span>
                  <select value={kindHint} onChange={(e) => setKindHint(e.target.value)}>
                    <option value="auto">Авто (по имени листа: «Материалы» / «Работы»)</option>
                    <option value="materials">Все строки — материалы</option>
                    <option value="works">Все строки — работы</option>
                    <option value="column">Брать из колонки «Тип»</option>
                  </select>
                </label>
              </div>
            )}
          </div>

          {/* Файл */}
          <div className="vor-import-field">
            <label>Файл Excel *</label>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileSelect}
            />
            {workbook && (
              <small style={{ marginTop: '0.25rem', color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>
                Загружено листов: {sheetNames.length}
              </small>
            )}
          </div>

          {/* Лист + диапазон */}
          {workbook && (
            <>
              {/* task 367: two-sheet support for format B */}
              {format === 'B' && sheetNames.length > 1 && (
                <div className="vor-import-row">
                  <div className="vor-import-field" style={{ flex: 2 }}>
                    <label>Лист — Материалы *</label>
                    <select
                      value={sheetName}
                      onChange={(e) => { setSheetName(e.target.value); setPreview(null) }}
                    >
                      {sheetNames.map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                  <div className="vor-import-field" style={{ flex: 2 }}>
                    <label>Лист — Работы (опционально)</label>
                    <select
                      value={sheetNameWork}
                      onChange={(e) => { setSheetNameWork(e.target.value); setPreview(null) }}
                    >
                      <option value="">— тот же лист / авто</option>
                      {sheetNames.map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                </div>
              )}
              {/* Single-sheet mode or format A: show single sheet selector */}
              {!(format === 'B' && sheetNames.length > 1) && (
                <div className="vor-import-row">
                  {sheetNames.length > 1 && (
                    <div className="vor-import-field" style={{ flex: 2 }}>
                      <label>Лист Excel</label>
                      <select
                        value={sheetName}
                        onChange={(e) => { setSheetName(e.target.value); setPreview(null) }}
                      >
                        {sheetNames.map(n => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </div>
                  )}
                </div>
              )}
              <div className="vor-import-row">
                <div className="vor-import-field">
                  <label>Со строки</label>
                  <input
                    type="number" min="1" value={startRow}
                    onChange={(e) => setStartRow(e.target.value)}
                    placeholder="2"
                  />
                </div>
                <div className="vor-import-field">
                  <label>По строку</label>
                  <input
                    type="number" min="1" value={endRow}
                    onChange={(e) => setEndRow(e.target.value)}
                    placeholder="Все"
                  />
                </div>
              </div>

              {/* Column mapping */}
              <div className="vor-import-section">
                <div className="vor-import-section-head">
                  <span className="vor-import-section-title">Сопоставление столбцов</span>
                  <button
                    type="button"
                    className="vor-import-reset"
                    onClick={() => format === 'A' ? setMapA({ ...A_DEFAULTS }) : setMapB({ ...B_DEFAULTS })}
                  >Сбросить</button>
                </div>
                <div className="vor-column-map-grid">
                  {currentFields.map(f => {
                    const required = (format === 'A' && (f.key === 'priceMaterial' || f.key === 'priceWork'))
                      || (format === 'B' && (f.key === 'name' || f.key === 'price'))
                    const optionalIfNotColumn = format === 'B' && f.key === 'kind' && kindHint !== 'column'
                    return (
                      <label key={f.key} className="vor-column-map-row">
                        <span className="vor-column-map-label">
                          {f.label} {required && <span style={{ color: '#dc2626' }}>*</span>}
                          {optionalIfNotColumn && (
                            <span style={{ color: 'var(--text-tertiary)', fontSize: '0.6875rem' }}> (только если «брать из колонки»)</span>
                          )}
                        </span>
                        <select
                          className="vor-column-map-select"
                          value={currentMap[f.key] ?? ''}
                          onChange={(e) => updateCurrent(f.key, e.target.value)}
                        >
                          <option value="">— не использовать</option>
                          {Array.from({ length: COLUMN_COUNT }, (_, idx) => {
                            const letter = XLSX.utils.encode_col(idx)
                            const prev = columnPreviews[idx]
                            return (
                              <option key={idx} value={idx}>
                                {letter}{prev ? ` — ${prev}` : ''}
                              </option>
                            )
                          })}
                        </select>
                      </label>
                    )
                  })}
                </div>
              </div>
            </>
          )}

          {/* Preview */}
          {preview && (
            <div className="vor-import-section">
              <div className="vor-import-section-head">
                <span className="vor-import-section-title">
                  Распознано: {preview.records.length} позиций
                </span>
              </div>
              {preview.warnings.length > 0 && (
                <ul style={{ margin: '0 0 0.625rem', paddingLeft: '1.25rem', fontSize: '0.75rem', color: '#b45309' }}>
                  {preview.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
              {preview.unmatched.length > 0 && (
                <details style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                  <summary style={{ cursor: 'pointer' }}>
                    Не сматчено: {preview.unmatched.length} строк
                  </summary>
                  <ul style={{ marginTop: '0.375rem', paddingLeft: '1.25rem', maxHeight: 160, overflow: 'auto' }}>
                    {preview.unmatched.slice(0, 50).map((u, i) => (
                      <li key={i}>
                        Стр. {u.row}: {u.name || u.rowNumber} — {u.reason}
                      </li>
                    ))}
                    {preview.unmatched.length > 50 && (
                      <li><em>… и ещё {preview.unmatched.length - 50}</em></li>
                    )}
                  </ul>
                </details>
              )}
            </div>
          )}

          <div className="vor-import-actions">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
              Отмена
            </button>
            <button type="submit" className="btn-secondary" disabled={!workbook || saving}>
              {preview ? 'Перераспознать' : 'Распознать'}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={handleSave}
              disabled={!preview || preview.records.length === 0 || saving}
            >
              {saving ? 'Сохранение…' : 'Сохранить КП'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default TenderProposalUploadModal
