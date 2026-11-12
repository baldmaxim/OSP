// Загрузка документа сметы КП / ПЗ: файл КП и/или файл сметы ПЗ (можно оба сразу, бросить в окно). До загрузки —
// сводка: строки, разделы, укрупнённые позиции, связь КП ↔ ПЗ, сверка формул и итогов, коэффициенты; при замене
// действующей версии — сколько отметок и распределений перейдёт на новую.
import { useEffect, useMemo, useRef, useState } from 'react'
import { buildEstimateRows, detectEstimateWorkbook, masteringToAllocations, parseKpWorkbook, parsePzWorkbook } from '../../utils/kpEstimateImport'
import { fmtMoney } from '../../utils/kpEstimate'
import { insertAllocations, loadRows, uploadEstimate } from '../../services/kpEstimate'

const isExcel = (f) => /\.(xlsx|xlsm|xls)$/i.test(f?.name || '')

async function readWorkbook(file) {
  const mod = await import('xlsx')
  const XLSX = mod.utils ? mod : mod.default
  const buf = await file.arrayBuffer()
  return { XLSX, wb: XLSX.read(buf, { type: 'array', cellFormula: true }) }
}

export default function KpEstimateImportDialog({ objectId, current, currentRows, currentMarks, currentAllocs, onClose, onDone }) {
  const [files, setFiles] = useState({ kp: null, pz: null })
  const [parsed, setParsed] = useState({ kp: null, pz: null })
  const [reading, setReading] = useState(false)
  const [problem, setProblem] = useState('')
  const [progress, setProgress] = useState(null)
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const addFiles = async (list) => {
    const excel = [...list].filter(isExcel)
    if (!excel.length) { setProblem('Нужен файл Excel (.xlsx): КП до перекидок и/или смета ПЗ.'); return }
    setReading(true)
    setProblem('')
    try {
      const nextFiles = { ...files }
      const nextParsed = { ...parsed }
      for (const file of excel.slice(0, 2)) {
        const { XLSX, wb } = await readWorkbook(file)
        const kind = detectEstimateWorkbook(XLSX, wb)
        if (!kind) { setProblem(`«${file.name}»: не похоже ни на КП (лист с «Номером раздела», «Номером позиции», «Коммерческой стоимостью»), ни на смету ПЗ (лист «Смета» с «Прямыми затратами»).`); continue }
        const result = kind === 'kp' ? parseKpWorkbook(XLSX, wb) : parsePzWorkbook(XLSX, wb)
        if (result.error) { setProblem(`«${file.name}»: ${result.message}`); continue }
        nextFiles[kind] = file
        nextParsed[kind] = result
      }
      setFiles(nextFiles)
      setParsed(nextParsed)
    } catch (e) {
      setProblem(`Файл не читается: ${e.message || e}`)
    } finally {
      setReading(false)
    }
  }

  const built = useMemo(() => {
    if (!parsed.kp && !parsed.pz) return null
    return buildEstimateRows({ kp: parsed.kp, pz: parsed.pz, kpFileName: files.kp?.name, pzFileName: files.pz?.name })
  }, [parsed, files])

  // Что перейдёт на новую версию: отметки и распределения строк с тем же ключом (как kp_estimate_row_map в базе,
  // второй признак — тот же код и наименование — база проверит сама).
  const transfer = useMemo(() => {
    if (!built?.rows || !current) return null
    const keys = new Set(built.rows.map((r) => r.row_key))
    const byId = new Map((currentRows || []).map((r) => [r.id, r]))
    let marks = 0; let marksLeft = 0; let allocs = 0; let allocsLeft = 0
    for (const m of currentMarks?.values?.() || []) (keys.has(byId.get(m.row_id)?.row_key) ? marks++ : marksLeft++)
    for (const list of currentAllocs?.values?.() || []) for (const a of list) (keys.has(byId.get(a.row_id)?.row_key) ? allocs++ : allocsLeft++)
    return { marks, marksLeft, allocs, allocsLeft }
  }, [built, current, currentRows, currentMarks, currentAllocs])

  const upload = async () => {
    if (!built?.rows?.length) return
    setBusy(true)
    setProblem('')
    try {
      const res = await uploadEstimate({ objectId, built, files, onProgress: setProgress })
      // Списания листа «Освоение» — распределениями (объём = сумма / цена позиции).
      let mastered = 0
      if (built.mastering?.length) {
        setProgress({ stage: 'mastering' })
        const rows = await loadRows(res.estimate.id)
        const idByNo = new Map(rows.map((r) => [r.row_no, r.id]))
        const { allocations } = masteringToAllocations(built.mastering, built.rows)
        const items = allocations.map(({ row_no, ...a }) => ({ ...a, row_id: idByNo.get(row_no) })).filter((a) => a.row_id)
        if (items.length) mastered = (await insertAllocations(res.estimate.id, objectId, items)).length
      }
      onDone({ ...res, mastered })
    } catch (e) {
      setProblem(e.message || String(e))
      setBusy(false)
      setProgress(null)
    }
  }

  const st = built?.stats
  const meta = built?.meta
  const kinds = useMemo(() => {
    const out = {}
    for (const r of built?.rows || []) out[r.kind] = (out[r.kind] || 0) + 1
    return out
  }, [built])
  const fc = meta?.formula_check

  return (
    <div className="kpe-modal-overlay" role="presentation">
      <div className="kpe-modal" role="dialog" aria-modal="true" aria-label="Загрузка сметы КП / ПЗ"
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); if (!busy) addFiles(e.dataTransfer.files) }}>
        <header className="kpe-modal-head">
          <h3>{current ? 'Новая версия сметы КП / ПЗ' : 'Загрузка сметы КП / ПЗ'}</h3>
          <button type="button" className="kpe-icon-btn" aria-label="Закрыть" disabled={busy} onClick={onClose}>✕</button>
        </header>
        <div className="kpe-modal-body">
          <div className={`kpe-drop${drag ? ' is-drag' : ''}`}>
            <p><b>КП до перекидок</b> — укрупнённые позиции по системам (лист «Комм. затраты»), и <b>смета ПЗ</b> — те же позиции с прямыми затратами и коэффициентами (листы «Смета», «Коэффициенты», «Паспорт»).</p>
            <p className="kpe-muted">Перетащите один или оба файла сюда или выберите. Можно загрузить только один из них.</p>
            <input ref={inputRef} type="file" accept=".xlsx,.xlsm,.xls" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
            <button type="button" className="kpe-btn" disabled={busy || reading} onClick={() => inputRef.current?.click()}>Выбрать файлы</button>
            <ul className="kpe-file-list">
              <li className={files.kp ? 'is-ok' : ''}>КП: {files.kp ? files.kp.name : <span className="kpe-muted">не выбран</span>}
                {files.kp && !busy && <button type="button" className="kpe-text-btn" onClick={() => { setFiles({ ...files, kp: null }); setParsed({ ...parsed, kp: null }) }}>убрать</button>}</li>
              <li className={files.pz ? 'is-ok' : ''}>Смета ПЗ: {files.pz ? files.pz.name : <span className="kpe-muted">не выбрана</span>}
                {files.pz && !busy && <button type="button" className="kpe-text-btn" onClick={() => { setFiles({ ...files, pz: null }); setParsed({ ...parsed, pz: null }) }}>убрать</button>}</li>
            </ul>
            {reading && <p className="kpe-muted">Читаем файл…</p>}
          </div>

          {problem && <div className="kpe-warn" role="alert">{problem}</div>}

          {built && !built.error && (
            <div className="kpe-import-summary">
              <h4>{meta.title}</h4>
              <dl className="kpe-dl">
                <dt>Строк</dt><dd>{built.rows.length.toLocaleString('ru-RU')}: разделов {kinds.section || 0}, групп {kinds.group || 0}, укрупнённых позиций {kinds.aggregate || 0}, позиций {(kinds.position || 0) + (kinds.adjust || 0)}</dd>
                {parsed.kp && <><dt>КП</dt><dd>лист «{parsed.kp.sheetName}», итог {fmtMoney(fc?.totals?.total)} ₽{parsed.kp.hasSubtotals ? ', вложенность — по формулам SUBTOTAL' : ', формул SUBTOTAL нет — вложенность по кодам'}</dd></>}
                {parsed.pz && <><dt>Смета ПЗ</dt><dd>{st.pzPositions.toLocaleString('ru-RU')} позиций; с КП связано {st.linked.toLocaleString('ru-RU')}{st.pzOnly ? `, только в ПЗ — ${st.pzOnly}` : ''}{meta.pz_file?.totals ? `; прямые ${fmtMoney(meta.pz_file.totals.direct)} ₽, коммерция ${fmtMoney(meta.pz_file.totals.total)} ₽` : ''}</dd></>}
                {parsed.kp && parsed.pz && st.kpLeavesWithoutPz > 0 && <><dt>Нет в ПЗ</dt><dd>{st.kpLeavesWithoutPz} позиций КП (нулевые строки «Учтено» и т. п.)</dd></>}
                <dt>Формулы</dt><dd>{fc?.issue_count ? <span className="kpe-over">расхождений: {fc.issue_count} — список в «Паспорте» после загрузки</span> : 'сверены: кол-во × цена, суммы групп и итог совпадают'}</dd>
                {meta.vat && <><dt>НДС</dt><dd>{meta.vat}</dd></>}
                {meta.coefficients?.length > 0 && <><dt>Коэффициенты</dt><dd>лист «Коэффициенты» сохранён ({meta.coefficients.length} строк)</dd></>}
                {built.mastering?.length > 0 && <><dt>Освоение</dt><dd>{built.mastering.length} списаний станут распределениями</dd></>}
              </dl>
              {current && transfer && (
                <div className="kpe-note-box">
                  Действующая версия «{current.title}» станет прежней (её можно открыть). На новую перейдут отметки: {transfer.marks}, распределения: {transfer.allocs}
                  {(transfer.marksLeft || transfer.allocsLeft) ? <> — не найдётся строк для {transfer.marksLeft} отметок и {transfer.allocsLeft} распределений, они останутся у прежней версии</> : null}.
                </div>
              )}
            </div>
          )}
          {built?.error && <div className="kpe-warn">{built.message}</div>}

          {progress && (
            <div className="kpe-progress" role="status">
              {progress.stage === 'rows' && <>Загружаем строки: {progress.done.toLocaleString('ru-RU')} из {progress.total.toLocaleString('ru-RU')}<progress max={progress.total} value={progress.done} /></>}
              {progress.stage === 'file' && <>Сохраняем исходный файл {progress.kind === 'kp' ? 'КП' : 'сметы ПЗ'}…</>}
              {progress.stage === 'activate' && <>Делаем версию действующей{current ? ' и переносим отметки' : ''}…</>}
              {progress.stage === 'mastering' && <>Переносим списания листа «Освоение»…</>}
            </div>
          )}
        </div>
        <footer className="kpe-modal-foot">
          <button type="button" className="kpe-btn" disabled={busy} onClick={onClose}>Отмена</button>
          <button type="button" className="kpe-btn kpe-btn--primary" disabled={busy || reading || !built?.rows?.length} onClick={upload}>
            {busy ? 'Загружаем…' : current ? 'Загрузить новую версию' : 'Загрузить'}
          </button>
        </footer>
      </div>
    </div>
  )
}
