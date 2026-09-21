// Выгрузка всей информации по объектам в Excel — одна книга, лист на каждый
// раздел карточки объекта: сами объекты, документы, гарантия, гарантийные
// удержания, площади, смета.
//
// buildObjectsExportSheets — чистая функция (без Supabase и без xlsx): из уже
// загруженных строк строит листы { name, headers, rows, widths, numeric }.
// Загрузка — services/objectsExport.js, книга — buildObjectsWorkbook ниже
// (xlsx-js-style грузится лениво, как в выгрузке реестра тендеров).

const STATUS_LABEL = {
  main_construction: 'Основное строительство',
  warranty_service: 'Гарантийное обслуживание',
}

const DOC_TYPE_LABEL = {
  general_contract: 'Договор генподряда',
  additional_agreement: 'Дополнительное соглашение',
  attachment: 'Приложение',
}
const DOC_TYPE_ORDER = { general_contract: 0, additional_agreement: 1, attachment: 2 }

const STAFF_ROLES = ['construction_manager', 'economist']

// Даты из БД бывают 'YYYY-MM-DD' и timestamptz. Разбираем строку сами: new Date
// от 'YYYY-MM-DD' — это полночь UTC, и западнее Гринвича дата съезжала бы на день.
export function fmtDate(value) {
  if (!value) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value))
  if (m) return `${m[3]}.${m[2]}.${m[1]}`
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU')
}

// Число или пустая ячейка: в Excel суммы должны складываться, а не лежать текстом.
const num = (v) => {
  if (v === null || v === undefined || v === '') return ''
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : ''
}
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100

// Окончание гарантии — те же приоритеты, что в карточке объекта
// (ObjectDetailPage.getWarrantyEndDisplay):
//   1) фиксированная дата окончания; 2) начало + срок; 3) «после события + N мес.».
export function warrantyEndText(w) {
  if (!w) return ''
  if (w.end_date_override) return fmtDate(w.end_date_override)
  const months = Number(w.warranty_months) || 0
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(w.start_date || ''))
  if (m && months > 0) {
    // Считаем в календарных месяцах без часовых поясов; 31-е число при переходе
    // на короткий месяц переносится вперёд — так же, как Date.setMonth в карточке.
    const d = new Date(Date.UTC(+m[1], +m[2] - 1 + months, +m[3]))
    const p = (x) => String(x).padStart(2, '0')
    return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`
  }
  if (w.start_type === 'event' && months > 0) return `после события + ${months} мес.`
  return ''
}

// Стоимость позиции сметы — как в карточке (calcMaterialsCost/calcWorksCost/calcTotalCost).
export function estimateCosts(item) {
  const q = parseFloat(item.quantity) || 0
  const mat = q * (parseFloat(item.unit_price_materials) || 0)
  const works = q * (parseFloat(item.unit_price_works) || 0)
  const total = (mat + works) || q * (parseFloat(item.unit_price) || 0)
  return { mat: round2(mat), works: round2(works), total: round2(total) }
}

const byOrder = (a, b) =>
  (a.order_number ?? 0) - (b.order_number ?? 0)
  || String(a.created_at || '').localeCompare(String(b.created_at || ''))

// Документы объекта в том порядке, в каком их видно в карточке: договор, ДС,
// под каждым — его приложения (любой вложенности).
export function orderDocuments(docs) {
  const children = new Map()
  const ids = new Set(docs.map((d) => d.id))
  const roots = []
  for (const d of docs) {
    // Родитель мог не попасть в выборку — тогда документ показываем корневым,
    // а не теряем.
    if (d.parent_document_id && ids.has(d.parent_document_id)) {
      if (!children.has(d.parent_document_id)) children.set(d.parent_document_id, [])
      children.get(d.parent_document_id).push(d)
    } else {
      roots.push(d)
    }
  }
  roots.sort((a, b) =>
    (DOC_TYPE_ORDER[a.document_type] ?? 9) - (DOC_TYPE_ORDER[b.document_type] ?? 9) || byOrder(a, b))
  const out = []
  const seen = new Set()
  const walk = (d, depth) => {
    if (seen.has(d.id)) return // защита от цикла в данных
    seen.add(d.id)
    out.push({ doc: d, depth })
    for (const c of (children.get(d.id) || []).sort(byOrder)) walk(c, depth + 1)
  }
  roots.forEach((r) => walk(r, 0))
  return out
}

// Площади — дерево через parent_area_id, дочерние с отступом в названии.
function orderAreas(areas) {
  const children = new Map()
  const ids = new Set(areas.map((a) => a.id))
  const roots = []
  for (const a of areas) {
    if (a.parent_area_id && ids.has(a.parent_area_id)) {
      if (!children.has(a.parent_area_id)) children.set(a.parent_area_id, [])
      children.get(a.parent_area_id).push(a)
    } else {
      roots.push(a)
    }
  }
  const sortFn = (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
    || String(a.created_at || '').localeCompare(String(b.created_at || ''))
  const out = []
  const seen = new Set()
  const walk = (a, depth) => {
    if (seen.has(a.id)) return
    seen.add(a.id)
    out.push({ area: a, depth })
    for (const c of (children.get(a.id) || []).sort(sortFn)) walk(c, depth + 1)
  }
  roots.sort(sortFn).forEach((r) => walk(r, 0))
  return out
}

const groupBy = (rows, key) => {
  const map = new Map()
  for (const r of rows || []) {
    const k = r[key]
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(r)
  }
  return map
}

export function buildObjectsExportSheets({
  objects = [], staff = [], documents = [], warranties = [], retentions = [], areas = [], estimateItems = [],
} = {}) {
  const objectList = [...objects].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'))
  const nameOf = new Map(objectList.map((o) => [o.id, o.name || '']))
  const inScope = (row) => nameOf.has(row.object_id)

  const staffBy = groupBy(staff.filter(inScope), 'object_id')
  const docsBy = groupBy(documents.filter(inScope), 'object_id')
  const warrBy = groupBy(warranties.filter(inScope), 'object_id')
  const retBy = groupBy(retentions.filter(inScope), 'object_id')
  const areasBy = groupBy(areas.filter(inScope), 'object_id')
  const estBy = groupBy(estimateItems.filter(inScope), 'object_id')
  const docNameById = new Map(documents.map((d) => [d.id, d.name || '']))

  const staffNames = (objectId, role) => (staffBy.get(objectId) || [])
    .filter((s) => s.staff_role === role && s.contacts)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((s) => s.contacts.full_name)
    .join('\n')

  // ── Объекты ──
  const objectsSheet = {
    name: 'Объекты',
    headers: ['Объект', 'Статус', 'Адрес', 'Описание', 'Застройщик', 'Проектирование',
      'Планируемое начало работ', 'Планируемое окончание работ', 'Бюджет, ₽', 'Email объекта',
      'Руководители строительства', 'Экономисты', 'Документов', 'Видов работ на гарантии',
      'Гарантийных удержаний', 'Площадей', 'Позиций сметы', 'Итого по смете, ₽',
      'Ссылка на карту', 'Широта', 'Долгота'],
    widths: [30, 22, 34, 40, 26, 26, 14, 14, 16, 26, 28, 28, 11, 12, 12, 10, 11, 18, 30, 12, 12],
    numeric: new Set(['Бюджет, ₽', 'Итого по смете, ₽']),
    rows: objectList.map((o) => {
      const est = (estBy.get(o.id) || []).filter((i) => !i.is_section)
      const estTotal = round2(est.reduce((s, i) => s + estimateCosts(i).total, 0))
      return [
        o.name || '',
        STATUS_LABEL[o.status || 'main_construction'] || o.status || '',
        o.address || '',
        o.description || '',
        o.developer || '',
        o.design || '',
        fmtDate(o.planned_start_date),
        fmtDate(o.planned_end_date),
        num(o.budget),
        o.email || '',
        staffNames(o.id, STAFF_ROLES[0]),
        staffNames(o.id, STAFF_ROLES[1]),
        (docsBy.get(o.id) || []).length,
        (warrBy.get(o.id) || []).length,
        (retBy.get(o.id) || []).length,
        (areasBy.get(o.id) || []).length,
        est.length,
        est.length ? estTotal : '',
        o.map_link || '',
        num(o.latitude),
        num(o.longitude),
      ]
    }),
  }

  // ── Документы ──
  const documentsRows = []
  for (const o of objectList) {
    for (const { doc: d, depth } of orderDocuments(docsBy.get(o.id) || [])) {
      documentsRows.push([
        o.name || '',
        depth > 0 ? 'Приложение' : (DOC_TYPE_LABEL[d.document_type] || d.document_type || ''),
        depth > 0 ? `${'   '.repeat(depth - 1)}↳ ${d.name || ''}` : (d.name || ''),
        d.parent_document_id ? (docNameById.get(d.parent_document_id) || '') : '',
        d.document_number || '',
        fmtDate(d.document_date),
        d.notes || '',
        d.signed?.file_name || '',
        d.editable?.file_name || '',
      ])
    }
  }
  const documentsSheet = {
    name: 'Документы',
    headers: ['Объект', 'Тип', 'Наименование', 'Относится к документу', 'Номер', 'Дата', 'Примечание',
      'Подписанный файл', 'Редактируемый файл'],
    widths: [28, 24, 44, 34, 18, 12, 40, 30, 30],
    rows: documentsRows,
  }

  // ── Гарантия ──
  const warrantyRows = []
  for (const o of objectList) {
    for (const w of [...(warrBy.get(o.id) || [])].sort(byOrder)) {
      const byEvent = w.start_type === 'event'
      warrantyRows.push([
        o.name || '',
        w.work_name || '',
        byEvent ? 'По событию' : 'По дате',
        byEvent ? (w.start_event_text || '') : '',
        w.start_document_id ? (docNameById.get(w.start_document_id) || '') : '',
        fmtDate(w.start_date),
        num(w.warranty_months),
        warrantyEndText(w),
        w.actual_start_doc?.file_name || '',
        w.notes || '',
      ])
    }
  }
  const warrantySheet = {
    name: 'Гарантия',
    headers: ['Объект', 'Вид работ', 'Начало гарантии', 'Событие', 'Документ-основание',
      'Дата начала', 'Срок, мес.', 'Окончание гарантии', 'Файл акта', 'Примечание'],
    widths: [28, 40, 14, 40, 30, 12, 10, 20, 28, 40],
    rows: warrantyRows,
  }

  // ── Гарантийные удержания ──
  const retentionRows = []
  for (const o of objectList) {
    for (const r of [...(retBy.get(o.id) || [])].sort(byOrder)) {
      const payments = [...(r.payments || [])].sort((a, b) => (a.order_number ?? 0) - (b.order_number ?? 0))
      retentionRows.push([
        o.name || '',
        num(r.retention_percent),
        r.retention_period || '',
        payments.map((p) => `${p.portion_text || ''} — ${p.condition_text || ''}`).join('\n'),
        r.notes || '',
      ])
    }
  }
  const retentionSheet = {
    name: 'Гарантийные удержания',
    headers: ['Объект', 'Удержание, %', 'Срок', 'Порядок выплаты', 'Примечание'],
    widths: [28, 12, 26, 60, 40],
    rows: retentionRows,
  }

  // ── Площади ──
  const areaRows = []
  for (const o of objectList) {
    for (const { area: a, depth } of orderAreas(areasBy.get(o.id) || [])) {
      areaRows.push([
        o.name || '',
        depth > 0 ? `${'   '.repeat(depth - 1)}↳ ${a.area_type || ''}` : (a.area_type || ''),
        num(a.value),
        a.unit || '',
        a.data_source || '',
        a.calc_method || '',
        a.notes || '',
      ])
    }
  }
  const areasSheet = {
    name: 'Площади',
    headers: ['Объект', 'Площадь', 'Значение', 'Ед. изм.', 'Источник данных', 'Методика расчёта', 'Примечание'],
    widths: [28, 40, 14, 10, 24, 30, 40],
    numeric: new Set(['Значение']),
    rows: areaRows,
  }

  // ── Смета ──
  // Одна таблица на все объекты; раздел сметы переносится в колонку каждой
  // позиции — строки разделов отдельными строками мешали бы фильтру и сумме.
  const estimateRows = []
  for (const o of objectList) {
    const items = [...(estBy.get(o.id) || [])].sort((a, b) =>
      (a.row_number ?? 0) - (b.row_number ?? 0) || String(a.id).localeCompare(String(b.id)))
    let section = ''
    for (const i of items) {
      if (i.is_section) { section = i.cost_name || ''; continue }
      const c = estimateCosts(i)
      const combined = i.import_mode === 'combined'
      estimateRows.push([
        o.name || '',
        section,
        i.code || '',
        i.original_row_number || i.row_number || '',
        i.cost_name || '',
        i.unit || '',
        num(i.quantity),
        combined ? num(i.unit_price) : '',
        combined ? '' : num(i.unit_price_materials),
        combined ? '' : num(i.unit_price_works),
        combined ? '' : c.mat,
        combined ? '' : c.works,
        c.total,
        num(i.vat_percent),
        i.notes || '',
        i.is_approved ? 'Да' : '',
      ])
    }
  }
  const estimateSheet = {
    name: 'Смета',
    headers: ['Объект', 'Раздел', 'Код', '№', 'Наименование работ', 'Ед. изм.', 'Кол-во',
      'Цена за ед., с НДС', 'Цена мат. за ед., с НДС', 'Цена работ за ед., с НДС',
      'Стоимость мат., с НДС', 'Стоимость работ, с НДС', 'Итого, с НДС', 'НДС, %', 'Примечание', 'Смета утверждена'],
    widths: [26, 30, 8, 8, 50, 9, 12, 15, 15, 15, 16, 16, 16, 8, 30, 11],
    numeric: new Set(['Кол-во', 'Цена за ед., с НДС', 'Цена мат. за ед., с НДС', 'Цена работ за ед., с НДС',
      'Стоимость мат., с НДС', 'Стоимость работ, с НДС', 'Итого, с НДС']),
    rows: estimateRows,
  }

  return [objectsSheet, documentsSheet, warrantySheet, retentionSheet, areasSheet, estimateSheet]
}

export async function buildObjectsWorkbook(sheets) {
  const mod = await import('xlsx-js-style')
  const XLSX = mod.utils ? mod : mod.default
  const border = { style: 'thin', color: { rgb: 'FFD0D5DD' } }
  const borders = { top: border, bottom: border, left: border, right: border }
  const headerStyle = {
    font: { bold: true }, fill: { fgColor: { rgb: 'FFE8ECF2' } }, border: borders,
    alignment: { wrapText: true, vertical: 'center', horizontal: 'center' },
  }
  const cellStyle = { border: borders, alignment: { wrapText: true, vertical: 'top' } }
  const moneyStyle = { ...cellStyle, numFmt: '#,##0.00' }

  const wb = XLSX.utils.book_new()
  for (const sheet of sheets) {
    const rows = sheet.rows.length ? sheet.rows : [['Нет данных']]
    const ws = XLSX.utils.aoa_to_sheet([sheet.headers, ...rows])
    const range = XLSX.utils.decode_range(ws['!ref'])
    const moneyCols = new Set(sheet.headers.map((h, i) => (sheet.numeric?.has(h) ? i : -1)).filter((i) => i >= 0))
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const ref = XLSX.utils.encode_cell({ r, c })
        if (!ws[ref]) ws[ref] = { t: 's', v: '' }
        ws[ref].s = r === 0 ? headerStyle : (moneyCols.has(c) && ws[ref].t === 'n' ? moneyStyle : cellStyle)
      }
    }
    ws['!cols'] = sheet.headers.map((h, i) => ({ wch: sheet.widths?.[i] || Math.max(12, Math.min(30, h.length + 2)) }))
    ws['!rows'] = [{ hpt: 36 }]
    ws['!freeze'] = { xSplit: 1, ySplit: 1 }
    ws['!views'] = [{ state: 'frozen', xSplit: 1, ySplit: 1 }]
    if (sheet.rows.length) {
      ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: range.e.r, c: range.e.c } }) }
    }
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31))
  }
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
}
