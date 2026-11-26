// Длинные списки в настоящем браузере на стенде тендеров: в DOM — только видимые строки (VirtualTableBody),
// а работать можно со всеми.
//   • Расценка снабжением у большого тендера (2 300 позиций, как у самых больших ВОР прода): таблица — окно строк
//     с прокруткой внутри, последняя позиция достаётся прокруткой, цена в ней сохраняется.
//   • Реестр «Тендеры на материалы» (360 тендеров, как на проде) в обвязке приложения: прокручивается
//     .main-content, а не окно, — окно строк следует за ней, последний тендер на месте, поиск находит любой.
//   • Реестр «Основное строительство» (300 тендеров) так же (24.11.2026: 700 тендеров — 68 тыс. элементов, открытие 4 с,
//     «Сбросить все» и сортировка — по 1,6 с подвисания). Раскрытые участники — часть строки тендера (vt-part).
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
      await page.locator('.sp-vors > summary', { hasText: 'ВОРы тендера: 8' }).waitFor({ timeout: 120000 })
      const inDom = await page.locator('.sp-table tbody tr:not(.vt-spacer)').count()
      assert.ok(inDom < 120, `в DOM ${inDom} строк, а не 2 300`)
      await page.getByRole('button', { name: 'Расценены (767)', exact: true }).waitFor()
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
      await page.getByRole('button', { name: 'Расценены (768)', exact: true }).waitFor()
      assert.match((await page.locator('.sp-table tfoot').innerText()).replace(/\s/g, ''), /Итого/)
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

  it('реестр «Основное строительство»: 300 тендеров — окно строк; раскрытие, прокрутка до конца, поиск и «Сбросить все»', async () => {
    const { page, context, errors } = await open('route=/tenders/construction&tenders=300&shell=1')
    try {
      const rows = () => page.locator('table.tenders-registry > tbody > tr:not(.vt-spacer)')
      await rows().nth(5).waitFor({ timeout: 120000 })
      assert.ok(await rows().count() < 80, `в DOM ${await rows().count()} строк, а не 300`)
      const total = await page.evaluate(() => window.__fakeDb.tenders.filter((t) => t.tender_type === 'main' && !t.deleted_at
        && (t.department || 'construction') === 'construction').length)
      assert.ok(total > 250, `тендеров в реестре: ${total}`)

      // Раскрытие первой строки: участники — под ней, строкой той же записи.
      await rows().first().locator('.expand-toggle').click()
      const expanded = page.locator('table.tenders-registry > tbody > tr.vt-part')
      await expanded.locator('.expanded-cp-row').waitFor()
      assert.equal(await expanded.count(), 1)

      // Прокрутка .main-content шагами: каждый тендер хоть раз в окне строк, раскрытая строка не сбивает окно.
      const numbers = () => rows().locator('.tp-num-value').allInnerTexts()
      const scroller = page.locator('.main-content')
      const seen = new Set(await numbers())
      for (let i = 0; i < 400; i++) {
        const atEnd = await scroller.evaluate((el) => { el.scrollTop += el.clientHeight * 0.8; return el.scrollTop + el.clientHeight >= el.scrollHeight - 2 })
        await page.waitForTimeout(40)
        for (const n of await numbers()) seen.add(n)
        if (atEnd) break
      }
      await page.waitForTimeout(200)
      for (const n of await numbers()) seen.add(n)
      assert.equal(seen.size, total, 'каждый тендер был в окне строк')
      assert.ok(await rows().count() < 80, 'и в DOM по-прежнему только окно')

      // Поиск находит любой тендер; «Сбросить все» возвращает весь реестр окном строк.
      await scroller.evaluate((el) => { el.scrollTop = 0 })
      await page.locator('input.tp-search').fill('№ 101')
      await page.locator('table.tenders-registry .tp-num-value', { hasText: /^101$/ }).waitFor()
      assert.equal(await rows().locator('.tp-num-value').count(), 1)
      await page.locator('.tp-filters-reset').click()
      await page.locator('.tp-filters-reset').waitFor({ state: 'detached' })
      await rows().nth(20).waitFor()
      assert.ok(await rows().count() < 80)
      assert.equal(await page.locator('input.tp-search').inputValue(), '')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
  it('«ВОРы и РД»: 400 тендеров — окно строк; прокрутка до конца показывает последнюю строку', async () => {
    const { page, context, errors } = await open('route=/vors&tenders=400&shell=1')
    try {
      const rows = () => page.locator('table tbody tr:not(.vt-spacer)')
      await rows().nth(5).waitFor({ timeout: 120000 })
      assert.ok(await page.locator('table tbody tr.vt-spacer').count() > 0, 'окно строк включено')
      assert.ok(await rows().count() < 80, `в DOM ${await rows().count()} строк`)
      const scroller = page.locator('.main-content')
      for (let i = 0; i < 300; i++) {
        const atEnd = await scroller.evaluate((el) => { el.scrollTop += el.clientHeight * 0.8; return el.scrollTop + el.clientHeight >= el.scrollHeight - 2 })
        await page.waitForTimeout(30)
        if (atEnd) break
      }
      await page.waitForTimeout(200)
      // Внизу — строки, распорки снизу нет: последняя строка списка на месте.
      const last = await page.locator('table tbody > tr').last().getAttribute('class')
      assert.ok(!String(last || '').includes('vt-spacer'), `последняя — строка, а не распорка: ${last}`)
      assert.ok(await rows().count() < 80)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
})
