// Данные крупного тендера для стенда (выполняется до импорта страницы).
import { normName } from '../../../src/utils/supplyRateHelpers.js'
const params = new URLSearchParams(window.location.search)
const ITEMS = Number(params.get('items') || 5000)
const CPS = Number(params.get('cps') || 10)
const DOCS = ['Корпус 1', 'Корпус 2', 'Паркинг']
const CP_CONTACTS = params.get('cpContacts') === '1'
const PHONE_EXT = params.get('phoneExt') === '1'
// ?cpCard=1 — карточка контрагента «Общая информация»: колонки НДС есть (миграция 20261026), у «Подрядчика 01»
// примечание, ставка 22 %, связь с «Подрядчиком 02», договор с двумя ДС, договор, где он вторая сторона, и чужой договор;
// у «Подрядчика 04» записан «Без НДС», у «Подрядчика 05» — 20 % (из выбора убраны 23.10.2026, но видны как есть).
const CP_CARD = params.get('cpCard') === '1'

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
    // Подразделение ВОР (общее с «ВОРами и РД»): у части тендеров указано, у первого — нет.
    vor_division: [null, 'monolith', 'general', null, 'electrical'][i % 5],
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
  // ?cpContacts=1 — у контрагентов есть контакты с телефонами, третий — в чёрном списке (реестр контрагентов на телефоне);
  // &phoneExt=1 — у первого номера добавочный («… доб. 123»).
  counterparties: counterparties.map((cp, i) => ({
    ...cp,
    status: CP_CONTACTS && i === 2 ? 'blacklist' : 'active',
    inn: '123456789012',
    work_type: CP_CONTACTS && i % 4 === 1 ? 'Фасадные работы, Кровельные работы, Устройство вентилируемых фасадов, Остекление, Благоустройство территории' : 'Фасадные работы',
    counterparty_contacts: CP_CONTACTS && i % 2 === 0
      ? [{ id: `cpc-${i}`, counterparty_id: cp.id, full_name: 'Сапаров Ержан Болатович', phone: `+7 701 555-12-34${PHONE_EXT ? ' доб. 123' : ''}; +7 727 300-00-00`, email: 'sales@example.invalid' }]
      : [],
    ...(CP_CARD ? {
      vat_rate: i === 0 ? 22 : i === 4 ? 20 : null,
      vat_exempt: i === 3,
      notes: i === 0 ? 'Работает только по предоплате' : null,
    } : {}),
  })),
  counterparty_relations: CP_CARD ? [{ id: 'rel-1', counterparty_id: 'cp-1', related_counterparty_id: 'cp-2' }] : [],
  counterparty_audit_log: [],
  contracts: CP_CARD ? [
    { id: 'k-1', display_id: 101, record_type: 'dp', parent_contract_id: null, root_contract_id: null, counterparty_id: 'cp-1',
      status: 'in_work', deleted_at: null, contract_number: 'П-15/26', contract_date: '2026-03-02', contract_amount: 1000000,
      psdc_total: null, currency: 'RUB', work_name: 'Устройство фасада', changed_fields: [], objects: { name: 'ЖК Северный' } },
    { id: 'k-1-ds1', display_id: 102, record_type: 'ds_extra', parent_contract_id: 'k-1', root_contract_id: 'k-1', counterparty_id: 'cp-1',
      status: 'completed', deleted_at: null, contract_number: 'ДС-1', contract_date: '2026-05-10', contract_amount: 250000,
      psdc_total: null, currency: 'RUB', work_name: 'Доп. отделка', changed_fields: [], objects: { name: 'ЖК Северный' } },
    { id: 'k-1-ds2', display_id: 103, record_type: 'ds_vor', parent_contract_id: 'k-1', root_contract_id: 'k-1', counterparty_id: 'cp-1',
      status: 'new_request', deleted_at: null, contract_number: 'ДС-2', contract_date: null, contract_amount: null,
      psdc_total: null, currency: 'RUB', work_name: null, changed_fields: [], objects: { name: 'ЖК Северный' } },
    { id: 'k-2', display_id: 104, record_type: 'dp', parent_contract_id: null, root_contract_id: null, counterparty_id: 'cp-3',
      status: 'completed', deleted_at: null, contract_number: 'Т-7', contract_date: '2025-11-20', contract_amount: 500000,
      psdc_total: null, currency: 'RUB', work_name: 'Трёхсторонний договор', changed_fields: [], objects: { name: 'БЦ Восток' } },
    { id: 'k-3', display_id: 105, record_type: 'dp', parent_contract_id: null, root_contract_id: null, counterparty_id: 'cp-4',
      status: 'in_work', deleted_at: null, contract_number: 'ЧУЖОЙ-1', contract_date: '2026-01-01', contract_amount: 1,
      psdc_total: null, currency: 'RUB', work_name: 'Не его договор', changed_fields: [], objects: { name: 'Другой объект' } },
  ] : [],
  contract_counterparties: CP_CARD ? [
    { id: 'kc-1', contract_id: 'k-2', counterparty_id: 'cp-3', sort_order: 0, contracts: { id: 'k-2', root_contract_id: null, deleted_at: null } },
    { id: 'kc-2', contract_id: 'k-2', counterparty_id: 'cp-1', sort_order: 1, contracts: { id: 'k-2', root_contract_id: null, deleted_at: null } },
  ] : [],
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

// Состояние разбора позиций службой osp-api (миграция 20261024).
//   importStates=1 — реестр: у tender-1 файл ВОР не разобрался, у tender-2 ВОР нет, tender-3 — ещё в очереди;
//   serverIssue=1 — у tender-p служба уже знает, что файл ВОР_ЭОМ (brokenFile=1) не читается: страница его не скачивает.
window.__fakeDb.tender_supply_import_state = [
  ...(params.get('importStates') === '1' ? [
    { tender_id: 'tender-1', status: 'issues', positions_count: 0, checked_at: '2026-10-19T10:00:00Z',
      issues: [{ doc_id: 'doc-x', file_name: 'ВОР_ЭОМ.xlsx', version: 'file:doc-x:1', parser: 2, kind: 'no_sheet' }] },
    { tender_id: 'tender-2', status: 'no_vor', positions_count: 0, checked_at: '2026-10-19T10:00:00Z', issues: [] },
    { tender_id: 'tender-3', status: 'pending', positions_count: 0, checked_at: '2026-10-19T10:00:00Z', issues: [] },
  ] : []),
  ...(params.get('serverIssue') === '1' ? [
    { tender_id: 'tender-p', status: 'ok', positions_count: 6, checked_at: '2026-10-19T10:00:00Z',
      issues: [{ doc_id: 'doc-vor-bad', file_name: 'ВОР_ЭОМ.xlsx', version: 'file:doc-vor-bad:2026-10-13T09:00:00Z', parser: 2, kind: 'broken', message: 'zip повреждён' }] },
  ] : []),
]

// Цены из других тендеров (миграция 20261023). reuse=1 — функции базы есть: у тендера № 445 «ЖК Север» свежие
// цены — тот же кран (подставится сам в ОВ; в ВК у крана другая ед. изм.), похожие трубы (меню) и старый хомут
// (старше 3 месяцев — ни сам, ни в меню). Без reuse функций нет, как до миграции: таблица работает как раньше.
const dayAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
const OTHER_RATES = [
  { id: 'o-kran', estimate_name: 'ВК-2', material_name: 'Кран шаровой Ду15', unit: 'шт', unit_price: 512.5, price_date: dayAgo(5), url: 'https://disk.example.ru/d/chek-445' },
  { id: 'o-truba-1', estimate_name: 'ОВ-2', material_name: 'Труба медная Ø12,7 мм (бухта)', unit: 'м', unit_price: 980, price_date: dayAgo(2), url: null },
  { id: 'o-truba-2', estimate_name: 'ОВ-2', material_name: 'Труба медная Ø15,9', unit: 'м', unit_price: 1100, price_date: dayAgo(20), url: 'https://disk.example.ru/d/chek-17' },
  { id: 'o-homut', estimate_name: 'ОВ-2', material_name: 'Хомут монтажный', unit: 'шт', unit_price: 35, price_date: dayAgo(120), url: null },
].map((r) => ({ ...r, k: normName(r.material_name), tender_id: 'tender-o', tender_number: 445, object_name: 'ЖК Север' }))
const freshRate = (o) => o.price_date >= dayAgo(91)
const nameWords = (s) => String(s).toLowerCase().split(/[^a-zа-яё]+/).filter((w) => w.length >= 3)
const similarRates = (name, unit) => {
  const w = new Set(nameWords(name))
  return OTHER_RATES.filter((o) => o.unit === unit && freshRate(o) && nameWords(o.material_name).some((x) => w.has(x)))
    .sort((a, b) => b.price_date.localeCompare(a.price_date))
}
if (params.get('reuse') === '1') {
  // Колонки 20261023 у прежней цены: день расценки и кто поставил; сам пользователь стенда — в справочнике ФИО.
  Object.assign(window.__fakeDb.tender_vor_supply_rates.find((r) => r.id === 'rate-p-3'), { price_date: dayAgo(3), price_by: 'user-2' })
  window.__fakeDb.employee_directory.push({ user_id: 'user-1', display_name: 'Стендов С. С.', full_name: 'Стендов Стенд Стендович', email: 't@example.invalid', role: 'admin' })
  window.__fakeRpc = {
    supply_autofill({ p_tender }) {
      const fdb = window.__fakeDb
      let n = 0
      for (const src of fdb.tender_supply_sources.filter((x) => x.tender_id === p_tender)) {
        for (const p of src.positions) {
          if (p.units || !p.unit) continue
          if (fdb.tender_vor_supply_rates.some((r) => r.tender_id === p_tender && r.estimate_name === src.estimate_name && r.material_key === p.k)) continue
          if (fdb.tender_supply_rate_log.some((l) => l.tender_id === p_tender && l.estimate_name === src.estimate_name && normName(l.material_name) === p.k)) continue
          const o = OTHER_RATES.filter((x) => x.k === p.k && x.unit === p.unit && freshRate(x)).sort((a, b) => b.price_date.localeCompare(a.price_date))[0]
          if (!o) continue
          const now = new Date().toISOString()
          const row = { id: crypto.randomUUID(), tender_id: p_tender, estimate_name: src.estimate_name, material_name: p.name, unit: p.unit,
            price_input: 'unit', input_value: o.unit_price, volume_at_input: p.volume, source_rate_id: o.id, source_kind: 'auto', created_at: now, updated_at: now }
          window.__fakeTriggers.tender_vor_supply_rates(row, null)
          fdb.tender_vor_supply_rates.push(row)
          window.__fakeAfter.tender_vor_supply_rates('insert', row, null)
          n += 1
        }
      }
      return { data: n, error: null }
    },
    supply_suggestion_counts({ p_items }) {
      return { data: p_items.map((i) => ({ estimate_name: i.doc, k: i.k, n: similarRates(i.name, i.unit).length })).filter((r) => r.n > 0), error: null }
    },
    supply_rate_suggestions({ p_name, p_unit, p_limit = 15 }) {
      return {
        data: similarRates(p_name, p_unit).slice(0, p_limit).map((o) => ({
          rate_id: o.id, tender_id: o.tender_id, tender_number: o.tender_number, object_name: o.object_name, estimate_name: o.estimate_name,
          material_name: o.material_name, unit: o.unit, unit_price: o.unit_price, price_date: o.price_date, url: o.url, similarity: 0.8,
          same_name: o.k === normName(p_name),
        })),
        error: null,
      }
    },
    supply_rate_origins({ p_tender }) {
      return {
        data: window.__fakeDb.tender_vor_supply_rates.filter((r) => r.tender_id === p_tender && r.source_kind).map((r) => {
          const o = OTHER_RATES.find((x) => x.id === r.source_rate_id)
          return { rate_id: r.id, source_kind: r.source_kind, source_tender_id: r.source_tender_id, tender_number: o?.tender_number ?? null,
            object_name: o?.object_name ?? null, estimate_name: o?.estimate_name ?? null, material_name: o?.material_name ?? null,
            price_date: r.price_date, url: o?.url ?? null, source_price_by: o ? 'user-2' : null }
        }),
        error: null,
      }
    },
  }
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
    // День расценки, автор и копия цены другого тендера (миграция 20261023) — как в базе; без reuse=1 колонок нет.
    if (params.get('reuse') !== '1') return
    const priced = !old || row.supply_price !== old.supply_price || row.supply_price_exact !== old.supply_price_exact
    const src = row.source_rate_id && (!old || row.source_rate_id !== old.source_rate_id) ? OTHER_RATES.find((o) => o.id === row.source_rate_id) : null
    if (src) {
      Object.assign(row, { price_date: src.price_date, source_tender_id: src.tender_id, source_kind: row.source_kind || 'pick' })
      row.price_by = row.source_kind === 'pick' ? 'user-1' : null
    } else if (priced || !old?.price_date) {
      Object.assign(row, { price_date: dayAgo(0), price_by: 'user-1', source_rate_id: null, source_tender_id: null, source_kind: null })
    } else {
      Object.assign(row, { price_date: old.price_date, price_by: old.price_by ?? null, source_rate_id: old.source_rate_id ?? null,
        source_tender_id: old.source_tender_id ?? null, source_kind: old.source_kind ?? null })
    }
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
// Как tender_supply_links_touch (20261025): документ — адрес или файл; записали одно — другое снимается.
window.__fakeTriggers.tender_supply_links = (row, old) => {
  row.url = row.url == null ? null : (String(row.url).trim() || null)
  if (old) {
    if (row.url && row.url !== old.url && (row.s3_document_id ?? null) === (old.s3_document_id ?? null)) row.s3_document_id = null
    else if (row.s3_document_id && row.s3_document_id !== old.s3_document_id && (row.url ?? null) === (old.url ?? null)) row.url = null
  }
  row.updated_by = 'user-1'
  row.updated_at = new Date().toISOString()
}
if (params.get('noLinks') === '1') {
  window.__fakeErrors = { ...(window.__fakeErrors || {}), tender_supply_links: { code: '42P01', message: 'relation "public.tender_supply_links" does not exist' } }
}

// Версии ВОР (миграция 20261029). Таблица версий есть всегда (пустая — изменений не было); noVersions=1 — её нет, как
// до миграции. vorChanges=1 — сметный отдел обновил ВОР «ОВ»: у крана объём 40 → 48 (и цена за «компл», а в ВОР «шт»),
// у изоляции ед. изм. «м2» → «м», хомут — новая позиция, «Труба медная Ø12,7 (бухта)» убрана, её цена 950 ₽ осталась —
// похожа на трубу без цены. vorQuestion=1 — файл ВОР ОВ удалён, рядом новый файл с другим именем: новая версия ли это.
window.__fakeDb.tender_supply_revisions = []
if (params.get('noVersions') === '1') {
  window.__fakeErrors = { ...(window.__fakeErrors || {}), tender_supply_revisions: { code: '42P01', message: 'relation "public.tender_supply_revisions" does not exist' } }
}
const versionChange = (op, name, extra = {}) => ({ op, k: normName(name), name, ...extra })
if (params.get('vorChanges') === '1') {
  window.__fakeDb.tender_vor_supply_rates.push({
    id: 'rate-p-old', tender_id: 'tender-p', estimate_name: 'ОВ', material_name: 'Труба медная Ø12,7 (бухта)', unit: 'м',
    supply_price: 950, supply_price_exact: null, supply_total: 1425000, price_input: 'unit', input_value: 950, volume_at_input: 1500,
    row_version: 1, updated_by: 'user-2', updated_at: '2026-10-12T10:00:00Z', created_at: '2026-10-12T10:00:00Z',
    material_key: normName('Труба медная Ø12,7 (бухта)'),
  }, {
    id: 'rate-p-kran', tender_id: 'tender-p', estimate_name: 'ОВ', material_name: 'Кран шаровой Ду15', unit: 'компл',
    supply_price: 500, supply_price_exact: null, supply_total: 20000, price_input: 'unit', input_value: 500, volume_at_input: 40,
    row_version: 1, updated_by: 'user-2', updated_at: '2026-10-12T10:00:00Z', created_at: '2026-10-12T10:00:00Z',
    material_key: normName('Кран шаровой Ду15'),
  })
  window.__fakeDb.tender_supply_revisions.push({
    id: 7, tender_id: 'tender-p', estimate_name: 'ОВ', kind: 'update', source: 'vor_file', old_document_id: 'doc-vor-p0', new_document_id: 'doc-vor-p',
    old_file_name: 'ВОР_ОВ.xlsx', new_file_name: 'ВОР_ОВ.xlsx', uploaded_by_name: 'Сметов С. С.', uploaded_at: '2026-10-21T09:55:00Z',
    positions_before: 4, positions_after: 4, added: 1, removed: 1, volume_changed: 1, unit_changed: 1, priced_removed: 1,
    changes: [
      versionChange('volume', 'Кран шаровой Ду15', { unit: 'шт', volume: 48, old_unit: 'шт', old_volume: 40, price: 500, rate_id: 'rate-p-kran' }),
      versionChange('unit', 'Изоляция K-Flex 13×15', { unit: 'м', volume: 1100, old_unit: 'м2', old_volume: 1100, price: 96, rate_id: 'rate-p-3' }),
      versionChange('added', 'Хомут монтажный', { unit: 'шт' }),
      versionChange('removed', 'Труба медная Ø12,7 (бухта)', { old_unit: 'м', old_volume: 1500, price: 950, rate_id: 'rate-p-old' }),
    ],
    prices: [
      { rate_id: 'rate-p-3', k: normName('Изоляция K-Flex 13×15'), name: 'Изоляция K-Flex 13×15', unit: 'м', volume: 1100, price: 96, total: 105600, input: 'unit', date: '2026-10-12' },
      { rate_id: 'rate-p-kran', k: normName('Кран шаровой Ду15'), name: 'Кран шаровой Ду15', unit: 'компл', volume: 40, price: 500, total: 20000, input: 'unit', date: '2026-10-12' },
      { rate_id: 'rate-p-old', k: normName('Труба медная Ø12,7 (бухта)'), name: 'Труба медная Ø12,7 (бухта)', unit: 'м', volume: 1500, price: 950, total: 1425000, input: 'unit', date: '2026-10-12' },
    ],
    created_by: null, created_at: '2026-10-21T10:00:00Z', reviewed_at: null, reviewed_by: null,
  }, {
    // Реестр тендеров на материалы (matTenders=1): у тендера № 1 добавили ВОР, снабжение ещё не смотрело.
    id: 8, tender_id: 'tender-1', estimate_name: 'ВОР ЭОМ', kind: 'added', source: 'vor_file', new_file_name: 'ВОР ЭОМ.xlsx',
    positions_before: 0, positions_after: 12, added: 12, removed: 0, volume_changed: 0, unit_changed: 0, priced_removed: 0,
    changes: [], prices: [], created_by: null, created_at: '2026-10-21T11:00:00Z', reviewed_at: null, reviewed_by: null,
  })
}
if (params.get('vorQuestion') === '1') {
  // Файл прежней версии удалён из «ВОРов и РД» (ссылка в списке осталась — база обнуляет её, стенд — нет: файла нет в
  // списке файлов, этого достаточно), рядом — новый файл с другим именем, уже разобранный в свой список.
  const NEW_AT = '2026-10-21T09:00:00Z'
  window.__fakeDb.s3_documents = window.__fakeDb.s3_documents.filter((d) => d.id !== 'doc-vor-p')
  window.__fakeDb.s3_documents.push({ id: 'doc-vor-p3', owner_type: 'tender', owner_id: 'tender-p', doc_category: 'vor_statement',
    file_name: 'ВОР_ОВ изм.1.xlsx', s3_key: 'tenders/tender-p/x-ВОР_ОВ изм.1.xlsx', created_at: NEW_AT, uploaded_by_name: 'Сметов С. С.' })
  Object.assign(window.__fakeDb.tender_supply_sources.find((s) => s.id === 'src-p'), { created_at: '2026-10-12T09:05:00Z' })
  const positions = [
    { name: 'Труба медная Ø12,7', unit: 'м', volume: 1600, order: 1 },
    { name: 'Кран шаровой Ду15', unit: 'шт', volume: 48, order: 2 },
    { name: 'Отвод 90° Ду15', unit: 'шт', volume: 30, order: 3 },
  ].map((p) => ({ ...p, k: normName(p.name) }))
  window.__fakeDb.tender_supply_sources.push({
    id: 'src-p3', tender_id: 'tender-p', estimate_name: 'ВОР_ОВ изм.1', source: 'vor_file', s3_document_id: 'doc-vor-p3', file_name: 'ВОР_ОВ изм.1.xlsx',
    sheet_name: 'Материалы', column_map: null, source_version: `file:doc-vor-p3:${NEW_AT}`, positions, positions_count: positions.length,
    row_version: 1, parsed_by: null, parsed_at: NEW_AT, created_at: NEW_AT, prior_document_ids: [], separate_at: null,
  })
}
// Функции базы версий ВОР — та же логика, что в миграции, на данных стенда.
const fdbv = () => window.__fakeDb
window.__fakeRpc = {
  ...(window.__fakeRpc || {}),
  supply_revisions_review({ p_tender, p_ids }) {
    let n = 0
    for (const r of fdbv().tender_supply_revisions) {
      if (r.tender_id === p_tender && p_ids.includes(r.id) && !r.reviewed_at) { r.reviewed_at = new Date().toISOString(); r.reviewed_by = 'user-1'; n += 1 }
    }
    return { data: n, error: null }
  },
  supply_rate_carry({ p_rate, p_version, p_estimate, p_name, p_unit }) {
    const rates = fdbv().tender_vor_supply_rates
    const rate = rates.find((r) => r.id === p_rate)
    if (!rate || rate.row_version !== p_version) return { data: null, error: { code: '23505', message: 'Эту цену уже изменили — обновите страницу', hint: 'supply_carry_stale' } }
    const k = normName(p_name)
    const at = (r) => r.tender_id === rate.tender_id && r.estimate_name === p_estimate && r.material_key === k
    if (rates.some((r) => at(r) && r.source_kind !== 'auto')) return { data: null, error: { code: '23505', message: `У позиции «${p_name}» уже есть своя цена` } }
    const dropped = rates.filter(at).map((r) => r.id)
    fdbv().tender_vor_supply_rates = rates.filter((r) => !dropped.includes(r.id))
    const old = { ...rate }
    Object.assign(rate, { estimate_name: p_estimate, material_name: p_name, unit: p_unit || rate.unit, updated_at: new Date().toISOString() })
    window.__fakeTriggers.tender_vor_supply_rates(rate, old)
    window.__fakeAfter.tender_vor_supply_rates('update', rate, old)
    return { data: { rate: { ...rate }, dropped, links: 0 }, error: null }
  },
  supply_vor_adopt({ p_tender, p_new, p_old }) {
    const db = fdbv()
    const n = db.tender_supply_sources.find((s) => s.tender_id === p_tender && s.estimate_name === p_new)
    const o = db.tender_supply_sources.find((s) => s.tender_id === p_tender && s.estimate_name === p_old)
    if (!n || !o) return { data: null, error: { code: '23505', message: 'ВОР уже изменили — обновите страницу' } }
    const prior = [...new Set([...(o.prior_document_ids || []), ...(o.s3_document_id ? [o.s3_document_id] : [])])]
    const oldKeys = new Set(o.positions.map((p) => p.k))
    const newKeys = new Set(n.positions.map((p) => p.k))
    const priceOf = (k) => db.tender_vor_supply_rates.find((r) => r.tender_id === p_tender && r.estimate_name === p_old && r.material_key === k)
    const added = n.positions.filter((p) => !oldKeys.has(p.k)).map((p) => versionChange('added', p.name, { unit: p.unit, volume: p.volume }))
    const removed = o.positions.filter((p) => !newKeys.has(p.k)).map((p) => versionChange('removed', p.name, {
      old_unit: p.unit, old_volume: p.volume, price: priceOf(p.k)?.supply_price, rate_id: priceOf(p.k)?.id }))
    db.tender_supply_revisions.push({
      id: 100 + db.tender_supply_revisions.length, tender_id: p_tender, estimate_name: p_old, kind: 'update', source: 'vor_file',
      old_file_name: o.file_name, new_file_name: n.file_name, uploaded_by_name: 'Сметов С. С.', positions_before: o.positions_count,
      positions_after: n.positions_count, added: added.length, removed: removed.length, volume_changed: 0, unit_changed: 0,
      priced_removed: removed.filter((c) => c.rate_id).length, changes: [...added, ...removed],
      prices: [], created_by: 'user-1', created_at: new Date().toISOString(), reviewed_at: null, reviewed_by: null,
    })
    Object.assign(o, { s3_document_id: n.s3_document_id, file_name: n.file_name, source_version: n.source_version, positions: n.positions,
      positions_count: n.positions_count, prior_document_ids: prior, row_version: o.row_version + 1 })
    let moved = 0
    for (const r of db.tender_vor_supply_rates) if (r.tender_id === p_tender && r.estimate_name === p_new) { r.estimate_name = p_old; moved += 1 }
    db.tender_supply_sources = db.tender_supply_sources.filter((s) => s !== n)
    return { data: { moved, replaced: 0, dropped: 0, links: 0 }, error: null }
  },
}

// Договор, прикреплённый к контрагенту вручную (миграция 20261031): у «Подрядчика 01» — договор «Л-3» «Подрядчика 05»
// (прикрепил Петров П. П.); при прикреплении кто прикрепил ставит «триггер». У договоров — контрагент (выбор договора
// ищет и по нему). cpLinks=0 — таблицы привязок нет, как до миграции.
if (CP_CARD) {
  const fdb = window.__fakeDb
  fdb.contracts.push({ id: 'k-4', display_id: 106, record_type: 'dp', parent_contract_id: null, root_contract_id: null, counterparty_id: 'cp-5',
    status: 'completed', deleted_at: null, contract_number: 'Л-3', contract_date: '2024-06-01', contract_amount: 300000,
    psdc_total: null, currency: 'RUB', work_name: 'Кровля паркинга', changed_fields: [], objects: { name: 'ЖК Южный' } })
  for (const k of fdb.contracts) k.counterparties = { name: fdb.counterparties.find((c) => c.id === k.counterparty_id)?.name }
  fdb.counterparty_contract_links = [{ id: 'cl-1', counterparty_id: 'cp-1', contract_id: 'k-4', created_by: 'user-2', created_at: '2026-10-20T07:30:00Z' }]
  window.__fakeUnique.counterparty_contract_links = ['counterparty_id', 'contract_id']
  window.__fakeTriggers.counterparty_contract_links = (row) => { row.created_by = 'user-1' }
  fdb.employee_directory.push({ user_id: 'user-1', display_name: 'Стендов С. С.', full_name: 'Стендов Стенд Стендович', email: 't@example.invalid', role: 'admin' })
  if (params.get('cpLinks') === '0') {
    window.__fakeErrors = { ...(window.__fakeErrors || {}),
      counterparty_contract_links: { code: 'PGRST205', message: "Could not find the table 'public.counterparty_contract_links' in the schema cache" } }
  }
}

// ── «Отчёты → Тендеры → Коммерческие предложения» (?route=/reports&kpStats=1) ─────────────────────────
// Файлы КП за последние 120 дней от «сейчас» браузера: по 3 в день (сегодня — за последние секунды),
// каждый пятый — новая версия предыдущего КП, старше 90 дней — до «Проверки КП» (review_required=false),
// на проверке — загруженные за последние 3 дня, каждый седьмой — гарантийный отдел. Встраивания (s3,
// tenders) лежат в строках.
if (params.get('kpStats') === '1') {
  const fdb = window.__fakeDb
  const now = new Date()
  const day = (back, hour) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, hour).toISOString()
  const uploaders = ['Архипов А. М.', 'Крюкова Ю. Д.', null]
  const reviewers = ['Петрова А. С.', 'Смирнов Д. В.']
  const rows = []
  for (let back = 0; back < 120; back++) {
    for (let k = 0; k < 3; k++) {
      const n = rows.length
      const tender = registry[n % registry.length]
      const isVersion = n % 5 === 4 && n > 0
      const created = back === 0 ? new Date(now.getTime() - (k + 1) * 1000).toISOString() : day(back, 8 + k)
      const required = back < 90
      const reviewed = required && back >= 3
      const remarks = reviewed && n % 3 === 0
      rows.push({
        id: `kpf-${n}`, tender_id: tender.id, counterparty_id: `cp-${(n % CPS) + 1}`,
        proposal_group_id: isVersion ? rows[n - 1].proposal_group_id : `kpg-${n}`,
        file_kind: 'commercial_proposal', created_at: created,
        review_required: required,
        review_status: reviewed ? (remarks ? 'has_remarks' : 'approved') : 'pending',
        reviewed_at: reviewed ? day(back - 1, 11) : null,
        reviewed_by: reviewed ? reviewers[n % 2] : null,
        remarks_send_required: !(remarks && n % 2 === 0),
        remarks_sent: remarks && back > 10,
        remarks_sent_at: remarks && back > 10 ? day(back - 2, 12) : null,
        summary_added: reviewed && back > 5,
        summary_added_at: reviewed && back > 5 ? day(back - 2, 10) : null,
        s3: { uploaded_by_name: uploaders[n % 3] },
        tenders: { object_id: tender.object_id, department: n % 7 === 0 ? 'warranty' : 'construction' },
      })
    }
  }
  fdb.tender_proposal_files = rows
}

// ── Файлы участников карточки tender-1 (tcFiles=1) — «Скачать всё» в ячейке «КП / Документы» ─────────────
// У «Подрядчик 01» две версии одного КП и документ, у «Подрядчик 02» — одно КП, у остальных файлов нет.
// Встраивание s3 лежит в строках, содержимое файлов — в хранилище стенда (window.__fakeFiles).
if (params.get('tcFiles') === '1') {
  const file = (id, counterpartyId, name, extra = {}) => {
    const key = `tenders/tender-1/${id}-${name}`
    window.__fakeFiles = { ...(window.__fakeFiles || {}),
      [key]: `data:application/octet-stream;base64,${btoa(unescape(encodeURIComponent(`содержимое ${name}`)))}` }
    const createdAt = extra.created_at || '2026-10-20T10:00:00Z'
    return { id, tender_id: 'tender-1', counterparty_id: counterpartyId, file_kind: 'commercial_proposal', proposal_group_id: null,
      version_label: null, review_required: false, created_at: createdAt, ...extra,
      s3: { id: `s3-${id}`, s3_key: key, file_name: name, size_bytes: name.length, created_at: createdAt, uploaded_by_name: 'Иванов И. И.' } }
  }
  window.__fakeDb.tender_proposal_files.push(
    file('tpf-1', 'cp-1', 'КП Подрядчик 01.xlsx', { proposal_group_id: 'g-1', version_label: 'исходное', created_at: '2026-10-18T10:00:00Z' }),
    file('tpf-2', 'cp-1', 'КП Подрядчик 01.xlsx', { proposal_group_id: 'g-1', created_at: '2026-10-21T10:00:00Z' }),
    file('tpf-3', 'cp-1', 'Выписка ЕГРЮЛ.pdf', { file_kind: 'attachment' }),
    file('tpf-4', 'cp-2', 'КП Подрядчик 02.xlsx', { proposal_group_id: 'g-2' }),
  )
}

// Публичная страница тендеров (/public/tenders) читает только представление public_open_tenders (20261016,
// ответственный — 20261101). № 369 — с ответственным и телефоном; № 370 — без ответственного, в ссылках
// javascript: (ссылками не становятся); № 371 — внутренний номер (не ссылка на звонок) и сетевой путь вместо
// адреса пакета. publicNoContact=1 — колонок ответственного ещё нет: выборка с ними отвечает 42703.
const PUBLIC_TENDERS = [
  {
    id: 'pub-369', public_tender_number: 369, work_description: 'Устройство кровли корпуса 2',
    start_date: '2026-11-01', end_date: '2026-12-15', tender_start_date: '2026-10-20', tender_end_date: '2026-10-30',
    tender_package_link: 'https://drive.example.ru/package-369', object_name: 'ЖК «Тёплый стан»',
    object_address: 'Москва, ул. Тёплый Стан, 1', object_map_link: 'https://yandex.ru/maps/?pt=37.5,55.6',
    responsible_name: 'Крюкова Юлия Денисовна', responsible_phone: '8 (916) 123-45-67',
  },
  {
    id: 'pub-370', public_tender_number: 370, work_description: 'Фасадные работы',
    start_date: '2026-11-10', end_date: '2027-02-01', tender_start_date: '2026-10-21', tender_end_date: '2026-11-05',
    tender_package_link: 'javascript:alert(1)', object_name: 'ЖК «Северный»',
    object_address: 'Москва, ул. Северная, 5', object_map_link: 'javascript:alert(2)',
    responsible_name: null, responsible_phone: null,
  },
  {
    id: 'pub-371', public_tender_number: 371, work_description: 'Электромонтажные работы',
    start_date: null, end_date: null, tender_start_date: null, tender_end_date: null,
    tender_package_link: '\\\\srv\\tenders\\371', object_name: 'Школа на 1100 мест',
    object_address: 'Москва, Ленинский пр., 10', object_map_link: null,
    responsible_name: 'Архипов Антон Михайлович', responsible_phone: 'доб. 214',
  },
]
if (params.get('publicNoContact') === '1') {
  window.__fakeDb.public_open_tenders = PUBLIC_TENDERS.map((t) => {
    const row = { ...t }
    delete row.responsible_name
    delete row.responsible_phone
    return row
  })
  window.__fakeMissingColumns = { public_open_tenders: ['responsible_name', 'responsible_phone'] }
} else {
  window.__fakeDb.public_open_tenders = PUBLIC_TENDERS
}

// ── «Общая информация» → «Отделы» (?route=/general/departments) ───────────────────────────────────────────
// Люди и телефоны — вымышленные. departments=missing — таблицы ещё нет (миграция 20261104 не применена).
if (params.get('departments') === 'missing') {
  window.__fakeErrors = {
    ...(window.__fakeErrors || {}),
    company_departments: { code: '42P01', message: 'relation "public.company_departments" does not exist' },
  }
} else {
  window.__fakeDb.company_departments = [
    { id: 'dep-1', sort_order: 10, block: 'Обеспечение деятельности компании', name: 'Юридический отдел',
      duties: 'Правовая экспертиза документов, сопровождение договоров, судебная защита.', note: null,
      contacts: [{ name: 'Стендов Сергей Сергеевич', position: '', phone: '+7 900 111-22-33' }] },
    { id: 'dep-2', sort_order: 20, block: 'Обеспечение деятельности компании', name: 'Административно-хозяйственный отдел',
      duties: 'Хозяйственное обслуживание офисных помещений, корпоративная мобильная связь.', note: 'Руководитель отсутствует',
      contacts: [{ name: 'Пробный П. П.', position: 'по сим-картам', phone: '+7 900 444-55-66' }] },
    { id: 'dep-3', sort_order: 30, block: 'Тендеры', name: 'Отдел по сопровождению подрядчиков',
      duties: 'Проведение тендеров и заключение договоров с подрядчиками.', note: null, contacts: [] },
    { id: 'dep-4', sort_order: 40, block: 'Финансы', name: 'Финансовый отдел',
      duties: 'Затраты по объектам строительства; начисление заработной платы.', note: null, contacts: [] },
  ]
}

// ── Задачи (?route=/tasks&task=task-1) — карточка задачи с чек-листом из трёх пунктов ───────────────────
// У второго и третьего пункта одинаковый sort_order — так бывало до перестановки (номер считался по длине списка).
// taskForeign=1 — задачу поставил другой сотрудник (user-2): пользователь стенда только исполнитель.
window.__fakeDb.tasks = [{
  id: 'task-1', title: 'Подготовить сводную КП', description: 'Собрать КП подрядчиков', status: 'in_progress',
  priority: 'normal', assignee_user_id: 'user-1',
  created_by_user_id: params.get('taskForeign') === '1' ? 'user-2' : 'user-1', due_date: null,
  object_id: null, tender_id: null, contract_id: null, sort_order: 0, created_at: '2026-10-20T10:00:00Z',
  deleted_at: null, completed_at: null, objects: null, tenders: null, contracts: null,
}]
window.__fakeDb.task_checklist_items = [
  { id: 'chk-1', task_id: 'task-1', title: 'Собрать КП', is_done: false, sort_order: 0, created_at: '2026-10-20T10:01:00Z' },
  { id: 'chk-2', task_id: 'task-1', title: 'Сверить объёмы', is_done: true, sort_order: 10, created_at: '2026-10-20T10:02:00Z' },
  { id: 'chk-3', task_id: 'task-1', title: 'Отправить на согласование', is_done: false, sort_order: 10, created_at: '2026-10-20T10:03:00Z' },
]
// taskChecklist=N — ещё пункты после трёх (chk-4 …): чек-лист длиннее экрана телефона.
for (let n = 4; n <= 3 + Number(params.get('taskChecklist') || 0); n++) {
  window.__fakeDb.task_checklist_items.push({ id: `chk-${n}`, task_id: 'task-1', title: `Пункт ${n}`, is_done: false,
    sort_order: n * 10, created_at: `2026-10-20T11:${String(n).padStart(2, '0')}:00Z` })
}
// taskList=N — ещё задачи в списке «Мои» (task-2 …) с объектом, тендером и сроком.
for (let n = 2; n <= 1 + Number(params.get('taskList') || 0); n++) {
  window.__fakeDb.tasks.push({
    ...window.__fakeDb.tasks[0], id: `task-${n}`, title: `Задача ${n}: проверить ведомость объёмов работ по разделу`,
    priority: n % 3 === 0 ? 'high' : 'normal', status: n % 2 ? 'new' : 'in_progress', due_date: `2026-11-${String(n % 28 + 1).padStart(2, '0')}`,
    object_id: 'obj-t', objects: { name: 'ЖК «Тёплый стан», корпус 2' }, tender_id: 'tender-1', tenders: { public_tender_number: 100 + n },
    sort_order: n * 10,
  })
}
window.__fakeDb.task_comments = []
window.__fakeDb.task_participants = []
window.__fakeDb.task_audit_log = []

// ── «Отчёты → Заявки на ДС» (?route=/reports&dcStats=1) ──────────────────────────────────────────────────
// Пять заявок и одна удалённая: этапы, суммы, просрочка (срок — вчера), журнал смены статуса на «Завершено».
if (params.get('dcStats') === '1') {
  const day = (offset) => {
    const d = new Date()
    d.setDate(d.getDate() + offset)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const iso = (offset) => new Date(Date.now() + offset * 24 * 3600 * 1000).toISOString()
  const objA = { id: 'obj-1', name: 'ЖК Альфа', status: 'main_construction' }
  const objB = { id: 'obj-2', name: 'ЖК Бета', status: 'warranty_service' }
  const base = (id, over) => ({
    id, object_id: objA.id, objects: objA, counterparty_id: 'cp-1', counterparties: { id: 'cp-1', name: 'Подрядчик 01' },
    responsible_contact_id: 'c-1', responsible: { id: 'c-1', full_name: 'Юристов Ю. Ю.' }, ds_number: `ДС-${id}`,
    status: 'in_work', check_status: 'not_checked', checked_at: null, ds_type: 'psdc_change', material_type: null,
    amount_before: null, amount_after: null, expected_approval_date: null, created_at: iso(-40), deleted_at: null,
    dc_request_tasks: [], ...over,
  })
  window.__fakeDb.dc_requests = [
    base('d1', { status: 'contract_check', created_at: iso(0), amount_before: 1000000, expected_approval_date: day(3) }),
    base('d2', { status: 'check_result', check_status: 'matches_with_remarks', checked_at: iso(-1), amount_before: 500000,
      expected_approval_date: day(-1), dc_request_tasks: [{ id: 't1', is_completed: false }, { id: 't2', is_completed: true }] }),
    base('d3', { object_id: objB.id, objects: objB, responsible_contact_id: null, responsible: null, check_status: 'matches',
      checked_at: iso(-30), ds_type: 'extra_out_contract', material_type: 'tolling' }),
    base('d4', { status: 'completed', check_status: 'matches', checked_at: iso(-35), amount_before: 2000000, amount_after: 1800000 }),
    base('d5', { status: 'completed', check_status: 'not_matches', checked_at: iso(-200), created_at: iso(-210), amount_after: 300000 }),
    base('d6', { deleted_at: iso(-5), amount_before: 999999999 }),
  ]
  // ?dcMany=N — ещё N заявок постарше (каждая третья — по «ЖК Бета», каждая четвёртая — «Подрядчика 02»): реестр
  // длиннее экрана, есть что прокручивать и фильтровать.
  for (let i = 1; i <= Number(params.get('dcMany') || 0); i++) {
    window.__fakeDb.dc_requests.push(base(`m${i}`, {
      created_at: new Date(Date.now() - (300 - i / 100) * 24 * 3600 * 1000).toISOString(),
      ...(i % 3 === 0 ? { object_id: objB.id, objects: objB } : {}),
      ...(i % 4 === 0 ? { counterparty_id: 'cp-2', counterparties: { id: 'cp-2', name: 'Подрядчик 02' } } : {}),
    }))
  }
  // ?dcNumbers=1 — постоянные номера заявок из базы (миграция 20261106), не по порядку создания.
  if (params.get('dcNumbers') === '1') {
    const numbers = { d1: 17, d2: 12, d3: 14, d4: 15, d5: 11, d6: 16 }
    for (const r of window.__fakeDb.dc_requests) r.request_number = numbers[r.id]
  }
  // ?dcSubmission=1 — колонки «Статуса ОКС» (миграция 20261108): у всех «Не проверено», у d2 — «Подано заказчику» с
  // письмом и подписью. Подмена триггера базы: «кто и когда» — при смене проверки, ФИО — из user_roles (не со страницы).
  if (params.get('dcSubmission') === '1') {
    for (const r of window.__fakeDb.dc_requests) {
      Object.assign(r, { submission_check: 'not_checked', submission_comment: null, submission_by_name: null, submission_at: null })
    }
    Object.assign(window.__fakeDb.dc_requests.find((r) => r.id === 'd2'), {
      submission_check: 'submitted', submission_comment: 'Письмо № 123', submission_by_name: 'Юристов Юрий Юрьевич', submission_at: iso(-1),
    })
    window.__fakeTriggers = { ...(window.__fakeTriggers || {}), dc_requests: (row, old) => {
      if (old && row.submission_check === old.submission_check) {
        Object.assign(row, { submission_by_name: old.submission_by_name, submission_at: old.submission_at })
      } else if (old || row.submission_check !== 'not_checked') {
        Object.assign(row, { submission_by_name: 'Сметчикова Анна Петровна', submission_at: new Date().toISOString() })
      }
    } }
  }
  // ?dcContracts=1 — договор, ДС и подразделение заявок (миграция 20261109): у «Подрядчика 01» по «ЖК Альфа» один
  // договор П-15/26 (с ДС №3), по «ЖК Бета» — два; договор другого подрядчика не предлагается. d2 — договор выбран,
  // в ДС не отмечена (её «ДС-3» совпадает с ДС №3 договора); d4 — занесена в ДС №3; у d1 и d3 — подразделения.
  if (params.get('dcContracts') === '1') {
    const fdb = window.__fakeDb
    const k = (id, over) => ({ id, display_id: 900 + fdb.contracts.length, record_type: 'dp', deleted_at: null, status: 'completed',
      counterparty_id: 'cp-1', object_id: objA.id, contract_number: null, contract_date: null, parent_contract_id: null,
      root_contract_id: null, signed_date: null, ...over })
    fdb.contracts.push(
      k('kd-1', { contract_number: 'П-15/26', contract_date: '2026-03-02' }),
      k('kd-1-ds3', { record_type: 'ds_extra', contract_number: 'ДС №3', contract_date: '2026-05-10', parent_contract_id: 'kd-1', root_contract_id: 'kd-1' }),
      k('kd-2', { object_id: objB.id, contract_number: 'Г-7', contract_date: '2025-11-20', status: 'in_work' }),
      k('kd-3', { object_id: objB.id, contract_number: 'Г-8', contract_date: '2026-01-15' }),
      k('kd-x', { counterparty_id: 'cp-2', contract_number: 'ЧУЖОЙ-9', contract_date: '2026-02-01' }),
    )
    for (const r of fdb.dc_requests) Object.assign(r, { contract_id: null, amendment_id: null, division: null })
    Object.assign(fdb.dc_requests.find((r) => r.id === 'd1'), { division: 'monolith' })
    Object.assign(fdb.dc_requests.find((r) => r.id === 'd2'), { contract_id: 'kd-1', ds_number: 'ДС-3' })
    Object.assign(fdb.dc_requests.find((r) => r.id === 'd3'), { division: 'electrical' })
    Object.assign(fdb.dc_requests.find((r) => r.id === 'd4'), { contract_id: 'kd-1', amendment_id: 'kd-1-ds3', ds_number: 'ДС №3' })
  }
  window.__fakeDb.dc_request_audit_log = [
    { id: 'al-1', dc_request_id: 'd4', event_type: 'status_changed', new_value: 'completed', changed_at: iso(-2) },
  ]
  // Файлы заявок: у d2 — рабочие (PDF и docx) и отчёт по документам, у d4 — итоговый, у удалённой d6 — рабочий.
  const dcDoc = (id, ownerId, fileName, over) => ({
    id, owner_type: 'dc_request', owner_id: ownerId, doc_category: 'general', file_name: fileName,
    s3_key: `dc_requests/${ownerId}/${id}-${fileName}`, mime_type: 'application/pdf', size_bytes: 2048,
    uploaded_by_name: 'Юристов Ю. Ю.', notes: null, created_at: iso(-3), ...over,
  })
  window.__fakeDb.s3_documents.push(
    dcDoc('dcf-1', 'd2', 'Было-стало.pdf', { notes: 'Расчёт было-стало' }),
    dcDoc('dcf-2', 'd2', 'Письмо.docx', { created_at: iso(-2),
      mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    dcDoc('dcf-3', 'd2', 'Отчёт.pdf', { doc_category: 'check_report' }),
    dcDoc('dcf-4', 'd4', 'ДС подписанное.pdf', { doc_category: 'final' }),
    dcDoc('dcf-5', 'd6', 'Черновик.pdf'),
  )
  // ?dcOldFiles=N — ещё N старых файлов заявки, которой нет в реестре (архив): с ?maxRows=1000 файлы выше —
  // самые новые — оказываются за тысячной строкой, как на проде 27.10.2026.
  for (let i = 1; i <= Number(params.get('dcOldFiles') || 0); i++) {
    window.__fakeDb.s3_documents.push(dcDoc(`dco-${i}`, 'd-archive', `Архив ${i}.pdf`, {
      created_at: new Date(Date.now() - (90 - i / 1000) * 24 * 3600 * 1000).toISOString(),
    }))
  }
  window.__fakeFiles = { ...(window.__fakeFiles || {}),
    'dc_requests/d2/dcf-1-Было-стало.pdf': 'data:application/pdf;base64,JVBERi0xLjQKJSVFT0YK',
    'dc_requests/d2/dcf-2-Письмо.docx': 'data:application/octet-stream;base64,UEsDBA==',
  }
}

// ?contracts=N — реестр «Договоры и ДС» (route=/contracts): N договоров, у каждого третьего — ДС, у каждого седьмого —
// понятийное соглашение (s3_documents, doc_category='concept_agreement'). &contractsMixed=1 — каждый второй договор
// с ДС «Завершено», его ДС — «В работе» (вкладки и счётчики «Договоров и ДС»).
const CONTRACTS = Number(params.get('contracts') || 0)
const CONTRACTS_MIXED = params.get('contractsMixed') === '1'
if (CONTRACTS > 0) {
  const contracts = []
  for (let i = 0; i < CONTRACTS; i++) {
    const obj = objects[i % objects.length]
    const cp = { id: `cp-${(i % CPS) + 1}`, name: `Подрядчик ${String((i % CPS) + 1).padStart(2, '0')}`, inn: '123456789012' }
    const parent = i % 3 === 2 ? contracts[i - 1] : null
    contracts.push({
      id: `ctr-${i + 1}`, display_id: i + 1, contract_number: `${i + 1}/26`, contract_date: '2026-09-01',
      status: CONTRACTS_MIXED && i % 6 === 1 ? 'completed' : 'in_work',
      record_type: parent ? 'change' : 'dp', parent_contract_id: parent?.id || null,
      root_contract_id: parent?.id || null, object_id: obj.id, objects: { name: obj.name, status: obj.status },
      counterparty_id: cp.id, counterparties: cp, contract_counterparties: [{ counterparty_id: cp.id, sort_order: 0, counterparties: cp }],
      tenders: null, responsible: null, work_name: `Работы ${i + 1}`, contract_amount: 1000000 + i, currency: 'RUB',
      created_at: new Date(Date.UTC(2026, 8, 1) + i * 60000).toISOString(), deleted_at: null, handled_by_us: true,
    })
  }
  window.__fakeDb.contracts = contracts
  window.__fakeDb.contract_appendices = []
  window.__fakeDb.s3_documents.push(...contracts.filter((_, i) => i % 7 === 0).map((c) => ({
    id: `ca-${c.id}`, owner_type: 'contract', owner_id: c.id, doc_category: 'concept_agreement', file_name: `ПС ${c.contract_number}.pdf`,
    s3_key: `contracts/${c.id}/ps.pdf`, mime_type: 'application/pdf', size_bytes: 1000, created_at: '2026-09-02T10:00:00Z',
  })))
}

// ── «Проверка КП» (?route=/kp-review&kpReview=1) ─────────────────────────────────────────────────────────
// Шесть тендеров всех направлений, в каждом 1–4 КП, все семь этапов проверки. У тендера «Благоустройство двора»
// нет номера и направления — отдел берётся по статусу объекта. План затрат: ссылка, «Завершён» без ссылки, стадии.
// Встраивания (s3, counterparties, tenders) лежат в строках, файлы КП — в хранилище стенда (window.__fakeFiles).
// kpReviewMany=N — ещё N КП на N/4 тендерах (длинный список, виртуализация).
// kpRole: super — суперпользователь (ручная установка этапа), engineer — инженер (отметки, без проверки),
// viewer — без прав (только просмотр); без параметра — администратор стенда.
if (params.get('kpReview') === '1') {
  const fdb = window.__fakeDb
  const person = (fullName) => (fullName ? { full_name: fullName } : null)
  const objNorth = { name: 'ЖК «Северный квартал»', status: 'main_construction' }
  const objNurly = { name: 'Бизнес-центр «Нурлы»', status: 'warranty_service' }
  const tender = (id, fields) => ({
    id, object_id: 'obj-1', objects: objNorth, folder_path: null, cost_plan_link: null, cost_plan_status: null,
    responsible_contact: null, cost_plan_responsible: null, ...fields,
  })
  const kt = {
    1: tender('kt-1', { public_tender_number: 412, department: 'construction',
      work_description: 'Устройство кровли корпуса 2 с утеплением и организованным водостоком',
      folder_path: '\\\\su10-fs\\Тендеры\\ЖК Северный квартал\\412 Кровля',
      cost_plan_link: 'https://docs.example.ru/plans/412', cost_plan_status: 'in_progress',
      responsible_contact: person('Архипов Антон Михайлович'), cost_plan_responsible: person('Крюкова Юлия Денисовна') }),
    2: tender('kt-2', { public_tender_number: 415, department: 'warranty', object_id: 'obj-2', objects: objNurly,
      work_description: 'Ремонт примыканий фасада по гарантийному обращению', cost_plan_status: 'completed',
      responsible_contact: person('Сейткали Айгерим Нурлановна') }),
    3: tender('kt-3', { public_tender_number: 420, department: 'joint',
      work_description: 'Наружные сети водоснабжения и канализации', folder_path: '\\\\su10-fs\\Тендеры\\Совместные\\420 НВК',
      cost_plan_status: 'awaiting_kp', responsible_contact: person('Архипов Антон Михайлович'),
      cost_plan_responsible: person('Крюкова Юлия Денисовна') }),
    4: tender('kt-4', { public_tender_number: 377, department: 'other', object_id: 'obj-2', objects: objNurly,
      work_description: 'Поставка и монтаж лифтового оборудования (6 лифтов), пусконаладка и сдача в Ростехнадзор',
      cost_plan_link: 'https://docs.example.ru/plans/377', cost_plan_status: 'completed',
      cost_plan_responsible: person('Крюкова Юлия Денисовна') }),
    5: tender('kt-5', { public_tender_number: null, department: null, work_description: 'Благоустройство двора',
      responsible_contact: person('Архипов Антон Михайлович') }),
    6: tender('kt-6', { public_tender_number: 431, department: 'construction',
      work_description: 'Выполнение комплекса работ по устройству внутренних инженерных систем отопления, вентиляции и кондиционирования воздуха в корпусах 1–3',
      folder_path: '\\\\su10-fs\\Тендеры\\ЖК Северный квартал\\431 ОВиК',
      cost_plan_link: 'https://docs.example.ru/plans/431', cost_plan_status: 'in_progress',
      responsible_contact: person('Крюкова Юлия Денисовна'), cost_plan_responsible: person('Архипов Антон Михайлович') }),
  }
  // Этап → поля (как STAGE_FIELDS в src/utils/kpReviewStages.js) с отметками «кто и когда».
  const reviewed = (by, at) => ({ reviewed_by: by, reviewed_at: at })
  const stage = {
    pending: () => ({ review_status: 'pending' }),
    ok_summary: (by, at) => ({ review_status: 'approved', ...reviewed(by, at) }),
    ok_done: (by, at) => ({ review_status: 'approved', ...reviewed(by, at),
      summary_added: true, summary_added_by: by, summary_added_at: at }),
    remarks_work: (by, at, note) => ({ review_status: 'has_remarks', review_note: note, ...reviewed(by, at) }),
    remarks_sent: (by, at, note) => ({ review_status: 'has_remarks', review_note: note, ...reviewed(by, at),
      summary_added: true, summary_added_by: 'Архипов Антон Михайлович', summary_added_at: at,
      remarks_sent: true, remarks_sent_by: 'Архипов Антон Михайлович', remarks_sent_at: at }),
    nosend_summary: (by, at, note) => ({ review_status: 'has_remarks', review_note: note, remarks_send_required: false, ...reviewed(by, at) }),
    nosend_done: (by, at, note) => ({ review_status: 'has_remarks', review_note: note, remarks_send_required: false,
      ...reviewed(by, at), summary_added: true, summary_added_by: by, summary_added_at: at }),
  }
  const files = {}
  const kp = (id, t, cpName, fileName, createdAt, fields = {}) => {
    const key = `tenders/${t.id}/${id}-${fileName}`
    files[key] = `data:application/octet-stream;base64,${btoa(unescape(encodeURIComponent(`КП ${id}`)))}`
    return {
      id, tender_id: t.id, counterparty_id: `kcp-${cpName}`, file_kind: 'commercial_proposal', review_required: true,
      version_label: null, created_at: createdAt, review_status: 'pending', review_note: null, reviewed_at: null, reviewed_by: null,
      remarks_send_required: true, remarks_sent: false, remarks_sent_at: null, remarks_sent_by: null,
      summary_added: false, summary_added_at: null, summary_added_by: null, review_note_s3: null,
      s3: { id: `s3-${id}`, s3_key: key, file_name: fileName, size_bytes: 1000, created_at: createdAt, uploaded_by_name: 'Архипов А. М.' },
      counterparties: { name: cpName }, tenders: t, ...fields,
    }
  }
  const longNote = 'Не учтены пароизоляция и примыкания к парапетам; расценки на утеплитель завышены на 18–25 % '
    + 'относительно рынка; нет разбивки на материалы и работы в разделе 3; срок действия КП истекает 30.10.2026.'
  const rows = [
    kp('kp-1', kt[1], 'ООО «Альфа-Кровля»', 'КП_Альфа-Кровля_кровля_корпус2_финал.xlsx', '2026-10-24T09:12:00Z'),
    kp('kp-2', kt[1], 'ТОО «СтройМонтаж-Инжиниринг Казахстан»', 'Коммерческое предложение СМИК от 23.10.2026 (с НДС).pdf',
      '2026-10-23T15:40:00Z', { ...stage.remarks_work('Петрова Анна Сергеевна', '2026-10-24T11:00:00Z', longNote),
        summary_added: true, summary_added_by: 'Крюкова Юлия Денисовна', summary_added_at: '2026-10-24T12:00:00Z',
        review_note_s3: { id: 's3-rem-2', s3_key: 'tenders/kt-1/rem-2.docx', file_name: 'Замечания к КП СМИК, кровля корпуса 2.docx' } }),
    kp('kp-3', kt[1], 'ИП Жумабеков Р. К.', 'КП.xlsx', '2026-10-22T11:05:00Z', stage.ok_summary('Петрова Анна Сергеевна', '2026-10-23T09:30:00Z')),
    kp('kp-4', kt[1], 'ООО «Альфа-Кровля»', 'КП_Альфа-Кровля_кровля_корпус2.xlsx', '2026-10-20T08:00:00Z', { version_label: 'исходное' }),
    kp('kp-5', kt[2], 'ООО «Фасад Сервис»', 'КП Фасад Сервис.xlsx', '2026-10-21T10:30:00Z',
      stage.nosend_summary('Смирнов Д. В.', '2026-10-22T10:00:00Z', 'Нет НДС в итоговой сумме.')),
    kp('kp-6', kt[2], 'ТОО «Аквастрой»', 'Аквастрой_КП_гарантия.xlsx', '2026-10-25T07:45:00Z'),
    kp('kp-7', kt[3], 'ТОО «Аквастрой»', 'КП НВК Аквастрой.xlsx', '2026-10-15T12:00:00Z',
      stage.remarks_sent('Петрова Анна Сергеевна', '2026-10-16T10:00:00Z', 'Пересчитать объёмы колодцев по ВОР ред. 2.')),
    kp('kp-8', kt[4], 'ООО «ЛифтТехМонтаж»', 'ЛТМ_КП_лифты_6шт.pdf', '2026-10-12T09:00:00Z', stage.ok_done('Смирнов Д. В.', '2026-10-13T09:00:00Z')),
    kp('kp-9', kt[4], 'ТОО «Отис-Сервис Центральная Азия»', 'КП лифты.xlsx', '2026-10-13T09:00:00Z',
      stage.ok_summary('Смирнов Д. В.', '2026-10-14T09:00:00Z')),
    kp('kp-10', kt[4], 'ООО «КМЗ Лифт»', 'КП_КМЗ.xlsx', '2026-10-14T09:00:00Z',
      stage.nosend_done('Петрова Анна Сергеевна', '2026-10-15T09:00:00Z', 'Срок поставки не согласован — уточнить на переговорах.')),
    kp('kp-11', kt[5], 'ИП Ахметов', 'КП благоустройство.xlsx', '2026-10-19T16:20:00Z'),
    kp('kp-12', kt[6], 'ТОО «Климат Про»', 'КП ОВиК Климат Про.xlsx', '2026-10-25T10:00:00Z'),
    kp('kp-13', kt[6], 'ООО «Термотехника»', 'Термотехника КП ОВиК корп1-3.xlsx', '2026-10-24T14:00:00Z', { version_label: 'после переторжки' }),
    kp('kp-14', kt[6], 'ООО «Термотехника»', 'Термотехника КП ОВиК.xlsx', '2026-10-18T14:00:00Z', {
      ...stage.remarks_work('analyst@example.invalid', '2026-10-19T10:00:00Z', 'Нет расценок на балансировку систем.'), version_label: 'исходное' }),
    kp('kp-15', kt[6], 'ТОО «ВентМонтаж»', 'ВМ_КП.xlsx', '2026-10-17T10:00:00Z', stage.ok_done('Смирнов Д. В.', '2026-10-18T10:00:00Z')),
  ]
  const many = Number(params.get('kpReviewMany') || 0)
  const depts = ['construction', 'warranty', 'other', 'joint']
  const stages = Object.keys(stage)
  for (let i = 0; i < many; i++) {
    const g = Math.floor(i / 4)
    const t = tender(`ktm-${g}`, { public_tender_number: 600 + g, department: depts[g % 4],
      work_description: `Тендер для длинного списка № ${600 + g}: отделочные работы секции ${g + 1}`,
      responsible_contact: person('Архипов Антон Михайлович') })
    const at = new Date(Date.UTC(2026, 8, 1) + i * 3600000).toISOString()
    rows.push(kp(`kpm-${i}`, t, `Подрядчик ${String((i % 9) + 1).padStart(2, '0')}`, `КП ${i}.xlsx`, at,
      stage[stages[i % stages.length]]('Смирнов Д. В.', at, 'Замечание')))
  }
  fdb.tender_proposal_files = rows
  window.__fakeFiles = { ...(window.__fakeFiles || {}), ...files }

  const role = params.get('kpRole')
  if (role) {
    window.__fakeRole = {
      role: role === 'super' ? 'admin' : role === 'engineer' ? 'engineer' : 'manager',
      isAdmin: role === 'super',
      isSuperAdmin: role === 'super',
      isEmployee: true,
      isContractor: false,
      isLoggedIn: true,
      canEdit: () => role !== 'viewer',
      user: { id: 'user-1', email: 'test@example.invalid' },
      canView: () => true,
      scopedObjectIds: [],
      userProfile: { full_name: 'Стендов Стенд Стендович' },
    }
  }
}

// ?dgpLegacy=1 — ДГП объекта стенда (/stand/dgp), загруженный, пока было два вида: категория dgp_compact,
// паспорт прежнего вида (notes v1: только заголовок и сумма), учтённые ДС — только в имени файла.
if (params.get('dgpLegacy') === '1') {
  window.__fakeDb.s3_documents.push({
    id: 'dgp-legacy', owner_type: 'object', owner_id: '11111111-1111-4111-8111-111111111111', doc_category: 'dgp_compact',
    file_name: 'Stories (ДС 1-10).xlsx', s3_key: 'objects/11111111-1111-4111-8111-111111111111/old-stories.xlsx',
    size_bytes: 2048, created_at: '2026-10-26T09:00:00Z', uploaded_by_name: 'Иванов И. И.',
    notes: JSON.stringify({ v: 1, title: 'ЕДИНЫЙ ПСДЦ · ЖК STORIES', subtitle: '', total: 5932993892.39,
      totalLabel: 'Актуальная цена договора', detected: true }),
  })
}
