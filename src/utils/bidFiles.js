// Свой ВОР подрядчика с расценками (миграция 20270113, решение пользователя 11.11.2026): ведомость отдела ↔ файл подрядчика и сводка
// сумм «по корпусам и итог» — как сводная «ВОР × подрядчик» в «Сравнении КП» карточки тендера (тендер № 38), только своя организация.
// Модуль лёгкий (без разбора файлов): его берут кабинет и сводка администратора. Сводку файла считает bidFileSummary.js.

// Что принимаем: заполненный ВОР (Excel) или КП в PDF с текстом — их читает тот же разбор, что «Цены из файла».
export const BID_FILE_ACCEPT = '.xlsx,.xlsm,.xls,.pdf'
export const BID_FILE_MAX_MB = 25

// Причины, по которым файл не прочитался (коды — как у readSupplierDoc / readBidPriceDoc), и свои: ведомость отдела не разобралась,
// цен по позициям ведомости в файле нет.
export const DOC_ERROR_TEXT = {
  unsupported: 'Такой файл не читается: нужен Excel (.xlsx, .xls), CSV, PDF или фото счёта.',
  broken: 'Файл не открылся — возможно, он повреждён.',
  encrypted: 'PDF защищён паролем — сохраните его без пароля.',
  scan: 'Скан или фото: текст не распознался. Нужен скан получше, Excel или PDF с текстом.',
  ocr_failed: 'Не удалось запустить распознавание скана: обновите страницу и повторите. Без него читаются Excel и PDF с текстом.',
  no_table: 'Не нашли таблицу: нужна шапка с колонками «Наименование» и «Цена» (или «Сумма»).',
  empty: 'Шапку нашли, а строк с ценой нет.',
}
export const SUMMARY_ERROR_TEXT = {
  ...DOC_ERROR_TEXT,
  no_vor: 'ВОР отдела не разобрался — сумму посчитать не по чему.',
  no_prices: 'Цен по позициям этой ведомости в файле не нашлось.',
}

const titleKey = (s) => String(s ?? '').replace(/\.(xlsx|xlsm|xls)$/i, '').replace(/\s+/g, ' ').trim().toLowerCase()

// Сводка посчитана (есть суммы) — строка входит в итог.
export const summaryCounted = (s) => !!s && !s.error && typeof s.total === 'number'
// Позиции с ценой не все — итог «нерепрезентативный», как подсветка неполного КП в «Сравнении КП».
export const summaryIncomplete = (s, kind) => summaryCounted(s) && (s.items?.[kind] || 0) > 0 && (s.priced?.[kind] || 0) < s.items[kind]

// Ведомости, которые видит подрядчик: без заменённых новой версией (миграция 20270114, тендер № 847: «ЗИЛ лот 33 ВОР ЭН» и «… версия 2»).
// superseded — ответ bid_vor_superseded ([{ file_id, current_file_id }]) или null (функции нет — все файлы, как раньше).
// Прежний файл скрывается, только если тот, что его заменил, среди файлов тендера: иначе подрядчик остался бы без ведомости.
// → { current: ведомости, priorOf: Map(id прежней → id той, что её заменила) }.
export function currentVorFiles(vorFiles, superseded) {
  const list = vorFiles || []
  const ids = new Set(list.map((v) => v.id))
  const priorOf = new Map()
  for (const r of superseded || []) {
    if (r?.file_id && r.current_file_id && ids.has(r.current_file_id) && r.file_id !== r.current_file_id) priorOf.set(r.file_id, r.current_file_id)
  }
  return { current: list.filter((v) => !priorOf.has(v.id)), priorOf }
}

// Ведомости тендера и свои файлы → { rows, orphans, totals }.
//   rows — по ведомости (по имени): её файл (по id ведомости). Файла нет — файл к прежней версии этой ведомости (по отметке версий
//   priorOf, иначе по тому же имени): stale — расценка посчитана по старой ведомости, объёмы могли измениться, поэтому в ИТОГО она не
//   входит, пока подрядчик не загрузит файл заново. orphans — файлы к ведомостям, которых в тендере больше нет: в итог не входят.
//   totals — сумма посчитанных строк по актуальным ведомостям.
// vorFiles: [{ id, file_name }] (уже без заменённых), myFiles: строки tender_bid_files, priorOf — из currentVorFiles.
export function bidFilesTable(vorFiles, myFiles, priorOf = null) {
  const files = [...(myFiles || [])].sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))
  const vorIds = new Set((vorFiles || []).map((v) => v.id))
  const used = new Set()
  // Ведомости — по имени («корпус 2» раньше «корпус 10»): порядок загрузки файлов отделом подрядчику ничего не говорит.
  const sorted = [...(vorFiles || [])].sort((a, b) => titleKey(a.file_name).localeCompare(titleKey(b.file_name), 'ru', { numeric: true }))
  const rows = sorted.map((vor) => {
    let file = files.find((f) => f.vor_file_id === vor.id) || null
    let stale = false
    if (!file) {
      file = files.find((f) => !used.has(f.id) && !vorIds.has(f.vor_file_id) && priorOf?.get(f.vor_file_id) === vor.id)
        || files.find((f) => !used.has(f.id) && !vorIds.has(f.vor_file_id) && !priorOf?.has(f.vor_file_id) && titleKey(f.vor_name) === titleKey(vor.file_name))
        || null
      stale = !!file
    }
    if (file) used.add(file.id)
    return { vor, file, stale }
  })
  // Сиротами показываются в порядке загрузки.
  const orphans = files.filter((f) => !used.has(f.id)).reverse()
  const totals = { materials: 0, works: 0, total: 0, counted: 0, uploaded: 0, stale: 0, incomplete: false }
  for (const r of rows) {
    if (!r.file) continue
    if (r.stale) { totals.stale += 1; continue }
    totals.uploaded += 1
    const s = r.file.summary
    if (!summaryCounted(s)) continue
    totals.counted += 1
    totals.materials += Number(s.materials || 0)
    totals.works += Number(s.works || 0)
    totals.total += Number(s.total || 0)
    if (summaryIncomplete(s, 'material') || summaryIncomplete(s, 'work')) totals.incomplete = true
  }
  for (const k of ['materials', 'works', 'total']) totals[k] = Math.round(totals[k] * 100) / 100
  return { rows, orphans, totals }
}

// Подсказка к сумме: сколько позиций ведомости с ценой.
export function coverageText(s, kind) {
  if (!summaryCounted(s)) return ''
  const items = s.items?.[kind] || 0
  if (!items) return ''
  const label = kind === 'work' ? 'работ' : 'материалов'
  return `Цены у ${s.priced?.[kind] || 0} из ${items} позиций ${label}`
}
