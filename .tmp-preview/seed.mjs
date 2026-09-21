// Данные тендерного стенда. Один файл — вся «база».
//
// Строки повторяют реальный реестр «Тендеры — Основное строительство» на
// 21.09.2026 (снимки пользователя), чтобы высоты строк у вариантов old/cur/new
// сравнивались на одинаковом содержимом.
//
// Связи (objects, responsible_contact, materials_tender и т.д.) вшиты прямо в
// строки: фейковый клиент не разбирает синтаксис embed'ов PostgREST, он просто
// отдаёт строку целиком.

const NOW_ISO = '2026-09-21T10:00:00'

// Понедельник недели — ключ ручной замены дежурного (utils/weeks.weekKey).
// Считается лениво (buildTables вызывается уже после подмены Date в index.html).
function mondayKey(date = new Date()) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ── Справочники ────────────────────────────────────────────────────────────

const OBJECTS = [
  {
    id: 'obj-primavera-14',
    name: 'ЖК Primavera к14',
    address: 'Москва, Волоколамское шоссе, вл.71/12, корп. 22, корп. 13',
    status: 'main_construction',
    map_link: 'https://yandex.ru/maps/?text=Волоколамское шоссе 71/12',
  },
  {
    id: 'obj-zil-33',
    name: 'ЖК ЗИЛ 33',
    address: 'ул.Бульвар Братьев Весниных / Бульвар Павла Филонова',
    status: 'main_construction',
    map_link: null,
  },
  {
    id: 'obj-event-62',
    name: 'Событие 6.2',
    address: 'г. Москва, ЗАО, вн.тер.г. муниципальный округ Раменки, улица Лобачевского, земельный участок 120/2',
    status: 'main_construction',
    map_link: 'https://yandex.ru/maps/?text=Лобачевского 120/2',
  },
  {
    id: 'obj-king-sons',
    name: 'ЖК King & Sons',
    address: 'Москва, Мосфильмовская ул., 31А',
    status: 'main_construction',
    map_link: 'https://yandex.ru/maps/?text=Мосфильмовская 31А',
  },
  {
    id: 'obj-alia',
    name: 'ЖК Alia к7',
    address: 'Москва, Волоколамское шоссе, вл. 81',
    status: 'main_construction',
    map_link: null,
  },
]

const CONTACTS = [
  { id: 'c-kryukova', full_name: 'Крюкова Юлия Денисовна', position: 'Инженер ОСП', email: 'kryukova@su10.ru', phone: '+7 (495) 120-10-10, доб. 118' },
  { id: 'c-savostenko', full_name: 'Савостенко Владислав Александрович', position: 'Инженер ОСП', email: 'savostenko@su10.ru', phone: '+7 (495) 120-10-10, доб. 121' },
  { id: 'c-arhipov', full_name: 'Архипов Антон Михайлович', position: 'Инженер ОСП', email: 'arhipov@su10.ru', phone: '+7 (495) 120-10-10, доб. 125' },
  { id: 'c-ivanova', full_name: 'Иванова Мария Сергеевна', position: 'Экономист ОСП', email: 'ivanova@su10.ru', phone: '+7 (495) 120-10-10, доб. 131' },
].map((c) => ({ ...c, departments: { name: 'ОСП' }, department_id: 'dep-osp' }))

const CONTACT_BY_ID = Object.fromEntries(CONTACTS.map((c) => [c.id, c]))
const OBJECT_BY_ID = Object.fromEntries(OBJECTS.map((o) => [o.id, o]))

const COUNTERPARTIES = [
  { id: 'cp-1', name: 'ООО «СтройМонтажСервис»', work_type: 'Электромонтажные работы', inn: '7701234567', status: 'active', deleted_at: null },
  { id: 'cp-2', name: 'ООО «ЭлектроПром»', work_type: 'Электромонтажные работы', inn: '7702345678', status: 'active', deleted_at: null },
  { id: 'cp-3', name: 'ООО «ТехноСвет»', work_type: 'Освещение', inn: '7703456789', status: 'active', deleted_at: null },
  { id: 'cp-4', name: 'ООО «МонтажГрупп»', work_type: 'Металлоконструкции', inn: '7704567890', status: 'active', deleted_at: null },
  { id: 'cp-5', name: 'ООО «Фасад-Строй»', work_type: 'Фасадные работы', inn: '7705678901', status: 'active', deleted_at: null },
  { id: 'cp-6', name: 'ООО «ПожЗащита»', work_type: 'Противопожарные работы', inn: '7706789012', status: 'active', deleted_at: null },
]

// Сотрудники СТО и снабжения — их отдаёт RPC, а не таблица.
const STO_EMPLOYEES = [
  { user_id: 'u-krasyukov', display_name: 'Красюков Михаил Александрович', role: 'sto', role_label: 'Сметно-технический отдел' },
  { user_id: 'u-petrov', display_name: 'Петров Сергей Иванович', role: 'sto', role_label: 'Сметно-технический отдел' },
]

const SUPPLY_EMPLOYEES = [
  { user_id: 'u-sidorov', display_name: 'Сидоров Егор Павлович', role: 'supply', role_label: 'Снабжение' },
  { user_id: 'u-noskov', display_name: 'Носков Илья Валерьевич', role: 'supply', role_label: 'Снабжение' },
]

// ── Тендеры ────────────────────────────────────────────────────────────────
//
// Поля описаны «плоско», связи достраивает buildTables().
// mat — статус дочернего тендера на материалы ('' → дочернего нет).

const RAW_TENDERS = [
  {
    n: 782,
    object_id: 'obj-primavera-14',
    work_description: 'Благоустройство: изготовление индивидуальных изделий',
    status: 'Подготовка ВОР',
    start_date: '2026-09-19',
    created_at: '2026-09-19T09:12:00',
    mat: 'Не начат',
  },
  {
    n: 780,
    object_id: 'obj-primavera-14',
    work_description: 'МАФы (изготовление и монтаж )',
    status: 'Подготовка ВОР',
    start_date: '2026-09-18',
    created_at: '2026-09-18T09:05:00',
    mat: 'Не начат',
  },
  {
    n: 778,
    object_id: 'obj-primavera-14',
    work_description: 'ПНР VRF-системы кондиционирования 1-го этажа на корпусах 22 и 13 (полный комплекс пусконаладочных работ с оформлением исполнительной документации)',
    status: 'Подготовка ВОР',
    start_date: '2026-09-17',
    created_at: '2026-09-17T11:40:00',
    mat: 'Не начат',
  },
  {
    n: 776,
    object_id: 'obj-zil-33',
    work_description: 'Огнезащитные экраны автостоянки',
    status: 'Подготовка ВОР',
    start_date: '2026-09-16',
    created_at: '2026-09-16T10:20:00',
    mat: 'Не начат',
  },
  {
    n: 772,
    object_id: 'obj-event-62',
    work_description: 'Тендер на изготовление и монтаж площадок и ограждения технических балконов по Секциям 1-5',
    status: 'Подготовка ВОР',
    start_date: '2026-09-10',
    created_at: '2026-09-17T08:30:00',
    responsible_contact_id: 'c-kryukova',
    vor_status: 'in_progress',
    vor_end_date: '2026-09-25',
    vor_sto_user_id: 'u-krasyukov',
    vor_sto_name: 'Красюков Михаил Александрович',
    mat: 'Не начат',
  },
  {
    n: 769,
    object_id: 'obj-king-sons',
    work_description: 'Устройство шинопровода (перезапуск тендера № 231)',
    status: 'Идет тендерная процедура',
    start_date: '2026-09-08',
    created_at: '2026-09-08T14:10:00',
    tender_start_date: '2026-09-17',
    tender_end_date: '2026-09-21',
    responsible_contact_id: 'c-kryukova',
    vor_status: 'completed',
    vor_end_date: '2026-09-15',
    // Ссылка нужна, иначе «Завершён» без файла рисуется как «⚠ Нет файла».
    vor_link: 'https://drive.google.com/drive/folders/vor-769',
    vor_sto_user_id: 'u-krasyukov',
    vor_sto_name: 'Красюков Михаил Александрович',
    tender_package_link: 'https://drive.google.com/drive/folders/tp-769',
    rd_checked: true,
    rd_checked_by: 'Крюкова Юлия Денисовна',
    rd_checked_at: '2026-09-16T12:00:00',
    tg_published: true,
    tg_published_by: 'Крюкова Юлия Денисовна',
    tg_published_at: '2026-09-17T09:30:00',
    folder_path: '\\\\su10-fs\\2. King n sons\\№769 Устройство шинопровода',
    mat: 'Не требуется',
  },
  {
    n: 766,
    object_id: 'obj-event-62',
    work_description: 'Временное освещения объекта',
    status: 'Идет тендерная процедура',
    start_date: '2026-09-05',
    created_at: '2026-09-05T10:00:00',
    tender_start_date: '2026-09-16',
    tender_end_date: '2026-09-25',
    responsible_contact_id: 'c-savostenko',
    vor_status: 'completed',
    vor_end_date: '2026-09-14',
    vor_link: 'https://drive.google.com/drive/folders/vor-766',
    cost_plan_status: 'in_progress',
    cost_plan_responsible_id: 'c-ivanova',
    mat: 'В работе',
    mat_link: 'https://drive.google.com/drive/folders/mat-766',
  },

  // ── «Живые» вкладки и счётчики ────────────────────────────────────────────
  {
    n: 764,
    object_id: 'obj-alia',
    work_description: 'Устройство наливных полов в паркинге',
    status: 'Подведение итогов',
    start_date: '2026-08-28',
    created_at: '2026-08-28T09:00:00',
    tender_start_date: '2026-09-07',
    tender_end_date: '2026-09-18',
    responsible_contact_id: 'c-arhipov',
    vor_status: 'completed',
    vor_end_date: '2026-09-04',
    vor_link: 'https://drive.google.com/drive/folders/vor-764',
    tender_package_link: 'https://drive.google.com/drive/folders/tp-764',
    cost_plan_status: 'completed',
    cost_plan_link: 'https://drive.google.com/drive/folders/cp-764',
    cost_plan_responsible_id: 'c-ivanova',
    summary_proposal_link: 'https://drive.google.com/drive/folders/sum-764',
    tg_published: true,
    completion_letter_sent: false,
    folder_path: '\\\\su10-fs\\5. Alia\\№764 Наливные полы',
    mat: 'Завершён',
  },
  {
    n: 761,
    object_id: 'obj-zil-33',
    work_description: 'Монтаж систем дымоудаления секций 1-3',
    status: 'Завершен',
    start_date: '2026-08-14',
    created_at: '2026-08-14T09:00:00',
    tender_start_date: '2026-08-24',
    tender_end_date: '2026-09-04',
    responsible_contact_id: 'c-kryukova',
    vor_status: 'completed',
    vor_end_date: '2026-08-21',
    tender_package_link: 'https://drive.google.com/drive/folders/tp-761',
    cost_plan_status: 'completed',
    cost_plan_link: 'https://drive.google.com/drive/folders/cp-761',
    summary_proposal_link: 'https://drive.google.com/drive/folders/sum-761',
    completion_letter_sent: true,
    tg_published: true,
    winners: [{ counterparty_id: 'cp-1', scope_note: '' }],
    mat: 'Завершён',
  },
  {
    n: 758,
    object_id: 'obj-primavera-14',
    work_description: 'Слаботочные системы: СКУД и видеонаблюдение',
    status: 'Приостановка тендера',
    start_date: '2026-08-06',
    created_at: '2026-08-06T09:00:00',
    tender_start_date: '2026-08-17',
    tender_end_date: '2026-08-28',
    responsible_contact_id: 'c-savostenko',
    vor_status: 'not_required',
    cost_plan_status: 'not_required',
    mat: 'Не требуется',
  },
  {
    n: 755,
    object_id: 'obj-event-62',
    work_description: 'Устройство кровли стилобата',
    status: 'Заявка на тендер',
    start_date: '2026-07-30',
    created_at: '2026-07-30T09:00:00',
    vor_status: 'not_started',
    mat: 'Не начат',
  },
  {
    n: 751,
    object_id: 'obj-king-sons',
    work_description: 'Отделка мест общего пользования (МОП) 1-8 этажи',
    status: 'Идет тендерная процедура',
    start_date: '2026-07-20',
    created_at: '2026-07-20T09:00:00',
    tender_start_date: '2026-09-14',
    tender_end_date: '2026-09-30',
    responsible_contact_id: 'c-arhipov',
    vor_status: 'completed',
    vor_end_date: '2026-09-10',
    vor_link: 'https://drive.google.com/drive/folders/vor-751',
    tender_package_link: 'https://drive.google.com/drive/folders/tp-751',
    cost_plan_status: 'awaiting_kp',
    cost_plan_responsible_id: 'c-ivanova',
    tg_published: true,
    folder_path: '\\\\su10-fs\\2. King n sons\\№751 Отделка МОП',
    mat: 'В работе',
  },
  {
    n: 745,
    object_id: 'obj-alia',
    work_description: 'Ошибочно заведённый тендер (дубль № 744)',
    status: 'Заявка на тендер',
    start_date: '2026-07-10',
    created_at: '2026-07-10T09:00:00',
    deleted_at: '2026-07-11T08:00:00',
    mat: '',
  },
]

// Участники: сколько всего и сколько предоставило КП.
const PARTICIPANTS = {
  769: { total: 10, provided: 3 },
  766: { total: 9, provided: 4 },
  764: { total: 7, provided: 6 },
  761: { total: 6, provided: 5 },
  751: { total: 8, provided: 2 },
  758: { total: 4, provided: 1 },
}

// ── Сборка таблиц ──────────────────────────────────────────────────────────

function mainTender(raw) {
  const id = `t-${raw.n}`
  const obj = OBJECT_BY_ID[raw.object_id] || null
  const resp = raw.responsible_contact_id ? CONTACT_BY_ID[raw.responsible_contact_id] : null
  const planResp = raw.cost_plan_responsible_id ? CONTACT_BY_ID[raw.cost_plan_responsible_id] : null
  const vorResp = raw.vor_responsible_id ? CONTACT_BY_ID[raw.vor_responsible_id] : null
  return {
    id,
    public_tender_number: raw.n,
    tender_type: 'main',
    department: 'construction',
    parent_tender_id: null,
    object_id: raw.object_id || null,
    custom_object_name: null,
    work_description: raw.work_description,
    status: raw.status,
    notes: raw.notes ?? null,
    notes_history: null,
    start_date: raw.start_date ?? null,
    end_date: raw.end_date ?? null,
    created_at: raw.created_at ?? NOW_ISO,
    updated_at: raw.created_at ?? NOW_ISO,
    deleted_at: raw.deleted_at ?? null,
    tender_start_date: raw.tender_start_date ?? null,
    tender_end_date: raw.tender_end_date ?? null,
    responsible_contact_id: raw.responsible_contact_id ?? null,
    tender_package_link: raw.tender_package_link ?? null,
    summary_proposal_link: raw.summary_proposal_link ?? null,
    folder_path: raw.folder_path ?? null,
    signal_link: null,
    // ВОР
    vor_status: raw.vor_status ?? 'not_started',
    vor_link: raw.vor_link ?? null,
    vor_start_date: raw.vor_start_date ?? null,
    vor_end_date: raw.vor_end_date ?? null,
    vor_responsible_id: raw.vor_responsible_id ?? null,
    vor_sto_user_id: raw.vor_sto_user_id ?? null,
    vor_sto_name: raw.vor_sto_name ?? null,
    vor_division: null,
    // План затрат
    cost_plan_status: raw.cost_plan_status ?? 'not_started',
    cost_plan_link: raw.cost_plan_link ?? null,
    cost_plan_responsible_id: raw.cost_plan_responsible_id ?? null,
    // Отметки
    tg_published: !!raw.tg_published,
    tg_published_by: raw.tg_published_by ?? null,
    tg_published_at: raw.tg_published_at ?? null,
    rd_checked: !!raw.rd_checked,
    rd_checked_by: raw.rd_checked_by ?? null,
    rd_checked_at: raw.rd_checked_at ?? null,
    completion_letter_sent: !!raw.completion_letter_sent,
    completion_letter_sent_by: null,
    completion_letter_sent_at: null,
    // Материалы (у основного тендера поля пустые — они у дочернего)
    materials_priority: null,
    materials_resp_user_id: null,
    materials_resp_name: null,
    materials_proposal_start_date: null,
    materials_proposal_deadline: null,
    materials_proposal_link: null,
    winner_counterparty_id: raw.winners?.[0]?.counterparty_id ?? null,
    // embed'ы
    objects: obj ? { name: obj.name, status: obj.status, address: obj.address, map_link: obj.map_link } : null,
    responsible_contact: resp ? { id: resp.id, full_name: resp.full_name } : null,
    cost_plan_responsible: planResp ? { id: planResp.id, full_name: planResp.full_name } : null,
    vor_responsible: vorResp ? { id: vorResp.id, full_name: vorResp.full_name } : null,
    winner: raw.winners?.[0]
      ? { id: raw.winners[0].counterparty_id, name: COUNTERPARTIES.find(c => c.id === raw.winners[0].counterparty_id)?.name }
      : null,
    tender_winners: (raw.winners || []).map((w) => ({
      counterparty_id: w.counterparty_id,
      scope_note: w.scope_note || null,
      counterparties: {
        id: w.counterparty_id,
        name: COUNTERPARTIES.find(c => c.id === w.counterparty_id)?.name || w.counterparty_id,
      },
    })),
    materials_tender: null,
  }
}

// Дочерний тендер на материалы — отдельная строка той же таблицы.
function materialsTender(raw, parent, index) {
  const id = `t-${raw.n}-mat`
  return {
    ...mainTender(raw),
    id,
    public_tender_number: raw.n + 1,
    tender_type: 'materials',
    parent_tender_id: parent.id,
    status: raw.mat,
    vor_status: 'not_started',
    vor_link: null,
    vor_end_date: null,
    vor_sto_user_id: null,
    vor_sto_name: null,
    cost_plan_status: 'not_started',
    cost_plan_link: null,
    cost_plan_responsible_id: null,
    cost_plan_responsible: null,
    tender_package_link: null,
    summary_proposal_link: null,
    tender_start_date: null,
    tender_end_date: null,
    tg_published: false,
    rd_checked: false,
    completion_letter_sent: false,
    materials_priority: ['high', 'medium', 'low', null][index % 4],
    materials_resp_user_id: index % 3 === 0 ? SUPPLY_EMPLOYEES[0].user_id : (index % 3 === 1 ? SUPPLY_EMPLOYEES[1].user_id : null),
    materials_resp_name: index % 3 === 0 ? SUPPLY_EMPLOYEES[0].display_name : (index % 3 === 1 ? SUPPLY_EMPLOYEES[1].display_name : null),
    materials_proposal_start_date: raw.tender_start_date ?? null,
    materials_proposal_deadline: raw.tender_end_date ?? null,
    materials_proposal_link: raw.mat_link ?? null,
    materials_tender: null,
    tender_winners: [],
    winner: null,
    winner_counterparty_id: null,
  }
}

export function buildTables() {
  const tenders = []
  RAW_TENDERS.forEach((raw, i) => {
    const main = mainTender(raw)
    tenders.push(main)
    if (raw.mat) {
      const child = materialsTender(raw, main, i)
      tenders.push(child)
      main.materials_tender = {
        id: child.id,
        status: child.status,
        summary_proposal_link: child.summary_proposal_link,
        cost_plan_status: child.cost_plan_status,
        cost_plan_link: child.cost_plan_link,
        materials_proposal_deadline: child.materials_proposal_deadline,
        materials_proposal_link: child.materials_proposal_link,
      }
    }
  })

  // Участники тендеров (счётчики «3/10 КП» и раскрытие строки).
  const tenderCounterparties = []
  for (const [num, { total, provided }] of Object.entries(PARTICIPANTS)) {
    for (let i = 0; i < total; i++) {
      const cp = COUNTERPARTIES[i % COUNTERPARTIES.length]
      tenderCounterparties.push({
        id: `tc-${num}-${i}`,
        tender_id: `t-${num}`,
        counterparty_id: cp.id,
        status: i < provided ? 'proposal_provided' : (i === total - 1 ? 'declined' : 'request_sent'),
        sort_order: (i + 1) * 10,
        notes: i === 0 ? 'Запрос отправлен повторно 18.09' : null,
        notes_history: null,
        created_at: '2026-09-17T09:00:00',
        counterparties: {
          id: cp.id,
          name: `${cp.name} ${i > COUNTERPARTIES.length - 1 ? `(${Math.floor(i / COUNTERPARTIES.length) + 1})` : ''}`.trim(),
          work_type: cp.work_type,
          inn: cp.inn,
          counterparty_contacts: [
            { id: `cc-${num}-${i}`, full_name: 'Смирнов А. В.', position: 'Менеджер', phone: '+7 (999) 100-20-30', email: `sales${i}@example.ru` },
          ],
        },
      })
    }
  }

  // Вложение тендерного пакета у № 769.
  const s3Documents = [
    {
      id: 's3-769-pkg',
      owner_type: 'tender',
      owner_id: 't-769',
      doc_category: 'tender_package',
      file_name: 'Тендерный пакет № 769.pdf',
      s3_key: 'tenders/t-769/package.pdf',
      mime_type: 'application/pdf',
      size_bytes: 482113,
      created_at: '2026-09-17T09:40:00',
      uploaded_by_name: 'Крюкова Юлия Денисовна',
    },
    {
      id: 's3-764-vor',
      owner_type: 'tender',
      owner_id: 't-764',
      doc_category: 'vor_statement',
      file_name: 'ВОР № 764.xlsx',
      s3_key: 'tenders/t-764/vor.xlsx',
      mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size_bytes: 91240,
      created_at: '2026-09-04T12:00:00',
      uploaded_by_name: 'Красюков Михаил Александрович',
    },
  ]

  const appSettings = [
    {
      key: 'tenders_root_folder_path:construction',
      value: '\\\\192.168.2.55\\SharA_Tender\\Отдел Субподряда\\4. Тендеры',
      updated_at: NOW_ISO,
    },
    {
      key: 'tenders_root_folder_path',
      value: '\\\\192.168.2.55\\SharA_Tender\\Отдел Субподряда\\4. Тендеры',
      updated_at: NOW_ISO,
    },
    {
      key: 'tenders_root_folder_path:materials',
      value: '\\\\192.168.2.55\\SharA_Tender\\Отдел Субподряда\\5. Материалы',
      updated_at: NOW_ISO,
    },
    {
      key: 'tenders_drive_folder_link:construction',
      value: 'https://drive.google.com/drive/folders/tenders-construction',
      updated_at: NOW_ISO,
    },
    // Дежурный по тендерам на текущую неделю — «Крюкова Юлия Денисовна».
    {
      key: 'tender_responsible_override',
      value: JSON.stringify({ week: mondayKey(), name: 'Крюкова Юлия Денисовна' }),
      updated_at: NOW_ISO,
    },
  ]

  return {
    tenders,
    objects: OBJECTS.map((o) => ({ ...o })),
    contacts: CONTACTS.map((c) => ({ ...c })),
    counterparties: COUNTERPARTIES.map((c) => ({ ...c })),
    tender_counterparties: tenderCounterparties,
    tender_winners: [],
    s3_documents: s3Documents,
    app_settings: appSettings,
    tender_audit_log: [],
    tender_rd_codes: [
      { id: 'rd-1', tender_id: 't-769', code: 'КЖ-1', title: 'Конструкции железобетонные', sort_order: 10, created_at: '2026-09-10T09:00:00' },
      { id: 'rd-2', tender_id: 't-769', code: 'ЭОМ', title: 'Электрооборудование', sort_order: 20, created_at: '2026-09-10T09:05:00' },
    ],
    tender_rd_document_codes: [],
    departments: [{ id: 'dep-osp', name: 'ОСП' }],
  }
}

export const RPC_RESULTS = {
  list_sto_employees: STO_EMPLOYEES,
  list_supply_employees: SUPPLY_EMPLOYEES,
}

export const FAKE_USER = {
  id: 'u-stand',
  email: 'stand@su10.ru',
  user_metadata: { full_name: 'Стенд Тендеров' },
}
