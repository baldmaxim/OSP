// «Отчёты» в настоящем браузере: две вкладки с подвкладками («Тендеры», «Договоры» — обзор и заявки на ДС) и подвкладка
// «Коммерческие предложения» — загрузка, проверка и очередь КП. Данные — стенд (tests/tender/ui, kpStats=1):
// 360 файлов КП за 120 дней, по 3 в день, каждый седьмой — гарантийный отдел.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()

describe('Отчёты: вкладки «Тендеры», «Договоры», статистика КП', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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
    await page.goto(`${stand.url}?route=/reports&kpStats=1&latency=10`)
    await page.locator('.reports-tabs').waitFor({ timeout: 120000 })
    return { context, page, errors }
  }

  const matrixRow = (page, label) => page.locator('.kps-matrix tbody tr', { has: page.locator(`td:text-is("${label}")`) })
    .locator('td.num').allInnerTexts()
  const kpRequests = (page) => page.evaluate(() => window.__supabaseStats.requests
    .filter((r) => r.table === 'tender_proposal_files').length)

  it('две вкладки; в «Тендерах» — обзор, КП, победители, материалы, планы затрат, ВОРы; в «Договорах» — обзор, заявки на ДС', async () => {
    const { context, page, errors } = await open()
    try {
      assert.deepEqual(await page.locator('.reports-tab .reports-tab-label').allInnerTexts(), ['Тендеры', 'Договоры'])
      const subs = await page.locator('.reports-subtab').evaluateAll((els) => els.map((e) => e.childNodes[0].textContent))
      assert.deepEqual(subs, ['Обзор', 'Коммерческие предложения', 'Победители', 'Материалы', 'Планы затрат', 'ВОРы и РД'])
      // Обзор открыт сразу, КП не грузятся, пока подвкладку не открыли.
      await page.locator('.dept-table').waitFor()
      assert.equal(await kpRequests(page), 0)

      await page.locator('.reports-subtab', { hasText: 'Планы затрат' }).click()
      await page.locator('h3', { hasText: 'По ответственным за план затрат' }).waitFor()

      await page.locator('.reports-tab', { hasText: 'Договоры' }).click()
      await page.locator('h3', { hasText: 'По ответственным юристам' }).waitFor()
      const contractSubs = await page.locator('.reports-subtab').evaluateAll((els) => els.map((e) => e.childNodes[0].textContent))
      assert.deepEqual(contractSubs, ['Обзор', 'Заявки на ДС'])
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('КП: загружено и проверено по периодам, отбор по направлению, без перезагрузки при переключении', async () => {
    const { context, page, errors } = await open()
    try {
      await page.locator('.reports-subtab', { hasText: 'Коммерческие предложения' }).click()
      await page.locator('.kps-matrix').waitFor({ timeout: 60000 })

      const uploaded = await matrixRow(page, 'Загружено КП')
      assert.equal(uploaded[0], '3', 'сегодня — три КП')
      assert.equal(uploaded[3], '360', 'всего — все файлы КП, и прежние')
      // Проверено: только с «Проверкой КП» (моложе 90 дней) и старше 3 дней — 87 дней × 3.
      assert.equal((await matrixRow(page, 'Проверено аналитиком'))[3], '261')
      assert.equal(await page.locator('.kpi-card', { hasText: 'На проверке сейчас' }).locator('.kpi-value').innerText(), '9')
      assert.equal(await page.locator('.kpi-card', { hasText: 'Загружено сегодня' }).locator('.kpi-value').innerText(), '3')

      // Кто загружает: три строки (двое + «Не указан»), всего по 120.
      const people = await page.locator('.kps-people').first().locator('tbody tr').count()
      assert.equal(people, 3)

      // Отбор: гарантийный отдел — каждый седьмой файл.
      await page.locator('.kps-toolbar select').selectOption('warranty')
      assert.equal((await matrixRow(page, 'Загружено КП'))[3], '52')
      await page.locator('.kps-toolbar select').selectOption('all')

      // График: по дням — 14 столбцов.
      await page.locator('.kps-gran button', { hasText: 'По дням' }).click()
      assert.equal(await page.locator('.bars-svg .bar-x').count(), 14)

      // Возврат с другой подвкладки не перечитывает КП.
      const before = await kpRequests(page)
      await page.locator('.reports-subtab', { hasText: 'Обзор' }).click()
      await page.locator('.dept-table').waitFor()
      assert.equal(await page.locator('.kps-matrix').isVisible(), false)
      await page.locator('.reports-subtab', { hasText: 'Коммерческие предложения' }).click()
      await page.locator('.kps-matrix').waitFor()
      assert.equal(await kpRequests(page), before)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('телефон: подвкладки и таблицы КП прокручиваются внутри, страница — нет', async () => {
    const { context, page, errors } = await open({ width: 390, height: 844 })
    try {
      await page.locator('.reports-subtab', { hasText: 'Коммерческие предложения' }).click()
      await page.locator('.kps-matrix').waitFor({ timeout: 60000 })
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert.ok(overflow <= 0, `страница шире экрана на ${overflow}px`)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
})
