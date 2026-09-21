// Obshie helpers: import smet/PSDC iz Excel i format summ.
// Logika parsinga povtoryaet handleImportEstimate iz ObjectDetailPage.jsx.
import * as XLSX from 'xlsx'

// cleanNumericValue: ubiraem valyutnye simvoly i probely (v JS \s pokryvaet i
// nerazryvnye probely U+00A0/U+202F/U+2007), zapyatuyu menyaem na tochku.
export function cleanNumericValue(value) {
  if (typeof value === 'number') return value
  if (value == null) return 0
  let str = String(value)
  str = str.replace(/[₽$€¥£]/g, '')
  str = str.replace(/\s/g, '')
  str = str.replace(',', '.')
  str = str.replace(/[^\d.-]/g, '')
  return parseFloat(str) || 0
}

// parseEstimateSheet: razbor lista smety/PSDC iz workbook v massiv strok-pozitsiy.
// Kolonki: A=kod, B=naimenovanie, C=ed.izm., D=kol-vo.
//   separate: E=tsena mat., F=tsena rabot, G=primechanie
//   combined: E=tsena za ed., F=primechanie
// options: { sheet, startRow=2, endRow, importMode='separate', vat=0 }
export function parseEstimateSheet(workbook, options = {}) {
  const { sheet, startRow = 2, endRow, importMode = 'separate', vat = 0 } = options
  const ws = workbook.Sheets[sheet || workbook.SheetNames[0]]
  if (!ws) return []
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 })
  const start = Math.max(0, (parseInt(startRow) || 2) - 1)
  const end = endRow ? Math.min(rows.length, parseInt(endRow) || rows.length) : rows.length

  const items = []
  let rowNum = 1
  for (let i = start; i < end; i++) {
    const row = rows[i]
    if (!row || row.length === 0) continue

    const code = row[0] ? String(row[0]).trim() : ''
    const name = row[1] ? String(row[1]).trim() : ''
    if (!name) continue

    const unit = row[2] ? String(row[2]).trim() : ''
    const quantity = cleanNumericValue(row[3])

    let priceMaterials, priceWorks, unitPrice, notes
    if (importMode === 'combined') {
      unitPrice = cleanNumericValue(row[4])
      priceMaterials = 0
      priceWorks = 0
      notes = row[5] ? String(row[5]).trim() : ''
    } else {
      priceMaterials = cleanNumericValue(row[4])
      priceWorks = cleanNumericValue(row[5])
      unitPrice = (priceMaterials || 0) + (priceWorks || 0)
      notes = row[6] ? String(row[6]).trim() : ''
    }

    // Sektsiya: tolko tekst, bez ed.izm. i chislovyh dannyh.
    const isSection = !unit && !quantity && !priceMaterials && !priceWorks && !unitPrice

    items.push({
      row_number: rowNum++,
      code: code || null,
      cost_name: name,
      unit: unit || null,
      quantity: quantity || null,
      unit_price_materials: priceMaterials || 0,
      unit_price_works: priceWorks || 0,
      unit_price: unitPrice || 0,
      total_price: quantity ? quantity * (unitPrice || 0) : 0,
      vat_percent: parseFloat(vat) || 0,
      is_section: isSection,
      original_row_number: String(i + 1),
      notes: notes || null,
      import_mode: importMode,
    })
  }
  return items
}

// --- Format summ s valyutoy ---
const CURRENCY_SYMBOL = { RUB: '₽', CNY: '¥', USD: '$', EUR: '€' }
export const CURRENCY_OPTIONS = [
  { code: 'RUB', label: '₽ Рубль' },
  { code: 'CNY', label: '¥ Юань' },
  { code: 'USD', label: '$ Доллар' },
  { code: 'EUR', label: '€ Евро' },
]

export function currencySymbol(currency) {
  return CURRENCY_SYMBOL[currency] || currency || ''
}

const MONEY_FORMATTER = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

// formatMoney(1234.5, 'RUB') -> "1 234,50 ₽". Pustoe/nevalidnoe -> ''.
export function formatMoney(amount, currency = 'RUB') {
  if (amount == null || amount === '' || !Number.isFinite(Number(amount))) return ''
  const sym = currencySymbol(currency)
  return MONEY_FORMATTER.format(Number(amount)) + (sym ? ` ${sym}` : '')
}
