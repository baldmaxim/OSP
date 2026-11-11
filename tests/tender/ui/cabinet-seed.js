// Данные стенда кабинета подрядчика (cabinet.html) и подделки функций базы миграции 20261102: тендеры кабинета,
// заявка, запись цен и анкеты, сводка администратора, решение инженера. Файл ВОР собирается здесь же (xlsx) и
// лежит в «хранилище» стенда (window.__fakeFiles) — кабинет скачивает и разбирает его как настоящий.
//   ?page=cabinet (по умолчанию) — кабинет подрядчика «ООО Альфа»; ?page=admin — реестр расценок, вкладка
//   «Расценки подрядчиков (актуальные тендеры)»; ?selfReg=1 — подрядчик, зарегистрировавшийся на сайте (позиции с сервера, файлов нет);
//   ?preview=1 — администратор смотрит кабинет от имени подрядчика: функции кабинета ему отказывают, данные — из таблиц;
//   ?legacyItems=1 — у тендера № 905 есть смета во вкладке «ВОР» (прежний путь: шаблон и загрузка КП).
//   ?bidFiles=1 — миграция 20270113 применена: свой ВОР с расценками рядом с каждой ведомостью (расценка на сайте скрыта); у тендера
//   № 857 две ведомости (корпуса), в базе лежит и файл чужой организации — кабинет его не показывает. Маршрут /api/fn/bid-file
//   (и /api/admin/bid-file) подделан здесь: ключ — в каталоге организации, файл — в «хранилище» стенда. Без параметра таблицы файлов
//   нет (PGRST205) — кабинет показывает прежнюю расценку на сайте.
//   ?vorVersions=1 — миграция 20270114: у тендера № 857 есть прежняя версия «ВОР паркинга» (снабжение отметило её заменённой), к ней у
//   «ООО Альфа» лежит своя расценка; bid_vor_superseded отдаёт пару «прежняя → новая». Без параметра функции нет — все файлы.
//   ?formLinks=1 — миграция 20270115: поля анкеты о компании (название и НДС — из карточки, «Наличие СРО» — ответ на компанию),
//   таблица bid_company_answers и bid_company_save. Без параметра колонок и таблицы нет — анкета как раньше.
import * as XLSX from 'xlsx'
import { readBidFileBytes } from '../../../src/utils/bidVor'

const params = new URLSearchParams(window.location.search)
const PAGE = params.get('page') || 'cabinet'
const SELF_REGISTERED = params.get('selfReg') === '1'
const PREVIEW = params.get('preview') === '1'
const BID_FILES = params.get('bidFiles') === '1'
const VOR_VERSIONS = params.get('vorVersions') === '1'
const FORM_LINKS = params.get('formLinks') === '1'
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

window.__fakeFiles = { 'tenders/t-open/vor.xlsx': vorBook(), 'tenders/t-inv/vor.xlsx': vorBook(), 'tenders/t-open/vor2.xlsx': vorBook() }

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

if (FORM_LINKS) {
  // Как после 20270115: название и НДС — из карточки, «Наличие СРО» — ответ на компанию, «Посещение объекта» — по тендеру.
  Object.assign(db.bid_form_fields[0], { scope: 'company', source: 'name' })
  Object.assign(db.bid_form_fields[1], { scope: 'company', source: 'vat' })
  db.bid_form_fields[2].scope = 'tender'
  db.bid_form_fields.push(
    { id: 'f-sro', label: 'Наличие СРО', hint: 'да (сумма) / нет', kind: 'text', options: null, code: null, scope: 'company', source: null, sort_order: 40, is_active: true, created_at: '2026-10-23T00:00:00Z' },
    { id: 'f-site', label: 'Ссылка на сайт компании', hint: null, kind: 'text', options: null, code: null, scope: 'company', source: 'website', sort_order: 50, is_active: true, created_at: '2026-10-23T00:00:00Z' },
    { id: 'f-visit', label: 'Информация о посещении объекта', hint: null, kind: 'text', options: null, code: null, scope: 'tender', source: null, sort_order: 60, is_active: true, created_at: '2026-10-23T00:00:00Z' },
  )
  db.bid_company_answers = []
} else {
  window.__fakeErrors = { ...(window.__fakeErrors || {}), bid_company_answers: { code: 'PGRST205', message: "Could not find the table 'public.bid_company_answers' in the schema cache" } }
}

if (BID_FILES) {
  db.s3_documents.push(
    { id: 'doc-vor2', owner_type: 'tender', owner_id: 't-open', doc_category: 'vor_statement', file_name: 'ВОР корпус 2.xlsx', s3_key: 'tenders/t-open/vor2.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size_bytes: 9000, created_at: '2026-10-21T10:00:00Z' },
    { id: 'doc-pack', owner_type: 'tender', owner_id: 't-open', doc_category: 'tender_package', file_name: 'Тендерный пакет.zip', s3_key: 'tenders/t-open/pack.zip', mime_type: 'application/zip', size_bytes: 120000, created_at: '2026-10-20T09:00:00Z' },
    { id: 'doc-rd1', owner_type: 'tender', owner_id: 't-open', doc_category: 'rd', file_name: 'РД КЖ лист 1.pdf', s3_key: 'tenders/t-open/rd1.pdf', mime_type: 'application/pdf', size_bytes: 300000, created_at: '2026-10-20T09:00:00Z' },
    { id: 'doc-rd2', owner_type: 'tender', owner_id: 't-open', doc_category: 'vor', file_name: 'РД КЖ лист 2.pdf', s3_key: 'tenders/t-open/rd2.pdf', mime_type: 'application/pdf', size_bytes: 300000, created_at: '2026-10-20T09:00:00Z' },
  )
  // Файл чужой организации к той же ведомости: правило базы его не отдаёт, кабинет отбирает по своей организации.
  db.tender_bid_files = [{ id: 'bf-foreign', tender_id: 't-open', counterparty_id: 'cp-beta', vor_file_id: 'doc-vor', vor_name: 'ВОР паркинга',
    s3_key: 'bids/t-open/cp-beta/x-beta.xlsx', file_name: 'Бета расценка.xlsx', size_bytes: 5000, uploaded_by_name: 'Бета',
    summary: { v: 1, materials: 777, works: 0, total: 777, items: { material: 2, work: 2 }, priced: { material: 2, work: 0 } },
    created_at: '2026-10-25T10:00:00Z', updated_at: '2026-10-25T10:00:00Z' }]
  // Просмотр от имени подрядчика и сводка администратора: у «ООО Альфа» уже лежит свой ВОР к ведомости паркинга.
  if (PREVIEW || PAGE === 'admin') {
    const key = 'bids/t-open/cp-alpha/0-alpha.xlsx'
    window.__fakeFiles[key] = vorBook()
    db.tender_bid_files.push({ id: 'bf-alpha', tender_id: 't-open', counterparty_id: CP.id, vor_file_id: 'doc-vor', vor_name: 'ВОР паркинга',
      s3_key: key, file_name: 'Альфа — ВОР паркинга.xlsx', size_bytes: 9000, uploaded_by_name: 'Альфин А. А.',
      summary: { v: 1, materials: 1294150, works: 326250, total: 1620400, items: { material: 2, work: 2 }, priced: { material: 2, work: 1 } },
      created_at: '2026-10-26T10:00:00Z', updated_at: '2026-10-26T10:00:00Z' })
  }
} else {
  window.__fakeErrors = { ...(window.__fakeErrors || {}), tender_bid_files: { code: 'PGRST205', message: "Could not find the table 'public.tender_bid_files' in the schema cache" } }
}

// Прежняя версия ведомости паркинга (как тендер № 847: «ЗИЛ лот 33 ВОР ЭН» и «… версия 2»): файл лежит в тендере, снабжение отметило его
// заменённым. У «ООО Альфа» к нему своя расценка — кабинет показывает её у новой версии с просьбой загрузить заново.
if (VOR_VERSIONS) {
  window.__fakeFiles['tenders/t-open/vor-old.xlsx'] = vorBook()
  db.s3_documents.push({ id: 'doc-vor-old', owner_type: 'tender', owner_id: 't-open', doc_category: 'vor_statement', file_name: 'ВОР паркинга старая.xlsx',
    s3_key: 'tenders/t-open/vor-old.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size_bytes: 9000, created_at: '2026-10-10T10:00:00Z' })
  if (BID_FILES) {
    window.__fakeFiles['bids/t-open/cp-alpha/old-alpha.xlsx'] = vorBook()
    db.tender_bid_files.push({ id: 'bf-alpha-old', tender_id: 't-open', counterparty_id: CP.id, vor_file_id: 'doc-vor-old', vor_name: 'ВОР паркинга старая',
      s3_key: 'bids/t-open/cp-alpha/old-alpha.xlsx', file_name: 'Альфа — по старой ведомости.xlsx', size_bytes: 9000, uploaded_by_name: 'Альфин А. А.',
      summary: { v: 1, materials: 1000000, works: 0, total: 1000000, items: { material: 2, work: 2 }, priced: { material: 2, work: 0 } },
      created_at: '2026-10-12T10:00:00Z', updated_at: '2026-10-12T10:00:00Z' })
  }
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

// Как bid_vor_superseded (20270114): прежние версии ведомостей тендера и файл, который их заменил.
if (VOR_VERSIONS) {
  window.__fakeRpc.bid_vor_superseded = ({ p_tender }) => {
    window.__bidCalls.push({ fn: 'bid_vor_superseded', p_tender })
    return ok(p_tender === 't-open' ? [{ file_id: 'doc-vor-old', current_file_id: 'doc-vor' }] : [])
  }
}
// Как bid_company_save (20270115): ответы о компании и они же — в анкетах идущих тендеров, где организация может менять анкету.
if (FORM_LINKS) {
  window.__fakeRpc.bid_company_save = ({ p_answers }) => {
    window.__bidCalls.push({ fn: 'bid_company_save', answers: p_answers })
    let row = db.bid_company_answers.find((r) => r.counterparty_id === CP.id)
    if (!row) { row = { counterparty_id: CP.id, answers: {} }; db.bid_company_answers.push(row) }
    const set = {}
    const del = []
    for (const [k, v] of Object.entries(p_answers)) {
      const f = db.bid_form_fields.find((x) => x.id === k && (x.scope === 'company' || x.source))
      if (!f) continue
      if (!String(v).trim()) { delete row.answers[k]; del.push(k) } else { row.answers[k] = { label: f.label, value: String(v).trim() }; set[k] = row.answers[k] }
    }
    row.updated_at = new Date().toISOString()
    const canEdit = (tenderId) => {
      const t = TENDERS.find((x) => x.id === tenderId)
      const access = t?.invite && t.invite !== 'declined' ? 'invited' : db.tender_bid_requests.find((r) => r.tender_id === tenderId)?.status
      return !!t?.is_open && ['invited', 'pending', 'accepted'].includes(access)
    }
    for (const form of db.tender_bid_forms.filter((x) => x.counterparty_id === CP.id && canEdit(x.tender_id))) {
      for (const k of del) delete form.answers[k]
      Object.assign(form.answers, set)
    }
    window.__fakeTouch?.('bid_company_answers')
    return ok(row.answers)
  }
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
    bid_company_save: record('bid_company_save', 'Сведения о компании заполняет подрядчик'),
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

// ── Маршрут своего ВОР с расценками (/api/fn/bid-file, /api/admin/bid-file) — как служба с функциями базы bid_file_* ──────────
if (BID_FILES) {
  const realFetch = window.fetch.bind(window)
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const FAKE_S3 = 'https://fake-s3.invalid/'
  const accessOf = (tenderId) => {
    const t = TENDERS.find((x) => x.id === tenderId)
    if (!t?.is_open) return null
    return t.invite && t.invite !== 'declined' ? 'invited' : db.tender_bid_requests.find((r) => r.tender_id === tenderId)?.status || null
  }
  window.__bidFileCalls = []
  window.fetch = async (url, init = {}) => {
    const href = String(url?.url || url)
    const admin = href.endsWith('/api/admin/bid-file')
    if (!href.endsWith('/api/fn/bid-file') && !admin) return realFetch(url, init)
    const body = JSON.parse(init.body || '{}')
    window.__bidFileCalls.push({ admin, ...body })
    await new Promise((r) => setTimeout(r, 80))
    const action = admin ? 'download' : body.action
    if (PREVIEW && !admin) return json(403, { error: 'Файл с расценкой — только для подрядчика' })
    if (action === 'download') {
      const row = db.tender_bid_files.find((f) => f.id === body.file_id && (admin || f.counterparty_id === CP.id))
      if (!row) return json(404, { error: 'Файл не найден' })
      return json(200, { presigned_url: FAKE_S3 + row.s3_key, expires_in: 3600, file_name: row.file_name })
    }
    if (action === 'delete') {
      const i = db.tender_bid_files.findIndex((f) => f.id === body.file_id && f.counterparty_id === CP.id)
      if (i < 0) return json(200, { ok: true, already: true })
      const [row] = db.tender_bid_files.splice(i, 1)
      delete window.__fakeFiles[row.s3_key]
      window.__fakeTouch?.('tender_bid_files')
      return json(200, { ok: true })
    }
    const access = accessOf(body.tender_id)
    if (!access || access === 'rejected') return json(403, { error: 'Приём предложений по этому тендеру закрыт или заявка не подана' })
    const vorDoc = db.s3_documents.find((d) => d.id === body.vor_file_id && d.owner_id === body.tender_id && /\.xlsx?$/i.test(d.file_name))
    if (!vorDoc) return json(404, { error: 'Такой ведомости в тендере нет' })
    if (VOR_VERSIONS && body.vor_file_id === 'doc-vor-old') {
      return json(404, { error: 'Отдел заменил эту ведомость новой версией — обновите страницу и загрузите расценку к новой' })
    }
    const key = `bids/${body.tender_id}/${CP.id}/${body.operation_id}-${body.file_name}`
    if (action === 'upload') return json(200, { presigned_url: FAKE_S3 + key, expires_in: 900 })
    if (!window.__fakeFiles[key]) return json(409, { error: 'Файла ещё нет в хранилище — загрузка не завершилась', code: 'OSP_NOT_UPLOADED' })
    const now = new Date().toISOString()
    const vorName = vorDoc.file_name.replace(/\.(xlsx|xlsm|xls)$/i, '')
    const i = db.tender_bid_files.findIndex((f) => f.tender_id === body.tender_id && f.counterparty_id === CP.id && f.vor_file_id === body.vor_file_id)
    const row = { id: i >= 0 ? db.tender_bid_files[i].id : crypto.randomUUID(), tender_id: body.tender_id, counterparty_id: CP.id, vor_file_id: body.vor_file_id,
      vor_name: vorName, s3_key: key, file_name: body.file_name, size_bytes: body.size_bytes, summary: body.summary || {},
      uploaded_by_name: 'Альфин А. А.', created_at: i >= 0 ? db.tender_bid_files[i].created_at : now, updated_at: now }
    if (i >= 0) { delete window.__fakeFiles[db.tender_bid_files[i].s3_key]; db.tender_bid_files[i] = row } else db.tender_bid_files.push(row)
    window.__fakeTouch?.('tender_bid_files')
    return json(200, { ok: true, vor_name: vorName })
  }
}
