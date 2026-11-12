// «Отчёты → Договоры → Заключение ДП» и «Проверка ДП/ДС» в Chromium (стенд tests/tender/ui, contractStats=1 — данные в seed.js).
//   • заявки грузятся при первом открытии подвкладки, не раньше, и не перечитываются при переключении;
//   • карточки, незавершённые и просроченные заявки, разрезы, таблица за период; фильтры пересчитывают всё;
//   • без права на раздел заявок подвкладки нет; без таблицы заявок на ДП — подсказка про миграцию;
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
  const DP_TABLES = ['dp_requests']
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

  it('«Заключение ДП»: грузится при открытии; карточки, незавершённые, разрезы, фильтр', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('.dept-table').waitFor()
      await page.locator('.reports-tab', { hasText: 'Договоры' }).click()
      await page.locator('h3', { hasText: 'По ответственным юристам' }).waitFor()
      assert.equal(await loads(page, DP_TABLES), 0, 'до открытия подвкладки заявки на ДП не грузятся')
      assert.equal(await loads(page, DC_TABLES), 0, 'и заявки на проверку — тоже')
      await page.locator('.reports-subtab', { hasText: 'Заключение ДП' }).click()
      await view(page).locator('.dps-kpi').waitFor({ timeout: 60000 })
      assert.equal(await loads(page, DC_TABLES), 0, 'соседняя подвкладка свои заявки не грузит')

      assert.equal(await kpi(page, 'Всего заявок'), '4')
      assert.match(await view(page).locator('.kpi-card', { hasText: 'Всего заявок' }).locator('.kpi-foot').innerText(), /в «Удалённых»: 1/)
      assert.equal(await kpi(page, 'Сумма заявок'), '3 500 000 ₽')
      assert.equal(await kpi(page, 'Ждут в «Новых»'), '2')
      assert.equal(await kpi(page, 'Не заполнено отделом'), '1')
      const matrix = await matrixRow(page, 'Подано заявок')
      assert.equal(matrix[0], '1', 'сегодня подана одна')
      assert.equal(matrix[3], '4')
      assert.equal((await matrixRow(page, 'Завершено'))[3], '1')

      const waiting = section(page, 'Незавершённые заявки').locator('tbody tr')
      assert.equal(await waiting.count(), 3)
      assert.match(await waiting.first().innerText(), /Договор 3/, 'дольше всех ждёт — сверху')
      assert.equal(await waiting.first().locator('a').getAttribute('href'), '/dp-requests?request=dps-3')
      assert.equal(await waiting.last().locator('td.dps-gap').count(), 4, 'поля отдела у новой заявки не заполнены')

      const objects = section(page, 'По объектам').locator('tbody tr td:first-child')
      assert.deepEqual(await objects.allInnerTexts(), ['ЖК Альфа', 'ЖК Бета', 'Объект не указан'])
      const people = section(page, 'По ответственным').locator('tbody tr td:first-child')
      assert.deepEqual((await people.allInnerTexts()).map((t) => t.split('\n')[0]), ['Экономов А. П.', 'Строев Б. И.', 'Не указан'])

      await view(page).locator('.rf-chip', { hasText: 'Объект' }).locator('select').selectOption({ label: 'ЖК Бета' })
      assert.equal(await kpi(page, 'Всего заявок'), '1')
      await view(page).locator('.rf-reset').click()
      assert.equal(await kpi(page, 'Всего заявок'), '4')

      // Переключение подвкладок не перечитывает заявки.
      const loaded = await loads(page, DP_TABLES)
      await page.locator('.reports-subtab', { hasText: 'Обзор' }).click()
      await page.locator('.reports-subtab', { hasText: 'Заключение ДП' }).click()
      await view(page).locator('.dps-kpi').waitFor()
      assert.equal(await loads(page, DP_TABLES), loaded)
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
      assert.equal(await loads(page, DP_TABLES), 0)

      assert.equal(await kpi(page, 'Всего заявок'), '4')
      assert.match(await view(page).locator('.kpi-card', { hasText: 'Всего заявок' }).locator('.kpi-foot').innerText(),
        /ДП: 1 · ДС: 3 · в архиве: 1 · в «Удалённых»: 1/)
      assert.equal(await kpi(page, 'В работе у отдела'), '2')
      assert.equal(await kpi(page, 'Просрочен срок'), '1')

      assert.equal((await matrixRow(page, 'Создано заявок'))[3], '4')
      assert.equal((await matrixRow(page, 'Взято в работу'))[3], '3')
      assert.equal((await matrixRow(page, 'Завершено'))[3], '1', 'правка поля — не перенос в «Завершено»')

      const attention = view(page).locator('.attn-item', { hasText: 'Скан не вернулся' }).locator('.attn-val')
      assert.equal(await attention.innerText(), '1')
      assert.equal(await view(page).locator('.attn-item', { hasText: 'Без исполнителя' }).locator('.attn-val').innerText(), '1')

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
      await view(page).locator('.rf-chip', { hasText: 'Исполнитель' }).locator('select').selectOption({ label: 'Без исполнителя' })
      assert.equal(await kpi(page, 'Всего заявок'), '1')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('без права на раздел заявок подвкладки нет', async () => {
    const { page, errors, close } = await open('contractStats=1&noView=dp_requests,doc_check_requests')
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

  it('нет таблицы заявок на ДП — подсказка про миграцию, без ошибок', async () => {
    const { page, errors, close } = await open('contractStats=missing')
    try {
      await openSub(page, 'Заключение ДП')
      await view(page).locator('.section-empty', { hasText: '20261227' }).waitFor({ timeout: 60000 })
      assert.equal(await view(page).locator('.dps-kpi').count(), 0)
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
      await view(page).locator('.dps-kpi').waitFor({ timeout: 60000 })
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
