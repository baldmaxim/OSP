// «Администрирование» → «Добавить пользователя»: какая роль уходит, если её не меняли. Первым в справочнике идёт
// «Администратор»: выбор по порядку списка выдавал новой учётке полный доступ. Стенд — route=/stand/add-user.
//   • по умолчанию — «Гость»;
//   • другая роль — только выбором;
//   • «Гостя» в справочнике нет — роль не подставляется, без выбора учётка не создаётся.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()

describe('Новый пользователь: роль по умолчанию', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open(query = '') {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1400, height: 900 } })
    const page = await context.newPage()
    await page.goto(`${stand.url}?route=/stand/add-user&latency=0${query}`)
    await page.getByLabel('Email (логин)').fill('new@example.invalid')
    await page.getByLabel('ФИО').fill('Новый Сотрудник')
    return { page, role: page.getByLabel('Роль'), close: () => context.close().catch(() => {}) }
  }
  const create = (page) => page.getByRole('button', { name: 'Создать' }).click()
  const created = (page) => page.evaluate(() => window.__createdUsers || [])
  const createdRoles = async (page) => {
    await page.waitForFunction(() => window.__createdUsers?.length)
    return (await created(page)).map((u) => u.role)
  }

  it('по умолчанию — «Гость», не «Администратор»', async () => {
    const { page, role, close } = await open()
    assert.equal(await role.inputValue(), 'guest')
    assert.equal(await role.locator('option:checked').innerText(), 'Гость')
    await create(page)
    assert.deepEqual(await createdRoles(page), ['guest'])
    await close()
  })

  it('другую роль выбирают сами', async () => {
    const { page, role, close } = await open()
    await role.selectOption('admin')
    await create(page)
    assert.deepEqual(await createdRoles(page), ['admin'])
    await close()
  })

  it('«Гостя» в справочнике нет — первая роль не подставляется, без выбора учётка не создаётся', async () => {
    const { page, role, close } = await open('&addUserNoGuest=1')
    assert.equal(await role.inputValue(), '')
    assert.equal(await role.locator('option:checked').innerText(), 'Выберите роль')
    await create(page)
    assert.equal(await role.evaluate((el) => el.validity.valueMissing), true)
    assert.deepEqual(await created(page), [])
    await role.selectOption('engineer')
    assert.equal(await role.locator('option', { hasText: 'Выберите роль' }).count(), 0, 'после выбора подсказка убирается')
    await create(page)
    assert.deepEqual(await createdRoles(page), ['engineer'])
    await close()
  })
})
