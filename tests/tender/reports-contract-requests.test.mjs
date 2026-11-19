// «Отчёты → Договоры → Заключение ДП» и «Проверка ДП/ДС» в Chromium (стенд tests/tender/ui, contractStats=1 — данные в seed.js).
// С 19.11.2026 заявки на заключение ДП — карточки доски проверки ДП/ДС, «Заключение ДП» — отчёт доски по одному виду.
//   • заявки грузятся при первом открытии подвкладки, не раньше, и не перечитываются при переключении;
//   • карточки, незавершённые и просроченные заявки, разрезы, таблица за период; фильтры пересчитывают всё;
//   • без права на доску подвкладок нет;
//   • телефон: страница не прокручивается вбок.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const plain = (s) => s.replace(/[\u00a0\u202f]/g, ' ')

describe('Отчёты: заключение ДП и проверка ДП/ДС', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open(query = 'contractStats=1', viewport = { width: 1600, height: 1000 }) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    await page.goto(`${stand.url}?route=/reports&${query}&latency=10&shell=1`)
    await page.locator('.reports-tabs').waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }

  const loads = (page, tables) => page.evaluate((list) => window.__supabaseStats.requests
    .filter((r) => list.includes(r.table)).length, tables)
  const DC_TABLES = ['doc_check_requests', 'doc_check_request_audit_log']
  const openSub = async (page, label) => {
    await page.locator('.reports-tab', { hasText: 'Договоры' }).click()
    await page.locator('.reports-subtab', { hasText: label }).click()
  }
  const view = (page) => page.locator('.reports-subview:not([hidden])')
  const kpi = async (page, label) => plain(await view(page).locator('.kpi-card', { has: page.locator(`.kpi-label:text-is("${label}")`) })
    .locator('.kpi-value').innerText())
  const matrixRow = async (page, label) => (await view(page).locator('.kps-matrix tbody tr', { has: page.locator(`td:text-is("${label}")`) })
    .locator('td.num').allInnerTexts()).map(plain)
  const section = (page, title) => view(page).locator('.report-section', { has: page.locator('h3', { hasText: title }) })

  it('«Заключение ДП»: грузится при открытии; только этот вид, без выбора документа; разрезы и фильтр', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('.dept-table').waitFor()
      await page.locator('.reports-tab', { hasText: 'Договоры' }).click()
      await page.locator('h3', { hasText: 'По ответственным юристам' }).waitFor()
      assert.equal(await loads(page, DC_TABLES), 0, 'до открытия подвкладки заявки не грузятся')
      await page.locator('.reports-subtab', { hasText: 'Заключение ДП' }).click()
      await view(page).locator('.dck-kpi').waitFor({ timeout: 60000 })

      assert.equal(await kpi(page, 'Всего заявок'), '2')
      assert.equal(await view(page).locator('.kpi-card', { hasText: 'Всего заявок' }).locator('.kpi-foot').innerText(), '')
      assert.equal(await kpi(page, 'В работе у отдела'), '2')
      const created = await matrixRow(page, 'Создано заявок')
      assert.equal(created[0], '1', 'сегодня подана одна')
      assert.equal(created[3], '2')
      assert.equal((await matrixRow(page, 'Взято в работу'))[3], '1')
      assert.equal(await view(page).locator('.rf-chip', { hasText: 'Документ' }).count(), 0, 'вид задан подвкладкой')

      const objects = section(page, 'По объектам').locator('tbody tr td:first-child')
      assert.deepEqual((await objects.allInnerTexts()).sort(), ['ЖК Альфа', 'ЖК Бета'])
      await view(page).locator('.rf-chip', { hasText: 'Объект' }).locator('select').selectOption({ label: 'ЖК Бета' })
      assert.equal(await kpi(page, 'Всего заявок'), '1')
      await view(page).locator('.rf-reset').click()
      assert.equal(await kpi(page, 'Всего заявок'), '2', 'сброс не снимает вид')

      // Переключение подвкладок не перечитывает заявки.
      const loaded = await loads(page, DC_TABLES)
      await page.locator('.reports-subtab', { hasText: 'Обзор' }).click()
      await page.locator('.reports-subtab', { hasText: 'Заключение ДП' }).click()
      await view(page).locator('.dck-kpi').waitFor()
      assert.equal(await loads(page, DC_TABLES), loaded)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('«Проверка ДП/ДС»: колонки, сроки, исполнители, история, фильтр', async () => {
    const { page, errors, close } = await open()
    try {
      await openSub(page, 'Проверка ДП/ДС')
      await view(page).locator('.dck-kpi').waitFor({ timeout: 60000 })

      assert.equal(await kpi(page, 'Всего заявок'), '6')
      assert.match(await view(page).locator('.kpi-card', { hasText: 'Всего заявок' }).locator('.kpi-foot').innerText(),
        /ДП: 1 · ДС: 3 · заключение ДП: 2 · в архиве: 1 · в «Удалённых»: 1/)
      assert.equal(await kpi(page, 'В работе у отдела'), '4')
      assert.equal(await kpi(page, 'Просрочен срок'), '1')

      assert.equal((await matrixRow(page, 'Создано заявок'))[3], '6')
      assert.equal((await matrixRow(page, 'Взято в работу'))[3], '4')
      assert.equal((await matrixRow(page, 'Завершено'))[3], '1', 'правка поля — не перенос в «Завершено»')

      const attention = view(page).locator('.attn-item', { hasText: 'Скан не вернулся' }).locator('.attn-val')
      assert.equal(await attention.innerText(), '1')
      assert.equal(await view(page).locator('.attn-item', { hasText: 'Без исполнителя' }).locator('.attn-val').innerText(), '2')

      const overdue = section(page, 'Просроченные заявки').locator('tbody tr')
      assert.equal(await overdue.count(), 1)
      assert.match(await overdue.innerText(), /ДП № СУ-002/)
      assert.match(await overdue.innerText(), /Юристова М\. А\., Правов П\. П\./)
      assert.equal(await overdue.locator('a').getAttribute('href'), '/doc-check-requests?request=dck-2')

      const people = section(page, 'По исполнителям').locator('tbody tr td:first-child')
      assert.deepEqual(await people.allInnerTexts(), ['Правов П. П.', 'Юристова М. А.', 'Без исполнителя'])

      await view(page).locator('.rf-chip', { hasText: 'Документ' }).locator('select').selectOption('dp')
      assert.equal(await kpi(page, 'Всего заявок'), '1')
      await view(page).locator('.rf-reset').click()
      await view(page).locator('.rf-chip', { hasText: 'Документ' }).locator('select').selectOption('dp_conclusion')
      assert.equal(await kpi(page, 'Всего заявок'), '2')
      await view(page).locator('.rf-reset').click()
      await view(page).locator('.rf-chip', { hasText: 'Исполнитель' }).locator('select').selectOption({ label: 'Без исполнителя' })
      assert.equal(await kpi(page, 'Всего заявок'), '2')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('без права на раздел заявок подвкладки нет', async () => {
    const { page, errors, close } = await open('contractStats=1&noView=doc_check_requests')
    try {
      await page.locator('.reports-tab', { hasText: 'Договоры' }).click()
      await page.locator('.reports-subtab', { hasText: 'Заявки на ДС' }).waitFor()
      assert.equal(await page.locator('.reports-subtab', { hasText: 'Заключение ДП' }).count(), 0)
      assert.equal(await page.locator('.reports-subtab', { hasText: 'Проверка ДП/ДС' }).count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('телефон: страница не прокручивается вбок', async () => {
    const { page, errors, close } = await open('contractStats=1', { width: 360, height: 800 })
    try {
      const side = () => page.evaluate(() => {
        const main = document.querySelector('.main-content')
        return Math.max(document.documentElement.scrollWidth - window.innerWidth, main.scrollWidth - main.clientWidth)
      })
      await openSub(page, 'Заключение ДП')
      await view(page).locator('.dck-kpi').waitFor({ timeout: 60000 })
      assert.ok(await side() <= 0, 'заключение ДП: прокрутка вбок')
      await page.locator('.reports-subtab', { hasText: 'Проверка ДП/ДС' }).click()
      await view(page).locator('.dck-kpi').waitFor({ timeout: 60000 })
      assert.ok(await side() <= 0, 'проверка ДП/ДС: прокрутка вбок')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
