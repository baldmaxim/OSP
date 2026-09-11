import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import XLSXStyle from 'xlsx-js-style'
import PizZip from 'pizzip'
import { supabase } from '../supabase'
import { fetchAllRows } from '../utils/fetchAllRows'
import {
  IMPORT_COLUMNS,
  TEMPLATE_HEADERS,
  mapHeaderRow,
  validateRow,
  normInn,
  normMatchName,
} from '../utils/contractsImport'
import { DOC_TYPES, buildDocIndex } from '../utils/contractAmendments'
import './ContractsImportModal.css'

const CHUNK = 200
const KEY_TO_CANONICAL = Object.fromEntries(IMPORT_COLUMNS.map((c, i) => [c.key, i]))

// Пакетная нарезка массива.
function chunks(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// Значение ячейки для отчёта: даты — в ДД.ММ.ГГГГ, остальное — как есть.
function cellDisplay(v) {
  if (v == null) return ''
  if (v instanceof Date && !isNaN(v.getTime())) {
    const p = (n) => String(n).padStart(2, '0')
    return `${p(v.getDate())}.${p(v.getMonth() + 1)}.${v.getFullYear()}`
  }
  return String(v)
}

// Выпадающий список значений в колонке шаблона.
//
// SheetJS в открытой сборке НЕ умеет записывать data validation (`dataValidation`
// встречается только в парсере XML-формата), поэтому дописываем элемент в готовый
// xlsx: он же обычный zip, а pizzip в проекте уже есть (разбор .docx договоров).
// Порядок элементов внутри <worksheet> задан схемой: dataValidations идут после
// sheetData и перед hyperlinks/pageMargins/ignoredErrors — вставляем перед первым
// из них, иначе Excel сочтёт файл повреждённым.
const DV_ANCHORS = ['<hyperlinks', '<printOptions', '<pageMargins', '<pageSetup', '<ignoredErrors', '</worksheet>']
const xmlAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function addListValidation(buffer, colIndex, values, title) {
  if (colIndex == null || !values.length) return buffer
  try {
    const zip = new PizZip(buffer)
    const path = 'xl/worksheets/sheet1.xml'
    const file = zip.file(path)
    if (!file) return buffer
    const xml = file.asText()
    const at = DV_ANCHORS.map((a) => xml.indexOf(a)).filter((i) => i >= 0).sort((a, b) => a - b)[0]
    if (at == null) return buffer

    const col = XLSX.utils.encode_col(colIndex)
    const dv =
      '<dataValidations count="1">' +
      `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1"` +
      ` errorTitle="${xmlAttr(title)}" error="Выберите значение из списка" sqref="${col}2:${col}2000">` +
      `<formula1>"${xmlAttr(values.join(','))}"</formula1>` +
      '</dataValidation></dataValidations>'
    zip.file(path, xml.slice(0, at) + dv + xml.slice(at))
    return zip.generate({ type: 'arraybuffer', compression: 'DEFLATE' })
  } catch (err) {
    // Список — удобство, а не условие загрузки: шаблон отдаём и без него.
    console.error('Не удалось добавить выпадающий список в шаблон:', err)
    return buffer
  }
}

function downloadBlob(buffer, fileName) {
  const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// Причины, по которым строка не загрузилась. Показываем их на экране результата:
// в файл ошибок служебные колонки добавлять нельзя — он должен грузиться обратно.
function skipReasons(row) {
  const r = row.result
  if (r.kind === 'error') return [...new Set(r.errors.map((e) => e.message))]
  if (row.saveError) return [`Ошибка сохранения: ${row.saveError}`]
  // невыбранное предупреждение
  return r.warnings.map((w) => {
    if (w.type === 'dup_number') return 'Пропущено пользователем: повторный номер договора'
    if (w.type === 'empty_number') return 'Пропущено пользователем: пустой номер договора'
    if (w.type === 'empty_date') return 'Пропущено пользователем: пустая дата договора'
    return 'Пропущено пользователем'
  })
}

function ContractsImportModal({ counterparties = [], objects = [], onClose, onImported }) {
  const [step, setStep] = useState('select')     // select | preview | result
  const [fileName, setFileName] = useState('')
  const [parseError, setParseError] = useState('')
  const [parsed, setParsed] = useState([])        // [{ excelRow, raw, disp, result }]
  const [checked, setChecked] = useState(() => new Set())
  const [existingNumbers, setExistingNumbers] = useState(null) // Set | null (загружается)
  // Дерево уже заведённых документов: { index, amendmentNumbers }.
  const [docs, setDocs] = useState(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [resultInfo, setResultInfo] = useState(null) // { created, notLoaded: [...] }

  // Индексы справочников для сопоставления (контрагенты без soft-deleted).
  const ctxRefs = useMemo(() => {
    const cpByInn = new Map()
    const cpByName = new Map()
    const objByName = new Map()
    const pushMap = (m, k, id) => { if (!k) return; const a = m.get(k) || []; if (!a.includes(id)) a.push(id); m.set(k, a) }
    counterparties.forEach((cp) => {
      if (cp.deleted_at) return
      pushMap(cpByInn, normInn(cp.inn), cp.id)
      pushMap(cpByName, normMatchName(cp.name), cp.id)
    })
    objects.forEach((o) => pushMap(objByName, normMatchName(o.name), o.id))
    return { cpByInn, cpByName, objByName }
  }, [counterparties, objects])

  // Существующие документы: нужны и для предупреждения «номер уже существует», и
  // для ДС — найти изменяемый документ по ID, проверить правила ветки и
  // унаследовать условия. Грузим одним запросом, дерево строим в памяти.
  useEffect(() => {
    let cancelled = false
    fetchAllRows((from, to) => supabase
      .from('contracts')
      .select('id, display_id, record_type, parent_contract_id, root_contract_id, status, deleted_at, contract_number, counterparty_id, object_id, changed_fields, contract_amount, gp_amount, currency, vat_rate, amount_includes_vat, bsm, work_name, work_start_date, work_end_date, warranty_retention_percent, warranty_retention_period, warranty_period')
      .range(from, to))
      .then((rows) => {
        if (cancelled) return
        const live = rows.filter((r) => !r.deleted_at)
        const numbers = new Set()
        const amendmentNumbers = new Set()
        live.forEach((r) => {
          const n = String(r.contract_number || '').trim()
          if (!n) return
          if (r.record_type === 'dp') numbers.add(n)
          else amendmentNumbers.add(`${r.root_contract_id || r.id}|${n}`)
        })
        setDocs({ index: buildDocIndex(live), amendmentNumbers })
        setExistingNumbers(numbers)
      })
      .catch((err) => {
        if (cancelled) return
        console.error('Загрузка документов договоров:', err.message)
        // Без списка существующих документов импорт вслепую опасен: не ловятся
        // дубли номеров, а ДС не находят изменяемый документ. Блокируем.
        const missingColumn = err.code === '42703' || /does not exist/i.test(err.message || '')
        setLoadError(missingColumn
          ? 'В базе не применена миграция 20260906_contract_amendments (нет колонок для ДС). Импорт недоступен, пока её не применят.'
          : `Не удалось загрузить существующие договоры: ${err.message}`)
      })
    return () => { cancelled = true }
  }, [])

  const stats = useMemo(() => {
    const s = { total: parsed.length, ready: 0, warn: 0, error: 0 }
    parsed.forEach((row) => {
      if (row.result.kind === 'ready') s.ready++
      else if (row.result.kind === 'warn') s.warn++
      else if (row.result.kind === 'error') s.error++
    })
    return s
  }, [parsed])

  const warnRows = useMemo(() => parsed.filter((r) => r.result.kind === 'warn'), [parsed])
  const toCreateCount = stats.ready + warnRows.filter((r) => checked.has(r.excelRow)).length

  async function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setParseError('')
    setFileName(file.name)
    if (existingNumbers == null || docs == null) {
      setParseError('Идёт загрузка справочников, повторите через мгновение.')
      e.target.value = ''
      return
    }
    try {
      const buf = await file.arrayBuffer()
      // БЕЗ cellDates: даты-ячейки остаются Excel-серийниками (число в cell.v) и
      // разбираются через XLSX.SSF независимо от часового пояса. cellDates:true
      // создавал Date-объекты, зависящие от TZ, из-за чего даты «съезжали» на день.
      const wb = XLSX.read(buf, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      if (!ws || !ws['!ref']) { setParseError('Файл пуст или не содержит данных.'); e.target.value = ''; return }
      const range = XLSX.utils.decode_range(ws['!ref'])

      const headerRow = []
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r: range.s.r, c })]
        headerRow.push(cell ? cell.v : '')
      }
      const { colIndexByKey } = mapHeaderRow(headerRow)

      const ctx = {
        ...ctxRefs,
        existingNumbers,
        docIndex: docs.index,
        // Копия: по мере успешной загрузки строк файла пополняем её, чтобы
        // дубль номера ДС внутри одного файла тоже отлавливался.
        amendmentNumbers: new Set(docs.amendmentNumbers),
      }
      const rows = []
      for (let r = range.s.r + 1; r <= range.e.r; r++) {
        const raw = {}
        const disp = {}
        let nonEmpty = false
        for (const col of IMPORT_COLUMNS) {
          const c = colIndexByKey[col.key]
          const cell = ws[XLSX.utils.encode_cell({ r, c })]
          let val = cell ? cell.v : ''
          if (col.key === 'document_link' && cell && cell.l && cell.l.Target) val = cell.l.Target
          raw[col.key] = val == null ? '' : val
          disp[col.key] = cell ? (cell.w != null ? cell.w : val) : ''
          if (raw[col.key] !== '' && raw[col.key] != null) nonEmpty = true
        }
        if (!nonEmpty) continue
        const result = validateRow(raw, ctx)
        // Номер ДС из принятой строки резервируем сразу: две одинаковые строки в
        // одном файле не должны обе пройти проверку уникальности.
        const p = result.payload
        if (p && p.record_type !== 'dp' && p.contract_number) {
          const parent = ctx.docIndex.byId.get(p.parent_contract_id)
          const rootId = parent?.root_contract_id || parent?.id
          if (rootId) ctx.amendmentNumbers.add(`${rootId}|${String(p.contract_number).trim()}`)
        }
        rows.push({ excelRow: r + 1, raw, disp, result })
      }

      if (rows.length === 0) { setParseError('В файле нет строк с данными (после строки заголовков).'); e.target.value = ''; return }

      setParsed(rows)
      setChecked(new Set())
      setStep('preview')
    } catch (err) {
      console.error('Ошибка чтения Excel:', err)
      setParseError('Не удалось прочитать файл. Убедитесь, что это .xlsx с одним листом.')
    } finally {
      e.target.value = ''
    }
  }

  function toggleCheck(excelRow) {
    setChecked((prev) => { const n = new Set(prev); n.has(excelRow) ? n.delete(excelRow) : n.add(excelRow); return n })
  }
  function checkAllWarns(on) {
    setChecked(on ? new Set(warnRows.map((r) => r.excelRow)) : new Set())
  }

  function downloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS])
    ws['!cols'] = TEMPLATE_HEADERS.map((h) => ({ wch: Math.max(14, h.length + 2) }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Договоры')
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
    downloadBlob(
      addListValidation(buf, KEY_TO_CANONICAL.record_type, DOC_TYPES.map((t) => t.label), 'Тип документа'),
      'Шаблон_импорта_договоров.xlsx',
    )
  }

  async function handleConfirm() {
    setIsProcessing(true)
    try {
      const toCreate = [
        ...parsed.filter((r) => r.result.kind === 'ready'),
        ...warnRows.filter((r) => checked.has(r.excelRow)),
      ]
      let created = 0
      const junction = []
      const failed = []

      for (const chunk of chunks(toCreate, CHUNK)) {
        const payloads = chunk.map((x) => x.result.payload)
        const { data, error } = await supabase.from('contracts').insert(payloads).select('id, counterparty_id')
        if (!error) {
          created += (data || []).length
          ;(data || []).forEach((d) => { if (d.counterparty_id) junction.push({ contract_id: d.id, counterparty_id: d.counterparty_id, sort_order: 0 }) })
        } else {
          // Изолируем сбойную строку — вставляем по одной, остальные из чанка сохраняются.
          for (const x of chunk) {
            const { data: d, error: e } = await supabase.from('contracts').insert(x.result.payload).select('id, counterparty_id').single()
            if (e) { x.saveError = e.message; failed.push(x) }
            else { created++; if (d.counterparty_id) junction.push({ contract_id: d.id, counterparty_id: d.counterparty_id, sort_order: 0 }) }
          }
        }
      }

      // Стороны договора (та же логика, что и в ручной форме): одна сторона, sort_order 0.
      for (const jchunk of chunks(junction, CHUNK)) {
        const { error } = await supabase.from('contract_counterparties').insert(jchunk)
        if (error) console.error('Ошибка записи сторон договора:', error.message)
      }

      const notLoaded = [
        ...parsed.filter((r) => r.result.kind === 'error'),
        ...warnRows.filter((r) => !checked.has(r.excelRow)),
        ...failed,
      ].sort((a, b) => a.excelRow - b.excelRow)

      setResultInfo({ created, notLoaded })
      setStep('result')
    } catch (err) {
      console.error('Ошибка импорта:', err)
      setParseError('Ошибка при сохранении: ' + (err.message || err))
    } finally {
      setIsProcessing(false)
    }
  }

  function downloadReport() {
    const rows = resultInfo?.notLoaded || []
    if (rows.length === 0) return
    // Ровно тот же шаблон: те же 29 колонок, тот же порядок, те же заголовки.
    // Никаких служебных колонок, комментариев и листов — причины ошибок человек
    // читает на странице, а файл должен открываться и грузиться обратно как есть.
    const header = TEMPLATE_HEADERS
    const aoa = [header]
    rows.forEach((row) => {
      aoa.push(IMPORT_COLUMNS.map((c) => cellDisplay(row.disp[c.key])))
    })
    const ws = XLSXStyle.utils.aoa_to_sheet(aoa)
    ws['!cols'] = header.map((h) => ({ wch: Math.max(14, h.length + 2) }))

    const RED = { fill: { patternType: 'solid', fgColor: { rgb: 'FFF4CCCC' } } }
    rows.forEach((row, i) => {
      if (row.result.kind !== 'error') return // пропуски пользователя и ДС не красим
      const errKeys = new Set(row.result.errors.map((e) => e.key))
      errKeys.forEach((key) => {
        const c = KEY_TO_CANONICAL[key]
        if (c == null) return
        const ref = XLSXStyle.utils.encode_cell({ r: i + 1, c })
        if (!ws[ref]) ws[ref] = { t: 's', v: '' }
        ws[ref].s = RED
      })
    })
    const wb = XLSXStyle.utils.book_new()
    XLSXStyle.utils.book_append_sheet(wb, ws, 'Отчёт')
    XLSXStyle.writeFile(wb, 'Отчёт_импорта_договоров.xlsx')
  }

  function finish() {
    if (onImported) onImported(resultInfo?.created || 0)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal cim-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Импорт договоров из Excel</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="cim-body">
          {/* Шаг 1 — выбор файла */}
          {step === 'select' && (
            <div className="cim-select">
              <p className="cim-hint">
                Загрузите файл <strong>.xlsx</strong> (один лист, первая строка — заголовки).
                Импорт только создаёт новые документы и никогда не изменяет существующие.
                Для ДС в колонке «Тип» выберите подвид, а в «ID изменяемого документа» укажите
                ID документа, который это соглашение меняет.
              </p>
              <div className="cim-select-actions">
                <button type="button" className="btn-secondary" onClick={downloadTemplate}>Скачать шаблон</button>
                <label className={`btn-primary cim-file-label${existingNumbers == null ? ' is-disabled' : ''}`}>
                  Выбрать файл .xlsx
                  <input type="file" accept=".xlsx" onChange={handleFile} disabled={existingNumbers == null} hidden />
                </label>
              </div>
              {loadError && <p className="cim-error">{loadError}</p>}
              {existingNumbers == null && !loadError && <p className="cim-loading">Загрузка справочников…</p>}
              {parseError && <p className="cim-error">{parseError}</p>}
            </div>
          )}

          {/* Шаг 2 — предпросмотр */}
          {step === 'preview' && (
            <div className="cim-preview">
              <div className="cim-file">Файл: <strong>{fileName}</strong></div>
              <div className="cim-stats">
                <div className="cim-stat"><span className="cim-stat-v">{stats.total}</span><span className="cim-stat-l">Всего строк</span></div>
                <div className="cim-stat is-ready"><span className="cim-stat-v">{stats.ready}</span><span className="cim-stat-l">Готовы</span></div>
                <div className="cim-stat is-warn"><span className="cim-stat-v">{stats.warn}</span><span className="cim-stat-l">Требуют подтверждения</span></div>
                <div className="cim-stat is-error"><span className="cim-stat-v">{stats.error}</span><span className="cim-stat-l">С ошибками</span></div>
              </div>

              {warnRows.length > 0 && (
                <div className="cim-warn-block">
                  <div className="cim-warn-head">
                    <h4>Требуют подтверждения ({warnRows.length})</h4>
                    <div className="cim-warn-bulk">
                      <button type="button" className="qfilter" onClick={() => checkAllWarns(true)}>Отметить все</button>
                      <button type="button" className="qfilter" onClick={() => checkAllWarns(false)}>Снять все</button>
                    </div>
                  </div>
                  <p className="cim-hint">Отметьте строки, которые всё равно нужно создать. Повторный номер создаёт новый самостоятельный договор — существующий не меняется.</p>
                  <div className="cim-warn-table-wrap">
                    <table className="cim-warn-table">
                      <thead>
                        <tr>
                          <th className="cim-cb"></th>
                          <th>Строка</th>
                          <th>№ договора</th>
                          <th>Контрагент</th>
                          <th>Объект</th>
                          <th>Причина</th>
                        </tr>
                      </thead>
                      <tbody>
                        {warnRows.map((row) => (
                          <tr key={row.excelRow} className={checked.has(row.excelRow) ? 'is-checked' : ''}>
                            <td className="cim-cb">
                              <input type="checkbox" checked={checked.has(row.excelRow)} onChange={() => toggleCheck(row.excelRow)} />
                            </td>
                            <td>{row.excelRow}</td>
                            <td>{cellDisplay(row.disp.contract_number) || '—'}</td>
                            <td>{cellDisplay(row.disp.counterparty_name) || '—'}</td>
                            <td>{cellDisplay(row.disp.object_name) || '—'}</td>
                            <td>{row.result.warnings.map((w) => w.label).join('; ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {stats.error > 0 && (
                <>
                  <p className="cim-note cim-note-error">{stats.error} строк(и) с ошибками данных не будут загружены:</p>
                  <div className="cim-warn-table-wrap">
                    <table className="cim-warn-table">
                      <thead>
                        <tr>
                          <th>Строка</th>
                          <th>№ документа</th>
                          <th>Причина</th>
                        </tr>
                      </thead>
                      <tbody>
                        {parsed.filter((r) => r.result.kind === 'error').map((row) => (
                          <tr key={row.excelRow}>
                            <td>{row.excelRow}</td>
                            <td>{cellDisplay(row.disp.contract_number) || '—'}</td>
                            <td>{skipReasons(row).join('; ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Шаг 3 — итог */}
          {step === 'result' && resultInfo && (
            <div className="cim-result">
              <div className="cim-result-big">Создано договоров: <strong>{resultInfo.created}</strong></div>
              {resultInfo.notLoaded.length > 0 ? (
                <>
                  {/* Причины показываем здесь: в файле ошибок их быть не должно —
                      он повторяет шаблон и должен грузиться обратно как есть. */}
                  <p className="cim-note">Не загружено строк: <strong>{resultInfo.notLoaded.length}</strong>. Исправьте их в отчёте (ошибочные ячейки подсвечены) и загрузите файл повторно.</p>
                  <div className="cim-warn-table-wrap">
                    <table className="cim-warn-table">
                      <thead>
                        <tr>
                          <th>Строка</th>
                          <th>№ документа</th>
                          <th>Причина</th>
                        </tr>
                      </thead>
                      <tbody>
                        {resultInfo.notLoaded.map((row) => (
                          <tr key={row.excelRow}>
                            <td>{row.excelRow}</td>
                            <td>{cellDisplay(row.disp.contract_number) || '—'}</td>
                            <td>{skipReasons(row).join('; ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <p className="cim-note">Все подходящие строки успешно загружены.</p>
              )}
            </div>
          )}
        </div>

        <div className="cim-footer">
          {step === 'preview' && (
            <>
              <button type="button" className="btn-secondary" onClick={() => setStep('select')} disabled={isProcessing}>Назад</button>
              <button type="button" className="btn-primary" onClick={handleConfirm} disabled={isProcessing || toCreateCount === 0}>
                {isProcessing ? 'Создание…' : `Завершить импорт (${toCreateCount})`}
              </button>
            </>
          )}
          {step === 'result' && (
            <>
              {resultInfo?.notLoaded.length > 0 && (
                <button type="button" className="btn-secondary" onClick={downloadReport}>Скачать отчёт</button>
              )}
              <button type="button" className="btn-primary" onClick={finish}>Готово</button>
            </>
          )}
          {step === 'select' && (
            <button type="button" className="btn-secondary" onClick={onClose}>Отмена</button>
          )}
        </div>
      </div>
    </div>
  )
}

export default ContractsImportModal
