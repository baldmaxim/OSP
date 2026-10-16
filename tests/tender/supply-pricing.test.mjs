// Расценка материалов снабжением в настоящем браузере на стенде тендеров: данные в памяти
// (tests/tender/ui/seed.js), триггеры базы подменены той же логикой. Одна таблица в двух местах — страница
// снабжения (/tenders/materials/:id/pricing) и вкладка «Расценки снабжения» карточки тендера.
// Проверяется: цена → сумма и сумма → цена, запись с версией строки, все ВОР в одной таблице со своими
// шапками, подстановка цены в одинаковые позиции других ВОР (только где пусто, и исправление подставленной за
// сеанс), автозагрузка позиций из вкладки «ВОР», когда файлов нет, причина, если файл ВОР не загрузился (и
// что она запоминается), сохранение без Enter и постоянная галочка, гонки записи на медленном сервере (Tab
// через «Итого», правка во время записи — без ложного «изменено другим»), окно «изменено другим», только
// чтение, понятное сообщение без миграции.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import * as XLSX from 'xlsx'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const plain = (s) => String(s ?? '').replace(/\s/g, '')
const price = (name, vor) => `Цена за единицу: ${name} (ВОР «${vor}»)`
const sum = (name, vor) => `Сумма: ${name} (ВОР «${vor}»)`
// Ввод как у человека: фокус (поле подставляет текущее значение и выделяет его в следующем кадре), затем
// набор поверх выделения и Enter.
async function enter(locator, text) {
  await locator.focus()
  await locator.page().waitForTimeout(60)
  await locator.fill(text)
  await locator.press('Enter')
}

describe('Расценка снабжением: таблица', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  // latency — «сетевая» задержка ответа стенда, мс: медленный сервер, на котором видны гонки записи.
  async function open(query = '', route = '/tenders/materials/mat-p/pricing', { latency = 10, context: given = null, init = null } = {}) {
    const context = given || await browser.newContext({ locale: 'ru-RU', viewport: { width: 1400, height: 900 } })
    if (init && !given) await context.addInitScript(init.fn, init.arg)
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    await page.goto(`${stand.url}?route=${route}&items=20&cps=1&tenders=3&latency=${latency}${query}`)
    return { page, context, errors }
  }
  const openPage = async (query = '', opts = {}) => {
    const r = await open(query, undefined, opts)
    await r.page.getByRole('heading', { name: 'Расценка материалов' }).waitFor({ timeout: 120000 })
    // Таблица загрузила позиции и цены (или показала, почему не может) — дальше можно менять «базу».
    await r.page.locator('.sp-table, .sp-banner').first().waitFor({ timeout: 120000 })
    return r
  }
  const summary = (page) => page.locator('.sp-summary-inline').innerText().then(plain)
  const rowOf = (page, name, vor) => page.locator('.sp-table tbody tr', { has: page.getByLabel(price(name, vor)) })
  const ratesNamed = (page, name) => page.evaluate((n) => window.__fakeDb.tender_vor_supply_rates.filter((r) => r.material_name === n), name)
  const rateOf = (page, name, vor) => page.evaluate(([n, v]) => window.__fakeDb.tender_vor_supply_rates
    .find((r) => r.material_name === n && r.estimate_name === v) || null, [name, vor])

  it('все ВОР в одной таблице со своими шапками; цена → сумма, сумма → цена; цена — в такие же позиции других ВОР', async () => {
    const { page, context, errors } = await openPage()
    try {
      await page.getByText('ВОР «ОВ»', { exact: true }).waitFor()
      await page.getByText('ВОР «ВК»', { exact: true }).waitFor()
      assert.match(await summary(page), /Расценено1из6/)
      // Ни кнопки загрузки позиций, ни окна: позиции уже загружены сами.
      assert.equal(await page.getByRole('button', { name: /Позиции из ВОР|Загрузить позиции/ }).count(), 0)

      // Цена за единицу в ОВ: сумма = 1500 × 412,50; та же труба в ВК (пусто) получает цену сама.
      await enter(page.getByLabel(price('Труба медная Ø12,7', 'ОВ')), '412,5')
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((r) => r.estimate_name === 'ВК' && r.material_name === 'труба медная ∅12.7'))
      const r1 = await rateOf(page, 'Труба медная Ø12,7', 'ОВ')
      assert.equal(r1.tender_id, 'tender-p', 'цена — у основного тендера')
      assert.equal(r1.price_input, 'unit')
      assert.equal(r1.volume_at_input, 1500)
      const vk = await rateOf(page, 'труба медная ∅12.7', 'ВК')
      assert.equal(vk.supply_price, 412.5)
      assert.equal(vk.supply_total, 82500)
      await page.getByText('подставлена в такие же позиции', { exact: false }).waitFor()
      await page.waitForFunction((l) => /618750,00/.test(document.querySelector(`[aria-label="${l}"]`).value.replace(/\s/g, '')), sum('Труба медная Ø12,7', 'ОВ'))

      // Итоговая сумма в ОВ: цена = 48 000 / 48. Кран в ВК — в другой единице: не подставляется.
      await enter(page.getByLabel(sum('Кран шаровой Ду15', 'ОВ')), '48000')
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((r) => r.estimate_name === 'ОВ' && r.material_name === 'Кран шаровой Ду15'))
      assert.equal((await rateOf(page, 'Кран шаровой Ду15', 'ОВ')).supply_price, 1000)
      await page.waitForTimeout(300)
      assert.equal(await rateOf(page, 'Кран шаровой Ду15', 'ВК'), null, 'другая единица — не та же позиция')

      // Уже расценённое в другом ВОР не перетирается: изоляция в ОВ своя, в ВК её нет.
      assert.equal(await page.getByLabel(sum('Хомут монтажный', 'ОВ')).isDisabled(), true, 'без объёма сумму не ввести')
      const before = await rateOf(page, 'Изоляция K-Flex 13×15', 'ОВ')
      await enter(page.getByLabel(price('Изоляция K-Flex 13×15', 'ОВ')), '97')
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.find((r) => r.id === 'rate-p-3').supply_price === 97)
      assert.equal((await rateOf(page, 'Изоляция K-Flex 13×15', 'ОВ')).row_version, before.row_version + 1)

      // Цена в ВК меняется отдельно — в ОВ ничего не трогает.
      await enter(page.getByLabel(price('труба медная ∅12.7', 'ВК')), '400')
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.find((r) => r.estimate_name === 'ВК').supply_price === 400)
      assert.equal((await rateOf(page, 'Труба медная Ø12,7', 'ОВ')).supply_price, 412.5)
      await page.waitForFunction(() => /Расценено4из6/.test(document.querySelector('.sp-summary-inline').innerText.replace(/\s/g, '')))
      assert.match(plain(await page.locator('.sp-table tfoot').innerText()), /853450,00/) // 618 750 + 48 000 + 106 700 + 80 000
      // Свернуть ВОР — его позиции скрыты, шапка остаётся.
      await page.getByRole('button', { name: 'Свернуть ВОР «ВК»' }).click()
      assert.equal(await page.getByLabel(price('труба медная ∅12.7', 'ВК')).count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('файлов ВОР нет — позиции сами берутся из вкладки «ВОР» карточки', async () => {
    const { page, context, errors } = await open('', '/tenders/materials/mat-q/pricing')
    try {
      await page.getByText('ВОР «Корпус 7»', { exact: true }).waitFor({ timeout: 120000 })
      await page.getByText('взяты из вкладки «ВОР» карточки тендера', { exact: false }).waitFor()
      const src = await page.evaluate(() => window.__fakeDb.tender_supply_sources.find((s) => s.tender_id === 'tender-q'))
      assert.equal(src.source, 'vor_tab')
      assert.deepEqual(src.positions.map((p) => [p.name, p.unit, p.volume]), [['Кабель ВВГнг 3×2,5', 'м', 4000], ['Щит ЩРН-12', 'шт', 3]])
      assert.equal(await page.getByLabel(price('Прокладка кабеля', 'Корпус 7')).count(), 0, 'работы — не позиции снабжения')
      await enter(page.getByLabel(price('Щит ЩРН-12', 'Корпус 7')), '15000')
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((r) => r.tender_id === 'tender-q' && r.supply_price === 15000))
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('файл ВОР не загрузился — плашка с причиной и что сделать', async () => {
    const { page, context, errors } = await openPage('&brokenFile=1')
    try {
      const banner = page.locator('.sp-problem', { hasText: 'ВОР_ЭОМ.xlsx' })
      await banner.waitFor()
      assert.match(await banner.innerText(), /не загрузился: файл не скачался/)
      assert.equal(await banner.getByRole('button', { name: 'Повторить' }).count(), 1)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('во вкладке «Расценки снабжения» карточки — та же таблица и загрузка цен из Excel, без отдельной кнопки', async () => {
    const { page, context, errors } = await open('', '/tenders/tender-p')
    try {
      await page.getByRole('button', { name: /Расценки снабжения/ }).first().click({ timeout: 120000 })
      await page.getByText('ВОР «ОВ»', { exact: true }).waitFor()
      await page.getByText('ВОР «ВК»', { exact: true }).waitFor()
      assert.ok(await page.getByRole('button', { name: /загрузить цены из Excel/ }).count() >= 2)
      assert.equal(await page.getByText('Расценка снабжения на сайте').count(), 0)
      await enter(page.getByLabel(price('Кран шаровой Ду15', 'ВК')), '700')
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((r) => r.estimate_name === 'ВК' && r.supply_price === 700))
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('сохраняется само, без Enter: через секунду после ввода; галочка у строки остаётся, вверху — «Все цены сохранены»', async () => {
    const { page, context, errors } = await openPage()
    try {
      const field = page.getByLabel(price('Кран шаровой Ду15', 'ОВ'))
      await field.focus()
      await page.waitForTimeout(60)
      await field.fill('777')
      // Поле не покидали и Enter не нажимали — цена всё равно в базе.
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((r) => r.material_name === 'Кран шаровой Ду15' && r.supply_price === 777), null, { timeout: 5000 })
      assert.equal(await field.evaluate((el) => el === document.activeElement), true, 'фокус остался в поле')
      await page.locator('.sp-save-status.is-ok', { hasText: 'Все цены сохранены' }).waitFor()
      await field.press('Tab')
      // Через 3 с галочка на месте (раньше гасла через 2 с), и у уже расценённой изоляции — тоже.
      await page.waitForTimeout(3000)
      assert.equal(await rowOf(page, 'Кран шаровой Ду15', 'ОВ').locator('.sp-st.is-saved').count(), 1)
      assert.equal(await rowOf(page, 'Изоляция K-Flex 13×15', 'ОВ').locator('.sp-st.is-saved').count(), 1)
      assert.equal(await rowOf(page, 'Хомут монтажный', 'ОВ').locator('.sp-st.is-saved').count(), 0, 'у нерасценённой галочки нет')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('медленный сервер: Tab через «Итого» во время записи — одна запись, без «цену уже изменили»', async () => {
    const { page, context, errors } = await openPage('', { latency: 400 })
    try {
      const field = page.getByLabel(price('Кран шаровой Ду15', 'ОВ'))
      await field.focus()
      await page.waitForTimeout(60)
      await field.fill('1500')
      await page.keyboard.press('Tab') // в «Итого» той же строки — запись цены ещё идёт
      await page.waitForTimeout(80)
      await page.keyboard.press('Tab') // и дальше, ничего не меняя
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((r) => r.material_name === 'Кран шаровой Ду15'))
      await page.waitForTimeout(2500)
      assert.equal(await page.getByRole('alertdialog').count(), 0, 'окна «изменено другим» нет')
      const rows = await ratesNamed(page, 'Кран шаровой Ду15')
      assert.equal(rows.length, 1)
      assert.equal(rows[0].price_input, 'unit', 'проход по «Итого» не переписал цену суммой')
      assert.equal(rows[0].row_version, 1, 'вторая запись не уходила')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('медленный сервер: исправили цену, пока первая ещё сохраняется — пишется по новой версии, без конфликта', async () => {
    const { page, context, errors } = await openPage('', { latency: 400 })
    try {
      const field = page.getByLabel(price('Кран шаровой Ду15', 'ОВ'))
      await enter(field, '100')
      await enter(field, '150')
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((r) => r.material_name === 'Кран шаровой Ду15' && r.supply_price === 150), null, { timeout: 10000 })
      await page.waitForTimeout(1000)
      assert.equal(await page.getByRole('alertdialog').count(), 0)
      const rows = await ratesNamed(page, 'Кран шаровой Ду15')
      assert.equal(rows.length, 1)
      assert.equal(rows[0].row_version, 2)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('исправили цену — подставленная за сеанс цена такой же позиции исправляется тоже; изменённая вручную — нет', async () => {
    const { page, context, errors } = await openPage()
    try {
      const vk = () => rateOf(page, 'труба медная ∅12.7', 'ВК')
      await enter(page.getByLabel(price('Труба медная Ø12,7', 'ОВ')), '412,5')
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((r) => r.estimate_name === 'ВК' && r.supply_price === 412.5))
      await enter(page.getByLabel(price('Труба медная Ø12,7', 'ОВ')), '420')
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((r) => r.estimate_name === 'ВК' && r.supply_price === 420))
      // В ВК цену поправили руками — дальше она своя.
      await enter(page.getByLabel(price('труба медная ∅12.7', 'ВК')), '400')
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((r) => r.estimate_name === 'ВК' && r.supply_price === 400))
      await enter(page.getByLabel(price('Труба медная Ø12,7', 'ОВ')), '430')
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((r) => r.estimate_name === 'ОВ' && r.supply_price === 430))
      await page.waitForTimeout(500)
      assert.equal((await vk()).supply_price, 400)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('у позиции без объёма — подсказка «вводится только цена за единицу», поле итога с пометкой', async () => {
    const { page, context, errors } = await openPage()
    try {
      const row = rowOf(page, 'Хомут монтажный', 'ОВ')
      assert.match(await row.innerText(), /объёма в ВОР нет: вводится только цена за единицу/)
      const total = page.getByLabel(sum('Хомут монтажный', 'ОВ'))
      assert.equal(await total.isDisabled(), true)
      assert.equal(await total.getAttribute('placeholder'), 'нет объёма')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('файл ВОР без листа «Материалы»: причина видна, запоминается — при следующем открытии файл не скачивается', async () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Наименование работ', 'Ед.', 'Объём'], ['Монтаж', 'м', 5]]), 'РАБОТЫ')
    const dataUrl = `data:application/octet-stream;base64,${XLSX.write(wb, { type: 'base64', bookType: 'xlsx' })}`
    const init = { fn: (url) => { window.__fakeFiles = { 'tenders/tender-q/x-ВОР_Корпус7.xlsx': url } }, arg: dataUrl }
    const first = await open('&noSheetFile=1', '/tenders/materials/mat-q/pricing', { init })
    try {
      const banner = first.page.locator('.sp-problem', { hasText: 'ВОР_Корпус7.xlsx' })
      await banner.waitFor({ timeout: 120000 })
      assert.match(await banner.innerText(), /нет листа «Материалы» \(листы: РАБОТЫ\)/)
      // Позиции всё равно есть — из вкладки «ВОР» карточки.
      await first.page.getByText('ВОР «Корпус 7»', { exact: true }).waitFor()
      assert.equal((await first.page.evaluate(() => window.__fakeFileRequests || [])).length, 1)
      await first.page.close()

      const second = await open('&noSheetFile=1', '/tenders/materials/mat-q/pricing', { context: first.context })
      await second.page.locator('.sp-problem', { hasText: 'ВОР_Корпус7.xlsx' }).waitFor({ timeout: 120000 })
      assert.deepEqual(await second.page.evaluate(() => window.__fakeFileRequests || []), [], 'файл не скачивался снова')
      assert.deepEqual([...first.errors, ...second.errors], [])
    } finally {
      await first.context.close()
    }
  })

  it('цену изменил другой пользователь — значение не записано, окно выбора; «Записать моё» — по новой версии', async () => {
    const { page, context, errors } = await openPage()
    try {
      // Страница уже показала прежнюю цену — значит, держит версию 1.
      await page.waitForFunction((l) => /96,00/.test(document.querySelector(`[aria-label="${l}"]`)?.value || ''), price('Изоляция K-Flex 13×15', 'ОВ'))
      await page.evaluate(() => {
        const r = window.__fakeDb.tender_vor_supply_rates.find((x) => x.id === 'rate-p-3')
        Object.assign(r, { supply_price: 120, input_value: 120, supply_total: 132000, row_version: 7, updated_by: 'user-2' })
      })
      await enter(page.getByLabel(price('Изоляция K-Flex 13×15', 'ОВ')), '99')
      const dialog = page.getByRole('alertdialog')
      await dialog.getByText('Цену уже изменили').waitFor()
      assert.match(await dialog.innerText(), /Петров П\. П\./)
      assert.equal((await rateOf(page, 'Изоляция K-Flex 13×15', 'ОВ')).supply_price, 120, 'чужая цена не перетёрта')
      await dialog.getByRole('button', { name: 'Записать моё' }).click()
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.find((r) => r.id === 'rate-p-3').supply_price === 99)
      assert.equal((await rateOf(page, 'Изоляция K-Flex 13×15', 'ОВ')).row_version, 8)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('тендер на материалы завершён — только чтение, автозагрузки нет', async () => {
    const { page, context, errors } = await openPage('&matStatus=%D0%97%D0%B0%D0%B2%D0%B5%D1%80%D1%88%D1%91%D0%BD&brokenFile=1')
    try {
      await page.getByText('Тендер на материалы завершён — расценки только для чтения', { exact: false }).first().waitFor()
      assert.equal(await page.getByLabel(price('Труба медная Ø12,7', 'ОВ')).isDisabled(), true)
      assert.equal(await page.getByLabel(sum('Труба медная Ø12,7', 'ОВ')).isDisabled(), true)
      assert.equal(await page.locator('.sp-problem').count(), 0, 'закрытый тендер не загружает ВОР')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('без права правки — только просмотр, цены видны; незагруженный файл — подсказка, а не ошибка', async () => {
    const { page, context, errors } = await openPage('&canEdit=0&brokenFile=1')
    try {
      await page.getByText('Только просмотр', { exact: false }).waitFor()
      assert.equal(await page.getByLabel(price('Изоляция K-Flex 13×15', 'ОВ')).isDisabled(), true)
      assert.match(plain(await page.getByLabel(price('Изоляция K-Flex 13×15', 'ОВ')).inputValue()), /96,00/)
      await page.getByText('ещё не загружены в расценку', { exact: false }).waitFor()
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('миграция не применена — понятное сообщение, страница не падает', async () => {
    const { page, context, errors } = await openPage('&missing=1')
    try {
      await page.getByText('Расценка на сайте ещё не включена', { exact: false }).first().waitFor()
      assert.equal(await page.locator('.sp-table').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
})
