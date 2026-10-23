// Выгрузка расценки подрядчика в Excel (кабинет и сводка администратора, миграция 20261102). Подключается по
// требованию: библиотека Excel тяжёлая.
import * as XLSX from 'xlsx'
import { priceStructure, lineTotal } from './bidVor.js'

const safeSheet = (name, used) => {
  let base = String(name || 'Лист').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28) || 'Лист'
  let n = base
  for (let i = 2; used.has(n); i++) n = `${base.slice(0, 25)} ${i}`
  used.add(n)
  return n
}
const fileSafe = (s) => String(s || '').replace(/[/\\?%*:|"<>]/g, '_').replace(/\s+/g, ' ').trim()

function listSheet(rows, title) {
  const aoa = [[title], [], ['№', 'Наименование', 'Ед. изм.', 'Объём', 'Цена за ед. с НДС, руб.', 'Сумма с НДС, руб.', 'Примечание', 'ВОР']]
  rows.forEach((r, i) => {
    const excelRow = aoa.length + 1
    aoa.push([
      i + 1, r.name, r.unit || '', r.volume ?? '', r.price ?? '',
      r.price != null && r.volume != null ? { f: `D${excelRow}*E${excelRow}`, v: lineTotal(r.price, r.volume) } : '',
      r.note || '', (r.docs || []).join(', '),
    ])
  })
  if (rows.length) {
    const first = 4
    const last = aoa.length
    aoa.push(['', 'Итого', '', '', '', { f: `SUM(F${first}:F${last})` }, '', ''])
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = [{ wch: 6 }, { wch: 60 }, { wch: 10 }, { wch: 12 }, { wch: 18 }, { wch: 18 }, { wch: 30 }, { wch: 30 }]
  return ws
}

function kpSheet(file, prices) {
  const { rows, totals } = priceStructure(file.parsed.structure, prices)
  const aoa = [[`ВОР: ${file.name}`], [], ['№', 'Код', 'Наименование', 'Ед. изм.', 'Объём', 'Цена мат., руб.', 'Цена СМР, руб.', 'Стоим. мат., руб.', 'Стоим. СМР, руб.', 'Итого, руб.']]
  for (const r of rows) {
    if (r.type === 'section') {
      aoa.push([r.num, '', r.name, '', '', '', '', r.materials, r.works, r.materials + r.works])
      continue
    }
    const work = r.kind === 'work'
    aoa.push([r.num, r.code, r.name, r.unit, r.volume ?? '', work ? '' : (r.price ?? ''), work ? (r.price ?? '') : '',
      work ? '' : (r.total ?? ''), work ? (r.total ?? '') : '', r.total ?? ''])
  }
  aoa.push(['', '', 'Итого', '', '', '', '', totals.materials, totals.works, totals.materials + totals.works])
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = [{ wch: 7 }, { wch: 8 }, { wch: 60 }, { wch: 9 }, { wch: 12 }, { wch: 15 }, { wch: 15 }, { wch: 16 }, { wch: 16 }, { wch: 16 }]
  return ws
}

const tenderLabel = (tender) => `Тендер № ${tender.public_tender_number ?? '—'}`

function answersSheet(head, rows) {
  const ws = XLSX.utils.aoa_to_sheet([[`Анкета — ${head}`], [], ['Вопрос', 'Ответ'], ...rows.map((r) => [r.label, r.value])])
  ws['!cols'] = [{ wch: 70 }, { wch: 60 }]
  return ws
}

// Кабинет: позиции всех ВОР с ценами организации + лист «КП» каждого ВОР + анкета.
// form — { fields, answers: { id поля: значение } }.
export function downloadBidWorkbook({ tender, counterpartyName, positions, rates, files, form = null }) {
  const wb = XLSX.utils.book_new()
  const used = new Set()
  const withRates = (list) => list.map((p) => ({ ...p, price: rates.get(p.key)?.price ?? null, note: rates.get(p.key)?.note || '' }))
  const head = `${tenderLabel(tender)} · ${tender.object_name || ''} · ${counterpartyName || ''}`
  XLSX.utils.book_append_sheet(wb, listSheet(withRates(positions.materials), `Материалы — ${head}`), safeSheet('Материалы', used))
  XLSX.utils.book_append_sheet(wb, listSheet(withRates(positions.works), `Работы — ${head}`), safeSheet('Работы', used))
  const prices = new Map([...rates].filter(([, r]) => r.price != null).map(([k, r]) => [k, r.price]))
  for (const f of files) {
    if (!f.parsed.structure?.length) continue
    XLSX.utils.book_append_sheet(wb, kpSheet(f, prices), safeSheet(`КП ${f.name}`, used))
  }
  if (form?.fields?.length) {
    const rows = form.fields.map((f) => ({ label: f.label, value: form.answers?.[f.id] || '' }))
    XLSX.utils.book_append_sheet(wb, answersSheet(head, rows), safeSheet('Анкета', used))
  }
  XLSX.writeFile(wb, `${fileSafe(`Расценка ${tenderLabel(tender)} ${counterpartyName || ''}`)}.xlsx`)
}

// Сводка администратора: цены организации по тендеру (строки tender_bid_rates) и анкета.
export function downloadRatesWorkbook({ row, rates, form }) {
  const wb = XLSX.utils.book_new()
  const used = new Set()
  const head = `Тендер № ${row.public_tender_number ?? '—'} · ${row.object_name || ''} · ${row.counterparty_name || ''}`
  const toRow = (r) => ({ name: r.name, unit: r.unit, volume: r.volume == null ? null : Number(r.volume), price: r.price == null ? null : Number(r.price), note: r.note })
  XLSX.utils.book_append_sheet(wb, listSheet(rates.filter((r) => r.kind === 'material').map(toRow), `Материалы — ${head}`), safeSheet('Материалы', used))
  XLSX.utils.book_append_sheet(wb, listSheet(rates.filter((r) => r.kind === 'work').map(toRow), `Работы — ${head}`), safeSheet('Работы', used))
  const answers = Object.values(form?.answers || {})
  if (answers.length) XLSX.utils.book_append_sheet(wb, answersSheet(head, answers), safeSheet('Анкета', used))
  XLSX.writeFile(wb, `${fileSafe(`Расценка ${head}`)}.xlsx`)
}
