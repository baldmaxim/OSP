// Страница расценки материалов снабжением (/tenders/materials/:id/pricing) в настоящем браузере на стенде
// тендеров: данные в памяти (tests/tender/ui/seed.js), расчёт триггера базы подменён той же логикой.
// Проверяется: цена → сумма и сумма → цена, запись с версией строки, окно «изменено другим», только чтение
// после завершения тендера на материалы и без права правки, понятное сообщение без миграции.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const plain = (s) => String(s ?? '').replace(/\s/g, '')
// Ввод как у человека: фокус (поле подставляет текущее значение и выделяет его в следующем кадре), затем
// набор поверх выделения и Enter.
async function enter(locator, text) {
  await locator.focus()
  await locator.page().waitForTimeout(60)
  await locator.fill(text)
  await locator.press('Enter')
}

describe('Расценка снабжением: страница', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open(query = '') {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1400, height: 900 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    await page.goto(`${stand.url}?route=/tenders/materials/mat-p/pricing&items=20&cps=1&tenders=3&latency=10${query}`)
    await page.getByRole('heading', { name: 'Расценка материалов' }).waitFor({ timeout: 120000 })
    return { page, context, errors }
  }
  const rateOf = (page, name) => page.evaluate((n) => window.__fakeDb.tender_vor_supply_rates.find((r) => r.material_name === n) || null, name)

  it('цена → сумма, сумма → цена; запись в расценки основного тендера с версией', async () => {
    const { page, context, errors } = await open()
    try {
      await page.getByText('Расценено 1 из 4', { exact: true }).waitFor()
      // Цена за единицу: сумма = 1500 × 412,50.
      const price = page.getByLabel('Цена за единицу: Труба медная Ø12,7')
      await enter(price, '412,5')
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((r) => r.material_name === 'Труба медная Ø12,7'))
      const r1 = await rateOf(page, 'Труба медная Ø12,7')
      assert.equal(r1.tender_id, 'tender-p', 'цена — у основного тендера')
      assert.equal(r1.estimate_name, 'ОВ')
      assert.equal(r1.price_input, 'unit')
      assert.equal(r1.input_value, 412.5)
      assert.equal(r1.volume_at_input, 1500)
      await page.waitForFunction(() => /618750,00/.test(document.querySelector('[aria-label="Сумма: Труба медная Ø12,7"]').value.replace(/\s/g, '')))

      // Итоговая сумма: цена = 48 000 / 48.
      const total = page.getByLabel('Сумма: Кран шаровой Ду15')
      await enter(total, '48000')
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((r) => r.material_name === 'Кран шаровой Ду15'))
      const r2 = await rateOf(page, 'Кран шаровой Ду15')
      assert.equal(r2.price_input, 'total')
      assert.equal(r2.supply_price, 1000)
      await page.waitForFunction(() => /1000,00/.test(document.querySelector('[aria-label="Цена за единицу: Кран шаровой Ду15"]').value.replace(/\s/g, '')))

      // Позиция без объёма: сумму не ввести, цену — можно.
      assert.equal(await page.getByLabel('Сумма: Хомут монтажный').isDisabled(), true)
      assert.equal(await page.getByLabel('Цена за единицу: Хомут монтажный').isDisabled(), false)

      // Правка существующей цены — по версии строки.
      const before = await rateOf(page, 'Изоляция K-Flex 13×15')
      const iso = page.getByLabel('Цена за единицу: Изоляция K-Flex 13×15')
      await enter(iso, '97')
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.find((r) => r.id === 'rate-p-3').supply_price === 97)
      assert.equal((await rateOf(page, 'Изоляция K-Flex 13×15')).row_version, before.row_version + 1)
      await page.getByText('Расценено 3 из 4', { exact: true }).waitFor()
      assert.match(plain(await page.locator('.sp-table tfoot').innerText()), /773450,00/) // 618 750 + 48 000 + 106 700 (97 × 1100)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('цену изменил другой пользователь — значение не записано, окно выбора; «Записать моё» — по новой версии', async () => {
    const { page, context, errors } = await open()
    try {
      // Пока страница открыта, другой пользователь поменял цену (версия выросла).
      await page.evaluate(() => {
        const r = window.__fakeDb.tender_vor_supply_rates.find((x) => x.id === 'rate-p-3')
        Object.assign(r, { supply_price: 120, input_value: 120, supply_total: 132000, row_version: 7, updated_by: 'user-2' })
      })
      const iso = page.getByLabel('Цена за единицу: Изоляция K-Flex 13×15')
      await enter(iso, '99')
      const dialog = page.getByRole('alertdialog')
      await dialog.getByText('Цену уже изменили').waitFor()
      assert.match(await dialog.innerText(), /Петров П\. П\./)
      assert.equal((await rateOf(page, 'Изоляция K-Flex 13×15')).supply_price, 120, 'чужая цена не перетёрта')
      await dialog.getByRole('button', { name: 'Записать моё' }).click()
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.find((r) => r.id === 'rate-p-3').supply_price === 99)
      assert.equal((await rateOf(page, 'Изоляция K-Flex 13×15')).row_version, 8)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('тендер на материалы завершён — только чтение', async () => {
    const { page, context, errors } = await open('&matStatus=%D0%97%D0%B0%D0%B2%D0%B5%D1%80%D1%88%D1%91%D0%BD')
    try {
      await page.getByText('Тендер на материалы завершён — расценки только для чтения', { exact: false }).first().waitFor()
      assert.equal(await page.getByLabel('Цена за единицу: Труба медная Ø12,7').isDisabled(), true)
      assert.equal(await page.getByLabel('Сумма: Труба медная Ø12,7').isDisabled(), true)
      assert.equal(await page.getByRole('button', { name: 'Позиции из ВОР' }).count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('без права правки — только просмотр, цены видны', async () => {
    const { page, context, errors } = await open('&canEdit=0')
    try {
      await page.getByText('Только просмотр', { exact: false }).waitFor()
      assert.equal(await page.getByLabel('Цена за единицу: Изоляция K-Flex 13×15').isDisabled(), true)
      assert.match(plain(await page.getByLabel('Цена за единицу: Изоляция K-Flex 13×15').inputValue()), /96,00/)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('миграция не применена — понятное сообщение, страница не падает', async () => {
    const { page, context, errors } = await open('&missing=1')
    try {
      await page.getByText('Расценка на сайте ещё не включена', { exact: false }).first().waitFor()
      assert.equal(await page.locator('.sp-table').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
})
