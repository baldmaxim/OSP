// «Заявки на проверку ДП/ДС»: руководитель строительства и экономист объекта создают заявки — только в «Новые заявки»
// (миграция 20270102, решение пользователя 06.11.2026: «по такому же принципу», что «Заявка на заключение ДП»). Страница в
// Chromium (стенд tests/tender/ui, route=/doc-check-requests&docCheck=1):
//   • право только создавать (?noEdit=doc_check_requests): «+ Новая заявка» в шапке и «+» только у колонки «Новые заявки»,
//     ничего не двигается; в форме — без исполнителей, срока, приоритета, цвета и меток, зато файлы на проверку;
//   • объект — из «Ролей»: один стоит серым, без выбора; несколько — выбор обязателен; заявка встаёт в «Новые заявки»;
//   • с правом правки — форма прежняя. База (тот же запрет) — doc-check-create-db.test.mjs. Люди вымышленные.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const CREATOR = '&noEdit=doc_check_requests,admin&asRole=construction_manager&asUser=boss-1&asName=Строев%20Борис%20Иванович'
const FILE = { name: 'ДС № 7.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') }

describe('Заявки на проверку ДП/ДС: создание рукстроем и экономистом объекта', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  const open = async (extra, { viewport = { width: 1700, height: 950 } } = {}) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => d.accept())
    await page.goto(`${stand.url}?route=/doc-check-requests&docCheck=1&latency=0${extra}`)
    await page.locator('.dc-board, .dc-error').first().waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const form = (page) => page.locator('.dc-form-modal')
  const labels = (page) => form(page).locator('.dc-form-label, .dc-form-row > label').allInnerTexts()
  const created = (page) => page.evaluate(() => window.__fakeDb.doc_check_requests.filter((r) => !/^dcr-\d+$/.test(r.id)))

  it('один объект: «+» только у «Новых заявок», объект стоит серым; без работы отдела; заявка с файлом — в «Новых»', async () => {
    const { page, errors, close } = await open(`${CREATOR}&scope=obj-2`)
    try {
      const adds = page.locator('.dc-column-add')
      assert.equal(await adds.count(), 1)
      assert.equal(await adds.getAttribute('aria-label'), 'Добавить заявку: Новые заявки')
      assert.equal(await page.locator('.dc-card.is-movable').count(), 0, 'карточки не двигаются')
      assert.equal(await page.locator('button.dc-card-check').count(), 0)

      await page.getByRole('button', { name: '+ Новая заявка' }).click()
      const select = form(page).getByLabel('Объект')
      assert.equal(await select.isDisabled(), true)
      assert.deepEqual(await select.locator('option').allTextContents(), ['Бизнес-центр «Нурлы»'])
      const shown = await labels(page)
      for (const work of ['Исполнители', 'Срок', 'Приоритет', 'Цвет карточки', 'Метки']) assert.ok(!shown.includes(work), `${work}: ${shown.join(' | ')}`)
      assert.ok(shown.includes('Документы на проверку'))

      await form(page).getByLabel('Примечание').fill('Проверить ДС на монолит')
      await page.locator('[data-testid="dc-files"] input[type=file]').setInputFiles(FILE)
      await form(page).getByText('ДС № 7.pdf').waitFor()
      await form(page).getByRole('button', { name: 'Создать заявку' }).click()
      await form(page).waitFor({ state: 'detached' })

      const [row] = await created(page)
      assert.equal(row.status, 'new')
      assert.equal(row.object_id, 'obj-2')
      for (const field of ['assignee_ids', 'due_date', 'priority', 'color', 'labels']) assert.ok(!(field in row), `${field} не отправляется`)
      const files = await page.evaluate((id) => window.__fakeDb.s3_documents.filter((d) => d.owner_id === id).map((d) => [d.owner_type, d.file_name]), row.id)
      assert.deepEqual(files, [['doc_check_request', 'ДС № 7.pdf']])
      const column = page.locator('.dc-column', { has: page.locator('.dc-column-title', { hasText: 'Новые заявки' }) })
      await column.locator(`.dc-card[data-id="${row.id}"]`).waitFor()
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('два объекта: выбор обязателен; «+» у колонки — тоже «Новые заявки»', async () => {
    const { page, errors, close } = await open(`${CREATOR}&scope=obj-1,obj-2`)
    try {
      await page.locator('.dc-column-add').click()
      assert.match(await form(page).locator('.dc-detail-sub').innerText(), /Новые заявки/)
      const select = form(page).getByLabel('Объект')
      assert.equal(await select.isDisabled(), false)
      assert.deepEqual(await select.locator('option').allTextContents(), ['— Выберите объект —', 'Бизнес-центр «Нурлы»', 'ЖК «Северный квартал»'])
      await form(page).getByLabel('Примечание').fill('ДП на кровлю')
      await form(page).getByRole('button', { name: 'Создать заявку' }).click()
      assert.match(await form(page).locator('.dc-form-error').innerText(), /Выберите объект/)
      assert.equal((await created(page)).length, 0)
      await select.selectOption({ label: 'ЖК «Северный квартал»' })
      await form(page).getByRole('button', { name: 'Создать заявку' }).click()
      await form(page).waitFor({ state: 'detached' })
      const [row] = await created(page)
      assert.equal(row.object_id, 'obj-1')
      assert.equal(row.status, 'new')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('с правом правки — как раньше: «+» у каждой колонки, исполнители и срок в форме, объект — из всех, файлов в форме нет', async () => {
    const { page, errors, close } = await open('')
    try {
      assert.ok(await page.locator('.dc-column-add').count() > 1)
      await page.getByRole('button', { name: '+ Новая заявка' }).click()
      const shown = await labels(page)
      for (const work of ['Исполнители', 'Срок', 'Приоритет', 'Метки', 'Объект']) assert.ok(shown.includes(work), `${work}: ${shown.join(' | ')}`)
      assert.equal(await form(page).locator('#dc-own-object').count(), 0)
      assert.equal(await page.locator('[data-testid="dc-files"]').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('телефон: шапка в три низкие строки, фильтры с архивом — по кнопке, реестр — карточками, поля 16 px', async () => {
    const { page, errors, close } = await open(`${CREATOR}&scope=obj-1,obj-2&shell=1`, { viewport: { width: 390, height: 844 } })
    try {
      const head = await page.locator('.dc-head').boundingBox()
      assert.ok(head.height < 170, `шапка над доской: ${head.height}px`)
      assert.equal(await page.locator('.dc-toolbar').count(), 0, 'фильтры свёрнуты')
      assert.equal(await page.locator('.dc-mode-toggle', { hasText: 'Удалённые' }).count(), 0)
      await page.getByRole('button', { name: /^Фильтры/ }).click()
      await page.locator('.dc-toolbar .dc-mode-toggle', { hasText: 'Удалённые' }).waitFor()
      await page.locator('.dc-toolbar .fdrop-trigger', { hasText: 'Объект' }).click()
      await page.locator('.fdrop-panel .fdrop-option', { hasText: 'Бизнес-центр' }).click()
      await page.keyboard.press('Escape')
      assert.match(await page.getByRole('button', { name: /^Фильтры/ }).innerText(), /Фильтры \(1\)/)

      await page.locator('.dc-view-btn', { hasText: 'Реестр' }).click()
      await page.locator('.dc-mcards .mcard').first().waitFor()
      assert.equal(await page.locator('.dc-table').count(), 0)
      assert.equal(await page.locator('.dc-mcards .mcard').count(), 3, 'отбор по объекту — и в карточках')
      await page.locator('.dc-mcards .mcard').first().click()
      await page.locator('.dc-detail-modal').waitFor()
      await page.locator('.dc-detail-modal').getByRole('button', { name: 'Закрыть' }).last().click()

      await page.getByRole('button', { name: '+ Новая заявка' }).click()
      const size = await form(page).getByLabel('Объект').evaluate((el) => getComputedStyle(el).fontSize)
      assert.equal(size, '16px', 'мельче — Safari увеличивает страницу при касании')
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert.ok(overflow <= 1, `нет прокрутки вбок: ${overflow}`)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('только просмотр (без права создания) — кнопок создания нет', async () => {
    const { page, errors, close } = await open('&canEdit=0&scope=obj-2&asRole=construction_manager')
    try {
      assert.equal(await page.getByRole('button', { name: '+ Новая заявка' }).count(), 0)
      assert.equal(await page.locator('.dc-column-add').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
