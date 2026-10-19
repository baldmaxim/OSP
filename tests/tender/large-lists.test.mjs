// Длинные списки в настоящем браузере на стенде тендеров: в DOM — только видимые строки (VirtualTableBody),
// а работать можно со всеми.
//   • Расценка снабжением у большого тендера (2 300 позиций, как у самых больших ВОР прода): таблица — окно строк
//     с прокруткой внутри, последняя позиция достаётся прокруткой, цена в ней сохраняется.
//   • Реестр «Тендеры на материалы» (360 тендеров, как на проде) в обвязке приложения: прокручивается
//     .main-content, а не окно, — окно строк следует за ней, последний тендер на месте, поиск находит любой.
// До этого всё рисовалось целиком: 27 тыс. элементов в реестре, секунды на открытие и подвисания при прокрутке.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()

describe('Длинные списки: только видимые строки', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open(query) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1400, height: 900 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    await page.goto(`${stand.url}?items=20&cps=1&latency=10&${query}`)
    return { page, context, errors }
  }

  it('расценка: 2 300 позиций — в таблице окно строк; последняя позиция прокруткой, цена в ней сохраняется', async () => {
    const { page, context, errors } = await open('route=/tenders/materials/mat-p/pricing&tenders=3&bigPricing=2300')
    try {
      await page.getByText('ВОР «Корпус 1»', { exact: true }).waitFor({ timeout: 120000 })
      const inDom = await page.locator('.sp-table tbody tr:not(.vt-spacer)').count()
      assert.ok(inDom < 120, `в DOM ${inDom} строк, а не 2 300`)
      assert.match((await page.locator('.sp-summary-inline').innerText()).replace(/\s/g, ''), /Расценено767из2300/)
      // Последняя позиция последнего ВОР — прокруткой таблицы до конца.
      const last = 'Цена за единицу: Материал 8.200 — труба стальная электросварная Ø96×3,5 ГОСТ 10704-91 (ВОР «Корпус 8»)'
      const wrap = page.locator('.sp-table-wrap.is-virtual')
      for (let i = 0; i < 40 && !(await page.getByLabel(last).count()); i++) {
        await wrap.evaluate((el) => { el.scrollTop = el.scrollHeight })
        await page.waitForTimeout(100)
      }
      const field = page.getByLabel(last)
      await field.focus()
      await page.waitForTimeout(60)
      await field.fill('777')
      await field.press('Enter')
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((r) => r.estimate_name === 'Корпус 8' && r.supply_price === 777))
      await page.locator('.sp-table tbody tr', { has: page.getByLabel(last) }).locator('.sp-st.is-saved').waitFor()
      // Итог закреплён внизу окна прокрутки и пересчитан.
      assert.match((await page.locator('.sp-table tfoot').innerText()).replace(/\s/g, ''), /расценено768из2300/)
      // Поиск сужает таблицу до найденного — без прокрутки.
      await page.getByLabel('Поиск по наименованию материала').fill('Материал 5.77 ')
      await page.getByLabel('Цена за единицу: Материал 5.77 — труба стальная электросварная Ø93×3,5 ГОСТ 10704-91 (ВОР «Корпус 5»)').waitFor()
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('реестр «Тендеры на материалы»: 360 тендеров в обвязке приложения — окно строк следует за прокруткой .main-content', async () => {
    const { page, context, errors } = await open('route=/tenders/materials&tenders=360&matTenders=1&shell=1')
    try {
      await page.locator('table.tenders-registry tbody tr').nth(5).waitFor({ timeout: 120000 })
      const rows = () => page.locator('table.tenders-registry tbody tr:not(.vt-spacer)')
      const inDom = await rows().count()
      assert.ok(inDom < 80, `в DOM ${inDom} строк, а не 360`)
      const numbers = () => rows().locator('td.tp-num').allInnerTexts()
      // Прокручивается .main-content (как в приложении), а не окно: шагами по экрану — каждый тендер списка
      // хотя бы раз попадает в окно строк, и ни один не теряется.
      const scroller = page.locator('.main-content')
      const seen = new Set(await numbers())
      for (let i = 0; i < 200; i++) {
        const atEnd = await scroller.evaluate((el) => { el.scrollTop += el.clientHeight * 0.8; return el.scrollTop + el.clientHeight >= el.scrollHeight - 2 })
        await page.waitForTimeout(40)
        for (const n of await numbers()) seen.add(n)
        if (atEnd) break
      }
      await page.waitForTimeout(200)
      for (const n of await numbers()) seen.add(n)
      // В стенде 360 тендеров на материалы основного строительства — все в списке по умолчанию.
      assert.equal(seen.size, 360, 'каждый тендер был в окне строк')
      assert.ok(await rows().count() < 80, 'и в DOM по-прежнему только окно')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
})
