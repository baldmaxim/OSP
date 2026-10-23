// Данные стенда кабинета подрядчика (cabinet.html) и подделки функций базы миграции 20261102: тендеры кабинета,
// заявка, запись цен и анкеты, сводка администратора, решение инженера. Файл ВОР собирается здесь же (xlsx) и
// лежит в «хранилище» стенда (window.__fakeFiles) — кабинет скачивает и разбирает его как настоящий.
//   ?page=cabinet (по умолчанию) — кабинет подрядчика «ООО Альфа»; ?page=admin — реестр расценок, вкладка
//   «Расценки подрядчиков (актуальные тендеры)».
import * as XLSX from 'xlsx'

const params = new URLSearchParams(window.location.search)
const PAGE = params.get('page') || 'cabinet'
const CP = { id: 'cp-alpha', name: 'ООО Альфа' }

window.__fakeRole = PAGE === 'admin'
  ? {
      role: 'admin', isAdmin: true, isSuperAdmin: false, isEmployee: true, isContractor: false, isLoggedIn: true,
      canEdit: () => true, canView: () => true, user: { id: 'admin-1' }, scopedObjectIds: [], userProfile: { full_name: 'Админов' },
    }
  : {
      role: 'contractor', isAdmin: false, isSuperAdmin: false, isEmployee: false, isContractor: true, isLoggedIn: true,
      canEdit: () => false, canView: () => false, user: { id: 'contractor-1' }, scopedObjectIds: [],
      userProfile: { full_name: 'Альфин А. А.' }, contractorInfo: CP, logout: async () => {},
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

window.__fakeFiles = { 'tenders/t-open/vor.xlsx': vorBook() }

const db = window.__fakeDb = {
  s3_documents: [
    { id: 'doc-vor', owner_type: 'tender', owner_id: 't-open', doc_category: 'vor_statement', file_name: 'ВОР паркинга.xlsx', s3_key: 'tenders/t-open/vor.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size_bytes: 9000, created_at: '2026-10-20T10:00:00Z' },
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
    { id: 'f-vat', label: 'Ставка НДС', hint: 'выберите из списка', kind: 'select', options: ['22 %', '20 %', '10 %', '7 %', '5 %', '0 %', 'Без НДС'], code: 'vat', sort_order: 20, is_active: true, created_at: '2026-10-23T00:00:00Z' },
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
]

const keyOf = (r) => `${r.kind}|${r.item_key}|${r.unit_key || ''}`
const ok = (data) => ({ data, error: null })

window.__bidCalls = []
window.__fakeRpc = {
  bid_contractor_tenders: () => ok(TENDERS.map((t) => {
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

if (PAGE === 'admin') {
  db.tender_bid_rates.push(
    { id: 'r1', tender_id: 't-open', counterparty_id: CP.id, kind: 'material', item_key: 'x', unit_key: 'м3', name: 'Бетон В25 W8', unit: 'м3', volume: 130.5, price: 7800, total: 1017900, note: null, source: 'import', updated_at: '2026-10-23T09:00:00Z',
      tenders: { public_tender_number: 857, work_description: 'Бетонные полы паркинга', status: 'Идет тендерная процедура' }, counterparties: { name: CP.name } },
    { id: 'r2', tender_id: 't-open', counterparty_id: CP.id, kind: 'work', item_key: 'y', unit_key: 'м3', name: 'Устройство монолитной плиты', unit: 'м3', volume: 130.5, price: 2500, total: 326250, note: 'с опалубкой', source: 'manual', updated_at: '2026-10-23T09:00:00Z',
      tenders: { public_tender_number: 857, work_description: 'Бетонные полы паркинга', status: 'Идет тендерная процедура' }, counterparties: { name: CP.name } },
  )
  db.tender_bid_forms.push({ id: 'form-1', tender_id: 't-open', counterparty_id: CP.id, answers: { 'f-name': { label: 'Наименование контрагента', value: 'ООО Альфа' } } })
}
