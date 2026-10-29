// «Администрирование» → «Доступ к API»: помощники и адаптер (без браузера) и вкладка в Chromium (стенд
// tests/tender/ui, route=/stand/api-keys — «сервер» ключей в памяти). Сервер и база — tests/osp-api/api-keys.test.mjs.
//   • список: права, срок, статус, использование, ключи из настроек сервера;
//   • выпуск: проверка формы, ключ — в окне один раз, закрывается только кнопкой, в запросе ключа нет;
//   • правка: только изменённые поля; у ключа из настроек сервера права и срок не правятся;
//   • отзыв с причиной, удаление; журнал вызовов: по ключу, «только отказы», «Показать ещё»;
//   • раздела у сервера нет (прежний портал) — подсказка вместо ошибки; телефон — без прокрутки страницы вбок.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { accessEditable, callReasonText, formatDate, keyFormError, keyPatch, usageText } from '../../src/utils/apiKeys.js'
import { createApiKeysClient } from '../../src/api/apiKeysClient.js'

describe('Доступ к API: помощники и адаптер', () => {
  it('форма: название, права, срок не раньше сегодня', () => {
    const ok = { name: 'Отдел', scopes: ['kp'], expiresOn: '' }
    assert.equal(keyFormError(ok, '2026-10-29'), '')
    assert.match(keyFormError({ ...ok, name: '   ' }, '2026-10-29'), /название/)
    assert.match(keyFormError({ ...ok, name: 'x'.repeat(201) }, '2026-10-29'), /200/)
    assert.match(keyFormError({ ...ok, scopes: [] }, '2026-10-29'), /право/)
    assert.equal(keyFormError({ ...ok, scopes: [] }, '2026-10-29', { scopesRequired: false }), '', 'у ключа из настроек права не правятся')
    assert.match(keyFormError({ ...ok, expiresOn: '2026-10-28' }, '2026-10-29'), /сегодня или позже/)
    assert.equal(keyFormError({ ...ok, expiresOn: '2026-10-29' }, '2026-10-29'), '')
  })

  it('правка: только изменённые поля; права и срок — только у выпущенного в портале и не отозванного', () => {
    const key = { name: 'Отдел', note: '', scopes: ['kp', 'larix'], expiresOn: null, source: 'portal', status: 'active' }
    assert.deepEqual(keyPatch(key, { name: ' Отдел ', note: '', scopes: ['larix', 'kp'], expiresOn: '' }, { accessEditable: true }), {})
    assert.deepEqual(keyPatch(key, { name: 'Отдел 2', note: 'Петров', scopes: ['kp'], expiresOn: '2027-01-01' }, { accessEditable: true }),
      { name: 'Отдел 2', note: 'Петров', scopes: ['kp'], expiresOn: '2027-01-01' })
    assert.deepEqual(keyPatch({ ...key, note: 'Петров' }, { name: 'Отдел', note: ' ', scopes: ['kp'], expiresOn: '' }, { accessEditable: false }), { note: null })
    assert.equal(accessEditable(key), true)
    assert.equal(accessEditable({ ...key, source: 'env' }), false)
    assert.equal(accessEditable({ ...key, status: 'revoked' }), false)
    assert.equal(accessEditable({ ...key, status: 'expired' }), true, 'истёкший можно продлить')
  })

  it('подписи: дата, использование, причина отказа', () => {
    assert.equal(formatDate('2026-12-31'), '31.12.2026')
    assert.equal(formatDate(null), '—')
    assert.equal(usageText({ callsDay: 702 }), '702 за сутки')
    assert.equal(usageText({ callsDay: 0, lastUsedAt: null }), 'не использовался')
    assert.equal(callReasonText({ status: 403, reason: 'forbidden_resource' }), 'ресурс ключу не открыт')
    assert.equal(callReasonText({ status: 500, reason: '' }), 'ошибка сервера')
    assert.equal(callReasonText({ status: 200, reason: '' }), '')
  })

  it('адаптер: токен, тело запроса, ошибки сервера и «раздела нет»', async () => {
    const seen = []
    const respond = { status: 200, body: { resources: [], keys: [], today: '2026-10-29' }, type: 'application/json' }
    const fetchImpl = async (url, init) => {
      seen.push({ url, init })
      const text = typeof respond.body === 'string' ? respond.body : JSON.stringify(respond.body)
      return new Response(text, { status: respond.status, headers: { 'content-type': respond.type } })
    }
    const client = createApiKeysClient({ fetchImpl, getToken: async () => 'tok' })
    assert.deepEqual(await client.list(), respond.body)
    assert.equal(seen[0].url, '/api/admin/api-keys')
    assert.equal(seen[0].init.headers.authorization, 'Bearer tok')

    respond.body = { key: { id: 'k1' }, secret: 'osp_x' }
    await client.issue({ name: 'Отдел', scopes: ['kp'] })
    assert.equal(seen[1].init.method, 'POST')
    assert.deepEqual(JSON.parse(seen[1].init.body), { name: 'Отдел', scopes: ['kp'] })
    await client.revoke('k 1', '')
    assert.equal(seen[2].url, '/api/admin/api-keys/k%201/revoke')
    assert.deepEqual(JSON.parse(seen[2].init.body), {})
    respond.body = { calls: [], hasMore: false }
    await client.calls({ keyId: 'k1', errorsOnly: true, before: 55, limit: 100 })
    assert.equal(seen[3].url, '/api/admin/api-keys/calls?key=k1&errors=1&before=55&limit=100')

    Object.assign(respond, { status: 503, body: { error: 'Ключи API ещё не настроены', code: 'OSP_API_KEYS_MISSING' } })
    await assert.rejects(client.list(), (err) => err.message === 'Ключи API ещё не настроены' && err.code === 'OSP_API_KEYS_MISSING' && !err.unavailable)
    Object.assign(respond, { status: 200, body: '<!doctype html><title>ОСП</title>', type: 'text/html' })
    await assert.rejects(client.list(), (err) => err.unavailable === true, 'на /api отвечает страница сайта — раздела нет')
    Object.assign(respond, { status: 404, body: { error: 'Not found' }, type: 'application/json' })
    await assert.rejects(client.list(), (err) => err.unavailable === true)
    const offline = createApiKeysClient({ fetchImpl: async () => { throw new TypeError('Failed to fetch') } })
    await assert.rejects(offline.list(), (err) => err.unavailable === true && err.status === 0)
  })
})

const launch = browserLaunchOptions()

describe('Доступ к API: вкладка', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open(query = '', viewport = { width: 1400, height: 900 }) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(stand.url).origin }).catch(() => {})
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    await page.goto(`${stand.url}?route=/stand/api-keys&latency=0${query}`)
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const rowOf = (page, name) => page.locator('.ak-keys-table tbody tr', { hasText: name })
  const requests = (page) => page.evaluate(() => window.__apiKeys.requests)

  it('список: права, срок, статус, использование; ключ из настроек сервера помечен', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('.ak-keys-table tbody tr').first().waitFor({ timeout: 120000 })
      assert.equal(await page.locator('.ak-keys-table tbody tr').count(), 3)
      const tender = rowOf(page, 'Тендерный отдел')
      assert.deepEqual(await tender.locator('.ak-chip').allInnerTexts(), ['Расценки от подрядчиков (КП)', 'Договорные расценки (Larix)'])
      assert.match(await tender.locator('.ak-usage').innerText(), /702 за сутки[\s\S]*отказов: 3/)
      assert.equal((await tender.locator('.ak-status').innerText()).trim(), 'Действует')
      assert.match(await tender.locator('.ak-prefix').innerText(), /^osp_Ab12Cd34…$/)
      assert.match(await rowOf(page, 'Ключ из настроек сервера').locator('.ak-tag').innerText(), /из настроек сервера/)
      const old = rowOf(page, 'Старый расчётчик')
      assert.equal((await old.locator('.ak-status').innerText()).trim(), 'Отозван')
      assert.match(await old.locator('.ak-status').getAttribute('title'), /Сотрудник уволился/)
      assert.equal(await old.getByRole('button', { name: /Отозвать/ }).count(), 0, 'отозванный не отзывается снова')
      assert.match(await page.locator('.ak-subtitle').innerText(), /Действующих: 2 из 3/)
      assert.match(await page.locator('.ak-help').innerText(), /X-API-Key[\s\S]*\/api\/rates\/kp[\s\S]*один раз/)
      // Подсказку можно скрыть — и она не возвращается после перезагрузки.
      await page.getByRole('button', { name: 'Скрыть подсказку' }).click()
      await page.reload()
      await page.locator('.ak-keys-table tbody tr').first().waitFor()
      assert.equal(await page.locator('.ak-help').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('выпуск: проверка формы; ключ — один раз, окно закрывается только кнопкой; в запросе ключа нет', async () => {
    const { page, errors, close } = await open()
    try {
      await page.getByRole('button', { name: /Выпустить ключ/ }).click()
      const drawer = page.getByRole('dialog', { name: 'Выпустить ключ доступа' })
      await drawer.getByRole('button', { name: 'Выпустить ключ' }).click()
      assert.match(await drawer.getByRole('alert').innerText(), /Укажите название/)
      await drawer.getByLabel(/Название/).fill('Сметный отдел — расчёты')
      await drawer.getByRole('button', { name: 'Выпустить ключ' }).click()
      assert.match(await drawer.getByRole('alert').innerText(), /хотя бы одно право/)
      await drawer.getByLabel(/Расценки от подрядчиков/).check()
      await drawer.getByLabel(/Договорные расценки/).check()
      assert.equal(await drawer.locator('input[type="date"]').getAttribute('min'), '2026-10-29')
      await drawer.locator('input[type="date"]').fill('2027-03-31')
      await drawer.getByLabel('Примечание').fill('Иванов, доб. 300')
      await drawer.getByRole('button', { name: 'Выпустить ключ' }).click()

      const dialog = page.getByRole('dialog', { name: 'Ключ выпущен' })
      await dialog.waitFor()
      const secret = (await dialog.getByTestId('api-key-secret').innerText()).trim()
      assert.match(secret, /^osp_StandSecret1/)
      assert.match(await dialog.innerText(), /показывается один раз/)
      // Щелчок мимо окна его не закрывает.
      await page.mouse.click(5, 5)
      assert.equal(await dialog.isVisible(), true)
      await dialog.getByRole('button', { name: 'Скопировать ключ' }).click()
      await dialog.getByRole('button', { name: 'Ключ скопирован' }).waitFor()
      await dialog.getByRole('button', { name: 'Я сохранил ключ' }).click()
      await dialog.waitFor({ state: 'detached' })
      assert.ok(!(await page.content()).includes(secret), 'после закрытия ключа на странице нет')

      const fresh = page.locator('.ak-keys-table tbody tr').first()
      assert.match(await fresh.locator('.ak-name').innerText(), /Сметный отдел — расчёты/)
      assert.equal((await fresh.locator('.ak-prefix').innerText()).trim(), `${secret.slice(0, 12)}…`)
      assert.match(await fresh.innerText(), /до 31\.03\.2027/)
      const issue = (await requests(page)).find((r) => r.method === 'POST' && r.path === '/api/admin/api-keys')
      assert.deepEqual(issue.body, { name: 'Сметный отдел — расчёты', scopes: ['kp', 'larix'], expiresOn: '2027-03-31', note: 'Иванов, доб. 300' })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('правка: у ключа из настроек сервера права и срок закрыты; уходят только изменённые поля', async () => {
    const { page, errors, close } = await open()
    try {
      await rowOf(page, 'Ключ из настроек сервера').getByRole('button', { name: /Изменить/ }).click()
      const drawer = page.getByRole('dialog', { name: 'Изменить ключ' })
      for (const label of [/Расценки от подрядчиков/, /Расценки от снабжения/, /Договорные расценки/]) assert.equal(await drawer.getByLabel(label).isDisabled(), true)
      assert.equal(await drawer.locator('input[type="date"]').isDisabled(), true)
      assert.match(await drawer.locator('.ak-locked').innerText(), /RATES_API_KEYS/)
      await drawer.getByLabel(/Название/).fill('Тендерный отдел (прежний ключ)')
      await drawer.getByRole('button', { name: 'Сохранить' }).click()
      await drawer.waitFor({ state: 'detached' })
      await rowOf(page, 'Тендерный отдел (прежний ключ)').waitFor()
      const upd = (await requests(page)).find((r) => r.path === '/api/admin/api-keys/k-env')
      assert.deepEqual(upd.body, { name: 'Тендерный отдел (прежний ключ)' })
      await page.locator('.admin-toast', { hasText: 'Ключ сохранён' }).waitFor()

      // Выпущенный в портале: права меняются.
      await rowOf(page, 'Тендерный отдел').first().getByRole('button', { name: /Изменить: Тендерный отдел$/ }).click()
      const own = page.getByRole('dialog', { name: 'Изменить ключ' })
      await own.getByLabel(/Расценки от снабжения/).check()
      await own.getByRole('button', { name: 'Сохранить' }).click()
      await own.waitFor({ state: 'detached' })
      const scopes = (await requests(page)).find((r) => r.path === '/api/admin/api-keys/k-tender').body
      assert.deepEqual(scopes, { scopes: ['kp', 'larix', 'supply'] })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('отзыв с причиной, удаление; журнал вызовов по ключу, «только отказы», «Показать ещё»', async () => {
    const { page, errors, close } = await open()
    try {
      // Журнал ключа — кнопкой в строке.
      await rowOf(page, 'Тендерный отдел').getByRole('button', { name: /Журнал вызовов/ }).click()
      await page.locator('.ak-calls-table tbody tr').first().waitFor()
      assert.equal(await page.getByLabel('Ключ', { exact: true }).inputValue(), 'k-tender')
      assert.equal(await page.locator('.ak-calls-table tbody tr').count(), 100)
      await page.getByRole('button', { name: 'Показать ещё' }).click()
      await page.waitForFunction(() => document.querySelectorAll('.ak-calls-table tbody tr').length === 130)
      assert.equal(await page.getByRole('button', { name: 'Показать ещё' }).count(), 0)
      await page.getByLabel('Только отказы и ошибки').check()
      await page.waitForFunction(() => document.querySelectorAll('.ak-calls-table tbody tr').length === 13)
      assert.match(await page.locator('.ak-calls-table tbody tr').first().innerText(), /403[\s\S]*ресурс ключу не открыт/)
      await page.getByLabel('Ключ', { exact: true }).selectOption('')
      await page.locator('.ak-calls-table tbody tr', { hasText: 'Старый расчётчик' }).waitFor()
      assert.match(await page.locator('.ak-calls-table tbody tr', { hasText: 'Старый расчётчик' }).innerText(), /401[\s\S]*ключ отозван/)

      await page.getByRole('tab', { name: /Ключи/ }).click()
      await rowOf(page, 'Тендерный отдел').getByRole('button', { name: /Отозвать/ }).click()
      const confirm = page.getByRole('dialog', { name: 'Отозвать ключ' })
      await confirm.getByLabel('Причина').fill('Ключ попал в общий чат')
      await confirm.getByRole('button', { name: 'Отозвать' }).click()
      await confirm.waitFor({ state: 'detached' })
      assert.equal((await rowOf(page, 'Тендерный отдел').locator('.ak-status').innerText()).trim(), 'Отозван')
      assert.deepEqual((await requests(page)).find((r) => r.path === '/api/admin/api-keys/k-tender/revoke').body, { reason: 'Ключ попал в общий чат' })

      await rowOf(page, 'Старый расчётчик').getByRole('button', { name: /Удалить/ }).click()
      const del = page.getByRole('dialog', { name: 'Удалить ключ' })
      await del.getByRole('button', { name: 'Удалить' }).click()
      await del.waitFor({ state: 'detached' })
      await page.waitForFunction(() => ![...document.querySelectorAll('.ak-keys-table tbody tr')].some((tr) => tr.innerText.includes('Старый расчётчик')))
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('раздела у сервера нет — подсказка; телефон — без прокрутки страницы вбок', async () => {
    const missing = await open('&apiKeys=missing')
    try {
      await missing.page.locator('.ak-unavailable').waitFor({ timeout: 120000 })
      assert.match(await missing.page.locator('.ak-unavailable').innerText(), /tender\.su10\.ru/)
      assert.deepEqual(missing.errors, [])
    } finally {
      await missing.close()
    }

    const phone = await open('&apiKeysMany=5', { width: 390, height: 800 })
    try {
      await phone.page.locator('.ak-keys-table tbody tr').first().waitFor({ timeout: 120000 })
      const { scroll, inner, tableScrolls } = await phone.page.evaluate(() => {
        const wrap = document.querySelector('.ak-table-wrap')
        return { scroll: document.documentElement.scrollWidth, inner: window.innerWidth, tableScrolls: wrap.scrollWidth > wrap.clientWidth }
      })
      assert.ok(scroll <= inner, `страница шире окна: ${scroll} > ${inner}`)
      assert.ok(tableScrolls, 'таблица прокручивается в своём блоке')
      await phone.page.getByRole('button', { name: /Выпустить ключ/ }).click()
      const box = await phone.page.getByRole('dialog', { name: 'Выпустить ключ доступа' }).boundingBox()
      assert.ok(box.width <= 390, 'окно выпуска помещается в экран')
      assert.deepEqual(phone.errors, [])
    } finally {
      await phone.close()
    }
  })
})
