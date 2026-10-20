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

  // Цены, позиции и ссылки грузит только таблица расценки — на странице снабжения или во вкладке карточки, когда её
  // открыли. Реестр — одно число «N из M» из базы (tender_supply_progress); карточка до вкладки — только счётчик.
  it('цены грузятся только в расценке: реестр и карточка без строк цен; повторное открытие — без скачивания файлов ВОР и записи', async () => {
    const ROW_TABLES = ['tender_vor_supply_rates', 'tender_supply_sources', 'tender_supply_links', 'tender_supply_rate_log']
    const settle = async (page) => {
      await page.waitForFunction(() => window.__supabaseStats.active === 0)
      await page.waitForTimeout(500)
      await page.waitForFunction(() => window.__supabaseStats.active === 0)
    }
    const requests = (page) => page.evaluate(() => window.__supabaseStats.requests)
    // Строки цен, позиций, ссылок, журнала; счётчик вкладки карточки (head, без range) — не строки.
    const rowRequests = (list) => list.filter((r) => ROW_TABLES.includes(r.table)
      && !(r.table === 'tender_vor_supply_rates' && r.op === 'select' && r.count && !r.range))
    // Подстановка цен из других тендеров — функция базы (rpc): пишет, только когда есть что подставить, — отдельно.
    const writes = (list) => list.filter((r) => r.op !== 'select' && r.op !== 'rpc')

    const registry = await open('&matTenders=1&bigPricing=2000', '/tenders/materials')
    try {
      await registry.page.locator('.tp-pricing-link').first().waitFor({ timeout: 120000 })
      await settle(registry.page)
      const list = await requests(registry.page)
      assert.deepEqual(rowRequests(list), [], 'реестр не читает строки цен')
      assert.ok(list.some((r) => r.table === 'tender_supply_progress'), 'реестр берёт «N из M» из базы')
      assert.deepEqual(registry.errors, [])
    } finally {
      await registry.context.close()
    }

    const card = await open('&bigPricing=2000', '/tenders/tender-p')
    try {
      const tab = card.page.getByRole('button', { name: /Расценки снабжения/ }).first()
      await tab.waitFor({ timeout: 120000 })
      await settle(card.page)
      assert.deepEqual(rowRequests(await requests(card.page)), [], 'карточка до открытия вкладки цены не грузит')
      const before = (await requests(card.page)).length
      await tab.click()
      await card.page.locator('.sp-table').waitFor({ timeout: 120000 })
      await settle(card.page)
      const opened = (await requests(card.page)).slice(before)
      assert.equal(opened.filter((r) => r.table === 'tender_vor_supply_rates' && r.range).length, 1, 'вкладка загрузила цены один раз')
      assert.deepEqual(writes(opened), [], 'открытие вкладки ничего не пишет')
      assert.deepEqual(card.errors, [])
    } finally {
      await card.context.close()
    }

    // Позиции ВОР уже в базе (версия файла совпадает) — ни при первом, ни при повторном открытии файлы не скачиваются.
    const first = await openPage()
    try {
      for (const r of [first, await openPage('', { context: first.context })]) {
        await settle(r.page)
        const list = await requests(r.page)
        assert.equal(list.filter((q) => q.table === 'tender_vor_supply_rates' && q.range).length, 1, 'цены — один раз за открытие')
        assert.deepEqual(writes(list), [], 'открытие страницы ничего не пишет')
        assert.ok(list.filter((q) => q.table === 'rpc:supply_autofill').length <= 1, 'подстановка — не больше одного вызова')
        assert.equal(await r.page.locator('.sp-similar-btn, .sp-origin').count(), 0, 'функций подбора нет — ни пометок, ни меню')
        assert.deepEqual(await r.page.evaluate(() => window.__fakeFileRequests || []), [], 'файлы ВОР не скачиваются')
        assert.deepEqual(r.errors, [])
      }
    } finally {
      await first.context.close()
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

  it('файл ВОР без листа «Материалы», но с колонкой «КОД» — позиции из строк «мат.» самого ВОР, не из вкладки', async () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['', 'Предмет тендера:', 'Электромонтажные работы'],
      ['№ п/п', 'КОД', 'Наименование затрат', 'Ед. изм.', 'Объем по виду работ', 'Общий расход'],
      [1, 2, 3, 4, 5, 6],
      ['1', 'Р', 'Прокладка кабеля', 'м', 4000, ''],
      ['', 'мат.', 'Кабель ВВГнг 3×2,5', 'м', '', 4200],
      ['', 'мат.', 'Щит ЩРН-24', 'шт', '', 2],
      ['', '', 'Наличие авансирования', 'да/нет'],
    ]), 'ВОР')
    const dataUrl = `data:application/octet-stream;base64,${XLSX.write(wb, { type: 'base64', bookType: 'xlsx' })}`
    const init = { fn: (url) => { window.__fakeFiles = { 'tenders/tender-q/x-ВОР_Корпус7.xlsx': url } }, arg: dataUrl }
    const { page, context, errors } = await open('&noSheetFile=1', '/tenders/materials/mat-q/pricing', { init })
    try {
      await page.getByText('ВОР «ВОР_Корпус7»', { exact: true }).waitFor({ timeout: 120000 })
      await page.getByText('строки с кодом «мат.»', { exact: false }).first().waitFor()
      const src = await page.evaluate(() => window.__fakeDb.tender_supply_sources.find((x) => x.tender_id === 'tender-q' && x.source === 'vor_file'))
      assert.deepEqual(src.positions.map((x) => [x.name, x.unit, x.volume]), [['Кабель ВВГнг 3×2,5', 'м', 4200], ['Щит ЩРН-24', 'шт', 2]])
      assert.equal(src.column_map.mode, 'code')
      assert.equal(await page.locator('.sp-problem').count(), 0, 'причины «не загрузился» нет')
      assert.equal(await page.getByText('Наличие авансирования').count(), 0, 'анкета претендента — не позиция')
      assert.equal(await page.getByLabel(price('Прокладка кабеля', 'ВОР_Корпус7')).count(), 0, 'работа — не позиция')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('ссылка на документ к позиции без цены: «+ документ», неверный адрес — подсказка, сохранённая — ссылка в строке', async () => {
    const { page, context, errors } = await openPage()
    try {
      const row = rowOf(page, 'Кран шаровой Ду15', 'ОВ')
      await row.getByRole('button', { name: /Прикрепить документ: Кран шаровой Ду15/ }).click()
      const dialog = page.getByRole('dialog', { name: 'Документ к позиции' })
      await dialog.getByRole('textbox').fill('javascript:alert(1)')
      await dialog.getByRole('button', { name: 'Сохранить' }).click()
      await dialog.getByText('Нужна ссылка вида https://', { exact: false }).waitFor()
      assert.equal(await page.evaluate(() => window.__fakeDb.tender_supply_links.length), 0, 'неверный адрес не записан')
      await dialog.getByRole('textbox').fill('  https://disk.example.ru/d/chek-777  ')
      await dialog.getByRole('button', { name: 'Сохранить' }).click()
      await page.waitForFunction(() => window.__fakeDb.tender_supply_links.some((l) => l.material_name === 'Кран шаровой Ду15'))
      const link = await page.evaluate(() => window.__fakeDb.tender_supply_links.find((l) => l.material_name === 'Кран шаровой Ду15'))
      assert.deepEqual([link.tender_id, link.estimate_name, link.url], ['tender-p', 'ОВ', 'https://disk.example.ru/d/chek-777'])
      const a = row.getByRole('link', { name: 'Открыть документ к «Кран шаровой Ду15»' })
      assert.equal(await a.getAttribute('href'), 'https://disk.example.ru/d/chek-777')
      assert.equal(await a.getAttribute('target'), '_blank')
      assert.equal(await rateOf(page, 'Кран шаровой Ду15', 'ОВ'), null, 'цены по-прежнему нет — ссылка от неё не зависит')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('ссылка нескольким сразу: отметить строки и весь ВОР → одна ссылка всем; сетевой путь; убрать у отмеченных', async () => {
    const { page, context, errors } = await openPage()
    try {
      await page.getByLabel('Отметить все позиции ВОР «ВК»').check()
      await page.getByLabel('Отметить: Изоляция K-Flex 13×15 (ВОР «ОВ»)').check()
      await page.locator('.sp-sel-bar', { hasText: 'Отмечено: 3' }).waitFor()
      await page.getByRole('button', { name: 'Документ', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: /Документ — 3 позициям/ })
      await dialog.getByRole('textbox').fill('\\\\su10-fs\\Снабжение\\Счёт 15.pdf')
      await dialog.getByRole('button', { name: 'Прикрепить к 3' }).click()
      await page.waitForFunction(() => window.__fakeDb.tender_supply_links.length === 3)
      const urls = await page.evaluate(() => [...new Set(window.__fakeDb.tender_supply_links.map((l) => l.url))])
      assert.deepEqual(urls, ['\\\\su10-fs\\Снабжение\\Счёт 15.pdf'])
      assert.equal(await page.locator('.sp-sel-bar').count(), 0, 'отметка снята после прикрепления')
      assert.equal(await rowOf(page, 'Изоляция K-Flex 13×15', 'ОВ').getByRole('button', { name: 'Скопировать путь к документу «Изоляция K-Flex 13×15»' }).count(), 1)
      // Убрать у двух из трёх: отметить ВОР «ВК» → «Убрать ссылку (2)».
      await page.getByLabel('Отметить все позиции ВОР «ВК»').check()
      await page.getByRole('button', { name: 'Документ', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Убрать документ (2)' }).click()
      await page.waitForFunction(() => window.__fakeDb.tender_supply_links.length === 1)
      assert.equal(await page.evaluate(() => window.__fakeDb.tender_supply_links[0].estimate_name), 'ОВ')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('ссылки без права правки — видны, но без «+ документ» и отметок; без таблицы ссылок — колонки нет, цены вводятся', async () => {
    const viewer = await openPage('&canEdit=0&seedLink=1')
    try {
      await viewer.page.getByRole('link', { name: 'Открыть документ к «Изоляция K-Flex 13×15»' }).waitFor()
      assert.equal(await viewer.page.getByRole('button', { name: /Прикрепить документ/ }).count(), 0)
      assert.equal(await viewer.page.locator('.sp-select').count(), 0)
      assert.deepEqual(viewer.errors, [])
    } finally {
      await viewer.context.close()
    }
    const old = await openPage('&noLinks=1')
    try {
      assert.equal(await old.page.getByRole('columnheader', { name: 'Документ' }).count(), 0)
      assert.equal(await old.page.locator('.sp-select').count(), 0)
      await enter(old.page.getByLabel(price('Кран шаровой Ду15', 'ОВ')), '321')
      await old.page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((r) => r.material_name === 'Кран шаровой Ду15' && r.supply_price === 321))
      assert.deepEqual(old.errors, [])
    } finally {
      await old.context.close()
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

  // Цены из других тендеров (миграция 20261023; стенд — reuse=1, у тендера № 445 «ЖК Север» свежие цены).
  it('цены из других тендеров: одинаковая позиция — сама, с пометкой и документом; похожие — меню от новых, «Взять» с отметкой и документом', async () => {
    const { page, context, errors } = await openPage('&reuse=1')
    try {
      // Кран в ОВ — тот же, что у № 445 (шт): подставлен сам; в ВК у крана «компл» — нет.
      const kran = rowOf(page, 'Кран шаровой Ду15', 'ОВ')
      // Сначала — «цена из другого тендера · от …» (по строке цены), следом — номер, объект и документ.
      await kran.locator('.sp-origin', { hasText: 'тендера № 445' }).waitFor({ timeout: 30000 })
      const hint = await kran.locator('.sp-origin').innerText()
      assert.match(hint, /цена из тендера № 445 · ЖК Север · от \d\d\.\d\d\.\d{4}/)
      assert.equal(await kran.locator('.sp-origin a', { hasText: 'Открыть' }).getAttribute('href'), 'https://disk.example.ru/d/chek-445')
      assert.match(plain(await page.getByLabel(price('Кран шаровой Ду15', 'ОВ')).inputValue()), /^512,50$/)
      const kranRate = await rateOf(page, 'Кран шаровой Ду15', 'ОВ')
      assert.equal(kranRate.source_kind, 'auto')
      assert.equal(kranRate.source_rate_id, 'o-kran')
      assert.equal(await rateOf(page, 'Кран шаровой Ду15', 'ВК'), null, 'другая ед. изм. — не подставляется')
      await page.getByText('Из других тендеров подставлено цен: 1', { exact: false }).waitFor()
      // Хомут: та же позиция у № 445, но цене больше 3 месяцев — ни сама, ни в меню.
      assert.equal(await rateOf(page, 'Хомут монтажный', 'ОВ'), null)

      // Труба медная Ø12,7 — две похожие; меню с клавиатуры: Enter, стрелка вниз, Enter — вторая (с документом).
      const truba = rowOf(page, 'Труба медная Ø12,7', 'ОВ')
      const btn = truba.locator('.sp-similar-btn')
      await btn.waitFor()
      assert.match(plain(await btn.innerText()), /похожиецены:2/)
      assert.equal(await rowOf(page, 'Хомут монтажный', 'ОВ').locator('.sp-similar-btn').count(), 0)
      await btn.focus()
      await page.keyboard.press('Enter')
      const menu = page.getByRole('dialog', { name: 'Похожие цены: Труба медная Ø12,7' })
      await menu.locator('li').first().waitFor()
      assert.deepEqual(await menu.locator('.sp-suggest-name').evaluateAll((els) => els.map((e) => e.firstChild.textContent)),
        ['Труба медная Ø12,7 мм (бухта)', 'Труба медная Ø15,9'], 'от новых к старым')
      assert.match(await menu.locator('li').nth(1).innerText(), /тендер № 445[\s\S]*ЖК Север[\s\S]*ВОР «ОВ-2»[\s\S]*документ: Открыть/)
      await page.waitForFunction(() => document.activeElement?.matches('.sp-suggest li'))
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      await menu.waitFor({ state: 'detached' })
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((r) => r.material_name === 'Труба медная Ø12,7' && r.source_kind === 'pick'))
      const r = await rateOf(page, 'Труба медная Ø12,7', 'ОВ')
      assert.equal(r.source_rate_id, 'o-truba-2')
      assert.equal(Number(r.supply_price), 1100)
      assert.equal(r.price_input, 'unit')
      await truba.getByText('цена похожей позиции «Труба медная Ø15,9» из тендера № 445', { exact: false }).waitFor()
      // Документ исходной позиции — к позиции (своего не было); та же труба в ВК — с той же отметкой.
      await page.waitForFunction(() => window.__fakeDb.tender_supply_links.some((l) => l.material_name === 'Труба медная Ø12,7' && l.url === 'https://disk.example.ru/d/chek-17'))
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((x) => x.estimate_name === 'ВК' && x.source_rate_id === 'o-truba-2'))
      await rowOf(page, 'труба медная ∅12.7', 'ВК').locator('.sp-origin').waitFor()
      const batches = await page.evaluate(() => window.__supabaseStats.requests.filter((q) => q.table === 'rpc:supply_suggestion_counts').map((q) => q.args.p_items.length))
      assert.ok(batches.length >= 1 && batches.every((n) => n <= 200))

      // Своя цена — уже своя: отметка снимается, кнопка похожих пропадает.
      await enter(page.getByLabel(price('Кран шаровой Ду15', 'ОВ')), '600')
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.find((x) => x.material_name === 'Кран шаровой Ду15' && x.estimate_name === 'ОВ')?.source_kind === null)
      await kran.locator('.sp-origin').waitFor({ state: 'detached' })
      assert.equal(await kran.locator('.sp-similar-btn').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('цены из других тендеров без права правки: ничего не подставляется, меню только для просмотра, Esc закрывает', async () => {
    const { page, context, errors } = await openPage('&reuse=1&canEdit=0')
    try {
      const btn = rowOf(page, 'Труба медная Ø12,7', 'ОВ').locator('.sp-similar-btn')
      await btn.waitFor()
      await btn.click()
      const menu = page.getByRole('dialog', { name: /Похожие цены/ })
      await menu.locator('li').first().waitFor()
      assert.equal(await menu.getByRole('button', { name: /Взять/ }).count(), 0)
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'detached' })
      await page.waitForFunction(() => document.activeElement?.classList.contains('sp-similar-btn'))
      const tables = await page.evaluate(() => window.__supabaseStats.requests.map((q) => q.table))
      assert.ok(!tables.includes('rpc:supply_autofill'), 'без права правки подстановки нет')
      assert.equal(await rateOf(page, 'Кран шаровой Ду15', 'ОВ'), null)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('похожие цены спрашиваются только для показанных строк и порциями: 2 тыс. позиций — не все сразу', async () => {
    const { page, context, errors } = await openPage('&reuse=1&bigPricing=2000')
    try {
      const counted = () => page.evaluate(() => window.__supabaseStats.requests.filter((q) => q.table === 'rpc:supply_suggestion_counts').map((q) => q.args.p_items.length))
      await page.waitForFunction(() => window.__supabaseStats.requests.some((q) => q.table === 'rpc:supply_suggestion_counts'))
      await page.waitForTimeout(800)
      const first = await counted()
      const asked = first.reduce((a, n) => a + n, 0)
      assert.ok(first.every((n) => n <= 200), String(first))
      assert.ok(asked > 0 && asked < 400, `спрошено ${asked} из ~1300 нерасценённых`)
      await page.locator('.sp-table-wrap').evaluate((el) => { el.scrollTop = el.scrollHeight / 2 })
      await page.waitForFunction((n) => window.__supabaseStats.requests.filter((q) => q.table === 'rpc:supply_suggestion_counts').length > n, first.length)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  // Дата цены и автор (20261023), статус разбора службой osp-api (20261024).
  it('дата цены у каждой цены и фильтр по ней; администратору — кто поставил цену', async () => {
    const { page, context, errors } = await openPage('&reuse=1')
    try {
      const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
      const shown = (name, vor) => page.getByLabel(price(name, vor)).count()
      const kran = rowOf(page, 'Кран шаровой Ду15', 'ОВ')
      await kran.locator('.sp-origin', { hasText: 'тендера № 445' }).waitFor({ timeout: 30000 })
      await page.getByRole('columnheader', { name: 'Дата цены, кто' }).waitFor()
      const iso = rowOf(page, 'Изоляция K-Flex 13×15', 'ОВ')
      assert.match(await iso.locator('.sp-date-cell').innerText(), /^\d\d\.\d\d\.\d{4}\s+Петров П\. П\.$/)
      assert.match(await kran.locator('.sp-date-cell').innerText(), /автоматически/)
      assert.match(await kran.locator('.sp-date-cell').getAttribute('title'), /поставил: автоматически \(цену поставил Петров П\. П\.\)/)

      // Своя цена — сегодняшний день и тот, кто вошёл.
      await enter(page.getByLabel(price('Труба медная Ø12,7', 'ОВ')), '400')
      const truba = rowOf(page, 'Труба медная Ø12,7', 'ОВ')
      await truba.locator('.sp-author', { hasText: 'Стендов С. С.' }).waitFor()
      const [y, m, d] = day(0).split('-')
      assert.match(await truba.locator('.sp-date-cell').innerText(), new RegExp(`^${d}\\.${m}\\.${y}`))

      // С позавчера — только сегодняшние цены; с 4 дней по 2 дня назад — только изоляция (3 дня), кран — 5 дней.
      await page.getByLabel('Дата цены: с').fill(day(2))
      await page.waitForFunction(() => !document.querySelector('[aria-label^="Цена за единицу: Изоляция"]'))
      assert.equal(await shown('Труба медная Ø12,7', 'ОВ'), 1)
      assert.equal(await shown('Кран шаровой Ду15', 'ОВ'), 0)
      assert.equal(await shown('Хомут монтажный', 'ОВ'), 0, 'без цены — не попадает')
      await page.getByLabel('Дата цены: с').fill(day(4))
      await page.getByLabel('Дата цены: по').fill(day(2))
      await page.waitForFunction(() => !!document.querySelector('[aria-label^="Цена за единицу: Изоляция"]'))
      assert.equal(await shown('Труба медная Ø12,7', 'ОВ'), 0)
      assert.equal(await shown('Кран шаровой Ду15', 'ОВ'), 0)
      await page.getByRole('button', { name: 'сбросить' }).click()
      await page.waitForFunction(() => !!document.querySelector('[aria-label^="Цена за единицу: Хомут"]'))
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('без прав администратора — дата цены без автора', async () => {
    const { page, context, errors } = await openPage('&reuse=1&canEdit=0')
    try {
      await page.getByRole('columnheader', { name: 'Дата цены', exact: true }).waitFor()
      assert.match(await rowOf(page, 'Изоляция K-Flex 13×15', 'ОВ').locator('.sp-date-cell').innerText(), /^\d\d\.\d\d\.\d{4}$/)
      assert.equal(await page.locator('.sp-author').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('реестр тендеров на материалы: статус расценки у всех тендеров — «ВОР не загрузился» с причиной, «нет ВОР», «загружается»', async () => {
    const { page, context, errors } = await open('&matTenders=1&importStates=1', '/tenders/materials')
    try {
      const link = (id) => page.locator(`a.tp-pricing-link[href$="/tenders/materials/${id}/pricing"]`)
      await link('mat-1').filter({ hasText: 'ВОР не загрузился' }).waitFor({ timeout: 120000 })
      assert.match(await link('mat-1').getAttribute('title'), /«ВОР_ЭОМ\.xlsx»: нет листа «Материалы»/)
      assert.match(await link('mat-1').getAttribute('class'), /is-warn/)
      assert.match(await link('mat-2').innerText(), /Расценка: нет ВОР/)
      assert.match(await link('mat-3').innerText(), /Расценка: загружается/)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('файл, который служба osp-api не смогла разобрать, страница не скачивает — причина видна сразу, и без права правки', async () => {
    for (const q of ['&brokenFile=1&serverIssue=1', '&brokenFile=1&serverIssue=1&canEdit=0']) {
      const { page, context, errors } = await openPage(q)
      try {
        await page.getByText('ВОР из файла «ВОР_ЭОМ.xlsx» не загрузился: файл не читается', { exact: false }).waitFor()
        await page.waitForTimeout(400)
        const asked = await page.evaluate(() => window.__fakePresignRequests || [])
        assert.ok(!asked.some((k) => k.includes('ВОР_ЭОМ')), `скачивали: ${asked.join(', ')}`)
        assert.equal(await page.getByText('ещё не загружены в расценку', { exact: false }).count(), 0, q)
        assert.deepEqual(errors, [])
      } finally {
        await context.close()
      }
    }
  })

  // ── Цены из счёта / КП поставщика и документ-файл (миграция 20261025) ────────────────────────────────
  // Счёт в Excel: реквизиты над таблицей, шапка «№ · Наименование товара · Ед. · Кол-во · Цена с НДС · Сумма с НДС»,
  // труба записана иначе, чем в ВОР (похожая), кран — то же наименование, изоляция — уже с ценой, доставка и болт,
  // которого в ВОР нет.
  const supplierXlsx = () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['ООО «ТеплоСнаб», ИНН 7701234567'],
      ['Счёт на оплату № 15 от 14.10.2026'],
      [],
      ['№', 'Наименование товара', 'Ед.', 'Кол-во', 'Цена с НДС, руб.', 'Сумма с НДС, руб.'],
      [1, 'Труба медная 12,7 мм (бухта 15 м)', 'м', 1500, 980, 1470000],
      [2, 'Кран шаровой Ду 15', 'шт.', 48, '512,50', '24 600,00'],
      [3, 'Изоляция K-Flex 13x15', 'м', 1100, 99, 108900],
      [4, 'Доставка', 'усл', 1, 3000, 3000],
      [5, 'Болт М12х80', 'шт', 100, 15, 1500],
      ['', 'Итого:', '', '', '', 1608000],
      ['', 'В том числе НДС (22%):', '', '', '', 289967.21],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Счёт')
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  }
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  const selected = (row) => row.locator('select').evaluate((s) => s.selectedOptions[0]?.textContent || '')

  it('цены из счёта поставщика (Excel): строки сопоставлены с позициями ВОР, своя цена — только по отметке; цены и файл-документ записаны', async () => {
    const { page, context, errors } = await openPage()
    try {
      await page.getByRole('button', { name: 'Цены из счёта / КП' }).click()
      const dialog = page.getByRole('dialog', { name: 'Цены из счёта или КП поставщика' })
      await dialog.locator('input[type=file]').setInputFiles({ name: 'Счёт 15 ТеплоСнаб.xlsx', mimeType: XLSX_MIME, buffer: supplierXlsx() })
      await dialog.locator('.sp-di-table').waitFor({ timeout: 60000 })
      assert.match(plain(await dialog.locator('.sp-di-summary').innerText()), /лист«Счёт»·строксценой:4·сопоставленосВОР:3/)
      const line = (text) => dialog.locator('.sp-di-table tbody tr', { hasText: text })

      // Труба — похожая (другая запись), одна позиция в двух ВОР; кран — то же наименование, а из двух кранов
      // ВОР — с той же ед. изм. (шт, не компл); изоляция уже расценена — «заменит», без отметки; болта в ВОР нет.
      // Имя позиции — как в первом ВОР таблицы (ВОР по алфавиту: «ВК» раньше «ОВ»).
      assert.match(await selected(line('Труба медная 12,7')), /^труба медная ∅12\.7 · м · \d+ %$/)
      assert.match(await line('Труба медная 12,7').innerText(), /в 2 ВОР/)
      assert.equal(await selected(line('Кран шаровой Ду 15')), 'Кран шаровой Ду15 · шт · точно')
      assert.match(await line('Изоляция K-Flex 13x15').innerText(), /заменит 96,00/)
      assert.equal(await line('Изоляция K-Flex 13x15').getByRole('checkbox').isChecked(), false)
      assert.equal(await line('Труба медная 12,7').getByRole('checkbox').isChecked(), true)
      assert.equal(await selected(line('Болт М12х80')), '— не сопоставлять —')
      assert.equal(await line('Болт М12х80').getByRole('checkbox').isDisabled(), true)
      // В документе «в том числе НДС» — цены как есть; доставка — к ценам пропорционально сумме (+0,2 %), снимается.
      await dialog.getByText('цены с НДС', { exact: false }).first().waitFor()
      const delivery = dialog.locator('.sp-di-delivery')
      assert.match(plain(await delivery.innerText()), /3000,00₽.*\(\+0,2%\)/)
      assert.match(plain(await line('Труба медная 12,7').locator('.sp-di-price').innerText()), /^981,83$/)
      await delivery.getByRole('checkbox').uncheck()
      assert.match(plain(await line('Труба медная 12,7').locator('.sp-di-price').innerText()), /^980,00$/)
      // Изоляцию заменить — отметить самому.
      await line('Изоляция K-Flex 13x15').getByRole('checkbox').check()
      await dialog.getByRole('button', { name: 'Применить цены: 3 (позиций ВОР: 4)' }).click()
      await dialog.waitFor({ state: 'detached', timeout: 30000 })

      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.filter((r) => r.tender_id === 'tender-p').length === 4)
      assert.equal((await rateOf(page, 'Труба медная Ø12,7', 'ОВ')).supply_price, 980)
      assert.equal((await rateOf(page, 'труба медная ∅12.7', 'ВК')).supply_price, 980)
      const kran = await rateOf(page, 'Кран шаровой Ду15', 'ОВ')
      assert.deepEqual([kran.supply_price, kran.price_input], [512.5, 'unit'])
      assert.equal(await page.evaluate(() => window.__fakeDb.tender_vor_supply_rates.filter((r) => r.material_name === 'Кран шаровой Ду15' && r.estimate_name === 'ВК').length), 0)
      const iso = await rateOf(page, 'Изоляция K-Flex 13×15', 'ОВ')
      assert.deepEqual([iso.id, iso.supply_price], ['rate-p-3', 99], 'своя цена заменена по версии строки')

      // Файл — в хранилище документов основного тендера, своей категорией, и документом четырёх позиций.
      const doc = await page.evaluate(() => window.__fakeDb.s3_documents.find((d) => d.doc_category === 'supply_doc'))
      assert.deepEqual([doc.owner_type, doc.owner_id, doc.file_name], ['tender', 'tender-p', 'Счёт 15 ТеплоСнаб.xlsx'])
      assert.equal((await page.evaluate(() => window.__fakeUploads))[0].s3_key, doc.s3_key)
      await page.waitForFunction(() => window.__fakeDb.tender_supply_links.length === 4)
      const links = await page.evaluate(() => window.__fakeDb.tender_supply_links)
      assert.ok(links.every((l) => l.s3_document_id === doc.id && l.url == null), JSON.stringify(links))
      await page.getByText('Из «Счёт 15 ТеплоСнаб.xlsx»: цен записано 4', { exact: false }).waitFor()
      const open = rowOf(page, 'Труба медная Ø12,7', 'ОВ').getByRole('button', { name: 'Открыть файл документа «Счёт 15 ТеплоСнаб.xlsx» к «Труба медная Ø12,7»' })
      await open.click()
      await page.locator('.s3-doc-modal-title', { hasText: 'Счёт 15 ТеплоСнаб.xlsx' }).waitFor()
      await page.locator('.s3-doc-modal-close').click()
      await page.locator('.s3-doc-modal').waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('цены из КП в PDF: текст читает pdf.js в отдельном потоке; «Цена без НДС» — НДС сверху; скан без текста — понятный отказ', async () => {
    const maker = await browser.newPage()
    await maker.setContent(`<html><head><meta charset="utf-8"><style>body{font:10pt Arial,sans-serif}table{border-collapse:collapse}
      td,th{border:1px solid #000;padding:2px 6px;vertical-align:bottom}.r{text-align:right;white-space:nowrap}</style></head><body>
      <h3>Коммерческое предложение № 7</h3>
      <table><tr><th>№ п/п</th><th>Наименование</th><th>Ед. изм.</th><th>Кол-во</th><th>Цена без НДС, руб.</th><th>Сумма без НДС, руб.</th></tr>
      <tr><td>1</td><td style="width:14em">Кран шаровой полнопроходной латунный муфтовый Ду15 PN40</td><td>шт</td><td class="r">48</td><td class="r">1 000,00</td><td class="r">48 000,00</td></tr>
      <tr><td>2</td><td>Хомут монтажный</td><td>шт</td><td class="r">200</td><td class="r">35,50</td><td class="r">7 100,00</td></tr>
      </table><p>Итого без НДС: 55 100,00. НДС 22%: 12 122,00. Всего с НДС: 67 222,00</p></body></html>`)
    const pdf = await maker.pdf({ format: 'A4' })
    await maker.setContent('<html><body><svg width="400" height="200"><rect width="400" height="200" fill="#ccc"/></svg></body></html>')
    const scan = await maker.pdf({ format: 'A4' })
    await maker.close()
    const { page, context, errors } = await openPage()
    try {
      await page.getByRole('button', { name: 'Цены из счёта / КП' }).click()
      const dialog = page.getByRole('dialog', { name: 'Цены из счёта или КП поставщика' })
      await dialog.locator('input[type=file]').setInputFiles({ name: 'скан.pdf', mimeType: 'application/pdf', buffer: scan })
      await dialog.getByText('В PDF нет текста — это скан или фото', { exact: false }).waitFor({ timeout: 60000 })
      await dialog.locator('input[type=file]').setInputFiles({ name: 'КП 7.pdf', mimeType: 'application/pdf', buffer: pdf })
      await dialog.locator('.sp-di-table').waitFor({ timeout: 60000 })
      assert.match(plain(await dialog.locator('.sp-di-summary').innerText()), /PDF,страниц:1·строксценой:2·сопоставленосВОР:2/)
      const line = (text) => dialog.locator('.sp-di-table tbody tr', { hasText: text })
      assert.equal(await selected(line('Хомут монтажный')), 'Хомут монтажный · шт · точно')
      assert.match(await selected(line('Кран шаровой полнопроходной')), /^Кран шаровой Ду15 · шт · \d+ %$/)
      // «Итого без НДС», колонки «без НДС» — к цене НДС 22 %: 1 000 → 1 220.
      await dialog.getByText('цены без НДС — НДС добавится', { exact: false }).waitFor()
      assert.match(plain(await line('Кран шаровой полнопроходной').locator('.sp-di-price').innerText()), /^1220,00$/)
      assert.match(plain(await line('Хомут монтажный').locator('.sp-di-price').innerText()), /^43,31$/)
      // Не прикреплять файл: только цены.
      await dialog.getByLabel('Прикрепить файл документом к позициям, получившим цену').uncheck()
      await dialog.getByRole('button', { name: 'Применить цены: 2' }).click()
      await dialog.waitFor({ state: 'detached', timeout: 30000 })
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((r) => r.material_name === 'Хомут монтажный'))
      assert.equal((await rateOf(page, 'Хомут монтажный', 'ОВ')).supply_price, 43.31)
      assert.equal((await rateOf(page, 'Кран шаровой Ду15', 'ОВ')).supply_price, 1220)
      assert.equal(await page.evaluate(() => window.__fakeDb.s3_documents.filter((d) => d.doc_category === 'supply_doc').length), 0)
      assert.equal(await page.evaluate(() => window.__fakeDb.tender_supply_links.length), 0)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('файл документом к позиции: «Файл» — загрузить с компьютера; другой позиции — тот же файл из списка; ссылка вместо файла', async () => {
    const { page, context, errors } = await openPage()
    try {
      await rowOf(page, 'Кран шаровой Ду15', 'ОВ').getByRole('button', { name: /Прикрепить документ: Кран шаровой Ду15/ }).click()
      let dialog = page.getByRole('dialog', { name: 'Документ к позиции' })
      await dialog.getByRole('tab', { name: 'Файл' }).click()
      await dialog.locator('input[type=file]').setInputFiles({ name: 'Чек 777.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') })
      await dialog.getByText('Чек 777.pdf').waitFor()
      await dialog.getByRole('button', { name: 'Сохранить' }).click()
      await page.waitForFunction(() => window.__fakeDb.tender_supply_links.some((l) => l.material_name === 'Кран шаровой Ду15' && l.s3_document_id))
      const doc = await page.evaluate(() => window.__fakeDb.s3_documents.find((d) => d.file_name === 'Чек 777.pdf'))
      assert.deepEqual([doc.owner_id, doc.doc_category], ['tender-p', 'supply_doc'])
      await rowOf(page, 'Кран шаровой Ду15', 'ОВ').getByRole('button', { name: 'Открыть файл документа «Чек 777.pdf» к «Кран шаровой Ду15»' }).waitFor()

      // Хомуту — тот же файл из списка загруженных к тендеру.
      await rowOf(page, 'Хомут монтажный', 'ОВ').getByRole('button', { name: /Прикрепить документ: Хомут монтажный/ }).click()
      dialog = page.getByRole('dialog', { name: 'Документ к позиции' })
      await dialog.getByRole('tab', { name: 'Файл' }).click()
      await dialog.getByRole('radio', { name: /Чек 777\.pdf/ }).check()
      await dialog.getByRole('button', { name: 'Сохранить' }).click()
      await page.waitForFunction((id) => window.__fakeDb.tender_supply_links.some((l) => l.material_name === 'Хомут монтажный' && l.s3_document_id === id), doc.id)
      assert.equal(await page.evaluate(() => window.__fakeDb.s3_documents.filter((d) => d.doc_category === 'supply_doc').length), 1, 'второй раз файл не загружается')

      // У крана — ссылка вместо файла: файл снимается (одно из двух).
      await rowOf(page, 'Кран шаровой Ду15', 'ОВ').getByRole('button', { name: /Изменить документ: Кран шаровой Ду15/ }).click()
      dialog = page.getByRole('dialog', { name: 'Документ к позиции' })
      assert.equal(await dialog.getByRole('tab', { name: 'Файл' }).getAttribute('aria-selected'), 'true', 'открывается на том, что есть')
      await dialog.getByRole('tab', { name: 'Ссылка' }).click()
      await dialog.getByRole('textbox').fill('https://disk.example.ru/d/chek-778')
      await dialog.getByRole('button', { name: 'Сохранить' }).click()
      await page.waitForFunction(() => window.__fakeDb.tender_supply_links.some((l) => l.material_name === 'Кран шаровой Ду15' && l.url === 'https://disk.example.ru/d/chek-778'))
      const kran = await page.evaluate(() => window.__fakeDb.tender_supply_links.find((l) => l.material_name === 'Кран шаровой Ду15'))
      assert.equal(kran.s3_document_id, null)
      await rowOf(page, 'Кран шаровой Ду15', 'ОВ').getByRole('link', { name: 'Открыть документ к «Кран шаровой Ду15»' }).waitFor()
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
