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
      assert.match(await page.locator('.cab-join').textContent(), /Откроется расценка на сайте/)
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      await page.locator('.bid-tab', { hasText: 'Материалы' }).locator('.bid-tab-count', { hasText: '2' }).waitFor({ timeout: 30000 })
      assert.equal(await page.locator('.cab-docs').count(), 0, 'файлов нет')
      assert.equal(await page.locator('.cab-section h3', { hasText: 'Документы тендера' }).count(), 0)
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
      for (const text of ['ООО Альфа', '770701001', 'Москва, ул. Строителей, 1', 'Монолитные работы', 'Альфин А. А.', '+79161234567', 'alfin@alpha.ru']) {
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
      await fill('Организация *', 'ООО «Ромашка»')
      await fill('ИНН *', '7707083894')
      await page.getByRole('button', { name: 'Зарегистрироваться' }).click()
      await page.locator('.login-field-error', { hasText: 'ИНН не прошёл проверку' }).waitFor()

      await fill('ИНН *', '500100732259')
      assert.equal(await page.getByLabel('КПП').count(), 0, 'у ИП КПП нет')
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

  it('регистрация закрыта: формы нет', async () => {
    const { page, close } = await open('&page=signup&view=register&closed=1')
    try {
      await page.getByText('Регистрация на сайте сейчас закрыта').waitFor()
      assert.equal(await page.locator('form').count(), 0)
    } finally {
      await close()
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
      const width = await phone.page.evaluate(() => document.documentElement.scrollWidth)
      assert.ok(width <= 375, `шире экрана: ${width}`)
    } finally {
      await phone.close()
    }
  })
})
