// Данные стенда кабинета подрядчика (cabinet.html) и подделки функций базы миграции 20261102: тендеры кабинета,
// заявка, запись цен и анкеты, сводка администратора, решение инженера. Файл ВОР собирается здесь же (xlsx) и
// лежит в «хранилище» стенда (window.__fakeFiles) — кабинет скачивает и разбирает его как настоящий.
//   ?page=cabinet (по умолчанию) — кабинет подрядчика «ООО Альфа»; ?page=admin — реестр расценок, вкладка
//   «Расценки подрядчиков (актуальные тендеры)»; ?selfReg=1 — подрядчик, зарегистрировавшийся на сайте (позиции с сервера, файлов нет);
//   ?preview=1 — администратор смотрит кабинет от имени подрядчика: функции кабинета ему отказывают, данные — из таблиц;
//   ?legacyItems=1 — у тендера № 905 есть смета во вкладке «ВОР» (прежний путь: шаблон и загрузка КП).
import * as XLSX from 'xlsx'
import { readBidFileBytes } from '../../../src/utils/bidVor'

const params = new URLSearchParams(window.location.search)
const PAGE = params.get('page') || 'cabinet'
const SELF_REGISTERED = params.get('selfReg') === '1'
const PREVIEW = params.get('preview') === '1'
const CP = { id: 'cp-alpha', name: 'ООО Альфа', ...(SELF_REGISTERED ? { selfRegistered: true } : {}) }

window.__fakeRole = PAGE === 'admin'
  ? {
      role: 'admin', isAdmin: true, isSuperAdmin: false, isEmployee: true, isContractor: false, isLoggedIn: true,
      canEdit: () => true, canView: () => true, user: { id: 'admin-1' }, scopedObjectIds: [], userProfile: { full_name: 'Админов' },
    }
  : {
      role: 'contractor', isAdmin: false, isSuperAdmin: false, isEmployee: false, isContractor: true, isLoggedIn: true,
      canEdit: () => false, canView: () => false, user: { id: 'contractor-1' }, scopedObjectIds: [],
      userProfile: { full_name: 'Альфин А. А.' }, contractorInfo: CP, logout: async () => {}, previewActive: PREVIEW,
    }

function vorBook() {
  const wb = XLSX.utils.book_new()
  const add = (name, aoa) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
  add('Главный лист', [
    ['', 'Особые условия, которые необходимо учесть'],
    ['', 'ГУ в размере 5 % (Пять процентов)'],
    ['', 'Гарантия на материалы/оборудование 60 мес.'],
    [],
    ['Квалификационная и контактная информация (обязательно к заполнению)'],
    [1, 'Наименование контрагента', ''],
  ])
  add('Материалы', [
    ['№ п/п', 'Наименование', 'Ед. изм.', 'Объём', 'Цена за ед. с доставкой и НДС', 'Итого'],
    [1, 'Бетон В25 W8', 'м3', 130.5, '', ''],
    [2, 'Арматура А500С d12', 'т', 3.25, '', ''],
  ])
  add('Работы', [
    ['№ п/п', 'Наименование', 'Ед. изм.', 'Объём', 'Цена за ед. с НДС', 'Итого'],
    [1, 'Устройство монолитной плиты', 'м3', 130.5, '', ''],
    [2, 'Армирование плиты', 'т', 3.25, '', ''],
  ])
  add('КП', [
    ['№ п/п', 'КОД', 'Наименование затрат', 'Примечание', 'Ед. изм.', 'Объем по виду работ', 'Общий расход по материалу'],
    ['', '', 'Монолитные работы', '', '', '', ''],
    ['1', '', 'Плита паркинга', '', '', '', ''],
    ['1.1', 'Р', 'Устройство монолитной плиты', '', 'м3', 120.5, ''],
    ['', 'мат.', 'Бетон В25 W8', '', 'м3', 120.5, 120.5],
    ['1.2', 'Р', 'Армирование плиты', '', 'т', 3.25, ''],
    ['', 'мат.', 'Арматура А500С d12', '', 'т', 3.25, 3.25],
    ['2', '', 'Приямки', '', '', '', ''],
    ['2.1', 'Р', 'Устройство монолитной плиты', '', 'м3', 10, ''],
    ['', 'мат.', 'Бетон В25 W8', '', 'м3', 10, 10],
    ['', '', 'ИТОГО', '', '', '', ''],
  ])
  const b64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' })
  return `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${b64}`
}

window.__fakeFiles = { 'tenders/t-open/vor.xlsx': vorBook(), 'tenders/t-inv/vor.xlsx': vorBook() }

const db = window.__fakeDb = {
  s3_documents: [
    { id: 'doc-vor', owner_type: 'tender', owner_id: 't-open', doc_category: 'vor_statement', file_name: 'ВОР паркинга.xlsx', s3_key: 'tenders/t-open/vor.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size_bytes: 9000, created_at: '2026-10-20T10:00:00Z' },
    { id: 'doc-inv', owner_type: 'tender', owner_id: 't-inv', doc_category: 'vor_statement', file_name: 'ВОР фасада.xlsx', s3_key: 'tenders/t-inv/vor.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size_bytes: 9000, created_at: '2026-10-20T10:00:00Z' },
  ],
  tender_counterparties: [],
  tender_estimate_items: [],
  tender_counterparty_proposals: [],
  contracts: [],
  contract_counterparties: [],
  tender_bid_requests: [],
  tender_bid_rates: [],
  tender_bid_forms: [],
  bid_form_fields: [
    { id: 'f-name', label: 'Наименование контрагента', hint: null, kind: 'text', options: null, code: null, sort_order: 10, is_active: true, created_at: '2026-10-23T00:00:00Z' },
    { id: 'f-vat', label: 'Ставка НДС', hint: 'выберите из списка', kind: 'select', options: ['22 %', '7 %', '5 %', '0 %'], code: 'vat', sort_order: 20, is_active: true, created_at: '2026-10-23T00:00:00Z' },
    { id: 'f-old', label: 'Скрытое поле', hint: null, kind: 'text', options: null, code: null, sort_order: 30, is_active: false, created_at: '2026-10-23T00:00:00Z' },
  ],
}

const TENDERS = [
  { id: 't-open', public_tender_number: 857, work_description: 'Бетонные полы паркинга', tender_status: 'Идет тендерная процедура', is_open: true,
    object_name: 'ЖК Primavera к14', object_address: 'Москва', responsible_name: 'Иванов Иван Иванович', responsible_phone: '+7 701 000-00-00',
    tender_start_date: '2026-10-20', tender_end_date: '2026-11-30', start_date: null, end_date: null, tender_package_link: 'https://disk.example.ru/pack' },
  { id: 't-mine', public_tender_number: 704, work_description: 'Слаботочные системы', tender_status: 'Подведение итогов', is_open: false,
    object_name: 'ЖК Примавера', object_address: 'Москва', responsible_name: 'Петров П. П.', responsible_phone: null,
    tender_start_date: null, tender_end_date: '2026-10-01', start_date: null, end_date: null, tender_package_link: null, invite: 'proposal_provided' },
  { id: 't-inv', public_tender_number: 905, work_description: 'Фасадные работы', tender_status: 'Идет тендерная процедура', is_open: true,
    object_name: 'ЖК Примавера', object_address: 'Москва', responsible_name: 'Петров П. П.', responsible_phone: null,
    tender_start_date: null, tender_end_date: '2026-12-01', start_date: null, end_date: null, tender_package_link: null, invite: 'request_sent' },
  // Организация отказалась: тендер идёт, но кабинет его не показывает.
  { id: 't-decl', public_tender_number: 910, work_description: 'Кровля', tender_status: 'Идет тендерная процедура', is_open: true,
    object_name: 'ЖК Примавера', object_address: 'Москва', responsible_name: 'Петров П. П.', responsible_phone: null,
    tender_start_date: null, tender_end_date: '2026-12-01', start_date: null, end_date: null, tender_package_link: null, invite: 'declined' },
  // Срок прошёл, статус тот же: тендер идёт, это не просрочка.
  { id: 't-late', public_tender_number: 911, work_description: 'Благоустройство', tender_status: 'Идет тендерная процедура', is_open: true,
    object_name: 'ЖК Примавера', object_address: 'Москва', responsible_name: 'Сидоров С. С.', responsible_phone: '+7 701 000-00-01',
    tender_start_date: '2020-01-01', tender_end_date: '2020-01-15', start_date: null, end_date: null, tender_package_link: 'https://disk.example.ru/late' },
]

// Те же сведения таблицами: их читает просмотр от имени подрядчика (встраивания стенд не разбирает — поля уже в строке).
db.tenders = [
  ...TENDERS.map((t) => ({
    id: t.id, public_tender_number: t.public_tender_number, work_description: t.work_description, status: t.tender_status, tender_type: 'main',
    deleted_at: null, tender_start_date: t.tender_start_date, tender_end_date: t.tender_end_date, start_date: t.start_date, end_date: t.end_date,
    tender_package_link: t.tender_package_link, custom_object_name: null,
    objects: { name: t.object_name, address: t.object_address, status: 'main_construction' },
    responsible: { full_name: t.responsible_name, phone: t.responsible_phone },
  })),
  // «Прочее»: тендер без объекта — кабинет его не показывает, как bid_tender_open.
  { id: 't-other', public_tender_number: 950, work_description: 'Прочее', status: 'Идет тендерная процедура', tender_type: 'main', deleted_at: null, objects: null, responsible: null },
  // Удалённый и тендер на материалы — тоже нет.
  { id: 't-gone', public_tender_number: 951, work_description: 'Удалённый', status: 'Идет тендерная процедура', tender_type: 'main', deleted_at: '2026-10-01T00:00:00Z', objects: { name: 'ЖК', address: null, status: 'main_construction' }, responsible: null },
  { id: 't-mat', public_tender_number: 952, work_description: 'На материалы', status: 'Идет тендерная процедура', tender_type: 'materials', deleted_at: null, objects: { name: 'ЖК', address: null, status: 'main_construction' }, responsible: null },
]
db.tender_counterparties = TENDERS.filter((t) => t.invite).map((t) => ({ id: `tc-${t.id}`, tender_id: t.id, counterparty_id: CP.id, status: t.invite }))
  .concat({ id: 'tc-foreign', tender_id: 't-open', counterparty_id: 'cp-beta', status: 'proposal_provided' })
db.counterparties = [{ id: CP.id, name: CP.name, inn: '7707083893', kpp: '770701001', legal_address: 'Москва, ул. Строителей, 1', actual_address: null,
  website: null, work_type: 'Монолитные работы', status: 'active', notes: 'служебное примечание', counterparty_number: 1234, vat_rate: 22, vat_exempt: false }]
const CONTACT_PERSONS = [
  { id: 'cc-1', counterparty_id: CP.id, full_name: 'Директоров Д. Д.', position: 'Директор', phone: '+7 916 000-00-10', email: 'dir@alpha.ru', created_at: '2026-01-01T00:00:00Z' },
  { id: 'cc-2', counterparty_id: CP.id, full_name: 'Сметчикова С. С.', position: null, phone: null, email: 'smeta@alpha.ru', created_at: '2026-01-02T00:00:00Z' },
]
db.counterparty_contacts = CONTACT_PERSONS
if (params.get('legacyItems') === '1') {
  db.tender_estimate_items = [
    { id: 'ei-1', tender_id: 't-inv', row_number: 1, cost_name: 'Монтаж фасада', unit: 'м2', work_volume: 100, is_section: false, estimate_name: 'Основная смета' },
    { id: 'ei-2', tender_id: 't-inv', row_number: 2, cost_name: 'Утепление', unit: 'м2', work_volume: 100, is_section: false, estimate_name: 'Основная смета' },
  ]
}

const keyOf = (r) => `${r.kind}|${r.item_key}|${r.unit_key || ''}`
const ok = (data) => ({ data, error: null })

window.__bidCalls = []
window.__fakeRpc = {
  // Как функция базы: позиции — только при доступе к тендеру; файл, который служба ещё не разобрала, — pending.
  bid_positions: ({ p_tender }) => {
    window.__bidCalls.push({ fn: 'bid_positions', p_tender })
    const t = TENDERS.find((x) => x.id === p_tender)
    const access = t?.invite ? 'invited' : db.tender_bid_requests.find((r) => r.tender_id === p_tender)?.status
    if (!access) return { data: null, error: { code: '42501', message: 'Сначала подайте заявку на участие в этом тендере' } }
    if (p_tender === 't-inv') return ok([{ file_id: 'doc-wait', title: 'ВОР фасада', status: 'pending', error: null, positions: [], structure: [], conditions: [] }])
    if (p_tender !== 't-open') return ok([])
    const bytes = Uint8Array.from(atob(window.__fakeFiles['tenders/t-open/vor.xlsx'].split(',')[1]), (c) => c.charCodeAt(0))
    const parsed = readBidFileBytes(bytes)
    return ok([{ file_id: 'doc-vor', title: 'ВОР паркинга', status: 'ok', error: null,
      positions: [...parsed.materials, ...parsed.works], structure: parsed.structure, conditions: parsed.conditions }])
  },
  contractor_org_card: () => ok([{ name: 'ООО Альфа', inn: '7707083893', kpp: '770701001', legal_address: 'Москва, ул. Строителей, 1', actual_address: null,
    website: null, work_type: 'Монолитные работы', contact_name: 'Альфин А. А.', contact_phone: '+79161234567', contact_email: 'alfin@alpha.ru',
    counterparty_number: 1234, vat_rate: 22, vat_exempt: false, contacts: CONTACT_PERSONS.map(({ id, full_name, position, phone, email }) => ({ id, full_name, position, phone, email })) }]),
  contractor_contracts: () => ok([{
    id: 'c-1', display_id: 15, contract_number: 'ДП-15', contract_date: '2026-09-01', work_name: 'Монолит паркинга',
    status: 'signed', contract_amount: 1000000, currency: 'RUB', object_name: 'ЖК Primavera к14',
  }]),
  contractor_set_participation: ({ p_tender, p_status }) => {
    window.__bidCalls.push({ fn: 'contractor_set_participation', p_tender, p_status })
    TENDERS.find((t) => t.id === p_tender).invite = p_status
    return ok(null)
  },
  // Как функция базы: учётке с регистрации — только идущие тендеры.
  bid_contractor_tenders: () => ok(TENDERS.filter((t) => !SELF_REGISTERED || t.is_open).map((t) => {
    const req = db.tender_bid_requests.find((r) => r.tender_id === t.id && r.counterparty_id === CP.id)
    const rates = db.tender_bid_rates.filter((r) => r.tender_id === t.id && r.price != null)
    return {
      ...t, invite_status: t.invite || null, request_status: req?.status || null,
      access: t.invite ? 'invited' : (req?.status || null),
      priced_count: rates.length, priced_total: rates.reduce((s, r) => s + Number(r.total || 0), 0), priced_at: null,
    }
  })),
  bid_request: ({ p_tender }) => {
    window.__bidCalls.push({ fn: 'bid_request', p_tender })
    if (!db.tender_bid_requests.some((r) => r.tender_id === p_tender)) {
      db.tender_bid_requests.push({ id: `req-${p_tender}`, tender_id: p_tender, counterparty_id: CP.id, status: 'pending', requested_at: new Date().toISOString() })
    }
    return ok('pending')
  },
  bid_rates_save: ({ p_tender, p_rows }) => {
    window.__bidCalls.push({ fn: 'bid_rates_save', p_tender, rows: p_rows })
    for (const r of p_rows) {
      const row = { tender_id: p_tender, counterparty_id: CP.id, kind: r.kind, item_key: r.key, unit_key: r.unit_key || '' }
      const i = db.tender_bid_rates.findIndex((x) => x.tender_id === p_tender && keyOf(x) === keyOf(row))
      if (r.price == null && !r.note) { if (i >= 0) db.tender_bid_rates.splice(i, 1); continue }
      const full = {
        ...row, id: i >= 0 ? db.tender_bid_rates[i].id : crypto.randomUUID(), name: r.name, unit: r.unit, volume: r.volume, price: r.price,
        total: r.price == null ? null : Math.round(r.price * (r.volume || 0) * 100) / 100, note: r.note, source: r.source, updated_at: new Date().toISOString(),
      }
      if (i >= 0) db.tender_bid_rates[i] = full; else db.tender_bid_rates.push(full)
    }
    return ok(p_rows.length)
  },
  bid_form_save: ({ p_tender, p_answers }) => {
    window.__bidCalls.push({ fn: 'bid_form_save', p_tender, answers: p_answers })
    let form = db.tender_bid_forms.find((f) => f.tender_id === p_tender)
    if (!form) { form = { id: crypto.randomUUID(), tender_id: p_tender, counterparty_id: CP.id, answers: {} }; db.tender_bid_forms.push(form) }
    for (const [k, v] of Object.entries(p_answers)) {
      const f = db.bid_form_fields.find((x) => x.id === k)
      if (!f) continue
      if (!String(v).trim()) delete form.answers[k]
      else form.answers[k] = { label: f.label, value: String(v).trim() }
    }
    form.updated_at = new Date().toISOString()
    return ok(form.answers)
  },
  bid_admin_overview: () => ok([
    { tender_id: 't-open', public_tender_number: 857, work_description: 'Бетонные полы паркинга', tender_status: 'Идет тендерная процедура', is_open: true,
      object_name: 'ЖК Primavera к14', tender_end_date: '2026-11-30', counterparty_id: CP.id, counterparty_name: CP.name, counterparty_inn: '7700000001',
      invite_status: null, request_id: 'req-t-open', request_status: 'pending', requested_at: '2026-10-23T08:00:00Z',
      materials_priced: 1, works_priced: 1, materials_total: 1017900, works_total: 326250, total: 1344150, notes_count: 0, form_answers: 1,
      vat: '22 %', updated_at: '2026-10-23T09:00:00Z' },
    // Завершённый тендер — его цены уже в реестре КП, во вкладке актуальных не показывается.
    { tender_id: 't-done', public_tender_number: 600, work_description: 'Кровля', tender_status: 'Завершен', is_open: false,
      object_name: 'ЖК Старый', tender_end_date: '2026-09-01', counterparty_id: 'cp-beta', counterparty_name: 'ООО Бета (завершён)', counterparty_inn: null,
      invite_status: 'proposal_provided', request_id: null, request_status: null, requested_at: null,
      materials_priced: 3, works_priced: 0, materials_total: 1000, works_total: 0, total: 1000, notes_count: 0, form_answers: 0,
      vat: null, updated_at: '2026-09-01T09:00:00Z' },
  ]),
}

// Просмотр от имени подрядчика: запросы идут под администратором, у него нет организации — функции кабинета отказывают, как в базе.
if (PREVIEW) {
  const refused = (text) => () => ({ data: null, error: { code: '42501', message: text } })
  const record = (fn, text) => (args) => { window.__bidCalls.push({ fn, ...args }); return refused(text)() }
  Object.assign(window.__fakeRpc, {
    bid_contractor_tenders: refused('Список тендеров кабинета — только для подрядчика'),
    contractor_org_card: () => ok([]),
    bid_request: record('bid_request', 'Заявку подаёт подрядчик'),
    bid_rates_save: record('bid_rates_save', 'Цены вводит подрядчик'),
    bid_form_save: record('bid_form_save', 'Анкету заполняет подрядчик'),
    contractor_set_participation: record('contractor_set_participation', 'Отметку участия ставит подрядчик'),
  })
  // Администратору правило показывает цены и анкеты всех организаций тендера: чужая цена не должна попасть в просмотр.
  const concrete = readBidFileBytes(Uint8Array.from(atob(window.__fakeFiles['tenders/t-open/vor.xlsx'].split(',')[1]), (c) => c.charCodeAt(0))).materials[0]
  db.tender_bid_rates.push({ id: 'r-foreign', tender_id: 't-open', counterparty_id: 'cp-beta', kind: 'material', item_key: concrete.itemKey, unit_key: concrete.unitKey,
    name: concrete.name, unit: concrete.unit, volume: concrete.volume, price: 999, total: 130000, note: null, source: 'manual', updated_at: '2026-10-23T09:00:00Z' })
  db.tender_bid_forms.push({ id: 'form-foreign', tender_id: 't-open', counterparty_id: 'cp-beta', answers: { 'f-vat': { label: 'Ставка НДС', value: '22 %' } }, updated_at: '2026-10-23T09:00:00Z' })
}

if (PAGE === 'admin') {
  db.tender_bid_rates.push(
    { id: 'r1', tender_id: 't-open', counterparty_id: CP.id, kind: 'material', item_key: 'x', unit_key: 'м3', name: 'Бетон В25 W8', unit: 'м3', volume: 130.5, price: 7800, total: 1017900, note: null, source: 'import', updated_at: '2026-10-23T09:00:00Z',
      tenders: { public_tender_number: 857, work_description: 'Бетонные полы паркинга', status: 'Идет тендерная процедура' }, counterparties: { name: CP.name } },
    { id: 'r2', tender_id: 't-open', counterparty_id: CP.id, kind: 'work', item_key: 'y', unit_key: 'м3', name: 'Устройство монолитной плиты', unit: 'м3', volume: 130.5, price: 2500, total: 326250, note: 'с опалубкой', source: 'manual', updated_at: '2026-10-23T09:00:00Z',
      tenders: { public_tender_number: 857, work_description: 'Бетонные полы паркинга', status: 'Идет тендерная процедура' }, counterparties: { name: CP.name } },
  )
  db.tender_bid_forms.push({ id: 'form-1', tender_id: 't-open', counterparty_id: CP.id, answers: { 'f-name': { label: 'Наименование контрагента', value: 'ООО Альфа' } } })
}
