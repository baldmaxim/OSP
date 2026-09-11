// Выгрузка реестра тендеров в Excel.
//
// buildTendersRegistryRows — чистая функция: из загруженных тендеров, шифров РД и
// счётчиков строит заголовки и строки таблицы. Её проверяет тест; сама книга
// собирается в buildTendersRegistryWorkbook (xlsx-js-style грузится лениво).

const PHASE_LABEL = {
  not_started: 'Не начат',
  in_progress: 'В работе',
  completed: 'Готово',
  not_required: 'Не требуется',
}

const fmtDate = (value) => {
  if (!value) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value))
  if (m) return `${m[3]}.${m[2]}.${m[1]}`
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU')
}

export const objectNameOf = (t) => t.objects?.name || t.custom_object_name || ''

export function winnersOf(t) {
  const tw = t?.tender_winners || []
  if (tw.length > 0) {
    return tw.map((w) => `${w.counterparties?.name || '—'}${w.scope_note ? ` — ${w.scope_note}` : ''}`)
  }
  return t?.winner?.name ? [t.winner.name] : []
}

// «2024-15-АР — Архитектурные решения» по одному шифру в строке ячейки.
export function rdCodesText(codes = []) {
  return [...codes]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((c) => (c.title ? `${c.code} — ${c.title}` : c.code))
    .join('\n')
}

// options: { isMaterialsView, withConstructionPhases, hideNotes, today }
export function buildTendersRegistryRows(tenders, { rdCodesByTender = new Map(), proposalCounts = {}, docCounts = {}, options = {} } = {}) {
  const { isMaterialsView = false, withConstructionPhases = true, hideNotes = false, today = new Date().toISOString().slice(0, 10) } = options

  if (isMaterialsView) {
    const headers = ['№ тендера', 'Основной тендер №', 'Объект', 'Описание работ', 'Шифр РД', 'Статус',
      'Ответственный', 'Срок предоставления КП на материалы', 'Ссылка на КП на материалы', 'Путь к папке']
    if (!hideNotes) headers.push('Примечание')
    const rows = tenders.map((t) => {
      const row = [
        t.public_tender_number ?? '',
        t.parent_tender?.public_tender_number ?? '',
        objectNameOf(t),
        t.work_description || '',
        // Шифры РД ведутся у основного тендера — тендер на материалы берёт их оттуда.
        rdCodesText(rdCodesByTender.get(t.parent_tender_id) || rdCodesByTender.get(t.id) || []),
        t.status || '',
        t.responsible_contact?.full_name || '',
        fmtDate(t.materials_proposal_deadline),
        t.materials_proposal_link || '',
        t.folder_path || '',
      ]
      if (!hideNotes) row.push(t.notes || '')
      return row
    })
    return { headers, rows }
  }

  const headers = ['№ тендера', 'Объект', 'Адрес объекта', 'Описание работ', 'Шифр РД', 'Статус',
    'Начало тендерных процедур', 'Окончание тендерных процедур', 'Срок истёк', 'Ответственный по тендеру',
    'Участников', 'КП предоставлено', 'Победитель', 'Тендерный пакет', 'Документов тендерного пакета']
  if (withConstructionPhases) {
    headers.push('ВОР и РД: статус', 'ВОР и РД: ответственный', 'ВОР: ссылка', 'Документов ВОР и РД',
      'План затрат: статус', 'План затрат: ответственный', 'План затрат: ссылка', 'Тендер на материалы')
  }
  headers.push('Сводная КП', 'Путь к папке', 'Публикация в ТГ', 'Письмо о завершении тендера',
    'Дата начала работ', 'Дата окончания работ')
  if (!hideNotes) headers.push('Примечание')

  const rows = tenders.map((t) => {
    const counts = proposalCounts[t.id] || { total: 0, proposalProvided: 0 }
    const done = t.status === 'Завершен'
    const row = [
      t.public_tender_number ?? '',
      objectNameOf(t),
      t.objects?.address || '',
      t.work_description || '',
      rdCodesText(rdCodesByTender.get(t.id) || []),
      t.status || '',
      fmtDate(t.tender_start_date),
      fmtDate(t.tender_end_date),
      t.tender_end_date && String(t.tender_end_date).slice(0, 10) < today && !done ? 'Да' : '',
      t.responsible_contact?.full_name || '',
      counts.total,
      counts.proposalProvided,
      winnersOf(t).join('\n'),
      t.tender_package_link || '',
      docCounts.package?.[t.id] || 0,
    ]
    if (withConstructionPhases) {
      row.push(
        PHASE_LABEL[t.vor_status || 'not_started'] || t.vor_status,
        t.vor_responsible?.full_name || '',
        t.vor_link || '',
        docCounts.vor?.[t.id] || 0,
        PHASE_LABEL[t.cost_plan_status || 'not_started'] || t.cost_plan_status,
        t.cost_plan_responsible?.full_name || '',
        t.cost_plan_link || '',
        t.materials_tender ? (t.materials_tender.status || 'Не начат') : '',
      )
    }
    row.push(
      t.summary_proposal_link || '',
      t.folder_path || '',
      t.tg_published ? `Да${t.tg_published_at ? `, ${fmtDate(t.tg_published_at)}` : ''}` : '',
      t.completion_letter_sent ? `Да${t.completion_letter_sent_at ? `, ${fmtDate(t.completion_letter_sent_at)}` : ''}` : '',
      fmtDate(t.start_date),
      fmtDate(t.end_date),
    )
    if (!hideNotes) row.push(t.notes || '')
    return row
  })
  return { headers, rows }
}

const COL_WIDTH = {
  '№ тендера': 10, 'Основной тендер №': 12, 'Объект': 28, 'Адрес объекта': 30, 'Описание работ': 44, 'Шифр РД': 34,
  'Статус': 22, 'Ответственный по тендеру': 26, 'Ответственный': 26, 'Победитель': 30, 'Примечание': 40,
  'Путь к папке': 40,
}

export async function buildTendersRegistryWorkbook({ headers, rows, sheetName = 'Реестр тендеров' }) {
  const mod = await import('xlsx-js-style')
  const XLSX = mod.utils ? mod : mod.default
  const border = { style: 'thin', color: { rgb: 'FFD0D5DD' } }
  const borders = { top: border, bottom: border, left: border, right: border }
  const headerStyle = {
    font: { bold: true }, fill: { fgColor: { rgb: 'FFE8ECF2' } }, border: borders,
    alignment: { wrapText: true, vertical: 'center', horizontal: 'center' },
  }
  const cellStyle = { border: borders, alignment: { wrapText: true, vertical: 'top' } }

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
  const range = XLSX.utils.decode_range(ws['!ref'])
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const ref = XLSX.utils.encode_cell({ r, c })
      if (!ws[ref]) ws[ref] = { t: 's', v: '' }
      ws[ref].s = r === 0 ? headerStyle : cellStyle
    }
  }
  ws['!cols'] = headers.map((h) => ({ wch: COL_WIDTH[h] || Math.max(12, Math.min(28, h.length + 2)) }))
  ws['!rows'] = [{ hpt: 42 }]
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: range.e.r, c: range.e.c } }) }
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31))
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
}
