// Пример для «Дерева договоров» (/contracts/tree, эксперимент): выдуманные договоры, ДС и заявки, где есть каждый
// случай — основание договора (заявка на ДП), проверки ДП и ДС на разных этапах, просроченная проверка, ДС к ДС,
// заявка на ДС, по которой ДС ещё нет, договор без веток и заявки без договора (с подсказкой и без).
// Строки — в том же виде, что из базы (с полем contract_id у проверок и заявок на ДП — так будет после миграции),
// поэтому дерево строит тот же код, что и для настоящих данных. Даты — от сегодняшнего дня: просрочка остаётся
// просрочкой. Названия и ФИО выдуманы.

const day = (offset) => {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() + offset)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const at = (offset) => `${day(offset)}T09:30:00Z`

const OBJ = {
  park: { id: 'demo-obj-park', name: 'ЖК «Пример Парк»', status: 'main_construction' },
  city: { id: 'demo-obj-city', name: 'ЖК «Пример Сити»', status: 'main_construction' },
}
const CP = {
  monolith: { id: 'demo-cp-monolith', name: 'ООО «Монолит-Пример»' },
  facade: { id: 'demo-cp-facade', name: 'ООО «Фасад-Пример»' },
  electro: { id: 'demo-cp-electro', name: 'ИП Примеров А. А.' },
  hvac: { id: 'demo-cp-hvac', name: 'ООО «Инженер-Пример»' },
}

export const DEMO_EMPLOYEES = [
  { user_id: 'demo-u-1', display_name: 'Петрова Е. А.' },
  { user_id: 'demo-u-2', display_name: 'Соколов И. В.' },
]

function doc(id, over) {
  const obj = over.obj
  const cp = over.cp
  return {
    id,
    display_id: over.display_id,
    record_type: 'dp',
    parent_contract_id: null,
    root_contract_id: null,
    contract_number: '',
    contract_date: null,
    status: 'in_work',
    contract_amount: null,
    currency: 'RUB',
    work_name: '',
    object_id: obj?.id || null,
    objects: obj ? { name: obj.name, status: obj.status } : null,
    counterparty_id: cp?.id || null,
    counterparties: cp ? { id: cp.id, name: cp.name } : null,
    contract_counterparties: [],
    responsible: over.lawyer ? { full_name: over.lawyer } : null,
    deleted_at: null,
    created_at: at(-200),
    ...Object.fromEntries(Object.entries(over).filter(([k]) => !['obj', 'cp', 'lawyer'].includes(k))),
  }
}

function dc(id, over) {
  const { obj, cp } = over
  return {
    id,
    request_number: over.request_number,
    status: 'contract_check',
    check_status: 'not_checked',
    object_id: obj.id,
    objects: { name: obj.name },
    counterparty_id: cp?.id || null,
    counterparties: cp ? { name: cp.name } : null,
    contract_id: null,
    amendment_id: null,
    ds_number: '',
    ds_type: null,
    works_description: '',
    amount_before: null,
    amount_contractor: null,
    amount_after: null,
    vor_amount_before: null,
    vor_amount_after: null,
    created_by_name: 'Кузнецов П. С.',
    deleted_at: null,
    ...Object.fromEntries(Object.entries(over).filter(([k]) => !['obj', 'cp'].includes(k))),
  }
}

function check(id, over) {
  const { obj, cp } = over
  return {
    id,
    request_number: over.request_number,
    doc_type: 'ds',
    status: 'new',
    object_id: obj.id,
    objects: { name: obj.name },
    counterparty_id: cp?.id || null,
    counterparties: cp ? { name: cp.name } : null,
    contract_id: null,
    doc_number: '',
    doc_date: null,
    notes: '',
    assignee_ids: [],
    due_date: null,
    priority: null,
    archived_at: null,
    created_by_name: 'Кузнецов П. С.',
    deleted_at: null,
    ...Object.fromEntries(Object.entries(over).filter(([k]) => !['obj', 'cp'].includes(k))),
  }
}

function dp(id, over) {
  const { obj } = over
  return {
    id,
    request_number: over.request_number,
    status: 'new',
    object_id: obj?.id || null,
    objects: obj ? { name: obj.name } : null,
    contract_id: null,
    contract_title: null,
    amount: null,
    responsible_name: null,
    responsible_role: null,
    reason: '',
    created_by_name: 'Кузнецов П. С.',
    deleted_at: null,
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'obj')),
  }
}

export function makeDemoData() {
  const { park, city } = OBJ
  const contracts = [
    // 1. Полная ветка: основание, проверка ДП, три ДС (одно — к другому ДС), заявки на ДС, проверки ДС, заявка без ДС.
    doc('demo-c1', {
      display_id: 1201, obj: park, cp: CP.monolith, lawyer: 'Смирнова О. В.',
      contract_number: 'ПРП-ДП-26-001', contract_date: day(-120), status: 'completed',
      work_name: 'Монолитные работы корпуса 2', contract_amount: 48600000, signed_date: day(-112),
    }),
    doc('demo-c1-ds1', {
      display_id: 1240, obj: park, cp: CP.monolith, record_type: 'ds_vor', parent_contract_id: 'demo-c1',
      root_contract_id: 'demo-c1', contract_number: '1', contract_date: day(-60), status: 'completed',
      work_name: 'Изменение объёмов армирования по РД изм. 3', contract_amount: 2400000,
    }),
    doc('demo-c1-ds2', {
      display_id: 1263, obj: park, cp: CP.monolith, record_type: 'ds_extra', parent_contract_id: 'demo-c1',
      root_contract_id: 'demo-c1', contract_number: '2', contract_date: day(-12), status: 'in_work',
      work_name: 'Устройство приямков и дополнительных лестниц', contract_amount: 860000,
    }),
    doc('demo-c1-ds3', {
      display_id: 1271, obj: park, cp: CP.monolith, record_type: 'ds_extra', parent_contract_id: 'demo-c1-ds2',
      root_contract_id: 'demo-c1', contract_number: '3', contract_date: day(-4), status: 'new_request',
      work_name: 'Уточнение сроков по ДС № 2', contract_amount: 120000,
    }),
    // 2. Договор, недавно оформленный по заявке на ДП: проверка только началась.
    doc('demo-c2', {
      display_id: 1268, obj: park, cp: CP.facade, lawyer: 'Смирнова О. В.',
      contract_number: 'ПРП-ДП-26-002', contract_date: day(-6), status: 'awaiting_paper_sign',
      work_name: 'Навесной вентилируемый фасад, секции 1–3', contract_amount: 31200000,
    }),
    // 3. Всё завершено — в строке нет отметки «в работе».
    doc('demo-c3', {
      display_id: 977, obj: city, cp: CP.electro, lawyer: 'Орлов Д. Н.',
      contract_number: 'ПРС-ДП-25-014', contract_date: day(-300), status: 'completed',
      work_name: 'Электромонтажные работы паркинга', contract_amount: 6900000,
    }),
    doc('demo-c3-ds1', {
      display_id: 1015, obj: city, cp: CP.electro, record_type: 'ds_extra', parent_contract_id: 'demo-c3',
      root_contract_id: 'demo-c3', contract_number: '1', contract_date: day(-210), status: 'completed',
      work_name: 'Дополнительное освещение рампы', contract_amount: 340000,
    }),
    // 4. Договор без веток: ни заявок, ни ДС.
    doc('demo-c4', {
      display_id: 1275, obj: city, cp: CP.hvac, lawyer: 'Орлов Д. Н.',
      contract_number: 'ПРС-ДП-26-003', contract_date: day(-2), status: 'new_request',
      work_name: 'Монтаж систем вентиляции и кондиционирования', contract_amount: 18750000,
    }),
  ]

  const dcRequests = [
    dc('demo-dc-45', {
      request_number: 45, obj: park, cp: CP.monolith, status: 'completed', check_status: 'matches',
      contract_id: 'demo-c1', amendment_id: 'demo-c1-ds1', ds_number: '1', ds_type: 'psdc_change',
      works_description: 'Изменение армирования по РД изм. 3', amount_before: 2000000, amount_contractor: 2650000,
      amount_after: 2400000, created_at: at(-75), updated_at: at(-58),
    }),
    dc('demo-dc-52', {
      request_number: 52, obj: park, cp: CP.monolith, status: 'in_work', check_status: 'matches_with_remarks',
      contract_id: 'demo-c1', amendment_id: 'demo-c1-ds2', ds_number: '2', ds_type: 'extra_in_contract',
      works_description: 'Приямки и дополнительные лестницы', amount_before: 700000, amount_contractor: 990000,
      amount_after: 860000, created_at: at(-20), updated_at: at(-11),
    }),
    // ДС ещё нет — в дереве кнопка «Создать ДС».
    dc('demo-dc-60', {
      request_number: 60, obj: park, cp: CP.monolith, status: 'contract_check', contract_id: 'demo-c1',
      ds_number: '4', ds_type: 'extra_out_contract', works_description: 'Временная дорога к корпусу 3',
      amount_contractor: 1450000, created_at: at(-3), updated_at: at(-3),
    }),
    dc('demo-dc-31', {
      request_number: 31, obj: city, cp: CP.electro, status: 'completed', check_status: 'matches',
      contract_id: 'demo-c3', amendment_id: 'demo-c3-ds1', ds_number: '1', ds_type: 'extra_in_contract',
      works_description: 'Освещение рампы', amount_before: 300000, amount_contractor: 360000, amount_after: 340000,
      created_at: at(-225), updated_at: at(-208),
    }),
    // Без договора: у контрагента по объекту один договор — подсказка «привязать» сразу.
    dc('demo-dc-58', {
      request_number: 58, obj: park, cp: CP.monolith, status: 'check_result', check_status: 'not_matches',
      ds_number: '5', ds_type: 'extra_in_contract', works_description: 'Утепление пазух фундамента',
      amount_contractor: 380000, created_at: at(-8), updated_at: at(-5),
    }),
  ]

  const checks = [
    check('demo-ch-341', {
      request_number: 341, obj: park, cp: CP.monolith, doc_type: 'dp', status: 'signal', contract_id: 'demo-c1',
      doc_number: 'ПРП-ДП-26-001', doc_date: day(-120), assignee_ids: ['demo-u-1'], due_date: day(2), priority: 'high',
      notes: 'ООО «Монолит-Пример» / договор подряда, загрузить в Signal после подписи заказчика',
      created_at: at(-118), updated_at: at(-2),
    }),
    check('demo-ch-352', {
      request_number: 352, obj: park, cp: CP.monolith, status: 'awaiting_scan', contract_id: 'demo-c1-ds1',
      doc_number: '1', doc_date: day(-60), assignee_ids: ['demo-u-1'], notes: 'Подписано на бумаге, ждём скан',
      created_at: at(-59), updated_at: at(-40),
    }),
    // Просрочена: срок прошёл три дня назад.
    check('demo-ch-377', {
      request_number: 377, obj: park, cp: CP.monolith, status: 'in_progress', contract_id: 'demo-c1-ds2',
      doc_number: '2', doc_date: day(-12), assignee_ids: ['demo-u-2'], due_date: day(-3),
      notes: 'Ждём от подрядчика исправленную ВОР к ДС', created_at: at(-11), updated_at: at(-6),
    }),
    check('demo-ch-380', {
      request_number: 380, obj: park, cp: CP.facade, doc_type: 'dp', status: 'new', contract_id: 'demo-c2',
      doc_number: 'ПРП-ДП-26-002', doc_date: day(-6), due_date: day(5), created_at: at(-5), updated_at: at(-5),
    }),
    check('demo-ch-120', {
      request_number: 120, obj: city, cp: CP.electro, doc_type: 'dp', status: 'done', contract_id: 'demo-c3',
      doc_number: 'ПРС-ДП-25-014', assignee_ids: ['demo-u-2'], created_at: at(-298), updated_at: at(-280),
    }),
    check('demo-ch-133', {
      request_number: 133, obj: city, cp: CP.electro, status: 'done', contract_id: 'demo-c3-ds1',
      doc_number: '1', assignee_ids: ['demo-u-2'], created_at: at(-209), updated_at: at(-200),
    }),
    // Без договора: номер ДС есть, у контрагента на объекте один договор, но самого ДС в реестре нет.
    check('demo-ch-390', {
      request_number: 390, obj: park, cp: CP.facade, status: 'new', doc_number: 'ДС № 1',
      notes: 'ООО «Фасад-Пример» / ДС № 1 — изменение цвета кассет', due_date: day(4),
      created_at: at(-1), updated_at: at(-1),
    }),
    // Без договора: номер договора с опечаткой — сам не нашёлся, подсказывается договор того же контрагента.
    check('demo-ch-395', {
      request_number: 395, obj: city, cp: CP.hvac, doc_type: 'dp', status: 'in_progress', doc_number: 'ПРС-ДП-26-03',
      assignee_ids: ['demo-u-1'], due_date: day(6), created_at: at(-1), updated_at: at(0),
    }),
    // Без договора и уже завершена — прячется под «ещё N завершённых».
    check('demo-ch-201', {
      request_number: 201, obj: city, cp: CP.electro, status: 'done', doc_number: '7', created_at: at(-150),
      updated_at: at(-140),
    }),
  ]

  const dpRequests = [
    dp('demo-dp-7', {
      request_number: 7, obj: park, status: 'completed', contract_id: 'demo-c1', contract_title: 'ПРП-ДП-26-001',
      amount: 48600000, responsible_name: 'Кузнецов П. С.', responsible_role: 'construction_manager',
      reason: 'Новый подрядчик по монолиту корпуса 2', created_at: at(-132), updated_at: at(-121),
    }),
    dp('demo-dp-9', {
      request_number: 9, obj: park, status: 'completed', contract_id: 'demo-c2', contract_title: 'ПРП-ДП-26-002',
      amount: 31200000, responsible_name: 'Кузнецов П. С.', responsible_role: 'construction_manager',
      reason: 'Фасад секций 1–3 по итогам тендера', created_at: at(-15), updated_at: at(-6),
    }),
    // Ждут договора: поданная (отдел ещё ничего не заполнил) и в работе (объект и сумма уже есть).
    dp('demo-dp-11', {
      request_number: 11, obj: city, status: 'new', reason: 'Нужен договор на благоустройство двора',
      created_at: at(-1), updated_at: at(-1),
    }),
    dp('demo-dp-10', {
      request_number: 10, obj: park, status: 'in_work', amount: 5400000, responsible_name: 'Лебедева М. Ю.',
      responsible_role: 'economist', reason: 'Слаботочные системы корпуса 2', created_at: at(-7), updated_at: at(-2),
    }),
  ]

  return { contracts, dcRequests, checks, dpRequests, employees: DEMO_EMPLOYEES }
}

// Следующий номер договора по образцу нумерации объекта (КОД-ДП-ГГ-NNN) — для «Оформить договор» в примере.
export function nextDemoContractNumber(contracts, objectId) {
  const code = objectId === OBJ.city.id ? 'ПРС' : 'ПРП'
  const yy = String(new Date().getFullYear()).slice(-2)
  const re = new RegExp(`^${code}-ДП-${yy}-(\\d+)$`)
  let max = 0
  for (const c of contracts) {
    const m = String(c.contract_number || '').match(re)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `${code}-ДП-${yy}-${String(max + 1).padStart(3, '0')}`
}

export const DEMO_OBJECTS = Object.values(OBJ)
