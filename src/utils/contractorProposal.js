// Шаблон КП для подрядчика и разбор заполненного файла.
//
// Вынесено из страницы кабинета: шаблон и парсер должны меняться только вместе,
// иначе «скачал одно, загрузил другое». Тот же принцип, что у шаблона сотрудника
// (parseProposalExcel.js): позиция опознаётся по скрытому ID, а не по номеру
// строки — номер уникален лишь внутри одного ВОРа, а их в тендере бывает
// несколько.

import * as XLSX from 'xlsx'
import { cleanNumeric } from './parseProposalExcel'

// Заголовок столбца-якоря. Ищем по подстроке «не изменя» — так же, как парсер
// сотрудника, чтобы файл, выгруженный там, читался и здесь.
export const ANCHOR_HEADER = 'ID (не изменять)'

export const TEMPLATE_HEADERS = [
  '№ п/п', 'КОД', 'Вид затрат', 'Наименование затрат', 'Примечание к расчету',
  'Ед. изм.', 'Объем по виду работ', 'Общий расход по материалу',
  'Цена за ед. Матер./Обор. с НДС', 'Цена за ед. СМР/ПНР с НДС',
  'ИТОГО цена за ед. с НДС', 'Стоим. Матер./Обор. с НДС', 'Стоим. СМР/ПНР с НДС',
  'ИТОГО стоимость с НДС', 'Общая стоимость с НДС', 'Примечание участника',
  ANCHOR_HEADER,
]

// Индексы столбцов, из которых читаем цены и примечание участника.
const COL = { number: 0, priceMaterials: 8, priceWorks: 9, note: 15 }

// Книга Excel со сметой тендера: подрядчик заполняет два столбца с ценами,
// остальное считают формулы. Разделы остаются заголовками — без формул и якоря.
export function buildProposalWorkbook(estimateItems, { tenderName = 'Тендер', counterpartyName = '' } = {}) {
  const dataRows = estimateItems.map((item, idx) => {
    const rowNum = idx + 2
    if (item.is_section) {
      return [item.row_number, '', '', item.cost_name || '', '', '', '', '', '', '', '', '', '', '', '', '', '']
    }
    return [
      item.row_number,
      item.code || '',
      item.cost_type || '',
      item.cost_name || '',
      item.calculation_note || '',
      item.unit || '',
      item.work_volume || '',
      item.material_consumption || '',
      '', // Цена материалов — заполняет подрядчик
      '', // Цена работ — заполняет подрядчик
      { f: `I${rowNum}+J${rowNum}` },
      { f: `I${rowNum}*G${rowNum}` },
      { f: `J${rowNum}*G${rowNum}` },
      { f: `L${rowNum}+M${rowNum}` },
      { f: `N${rowNum}` },
      '', // Примечание участника
      item.id,
    ]
  })

  const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, ...dataRows])
  ws['!cols'] = [
    { wch: 8 }, { wch: 12 }, { wch: 15 }, { wch: 40 }, { wch: 25 },
    { wch: 10 }, { wch: 15 }, { wch: 15 }, { wch: 22 }, { wch: 20 },
    { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 25 },
    { wch: 38, hidden: true },
  ]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'КП')

  const fileName = `КП_${tenderName}_${counterpartyName}`.replace(/[/\\?%*:|"<>]/g, '_') + '.xlsx'
  return { workbook: wb, fileName }
}

// Разбор заполненного файла: строки Excel → расценки по позициям ВОР.
// Возвращает { rows, skippedAmbiguous, matchedBy }.
//   rows              — [{ estimate_item_id, unit_price_materials, ... }]
//   skippedAmbiguous  — сколько строк не удалось привязать однозначно
//   matchedBy         — 'anchor' | 'number'
export function matchProposalRows(excelData, estimateItems) {
  const byId = new Map(estimateItems.map(it => [String(it.id), it]))
  const docNames = new Set(estimateItems.map(it => it.estimate_name || 'Основная смета'))
  const byRowNumber = new Map()
  for (const it of estimateItems) {
    if (it.is_section) continue
    const key = String(it.row_number)
    if (!byRowNumber.has(key)) byRowNumber.set(key, it)
  }

  const headerCells = (excelData[0] || []).map(c => String(c ?? '').toLowerCase())
  const anchorCol = headerCells.findIndex(h => h.includes('не изменя'))
  // Без якоря сопоставляем по номеру только когда ВОР один: иначе номер «1»
  // есть в каждом документе и цена уедет не туда.
  const canMatchByNumber = anchorCol < 0 && docNames.size <= 1

  const rows = []
  let skippedAmbiguous = 0

  for (let i = 1; i < excelData.length; i++) {
    const row = excelData[i]
    if (!row || row.length === 0) continue

    let item = null
    if (anchorCol >= 0) {
      const rawId = String(row[anchorCol] ?? '').trim()
      if (!rawId) continue                   // раздел или дописанная строка
      item = byId.get(rawId) || null
    } else {
      const rowNumber = parseInt(row[COL.number])
      if (isNaN(rowNumber)) continue
      if (!canMatchByNumber) { skippedAmbiguous++; continue }
      item = byRowNumber.get(String(rowNumber)) || null
    }
    if (!item || item.is_section) continue

    // cleanNumeric чистит пробелы/валюту/запятые: текстовая ячейка «1 200,50»
    // иначе усекается parseFloat'ом и искажает цену.
    const unitPriceMaterials = cleanNumeric(row[COL.priceMaterials])
    const unitPriceWorks = cleanNumeric(row[COL.priceWorks])
    const workVolume = Number(item.work_volume) || 0

    rows.push({
      estimate_item_id: item.id,
      unit_price_materials: unitPriceMaterials,
      unit_price_works: unitPriceWorks,
      total_unit_price: unitPriceMaterials + unitPriceWorks,
      total_materials: unitPriceMaterials * workVolume,
      total_works: unitPriceWorks * workVolume,
      total_cost: unitPriceMaterials * workVolume + unitPriceWorks * workVolume,
      participant_note: row[COL.note] || '',
    })
  }

  return { rows, skippedAmbiguous, matchedBy: anchorCol >= 0 ? 'anchor' : 'number' }
}
