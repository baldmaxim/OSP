// «Заявка на заключение ДП» (миграции 20261227, 20261231): правила (без браузера) и страница в Chromium (стенд tests/tender/ui/dp-stand.jsx).
//   • подающий заполняет только понятийное соглашение (без него кнопка неактивна, причина написана, а отказ базы виден словами), документы и примечание;
//   • объект, договор, сумму и ответственного заполняет работающий с заявками, по мере готовности; незаполненное не притворяется нулём;
//   • сбой загрузки: заявка не появляется, черновик убран, заполненная форма на месте;
//   • ответственный — люди объекта, сам вошедший без карточки в «Контактах», объект без сотрудников;
//   • создают только с правом создания, статус меняют только с правом работы; автор — пока заявку не взяли в работу;
//   • большое окно: только получателю, на любой странице, закрывается только кнопкой, «Открыть заявку» ведёт к строке;
//     не получатель базу не опрашивает;
//   • базы без миграции — подсказка, а не ошибка. База — dp-requests-db.test.mjs.
// Люди и объекты стенда вымышленные: настоящие ФИО в репозиторий не кладём.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  accountResponsibleRole, canChangeDpRequest, countDpTabs, dpErrorText, dpFileAccept, dpFileProblem, dpFormFields, dpFormProblems, filterDpRequests, isDpMigrationMissing,
  isLastRequiredFile, matchesDpSearch, newRequestsLabel, ownObjectChoice, pickResponsibleKey, responsibleOptions,
} from '../../src/utils/dpRequests.js'

const STAFF = [
  { object_id: 'a', contact_id: 'c-boss', staff_role: 'construction_manager', sort_order: 0, contacts: { full_name: 'Строев Борис' } },
  { object_id: 'a', contact_id: 'c-econ2', staff_role: 'economist', sort_order: 1, contacts: { full_name: 'Яковлев Ян' } },
  { object_id: 'a', contact_id: 'c-econ1', staff_role: 'economist', sort_order: 0, contacts: { full_name: 'Экономов Андрей' } },
  { object_id: 'b', contact_id: 'c-far', staff_role: 'economist', sort_order: 0, contacts: { full_name: 'Дальний Олег' } },
  { object_id: 'a', contact_id: 'c-noname', staff_role: 'economist', sort_order: 2, contacts: null },
]

describe('Заявка на заключение ДП: правила без базы', () => {
  it('ответственный: люди объекта, экономисты первыми', () => {
    const { options, fallback } = responsibleOptions({ staff: STAFF, objectId: 'a' })
    assert.equal(fallback, false)
    assert.deepEqual(options.map((o) => o.name), ['Экономов Андрей', 'Яковлев Ян', 'Строев Борис'])
    assert.deepEqual(options[0], { key: 'c-econ1:economist', contactId: 'c-econ1', name: 'Экономов Андрей', role: 'economist' })
  })

  it('у объекта никого — такие люди других объектов, с пометкой; объект не выбран — пусто', () => {
    const none = responsibleOptions({ staff: STAFF, objectId: 'z' })
    assert.equal(none.fallback, true)
    assert.equal(none.options.length, 4)
    assert.deepEqual(responsibleOptions({ staff: STAFF, objectId: '' }), { options: [], fallback: false })
  })

  it('сам вошедший без карточки в «Контактах»: в списке, без контакта; с карточкой — не дублируется; экономист ОСП — не с объекта', () => {
    const me = { role: 'construction_manager', name: 'Новиков Пётр' }
    const { options } = responsibleOptions({ staff: STAFF, objectId: 'a', me })
    assert.deepEqual(options[0], { key: 'me', contactId: null, name: 'Новиков Пётр', role: 'construction_manager' })
    const twin = responsibleOptions({ staff: STAFF, objectId: 'a', me: { role: 'economist_object', name: ' экономов  андрей ' } })
    assert.ok(!twin.options.some((o) => o.key === 'me'))
    const osp = responsibleOptions({ staff: STAFF, objectId: 'a', me: { role: 'economist', name: 'Экономист ОСП' } })
    assert.ok(!osp.options.some((o) => o.key === 'me'))
    assert.equal(accountResponsibleRole('economist_object'), 'economist')
    assert.equal(accountResponsibleRole('economist'), null)
    assert.equal(accountResponsibleRole('admin'), null)
  })

  it('выбор в форме: прежний выбор, затем сам вошедший, затем единственный; среди нескольких не угадываем', () => {
    const options = responsibleOptions({ staff: STAFF, objectId: 'a' }).options
    assert.equal(pickResponsibleKey({ options, current: 'c-boss:construction_manager' }), 'c-boss:construction_manager')
    assert.equal(pickResponsibleKey({ options, current: 'нет-такого', myName: 'Яковлев Ян' }), 'c-econ2:economist')
    assert.equal(pickResponsibleKey({ options, current: '', myName: 'Чужой' }), '')
    const single = responsibleOptions({ staff: STAFF, objectId: 'b' }).options
    assert.equal(pickResponsibleKey({ options: single, current: '', myName: 'Чужой' }), 'c-far:economist')
  })

  it('форма подающего: обязательно только понятийное соглашение; в запись идёт только примечание', () => {
    const empty = { object_id: '', contract_title: '', amount: '', responsibleKey: '', reason: '' }
    assert.deepEqual(dpFormProblems(empty, { conceptCount: 0 }), ['загрузите понятийное соглашение'])
    assert.deepEqual(dpFormProblems(empty, { conceptCount: 1 }), [])
    assert.deepEqual(dpFormProblems(empty), [], 'при правке файлы — в строке заявки')
    assert.deepEqual(dpFormFields(empty), { reason: null })
    assert.deepEqual(dpFormFields({ ...empty, reason: '  Срочно ' }), { reason: 'Срочно' })
    assert.deepEqual(dpFormFields({ object_id: 'a', contract_title: 'Договор', amount: '5', responsibleKey: 'me', reason: 'x' }, { contactId: 'c-1', name: 'И. И.', role: 'economist' }), { reason: 'x' },
      'поля отдела подающий не пишет, что бы ни оказалось в форме')
  })

  it('объект подающего с привязкой: один — стоит сам, несколько — выбор обязателен; в запись — только свой объект', () => {
    const A = { id: 'a', name: 'Объект А' }
    const B = { id: 'b', name: 'Объект Б' }
    assert.deepEqual(ownObjectChoice({ ownObjects: [A], objectId: '' }), { objectId: 'a', single: A, problem: null })
    assert.deepEqual(ownObjectChoice({ ownObjects: [A], objectId: 'b' }), { objectId: 'a', single: A, problem: null }, 'выбирать нечего')
    assert.deepEqual(ownObjectChoice({ ownObjects: [A, B], objectId: '' }), { objectId: '', single: null, problem: 'выберите объект' })
    assert.deepEqual(ownObjectChoice({ ownObjects: [A, B], objectId: 'b' }), { objectId: 'b', single: null, problem: null })
    assert.equal(ownObjectChoice({ ownObjects: [A, B], objectId: 'чужой' }).problem, 'выберите объект', 'не из своих — не выбор')
    assert.match(ownObjectChoice({ ownObjects: null }).problem, /дождитесь/)
    assert.match(ownObjectChoice({ ownObjects: null, failed: true }).problem, /не загрузился/)
    assert.deepEqual(ownObjectChoice({ ownObjects: [] }), { objectId: '', single: null, problem: null }, 'объектов привязки в базе нет — объект поставит отдел')

    const form = { object_id: 'b', contract_title: 'Договор', amount: '5', responsibleKey: '', reason: ' x ' }
    assert.deepEqual(dpFormFields(form, null, { ownObjectId: 'b' }), { object_id: 'b', reason: 'x' })
    assert.deepEqual(dpFormFields(form, null, { ownObjectId: '' }), { reason: 'x' }, 'без привязки объект не пишется')
    assert.deepEqual(dpFormProblems(form, { conceptCount: 1, objectProblem: 'выберите объект' }), ['выберите объект'])
  })

  it('форма работающего с заявками: всё необязательно, проверяется только введённая сумма', () => {
    const empty = { object_id: '', contract_title: ' ', amount: '', responsibleKey: '', reason: ' ' }
    assert.deepEqual(dpFormProblems(empty, { canWork: true }), [])
    assert.deepEqual(dpFormProblems({ ...empty, amount: '0' }, { canWork: true }), [], 'сумма 0 допустима')
    assert.deepEqual(dpFormProblems({ ...empty, amount: '-5' }, { canWork: true }), ['проверьте сумму'])
    assert.deepEqual(dpFormProblems({ ...empty, amount: '-5' }), [], 'подающему суммы нет')
    assert.deepEqual(dpFormFields(empty, null, { canWork: true }), {
      object_id: null, contract_title: null, amount: null, responsible_contact_id: null, responsible_name: null, responsible_role: null, reason: null,
    })
    const full = { object_id: 'a', contract_title: ' Договор ', amount: '1 000,50', responsibleKey: 'me', reason: 'Нужен' }
    assert.deepEqual(dpFormFields(full, { contactId: 'c-1', name: 'И. И.', role: 'economist' }, { canWork: true }), {
      object_id: 'a', contract_title: 'Договор', amount: 1000.5, responsible_contact_id: 'c-1', responsible_name: 'И. И.', responsible_role: 'economist', reason: 'Нужен',
    })
  })

  it('право менять заявку: работает с заявками — всегда; автор — пока не взяли в работу; другие — нет', () => {
    const mine = { created_by: 'u1', status: 'new' }
    assert.equal(canChangeDpRequest(mine, { canWork: false, canCreate: true, userId: 'u1' }), true)
    assert.equal(canChangeDpRequest({ ...mine, status: 'in_work' }, { canWork: false, canCreate: true, userId: 'u1' }), false)
    assert.equal(canChangeDpRequest(mine, { canWork: false, canCreate: true, userId: 'u2' }), false)
    assert.equal(canChangeDpRequest(mine, { canWork: false, canCreate: false, userId: 'u1' }), false)
    assert.equal(canChangeDpRequest({ ...mine, status: 'completed' }, { canWork: true, canCreate: false, userId: 'u2' }), true)
  })

  it('последний файл соглашения убрать нельзя, второй — можно; документы необязательны', () => {
    const a = { doc_category: 'dp_concept_agreement' }
    assert.equal(isLastRequiredFile(a, [a]), true)
    assert.equal(isLastRequiredFile(a, [a, { doc_category: 'dp_concept_agreement' }]), false)
    const doc = { doc_category: 'dp_contract_doc' }
    assert.equal(isLastRequiredFile(doc, [doc]), false)
    assert.equal(isLastRequiredFile({ doc_category: 'другая' }, [{}]), false)
  })

  it('типы файлов: в документах ещё и Excel, у соглашения — нет; размер проверяется у обоих', () => {
    const xlsx = { name: 'Расчёт.XLSX', size: 10 }
    assert.equal(dpFileProblem(xlsx, 'dp_contract_doc'), null)
    assert.match(dpFileProblem(xlsx, 'dp_concept_agreement'), /нужен PDF, Word или скан/)
    assert.match(dpFileProblem({ name: 'x.exe', size: 10 }, 'dp_contract_doc'), /нужен PDF, Word, Excel или скан/)
    assert.equal(dpFileProblem({ name: 'x.pdf', size: 10 }, 'dp_concept_agreement'), null)
    assert.match(dpFileProblem({ name: 'x.xlsx', size: 0 }, 'dp_contract_doc'), /пустой/)
    assert.match(dpFileProblem({ name: 'x.xlsx', size: 60 * 1024 * 1024 }, 'dp_contract_doc'), /больше 50/)
    assert.match(dpFileAccept('dp_contract_doc'), /\.xlsx/)
    assert.doesNotMatch(dpFileAccept('dp_concept_agreement'), /\.xlsx/)
  })

  it('поиск и вкладки: номер, слова в любом поле; счётчик вкладки равен числу строк', () => {
    const rows = [
      { id: '1', request_number: 12, status: 'new', object_id: 'a', objects: { name: 'ЖК Альфа' }, contract_title: 'Монолит', responsible_name: 'Ёлкин', reason: 'Новый подрядчик' },
      { id: '2', request_number: 3, status: 'in_work', object_id: 'b', objects: { name: 'БЦ Бета' }, contract_title: 'Фасад №12', responsible_name: 'Петров', reason: 'Замена' },
      { id: '3', request_number: 4, status: 'new', object_id: 'a', objects: { name: 'ЖК Альфа' }, contract_title: 'Удалённый', reason: 'x', deleted_at: '2026-11-01' },
    ]
    assert.equal(matchesDpSearch(rows[0], '№ 12'), true)
    assert.equal(matchesDpSearch(rows[0], 'елкин монолит'), true)
    assert.equal(matchesDpSearch(rows[0], 'петров'), false)
    assert.deepEqual(filterDpRequests(rows, { query: '12' }).map((r) => r.id), ['1', '2'], 'номер и текст');
    assert.deepEqual(filterDpRequests(rows, { tab: 'new' }).map((r) => r.id), ['1'])
    assert.deepEqual(filterDpRequests(rows, { tab: 'deleted' }).map((r) => r.id), ['3'])
    assert.deepEqual(filterDpRequests(rows, { objectIds: ['b'] }).map((r) => r.id), ['2'])
    assert.deepEqual(countDpTabs(rows), { all: 2, new: 1, in_work: 1, completed: 0, deleted: 1 })
    assert.deepEqual(countDpTabs(rows, { objectIds: ['a'] }), { all: 1, new: 1, in_work: 0, completed: 0, deleted: 1 })
  })

  it('отказ базы — словами страницы; база без миграции узнаётся', () => {
    assert.match(dpErrorText({ hint: 'dp_concept_agreement_required', message: 'x' }), /без понятийного соглашения/)
    assert.match(dpErrorText({ hint: 'dp_work_fields', message: 'x' }), /работающий с заявками/)
    assert.match(dpErrorText({ code: '23502', message: 'null value in column' }), /20261231_dp_requests_short_form/)
    assert.equal(dpErrorText({ message: 'Другая ошибка' }), 'Другая ошибка')
    assert.equal(isDpMigrationMissing({ code: 'PGRST205', message: "Could not find the table 'public.dp_requests'" }), true)
    assert.equal(isDpMigrationMissing({ code: '42501', message: 'permission denied' }), false)
  })

  it('склонение количества заявок', () => {
    assert.equal(newRequestsLabel(1), '1 новая заявка')
    assert.equal(newRequestsLabel(3), '3 новые заявки')
    assert.equal(newRequestsLabel(5), '5 новых заявок')
    assert.equal(newRequestsLabel(11), '11 новых заявок')
    assert.equal(newRequestsLabel(21), '21 новая заявка')
  })
})

const launch = browserLaunchOptions()
const CONCEPT = { name: 'Понятийное.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') }
const CONTRACT = { name: 'Договор.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('docx') }
// Экономист объекта: создаёт, но не работает с заявками.
const ECONOMIST = 'asRole=economist_object&asUser=econ-1&asName=Экономов%20Андрей%20Петрович&noEdit=dp_requests,admin&dpRecipient=0'

describe('Заявка на заключение ДП: страница', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
  let stand
  let browser

  before(async () => {
    stand = await startStand(REPO)
    browser = await chromium.launch({ ...launch, headless: true })
  })
  after(async () => {
    await browser?.close()
    await stand?.server.close()
  })

  const open = async (query, { ready = '.dp-requests-page', viewport = { width: 1500, height: 950 }, route = '/dp-requests' } = {}) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => d.accept())
    await page.goto(`${stand.url}?route=${route}&latency=0${query ? `&${query}` : ''}`)
    await page.locator(ready).first().waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const row = (page, n) => page.locator('.dpr-table tbody tr').filter({ has: page.locator('.dpr-number', { hasText: new RegExp(`^${n}$`) }) })
  const dialog = (page) => page.locator('.dpr-dialog')
  // Подают только из «Реестра по договорам» (кнопка DpRequestCreateButton; стенд ставит её над страницей заявок).
  const newRequest = (page) => page.locator('.cr-dp-add').click()
  // Поля, которые заполняет работающий с заявками.
  const fillWorkFields = async (page, { object = 'ЖК «Северный квартал»', responsible = 'Экономов Андрей Петрович · Экономист объекта' } = {}) => {
    const d = dialog(page)
    await d.getByLabel('Объект').selectOption({ label: object })
    await d.getByRole('textbox', { name: /^Договор/ }).fill('Договор на монолит')
    await d.getByLabel('Сумма, ₽').fill('1500000,5')
    if (responsible) await d.getByLabel('Ответственный').selectOption({ label: responsible })
  }
  const fillNote = (page) => dialog(page).getByLabel('Примечание').fill('Новый подрядчик по монолиту')
  const attachConcept = (page, file = CONCEPT) => page.locator('[data-testid="dpr-concept-files"] input[type=file]').setInputFiles(file)
  const attachDoc = (page, file = CONTRACT) => page.locator('[data-testid="dpr-doc-files"] input[type=file]').setInputFiles(file)
  const attachBoth = async (page) => { await attachDoc(page); await attachConcept(page) }
  // Заявка, какой её подал автор: заполнять ещё нечего. Появляется в реестре при возврате на вкладку.
  const pushShortRequest = (page) => page.evaluate(() => {
      window.__fakeDb.dp_requests.push({
        id: 'dp-short', request_number: 50, status: 'new', object_id: null, objects: null, contract_title: null, amount: null,
        responsible_contact_id: null, responsible_name: null, responsible_role: null, reason: null,
        created_by: 'author-1', created_by_name: 'Автор Заявки', created_at: '2026-11-05T09:00:00Z', updated_at: '2026-11-05T09:00:00Z', deleted_at: null,
      })
      window.__fakeDb.s3_documents.push({
        id: 'f-short', owner_type: 'dp_request', owner_id: 'dp-short', doc_category: 'dp_concept_agreement', s3_key: 'dp-requests/dp-short/f-Понятийка.pdf',
        file_name: 'Понятийка короткая.pdf', mime_type: 'application/pdf', size_bytes: 10, created_at: '2026-11-05T09:00:00Z',
      })
      window.__fakeTouch('dp_requests')
      document.dispatchEvent(new Event('visibilitychange'))
  })
  const addShortRequest = async (page) => {
    await pushShortRequest(page)
    await row(page, 50).waitFor()
  }
  const addShortRequest2 = async (page) => {
    await pushShortRequest(page)
    await page.locator('.mcard', { hasText: '№ 50' }).waitFor()
  }

  it('реестр: столбцы формата заявки, файлы, вкладки, поиск', async () => {
    const { page, errors, close } = await open('dpRecipient=0')
    try {
      await row(page, 1).waitFor()
      const heads = await page.locator('.dpr-table thead th').allTextContents()
      assert.deepEqual(heads.slice(0, 8), ['№', 'Объект', 'Договор и документы', 'Понятийное соглашение', 'Сумма, ₽', 'Ответственный', 'Примечание', 'Статус'])
      const first = row(page, 1)
      assert.match(await first.innerText(), /ЖК «Северный квартал»[\s\S]*Договор № 1[\s\S]*Договор 1\.docx[\s\S]*Понятийка 1\.pdf[\s\S]*1\s000\s001,00[\s\S]*Экономов[\s\S]*[\s\S]*Экономист объекта[\s\S]*Причина заявки 1/)
      // Столбцы разделены вертикальными линиями (09.11.2026): в строках — рамкой справа, в закреплённой шапке — тенью; у последнего — нет.
      const lines = await page.evaluate(() => {
        const cells = (sel) => [...document.querySelectorAll(sel)].map((el) => getComputedStyle(el))
        return {
          td: cells('.dpr-table tbody tr:first-child > td').map((s) => s.borderRightWidth),
          th: cells('.dpr-table thead th').map((s) => /-1px 0px 0px 0px inset/.test(s.boxShadow)),
        }
      })
      assert.deepEqual(lines.td, [...Array(8).fill('1px'), '0px'])
      assert.deepEqual(lines.th, [...Array(8).fill(true), false])
      await page.locator('.status-tab', { hasText: 'В работе' }).click()
      assert.equal(await page.locator('.dpr-table tbody tr').count(), 1)
      await page.locator('.status-tab', { hasText: 'Удалённые' }).click()
      await row(page, 5).waitFor()
      assert.match(await row(page, 5).innerText(), /Удалена/)
      await page.locator('.status-tab', { hasText: 'Все заявки' }).click()
      await page.getByLabel('Поиск по номеру').fill('нурлы')
      assert.equal(await page.locator('.dpr-table tbody tr').count(), 1)
      await row(page, 2).waitFor()
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('подающий видит только соглашение, документы и примечание; без соглашения заявку не создать, остальное необязательно', async () => {
    const { page, errors, close } = await open(ECONOMIST)
    try {
      await row(page, 1).waitFor()
      await newRequest(page)
      const d = dialog(page)
      assert.deepEqual(await d.locator('.dpr-label').allTextContents(), ['Понятийное соглашение *', 'Документы (необязательно)', 'Примечание'])
      assert.equal(await d.locator('select').count(), 0, 'ни объекта, ни ответственного')
      assert.equal(await d.locator('input[type=text]').count(), 0, 'ни договора, ни суммы')

      const submit = d.getByRole('button', { name: 'Создать заявку' })
      assert.equal(await submit.isDisabled(), true)
      const problems = d.locator('.dpr-problems')
      assert.match(await problems.innerText(), /загрузите понятийное соглашение/)
      await attachDoc(page)
      assert.equal(await submit.isDisabled(), true, 'документ соглашение не заменяет')
      await page.locator('[data-testid="dpr-doc-files"]').getByRole('button', { name: 'Убрать Договор.docx' }).click()

      await attachConcept(page)
      assert.equal(await submit.isDisabled(), false, 'документы и примечание необязательны')
      assert.equal(await problems.count(), 0)
      await submit.click()
      await d.waitFor({ state: 'detached' })

      const created = row(page, 100)
      await created.waitFor()
      const text = await created.innerText()
      assert.match(text, /Понятийное\.pdf/)
      assert.doesNotMatch(text, /0,00/, 'сумма не заполнена, а не ноль')
      assert.doesNotMatch(text, /нет файла|не заполнено/, 'подающему напоминать не о чем')
      const saved = await page.evaluate(() => window.__fakeDb.dp_requests.find((r) => r.request_number === 100))
      assert.equal(saved.status, 'new')
      for (const field of ['object_id', 'contract_title', 'amount', 'responsible_contact_id', 'responsible_name', 'reason']) {
        assert.equal(saved[field] ?? null, null, field)
      }
      const read = await page.evaluate(() => window.__supabaseStats.requests.map((r) => r.table))
      assert.ok(!read.includes('object_staff') && !read.includes('objects'), 'объекты и сотрудники подающему не нужны')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('подающий с документами и примечанием: всё на месте, файлы по своим категориям', async () => {
    const { page, errors, close } = await open(ECONOMIST)
    try {
      await row(page, 1).waitFor()
      await newRequest(page)
      await attachBoth(page)
      await attachDoc(page, { name: 'Расчёт.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('xlsx') })
      await fillNote(page)
      await dialog(page).getByRole('button', { name: 'Создать заявку' }).click()
      await dialog(page).waitFor({ state: 'detached' })
      const text = await row(page, 100).innerText()
      assert.match(text, /Договор\.docx/)
      assert.match(text, /Расчёт\.xlsx/)
      assert.match(text, /Понятийное\.pdf/)
      assert.match(text, /Новый подрядчик/)
      const docs = await page.evaluate(() => window.__fakeDb.s3_documents
        .filter((d) => d.owner_type === 'dp_request' && /Понятийное|Договор\.docx|Расчёт/.test(d.file_name)).map((d) => [d.file_name, d.doc_category]))
      assert.deepEqual(docs.sort(), [['Договор.docx', 'dp_contract_doc'], ['Понятийное.pdf', 'dp_concept_agreement'], ['Расчёт.xlsx', 'dp_contract_doc']])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('подающий с двумя объектами в «Ролях»: выбирает объект, без выбора заявку не создать; чужих объектов в списке нет', async () => {
    const { page, errors, close } = await open(`${ECONOMIST}&scope=obj-1,obj-2`)
    try {
      await row(page, 1).waitFor()
      await newRequest(page)
      const d = dialog(page)
      const select = d.getByLabel('Объект')
      await select.locator('option', { hasText: 'Бизнес-центр' }).waitFor({ state: 'attached' })
      assert.deepEqual(await d.locator('.dpr-label').allTextContents(), ['Объект *', 'Понятийное соглашение *', 'Документы (необязательно)', 'Примечание'])
      assert.equal(await select.isDisabled(), false)
      assert.deepEqual(await select.locator('option').allTextContents(), ['— Выберите объект —', 'Бизнес-центр «Нурлы»', 'ЖК «Северный квартал»'], 'по алфавиту')
      const objectReads = await page.evaluate(() => window.__supabaseStats.requests.filter((r) => r.table === 'objects'))
      assert.ok(objectReads.length > 0)
      for (const r of objectReads) assert.deepEqual(r.ids, ['obj-1', 'obj-2'], 'только свои объекты, отбор — в запросе')

      await attachConcept(page)
      const submit = d.getByRole('button', { name: 'Создать заявку' })
      assert.equal(await submit.isDisabled(), true, 'объект не выбран')
      assert.match(await d.locator('.dpr-problems').innerText(), /выберите объект/)
      await select.selectOption({ label: 'Бизнес-центр «Нурлы»' })
      assert.equal(await submit.isDisabled(), false)
      await submit.click()
      await d.waitFor({ state: 'detached' })

      const created = row(page, 100)
      await created.waitFor()
      assert.match(await created.innerText(), /Бизнес-центр «Нурлы»/)
      const saved = await page.evaluate(() => window.__fakeDb.dp_requests.find((r) => r.request_number === 100))
      assert.equal(saved.object_id, 'obj-2')
      for (const field of ['contract_title', 'amount', 'responsible_contact_id', 'responsible_name']) assert.equal(saved[field] ?? null, null, field)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('подающий с одним объектом: объект стоит сам, серым, выбирать нечего; в заявку идёт он', async () => {
    const { page, errors, close } = await open('asRole=construction_manager&asUser=boss-1&asName=Строев%20Борис%20Иванович&noEdit=dp_requests,admin&dpRecipient=0&scope=obj-2')
    try {
      await row(page, 2).waitFor()
      await newRequest(page)
      const d = dialog(page)
      const select = d.getByLabel('Объект')
      await select.locator('option', { hasText: 'Бизнес-центр «Нурлы»' }).waitFor({ state: 'attached' })
      assert.equal(await select.isDisabled(), true)
      assert.deepEqual(await select.locator('option').allTextContents(), ['Бизнес-центр «Нурлы»'])
      assert.equal(await d.locator('.dpr-label').first().innerText(), 'Объект', 'не обязательное поле: выбирать нечего')
      const look = await select.evaluate((el) => {
        const s = getComputedStyle(el)
        const field = getComputedStyle(el.closest('.dpr-dialog').querySelector('textarea'))
        return { bg: s.backgroundColor, fieldBg: field.backgroundColor }
      })
      assert.notEqual(look.bg, look.fieldBg, 'серое, а не как поле ввода')

      await attachConcept(page)
      await d.getByRole('button', { name: 'Создать заявку' }).click()
      await d.waitFor({ state: 'detached' })
      await row(page, 100).waitFor()
      const saved = await page.evaluate(() => window.__fakeDb.dp_requests.find((r) => r.request_number === 100))
      assert.equal(saved.object_id, 'obj-2')
      assert.match(await row(page, 100).innerText(), /Бизнес-центр «Нурлы»/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('работающий с заявками заполняет поданную по мере готовности; незаполненное видно словами', async () => {
    const { page, errors, close } = await open('dpRecipient=0')
    try {
      await row(page, 1).waitFor()
      await addShortRequest(page)
      assert.equal((await row(page, 50).innerText()).match(/не заполнено/g).length, 4, 'объект, договор, сумма, ответственный')
      assert.doesNotMatch(await row(page, 50).innerText(), /0,00/)

      await row(page, 50).getByRole('button', { name: 'Изменить заявку № 50' }).click()
      const d = dialog(page)
      assert.equal(await d.getByLabel('Сумма, ₽').inputValue(), '')
      assert.equal(await d.getByLabel('Ответственный').isDisabled(), true, 'объект не выбран')
      await d.getByRole('textbox', { name: /^Договор/ }).fill('Договор пока без объекта')
      await d.getByRole('button', { name: 'Сохранить' }).click()
      await d.waitFor({ state: 'detached' })
      await row(page, 50).getByText('Договор пока без объекта').waitFor()
      assert.equal((await row(page, 50).innerText()).match(/не заполнено/g).length, 3, 'заполнять можно частями')

      await row(page, 50).getByRole('button', { name: 'Изменить заявку № 50' }).click()
      assert.equal(await d.getByRole('textbox', { name: /^Договор/ }).inputValue(), 'Договор пока без объекта')
      await fillWorkFields(page)
      await d.getByRole('button', { name: 'Сохранить' }).click()
      await d.waitFor({ state: 'detached' })
      await page.waitForFunction(() => window.__fakeDb.dp_requests.find((r) => r.id === 'dp-short').amount === 1500000.5)
      const text = await row(page, 50).innerText()
      assert.doesNotMatch(text, /не заполнено/)
      assert.match(text, /ЖК «Северный квартал»[\s\S]*Договор на монолит[\s\S]*Понятийка короткая\.pdf[\s\S]*1\s500\s000,50[\s\S]*Экономов/)
      const saved = await page.evaluate(() => window.__fakeDb.dp_requests.find((r) => r.id === 'dp-short'))
      assert.equal(saved.object_id, 'obj-1')
      assert.equal(saved.responsible_contact_id, 'ct-econ')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('работающий с заявками создаёт сам: поля отдела сразу в форме, сумма проверяется', async () => {
    const { page, close } = await open('dpRecipient=0')
    try {
      await row(page, 1).waitFor()
      await newRequest(page)
      const d = dialog(page)
      await attachConcept(page)
      await fillWorkFields(page)
      await fillNote(page)
      const submit = d.getByRole('button', { name: 'Создать заявку' })
      assert.equal(await submit.isDisabled(), false)
      await submit.click()
      await d.waitFor({ state: 'detached' })
      const text = await row(page, 100).innerText()
      assert.match(text, /Договор на монолит[\s\S]*1\s500\s000,50[\s\S]*Экономов[\s\S]*Новый подрядчик/)
    } finally { await close() }
  })

  it('файл не того типа не принимается; перетаскивание и удаление из списка', async () => {
    const { page, close } = await open(ECONOMIST)
    try {
      await newRequest(page)
      await attachConcept(page, { name: 'virus.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('x') })
      assert.match(await dialog(page).locator('.dpr-error-line').innerText(), /нужен PDF, Word или скан/)
      await attachConcept(page, { name: 'Расчёт.xlsx', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from('x') })
      assert.match(await dialog(page).locator('.dpr-error-line').innerText(), /нужен PDF, Word или скан/, 'соглашение Excel-файлом не принимается')
      await attachConcept(page)
      const drop = page.locator('[data-testid="dpr-concept-files"]')
      assert.match(await drop.innerText(), /Понятийное\.pdf/)
      await drop.getByRole('button', { name: 'Убрать Понятийное.pdf' }).click()
      assert.doesNotMatch(await drop.innerText(), /Понятийное\.pdf/)
      const data = await page.evaluateHandle(() => {
        const dt = new DataTransfer()
        dt.items.add(new File(['%PDF'], 'Брошенное.pdf', { type: 'application/pdf' }))
        return dt
      })
      await drop.dispatchEvent('drop', { dataTransfer: data })
      assert.match(await drop.innerText(), /Брошенное\.pdf/)
    } finally { await close() }
  })

  it('сбой загрузки файла: заявка не появляется, черновик убран, форма заполнена для повтора', async () => {
    const { page, close } = await open(`${ECONOMIST}&dpFailUpload=1`)
    try {
      await row(page, 1).waitFor()
      await newRequest(page)
      await fillNote(page)
      await attachBoth(page)
      await dialog(page).getByRole('button', { name: 'Создать заявку' }).click()
      await dialog(page).locator('.dpr-error').waitFor()
      assert.match(await dialog(page).locator('.dpr-error').innerText(), /Хранилище не ответило/)
      assert.equal(await dialog(page).getByLabel('Примечание').inputValue(), 'Новый подрядчик по монолиту')
      assert.equal(await page.evaluate(() => window.__fakeDb.dp_requests.filter((r) => r.status === 'draft').length), 0, 'черновик убран')
    } finally { await close() }
  })

  it('база отказала на подаче: причина словами, заявки нет', async () => {
    const { page, close } = await open(ECONOMIST)
    try {
      await row(page, 1).waitFor()
      await page.evaluate(() => {
        // Файл «потерялся» до подачи: страница не знает, отказывает база.
        const trigger = window.__fakeTriggers.dp_requests
        window.__fakeTriggers.dp_requests = (r, old) => {
          if (old?.status === 'draft' && r.status === 'new') {
            window.__fakeDb.s3_documents = window.__fakeDb.s3_documents.filter((d) => d.owner_id !== r.id)
          }
          trigger(r, old)
        }
      })
      await newRequest(page)
      await fillNote(page)
      await attachBoth(page)
      await dialog(page).getByRole('button', { name: 'Создать заявку' }).click()
      await dialog(page).locator('.dpr-error').waitFor()
      assert.match(await dialog(page).locator('.dpr-error').innerText(), /без понятийного соглашения/)
      assert.equal(await page.evaluate(() => window.__fakeDb.dp_requests.filter((r) => !r.request_number).length), 0)
    } finally { await close() }
  })

  it('ответственный (форма работающего с заявками): сам вошедший без карточки, смена объекта, объект без сотрудников', async () => {
    const { page, close } = await open('asRole=construction_manager&asUser=boss-2&asName=Новиков%20Пётр%20Ильич&noEdit=admin&dpRecipient=0')
    try {
      await newRequest(page)
      const d = dialog(page)
      assert.equal(await d.getByLabel('Ответственный').isDisabled(), true, 'объект не выбран')
      await d.getByLabel('Объект').selectOption({ label: 'ЖК «Северный квартал»' })
      const resp = d.getByLabel('Ответственный')
      assert.deepEqual((await resp.locator('option').allTextContents()).slice(1), [
        'Новиков Пётр Ильич · Руководитель строительства', 'Экономов Андрей Петрович · Экономист объекта', 'Строев Борис Иванович · Руководитель строительства',
      ])
      assert.equal(await resp.inputValue(), 'me', 'подставлен сам вошедший')
      await resp.selectOption({ label: 'Строев Борис Иванович · Руководитель строительства' })
      await d.getByLabel('Объект').selectOption({ label: 'Склад без сотрудников' })
      assert.match(await d.innerText(), /не указаны экономист и руководитель строительства/)
      assert.equal(await resp.inputValue(), 'ct-boss:construction_manager', 'человек есть и в новом списке: выбор не сбрасывается')
      await d.getByLabel('Объект').selectOption({ label: 'Бизнес-центр «Нурлы»' })
      assert.equal(await resp.inputValue(), 'me', 'на этом объекте его нет: снова сам вошедший')
    } finally { await close() }
  })

  it('на странице заявок подать нельзя: кнопки «+ Новая заявка» нет, ссылка ведёт в «Реестр по договорам»', async () => {
    const { page, errors, close } = await open(ECONOMIST)
    try {
      await row(page, 1).waitFor()
      const pageRoot = page.locator('.dp-requests-page')
      assert.equal(await pageRoot.getByRole('button', { name: /Новая заявка/ }).count(), 0)
      const hint = pageRoot.locator('.dpr-create-hint')
      assert.equal(await hint.getAttribute('href'), '/contracts/registry')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без права создания кнопки нет; без права работы статус — только показ', async () => {
    const { page, close } = await open('asRole=finance&asUser=fin-1&noEdit=dp_requests,dp_requests_create,admin&dpRecipient=0')
    try {
      await row(page, 1).waitFor()
      assert.equal(await page.locator('.cr-dp-add').count(), 0)
      assert.equal(await page.locator('.dpr-create-hint').count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Уведомления' }).count(), 0)
      assert.equal(await row(page, 1).locator('select').count(), 0)
      assert.equal(await row(page, 1).getByRole('button', { name: /Изменить заявку/ }).count(), 0)
      assert.equal(await row(page, 1).getByText('+ файл').count(), 0)
      assert.match(await row(page, 1).locator('.status-badge').innerText(), /Новая/)
    } finally { await close() }
  })

  it('автор: в своей новой заявке правит только примечание и удаляет её; взятую в работу и чужую — нет; статус не меняет', async () => {
    const { page, close } = await open('asRole=economist_object&asUser=author-x&noEdit=dp_requests,admin&dpRecipient=0')
    try {
      await row(page, 1).waitFor()
      await page.evaluate(() => {
        const db = window.__fakeDb.dp_requests
        db.find((r) => r.id === 'dp-1').created_by = 'author-x'
        db.find((r) => r.id === 'dp-2').created_by = 'author-x'
        window.__fakeTouch('dp_requests')
      })
      await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')) })
      await row(page, 1).getByRole('button', { name: 'Изменить заявку № 1' }).waitFor()
      assert.equal(await row(page, 2).getByRole('button', { name: /Изменить заявку/ }).count(), 0, 'уже в работе')
      assert.equal(await row(page, 3).getByRole('button', { name: /Изменить заявку/ }).count(), 0, 'чужая')
      assert.equal(await row(page, 1).locator('select').count(), 0)

      await row(page, 1).getByRole('button', { name: 'Изменить заявку № 1' }).click()
      const d = dialog(page)
      assert.deepEqual(await d.locator('.dpr-label').allTextContents(), ['Примечание'], 'файлы — в строке, поля отдела ему не показаны')
      assert.equal(await d.getByLabel('Примечание').inputValue(), 'Причина заявки 1')
      await d.getByLabel('Примечание').fill('Новое примечание автора')
      await d.getByRole('button', { name: 'Сохранить' }).click()
      await d.waitFor({ state: 'detached' })
      await row(page, 1).getByText('Новое примечание автора').waitFor()
      const kept = await page.evaluate(() => window.__fakeDb.dp_requests.find((r) => r.id === 'dp-1'))
      assert.equal(kept.contract_title, 'Договор № 1', 'заполненное отделом не задето')
      assert.equal(kept.amount, 1000001)
      assert.equal(kept.responsible_contact_id, 'ct-econ')

      await row(page, 1).getByRole('button', { name: 'Удалить заявку № 1' }).click()
      await row(page, 1).waitFor({ state: 'detached' })
      await page.locator('.status-tab', { hasText: 'Удалённые' }).click()
      await row(page, 1).getByRole('button', { name: 'Восстановить заявку № 1' }).click()
      await row(page, 1).waitFor({ state: 'detached' })
    } finally { await close() }
  })

  it('работа с заявкой: статус меняется и переносит во вкладку', async () => {
    const { page, close } = await open('dpRecipient=0')
    try {
      await row(page, 1).waitFor()
      await row(page, 1).getByLabel('Статус заявки № 1').selectOption({ label: 'В работе' })
      await page.waitForFunction(() => window.__fakeDb.dp_requests.find((r) => r.id === 'dp-1').status === 'in_work')
      await page.locator('.status-tab', { hasText: 'В работе' }).click()
      await row(page, 1).waitFor()
      assert.equal(await page.locator('.status-tab', { hasText: 'Новые' }).locator('.tab-count').innerText(), '1')
    } finally { await close() }
  })

  it('последний файл соглашения: удалить нельзя, заменить можно; второй — удаляется; документы можно убрать совсем', async () => {
    const { page, close } = await open('dpRecipient=0')
    try {
      await row(page, 1).waitFor()
      assert.equal(await row(page, 1).getByRole('button', { name: 'Удалить Понятийка 1.pdf' }).count(), 0)
      assert.equal(await row(page, 1).getByRole('button', { name: 'Удалить Договор 1.docx' }).count(), 1, 'документ необязателен')
      assert.equal(await row(page, 4).getByRole('button', { name: 'Удалить Понятийка 4.pdf' }).count(), 1, 'файла два — можно')

      const files = (category) => page.evaluate((c) => window.__fakeDb.s3_documents.filter((d) => d.owner_id === 'dp-1' && d.doc_category === c).map((d) => d.file_name), category)
      const replace = async (column, name) => {
        const [chooser] = await Promise.all([page.waitForEvent('filechooser'), row(page, 1).locator('td').nth(column).getByRole('button', { name: 'заменить' }).click()])
        await chooser.setFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF') })
        await row(page, 1).getByText(name).waitFor()
      }
      await replace(3, 'Новая понятийка.pdf')
      await row(page, 1).getByText('Понятийка 1.pdf').waitFor({ state: 'detached' })
      assert.deepEqual(await files('dp_concept_agreement'), ['Новая понятийка.pdf'])
      await replace(2, 'Новый договор.pdf')
      await row(page, 1).getByText('Договор 1.docx').waitFor({ state: 'detached' })
      assert.deepEqual(await files('dp_contract_doc'), ['Новый договор.pdf'])
      await row(page, 1).getByRole('button', { name: 'Удалить Новый договор.pdf' }).click()
      await row(page, 1).getByText('Новый договор.pdf').waitFor({ state: 'detached' })
      assert.deepEqual(await files('dp_contract_doc'), [])
      assert.equal(await row(page, 1).getByText('нет файла').count(), 0, 'документов нет — и не надо')
    } finally { await close() }
  })

  it('большое окно: на любой странице, только кнопкой; «Понятно» гасит в базе', async () => {
    const { page, errors, close } = await open('dpAlerts=1', { ready: '.dpa-dialog', route: '/stand/dp-alert' })
    try {
      const alert = page.locator('.dpa-dialog')
      const text = await alert.innerText()
      assert.match(text, /Новая заявка на заключение ДП/)
      assert.match(text, /№ 1/)
      assert.match(text, /ЖК «Северный квартал»/)
      assert.match(text, /Договор № 1/)
      assert.match(text, /1\s000\s001,00\s₽/)
      assert.match(text, /Экономов Андрей Петрович/)
      assert.match(text, /Причина заявки 1/)
      assert.match(text, /Автор Заявки/)
      const box = await alert.boundingBox()
      assert.ok(box.width > 700, `большое окно: ширина ${box.width}`)
      const overlay = await page.locator('.dpa-overlay').evaluate((el) => {
        const s = getComputedStyle(el)
        return { position: s.position, zIndex: Number(s.zIndex) }
      })
      assert.equal(overlay.position, 'fixed', 'стили окна не зависят от страницы')
      assert.ok(overlay.zIndex > 1250, 'выше окон и полосы меню')

      await page.keyboard.press('Escape')
      await page.mouse.click(5, 5)
      assert.equal(await alert.isVisible(), true, 'Escape и щелчок мимо не закрывают')
      assert.deepEqual(await page.evaluate(() => window.__dpAcks), [])

      assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Понятно', 'щелчок мимо не снял фокус с кнопки')
      await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Открыть заявку', 'Tab — по кнопкам окна')
      await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Понятно', 'из окна не выходит')
      await page.getByRole('button', { name: 'Понятно' }).click()
      await alert.waitFor({ state: 'detached' })
      await page.waitForFunction(() => window.__dpAcks.length === 1)
      assert.deepEqual(await page.evaluate(() => window.__dpAcks), [['dp-1']])
      await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')) })
      await page.waitForTimeout(100)
      assert.equal(await alert.count(), 0, 'прочитанное не возвращается')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('большое окно о только что поданной заявке: только то, что есть, сумма не притворяется нулём', async () => {
    const { page, errors, close } = await open(ECONOMIST.replace('&dpRecipient=0', ''))
    try {
      await row(page, 1).waitFor()
      await newRequest(page)
      await attachConcept(page)
      await dialog(page).getByRole('button', { name: 'Создать заявку' }).click()
      await page.locator('.dpa-dialog').waitFor()
      const text = await page.locator('.dpa-dialog').innerText()
      assert.match(text, /№ 100/)
      assert.match(text, /Объект не указан/)
      assert.doesNotMatch(text, /Сумма|0,00|Договор\s|Ответственный|Примечание/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('большое окно: несколько заявок списком, одна открывается — строка подсвечена, остальные ждут', async () => {
    const { page, close } = await open('dpAlerts=3&tab=completed')
    try {
      await page.locator('.dpa-dialog').waitFor()
      assert.match(await page.locator('.dpa-dialog').innerText(), /3 новые заявки/)
      assert.equal(await page.locator('.dpa-card').count(), 3)
      await page.locator('.dpa-card', { hasText: '№ 2' }).getByRole('button', { name: 'Открыть заявку' }).click()
      await row(page, 2).locator('xpath=self::tr[contains(@class, "dpr-highlight")]').waitFor()
      await page.waitForFunction(() => window.__dpAcks.length === 1)
      assert.deepEqual(await page.evaluate(() => window.__dpAcks), [['dp-2']])
      assert.equal(await page.locator('.dpa-card').count(), 2, 'остальные ещё не прочитаны')
      await page.getByRole('button', { name: 'Понятно' }).click()
      await page.locator('.dpa-dialog').waitFor({ state: 'detached' })
      await page.waitForFunction(() => window.__dpAcks.length === 2)
      assert.deepEqual((await page.evaluate(() => window.__dpAcks))[1].sort(), ['dp-1', 'dp-3'])
    } finally { await close() }
  })

  it('новая заявка получателя: окно сразу, сведения те же, что в заявке', async () => {
    const { page, close } = await open('')
    try {
      await row(page, 1).waitFor()
      await newRequest(page)
      await fillWorkFields(page)
      await fillNote(page)
      await attachBoth(page)
      await dialog(page).getByRole('button', { name: 'Создать заявку' }).click()
      await page.locator('.dpa-dialog').waitFor()
      assert.match(await page.locator('.dpa-dialog').innerText(), /№ 100[\s\S]*Договор на монолит[\s\S]*1\s500\s000,50\s₽/)
    } finally { await close() }
  })

  it('не получатель: окна нет и базу не опрашивает', async () => {
    const { page, close } = await open('dpRecipient=0&dpAlerts=1')
    try {
      await row(page, 1).waitFor()
      await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')) })
      await page.waitForTimeout(150)
      assert.equal(await page.locator('.dpa-dialog').count(), 0)
      const rpc = await page.evaluate(() => window.__supabaseStats.requests.filter((r) => r.table === 'rpc:dp_request_my_alerts').length)
      assert.equal(rpc, 0)
    } finally { await close() }
  })

  it('заявка из окна удалена или не на своих объектах: сказано словами', async () => {
    const { page, close } = await open('')
    try {
      await row(page, 1).waitFor()
      await page.evaluate(() => window.__navigate('/dp-requests?request=нет-такой'))
      await page.locator('.dpr-page-error').waitFor()
      assert.match(await page.locator('.dpr-page-error').innerText(), /не найдена в реестре/)
    } finally { await close() }
  })

  it('получатели: администратор добавляет и убирает; поиск только среди ещё не добавленных', async () => {
    const { page, close } = await open('')
    try {
      await page.getByRole('button', { name: 'Уведомления' }).click()
      const d = dialog(page)
      await d.getByRole('list', { name: 'Получатели' }).getByText('Стендов Стенд Стендович').waitFor()
      await d.getByPlaceholder('ФИО или почта').fill('коллегова')
      await d.getByRole('button', { name: 'Добавить' }).click()
      await d.getByRole('list', { name: 'Получатели' }).getByText('Коллегова Мария Андреевна').waitFor()
      assert.deepEqual(await page.evaluate(() => window.__fakeDb.dp_request_alert_recipients.map((r) => r.user_id).sort()), ['user-1', 'user-2'])
      assert.equal(await d.getByRole('list', { name: 'Найденные сотрудники' }).getByRole('button', { name: 'Добавить' }).count(), 0)
      await d.getByRole('button', { name: 'Убрать: Коллегова Мария Андреевна' }).click()
      await d.getByRole('list', { name: 'Получатели' }).getByText('Коллегова Мария Андреевна').waitFor({ state: 'detached' })
      await d.getByRole('button', { name: 'Готово' }).click()
      await d.waitFor({ state: 'detached' })
    } finally { await close() }
  })

  it('база без миграции: подсказка, ни кнопок, ни ошибок', async () => {
    const { page, errors, close } = await open('dpMissing=1')
    try {
      await page.getByText('20261227_dp_requests').waitFor()
      assert.equal(await page.locator('.dpr-create-hint').count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Уведомления' }).count(), 0)
      assert.equal(await page.locator('.dpa-dialog').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('телефон: заявки карточками, окно и форма помещаются', async () => {
    const { page, close } = await open('dpAlerts=1', { viewport: { width: 390, height: 780 } })
    try {
      await page.locator('.dpa-dialog').waitFor()
      const box = await page.locator('.dpa-dialog').boundingBox()
      assert.ok(box.x >= 0 && box.x + box.width <= 390, 'окно в ширину экрана')
      await page.getByRole('button', { name: 'Понятно' }).click()
      await page.locator('.mcard').first().waitFor()
      assert.equal(await page.locator('.dpr-table').count(), 0)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert.ok(overflow <= 1, `нет прокрутки вбок: ${overflow}`)
      await newRequest(page)
      const form = await dialog(page).boundingBox()
      assert.ok(form.x >= 0 && form.x + form.width <= 390)
      await dialog(page).getByRole('button', { name: 'Отмена' }).click()
      await addShortRequest2(page)
      const card = page.locator('.mcard', { hasText: '№ 50' })
      assert.doesNotMatch(await card.innerText(), /0,00/, 'незаполненная сумма на телефоне — тоже не ноль')
      assert.match(await card.innerText(), /не заполнено/)
      // Вкладки — одной строкой (рабочий слой переносил их в три ряда), статус — по ширине текста, файл — во всю ширину.
      const tabsY = await page.locator('.status-tab').evaluateAll((els) => [...new Set(els.map((el) => Math.round(el.getBoundingClientRect().top)))])
      assert.equal(tabsY.length, 1, `вкладки в ${tabsY.length} ряда`)
      const status = await page.locator('.mcard .dpr-status-select').first().boundingBox()
      assert.ok(status.width < 200, `статус: ${status.width}px`)
      const file = await card.locator('.dpr-file-name').first().boundingBox()
      assert.ok(file.width > 250, `имя файла: ${file.width}px`)
      await newRequest(page)
      assert.equal(await dialog(page).getByLabel('Примечание').evaluate((el) => getComputedStyle(el).fontSize), '16px')
    } finally { await close() }
  })
})
