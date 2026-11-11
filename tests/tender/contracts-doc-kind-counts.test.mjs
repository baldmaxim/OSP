// «Реестр по договорам» (/contracts/registry): числа на вкладках вида документа и на статусах.
//   • вид документа — вкладки с числами (11.11.2026: вкладки «Все» нет — это «Договоры и ДС»), статусы — переключатели;
//   • «Договоры и ДС» — договоры и ДС вместе (раньше — одни договоры); «Договоры» (вид вернули 05.11) — только договоры;
//   • на вкладке статуса видны и ДС этого статуса: договор в другом статусе — строкой «показан ради ДС»,
//     раскрыт сразу (ДС — в правой области под строкой). Правила — utils/contractRegistryTabs
//     (tests/contracts/registry-tabs.test.mjs); раскрытый договор — tests/tender/contracts-expanded.test.mjs.
// Стенд: 30 документов — 20 договоров и 10 ДС, пять договоров «Завершено» с ДС «В работе».
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const BASE = 'route=/contracts/registry&contracts=30&contractsMixed=1&latency=0'

describe('Договоры и ДС: счётчики вида «Документ»', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  it('«Договоры и ДС» = «Договоры» + «ДС», ДС «В работе» видны под завершённым договором', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    try {
      await page.goto(`${stand.url}?${BASE}`)
      const rows = page.locator('.contracts-table tbody tr.contract-row')
      await rows.first().waitFor({ timeout: 120000 })

      const counts = async () => page.evaluate(() => {
        const read = (sel, attr) => Object.fromEntries([...document.querySelectorAll(sel)].map((b) => [
          b.getAttribute(attr), Number(b.querySelector('[class*="-count"]')?.textContent),
        ]))
        return { kinds: read('.cr-kind-tab', 'data-kind'), tabs: read('.cr-status-chip', 'data-tab') }
      })
      const pick = async (kind) => {
        await page.locator(`.cr-kind-tab[data-kind="${kind}"]`).click()
        return counts()
      }

      // Числа вида документа — без выбранного статуса; на статусах — внутри выбранного вида.
      const both = await pick('all')
      assert.deepEqual(both.kinds, { all: 30, contracts: 20, amendments: 10 })
      const onlyContracts = await pick('contracts')
      const amendments = await pick('amendments')
      assert.deepEqual([onlyContracts.tabs.in_work, amendments.tabs.in_work, both.tabs.in_work], [15, 10, 25])
      assert.equal(both.tabs.completed, 5)
      // Статус выбран — числа вида документа считают его.
      await page.locator('.cr-status-chip[data-tab="in_work"]').click()
      assert.deepEqual((await counts()).kinds, { all: 25, contracts: 15, amendments: 10 })
      await page.locator('.cr-status-chip[data-tab="in_work"]').click()

      await pick('all')
      await page.locator('.cr-status-chip[data-tab="in_work"]').click()
      // 15 договоров «В работе» + 5 завершённых ради их ДС; последние раскрыты сразу — их ДС в правой
      // области «Дополнительные соглашения» (строками таблицы ДС больше не показываются).
      await page.locator('.ctx-ds-note').first().waitFor()
      assert.equal(await page.locator('.contracts-table tbody tr.contract-row').count(), 20)
      assert.equal(await page.locator('.ctx-ds-note').count(), 5)
      assert.equal(await page.locator('.contracts-table tbody tr.contract-expanded-row').count(), 5)
      assert.equal(await page.locator('.contracts-table .ce2-area-ds .ce2-ds').count(), 5)
      assert.match(await page.locator('.registry-pagination.is-top .rp-info').innerText(), /из 20 договоров · ДС к ним: 10/)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('вид «Договоры»: только договоры по своему статусу, вкладки и поиск работают вместе с ним, выбор переживает обновление', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    try {
      await page.goto(`${stand.url}?${BASE}`)
      const rows = page.locator('.contracts-table tbody tr.contract-row')
      await rows.first().waitFor({ timeout: 120000 })
      const KIND = { 'Договоры и ДС': 'all', 'Договоры': 'contracts', 'ДС': 'amendments' }
      const TAB = { 'В работе': 'in_work', 'Завершено': 'completed' }
      const kind = (label) => page.locator(`.cr-kind-tab[data-kind="${KIND[label]}"]`)
      const tab = (label) => page.locator(`.cr-status-chip[data-tab="${TAB[label]}"]`)
      const info = () => page.locator('.registry-pagination.is-top .rp-info').innerText()
      const search = page.locator('.cr-search')
      const waitInfo = (re) => page.waitForFunction(({ source }) => new RegExp(source).test(document.querySelector('.registry-pagination.is-top .rp-info')?.textContent || ''), { source: re.source })

      await kind('Договоры').click()
      assert.equal(await kind('Договоры').getAttribute('aria-selected'), 'true')
      await waitInfo(/из 20 договоров$/)
      assert.equal(await rows.count(), 20)
      assert.equal(await page.locator('.contracts-table tbody tr.contract-expanded-row').count(), 0, 'строк, раскрытых ради ДС, нет')

      // Вкладка: договор — по своему статусу, завершённый договор ради его ДС «В работе» не показывается.
      await tab('В работе').click()
      await waitInfo(/из 15 договоров$/)
      assert.equal(await rows.count(), 15)
      assert.equal(await page.locator('.ctx-ds-note').count(), 0)

      // У завершённых договоров ДС «В работе»: видны и считаются — все ДС договора, а не только этой вкладки.
      await tab('Завершено').click()
      await waitInfo(/из 5 договоров$/)
      assert.equal(await page.locator('.contracts-table .ds-toggle').count(), 5)
      await page.locator('.contracts-table .ds-toggle').first().click()
      await page.locator('.contracts-table .ce2-area-ds .ce2-ds').first().waitFor()

      // Поиск: номер ДС (15/26) в «Договорах» не находит ничего, в «ДС» — это ДС, в «Договорах и ДС» — его договор.
      await tab('Завершено').click() // повторное нажатие снимает статус — снова все
      assert.equal(await tab('Завершено').getAttribute('aria-pressed'), 'false')
      await search.fill('14/26')
      await waitInfo(/из 1 договор$/)
      await search.fill('15/26')
      await page.getByText('Нет договоров под выбранные фильтры.').waitFor()
      assert.equal(await rows.count(), 0)
      await kind('ДС').click()
      await waitInfo(/из 1 соглашение$/)
      await kind('Договоры и ДС').click()
      await waitInfo(/из 1 договор · ДС к ним: 1$/)
      await search.fill('')

      // Быстрый фильтр не сбрасывает вид и считается внутри него: у всех договоров стенда нет пути Larix.
      await kind('Договоры').click()
      await page.locator('.cr-toolbar .qfilter', { hasText: 'Не в Larix' }).click()
      await waitInfo(/из 20 договоров$/)
      await page.locator('.cr-toolbar .cr-filter-clear').click()
      assert.equal(await kind('Договоры').getAttribute('aria-selected'), 'true', '«Сбросить» вид не снимает')

      await page.reload()
      await rows.first().waitFor({ timeout: 60000 })
      assert.equal(await kind('Договоры').getAttribute('aria-selected'), 'true', 'выбор помнит браузер')
      await waitInfo(/из 20 договоров$/)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
})
