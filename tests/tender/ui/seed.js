// Данные крупного тендера для стенда (выполняется до импорта страницы).
import { normName } from '../../../src/utils/supplyRateHelpers.js'
const params = new URLSearchParams(window.location.search)
const ITEMS = Number(params.get('items') || 5000)
const CPS = Number(params.get('cps') || 10)
const DOCS = ['Корпус 1', 'Корпус 2', 'Паркинг']
const CP_CONTACTS = params.get('cpContacts') === '1'

const counterparties = Array.from({ length: CPS }, (_, i) => ({ id: `cp-${i + 1}`, name: `Подрядчик ${String(i + 1).padStart(2, '0')}` }))
const items = []
const perDoc = Math.ceil(ITEMS / DOCS.length)
for (const [d, doc] of DOCS.entries()) {
  let row = 1
  for (let n = 0; n < perDoc && items.length < ITEMS; n++) {
    if (n % 50 === 0) {
      items.push({ id: `sec-${d}-${n}`, tender_id: 'tender-1', estimate_name: doc, row_number: row++, code: null, cost_name: `Раздел ${n / 50 + 1}`, unit: null, work_volume: null, material_consumption: null, is_section: true, outline_level: 0 })
      continue
    }
    const isWork = n % 3 === 1
    items.push({
      id: `it-${d}-${n}`, tender_id: 'tender-1', estimate_name: doc, row_number: row++,
      code: isWork ? 'Р' : 'мат.', cost_name: `${isWork ? 'Работа' : 'Материал'} ${d}-${n}`, unit: isWork ? 'м2' : 'шт',
      work_volume: isWork ? 10 + (n % 7) : null, material_consumption: isWork ? null : 5 + (n % 11),
      is_section: false, outline_level: 1,
    })
  }
}

const proposals = []
for (const it of items) {
  if (it.is_section) continue
  counterparties.forEach((cp, c) => {
    // У первого подрядчика часть материалов не расценена — для «учтено».
    if (c === 0 && it.code === 'мат.' && Number(it.id.split('-')[2]) % 13 === 2) return
    const up = 100 + ((c * 17 + it.row_number) % 50)
    const vol = Number(it.work_volume || it.material_consumption)
    const isWork = it.code === 'Р'
    proposals.push({
      id: `p-${it.id}-${cp.id}`, tender_id: 'tender-1', counterparty_id: cp.id, estimate_item_id: it.id,
      unit_price_materials: isWork ? 0 : up, unit_price_works: isWork ? up : 0,
      total_materials: isWork ? 0 : up * vol, total_works: isWork ? up * vol : 0, total_cost: up * vol,
      proposal_date: '2026-09-01', covered_elsewhere: false, coverage_note: null,
      participant_note: 'длинное примечание участника, которое сравнению не нужно', created_at: '2026-09-01T10:00:00Z',
    })
  })
}

const TENDERS = Number(params.get('tenders') || 40)
const STATUSES = ['Заявка на тендер', 'Подготовка ВОР', 'Идет тендерная процедура', 'Подведение итогов', 'Завершен']
const objects = [
  { id: 'obj-1', name: 'ЖК «Северный квартал»', status: 'main_construction', address: 'г. Алматы, ул. Сейфуллина, 512' },
  { id: 'obj-2', name: 'Бизнес-центр «Нурлы»', status: 'main_construction', address: 'г. Астана, пр. Мангилик Ел, 55' },
]
const contacts = [
  { id: 'ct-1', full_name: 'Архипов Антон Михайлович', position: 'Инженер ОСП', departments: { name: 'ОСП' } },
  { id: 'ct-2', full_name: 'Крюкова Юлия Денисовна', position: 'Инженер ОСП', departments: { name: 'ОСП' } },
]
const registry = Array.from({ length: TENDERS }, (_, i) => {
  const obj = objects[i % objects.length]
  const contact = contacts[i % contacts.length]
  return {
    id: i === 0 ? 'tender-1' : `tender-${i + 1}`,
    tender_type: 'main',
    department: 'construction',
    public_tender_number: 200 - i,
    status: STATUSES[i % STATUSES.length],
    work_description: i % 3 === 0 ? 'Устройство вентилируемого фасада с облицовкой керамогранитом, секции 1–4' : 'Отделочные работы МОП',
    object_id: obj.id,
    objects: obj,
    responsible_contact_id: contact.id,
    responsible_contact: contact,
    start_date: `2026-0${(i % 8) + 1}-10`,
    tender_start_date: '2026-09-01',
    tender_end_date: i % 4 === 0 ? '2026-09-05' : '2026-10-20',
    folder_path: i % 2 === 0 ? `\\\\su10-fs\\Тендеры\\${obj.name}\\Тендер ${200 - i}` : null,
    tg_published: i % 2 === 1,
    vor_status: 'in_progress',
    cost_plan_status: 'completed',
    notes: 'Примечание к тендеру',
    tender_winners: [],
    materials_tender: [],
    deleted_at: null,
  }
})

// matTenders=1 — у каждого основного тендера реестра свой тендер на материалы (реестр «Тендеры на материалы»).
const MATERIALS = params.get('matTenders') === '1'
  ? registry.map((t, i) => ({
    ...t, id: `mat-${i + 1}`, tender_type: 'materials', parent_tender_id: t.id, public_tender_number: 1000 + i,
    status: ['Не начат', 'В работе', 'Завершён', 'Не требуется'][i % 4], materials_priority: i % 5 === 0 ? 'high' : null,
    materials_resp_name: i % 2 ? 'Снабженцев С. С.' : null, materials_proposal_deadline: '2026-10-30', materials_tender: [],
  }))
  : []

window.__fakeDb = {
  tenders: [...registry, ...MATERIALS],
  objects,
  contacts,
  app_settings: [],
  tender_rd_codes: registry.flatMap((t, i) => [
    { id: `rd-${i}-1`, tender_id: t.id, code: `2026-${t.public_tender_number}-АР`, title: 'Архитектурные решения', sort_order: 10 },
    { id: `rd-${i}-2`, tender_id: t.id, code: `2026-${t.public_tender_number}-КЖ`, title: 'Конструкции железобетонные', sort_order: 20 },
  ]),
  tender_counterparties: [...registry.slice(1, 9).map((t, i) => ({ id: `tch-${i}`, tender_id: t.id, counterparty_id: 'cp-1', status: i % 3 === 0 ? 'declined' : 'proposal_provided', sort_order: 0, tenders: { id: t.id, work_description: t.work_description, tender_start_date: t.tender_start_date, tender_end_date: t.tender_end_date, objects: { name: t.objects.name } } })), ...counterparties.map((cp, i) => ({ id: `tc-${i + 1}`, tender_id: 'tender-1', counterparty_id: cp.id, status: 'proposal_provided', sort_order: i, invited_at: '2026-08-01', counterparties: { ...cp, counterparty_contacts: [] } }))],
  // ?cpContacts=1 — у контрагентов есть контакты с телефонами, третий — в чёрном списке (реестр контрагентов на телефоне).
  counterparties: counterparties.map((cp, i) => ({
    ...cp,
    status: CP_CONTACTS && i === 2 ? 'blacklist' : 'active',
    inn: '123456789012',
    work_type: CP_CONTACTS && i % 4 === 1 ? 'Фасадные работы, Кровельные работы, Устройство вентилируемых фасадов, Остекление, Благоустройство территории' : 'Фасадные работы',
    counterparty_contacts: CP_CONTACTS && i % 2 === 0
      ? [{ id: `cpc-${i}`, counterparty_id: cp.id, full_name: 'Сапаров Ержан Болатович', phone: '+7 701 555-12-34; +7 727 300-00-00', email: 'sales@example.invalid' }]
      : [],
  })),
  tender_estimate_items: items,
  tender_counterparty_proposals: proposals,
  tender_vor_supply_rates: [],
  tender_proposal_files: [],
  tender_audit_log: [],
  s3_documents: [],
}

// ── Расценка снабжением на сайте (страница /tenders/materials/mat-p/pricing) ──────────────────────────
// Основной тендер — направление «гарантия», чтобы не попасть в реестр стенда основного строительства.
//   matStatus — статус тендера на материалы («Завершён» — только чтение); missing=1 — таблиц расценки нет.
const PRICING_POSITIONS = [
  { name: 'Труба медная Ø12,7', unit: 'м', volume: 1500, order: 1 },
  { name: 'Кран шаровой Ду15', unit: 'шт', volume: 48, order: 2 },
  { name: 'Изоляция K-Flex 13×15', unit: 'м', volume: 1100, order: 3 },
  { name: 'Хомут монтажный', unit: 'шт', volume: null, order: 4 },
].map((p) => ({ ...p, k: normName(p.name) }))
window.__fakeDb.tenders.push(
  { id: 'tender-p', tender_type: 'main', department: 'warranty', public_tender_number: 291, status: 'Идет тендерная процедура',
    work_description: 'Монтаж систем ОВ и ВК', object_id: 'obj-1', objects: objects[0], deleted_at: null, parent_tender_id: null },
  { id: 'mat-p', tender_type: 'materials', department: 'warranty', public_tender_number: 292, status: params.get('matStatus') || 'В работе',
    work_description: 'Монтаж систем ОВ и ВК', object_id: 'obj-1', objects: objects[0], deleted_at: null, parent_tender_id: 'tender-p',
    materials_proposal_deadline: '2026-10-30', materials_resp_name: 'Снабженцев С. С.' },
)
window.__fakeDb.s3_documents.push(
  { id: 'doc-vor-p', owner_type: 'tender', owner_id: 'tender-p', doc_category: 'vor_statement',
    file_name: 'ВОР_ОВ.xlsx', s3_key: 'tenders/tender-p/x-ВОР_ОВ.xlsx', created_at: '2026-10-12T09:00:00Z', uploaded_by_name: 'Иванов И. И.' },
  { id: 'doc-vor-p2', owner_type: 'tender', owner_id: 'tender-p', doc_category: 'vor_statement',
    file_name: 'ВОР_ВК.xlsx', s3_key: 'tenders/tender-p/x-ВОР_ВК.xlsx', created_at: '2026-10-12T09:10:00Z', uploaded_by_name: 'Иванов И. И.' },
)
// brokenFile=1 — третий файл ВОР, который не скачивается (хранилища в стенде нет): автозагрузка покажет причину.
if (params.get('brokenFile') === '1') {
  window.__fakeDb.s3_documents.push({ id: 'doc-vor-bad', owner_type: 'tender', owner_id: 'tender-p', doc_category: 'vor_statement',
    file_name: 'ВОР_ЭОМ.xlsx', s3_key: 'tenders/tender-p/x-ВОР_ЭОМ.xlsx', created_at: '2026-10-13T09:00:00Z', uploaded_by_name: 'Иванов И. И.' })
}
// Второй ВОР: та же труба (подстановка цены) и тот же кран, но в другой единице (не подставляется).
const PRICING_POSITIONS_VK = [
  { name: 'труба медная ∅12.7', unit: 'м', volume: 200, order: 1 },
  { name: 'Кран шаровой Ду15', unit: 'компл', volume: 5, order: 2 },
].map((p) => ({ ...p, k: normName(p.name) }))
window.__fakeDb.tender_supply_sources = [{
  id: 'src-p', tender_id: 'tender-p', estimate_name: 'ОВ', source: 'vor_file', s3_document_id: 'doc-vor-p', file_name: 'ВОР_ОВ.xlsx',
  sheet_name: 'Материалы', column_map: null, source_version: 'file:doc-vor-p:2026-10-12T09:00:00Z', positions: PRICING_POSITIONS,
  positions_count: PRICING_POSITIONS.length, row_version: 1, parsed_by: 'user-2', parsed_at: '2026-10-12T09:05:00Z',
}, {
  id: 'src-p2', tender_id: 'tender-p', estimate_name: 'ВК', source: 'vor_file', s3_document_id: 'doc-vor-p2', file_name: 'ВОР_ВК.xlsx',
  sheet_name: 'Материалы', column_map: null, source_version: 'file:doc-vor-p2:2026-10-12T09:10:00Z', positions: PRICING_POSITIONS_VK,
  positions_count: PRICING_POSITIONS_VK.length, row_version: 1, parsed_by: 'user-2', parsed_at: '2026-10-12T09:15:00Z',
}]

// bigPricing=N — у tender-p вместо двух маленьких ВОР N позиций (по 300 на ВОР), треть расценена: замер
// загрузки и отклика таблицы на объёме больших тендеров прода (до 2,3 тыс. позиций).
const BIG_PRICING = Number(params.get('bigPricing') || 0)
if (BIG_PRICING > 0) {
  const units = ['м', 'шт', 'м²', 'кг', 'т', 'компл']
  window.__fakeDb.tender_supply_sources = []
  for (let v = 0; v * 300 < BIG_PRICING; v++) {
    const name = `Корпус ${v + 1}`
    const positions = Array.from({ length: Math.min(300, BIG_PRICING - v * 300) }, (_, i) => {
      const n = `Материал ${v + 1}.${i + 1} — труба стальная электросварная Ø${57 + (i % 40)}×3,5 ГОСТ 10704-91`
      return { name: n, unit: units[i % units.length], volume: 10 + (i % 97) * 3.5, order: i + 1, k: normName(n) }
    })
    window.__fakeDb.tender_supply_sources.push({
      id: `src-big-${v}`, tender_id: 'tender-p', estimate_name: name, source: 'vor_tab', s3_document_id: null, file_name: null,
      sheet_name: null, column_map: null, source_version: `vor:${positions.length}:2026-10-01T10:00:00Z`, positions,
      positions_count: positions.length, row_version: 1, parsed_by: 'user-2', parsed_at: '2026-10-12T09:05:00Z',
    })
    positions.forEach((p, i) => {
      if (i % 3) return
      window.__fakeDb.tender_vor_supply_rates.push({
        id: `rate-big-${v}-${i}`, tender_id: 'tender-p', estimate_name: name, material_name: p.name, unit: p.unit,
        supply_price: 100 + i, supply_price_exact: null, supply_total: Math.round((100 + i) * p.volume * 100) / 100, price_input: 'unit',
        input_value: 100 + i, volume_at_input: p.volume, row_version: 1, updated_by: 'user-2', updated_at: '2026-10-12T10:00:00Z',
        created_at: '2026-10-12T10:00:00Z', material_key: p.k,
      })
    })
  }
  window.__fakeDb.s3_documents = window.__fakeDb.s3_documents.filter((d) => d.owner_id !== 'tender-p')
}

// Тендер без файлов ВОР: позиции берутся из вкладки «ВОР» карточки (tender_estimate_items).
window.__fakeDb.tenders.push(
  { id: 'tender-q', tender_type: 'main', department: 'warranty', public_tender_number: 301, status: 'Идет тендерная процедура',
    work_description: 'Электромонтажные работы', object_id: 'obj-2', objects: objects[1], deleted_at: null, parent_tender_id: null },
  { id: 'mat-q', tender_type: 'materials', department: 'warranty', public_tender_number: 302, status: 'В работе',
    work_description: 'Электромонтажные работы', object_id: 'obj-2', objects: objects[1], deleted_at: null, parent_tender_id: 'tender-q' },
)
window.__fakeDb.tender_estimate_items.push(
  { id: 'q-1', tender_id: 'tender-q', estimate_name: 'Корпус 7', row_number: 1, code: 'Р', cost_name: 'Прокладка кабеля', unit: 'м', work_volume: 4000, material_consumption: null, is_section: false, outline_level: 0, created_at: '2026-10-01T10:00:00Z' },
  { id: 'q-2', tender_id: 'tender-q', estimate_name: 'Корпус 7', row_number: 2, code: 'мат.', cost_name: 'Кабель ВВГнг 3×2,5', unit: 'м', work_volume: null, material_consumption: 4000, is_section: false, outline_level: 1, created_at: '2026-10-01T10:00:00Z' },
  { id: 'q-3', tender_id: 'tender-q', estimate_name: 'Корпус 7', row_number: 3, code: 'мат.', cost_name: 'Щит ЩРН-12', unit: 'шт', work_volume: null, material_consumption: 3, is_section: false, outline_level: 1, created_at: '2026-10-01T10:00:00Z' },
)
window.__fakeDb.tender_vor_supply_rates.push({
  id: 'rate-p-3', tender_id: 'tender-p', estimate_name: 'ОВ', material_name: 'Изоляция K-Flex 13×15', unit: 'м',
  supply_price: 96, supply_price_exact: null, supply_total: 105600, price_input: 'unit', input_value: 96, volume_at_input: 1100,
  row_version: 1, updated_by: 'user-2', updated_at: '2026-10-12T10:00:00Z', created_at: '2026-10-12T10:00:00Z',
  material_key: normName('Изоляция K-Flex 13×15'),
})
window.__fakeDb.tender_supply_rate_log = []
// Уникальные ключи, как в базе: цена — одна на (тендер, ВОР, наименование), список позиций — один на ВОР.
window.__fakeUnique = {
  tender_vor_supply_rates: ['tender_id', 'estimate_name', 'material_name'],
  tender_supply_sources: ['tender_id', 'estimate_name'],
}
// Журнал расценок — триггер «после записи» tender_supply_rate_log_write: номер растёт с каждой правкой.
let rateLogSeq = 0
window.__fakeAfter = {
  tender_vor_supply_rates(op, row, old) {
    const r = row || old
    window.__fakeDb.tender_supply_rate_log.push({
      id: ++rateLogSeq, tender_id: r.tender_id, rate_id: r.id, op, estimate_name: r.estimate_name, material_name: r.material_name,
      unit: r.unit, old_price: old?.supply_price ?? null, new_price: row?.supply_price ?? null, changed_by: row?.updated_by || 'user-1',
      changed_by_name: 'Стендов С. С.', changed_at: new Date().toISOString(),
    })
  },
}
// noSheetFile=1 — у тендера без файлов ВОР появляется файл без листа «Материалы» (содержимое кладёт тест в
// window.__fakeFiles): причина запоминается, и при следующем открытии файл не скачивается снова.
if (params.get('noSheetFile') === '1') {
  window.__fakeDb.s3_documents.push({ id: 'doc-vor-q', owner_type: 'tender', owner_id: 'tender-q', doc_category: 'vor_statement',
    file_name: 'ВОР_Корпус7.xlsx', s3_key: 'tenders/tender-q/x-ВОР_Корпус7.xlsx', created_at: '2026-10-14T09:00:00Z', uploaded_by_name: 'Иванов И. И.' })
}
window.__fakeDb.employee_directory = [{ user_id: 'user-2', display_name: 'Петров П. П.', full_name: 'Петров Пётр Петрович', email: 'p@example.invalid', role: 'supply' }]
if (params.get('missing') === '1') {
  window.__fakeErrors = { tender_supply_sources: { code: '42P01', message: 'relation "public.tender_supply_sources" does not exist' } }
}

// Триггер расчёта tender_vor_supply_rates (миграция 20261020) — та же логика, что в базе.
const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100
window.__fakeTriggers = {
  tender_vor_supply_rates(row, old) {
    row.row_version = old ? (old.row_version || 1) + 1 : 1
    row.updated_by = 'user-1'
    const page = ['unit', 'total'].includes(row.price_input)
      && (!old || row.price_input !== old.price_input || row.input_value !== old.input_value || row.volume_at_input !== old.volume_at_input)
    if (page && row.price_input === 'unit') {
      row.supply_price = round2(row.input_value)
      row.supply_price_exact = null
      row.supply_total = row.volume_at_input > 0 ? round2(row.supply_price * row.volume_at_input) : null
    } else if (page) {
      row.supply_total = round2(row.input_value)
      row.supply_price_exact = row.supply_total / row.volume_at_input
      row.supply_price = round2(row.supply_price_exact)
    } else if (!old || row.supply_price !== old.supply_price) {
      Object.assign(row, { price_input: 'import', input_value: row.supply_price, volume_at_input: null, supply_price_exact: null, supply_total: null })
    }
    row.material_key = normName(row.material_name)
  },
  // Список позиций: ключ k, число позиций и версия — как триггер tender_supply_sources_compute.
  tender_supply_sources(row, old) {
    row.positions = (row.positions || []).map((p) => ({ ...p, k: normName(p.name) }))
    row.positions_count = new Set(row.positions.map((p) => p.k).filter(Boolean)).size
    row.row_version = old ? (old.row_version || 1) + 1 : 1
    row.parsed_by = 'user-1'
    row.parsed_at = new Date().toISOString()
  },
}

// Ссылки на документы к позициям расценки (миграция 20261022): одна на (тендер, ВОР, ключ наименования).
//   noLinks=1 — таблицы ссылок нет (миграция не применена): колонки «Документ» нет, остальное работает;
//   seedLink=1 — у изоляции в ОВ уже есть ссылка (просмотр без права правки).
window.__fakeDb.tender_supply_links = params.get('seedLink') === '1'
  ? [{ id: 'link-p-3', tender_id: 'tender-p', estimate_name: 'ОВ', material_name: 'Изоляция K-Flex 13×15', material_key: normName('Изоляция K-Flex 13×15'),
    url: 'https://disk.example.ru/d/schet-15', updated_by: 'user-2', updated_at: '2026-10-18T09:00:00Z', created_at: '2026-10-18T09:00:00Z' }]
  : []
window.__fakeUnique.tender_supply_links = ['tender_id', 'estimate_name', 'material_key']
window.__fakeGenerated = { tender_supply_links: (r) => ({ material_key: normName(r.material_name) }) }
window.__fakeTriggers.tender_supply_links = (row) => {
  row.url = String(row.url).trim()
  row.updated_by = 'user-1'
  row.updated_at = new Date().toISOString()
}
if (params.get('noLinks') === '1') {
  window.__fakeErrors = { ...(window.__fakeErrors || {}), tender_supply_links: { code: '42P01', message: 'relation "public.tender_supply_links" does not exist' } }
}
