// «Договоры и ДС» (/contracts): счётчики вкладок и охвата при выборе «Документ».
//   • «Договоры и ДС» — договоры и ДС вместе (раньше — одни договоры, то же число, что «Договоры»);
//   • на вкладке статуса видны и ДС этого статуса: договор в другом статусе — строкой «показан ради ДС»,
//     раскрыт сразу (ДС — в правой области под строкой). Правила — utils/contractRegistryTabs
//     (tests/contracts/registry-tabs.test.mjs); раскрытый договор — tests/tender/contracts-expanded.test.mjs.
// Стенд: 30 документов — 20 договоров и 10 ДС, пять договоров «Завершено» с ДС «В работе».
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const BASE = 'route=/contracts&contracts=30&contractsMixed=1&latency=0'

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
      const contracts = await pick('Договоры')
      const amendments = await pick('ДС')
      assert.deepEqual(
        [contracts.tabs['Общий реестр'], amendments.tabs['Общий реестр'], both.tabs['Общий реестр']], [20, 10, 30])
      assert.deepEqual([contracts.tabs['В работе'], amendments.tabs['В работе'], both.tabs['В работе']], [15, 10, 25])
      assert.equal(both.tabs['Завершено'], 5)
      assert.equal(both.scopes['Все договоры'], 30)
      for (const k of Object.keys(both.tabs)) assert.equal(both.tabs[k], contracts.tabs[k] + amendments.tabs[k], k)

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
})
