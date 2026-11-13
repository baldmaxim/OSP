// Просмотр файла в окне S3DocumentPreview (13.11.2026): какой просмотр у файла и как лист Excel превращается в таблицу.
// Окно в браузере — dc-request-doc-chip.test.mjs («без права правки…») и dc-request-docs-export.test.mjs (ссылка на .docx).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { previewKind, sheetView } from '../../src/utils/filePreview.js'

describe('просмотр файла: тип и лист Excel', () => {
  it('тип — по базе, а без него — по расширению; остальное только скачать', () => {
    assert.equal(previewKind('application/pdf', 'a.bin'), 'pdf')
    assert.equal(previewKind('application/octet-stream', 'Отчёт.PDF'), 'pdf')
    assert.equal(previewKind('image/jpeg', 'скан'), 'image')
    assert.equal(previewKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Отчёт'), 'docx')
    assert.equal(previewKind(null, 'Отчет по ДС №3.docx'), 'docx')
    assert.equal(previewKind('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x'), 'sheet')
    assert.equal(previewKind('application/vnd.ms-excel', 'старый.xls'), 'sheet')
    assert.equal(previewKind('application/msword', 'старый.doc'), null, '.doc docx-preview не читает')
    assert.equal(previewKind('text/plain', 'заметка.txt'), null)
  })

  it('лист: значения как в Excel, объединение — одной ячейкой, пустые строки и столбцы в конце не показываются', () => {
    const ws = XLSX.utils.aoa_to_sheet([['Сравнение ДС', '', ''], ['Позиция', 'Было', 'Стало'], ['Бетон', 10.5, 12]])
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }]
    ws['!cols'] = [{ wch: 30 }, { wpx: 80 }]
    ws['!ref'] = 'A1:F9' // диапазон шире данных
    const v = sheetView(XLSX, ws)
    assert.equal(v.rows.length, 3)
    assert.deepEqual(v.rows[0], [{ text: 'Сравнение ДС', rowSpan: 1, colSpan: 3 }, null, null])
    assert.deepEqual(v.rows[2].map((c) => c.text), ['Бетон', '10.5', '12'])
    assert.deepEqual(v.widths, [220, 80, null])
    assert.equal(v.truncated, false)
  })

  it('большой лист — начало и пометка; пустой — без строк', () => {
    const ws = XLSX.utils.aoa_to_sheet(Array.from({ length: 30 }, (_, r) => Array.from({ length: 8 }, (__, c) => `${r}:${c}`)))
    const v = sheetView(XLSX, ws, { rowsMax: 10, colsMax: 5 })
    assert.equal(v.rows.length, 10)
    assert.equal(v.rows[0].length, 5)
    assert.equal(v.truncated, true)
    assert.deepEqual(sheetView(XLSX, {}), { rows: [], widths: [], truncated: false })
  })
})
