// «Отчёты → Заявки на ДС» в Chromium (стенд tests/tender/ui, dcStats=1: пять заявок и одна удалённая).
//   • заявки и журнал статусов грузятся при первом открытии вкладки, не раньше;
//   • карточки: всего, подано / утверждено, просрочка срока; этапы, итог проверки, за период;
//   • просроченные заявки списком, разрезы по объектам и ответственным; фильтры пересчитывают всё.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const plain = (s) => s.replace(/[  ]/g, ' ')

describe('Отчёты: заявки на ДС', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open(viewport = { width: 1600, height: 1000 }) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    await page.goto(`${stand.url}?route=/reports&dcStats=1&latency=10&shell=1`)
    await page.locator('.reports-tabs').waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }

  const dcRequests = (page) => page.evaluate(() => window.__supabaseStats.requests
    .filter((r) => r.table === 'dc_requests' || r.table === 'dc_request_audit_log').length)
  const kpi = (page, label) => page.locator('.kpi-card', { hasText: label }).locator('.kpi-value').innerText()
  const matrixRow = async (page, label) => (await page.locator('.kps-matrix tbody tr', { has: page.locator(`td:text-is("${label}")`) })
    .locator('td.num').allInnerTexts()).map(plain)

  it('вкладка грузит данные при открытии; карточки, периоды, просроченные, разрезы', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('.dept-table').waitFor()
      assert.equal(await dcRequests(page), 0, 'до открытия вкладки заявки не грузятся')
      await page.locator('.reports-tab', { hasText: 'Заявки на ДС' }).click()
      await page.locator('.dcs-kpi').waitFor({ timeout: 60000 })

      assert.equal(await kpi(page, 'Всего заявок'), '5')
      assert.match(await page.locator('.kpi-card', { hasText: 'Всего заявок' }).locator('.kpi-foot').innerText(), /в «Удалённых»: 1/)
      assert.equal(plain(await kpi(page, 'Было подано')), '3 500 000 ₽')
      assert.match(plain(await kpi(page, 'Утверждено к поданному')), /^[-−]10 %$/)
      assert.equal(await kpi(page, 'Просрочен срок утверждения'), '1')

      // Сегодня создана одна заявка, остальные — 40 и 210 дней назад.
      assert.deepEqual(await matrixRow(page, 'Создано заявок'), ['1', '1', '1', '5'])
      assert.equal((await matrixRow(page, 'Завершено'))[3], '1', 'завершение без записи в журнале не считается')
      assert.equal((await matrixRow(page, 'Утверждено, ₽'))[3], '1 800 000 ₽')

      const overdue = page.locator('.dcs-overdue tbody tr')
      assert.equal(await overdue.count(), 1)
      assert.match(await overdue.innerText(), /ДС-d2/)
      assert.match(await overdue.innerText(), /Итог проверки/)

      const objects = page.locator('.report-section', { has: page.locator('h3', { hasText: 'По объектам' }) }).locator('tbody tr td:first-child')
      assert.deepEqual(await objects.allInnerTexts(), ['ЖК Альфа', 'ЖК Бета'])
      const people = page.locator('.report-section', { has: page.locator('h3', { hasText: 'По ответственным' }) }).locator('tbody tr td:first-child')
      assert.deepEqual(await people.allInnerTexts(), ['Юристов Ю. Ю.', 'Не назначен'])

      // Переключение вкладок не перечитывает заявки.
      const loaded = await dcRequests(page)
      await page.locator('.reports-tab', { hasText: 'Договоры' }).click()
      await page.locator('.reports-tab', { hasText: 'Заявки на ДС' }).click()
      await page.locator('.dcs-kpi').waitFor()
      assert.equal(await dcRequests(page), loaded)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('фильтры: отдел и ответственный пересчитывают карточки и таблицы', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('.reports-tab', { hasText: 'Заявки на ДС' }).click()
      await page.locator('.dcs-kpi').waitFor({ timeout: 60000 })
      await page.locator('.rf-chip', { hasText: 'Отдел' }).locator('select').selectOption('warranty_service')
      assert.equal(await kpi(page, 'Всего заявок'), '1')
      assert.equal(await kpi(page, 'Просрочен срок утверждения'), '0')
      await page.locator('.rf-reset').click()
      assert.equal(await kpi(page, 'Всего заявок'), '5')
      await page.locator('.rf-chip', { hasText: 'Ответственный' }).locator('select').selectOption('_unassigned')
      assert.equal(await kpi(page, 'Всего заявок'), '1')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('телефон: страница не прокручивается вбок', async () => {
    const { page, errors, close } = await open({ width: 360, height: 800 })
    try {
      await page.locator('.reports-tab', { hasText: 'Заявки на ДС' }).click()
      await page.locator('.dcs-kpi').waitFor({ timeout: 60000 })
      const side = await page.evaluate(() => {
        const main = document.querySelector('.main-content')
        return Math.max(document.documentElement.scrollWidth - window.innerWidth, main.scrollWidth - main.clientWidth)
      })
      assert.ok(side <= 0, `прокрутка вбок: ${side}px`)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
