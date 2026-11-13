// Какой просмотр у файла в окне S3DocumentPreview: 'pdf' — встроенный просмотр браузера, 'image' — картинка, 'docx' — Word
// (docx-preview, DocxPreview), 'sheet' — таблица Excel (SheetPreview); null — только скачать. По типу из базы, а без него —
// по расширению: у части файлов тип записан как application/octet-stream.
// 13.11.2026: Word и Excel добавлены по просьбе пользователя — «Отчёт по документам» в /dc-requests почти всегда .docx
// (64 из 68 файлов на копии прода 02.11), и глазика у него не было.
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const SHEET_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroenabled.12',
])

export function previewKind(mime, name) {
  const m = String(mime || '').toLowerCase()
  const n = String(name || '').toLowerCase()
  if (m === 'application/pdf' || /\.pdf$/.test(n)) return 'pdf'
  if (m.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp)$/.test(n)) return 'image'
  if (m === DOCX_MIME || /\.docx$/.test(n)) return 'docx'
  if (SHEET_MIMES.has(m) || /\.(xlsx|xlsm|xls)$/.test(n)) return 'sheet'
  return null
}

// Лист Excel → строки для показа: значения как в Excel (отформатированные), объединённые ячейки, без пустых строк и столбцов
// в конце. Не больше rowsMax строк и colsMax столбцов (truncated — что-то не показано). XLSX — библиотека xlsx (передаёт вызвавший:
// она грузится лениво). Ответ: { rows: [[{ text, rowSpan, colSpan } | null]], widths: [px | null], truncated } — null на месте
// ячейки, закрытой объединением.
export function sheetView(XLSX, ws, { rowsMax = 2000, colsMax = 60 } = {}) {
  if (!ws?.['!ref']) return { rows: [], widths: [], truncated: false }
  const range = XLSX.utils.decode_range(ws['!ref'])
  const lastRow = Math.min(range.e.r, range.s.r + rowsMax - 1)
  const lastCol = Math.min(range.e.c, range.s.c + colsMax - 1)
  const truncated = lastRow < range.e.r || lastCol < range.e.c
  const text = (r, c) => {
    const cell = ws[XLSX.utils.encode_cell({ r, c })]
    if (!cell || cell.v == null) return ''
    if (cell.w != null) return String(cell.w)
    return cell.v instanceof Date ? cell.v.toLocaleDateString('ru-RU') : String(cell.v)
  }
  // Где кончаются данные: пустые строки и столбцы в конце диапазона не показываем.
  let maxRow = range.s.r - 1
  let maxCol = range.s.c - 1
  for (let r = range.s.r; r <= lastRow; r++) {
    for (let c = range.s.c; c <= lastCol; c++) {
      if (text(r, c) !== '') {
        if (r > maxRow) maxRow = r
        if (c > maxCol) maxCol = c
      }
    }
  }
  const covered = new Set()
  const spans = new Map()
  for (const m of ws['!merges'] || []) {
    if (m.s.r > maxRow || m.s.c > maxCol) continue
    const e = { r: Math.min(m.e.r, maxRow), c: Math.min(m.e.c, maxCol) }
    spans.set(`${m.s.r}:${m.s.c}`, { rowSpan: e.r - m.s.r + 1, colSpan: e.c - m.s.c + 1 })
    for (let r = m.s.r; r <= e.r; r++) for (let c = m.s.c; c <= e.c; c++) if (r !== m.s.r || c !== m.s.c) covered.add(`${r}:${c}`)
  }
  const rows = []
  for (let r = range.s.r; r <= maxRow; r++) {
    const row = []
    for (let c = range.s.c; c <= maxCol; c++) {
      if (covered.has(`${r}:${c}`)) { row.push(null); continue }
      const span = spans.get(`${r}:${c}`)
      row.push({ text: text(r, c), rowSpan: span?.rowSpan || 1, colSpan: span?.colSpan || 1 })
    }
    rows.push(row)
  }
  const cols = ws['!cols'] || []
  const widths = []
  for (let c = range.s.c; c <= maxCol; c++) {
    const w = cols[c]
    widths.push(w?.hidden ? 0 : w?.wpx ? Math.round(w.wpx) : w?.wch ? Math.round(w.wch * 7 + 10) : null)
  }
  return { rows, widths, truncated }
}
