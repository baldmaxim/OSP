// «Реестр по договорам» глазами сотрудника объекта (10.11.2026, решение пользователя): руководитель строительства и экономист
// объекта видят договоры только своих объектов, без общей папки раздела, без «+ Добавить договор», без «Структуры хранения» и
// «Стандартных приложений»; заявку на заключение ДП подают плюсиком сразу за вкладкой «Все» — то же окно, что на /dp-requests.
// У администратора и сотрудника без привязки к объектам — всё как раньше, плюс та же кнопка, если есть право подавать заявки.
// Стенд tests/tender/ui (route=/contracts/registry), Chromium. Люди и объекты вымышленные.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const BASE = 'route=/contracts/registry&contracts=12&latency=0'
// Руководитель строительства одного объекта: просмотр договоров, подаёт заявки на ДП, с ними не работает.
const SITE = 'asRole=construction_manager&asUser=boss-1&asName=Строев%20Борис%20Иванович&noEdit=contracts,dp_requests,admin&scope=obj-2'
const CONCEPT = { name: 'Понятийное.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') }

describe('Реестр по договорам: сотрудник объекта и «+ Заявка на заключение ДП»', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  const open = async (query = '', viewport = { width: 1600, height: 950 }, extra = {}) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport, ...extra })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => d.accept())
    await page.goto(`${stand.url}?${BASE}${query ? `&${query}` : ''}`)
    await page.locator('.contracts-page-v2 .status-tabs .status-tab').first().waitFor({ timeout: 120000 })
    await page.locator('.contracts-page-v2 .loading').waitFor({ state: 'detached' }).catch(() => {})
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  // Что стоит в строке вкладок по порядку: вкладки — названием, кнопка — классом.
  const tabsRow = (page) => page.locator('.contracts-page-v2 .status-tabs > *').evaluateAll((els) => els.map((el) => (
    el.classList.contains('cr-dp-add') ? 'cr-dp-add' : el.firstChild.textContent.trim())))
  const docsCards = async (page) => {
    await page.getByRole('button', { name: 'Документы' }).click()
    const modal = page.locator('.tdm-modal')
    await modal.waitFor()
    const titles = await modal.locator('.tdm-card-title').allTextContents()
    await modal.getByRole('button', { name: 'Закрыть' }).last().click()
    return titles
  }

  it('сотрудник объекта: только свой объект, без общей папки и «+ Добавить договор»; «Документы» — только шаблоны', async () => {
    const { page, errors, close } = await open(SITE)
    try {
      const objectsInRows = await page.locator('.contracts-page-v2 tbody').innerText()
      assert.match(objectsInRows, /Бизнес-центр «Нурлы»/)
      assert.doesNotMatch(objectsInRows, /Северный квартал/, 'договоры чужого объекта не показываются')

      await page.locator('.cr-toolbar .fdrop-trigger', { hasText: 'Все объекты' }).click()
      const options = await page.locator('.fdrop-panel .fdrop-option').allTextContents()
      assert.ok(options.some((t) => t.includes('Нурлы')), options.join())
      assert.ok(!options.some((t) => t.includes('Северный квартал')), `в фильтре только свои объекты: ${options.join()}`)
      await page.keyboard.press('Escape')

      assert.equal(await page.locator('.contracts-page-v2 .rfpath').count(), 0, 'общей папки раздела нет')
      assert.equal(await page.getByRole('button', { name: '+ Добавить договор' }).count(), 0, 'договоры не заводит')
      assert.deepEqual((await tabsRow(page)).slice(0, 3), ['Все', 'cr-dp-add', 'В работе'], 'кнопка — сразу за «Все»')
      assert.match(await page.locator('.cr-dp-add').textContent(), /^\+\s*Заявка на заключение ДП$/)

      const cards = await docsCards(page)
      assert.ok(cards.includes('Понятийное соглашение'), cards.join())
      assert.ok(!cards.includes('Структура хранения документов'), cards.join())
      assert.ok(!cards.includes('Стандартные приложения'), cards.join())
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«+ Заявка на заключение ДП»: то же окно, свой объект стоит сам; после подачи — номер и ссылка на заявку', async () => {
    const { page, errors, close } = await open(SITE)
    try {
      // Отметки базы на подаче (как dp_requests_guard): черновик, затем «новая» с номером.
      await page.evaluate(() => {
        window.__fakeTriggers = {
          ...(window.__fakeTriggers || {}),
          dp_requests: (row, old) => {
            if (!old) { row.status = 'draft'; return }
            if (old.status === 'draft' && row.status === 'new') row.request_number = 41
          },
        }
      })
      await page.locator('.cr-dp-add').click()
      const d = page.locator('.dpr-dialog')
      await d.waitFor()
      assert.equal(await d.locator('h3').innerText(), 'Новая заявка на заключение ДП')
      // Окно — в <body>, поверх реестра, на рабочем слое (тот же вид, что на странице заявок).
      const where = await d.evaluate((el) => ({
        portal: !!el.closest('body > .dpr-portal.ui-work'),
        inTabs: !!el.closest('.status-tabs'),
        overlay: getComputedStyle(el.closest('.dpr-overlay')).position,
        font: getComputedStyle(el).fontFamily,
      }))
      assert.deepEqual({ portal: where.portal, inTabs: where.inTabs, overlay: where.overlay }, { portal: true, inTabs: false, overlay: 'fixed' })
      assert.match(where.font, /Inter/)

      const select = d.getByLabel('Объект')
      await select.locator('option', { hasText: 'Бизнес-центр «Нурлы»' }).waitFor({ state: 'attached' })
      assert.equal(await select.isDisabled(), true, 'один объект — стоит сам')
      assert.equal(await d.getByLabel('Сумма, ₽').count(), 0, 'поля отдела подающему не показываются')

      await page.locator('[data-testid="dpr-concept-files"] input[type=file]').setInputFiles(CONCEPT)
      await d.getByLabel('Примечание').fill('Новый подрядчик по фасаду')
      await d.getByRole('button', { name: 'Создать заявку' }).click()
      await d.waitFor({ state: 'detached' })

      const note = page.locator('.cr-dp-created')
      await note.waitFor()
      assert.match(await note.innerText(), /Заявка на заключение ДП № 41 подана/)
      const saved = await page.evaluate(() => {
        const r = window.__fakeDb.dp_requests.find((x) => x.request_number === 41)
        const files = window.__fakeDb.s3_documents.filter((f) => f.owner_type === 'dp_request' && f.owner_id === r?.id)
        return r && { id: r.id, status: r.status, object_id: r.object_id, reason: r.reason, files: files.map((f) => f.doc_category) }
      })
      assert.deepEqual({ ...saved, id: undefined }, {
        id: undefined, status: 'new', object_id: 'obj-2', reason: 'Новый подрядчик по фасаду', files: ['dp_concept_agreement'],
      })
      assert.equal(await note.getByRole('link', { name: 'Открыть заявку' }).getAttribute('href'), `/dp-requests?request=${saved.id}`)
      await note.getByRole('button', { name: 'Закрыть' }).click()
      await note.waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('администратор: реестр как раньше (общая папка, «+ Добавить договор», все «Документы») и та же кнопка заявки', async () => {
    const { page, errors, close } = await open()
    try {
      const rows = await page.locator('.contracts-page-v2 tbody').innerText()
      assert.match(rows, /Северный квартал/)
      assert.match(rows, /Нурлы/)
      assert.equal(await page.locator('.contracts-page-v2 .rfpath').count(), 1)
      assert.equal(await page.getByRole('button', { name: '+ Добавить договор' }).count(), 1)
      assert.deepEqual((await tabsRow(page)).slice(0, 2), ['Все', 'cr-dp-add'])
      const cards = await docsCards(page)
      assert.ok(cards.includes('Структура хранения документов') && cards.includes('Стандартные приложения'), cards.join())
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без права подавать заявки на ДП кнопки нет', async () => {
    const { page, errors, close } = await open('noEdit=dp_requests_create')
    try {
      assert.equal(await page.locator('.cr-dp-add').count(), 0)
      assert.deepEqual((await tabsRow(page)).slice(0, 2), ['Все', 'В работе'])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('телефон: кнопка в строке вкладок, окно — в экран', async () => {
    const { page, errors, close } = await open(SITE, { width: 390, height: 800 }, { hasTouch: true, isMobile: true })
    try {
      const btn = page.locator('.cr-dp-add')
      await btn.scrollIntoViewIfNeeded()
      const box = await btn.boundingBox()
      assert.ok(box.height >= 34, `кнопка под палец: ${box.height}px`)
      await btn.tap()
      const d = page.locator('.dpr-dialog')
      await d.waitFor()
      const dialog = await d.boundingBox()
      assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= 390, `окно по ширине экрана: ${dialog.x}, ${dialog.width}`)
      await d.getByRole('button', { name: 'Отмена' }).tap()
      await d.waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
