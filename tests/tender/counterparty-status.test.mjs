// Реестр контрагентов (/general/counterparties): жёлтый статус «Малые суммы» (limited, миграция 20261114) и
// фильтр «Виды работ» в панели.
//   • «Малые суммы» — привлекать можно, но только на небольшие суммы: жёлтый список статуса в строке, контрагент во
//     вкладке «Активные», запись в базу и в журнал «Изменения»; в карточке — жёлтая подпись, у аффилированной
//     компании — плашка; на телефоне — плашка и жёлтая черта слева; импорт Excel понимает «Малые суммы»;
//   • база без значения limited (миграция не применена) — понятное сообщение, статус в строке прежний;
//   • список фильтра «Виды работ» шире поля (длинные названия не ломаются), на телефоне — в пределах экрана.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { cpStatusFromText, cpStatusLabel, isLimitedStatusMissing } from '../../src/utils/counterpartyStatus.js'

const launch = browserLaunchOptions()
const BASE = 'route=/general/counterparties&cps=6&cpContacts=1&cpCard=1&cpLimited=1&items=20&latency=0'

describe('Статус контрагента «Малые суммы»: подписи и разбор', () => {
  it('подписи, импорт из Excel и ошибка базы без значения', () => {
    assert.equal(cpStatusLabel('limited'), 'Малые суммы')
    assert.equal(cpStatusLabel('blacklist'), 'Чёрный список')
    assert.equal(cpStatusLabel(null), 'Активный')
    assert.equal(cpStatusFromText('Малые суммы'), 'limited')
    assert.equal(cpStatusFromText(' малые суммы '), 'limited')
    assert.equal(cpStatusFromText('Черный список'), 'blacklist')
    assert.equal(cpStatusFromText('Чёрный список'), 'blacklist')
    assert.equal(cpStatusFromText('Действующий'), 'active')
    assert.equal(cpStatusFromText(undefined), 'active')
    assert.ok(isLimitedStatusMissing({ code: '22P02', message: 'invalid input value for enum counterparty_status: "limited"' }))
    assert.ok(!isLimitedStatusMissing({ code: '22P02', message: 'invalid input syntax for type uuid' }))
    assert.ok(!isLimitedStatusMissing(null))
  })
})

describe('Реестр контрагентов: «Малые суммы» и фильтр видов работ', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 600000 }, () => {
  let stand
  let browser

  before(async () => {
    stand = await startStand(REPO)
    browser = await chromium.launch({ ...launch, headless: true })
    const page = await browser.newPage()
    await page.goto(`${stand.url}?${BASE}`)
    await page.locator('table.compact-table tbody tr.table-row').first().waitFor({ timeout: 120000 })
    await page.close()
  })
  after(async () => {
    await browser?.close()
    await stand?.server.close()
  })

  async function openPage(query, viewport = { width: 1440, height: 900 }, extra = {}) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport, ...extra })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.goto(`${stand.url}?${query}`)
    await page.locator('table.compact-table tbody tr.table-row, .cp-mrow').first().waitFor({ timeout: 60000 })
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }
  const row = (page, name) => page.locator('table.compact-table tbody tr.table-row', { hasText: name })
  const statusOf = (page, id) => page.evaluate((cpId) => window.__fakeDb.counterparties.find(c => c.id === cpId).status, id)

  it('жёлтый статус в строке, во вкладке «Активные»; смена пишется в базу и журнал', async () => {
    const { page, errors, close } = await openPage(BASE)
    try {
      const sel = row(page, 'Подрядчик 02').locator('select.status-select-mini')
      assert.equal(await sel.inputValue(), 'limited')
      assert.match(await sel.getAttribute('class'), /\blimited\b/)
      assert.match(await sel.getAttribute('title'), /небольшие суммы/)
      const look = await sel.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, cut: el.scrollWidth - el.clientWidth }))
      assert.equal(look.bg, 'rgb(254, 243, 199)', 'жёлтая заливка')
      assert.ok(look.cut <= 1, `подпись «Малые суммы» не помещается: ${look.cut}px`)
      const options = await sel.locator('option').allInnerTexts()
      assert.deepEqual(options, ['Активный', 'Малые суммы', 'ЧС'])
      // Пункты раскрытого списка — своими цветами: «Малые суммы» жёлтым, «ЧС» красным.
      const optionBg = await sel.locator('option').evaluateAll((els) => els.map(el => getComputedStyle(el).backgroundColor))
      assert.deepEqual(optionBg, ['rgb(209, 250, 229)', 'rgb(254, 243, 199)', 'rgb(254, 226, 226)'])

      // «Малые суммы» — в «Активных» (6 контрагентов, из них один в чёрном списке), в «Чёрном списке» — нет.
      assert.match(await page.locator('.cp-tab', { hasText: 'Активные' }).innerText(), /5/)
      await page.locator('.cp-tab-blacklist').click()
      await page.locator('table.compact-table tbody tr.table-row').first().waitFor()
      assert.equal(await row(page, 'Подрядчик 02').count(), 0)
      await page.locator('.cp-tab', { hasText: 'Активные' }).click()

      await row(page, 'Подрядчик 01').locator('select.status-select-mini').selectOption('limited')
      await page.waitForFunction(() => window.__fakeDb.counterparties.find(c => c.id === 'cp-1').status === 'limited')
      await page.waitForFunction(() => window.__fakeDb.counterparty_audit_log.some(r => r.counterparty_id === 'cp-1'))
      const log = await page.evaluate(() => window.__fakeDb.counterparty_audit_log.filter(r => r.counterparty_id === 'cp-1').map(r => r.description))
      assert.ok(log.some(d => /Статус: Действующий → Малые суммы/.test(d)), log.join(' | '))
      assert.match(await row(page, 'Подрядчик 01').locator('select.status-select-mini').getAttribute('class'), /\blimited\b/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('база без значения limited — сообщение про миграцию, статус прежний', async () => {
    const { page, dialogs, close } = await openPage(BASE)
    try {
      await page.evaluate(() => {
        window.__fakeHold = ({ table, op }) => (table === 'counterparties' && op === 'update'
          ? { error: { code: '22P02', message: 'invalid input value for enum counterparty_status: "limited"' } }
          : {})
      })
      const sel = row(page, 'Подрядчик 04').locator('select.status-select-mini')
      await sel.selectOption('limited')
      for (let i = 0; i < 60 && !dialogs.length; i++) await page.waitForTimeout(50)
      assert.ok(dialogs.some(m => /Малые суммы.*20261114/.test(m)), dialogs.join(' | '))
      assert.equal(await statusOf(page, 'cp-4'), 'active')
      assert.equal(await sel.inputValue(), 'active')
    } finally { await close() }
  })

  it('карточка: жёлтая подпись статуса, у аффилированной компании — плашка', async () => {
    const { page, errors, close } = await openPage(BASE)
    try {
      await row(page, 'Подрядчик 02').locator('.company-name').click()
      await page.locator('.cp-detail-modal').waitFor()
      const status = page.locator('.cpg-limited')
      assert.equal(await status.innerText(), 'Малые суммы')
      await page.locator('.cp-detail-modal .modal-close').click()

      await row(page, 'Подрядчик 01').locator('.company-name').click()
      await page.locator('.cp-detail-modal').waitFor()
      const affiliate = page.locator('.cpg-affiliate', { hasText: 'Подрядчик 02' })
      await affiliate.waitFor()
      assert.equal(await affiliate.locator('.cpg-limited-badge').innerText(), 'Малые суммы')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('форма контрагента: «Малые суммы» в выборе статуса и подсказка под ним', async () => {
    const { page, close } = await openPage(BASE)
    try {
      await page.locator('button.btn-add', { hasText: /^\+ Добавить$/ }).first().click()
      const form = page.locator('.modal-overlay .modal form')
      const select = form.locator('.form-group', { has: page.locator('label', { hasText: /^Статус$/ }) }).locator('select')
      assert.deepEqual(await select.locator('option').allInnerTexts(), ['Действующий', 'Малые суммы', 'Черный список'])
      assert.equal(await form.locator('.cp-status-hint').count(), 0)
      await select.selectOption('limited')
      assert.match(await form.locator('.cp-status-hint').innerText(), /только на небольшие суммы/)
    } finally { await close() }
  })

  it('фильтр «Виды работ»: список шире поля, длинные названия в одну строку', async () => {
    const { page, errors, close } = await openPage(BASE)
    try {
      const input = page.locator('.wt-filter-input')
      await input.click()
      const dropdown = page.locator('.wt-filter-dropdown')
      await dropdown.waitFor()
      const box = await page.evaluate(() => {
        const r = (sel) => document.querySelector(sel).getBoundingClientRect()
        const item = [...document.querySelectorAll('.wt-filter-item')].find(el => /Устройство вентилируемых фасадов/.test(el.textContent))
        return {
          input: r('.wt-filter-input').width,
          list: r('.wt-filter-dropdown').width,
          right: r('.wt-filter-dropdown').right,
          vw: window.innerWidth,
          itemHeight: item.getBoundingClientRect().height,
          rowHeight: document.querySelector('.wt-filter-item').getBoundingClientRect().height,
        }
      })
      assert.ok(box.input >= 250, `поле фильтра узкое: ${box.input}px`)
      assert.ok(box.list >= 416, `список уже 26rem: ${box.list}px`)
      assert.ok(box.right <= box.vw, `список уходит за край окна: ${box.right} > ${box.vw}`)
      assert.ok(box.itemHeight <= box.rowHeight + 1, `длинное название переносится: ${box.itemHeight}px против ${box.rowHeight}px`)
      await page.locator('.wt-filter-item', { hasText: 'Устройство вентилируемых фасадов' }).click()
      assert.equal(await input.inputValue(), 'Устройство вентилируемых фасадов')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('телефон: плашка «Малые суммы» и жёлтая черта; список видов работ в пределах экрана', async () => {
    const { page, errors, close } = await openPage(`${BASE}&shell=1`, { width: 390, height: 844 }, { isMobile: true, hasTouch: true })
    try {
      const mrow = page.locator('.cp-mrow', { hasText: 'Подрядчик 02' })
      await mrow.waitFor()
      assert.match(await mrow.getAttribute('class'), /\bis-limited\b/)
      assert.equal(await mrow.locator('.cp-mrow-limited').innerText(), 'Малые суммы')

      await page.locator('.wt-filter-input').click()
      await page.locator('.wt-filter-dropdown').waitFor()
      const box = await page.evaluate(() => {
        const r = document.querySelector('.wt-filter-dropdown').getBoundingClientRect()
        return { left: r.left, right: r.right, vw: window.innerWidth, scroll: document.documentElement.scrollWidth - window.innerWidth }
      })
      assert.ok(box.left >= 0 && box.right <= box.vw, `список вне экрана: ${box.left}–${box.right} из ${box.vw}`)
      assert.ok(box.scroll <= 0, `страница прокручивается вбок на ${box.scroll}px`)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
