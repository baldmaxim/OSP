import { useEffect, useState } from 'react'
import { fetchFileBytes } from '../services/s3'
import { sheetView } from '../utils/filePreview'
import './SheetPreview.css'

// Просмотр файла Excel в окне S3DocumentPreview (13.11.2026): листы вкладками, значения — как показывает Excel, объединённые ячейки
// сохраняются. Только чтение; формулы, картинки и оформление не показываются. Текст ячеек выводит React — разметка из файла
// в страницу не попадает. Скрытые листы не показываются; больше 2000 строк и 60 столбцов — начало и пометка.
export default function SheetPreview({ s3Key }) {
  const [state, setState] = useState({ status: 'loading', sheets: [], error: '' })
  const [active, setActive] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading', sheets: [], error: '' })
    setActive(0)
    Promise.all([import('xlsx'), fetchFileBytes(s3Key)])
      .then(([XLSX, bytes]) => {
        if (cancelled) return
        const wb = XLSX.read(bytes, { type: 'array', cellDates: true })
        const hidden = new Set((wb.Workbook?.Sheets || []).filter((s) => s.Hidden).map((s) => s.name))
        const sheets = wb.SheetNames.filter((name) => !hidden.has(name)).map((name) => ({ name, ...sheetView(XLSX, wb.Sheets[name]) }))
        setState({ status: 'ready', sheets, error: '' })
      })
      .catch((err) => {
        if (!cancelled) setState({ status: 'error', sheets: [], error: err.message || 'Файл не открылся' })
      })
    return () => { cancelled = true }
  }, [s3Key])

  if (state.status === 'loading') return <div className="sheet-preview-status">Открываем таблицу…</div>
  if (state.status === 'error') return <div className="sheet-preview-status is-error">Таблица не открылась: {state.error}</div>
  const sheet = state.sheets[active] || null
  return (
    <div className="sheet-preview">
      {state.sheets.length > 1 && (
        <div className="sheet-preview-tabs" role="tablist" aria-label="Листы">
          {state.sheets.map((s, i) => (
            <button key={s.name} type="button" role="tab" aria-selected={i === active} className={i === active ? 'is-active' : undefined} onClick={() => setActive(i)}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="sheet-preview-scroll">
        {!sheet || !sheet.rows.length ? <div className="sheet-preview-status">Лист пустой</div> : (
          <table className="sheet-preview-table">
            <colgroup>
              <col className="sheet-preview-rownum" />
              {sheet.widths.map((w, i) => <col key={i} style={w != null ? { width: `${w}px` } : undefined} />)}
            </colgroup>
            <tbody>
              {sheet.rows.map((row, r) => (
                <tr key={r}>
                  <th scope="row">{r + 1}</th>
                  {row.map((cell, c) => (cell ? (
                    <td key={c} rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined} colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}>{cell.text}</td>
                  ) : null))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {sheet?.truncated && <div className="sheet-preview-status">Показано начало листа: целиком — в скачанном файле.</div>}
      </div>
    </div>
  )
}
