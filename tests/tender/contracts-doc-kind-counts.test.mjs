// «Реестр по договорам» (/contracts/registry): счётчики вкладок и охвата при выборе «Документ».
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
        const read = (sel) => Object.fromEntries([...document.querySelectorAll(sel)].map((b) => [
          b.firstChild.textContent.trim(), Number(b.querySelector('[class$="-count"]')?.textContent),
        ]))
        return { tabs: read('.status-tab'), scopes: read('.registry-scope-btn') }
      })
      const pick = async (label) => {
        await page.locator('.rf-doc-kind-btn', { hasText: new RegExp(`^${label}$`) }).click()
        return counts()
      }

      const both = await pick('Договоры и ДС')
      const onlyContracts = await pick('Договоры')
      const amendments = await pick('ДС')
      assert.deepEqual([onlyContracts.tabs['Все'], amendments.tabs['Все'], both.tabs['Все']], [20, 10, 30])
      assert.deepEqual([onlyContracts.tabs['В работе'], amendments.tabs['В работе'], both.tabs['В работе']], [15, 10, 25])
      assert.equal(both.tabs['Завершено'], 5)
      assert.equal(both.scopes['Все договоры'], 30)
      assert.equal(onlyContracts.scopes['Все договоры'], 20)

      await pick('Договоры и ДС')
      await page.locator('.status-tab', { hasText: 'В работе' }).click()
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
      const kind = (label) => page.locator('.rf-doc-kind-btn', { hasText: new RegExp(`^${label}$`) })
      const tab = (label) => page.locator('.status-tab', { hasText: label })
      const info = () => page.locator('.registry-pagination.is-top .rp-info').innerText()
      const search = page.locator('.cr-search')
      const waitInfo = (re) => page.waitForFunction(({ source }) => new RegExp(source).test(document.querySelector('.registry-pagination.is-top .rp-info')?.textContent || ''), { source: re.source })

      await kind('Договоры').click()
      assert.equal(await kind('Договоры').getAttribute('aria-checked'), 'true')
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
      await tab('Все').click()
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
      assert.equal(await kind('Договоры').getAttribute('aria-checked'), 'true', '«Сбросить» вид не снимает')

      await page.reload()
      await rows.first().waitFor({ timeout: 60000 })
      assert.equal(await kind('Договоры').getAttribute('aria-checked'), 'true', 'выбор помнит браузер')
      await waitInfo(/из 20 договоров$/)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
})
