// Регистрация подрядчика на сайте в браузере (стенд tests/tender/ui/cabinet.html, сервер — подделка на уровне сети):
//   • кабинет подрядчика с регистрации: тендеры, расценка, «Моя компания»; ни договоров, ни файлов, ни загрузки КП; позиции
//     приходят с сервера, файл ВОР не скачивается; ни одного запроса вне короткого списка шлюза;
//   • подрядчик от администратора — как раньше;
//   • форма: поля проверяются до отправки, задача на вычисление решается, ловушка пуста, пароля в заявке нет;
//   • ссылка из письма: токен убран из адреса, видно, что подтверждается; пароль задаёт хозяин почты; ответ не выдаёт причину проверки;
//   • подтверждение с почты компании, новый пароль, закрытая регистрация; вкладка заявок у администратора.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const ALLOW = JSON.parse(fs.readFileSync(path.join(REPO, 'server', 'osp-api', 'src', 'data', 'allow-self-contractor.json'), 'utf8'))
const TOKEN = 'A'.repeat(43)

describe('Регистрация подрядчика на сайте: страницы', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open(query = '', { hash = '', viewport = { width: 1400, height: 950 }, api = {} } = {}) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    const seen = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
    page.on('dialog', (d) => d.accept())
    // Только адреса сервера: модули стенда (/src/api/…) идут как обычно.
    await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
      const req = route.request()
      const url = new URL(req.url())
      const body = req.postData() ? JSON.parse(req.postData()) : null
      seen.push({ method: req.method(), path: url.pathname, search: url.search, body })
      const answer = api[`${req.method()} ${url.pathname}`]
      const res = typeof answer === 'function' ? answer(body) : answer
      await route.fulfill({ status: res?.status ?? 404, contentType: 'application/json', body: JSON.stringify(res?.body ?? { error: 'Not found' }) })
    })
    await page.goto(`${stand.url.replace('index.html', 'cabinet.html')}?latency=0${query}${hash}`)
    return { page, errors, seen, close: () => context.close().catch(() => {}) }
  }
  const CHALLENGE = { 'GET /api/auth/register/challenge': { status: 200, body: { challenge: 'abc.1893456000000.8.sig', bits: 8 } } }

  it('кабинет с регистрации: тендеры, расценка, компания; договоров и файлов нет; только разрешённые запросы', async () => {
    const { page, errors, close } = await open('&selfReg=1')
    try {
      await page.locator('table.tenders-registry').waitFor({ timeout: 120000 })
      assert.equal(await page.getByRole('link', { name: 'Открыть тендер № 704' }).count(), 0, 'завершённых тендеров нет')
      const tabs = await page.locator('.cab-tab').allTextContents()
      assert.ok(tabs.some((t) => t.startsWith('Тендеры')) && tabs.includes('Моя компания'), tabs.join())
      assert.ok(!tabs.some((t) => t.startsWith('Договоры')), 'договоров нет')

      await page.getByRole('link', { name: 'Открыть тендер № 857' }).click()
      assert.match(await page.locator('.cab-join').textContent(), /Откроются файлы ВОР и расценка на сайте/)
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      await page.locator('.bid-tab', { hasText: 'Материалы' }).locator('.bid-tab-count', { hasText: '2' }).waitFor({ timeout: 30000 })
      assert.equal(await page.locator('.cab-docs').count(), 0, 'списка файлов нет')
      assert.equal(await page.locator('.cab-section h3', { hasText: 'Документы тендера' }).count(), 0)

      // Файл ВОР — по id, через свой маршрут сервера (ключа и строк s3_documents у этой учётки нет).
      const asked = []
      await page.route('**/api/fn/bid-vor-file', (route) => {
        asked.push(route.request().postDataJSON())
        route.fulfill({ json: { presigned_url: `${new URL(page.url()).origin}/fake-storage/vor.xlsx`, expires_in: 3600, file_name: 'ВОР паркинга.xlsx' } })
      })
      await page.route('**/fake-storage/vor.xlsx', (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'xlsx' }))
      const [saved] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Скачать ВОР «ВОР паркинга»' }).click()])
      assert.equal(saved.suggestedFilename(), 'ВОР паркинга.xlsx')
      assert.deepEqual(asked, [{ file_id: 'doc-vor' }])

      // Сервер отказал — причина под кнопкой, страница работает.
      await page.unroute('**/api/fn/bid-vor-file')
      await page.route('**/api/fn/bid-vor-file', (route) => route.fulfill({ status: 404, json: { error: 'Файл недоступен: приём предложений закрыт или заявка не подана' } }))
      await page.getByRole('button', { name: 'Скачать ВОР «ВОР паркинга»' }).click()
      await page.locator('.bid-vor-files .bid-note', { hasText: 'Файл недоступен' }).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Загрузить КП' }).count(), 0)
      assert.match(await page.locator('.bid-conditions').textContent(), /ГУ в размере 5 %/, 'особые условия — с сервера')

      const concrete = page.locator('.bid-table tbody tr', { hasText: 'Бетон В25 W8' })
      assert.match(await concrete.locator('.bid-col-vol').textContent(), /130,5/)
      await concrete.locator('.bid-money-input').fill('7800')
      await concrete.locator('.bid-money-input').press('Enter')
      await page.locator('.bid-save', { hasText: 'Все цены сохранены' }).waitFor({ timeout: 10000 })
      await page.locator('.bid-tab', { hasText: 'Структура КП' }).click()
      await page.locator('.bid-kp-table').waitFor()

      // Разобрать ещё не успели — подсказка, а не ошибка.
      await page.locator('.cab-back').click()
      await page.getByRole('link', { name: 'Открыть тендер № 905' }).click()
      await page.locator('.bid-note', { hasText: 'Готовим позиции ВОР' }).waitFor()
      assert.equal(await page.locator('.cab-decline').count(), 0, 'отказа от участия у учётки с регистрации нет')

      await page.locator('.cab-tab', { hasText: 'Моя компания' }).click()
      const company = page.locator('.cab-org')
      await company.getByText('7707083893').waitFor()
      // Название компании в шапке кабинета — свой класс: стили вкладки его не задевают.
      assert.equal(await page.locator('.cab-header .cab-company').evaluate((el) => getComputedStyle(el).display), 'block')
      for (const text of ['ООО Альфа', '770701001', 'Москва, ул. Строителей, 1', 'Монолитные работы', 'Альфин А. А.', '+79161234567', 'alfin@alpha.ru', '1234', 'Директоров Д. Д.', 'dir@alpha.ru']) {
        assert.ok(await company.getByText(text, { exact: true }).count(), text)
      }

      // Каждый запрос страницы — из короткого списка шлюза; файлы и хранилище не трогались.
      const requests = await page.evaluate(() => window.__supabaseStats.requests.map((r) => ({ table: r.table, op: r.op })))
      assert.ok(requests.length > 0)
      for (const r of requests) {
        if (r.table.startsWith('rpc:')) assert.ok(ALLOW.rpc[r.table.slice(4)], `функция вне списка: ${r.table}`)
        else assert.ok(ALLOW.tables[r.table], `таблица вне списка: ${r.table}`)
      }
      assert.ok(!requests.some((r) => r.table === 's3_documents' || r.table === 'tender_estimate_items'), 'файлы и смету не запрашивали')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('подрядчик от администратора: файлы и расценка из файла — как раньше; прошлых тендеров и договоров нет и у него', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('table.tenders-registry').waitFor({ timeout: 120000 })
      assert.ok(!(await page.locator('.cab-tab').allTextContents()).some((t) => t.startsWith('Договоры')))
      assert.equal(await page.getByRole('link', { name: 'Открыть тендер № 704' }).count(), 0)
      await page.getByRole('link', { name: 'Открыть тендер № 857' }).click()
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      await page.locator('.cab-doc-name', { hasText: 'ВОР паркинга.xlsx' }).waitFor()
      await page.locator('.bid-tab', { hasText: 'Работы' }).locator('.bid-tab-count', { hasText: '2' }).waitFor({ timeout: 60000 })
      assert.equal((await page.evaluate(() => window.__bidCalls.filter((c) => c.fn === 'bid_positions'))).length, 0, 'позиции — из файла')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('заявка: ошибки полей до отправки; ловушка пуста; задача решена; ответ сервера по полю — у поля', async () => {
    let answer = { status: 400, body: { error: 'Домен почты не принимает письма', code: 'OSP_SIGNUP_FIELD', field: 'email' } }
    const { page, errors, seen, close } = await open('&page=signup&view=register', {
      api: { ...CHALLENGE, 'POST /api/auth/register': () => answer },
    })
    try {
      await page.getByLabel('Организация *').waitFor()
      const fill = async (label, value) => page.getByLabel(label, { exact: true }).fill(value)
      await page.getByRole('button', { name: 'Зарегистрироваться' }).click()
      await page.locator('.login-field-error', { hasText: 'Проверьте адрес почты' }).or(page.locator('.login-field-error', { hasText: 'Укажите почту' })).first().waitFor()
      assert.equal(seen.length, 0, 'с ошибками на сервер ничего не уходит')

      await fill('Рабочая почта *', 'ivanov@company.ru')
      await fill('Организация *', '«Ромашка»')
      await fill('ИНН *', '7707083894')
      await page.getByRole('button', { name: 'Зарегистрироваться' }).click()
      await page.locator('.login-field-error', { hasText: 'ИНН не прошёл проверку' }).waitFor()

      await fill('ИНН *', '7707083893')
      await fill('КПП', '770701001')
      await fill('Контактное лицо *', 'Иванов Иван')
      await fill('Контактный телефон *', '8 916 123-45-67')
      assert.equal(await page.locator('input[type=password]').count(), 0, 'пароля в заявке нет')
      await page.getByRole('button', { name: 'Зарегистрироваться' }).click()
      await page.locator('.login-field-error', { hasText: 'Нужно согласие' }).waitFor()
      await page.locator('.login-consent input').check()
      assert.equal(seen.length, 0)

      await page.getByRole('button', { name: 'Зарегистрироваться' }).click()
      await page.locator('.login-field-error', { hasText: 'не принимает письма' }).waitFor()
      const sent = seen.find((r) => r.path === '/api/auth/register')
      assert.equal(sent.search, '', 'в адресе ничего нет')
      assert.equal(sent.body.email, 'ivanov@company.ru')
      assert.equal(sent.body.inn, '7707083893')
      assert.equal(sent.body.kpp, '770701001')
      assert.equal(sent.body.legalForm, 'ООО')
      assert.equal(sent.body.companyName, '«Ромашка»')
      assert.equal(sent.body.phone, '+79161234567')
      assert.ok(!('password' in sent.body), 'пароля в заявке нет')
      assert.equal(sent.body.consent, true)
      assert.ok(!('website' in sent.body), 'ловушка пуста')
      const hash = crypto.createHash('sha256').update(`${sent.body.challenge}:${sent.body.answer}`).digest()
      assert.equal(hash[0], 0, 'задача решена')
      const trap = await page.locator('#signup-website').boundingBox()
      assert.ok(!trap || trap.x < 0, 'поле-ловушка за экраном')

      answer = { status: 202, body: { ok: true } }
      await page.getByRole('button', { name: 'Зарегистрироваться' }).click()
      await page.locator('.login-success', { hasText: 'ivanov@company.ru' }).waitFor()
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('поля заявки: ИНН и телефон — только цифры, КПП — ещё буквы на своём месте; не больше положенного; курсор при правке не уезжает', async () => {
    const { page, errors, close } = await open('&page=signup&view=register')
    try {
      const inn = page.getByLabel('ИНН *', { exact: true })
      const kpp = page.getByLabel('КПП', { exact: true })
      const phone = page.getByLabel('Контактный телефон *', { exact: true })
      const ext = page.getByLabel('доб.', { exact: true })
      await inn.waitFor()

      // Набор с клавиатуры: буквы и знаки не появляются, лишние цифры тоже.
      await inn.pressSequentially('77а07-08ь3 893')
      assert.equal(await inn.inputValue(), '7707083893')
      await inn.pressSequentially('12345')
      assert.equal(await inn.inputValue(), '770708389312', 'форма не названа — до 12 цифр')
      await inn.fill('ИНН 7707083893')
      assert.equal(await inn.inputValue(), '7707083893', 'вставка с подписью')
      assert.equal(await page.locator('#signup-inn').getAttribute('maxlength'), null, 'вставленное не обрезается до очистки')

      await kpp.pressSequentially('kpp7707 01001999')
      assert.equal(await kpp.inputValue(), '770701001')
      await kpp.fill('')
      await kpp.pressSequentially('77ab01ab001')
      assert.equal(await kpp.inputValue(), '7701AB001', 'буквы — в 5–6 знаках, заглавные')
      await kpp.fill('7701АВ001')
      assert.equal(await kpp.inputValue(), '7701AB001', 'русские А и В — как латинские')
      // Правка КПП в середине: курсор после той же буквы.
      await kpp.focus()
      await page.keyboard.press('Home')
      for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowRight')
      await page.keyboard.type('я')
      assert.equal(await kpp.inputValue(), '7701AB001')
      assert.equal(await kpp.evaluate((el) => el.value.slice(0, el.selectionStart)), '7701A')

      // Телефон: «+7» стоит перед полем, вводится остальное; маска по ходу набора.
      assert.equal(await page.locator('.login-input-group .login-input-affix').first().textContent(), '+7')
      await phone.pressSequentially('9x16')
      assert.equal(await phone.inputValue(), '(916')
      await phone.pressSequentially('1234567999')
      assert.equal(await phone.inputValue(), '(916)123-45-67', 'не больше 10 цифр')
      await ext.pressSequentially('доб12345678')
      assert.equal(await ext.inputValue(), '123456', 'добавочный — до 6 цифр')

      // Правка цифры в середине: курсор остаётся на месте, буква его не сдвигает.
      await phone.focus()
      await page.keyboard.press('Home')
      for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Backspace')
      assert.equal(await phone.inputValue(), '(916)234-56-7')
      await page.keyboard.type('я')
      await page.keyboard.type('1')
      assert.equal(await phone.inputValue(), '(916)123-45-67')
      assert.equal(await phone.evaluate((el) => el.value.slice(0, el.selectionStart)), '(916)1')

      // Привычные записи номера.
      for (const [typed, shown] of [['89161234567', '(916)123-45-67'], ['+7 (916) 123-45-67', '(916)123-45-67'], ['8121234567', '(812)123-45-67'], ['88121234567', '(812)123-45-67']]) {
        await phone.fill('')
        await phone.pressSequentially(typed)
        assert.equal(await phone.inputValue(), shown, typed)
      }
      await ext.fill('')
      await phone.fill('+7 916 123-45-67 доб. 321')
      assert.equal(await phone.inputValue(), '(916)123-45-67', 'вставлен с добавочным')
      assert.equal(await ext.inputValue(), '321')

      // Неполный номер и почта без @ — замечание сразу при выходе из поля; исправил — пропало.
      await phone.fill('916123')
      await ext.focus()
      await page.locator('.login-field-error', { hasText: '10 цифр' }).waitFor()
      await phone.fill('9161234567')
      assert.equal(await page.locator('.login-field-error').count(), 0)
      const email = page.getByLabel('Рабочая почта *', { exact: true })
      assert.equal(await email.getAttribute('maxlength'), '100')
      await email.fill('ivanov.company.ru')
      await inn.focus()
      await page.locator('.login-field-error', { hasText: 'нужен знак @' }).waitFor()
      await email.fill('ivanov@company.ru')
      await inn.focus()
      assert.equal(await page.locator('.login-field-error').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('организация: выбирать не нужно — форма встаёт сама из названия или по ИНН; список только поправить и сужается по ИНН', async () => {
    const { page, errors, seen, close } = await open('&page=signup&view=register', {
      api: { ...CHALLENGE, 'POST /api/auth/register': () => ({ status: 202, body: { ok: true } }) },
    })
    try {
      const form = page.getByLabel('Форма организации')
      const name = page.getByLabel('Организация *', { exact: true })
      const inn = page.getByLabel('ИНН *', { exact: true })
      const hint = page.locator('.login-field-hint')
      const kpp = page.getByLabel('КПП', { exact: true })
      const options = () => form.locator('option').allTextContents()
      await name.waitFor()
      assert.equal(await form.inputValue(), '', 'ничего не выбрано и выбирать не обязательно')
      assert.deepEqual(await options(), ['—', 'ООО', 'ИП', 'СЗ', 'АО', 'ПАО', 'ЗАО', 'ОАО', 'НАО', 'АНО', 'ГУП', 'МУП', 'ФГУП', 'ГБУ'])
      assert.match(await hint.textContent(), /определится сама/)

      // Написали с формой: она ушла в колонку, в названии её нет.
      await name.pressSequentially('АО "Гамма"')
      assert.equal(await name.inputValue(), '"Гамма"')
      assert.equal(await form.inputValue(), 'АО')
      assert.equal(await hint.textContent(), 'В заявке: АО "Гамма"')
      // Очистил название — форма снова определяется сама.
      await name.fill('')
      assert.equal(await form.inputValue(), '')
      await name.pressSequentially('ИПотека')
      assert.equal(await name.inputValue(), 'ИПотека', 'часть слова — не форма')
      assert.equal(await form.inputValue(), '')
      assert.equal(await hint.textContent(), 'В заявке: ИПотека', 'без формы — название как есть')

      // Формы в названии нет — по ИНН, это видно; при 12 цифрах в списке только ИП и СЗ, КПП нет.
      await inn.fill('500100732259')
      assert.equal(await form.inputValue(), 'ИП')
      assert.deepEqual(await options(), ['—', 'ИП', 'СЗ'])
      assert.equal(await kpp.count(), 0, 'у ИП КПП нет')
      assert.equal(await hint.textContent(), 'В заявке: ИП ИПотека · определена по ИНН, если не так — выберите другую')
      await inn.fill('7707083893')
      assert.equal(await form.inputValue(), 'ООО')
      assert.ok((await options()).includes('АО') && !(await options()).includes('ИП'))
      assert.equal(await kpp.count(), 1)
      await kpp.fill('7701AB001')

      // Догадка неверна — поправить: выбранное не сбивается и подсказка про ИНН уходит; другая форма в названии — часть названия.
      await form.selectOption('ПАО')
      assert.equal(await form.inputValue(), 'ПАО')
      await name.fill('СЗ Инвест')
      assert.equal(await form.inputValue(), 'ПАО')
      assert.equal(await hint.textContent(), 'В заявке: ПАО СЗ Инвест')
      await inn.focus()
      await page.keyboard.press('End')
      await page.keyboard.type('999')
      assert.equal(await inn.inputValue(), '7707083893', 'у ПАО — 10 цифр')

      // Названной форме ИНН не подходит — причина у поля, в списке форма остаётся.
      await name.fill('')
      await name.fill('ИП Петров П.П.')
      assert.equal(await form.inputValue(), 'ИП')
      assert.ok((await options()).includes('ИП'))
      await page.getByLabel('Рабочая почта *', { exact: true }).fill('a@firm.ru')
      await page.getByLabel('Контактное лицо *', { exact: true }).fill('Иванов Иван')
      await page.getByLabel('Контактный телефон *', { exact: true }).fill('9161234567')
      await page.locator('.login-consent input').check()
      await page.getByRole('button', { name: 'Зарегистрироваться' }).click()
      await page.locator('.login-field-error', { hasText: 'ИНН у ИП — 12 цифр' }).waitFor()
      assert.equal(seen.filter((r) => r.method === 'POST').length, 0, 'с ошибками на сервер ничего не уходит')

      // СЗ: словом в названии; КПП, скрытый сменой формы, не уходит и ошибкой не становится.
      await name.fill('')
      await name.fill('Самозанятый Иванов Иван')
      assert.equal(await form.inputValue(), 'СЗ')
      assert.equal(await hint.textContent(), 'В заявке: СЗ Иванов Иван · СЗ — самозанятый')
      await inn.fill('500100732259')
      await page.getByLabel('доб.', { exact: true }).fill('77')
      await page.getByRole('button', { name: 'Зарегистрироваться' }).click()
      await page.locator('.login-success').waitFor()
      const sent = seen.find((r) => r.path === '/api/auth/register' && r.method === 'POST').body
      assert.equal(sent.legalForm, 'СЗ')
      assert.equal(sent.companyName, 'Иванов Иван')
      assert.equal(sent.inn, '500100732259')
      assert.equal(sent.kpp, null)
      assert.equal(sent.phone, '+79161234567 доб. 77')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }

    // Подрядчик ничего не трогал: написал название и ИНН — форма по ИНН и КПП с буквами ушли в заявке. Убрал форму — название как есть.
    for (const [clear, legalForm] of [[false, 'ООО'], [true, '']]) {
      const run = await open('&page=signup&view=register', { api: { ...CHALLENGE, 'POST /api/auth/register': () => ({ status: 202, body: { ok: true } }) } })
      try {
        await run.page.getByLabel('Организация *', { exact: true }).fill('Гамма')
        await run.page.getByLabel('ИНН *', { exact: true }).fill('7707083893')
        await run.page.getByLabel('КПП', { exact: true }).fill('7701ab001')
        if (clear) await run.page.getByLabel('Форма организации').selectOption('')
        await run.page.getByLabel('Контактное лицо *', { exact: true }).fill('Иванов Иван')
        await run.page.getByLabel('Контактный телефон *', { exact: true }).fill('9161234567')
        await run.page.getByLabel('Рабочая почта *', { exact: true }).fill('a@firm.ru')
        await run.page.locator('.login-consent input').check()
        await run.page.getByRole('button', { name: 'Зарегистрироваться' }).click()
        await run.page.locator('.login-success').waitFor()
        const body = run.seen.find((r) => r.path === '/api/auth/register' && r.method === 'POST').body
        assert.equal(body.legalForm, legalForm)
        assert.equal(body.companyName, 'Гамма')
        assert.equal(body.kpp, '7701AB001')
      } finally {
        await run.close()
      }
    }
  })

  it('регистрация закрыта: формы нет', async () => {
    const { page, close } = await open('&page=signup&view=register&closed=1')
    try {
      await page.getByText('Регистрация на сайте сейчас закрыта').waitFor()
      assert.equal(await page.locator('form').count(), 0)
      assert.equal(await page.locator('.login-contact a').innerText(), 'tender.osp@su10.ru', 'контакт для связи есть и здесь')
    } finally {
      await close()
    }
  })

  it('контакт для связи и каналы СУ-10: почта видна сразу, MAX, Telegram и сайт — ссылками, логотипы без запросов наружу', async () => {
    const { page, errors, close } = await open('&page=signup&view=register&signupMode=manual', { viewport: { width: 1366, height: 700 } })
    const outside = []
    page.on('request', (r) => { if (!new URL(r.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/) && !r.url().startsWith('data:')) outside.push(r.url()) })
    try {
      const mail = page.getByRole('link', { name: 'tender.osp@su10.ru' })
      await mail.waitFor()
      assert.match(await mail.getAttribute('href'), /^mailto:tender\.osp@su10\.ru\?subject=/)
      // Над формой: виден без прокрутки, даже когда форма выше окна.
      const box = await mail.boundingBox()
      assert.ok(box.y >= 0 && box.y + box.height <= 700, `почта в первом экране: ${JSON.stringify(box)}`)
      assert.ok(await page.evaluate(() => document.querySelector('.login-contact').compareDocumentPosition(document.querySelector('form')) & Node.DOCUMENT_POSITION_FOLLOWING))

      const links = await page.locator('.login-channels a').evaluateAll((els) => els.map((a) => ({
        href: a.getAttribute('href'), target: a.target, rel: a.rel, text: a.textContent.trim(), logo: !!a.querySelector('svg'),
      })))
      const common = { target: '_blank', rel: 'noopener noreferrer', logo: true }
      assert.deepEqual(links, [
        { href: 'https://max.ru/id7736255508_biz', text: 'MAX', ...common },
        { href: 'https://t.me/su10official', text: 'Telegram', ...common },
        { href: 'https://su10.ru', text: 'Сайт su10.ru', ...common },
      ])
      // Логотип MAX — настоящий: заливка градиентом определена в самой странице, белый рисунок поверх.
      const max = await page.locator('.login-channels a').first().locator('svg').evaluate((svg) => {
        const rect = svg.querySelector('rect')
        const id = rect.getAttribute('fill').match(/url\(#(.+)\)/)[1]
        return { gradient: !!svg.querySelector(`#${id} stop`), mark: svg.querySelector('path').getAttribute('fill'), width: svg.getBoundingClientRect().width }
      })
      assert.deepEqual(max, { gradient: true, mark: '#fff', width: 18 })
      // Три канала — одной строкой карточки.
      const tops = await page.locator('.login-channels a').evaluateAll((els) => new Set(els.map((a) => Math.round(a.getBoundingClientRect().top))).size)
      assert.equal(tops, 1)
      assert.deepEqual(outside, [], 'запросов наружу нет')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
    // На телефоне: ни прокрутки вбок, ни обрезанной почты.
    const phone = await open('&page=signup&view=register&signupMode=manual', { viewport: { width: 360, height: 700 } })
    try {
      await phone.page.locator('.login-channels a').first().waitFor()
      assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0)
    } finally {
      await phone.close()
    }
  })

  const PREVIEW = { companyName: 'ООО «Ромашка»', inn: '7707083893', contactName: 'Иванов Иван', email: 'ivanov@company.ru' }
  const previewOk = { 'POST /api/auth/register/preview': { status: 200, body: PREVIEW } }
  const setPassword = async (page, password) => {
    await page.getByLabel('Придумайте пароль').fill(password)
    await page.getByLabel('Повторите пароль').fill(password)
    await page.getByRole('button', { name: 'Завершить регистрацию' }).click()
  }

  it('ссылка из письма: токен убран из адреса; видно, что подтверждается; пароль — здесь; проверка не называет причину', async () => {
    const password = 'длинная фраза для входа подрядчика'
    const { page, seen, errors, close } = await open('&page=signup&view=confirm', {
      hash: `#t=${TOKEN}`,
      api: { ...previewOk, 'POST /api/auth/register/confirm': (b) => (b.password === password
        ? { status: 200, body: { status: 'review' } }
        : { status: 400, body: { error: 'Этот пароль слишком распространён', code: 'OSP_SIGNUP_FIELD', field: 'password' } }) },
    })
    try {
      const facts = page.locator('.login-facts')
      await facts.waitFor()
      assert.ok(!page.url().includes(TOKEN), 'токена в адресе нет')
      for (const text of ['ООО «Ромашка»', '7707083893', 'Иванов Иван', 'ivanov@company.ru']) assert.ok((await facts.textContent()).includes(text), text)
      assert.ok(!seen.some((r) => r.path.endsWith('/confirm')), 'открытие ссылки ничего не подтверждает')
      await setPassword(page, 'короткий')
      await page.locator('.login-error', { hasText: 'не меньше 15 знаков' }).waitFor()
      await setPassword(page, 'другая длинная фраза для входа')
      await page.locator('.login-error', { hasText: 'распространён' }).waitFor()
      assert.equal(await page.getByLabel('Придумайте пароль').count(), 1, 'ссылка не сгорела, можно другой пароль')
      await setPassword(page, password)
      const done = page.locator('.login-success')
      await done.waitFor()
      assert.match(await done.textContent(), /проходит проверку/)
      assert.doesNotMatch(await done.textContent(), /чёрн|ЧС|реестр/i)
      assert.deepEqual(seen.at(-1).body, { token: TOKEN, password })
      assert.equal(await page.locator('input[type=password]').count(), 0, 'пароль с экрана убран')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
    const ok = await open('&page=signup&view=confirm', { hash: `#t=${TOKEN}`, api: { ...previewOk, 'POST /api/auth/register/confirm': { status: 200, body: { status: 'active' } } } })
    try {
      await setPassword(ok.page, password)
      await ok.page.locator('.login-success', { hasText: 'Регистрация завершена' }).waitFor()
      assert.equal(await ok.page.getByRole('button', { name: 'Войти' }).count(), 1, 'вход — отдельно, паролем')
    } finally {
      await ok.close()
    }
    const bad = await open('&page=signup&view=confirm', { hash: `#t=${TOKEN}`, api: { 'POST /api/auth/register/preview': { status: 400, body: { error: 'Ссылка устарела', code: 'OSP_SIGNUP_TOKEN' } } } })
    try {
      await bad.page.locator('.login-error', { hasText: 'устарела или уже использована' }).waitFor()
      assert.equal(await bad.page.locator('input[type=password]').count(), 0)
    } finally {
      await bad.close()
    }
    const none = await open('&page=signup&view=confirm')
    try {
      await none.page.locator('.login-error', { hasText: 'устарела или уже использована' }).waitFor()
    } finally {
      await none.close()
    }
  })

  it('подтверждение с почты компании и новый пароль', async () => {
    const claim = await open('&page=signup&view=claim', { hash: `#t=${TOKEN}`, api: {
      'POST /api/auth/register/preview': { status: 200, body: { companyName: 'ООО Старый подрядчик', inn: '7702070139', email: 'stranger@somewhere.ru' } },
      'POST /api/auth/register/claim': (b) => ({ status: 200, body: { status: b.decision === 'deny' ? 'denied' : 'approved' } }),
    } })
    try {
      const facts = claim.page.locator('.login-facts')
      await facts.waitFor()
      for (const text of ['ООО Старый подрядчик', '7702070139', 'stranger@somewhere.ru']) assert.ok((await facts.textContent()).includes(text), text)
      assert.deepEqual(claim.seen.at(-1).body, { token: TOKEN, kind: 'claim' })
      // Первая кнопка, основная, — отказ: подтверждать надо осознанно.
      assert.match(await claim.page.locator('.login-actions button').first().textContent(), /отклонить/)
      await claim.page.getByRole('button', { name: 'Не знаю этого человека — отклонить' }).click()
      await claim.page.locator('.login-success', { hasText: 'Запрос отклонён' }).waitFor()
      assert.deepEqual(claim.seen.at(-1).body, { token: TOKEN, decision: 'deny' })
    } finally {
      await claim.close()
    }
    const reset = await open('&page=signup&view=reset', { hash: `#t=${TOKEN}`, api: { 'POST /api/auth/password/reset': { status: 200, body: { ok: true } } } })
    try {
      await reset.page.getByLabel('Новый пароль').fill('короткий')
      await reset.page.getByLabel('Повторите пароль').fill('короткий')
      await reset.page.getByRole('button', { name: 'Сохранить пароль' }).click()
      await reset.page.locator('.login-error', { hasText: 'не меньше 15 знаков' }).waitFor()
      const next = 'совсем другая длинная фраза'
      await reset.page.getByLabel('Новый пароль').fill(next)
      await reset.page.getByLabel('Повторите пароль').fill(next)
      await reset.page.getByRole('button', { name: 'Сохранить пароль' }).click()
      await reset.page.locator('.login-success', { hasText: 'Пароль изменён' }).waitFor()
      assert.deepEqual(reset.seen.at(-1).body, { token: TOKEN, newPassword: next })
    } finally {
      await reset.close()
    }
    const forgot = await open('&page=signup&view=forgot', { api: { ...CHALLENGE, 'POST /api/auth/password/forgot': { status: 202, body: { ok: true } } } })
    try {
      await forgot.page.getByLabel('Почта').fill('a@b.ru')
      await forgot.page.getByRole('button', { name: 'Отправить письмо' }).click()
      await forgot.page.locator('.login-success', { hasText: 'Если для этого адреса' }).waitFor()
    } finally {
      await forgot.close()
    }
  })

  it('режим «вручную»: заявка без письма и пароля; страница о письме не обещает, восстановления пароля нет', async () => {
    const { page, errors, seen, close } = await open('&page=signup&view=register&signupMode=manual', {
      api: {
        'GET /api/auth/register/challenge': () => ({ status: 200, body: { challenge: 'c', bits: 1 } }),
        'POST /api/auth/register': () => ({ status: 202, body: { ok: true } }),
      },
    })
    try {
      await page.getByLabel('Организация *').waitFor()
      const note = await page.locator('.login-note').innerText()
      assert.match(note, /проверит отдел/)
      assert.doesNotMatch(note, /письм/i)
      await page.getByLabel('Организация *').fill('Заявитель')
      await page.getByLabel('ИНН *').fill('7707083893')
      await page.getByLabel('Контактное лицо *').fill('Иванов Иван Иванович')
      await page.getByLabel('Контактный телефон *').fill('916 123-45-67')
      await page.getByLabel('Рабочая почта *').fill('a@firm.ru')
      await page.locator('.login-consent input').check()
      await page.getByRole('button', { name: 'Отправить заявку' }).click()
      const done = page.locator('.login-success')
      await done.waitFor()
      const text = await done.innerText()
      assert.match(text, /временный пароль/)
      assert.doesNotMatch(text, /письмо|ссылк/i)
      const sent = seen.find((r) => r.path === '/api/auth/register' && r.method === 'POST').body
      assert.equal('password' in sent, false)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
    const forgot = await open('&page=signup&view=forgot&signupMode=manual')
    try {
      await forgot.page.getByText('обратитесь к вашему менеджеру').waitFor()
      assert.equal(await forgot.page.locator('form').count(), 0)
    } finally {
      await forgot.close()
    }
  })

  it('режим «вручную» у администратора: проверка, контрагент на выбор, временный пароль один раз', async () => {
    const row = {
      id: '11111111-1111-4111-8111-111111111111', email: 'a@firm.ru', company_name: 'ООО «Подрядчик 01»', inn: '7707083893', kpp: null, contact_name: 'Иванов',
      phone: '+79161234567', status: 'review', reasons: ['new_company'], counterparty_id: null, counterparty_name: null,
      created_at: '2026-11-05T10:00:00Z', decided_at: null, decided_by: null,
    }
    const known = { ...row, id: '22222222-2222-4222-8222-222222222222', email: 'b@firm.ru', reasons: ['contact_differs'], counterparty_id: 'cp-2', counterparty_name: 'ООО Из реестра' }
    let rows = [row, known]
    const { page, errors, seen, close } = await open('&page=signups', {
      api: {
        'GET /api/admin/contractor-signups': () => ({ status: 200, body: { open: true, mode: 'manual', items: rows, hasMore: false } }),
        [`POST /api/admin/contractor-signups/${row.id}/decision`]: () => { rows = rows.filter((r) => r.id !== row.id); return { status: 200, body: { status: 'active', temporaryPassword: 'Времен-ный-Пароль-1' } } },
        [`POST /api/admin/contractor-signups/${known.id}/decision`]: () => ({ status: 409, body: { error: 'Учётная запись с такой почтой уже есть', code: 'email_taken' } }),
      },
    })
    const posts = () => seen.filter((r) => r.method === 'POST')
    try {
      await page.locator('.css-table tbody tr').first().waitFor()
      assert.equal(await page.getByRole('tab', { name: 'Ждут подтверждения компании' }).count(), 0, 'писем нет — ждать нечего')
      assert.ok((await page.locator('.css-table thead').innerText()).includes('Что проверить'))
      assert.ok((await page.locator('.css-table').innerText()).includes('такого ИНН в реестре нет'))

      // Нажатие только открывает окно: без проверки и выбора контрагента ничего не уходит.
      const line = (r) => page.locator('.css-table tbody tr', { hasText: r.email })
      await line(row).getByRole('button', { name: 'Открыть доступ' }).click()
      const dialog = page.getByRole('dialog', { name: 'Открыть доступ' })
      await dialog.waitFor()
      assert.equal(posts().length, 0)
      assert.match(await dialog.innerText(), /Заявку мог подать кто угодно/)
      assert.match(await dialog.innerText(), /будет заведён новый контрагент/)
      // Поиск начат сам, по названию без формы собственности: компания в реестре могла быть без ИНН.
      assert.equal(await dialog.getByLabel('Поиск контрагента').inputValue(), 'Подрядчик 01')
      await dialog.getByRole('button', { name: 'Отмена' }).click()
      await dialog.waitFor({ state: 'hidden' })

      // Отказ сервера виден в окне, окно не закрывается.
      await line(known).getByRole('button', { name: 'Открыть доступ' }).click()
      await dialog.waitFor()
      assert.match(await dialog.innerText(), /ООО Из реестра/)
      assert.equal(await dialog.getByLabel('Поиск контрагента').count(), 0, 'ИНН нашёл компанию — выбирать нечего')
      await dialog.getByRole('button', { name: 'Открыть доступ' }).click()
      await dialog.getByText('Учётная запись с такой почтой уже есть').waitFor()
      await dialog.getByRole('button', { name: 'Отмена' }).click()

      await line(row).getByRole('button', { name: 'Открыть доступ' }).click()
      await dialog.getByRole('button', { name: 'Открыть доступ' }).click()
      await page.locator('.adm-temp-password', { hasText: 'Времен-ный-Пароль-1' }).waitFor()
      assert.deepEqual(posts().at(-1).body, { decision: 'approve' })
      await page.getByRole('button', { name: 'Готово' }).click()
      await page.locator('.adm-temp-password').waitFor({ state: 'hidden' })
      assert.equal(await line(row).count(), 0)
      assert.deepEqual(errors.filter((e) => !/409/.test(e)), [])
    } finally {
      await close()
    }
  })

  it('заявки у администратора: причины и решение; на телефоне форма не вылезает за экран', async () => {
    const row = {
      id: '11111111-1111-4111-8111-111111111111', email: 'a@firm.ru', company_name: 'ООО Заявитель', inn: '7707083893', kpp: null, contact_name: 'Иванов',
      phone: '+79161234567', status: 'review', reasons: ['inn_blacklisted', 'no_company_mail'], counterparty_name: 'ООО Из реестра',
      created_at: '2026-11-03T10:00:00Z', decided_at: null, decided_by: null,
    }
    let rows = [row]
    const { page, errors, seen, close } = await open('&page=signups', {
      api: {
        'GET /api/admin/contractor-signups': () => ({ status: 200, body: { open: true, items: rows, hasMore: false } }),
        [`POST /api/admin/contractor-signups/${row.id}/decision`]: () => { rows = []; return { status: 200, body: { status: 'active' } } },
      },
    })
    try {
      const line = page.locator('.css-table tbody tr')
      await line.waitFor()
      const text = await line.textContent()
      for (const part of ['ООО Заявитель', 'ИНН 7707083893', 'В реестре: ООО Из реестра', 'a@firm.ru', 'ИНН в чёрном списке', 'в её карточке нет почты']) assert.ok(text.includes(part), part)
      await page.getByRole('button', { name: 'Открыть доступ' }).click()
      await page.getByText('Заявок нет.').waitFor()
      assert.deepEqual(seen.find((r) => r.method === 'POST').body, { decision: 'approve' })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
    const phone = await open('&page=signup&view=register', { viewport: { width: 375, height: 700 } })
    try {
      await phone.page.getByLabel('Организация *').waitFor()
      await phone.page.getByLabel('Контактный телефон *', { exact: true }).fill('9161234567')
      await phone.page.getByLabel('доб.', { exact: true }).fill('123456')
      const width = await phone.page.evaluate(() => document.documentElement.scrollWidth)
      assert.ok(width <= 375, `шире экрана: ${width}`)
      for (const id of ['#signup-phone', '#signup-phoneExt']) {
        assert.ok(await phone.page.locator(id).evaluate((el) => el.scrollWidth <= el.clientWidth), `${id}: цифры обрезаны`)
      }
    } finally {
      await phone.close()
    }
    // На компьютере номер и добавочный — одной строкой, все цифры видны.
    const wide = await open('&page=signup&view=register')
    try {
      await wide.page.getByLabel('Контактный телефон *', { exact: true }).fill('9161234567')
      await wide.page.getByLabel('доб.', { exact: true }).fill('123456')
      const [number, ext] = await Promise.all(['#signup-phone', '#signup-phoneExt'].map((id) => wide.page.locator(id).boundingBox()))
      assert.equal(number.y, ext.y, 'одна строка')
      for (const id of ['#signup-phone', '#signup-phoneExt']) {
        assert.ok(await wide.page.locator(id).evaluate((el) => el.scrollWidth <= el.clientWidth), `${id}: цифры обрезаны`)
      }
    } finally {
      await wide.close()
    }
  })
})
