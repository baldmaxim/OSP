// Генератор XLSX «как из старой системы» для тестов импорта.
// Один рабочий лист A:T, скрытый технический U, старые формулы K/M/N/O с
// сохранёнными значениями (включая ошибочное исключение работ ДМ), пустые строки
// в середине, итоговые строки не на фиксированных номерах.
import XLSXStyle from 'xlsx-js-style'
import { HEADER } from './fixtures.mjs'

const COLS = 'ABCDEFGHIJKLMNOPQRSTU'.split('')

// rows: [{ r, A..U }] — значение: строка → текстовая ячейка, число → числовая,
// { f, v } → формула с сохранённым значением.
export function buildLegacyWorkbook({ sheetName = 'Ведомость объёмов работ', header = HEADER, rows = [], extraSheets = [], withU = true } = {}) {
  const ws = {}
  header.forEach((h, i) => { ws[`${COLS[i]}1`] = { t: 's', v: h } })
  let maxRow = 1
  for (const row of rows) {
    maxRow = Math.max(maxRow, row.r)
    for (const col of COLS) {
      const v = row[col]
      if (v === undefined) continue
      if (v && typeof v === 'object') {
        ws[`${col}${row.r}`] = v.f
          ? { t: typeof v.v === 'number' ? 'n' : 's', v: v.v ?? '', f: v.f }
          : { ...v }
      } else if (typeof v === 'number') {
        ws[`${col}${row.r}`] = { t: 'n', v }
      } else {
        ws[`${col}${row.r}`] = { t: 's', v }
      }
    }
  }
  ws['!ref'] = `A1:${withU ? 'U' : 'T'}${maxRow}`
  ws['!cols'] = COLS.slice(0, withU ? 21 : 20).map((_, i) => (i >= 19 ? { hidden: true, wch: 10 } : { wch: 14 }))
  const wb = XLSXStyle.utils.book_new()
  XLSXStyle.utils.book_append_sheet(wb, ws, sheetName)
  for (const extra of extraSheets) {
    XLSXStyle.utils.book_append_sheet(wb, XLSXStyle.utils.aoa_to_sheet(extra.data), extra.name)
  }
  return new Uint8Array(XLSXStyle.write(wb, { type: 'array', bookType: 'xlsx' }))
}

// Типичный старый файл: секция 5 с процессами 5.1, 5.2, 5.10 (ДМ), удалённая
// строка, пустые строки, итог в 38-й и НДС в 39-й строке, лишний лист.
export function legacySample() {
  const rows = [
    { r: 2, A: '5', B: 'Секция', F: 'Отделка МОП', K: { f: 'SUM(K3:K5)', v: 13000 }, M: { f: 'SUM(M3:M5)', v: 1000 }, O: { f: 'K2+M2', v: 14000 } },
    { r: 3, A: '5.1', B: 'Комплексный процесс', C: 'Р-01', F: 'Грунтовка', G: 'м2', H: 1.5, I: 10, J: '1 000,00', L: 100, K: { f: 'ROUND(I3*J3,2)', v: 10000 }, M: { f: 'ROUND(I3*L3,2)', v: 1000 }, N: { f: 'J3+L3', v: 1100 }, O: { f: 'K3+M3', v: 11000 }, T: '' },
    { r: 4, A: '5.2', B: 'Комплексный процесс', F: 'Шпаклевка', G: 'м2', I: '2,5', J: 1200, L: 0 },
    { r: 7, A: '5.10', B: ' комплексный процесс ', D: 'ДМ', F: 'Плинтус', G: 'м.п.', I: 4, J: 500, L: 250, M: { f: 'IF(D7<>"ДМ",ROUND(I7*L7,2),0)', v: 0 } },
    { r: 9, A: '5.11', B: 'Комплексный процесс', F: 'Удалённая', G: 'шт', I: 1, J: 99999, L: 1, U: 'deleted' },
    { r: 38, B: 'Итого по всей ведомости, руб.', K: { f: 'SUM(K2:K37)', v: 13000 }, M: { f: 'SUM(M2:M37)', v: 1000 }, O: { f: 'K38+M38', v: 14000 } },
    { r: 39, B: 'в том числе НДС 22%', O: { f: 'ROUND(O38*22/122,2)', v: 2524.59 } },
  ]
  return buildLegacyWorkbook({ rows, extraSheets: [{ name: 'Служебный', data: [['не импортируется'], [123]] }] })
}
