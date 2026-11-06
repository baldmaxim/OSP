// Расценка материалов снабжением в настоящем браузере на стенде тендеров: данные в памяти
// (tests/tender/ui/seed.js), триггеры базы подменены той же логикой. Одна таблица в двух местах — страница
// снабжения (/tenders/materials/:id/pricing) и вкладка «Расценки снабжения» карточки тендера.
// Проверяется: цена → сумма и сумма → цена, запись с версией строки, одна строка на позицию (одинаковые позиции всех ВОР сложены,
// цена пишется всем ВОР строки, сумма делится по объёму), автозагрузка позиций из вкладки «ВОР», когда файлов нет, причина, если файл
// ВОР не загрузился (и что она запоминается), сохранение без Enter и постоянная галочка, гонки записи на медленном сервере (Tab через
// «Итого», правка во время записи — без ложного «изменено другим»), окно «изменено другим», только чтение, понятное сообщение без
// миграции; окно «Счета и КП»: позиция и строка счёта рядом, правильная цена не показывается, свежий документ важнее.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import * as XLSX from 'xlsx'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { invoiceJpeg, jpegPdf } from '../supply/lib/scan-pdf.mjs'

const launch = browserLaunchOptions()
const plain = (s) => String(s ?? '').replace(/\s/g, '')
// Подпись строки: один ВОР — его имя, несколько — «ВОР: N» (как в таблице).
const vorText = (vor) => (vor.startsWith('ВОР:') ? vor : `ВОР «${vor}»`)
const price = (name, vor) => `Цена за единицу: ${name} (${vorText(vor)})`
const sum = (name, vor) => `Сумма: ${name} (${vorText(vor)})`
// Труба есть в обоих ВОР стенда; имя строки — как в первом ВОР таблицы (по алфавиту: «ВК» раньше «ОВ»).
const TRUBA = 'труба медная ∅12.7'
const TWO = 'ВОР: 2'
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
  const pricedCount = (page, n, all) => page.getByRole('button', { name: `Расценены (${n})`, exact: true }).waitFor().then(() => page.getByRole('button', { name: `Все (${all})`, exact: true }).waitFor())
  const vors = (page, text) => page.locator('.sp-vors > summary', { hasText: text })
  const openVors = async (page) => { const d = page.locator('.sp-vors'); if (!(await d.evaluate((el) => el.open))) await d.locator('summary').click(); return d }
  const rowOf = (page, name, vor) => page.locator('.sp-table tbody tr', { has: page.getByLabel(price(name, vor)) })
  const ratesNamed = (page, name) => page.evaluate((n) => window.__fakeDb.tender_vor_supply_rates.filter((r) => r.material_name === n), name)
  const rateOf = (page, name, vor) => page.evaluate(([n, v]) => window.__fakeDb.tender_vor_supply_rates
    .find((r) => r.material_name === n && r.estimate_name === v) || null, [name, vor])

  it('одна строка на позицию: цена — всем ВОР строки, сумма — по объёму; другая ед. изм. — своя строка; фильтр по ВОР', async () => {
    const { page, context, errors } = await openPage()
    try {
      await vors(page, 'ВОРы тендера: 2').waitFor()
      assert.equal(await page.locator('.sp-section-head').count(), 0, 'шапок ВОР в таблице нет')
      // 6 позиций двух ВОР — 5 строк: труба в обоих ВОР одна.
      await pricedCount(page, 1, 5)
      assert.equal(await page.getByLabel(/^Цена за единицу:/).count(), 5)
      assert.equal(await page.getByRole('button', { name: /Позиции из ВОР|Загрузить позиции/ }).count(), 0)
      const pipeRow = rowOf(page, TRUBA, TWO)
      assert.match(plain(await pipeRow.locator('td[data-label="Объём"]').innerText()), /^1700,?\d*2ВОР$/)
      assert.match(await pipeRow.locator('td[data-label="Объём"]').getAttribute('title'), /ОВ: 1\s?500[\s\S]*ВК: 200|ВК: 200[\s\S]*ОВ: 1\s?500/)

      // Цена в строке — обоим ВОР: у каждого своя строка цены и свой объём, итог строки — их сумма.
      await enter(page.getByLabel(price(TRUBA, TWO)), '412,5')
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.filter((r) => r.material_key === window.__fakeDb.tender_vor_supply_rates.find((x) => x.estimate_name === 'ВК')?.material_key).length === 2)
      const ov = await rateOf(page, 'Труба медная Ø12,7', 'ОВ')
      const vk = await rateOf(page, TRUBA, 'ВК')
      assert.deepEqual([ov.tender_id, ov.price_input, ov.volume_at_input, ov.supply_total], ['tender-p', 'unit', 1500, 618750], 'цена — у основного тендера')
      assert.deepEqual([vk.supply_price, vk.supply_total], [412.5, 82500])
      await page.waitForFunction((l) => /701250,00/.test(document.querySelector(`[aria-label="${l}"]`).value.replace(/\s/g, '')), sum(TRUBA, TWO))

      // Сумма на строку из двух ВОР: цена одна, сумма — по объёму каждого.
      await enter(page.getByLabel(sum(TRUBA, TWO)), '850000')
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.filter((r) => Number(r.supply_price) === 500).length === 2)
      assert.equal((await rateOf(page, 'Труба медная Ø12,7', 'ОВ')).supply_total, 750000)
      assert.equal((await rateOf(page, TRUBA, 'ВК')).supply_total, 100000)

      // Кран в ОВ и ВК в разных единицах — разные строки: цена одного не трогает другой.
      await enter(page.getByLabel(sum('Кран шаровой Ду15', 'ОВ')), '48000')
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((r) => r.estimate_name === 'ОВ' && r.material_name === 'Кран шаровой Ду15'))
      assert.equal((await rateOf(page, 'Кран шаровой Ду15', 'ОВ')).supply_price, 1000)
      await page.waitForTimeout(300)
      assert.equal(await rateOf(page, 'Кран шаровой Ду15', 'ВК'), null, 'другая единица — не та же позиция')

      assert.equal(await page.getByLabel(sum('Хомут монтажный', 'ОВ')).isDisabled(), true, 'без объёма сумму не ввести')
      const before = await rateOf(page, 'Изоляция K-Flex 13×15', 'ОВ')
      await enter(page.getByLabel(price('Изоляция K-Flex 13×15', 'ОВ')), '97')
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.find((r) => r.id === 'rate-p-3').supply_price === 97)
      assert.equal((await rateOf(page, 'Изоляция K-Flex 13×15', 'ОВ')).row_version, before.row_version + 1)
      await pricedCount(page, 3, 5)
      assert.match(plain(await page.locator('.sp-table tfoot').innerText()), /Итого1004700,00/) // 850 000 + 48 000 + 106 700

      // Фильтр по ВОР: только его позиции, объём и суммы — его; цена по-прежнему одна на строку.
      await page.getByLabel('Показать позиции ВОР').selectOption('ВК')
      await page.getByRole('button', { name: 'Все (2)' }).waitFor()
      assert.equal(await page.getByLabel(price('Хомут монтажный', 'ОВ')).count(), 0)
      assert.match(plain(await rowOf(page, TRUBA, TWO).locator('td[data-label="Объём"]').innerText()), /^200/)
      assert.match(plain(await page.getByLabel(sum(TRUBA, TWO)).inputValue()), /^100000,00$/)
      assert.match(plain(await page.locator('.sp-table tfoot').innerText()), /Итого100000,00/)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('разное написание: уверенность от 90 % — одна строка, вторая запись видна, можно разделить; другая длина — разные строки', async () => {
    const name = 'Кран шаровой полнопроходной DN15 R850X023'
    const other = 'Шаровой кран полнопроходной, резьба ВН/ВН, DN15 R850X023 Giacomini'
    const { page, context, errors } = await openPage('&samePos=1')
    try {
      // Строка — по первому ВОР таблицы («ВК»), вторая запись — подсказкой.
      const row = rowOf(page, other, TWO)
      await row.getByText(`в другом ВОР: «${name}»`).waitFor()
      assert.equal(await page.getByLabel(/^Цена за единицу: Патч-корд/).count(), 2, 'длины 0,3 м и 5 м — разные позиции, хотя текст почти один')
      await enter(page.getByLabel(price(other, TWO)), '1200')
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.filter((r) => Number(r.supply_price) === 1200).length === 2)
      const both = await page.evaluate(() => window.__fakeDb.tender_vor_supply_rates.filter((r) => Number(r.supply_price) === 1200).map((r) => r.estimate_name).sort())
      assert.deepEqual(both, ['ВК', 'ОВ'])

      // Разделили — две строки, и браузер это помнит.
      await row.getByRole('button', { name: `Разделить: ${other}` }).click()
      await page.getByLabel(price(name, 'ОВ')).waitFor()
      await page.getByLabel(price(other, 'ВК')).waitFor()
      await page.reload()
      await page.getByLabel(price(name, 'ОВ')).waitFor({ timeout: 120000 })
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('разные цены одной позиции в ВОР: подсказка и «поставить во все ВОР»; цена только в одном ВОР — то же', async () => {
    const { page, context, errors } = await openPage('&pipeRates=differ')
    try {
      const row = rowOf(page, TRUBA, TWO)
      await row.getByText('в ВОР разные цены', { exact: false }).waitFor()
      // Строка показывает самую свежую цену, итог — сумма по ВОР: 1 500 × 400 + 200 × 450.
      assert.equal(plain(await page.getByLabel(price(TRUBA, TWO)).inputValue()), '400,00')
      assert.equal(plain(await page.getByLabel(sum(TRUBA, TWO)).inputValue()), '690000,00')
      await row.getByRole('button', { name: 'поставить 400,00 во все ВОР' }).click()
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.find((x) => x.id === 'rate-pipe-vk').supply_price === 400)
      await row.getByText('в ВОР разные цены', { exact: false }).waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
    const partial = await openPage('&pipeRates=partial')
    try {
      const row = rowOf(partial.page, TRUBA, TWO)
      await row.getByText('цена не во всех ВОР', { exact: false }).waitFor()
      // Такая строка считается нерасценённой: цена есть не во всех ВОР.
      await partial.page.getByRole('button', { name: 'Не расценены (4)', exact: true }).waitFor()
      await row.getByRole('button', { name: 'поставить 400,00 во все ВОР' }).click()
      await partial.page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((x) => x.estimate_name === 'ВК' && Number(x.supply_price) === 400))
      await partial.page.getByRole('button', { name: 'Не расценены (3)', exact: true }).waitFor()
      assert.deepEqual(partial.errors, [])
    } finally {
      await partial.context.close()
    }
  })

  it('«Скачать Excel» и «Версии ВОР» — только администратору; инженеру с правом правки и зрителю — нет', async () => {
    const admin = await openPage()
    try {
      await admin.page.getByRole('button', { name: 'Скачать Excel' }).waitFor()
      await admin.page.getByRole('button', { name: 'Версии ВОР' }).waitFor()
      assert.deepEqual(admin.errors, [])
    } finally {
      await admin.context.close()
    }
    for (const q of ['&asRole=supply', '&canEdit=0']) {
      const { page, context, errors } = await openPage(q)
      try {
        await page.locator('.sp-table').waitFor()
        assert.equal(await page.getByRole('button', { name: 'Скачать Excel' }).count(), 0, q)
        assert.equal(await page.getByRole('button', { name: 'Версии ВОР' }).count(), 0, q)
        assert.deepEqual(errors, [])
      } finally {
        await context.close()
      }
    }
  })

  it('файлов ВОР нет — позиции сами берутся из вкладки «ВОР» карточки', async () => {
    const { page, context, errors } = await open('', '/tenders/materials/mat-q/pricing')
    try {
      await vors(page, 'ВОР «Корпус 7»').waitFor({ timeout: 120000 })
      await (await openVors(page)).getByText('вкладка «ВОР» карточки', { exact: false }).waitFor()
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
      await vors(page, 'ВОРы тендера: 2').waitFor()
      await openVors(page)
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
      // Без колонок доставки (миграция 20261120) первая выборка узнаёт это ответом 42703 — она не загрузка.
      // Два чтения: цены тендера и свежие цены других тендеров для меню похожих (в другой ед. изм.; база их не отбирает).
      assert.equal(opened.filter((r) => r.table === 'tender_vor_supply_rates' && r.range && !r.missing).length, 2, 'вкладка загрузила цены один раз')
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
        // Цены тендера и свежие цены других тендеров (для меню похожих в другой ед. изм.) — по одному чтению.
        assert.equal(list.filter((q) => q.table === 'tender_vor_supply_rates' && q.range && !q.missing).length, 2, 'цены — один раз за открытие')
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

  it('у позиции без объёма поле итога закрыто и говорит почему — отдельной подсказкой строку не загружаем', async () => {
    const { page, context, errors } = await openPage()
    try {
      const total = page.getByLabel(sum('Хомут монтажный', 'ОВ'))
      assert.equal(await total.isDisabled(), true)
      assert.equal(await total.getAttribute('placeholder'), 'нет объёма')
      assert.match(await total.getAttribute('title'), /в ВОР у позиции нет объёма — введите цену за единицу/)
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
      await vors(first.page, 'ВОР «Корпус 7»').waitFor()
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
      await vors(page, 'ВОР «ВОР_Корпус7»').waitFor({ timeout: 120000 })
      assert.match(await (await openVors(page)).locator('.sp-vor-line', { hasText: 'ВОР_Корпус7' }).getAttribute('title'), /строки с кодом «мат\.»/)
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
      await dialog.getByRole('tab', { name: 'Ссылка' }).click()
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
      // Весь ВОР — выбрать его в списке и отметить показанные; плюс одна строка другого ВОР.
      await page.getByLabel('Показать позиции ВОР').selectOption('ВК')
      await page.getByLabel('Отметить все показанные позиции').check()
      await page.getByLabel('Показать позиции ВОР').selectOption('')
      await page.getByLabel('Отметить: Изоляция K-Flex 13×15 (ВОР «ОВ»)').check()
      await page.locator('.sp-sel-bar', { hasText: 'Отмечено: 3' }).waitFor()
      await page.getByRole('button', { name: 'Документ', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: /Документ — 3 позициям/ })
      await dialog.getByRole('tab', { name: 'Ссылка' }).click()
      await dialog.getByRole('textbox').fill('\\\\su10-fs\\Снабжение\\Счёт 15.pdf')
      await dialog.getByRole('button', { name: 'Прикрепить к 3' }).click()
      // Три строки — четыре записи: труба есть в двух ВОР.
      await page.waitForFunction(() => window.__fakeDb.tender_supply_links.length === 4)
      const urls = await page.evaluate(() => [...new Set(window.__fakeDb.tender_supply_links.map((l) => l.url))])
      assert.deepEqual(urls, ['\\\\su10-fs\\Снабжение\\Счёт 15.pdf'])
      assert.equal(await page.locator('.sp-sel-bar').count(), 0, 'отметка снята после прикрепления')
      assert.equal(await rowOf(page, 'Изоляция K-Flex 13×15', 'ОВ').getByRole('button', { name: 'Скопировать путь к документу «Изоляция K-Flex 13×15»' }).count(), 1)
      // Убрать у трубы и крана ВК.
      await page.getByLabel('Показать позиции ВОР').selectOption('ВК')
      await page.getByLabel('Отметить все показанные позиции').check()
      await page.getByRole('button', { name: 'Документ', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Убрать документ' }).click()
      await page.waitForFunction(() => window.__fakeDb.tender_supply_links.length === 1)
      assert.equal(await page.evaluate(() => window.__fakeDb.tender_supply_links[0].material_name), 'Изоляция K-Flex 13×15')
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
      assert.equal(await page.getByLabel(price(TRUBA, TWO)).isDisabled(), true)
      assert.equal(await page.getByLabel(sum(TRUBA, TWO)).isDisabled(), true)
      assert.equal(await page.locator('.sp-problem').count(), 0, 'закрытый тендер не загружает ВОР')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  // Тендер № 38 на проде: цены снабжения поставлены в июне по вкладке «ВОР», тендер на материалы завершён раньше,
  // чем появились списки позиций, — таблица была пустой, все цены лежали в «Ценах без позиции».
  it('расценка закрыта, а списка позиций нет — позиции по вкладке «ВОР», цены на месте, в базу ничего не пишется', async () => {
    for (const query of ['&qPriced=1&qMatStatus=%D0%97%D0%B0%D0%B2%D0%B5%D1%80%D1%88%D1%91%D0%BD', '&qPriced=1&canEdit=0']) {
      const { page, context, errors } = await open(query, '/tenders/materials/mat-q/pricing')
      try {
        await vors(page, 'ВОР «Корпус 7»').waitFor({ timeout: 120000 })
        assert.match(await (await openVors(page)).locator('.sp-vor-line').getAttribute('title'), /в расценку не загружался — позиции показаны по вкладке/)
        const cable = page.getByLabel(price('Кабель ВВГнг 3×2,5', 'Корпус 7'))
        assert.match(plain(await cable.inputValue()), /120,00/, query)
        assert.equal(await cable.isDisabled(), true, query)
        await pricedCount(page, 1, 2)
        assert.match(plain(await page.locator('.sp-table tfoot').innerText()), /480000,00/, query)
        assert.equal(await page.locator('.sp-orphans').count(), 0, `цены без позиции не остаются (${query})`)
        await page.waitForTimeout(300)
        assert.equal(await page.evaluate(() => window.__fakeDb.tender_supply_sources.filter((s) => s.tender_id === 'tender-q').length), 0,
          `список позиций в базу не записан (${query})`)
        assert.deepEqual(errors, [])
      } finally {
        await context.close()
      }
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
      // В строке коротко: откуда и документ; объект и день — в подсказке (день ещё и своей колонкой).
      await kran.locator('.sp-origin', { hasText: 'тендера № 445' }).waitFor({ timeout: 30000 })
      assert.match(await kran.locator('.sp-origin').innerText(), /^цена из тендера № 445/)
      assert.match(await kran.locator('.sp-origin').getAttribute('title'), /ЖК Север/)
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
      const truba = rowOf(page, TRUBA, TWO)
      const btn = truba.locator('.sp-similar-btn')
      await btn.waitFor()
      assert.match(plain(await btn.innerText()), /похожиецены:2/)
      assert.equal(await rowOf(page, 'Хомут монтажный', 'ОВ').locator('.sp-similar-btn').count(), 0)
      await btn.focus()
      await page.keyboard.press('Enter')
      const menu = page.getByRole('dialog', { name: `Похожие цены: ${TRUBA}` })
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
      const trubaOrigin = truba.locator('.sp-origin', { hasText: 'Похожая цена: Труба медная Ø15,9; №445; ' })
      await trubaOrigin.waitFor()
      assert.match((await trubaOrigin.innerText()).trim(), /^Похожая цена: Труба медная Ø15,9; №445; \d\d\.\d\d\.\d{4}; документ: Открыть\.$/)
      assert.match(await trubaOrigin.getAttribute('title'), /ЖК Север · ВОР «ОВ-2»/, 'объект и ВОР — в подсказке')
      // Документ исходной позиции — к позиции в обоих ВОР (своего не было); цена в ВК — с той же отметкой.
      await page.waitForFunction(() => window.__fakeDb.tender_supply_links.filter((l) => l.url === 'https://disk.example.ru/d/chek-17').length === 2)
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((x) => x.estimate_name === 'ВК' && x.source_rate_id === 'o-truba-2'))
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

  // Взять из меню первую похожую цену трубы (Ø12,7 мм, документа у исходной позиции нет) или вторую (Ø15,9, документ — ссылка).
  const pickOtherTruba = async (page, nth) => {
    const truba = rowOf(page, TRUBA, TWO)
    await truba.locator('.sp-similar-btn').click()
    const menu = page.getByRole('dialog', { name: `Похожие цены: ${TRUBA}` })
    await menu.locator('li').nth(nth).getByRole('button', { name: /Взять/ }).click()
    await menu.waitFor({ state: 'detached' })
    await truba.locator('.sp-origin-open').waitFor()
    return truba
  }

  it('откуда цена: нажатие на строку «Похожая цена» — тендер, ВОР и документ; ссылка открывается', async () => {
    const { page, context, errors } = await openPage('&reuse=1&originDocs=1')
    try {
      const truba = await pickOtherTruba(page, 1)
      await truba.locator('.sp-origin-open', { hasText: 'Похожая цена: Труба медная Ø15,9; №445; ' }).click()
      const dlg = page.getByRole('dialog', { name: 'Откуда цена' })
      await dlg.waitFor()
      const text = await dlg.innerText()
      assert.match(text, /Исходная позиция\s+Труба медная Ø15,9/)
      assert.match(text, /№ 445 · ЖК Север/)
      assert.match(text, /ОВ-2/)
      assert.match(text, /1\s?100,00\s₽ за м/)
      assert.equal(await dlg.getByRole('link', { name: 'Открыть документ' }).getAttribute('href'), 'https://disk.example.ru/d/chek-17')
      assert.equal(await dlg.getByRole('link', { name: '№ 445' }).getAttribute('href'), '/tenders/materials/tender-o/pricing')
      assert.doesNotMatch(text, /Документа нет/)
      await page.keyboard.press('Escape')
      await dlg.waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('откуда цена: документа нет — так и сказано, и почему; автор — только администратору', async () => {
    const { page, context, errors } = await openPage('&reuse=1&originDocs=1')
    try {
      const truba = await pickOtherTruba(page, 0)
      await truba.locator('.sp-origin-open').click()
      const dlg = page.getByRole('dialog', { name: 'Откуда цена' })
      await dlg.getByText('Документа нет: цену ввели вручную, документ к ней не прикрепляли.').waitFor()
      assert.equal(await dlg.getByRole('link', { name: 'Открыть документ' }).count(), 0)
      assert.match(await dlg.innerText(), /Поставил/, 'администратору')
      await dlg.getByRole('button', { name: 'Закрыть' }).click()
      await dlg.waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
    // Другая роль: то же окно, но автора нет (как в колонке «Дата цены»).
    const other = await openPage('&reuse=1&originDocs=1&asRole=supply')
    try {
      const truba = await pickOtherTruba(other.page, 0)
      await truba.locator('.sp-origin-open').click()
      const dlg = other.page.getByRole('dialog', { name: 'Откуда цена' })
      await dlg.getByText('Документа нет', { exact: false }).waitFor()
      assert.doesNotMatch(await dlg.innerText(), /Поставил/)
      assert.deepEqual(other.errors, [])
    } finally {
      await other.context.close()
    }
  })

  it('откуда цена: к цене не прикреплено, но в счёте тендера та же строка — файл открывается просмотром', async () => {
    const { page, context, errors } = await openPage('&reuse=1&originDocs=2')
    try {
      const truba = await pickOtherTruba(page, 0)
      await truba.locator('.sp-origin-open').click()
      const dlg = page.getByRole('dialog', { name: 'Откуда цена' })
      await dlg.getByText('в файлах тендера есть похожая строка', { exact: false }).waitFor()
      assert.match(await dlg.innerText(), /Труба медная Ø12,7 мм \(бухта\) — 980,00 ₽ за м · та же цена/)
      await dlg.getByRole('button', { name: 'Счёт на трубу.pdf' }).click()
      await dlg.waitFor({ state: 'detached' })
      await page.locator('.s3-doc-modal-title', { hasText: 'Счёт на трубу.pdf' }).waitFor()
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('цены из других тендеров без права правки: ничего не подставляется, меню только для просмотра, Esc закрывает', async () => {
    const { page, context, errors } = await openPage('&reuse=1&canEdit=0')
    try {
      const btn = rowOf(page, TRUBA, TWO).locator('.sp-similar-btn')
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
      await enter(page.getByLabel(price(TRUBA, TWO)), '400')
      const truba = rowOf(page, TRUBA, TWO)
      await truba.locator('.sp-author', { hasText: 'Стендов С. С.' }).waitFor()
      const [y, m, d] = day(0).split('-')
      assert.match(await truba.locator('.sp-date-cell').innerText(), new RegExp(`^${d}\\.${m}\\.${y}`))

      // С позавчера — только сегодняшние цены; с 4 дней по 2 дня назад — только изоляция (3 дня), кран — 5 дней.
      await page.getByRole('button', { name: 'фильтр по дате цены' }).click()
      await page.getByLabel('Дата цены: с').fill(day(2))
      await page.waitForFunction(() => !document.querySelector('[aria-label^="Цена за единицу: Изоляция"]'))
      assert.equal(await shown(TRUBA, TWO), 1)
      assert.equal(await shown('Кран шаровой Ду15', 'ОВ'), 0)
      assert.equal(await shown('Хомут монтажный', 'ОВ'), 0, 'без цены — не попадает')
      await page.getByLabel('Дата цены: с').fill(day(4))
      await page.getByLabel('Дата цены: по').fill(day(2))
      await page.waitForFunction(() => !!document.querySelector('[aria-label^="Цена за единицу: Изоляция"]'))
      assert.equal(await shown(TRUBA, TWO), 0)
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
  // Окно «Счета и КП тендера»: файл читается и загружается сразу, позиция ВОР и строка счёта — рядом.
  const tenderDocs = (page) => page.getByRole('dialog', { name: 'Счета и КП тендера' })
  const openTenderDocs = async (page) => {
    await page.getByRole('button', { name: /^Счета и КП/ }).click()
    await tenderDocs(page).locator('input[type=file]').waitFor({ state: 'attached' })
    return tenderDocs(page)
  }
  const closeTenderDocs = async (page) => {
    await tenderDocs(page).getByRole('button', { name: 'Закрыть' }).click()
    await tenderDocs(page).waitFor({ state: 'detached' })
  }
  const pickRow = (docs, text) => docs.locator('.sp-td-table tbody tr', { hasText: text })
  const applyBox = (row) => row.getByRole('checkbox', { name: /^Применить цену/ })
  const fileChips = (docs) => docs.getByRole('list', { name: 'Файлы тендера' })

  it('счёт (Excel): позиция ВОР полужирным и строка счёта рядом, единицы совпадают; свежий документ заменяет свою цену; применённое больше не показывается', async () => {
    const { page, context, errors } = await openPage()
    try {
      const docs = await openTenderDocs(page)
      await docs.locator('input[type=file]').setInputFiles({ name: 'Счёт 15 ТеплоСнаб.xlsx', mimeType: XLSX_MIME, buffer: supplierXlsx() })
      const pipe = pickRow(docs, 'Труба медная 12,7 мм (бухта 15 м)')
      await pipe.waitFor({ timeout: 60000 })
      // Построчной проверки и переключателей больше нет.
      assert.equal(await docs.getByRole('button', { name: /Проверить построчно/ }).count(), 0)
      assert.equal(await docs.getByRole('radio').count(), 0)
      assert.equal(await docs.locator('.sp-filter').count(), 0)
      // Позиция — полужирным, строка счёта — обычным; файл — мелко; отличия подсвечены.
      assert.equal((await pipe.locator('b.sp-td-name').innerText()).trim(), TRUBA)
      assert.equal(await pipe.locator('td.sp-td-line b').count(), 0)
      assert.match(await pipe.locator('td.sp-td-line .sp-td-diff').allInnerTexts().then((x) => x.join(' ')), /бухта/)
      assert.match(await pipe.locator('td.sp-td-line .sp-td-file').innerText(), /Счёт 15 ТеплоСнаб\.xlsx/)
      assert.match(await pipe.locator('.sp-td-pos .sp-td-meta').getAttribute('title'), /ВК: 200 м/)
      assert.match(plain(await pipe.locator('.sp-td-pos .sp-td-meta').innerText()), /1700м·2ВОР/)
      // Единицы совпадают — статус; цена — с доставкой документа (+0,2 %).
      await pipe.locator('.sp-td-unit.is-ok').waitFor()
      assert.equal(plain(await pipe.locator('.sp-td-price').innerText()), '981,83')
      assert.equal(await applyBox(pipe).isChecked(), true)
      // Кран — та же позиция: из двух кранов ВОР — той же ед. изм.
      const kran = pickRow(docs, 'Кран шаровой Ду 15')
      assert.equal((await kran.locator('b.sp-td-name').innerText()).trim(), 'Кран шаровой Ду15')
      assert.equal(await applyBox(kran).isChecked(), true)
      // Своя цена старше документа — документ важнее: отмечено, видно, что заменится.
      const iso = pickRow(docs, 'Изоляция K-Flex 13x15')
      assert.match(await iso.locator('.sp-td-now.is-replace').innerText(), /96,00/)
      assert.equal(await applyBox(iso).isChecked(), true)
      // Строки, которым нет позиции, — свёрнуты внизу, не в таблице.
      assert.equal(await pickRow(docs, 'Болт М12х80').count(), 0)
      await docs.getByText('Строки счетов без позиции ВОР: 1').waitFor()

      await docs.getByRole('button', { name: 'Применить цены: 3' }).click()
      await docs.waitFor({ state: 'detached', timeout: 30000 })
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.filter((r) => r.tender_id === 'tender-p').length === 4)
      assert.equal((await rateOf(page, 'Труба медная Ø12,7', 'ОВ')).supply_price, 981.83)
      assert.equal((await rateOf(page, TRUBA, 'ВК')).supply_price, 981.83)
      const iRate = await rateOf(page, 'Изоляция K-Flex 13×15', 'ОВ')
      assert.equal(iRate.id, 'rate-p-3', 'своя цена заменена по версии строки')
      assert.equal(await rateOf(page, 'Кран шаровой Ду15', 'ВК'), null)

      // Файл — в хранилище документов основного тендера, своей категорией, и документом четырёх позиций.
      const doc = await page.evaluate(() => window.__fakeDb.s3_documents.find((d) => d.doc_category === 'supply_doc'))
      assert.deepEqual([doc.owner_type, doc.owner_id, doc.file_name], ['tender', 'tender-p', 'Счёт 15 ТеплоСнаб.xlsx'])
      await page.waitForFunction(() => window.__fakeDb.tender_supply_links.length === 4)
      const links = await page.evaluate(() => window.__fakeDb.tender_supply_links)
      assert.ok(links.every((l) => l.s3_document_id === doc.id && l.url == null), JSON.stringify(links))
      await page.getByText('Цен записано: 4', { exact: false }).waitFor()
      const open = rowOf(page, TRUBA, TWO).getByRole('button', { name: `Открыть файл документа «Счёт 15 ТеплоСнаб.xlsx» к «${TRUBA}»` })
      await open.click()
      await page.locator('.s3-doc-modal-title', { hasText: 'Счёт 15 ТеплоСнаб.xlsx' }).waitFor()
      await page.locator('.s3-doc-modal-close').click()
      await page.locator('.s3-doc-modal').waitFor({ state: 'detached' })

      // Цена уже стоит правильно — такой строки в окне нет.
      const again = await openTenderDocs(page)
      await again.getByText('Все цены из документов уже стоят в расценке.').waitFor()
      assert.equal(await again.locator('.sp-td-table').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('цены из КП в PDF: текст читает pdf.js в отдельном потоке; «Цена без НДС» — НДС сверху, можно поправить; скан без текста — понятный отказ', async () => {
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
      const docs = await openTenderDocs(page)
      await docs.locator('input[type=file]').setInputFiles({ name: 'скан.pdf', mimeType: 'application/pdf', buffer: scan })
      await docs.getByText('скан или фото: текст не распознался', { exact: false }).waitFor({ timeout: 60000 })
      await docs.locator('input[type=file]').setInputFiles({ name: 'КП 7.pdf', mimeType: 'application/pdf', buffer: pdf })
      const kran = pickRow(docs, 'Кран шаровой полнопроходной')
      await kran.waitFor({ timeout: 60000 })
      // Похоже не наверняка — пометка; то же наименование — без пометок. «Без НДС» — к цене НДС 22 %: 1 000 → 1 220.
      assert.match(await kran.locator('.sp-td-line').innerText(), /похоже на \d+ %/)
      assert.equal(await pickRow(docs, 'Хомут монтажный').locator('.sp-td-tag').count(), 0)
      assert.equal(plain(await kran.locator('.sp-td-price').innerText()), '1220,00')
      assert.equal(plain(await pickRow(docs, 'Хомут монтажный').locator('.sp-td-price').innerText()), '43,31')
      // Документ понят неверно — поправить у файла: цены пересчитываются и запоминаются.
      const vat = docs.getByLabel('НДС в ценах: КП 7.pdf')
      assert.equal(await vat.inputValue(), 'net')
      await vat.selectOption('gross')
      await page.waitForFunction(() => /1000,00/.test(document.querySelector('.sp-td-table')?.innerText.replace(/\s/g, '') || ''))
      await vat.selectOption('net')
      await page.waitForFunction(() => /1220,00/.test(document.querySelector('.sp-td-table')?.innerText.replace(/\s/g, '') || ''))
      await docs.getByRole('button', { name: 'Применить цены: 2' }).click()
      await docs.waitFor({ state: 'detached', timeout: 30000 })
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((r) => r.material_name === 'Хомут монтажный'))
      assert.equal((await rateOf(page, 'Хомут монтажный', 'ОВ')).supply_price, 43.31)
      assert.equal((await rateOf(page, 'Кран шаровой Ду15', 'ОВ')).supply_price, 1220)
      assert.deepEqual(await page.evaluate(() => window.__fakeDb.s3_documents.filter((d) => d.doc_category === 'supply_doc').map((d) => d.file_name).sort()), ['КП 7.pdf', 'скан.pdf'])
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  // Доставка позиции (миграция 20261120, стенд delivery=1 — колонки есть, триггер считает как база).
  const deliveryCell = (page, name, vor, mode = 'за единицу') => page.getByLabel(`Доставка ${mode}: ${name} (${vorText(vor)})`)
  const deliveryMode = (page, name, vor) => page.getByLabel(`Доставка за единицу или на позицию: ${name} (${vorText(vor)})`)
  const rateWhen = (page, test, arg) => page.waitForFunction(test, arg, { timeout: 30000 })

  it('доставка: за единицу и на позицию, цена с доставкой и итог; смена вида — та же доставка; итог вводится с доставкой; без цены — закрыта', async () => {
    const { page, context, errors } = await openPage('&delivery=1')
    try {
      // Пока доставки нет ни у одной цены — колонка скрыта, открывается кнопкой.
      assert.equal(await page.locator('.sp-table th', { hasText: 'Доставка, ₽' }).count(), 0)
      await page.getByRole('button', { name: 'показать доставку' }).click()
      await page.locator('.sp-table th', { hasText: 'Доставка, ₽' }).waitFor()
      const iso = 'Изоляция K-Flex 13×15'
      const row = rowOf(page, iso, 'ОВ')
      const isoRate = () => page.evaluate(() => window.__fakeDb.tender_vor_supply_rates.find((r) => r.id === 'rate-p-3'))
      const parts = (r) => [r.price_input, r.input_value, r.delivery_input, r.delivery_value, r.supply_price, r.supply_total]

      // 96 за ед., объём 1 100: доставка 4 за ед. → цена позиции 100, итог 110 000; в поле цены — по-прежнему 96.
      await enter(deliveryCell(page, iso, 'ОВ'), '4')
      await rateWhen(page, () => window.__fakeDb.tender_vor_supply_rates.find((r) => r.id === 'rate-p-3').delivery_value === 4)
      assert.deepEqual(parts(await isoRate()), ['unit', 96, 'unit', 4, 100, 110000])
      assert.equal(plain(await page.getByLabel(price(iso, 'ОВ')).inputValue()), '96,00')
      assert.equal(plain(await page.getByLabel(sum(iso, 'ОВ')).inputValue()), '110000,00')
      assert.match(plain(await row.innerText()), /сдоставкой100,00/)
      assert.match(plain(await row.innerText()), /напозицию4400,00/)

      // «На позицию» — та же доставка суммой: 4 × 1 100 = 4 400, цена и итог те же.
      await deliveryMode(page, iso, 'ОВ').selectOption('total')
      await rateWhen(page, () => window.__fakeDb.tender_vor_supply_rates.find((r) => r.id === 'rate-p-3').delivery_input === 'total')
      assert.deepEqual(parts(await isoRate()), ['unit', 96, 'total', 4400, 100, 110000])
      // Своя сумма доставки: 1 100 на позицию → 1 за ед., цена 97, итог 106 700.
      await enter(deliveryCell(page, iso, 'ОВ', 'на позицию'), '1100')
      await rateWhen(page, () => window.__fakeDb.tender_vor_supply_rates.find((r) => r.id === 'rate-p-3').delivery_value === 1100)
      assert.deepEqual(parts(await isoRate()), ['unit', 96, 'total', 1100, 97, 106700])
      assert.match(plain(await row.innerText()), /заед\.1,00/)

      // «Итого» — с доставкой: ввели 110 000 → сумма материала 108 900 (99 за ед.), доставка та же.
      await enter(page.getByLabel(sum(iso, 'ОВ')), '110000')
      await rateWhen(page, () => window.__fakeDb.tender_vor_supply_rates.find((r) => r.id === 'rate-p-3').price_input === 'total')
      assert.deepEqual(parts(await isoRate()), ['total', 108900, 'total', 1100, 100, 110000])
      assert.equal(plain(await page.getByLabel(price(iso, 'ОВ')).inputValue()), '99,00')
      // Убрали доставку — цена позиции без неё.
      await enter(deliveryCell(page, iso, 'ОВ', 'на позицию'), '')
      await rateWhen(page, () => window.__fakeDb.tender_vor_supply_rates.find((r) => r.id === 'rate-p-3').delivery_input === null)
      assert.deepEqual(parts(await isoRate()), ['total', 108900, null, null, 99, 108900])

      // Хомут: цены нет — доставка закрыта; после цены — только за единицу (объёма в ВОР нет).
      assert.equal(await deliveryCell(page, 'Хомут монтажный', 'ОВ').isDisabled(), true)
      await enter(page.getByLabel(price('Хомут монтажный', 'ОВ')), '35')
      await rateWhen(page, () => window.__fakeDb.tender_vor_supply_rates.some((r) => r.material_name === 'Хомут монтажный'))
      await page.waitForFunction((l) => !document.querySelector(`[aria-label="${l}"]`)?.disabled, 'Доставка за единицу: Хомут монтажный (ВОР «ОВ»)')
      assert.equal(await deliveryMode(page, 'Хомут монтажный', 'ОВ').locator('option[value=total]').isDisabled(), true)
      await enter(deliveryCell(page, 'Хомут монтажный', 'ОВ'), '5')
      await rateWhen(page, () => window.__fakeDb.tender_vor_supply_rates.find((r) => r.material_name === 'Хомут монтажный').delivery_value === 5)
      assert.equal((await rateOf(page, 'Хомут монтажный', 'ОВ')).supply_price, 40)

      // Труба — строка из двух ВОР: доставка за единицу — обоим (у ВК свой объём), на позицию — по объёму.
      await enter(page.getByLabel(price(TRUBA, TWO)), '412,5')
      await rateWhen(page, () => window.__fakeDb.tender_vor_supply_rates.filter((r) => Number(r.supply_price) === 412.5).length === 2)
      await enter(deliveryCell(page, TRUBA, TWO), '10')
      await rateWhen(page, () => window.__fakeDb.tender_vor_supply_rates.filter((r) => r.delivery_value === 10).length === 2)
      const vk = await rateOf(page, TRUBA, 'ВК')
      assert.deepEqual([vk.input_value, vk.delivery_input, vk.supply_price, vk.supply_total], [412.5, 'unit', 422.5, 84500])
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('без колонок доставки (миграция 20261120 не применена) — колонки нет, цены пишутся как раньше', async () => {
    const { page, context, errors } = await openPage()
    try {
      await page.getByLabel(price('Изоляция K-Flex 13×15', 'ОВ')).waitFor()
      assert.equal(await page.locator('.sp-table th', { hasText: 'Доставка, ₽' }).count(), 0)
      await page.locator('.sp-table th', { hasText: 'Цена за ед. с доставкой и НДС, ₽' }).waitFor()
      await enter(page.getByLabel(price('Кран шаровой Ду15', 'ОВ')), '500')
      await rateWhen(page, () => window.__fakeDb.tender_vor_supply_rates.some((r) => r.material_name === 'Кран шаровой Ду15' && r.estimate_name === 'ОВ'))
      const kran = await rateOf(page, 'Кран шаровой Ду15', 'ОВ')
      assert.ok(!('delivery_input' in kran) && !('delivery_value' in kran), 'доставка не пишется')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('счёт с доставкой: строка «Доставка» — по позициям пропорционально сумме, в цене позиции; колонка «Доставка» не заполняется', async () => {
    const maker = await browser.newPage()
    await maker.setContent(`<html><head><meta charset="utf-8"><style>body{font:7pt Arial,sans-serif}table{border-collapse:collapse;width:170mm;table-layout:fixed}
      td,th{border:1px solid #000;padding:0 2px;vertical-align:top;line-height:1.15}th{background:#ccc;font-weight:normal}.r{text-align:right}</style></head><body>
      <h3>Коммерческое предложение № 10068</h3>
      <table><tr><th style="width:5mm">№</th><th style="width:14mm">Артикул</th><th style="width:40mm">Наименование</th><th style="width:7mm">Ед.</th>
      <th style="width:14mm">Кол-во</th><th style="width:20mm">Цена, шт с<br>НДС</th><th>Сумма, руб. с<br>НДС</th></tr>
      <tr><td>1</td><td>13015</td><td>Изоляция K-Flex 13×15 трубная, вспененный каучук</td><td>м</td><td class="r">1 100</td><td class="r">101,00</td><td class="r">111 100,00</td></tr>
      <tr><td>2</td><td>22018</td><td>Кран шаровой Ду15 латунный муфтовый</td><td>шт</td><td class="r">48</td><td class="r">500,00</td><td class="r">24 000,00</td></tr>
      <tr><td>3</td><td></td><td>Доставка товара (без разгрузочных работ)</td><td>шт</td><td class="r">1</td><td class="r">6 755,00</td><td class="r">6 755,00</td></tr>
      </table><p style="text-align:right"><b>Итого: 141 855,00</b><br><b>В том числе НДС: 25 580,08</b></p></body></html>`)
    const pdf = await maker.pdf({ format: 'A4' })
    await maker.close()
    const { page, context, errors } = await openPage('&delivery=1')
    try {
      const docs = await openTenderDocs(page)
      await docs.locator('input[type=file]').setInputFiles({ name: 'КП 10068.pdf', mimeType: 'application/pdf', buffer: pdf })
      const kranRow = pickRow(docs, 'Кран шаровой Ду15 латунный')
      await kranRow.waitFor({ timeout: 60000 })
      // Доставка 6 755 = 5 % суммы товаров: к цене кранов +25.
      assert.equal(plain(await kranRow.locator('.sp-td-price').innerText()), '525,00')
      await applyBox(kranRow).check()
      await docs.getByRole('button', { name: /^Применить цены:/ }).click()
      await docs.waitFor({ state: 'detached', timeout: 30000 })
      await rateWhen(page, () => window.__fakeDb.tender_vor_supply_rates.some((r) => r.material_name === 'Кран шаровой Ду15' && r.estimate_name === 'ОВ'))
      const kran = await rateOf(page, 'Кран шаровой Ду15', 'ОВ')
      assert.deepEqual([kran.input_value, kran.delivery_input, kran.delivery_value, kran.supply_price], [525, null, null, 525])
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  // Второй поставщик: те же материалы своими словами и дешевле, без доставки.
  const supplierXlsx2 = () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['ООО «Климат-Опт»'],
      ['Коммерческое предложение № 3'],
      ['№', 'Наименование', 'Ед. изм.', 'Кол-во', 'Цена с НДС', 'Сумма с НДС'],
      [1, 'Кран шаровой латунный Ду15 PN40', 'шт', 48, 500, 24000],
      [2, 'Изоляция K-Flex ST 13x15', 'м', 1100, 101, 111100],
      ['', 'Итого', '', '', '', 135100],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'КП')
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  }
  const offerDoc = (page, name) => page.evaluate((n) => {
    const d = window.__fakeDb.s3_documents.find((x) => x.doc_category === 'supply_doc' && x.file_name === n)
    return d ? { ...d, offer: d.notes ? JSON.parse(d.notes) : null } : null
  }, name)
  const similarBtn = (row) => row.locator('.sp-similar-btn')

  it('другая строка и отказ — при файле: «нет в счетах» больше не предлагается; строке без позиции указать позицию поиском; цены не пишутся, пока не применили; «Взять» — цена и файл', async () => {
    const { page, context, errors } = await openPage()
    try {
      const ratesBefore = await page.evaluate(() => window.__fakeDb.tender_vor_supply_rates.length)
      const docs = await openTenderDocs(page)
      await docs.locator('input[type=file]').setInputFiles({ name: 'Счёт 15 ТеплоСнаб.xlsx', mimeType: XLSX_MIME, buffer: supplierXlsx() })
      const pipe = pickRow(docs, 'Труба медная 12,7')
      await pipe.waitFor({ timeout: 60000 })
      // Трубу — это не она: строка больше не предлагается и уходит в «без позиции».
      await pipe.getByRole('button', { name: 'другая строка' }).click()
      await pipe.getByRole('searchbox', { name: `Найти строку счёта для «${TRUBA}»` }).waitFor()
      await pipe.getByRole('button', { name: 'нет в счетах — не предлагать эту строку' }).click()
      await pipe.waitFor({ state: 'detached' })
      await docs.getByText('Строки счетов без позиции ВОР: 2').click()
      // Болт — хомуту, найденному поиском среди всех позиций: строка появляется и отмечена.
      await docs.getByRole('searchbox', { name: 'Найти позицию ВОР для «Болт М12х80»' }).fill('хомут')
      await docs.locator('.sp-td-unplaced .sp-td-opt', { hasText: 'Хомут монтажный' }).click()
      const xomutRow = pickRow(docs, 'Хомут монтажный')
      await xomutRow.waitFor()
      assert.match(await xomutRow.innerText(), /Болт М12х80/)
      assert.equal(await applyBox(xomutRow).isChecked(), true)
      await page.waitForFunction(() => {
        const d = window.__fakeDb.s3_documents.find((x) => x.doc_category === 'supply_doc')
        return d?.notes && JSON.parse(d.notes).lines.find((l) => l.n === 'Болт М12х80').k
      })
      await closeTenderDocs(page)
      assert.equal(await page.evaluate(() => window.__fakeDb.tender_vor_supply_rates.length), ratesBefore, 'цены не записаны')
      assert.equal(await page.evaluate(() => window.__fakeDb.tender_supply_links.length), 0, 'документ позициям не прикреплён')
      const doc = await offerDoc(page, 'Счёт 15 ТеплоСнаб.xlsx')
      const byName = Object.fromEntries(doc.offer.lines.map((l) => [l.n, l]))
      assert.ok(byName['Труба медная 12,7 мм (бухта 15 м)'].kn?.length, 'отказ запомнен при файле')
      assert.ok(byName['Болт М12х80'].k, 'выбранная позиция запомнена при файле')
      assert.equal(byName['Кран шаровой Ду 15'].p, 513.46, 'цена — с доставкой')

      // В таблице: хомут без цены — «похожие цены: 1» (строка болта); труба — нигде; изоляция расценена — «цены поставщиков».
      const xomut = rowOf(page, 'Хомут монтажный', 'ОВ')
      assert.equal(plain(await similarBtn(xomut).innerText()), 'похожиецены:1')
      assert.equal(await similarBtn(rowOf(page, TRUBA, TWO)).count(), 0)
      assert.equal(plain(await similarBtn(rowOf(page, 'Изоляция K-Flex 13×15', 'ОВ')).innerText()), 'ценыпоставщиков:1')
      await similarBtn(xomut).click()
      const menu = page.getByRole('dialog', { name: 'Похожие цены: Хомут монтажный' })
      await menu.getByText('Цены поставщиков', { exact: true }).waitFor()
      const offer = menu.locator('li.is-offer', { hasText: 'Болт М12х80' })
      await offer.getByText('выбрано вручную').waitFor()
      assert.match(plain(await offer.locator('.sp-suggest-price').innerText()), /^15,03₽/)
      await offer.getByRole('button', { name: /Взять цену 15,03/ }).click()
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((r) => r.material_name === 'Хомут монтажный' && r.estimate_name === 'ОВ'))
      const r = await rateOf(page, 'Хомут монтажный', 'ОВ')
      assert.deepEqual([r.supply_price, r.source_kind ?? null], [15.03, null], 'своя цена, не копия из другого тендера')
      await page.waitForFunction((id) => window.__fakeDb.tender_supply_links.some((l) => l.material_name === 'Хомут монтажный' && l.s3_document_id === id), doc.id)
      // Взятая цена — та же, что в документе: больше не предлагается.
      await similarBtn(rowOf(page, 'Хомут монтажный', 'ОВ')).waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('несколько файлов на весь тендер: читаются сами, у позиции цены обоих поставщиков; тот же файл второй раз не загружается', async () => {
    const { page, context, errors } = await openPage()
    try {
      const dialog = await openTenderDocs(page)
      const invoices = [
        { name: 'Счёт 15 ТеплоСнаб.xlsx', mimeType: XLSX_MIME, buffer: supplierXlsx() },
        { name: 'КП 3 Климат-Опт.xlsx', mimeType: XLSX_MIME, buffer: supplierXlsx2() },
      ]
      await dialog.locator('input[type=file]').setInputFiles(invoices)
      const files = fileChips(dialog)
      await files.locator('.sp-td-file', { hasText: 'Счёт 15 ТеплоСнаб.xlsx' }).waitFor({ timeout: 60000 })
      await files.locator('.sp-td-file', { hasText: 'КП 3 Климат-Опт.xlsx' }).waitFor({ timeout: 60000 })
      const second = await offerDoc(page, 'КП 3 Климат-Опт.xlsx')
      assert.equal(second.offer.lines.length, 2)
      assert.ok(second.offer.lines.every((l) => !l.k && !l.x), 'позиции не выбраны — их найдёт расценка')
      assert.equal(await page.evaluate(() => window.__fakeDb.tender_supply_links.length), 0)

      await dialog.locator('input[type=file]').setInputFiles(invoices[1])
      await files.getByText('уже есть у тендера', { exact: false }).waitFor({ timeout: 30000 })
      assert.equal(await page.evaluate(() => window.__fakeDb.s3_documents.filter((d) => d.doc_category === 'supply_doc').length), 2)
      await closeTenderDocs(page)
      const kran = rowOf(page, 'Кран шаровой Ду15', 'ОВ')
      assert.equal(plain(await similarBtn(kran).innerText()), 'похожиецены:2')
      await similarBtn(kran).click()
      const menu = page.getByRole('dialog', { name: 'Похожие цены: Кран шаровой Ду15' })
      const offers = menu.locator('li.is-offer')
      await offers.first().waitFor()
      assert.equal(await offers.count(), 2)
      assert.match(await offers.nth(0).innerText(), /Кран шаровой Ду 15[\s\S]*то же наименование[\s\S]*Счёт 15 ТеплоСнаб\.xlsx/)
      assert.match(await offers.nth(1).innerText(), /Кран шаровой латунный Ду15 PN40[\s\S]*похоже на \d+ %[\s\S]*КП 3 Климат-Опт\.xlsx[\s\S]*500,00/)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('файл к позиции перетаскиванием: на ячейку «Документ» — сразу окно всех расценок, файл — документ позиции; файл в окно документа — то же; мимо — ко всему тендеру', async () => {
    const { page, context, errors } = await openPage()
    try {
      const dropFile = async (target, name) => {
        const dt = await page.evaluateHandle((n) => {
          const d = new DataTransfer()
          d.items.add(new File(['%PDF-1.4\n%%EOF\n'], n, { type: 'application/pdf' }))
          return d
        }, name)
        await target.dispatchEvent('dragover', { dataTransfer: dt })
        await target.dispatchEvent('drop', { dataTransfer: dt })
      }
      await dropFile(rowOf(page, 'Кран шаровой Ду15', 'ОВ').locator('td.sp-doc'), 'Чек 9.pdf')
      const docs = tenderDocs(page)
      await fileChips(docs).getByText('Чек 9.pdf').waitFor({ timeout: 60000 })
      await page.waitForFunction(() => window.__fakeDb.tender_supply_links.some((l) => l.material_name === 'Кран шаровой Ду15' && l.s3_document_id))
      await closeTenderDocs(page)
      await rowOf(page, 'Кран шаровой Ду15', 'ОВ').getByRole('button', { name: 'Открыть файл документа «Чек 9.pdf» к «Кран шаровой Ду15»' }).waitFor()

      // Окно документа: бросили файл на вкладке «Ссылка» — то же самое, подтверждать не нужно.
      await rowOf(page, 'Хомут монтажный', 'ОВ').getByRole('button', { name: /Прикрепить документ: Хомут монтажный/ }).click()
      const dialog = page.getByRole('dialog', { name: 'Документ к позиции' })
      await dialog.getByRole('tab', { name: 'Ссылка' }).click()
      await dropFile(dialog, 'Счёт 10.pdf')
      await fileChips(docs).getByText('Счёт 10.pdf').waitFor({ timeout: 60000 })
      await dialog.waitFor({ state: 'detached' })
      await page.waitForFunction(() => window.__fakeDb.tender_supply_links.some((l) => l.material_name === 'Хомут монтажный' && l.s3_document_id))
      await closeTenderDocs(page)

      // Файл, брошенный мимо ячейки, страницу не уводит: это файл ко всему тендеру, позициям не прикрепляется.
      const before = await page.evaluate(() => window.__fakeDb.tender_supply_links.length)
      await dropFile(page.locator('.sp-toolbar-right'), 'мимо.pdf')
      await page.getByRole('heading', { name: 'Расценка материалов' }).waitFor()
      await fileChips(docs).getByText('мимо.pdf').waitFor({ timeout: 60000 })
      await page.waitForFunction(() => window.__fakeDb.s3_documents.filter((d) => d.doc_category === 'supply_doc').length === 3, null, { timeout: 60000 })
      assert.equal(await page.evaluate(() => window.__fakeDb.tender_supply_links.length), before)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('файл документом к позиции: с компьютера — сразу окно расценок; другой позиции — тот же файл из списка; ссылка вместо файла', async () => {
    const { page, context, errors } = await openPage()
    try {
      await rowOf(page, 'Кран шаровой Ду15', 'ОВ').getByRole('button', { name: /Прикрепить документ: Кран шаровой Ду15/ }).click()
      let dialog = page.getByRole('dialog', { name: 'Документ к позиции' })
      assert.equal(await dialog.getByRole('tab', { name: 'Файл' }).getAttribute('aria-selected'), 'true', 'обычно прикладывают файл')
      await dialog.locator('input[type=file]').setInputFiles({ name: 'Чек 777.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') })
      const docs = tenderDocs(page)
      await fileChips(docs).getByText('Чек 777.pdf').waitFor({ timeout: 60000 })
      await page.waitForFunction(() => window.__fakeDb.tender_supply_links.some((l) => l.material_name === 'Кран шаровой Ду15' && l.s3_document_id))
      await closeTenderDocs(page)
      const doc = await page.evaluate(() => window.__fakeDb.s3_documents.find((d) => d.file_name === 'Чек 777.pdf'))
      assert.deepEqual([doc.owner_id, doc.doc_category], ['tender-p', 'supply_doc'])
      await rowOf(page, 'Кран шаровой Ду15', 'ОВ').getByRole('button', { name: 'Открыть файл документа «Чек 777.pdf» к «Кран шаровой Ду15»' }).waitFor()

      // Хомуту — тот же файл из списка загруженных к тендеру: тоже окно расценок, второй раз файл не загружается.
      await rowOf(page, 'Хомут монтажный', 'ОВ').getByRole('button', { name: /Прикрепить документ: Хомут монтажный/ }).click()
      dialog = page.getByRole('dialog', { name: 'Документ к позиции' })
      await dialog.getByRole('radio', { name: /Чек 777\.pdf/ }).check()
      await dialog.getByRole('button', { name: 'Сохранить' }).click()
      await page.waitForFunction((id) => window.__fakeDb.tender_supply_links.some((l) => l.material_name === 'Хомут монтажный' && l.s3_document_id === id), doc.id)
      await docs.waitFor()
      await closeTenderDocs(page)
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
      assert.equal(await tenderDocs(page).count(), 0, 'ссылка окна расценок не открывает')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  // Счёт, как у ЭТМ: цена за упаковку, артикул отдельной колонкой.
  const packXlsx = () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Коммерческое предложение / Спецификация № 201/1'],
      ['N', 'Код товара', 'Имя товара', 'Производитель', 'Артикул', 'Кол-во', 'Ед.изм.', 'Цена без НДС', 'Цена с НДС', 'Сумма с НДС', 'Срок поставки'],
      [1, 106843968, 'Хомут монтажный (50шт)', 'DKC', 27403, 10, 'упак', 409.84, 500, 5000, 'в наличии'],
      [2, 9106234, 'Кран шаровой Ду 15', 'Valtec', 'VT.214', 48, 'шт', 420.08, 512.5, 24600, '03/11/26'],
      [3, 7611092, 'Болт М12х80', 'Крепдил', 'B-12', 100, 'шт', 12.3, 15, 1500, 'в наличии'],
      [null, null, null, null, null, null, null, null, 'Всего', 31100],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Лист1')
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  }

  it('файл к позиции: счёт читается сам, окно расценок; цена за упаковку — за штуку; неизвестный пересчёт — указать; файл не загружается заново', async () => {
    const { page, context, errors } = await openPage()
    try {
      await rowOf(page, 'Хомут монтажный', 'ОВ').getByRole('button', { name: /Прикрепить документ: Хомут монтажный/ }).click()
      const link = page.getByRole('dialog', { name: 'Документ к позиции' })
      await link.getByText('Сразу откроется окно расценок', { exact: false }).waitFor()
      await link.locator('input[type=file]').setInputFiles({ name: 'Спецификация ЭТМ.xlsx', mimeType: XLSX_MIME, buffer: packXlsx() })

      const docs = tenderDocs(page)
      const row = pickRow(docs, 'Хомут монтажный (50шт)')
      await row.waitFor({ timeout: 60000 })
      assert.equal(plain(await row.locator('.sp-td-price').innerText()), '10,00')
      await row.getByText('1 упак = 50 шт').waitFor()
      assert.equal(await applyBox(row).isChecked(), true, 'пересчёт понятен — ед. изм. подходит')
      assert.equal(await page.evaluate(() => window.__fakeDb.tender_supply_links.filter((l) => l.material_name === 'Хомут монтажный' && l.s3_document_id).length), 1, 'файл уже документ позиции')
      await docs.getByRole('button', { name: /^Применить цены: 2/ }).click()
      await docs.waitFor({ state: 'detached', timeout: 30000 })

      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.some((r) => r.material_name === 'Хомут монтажный'))
      assert.equal(Number((await rateOf(page, 'Хомут монтажный', 'ОВ')).supply_price), 10)
      const doc = await page.evaluate(() => window.__fakeDb.s3_documents.filter((d) => d.doc_category === 'supply_doc'))
      assert.equal(doc.length, 1, 'файл загружен один раз')
      assert.equal((await page.evaluate(() => window.__fakeUploads.filter((u) => /Спецификация/.test(u.s3_key)))).length, 1)
      assert.equal(JSON.parse(doc[0].notes).lines.find((l) => /Хомут/.test(l.n)).p, 500, 'в файле — цена за единицу документа')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('ед. изм. разные и пересчёт неизвестен: строка видна, не отмечена; указали — цена за единицу позиции, запомнено при файле', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['№', 'Наименование', 'Ед. изм.', 'Кол-во', 'Цена с НДС', 'Сумма с НДС'],
      [1, 'Хомут монтажный', 'упак', 2, 1000, 2000],
      ['', 'Итого', '', '', '', 2000],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Счёт')
    const { page, context, errors } = await openPage()
    try {
      const docs = await openTenderDocs(page)
      await docs.locator('input[type=file]').setInputFiles({ name: 'Упаковки.xlsx', mimeType: XLSX_MIME, buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) })
      const row = pickRow(docs, 'Хомут монтажный')
      await row.waitFor({ timeout: 60000 })
      await row.locator('.sp-td-unit.is-off').waitFor()
      assert.equal(await applyBox(row).isChecked(), false)
      assert.equal(await applyBox(row).isDisabled(), true)
      await row.getByLabel('Сколько шт в 1 упак: Хомут монтажный').fill('50')
      await row.getByLabel('Сколько шт в 1 упак: Хомут монтажный').press('Enter')
      await page.waitForFunction(() => /20,00/.test(document.querySelector('.sp-td-price')?.innerText || ''))
      assert.equal(await applyBox(row).isChecked(), true)
      await page.waitForFunction(() => {
        const d = window.__fakeDb.s3_documents.find((x) => x.file_name === 'Упаковки.xlsx')
        return d?.notes && JSON.parse(d.notes).lines[0].pm
      })
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('файл «Документ», прикреплённый без чтения: расценка читает его сама — цены поставщиков у позиций и строки в файле; нечитаемый не повторяется, фото не трогается; без права правки — не читает', async () => {
    const dataUrl = (buffer) => `data:application/octet-stream;base64,${Buffer.from(buffer).toString('base64')}`
    const init = {
      fn: (files) => { window.__fakeFiles = files },
      arg: { 'tenders/tender-p/unread.xlsx': dataUrl(supplierXlsx()), 'tenders/tender-p/unread-bad.xlsx': dataUrl(Buffer.from('не книга Excel')) },
    }
    let { page, context, errors } = await openPage('&supplyUnread=1', { init })
    try {
      await page.waitForFunction(() => window.__fakeDb.s3_documents.find((d) => d.id === 'doc-unread').notes
        && window.__fakeDb.s3_documents.find((d) => d.id === 'doc-unread-bad').notes, null, { timeout: 60000 })
      const stored = await page.evaluate(() => Object.fromEntries(window.__fakeDb.s3_documents.filter((d) => d.doc_category === 'supply_doc').map((d) => [d.id, d.notes])))
      assert.ok(JSON.parse(stored['doc-unread']).lines.length >= 3)
      assert.equal(JSON.parse(stored['doc-unread-bad']).lines.length, 0)
      assert.ok(JSON.parse(stored['doc-unread-bad']).failed)
      assert.equal(stored['doc-photo'], null, 'Word не скачиваем')
      await rowOf(page, 'Кран шаровой Ду15', 'ОВ').getByRole('button', { name: /похожие цены: 1|цены поставщиков: 1/i }).waitFor({ timeout: 30000 })

      // Окно: прочитанный файл — плашкой, нечитаемый и фото — с причиной; цены применяются без новой загрузки.
      const docs = await openTenderDocs(page)
      const list = fileChips(docs)
      await list.locator('.sp-td-file', { hasText: 'Счёт старый.xlsx' }).waitFor()
      await list.locator('li', { hasText: 'Испорченный.xlsx' }).getByText('не нашли таблицу', { exact: false }).or(list.locator('li', { hasText: 'Испорченный.xlsx' }).getByText('файл не читается', { exact: false })).waitFor()
      await list.locator('li', { hasText: 'Чек.docx' }).getByText('цены из него не прочитать', { exact: false }).waitFor()
      await docs.getByRole('button', { name: /^Применить цены:/ }).click()
      await docs.waitFor({ state: 'detached', timeout: 30000 })
      await page.waitForFunction(() => window.__fakeDb.tender_supply_links.some((l) => l.material_name === 'Кран шаровой Ду15' && l.s3_document_id === 'doc-unread'))
      assert.equal((await page.evaluate(() => window.__fakeUploads || [])).length, 0, 'файл заново не загружается')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }

    ;({ page, context, errors } = await openPage('&supplyUnread=1&canEdit=0', { init }))
    try {
      await page.locator('.sp-table').waitFor({ timeout: 60000 })
      await page.waitForTimeout(800)
      assert.equal(await page.evaluate(() => window.__fakeDb.s3_documents.find((d) => d.id === 'doc-unread').notes), null, 'без права правки — только смотрим')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  // Счёт на оплату из 1С: шапка таблицы глубоко в листе, лист свёрстан объединёнными ячейками (копия по виду тендера № 902).
  const oneCBook = () => {
    const width = 76
    const rows = Array.from({ length: 70 }, () => new Array(width).fill(''))
    const merges = []
    const put = (r, c0, c1, v) => { rows[r][c0] = v; if (c1 > c0) merges.push({ s: { r, c: c0 }, e: { r, c: c1 } }) }
    put(17, 17, 74, 'Внимание! Оплата данного счета означает согласие с условиями поставки товара. Уведомление об оплате обязательно, в противном случае не гарантируется наличие товара на складе.')
    put(41, 1, 74, 'Счет на оплату № 1234 от 02 ноября 2026 г.')
    for (const [c0, c1, text] of [[1, 4, '№'], [5, 14, 'Артикул'], [15, 48, 'Товары (работы, услуги)'], [49, 54, 'Кол-во'], [55, 58, 'Ед.'], [59, 66, 'Цена'], [67, 74, 'Сумма']]) put(49, c0, c1, text)
    for (const [c0, c1, v] of [[1, 4, 1], [5, 14, 'AE500'], [15, 48, 'Хомут монтажный (75)'], [49, 54, 3], [55, 58, 'упак'], [59, 66, 737.25], [67, 74, 2211.75]]) put(50, c0, c1, v)
    put(52, 37, 60, 'Итого:')
    put(52, 61, 74, 2211.75)
    put(54, 37, 60, 'В том числе НДС 22%:')
    put(54, 61, 74, 398.84)
    const ws = XLSX.utils.aoa_to_sheet(rows)
    ws['!merges'] = merges
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'TDSheet')
    return XLSX.write(wb, { type: 'buffer', bookType: 'biff8' })
  }
  const SCAN_INVOICE = `<h2>Счет № 123456 от 2 Ноября 2026 г.</h2><p>Покупатель: ООО "Строительное Управление"</p>
    <table><tr><th style="width:4%">№</th><th>Товар</th><th>Склад</th><th>Цена с НДС</th><th>Кол-во</th><th>Ед.</th><th>Сумма, руб</th></tr>
    <tr><td class="c">1</td><td>Кран шаровой Ду15 латунный</td><td class="c">14</td><td class="r">512,50</td><td class="r">48</td><td class="c">шт</td><td class="r">24 600,00</td></tr>
    <tr><td class="c">2</td><td>Изоляция K-Flex 13×15 ГОСТ</td><td class="c">14</td><td class="r">99,00</td><td class="r">1 100</td><td class="c">м</td><td class="r">108 900,00</td></tr>
    </table><p style="text-align:right">Итого: 133 500,00 руб.<br>В том числе НДС: 24 073,77 руб.</p>`

  it('скан и счёт 1С, отвергнутые прежним чтением, читаются заново сами: цены — к позициям; пароль заново не читаем', { timeout: 280000 }, async () => {
    const dataUrl = (buffer) => `data:application/octet-stream;base64,${Buffer.from(buffer).toString('base64')}`
    const scan = await invoiceJpeg(browser, SCAN_INVOICE, { skew: 0.4 })
    const init = {
      fn: (files) => { window.__fakeFiles = files },
      arg: {
        'tenders/tender-p/scan.pdf': dataUrl(jpegPdf(scan)),
        'tenders/tender-p/1c.xls': dataUrl(oneCBook()),
      },
    }
    const { page, context, errors } = await openPage('&supplyRejected=1', { init })
    try {
      const notesOf = (id) => page.evaluate((x) => window.__fakeDb.s3_documents.find((d) => d.id === x).notes, id)
      await page.waitForFunction(() => JSON.parse(window.__fakeDb.s3_documents.find((d) => d.id === 'doc-1c').notes).lines.length > 0, null, { timeout: 60000 })
      const book = JSON.parse(await notesOf('doc-1c'))
      assert.equal(book.rv, 2)
      assert.equal(book.date, '2026-11-02')
      assert.deepEqual(book.lines.map((l) => [l.n, l.u, l.p]), [['Хомут монтажный (75)', 'упак', 737.25]])

      await page.waitForFunction(() => JSON.parse(window.__fakeDb.s3_documents.find((d) => d.id === 'doc-scan').notes).lines.length > 0, null, { timeout: 240000 })
      const read = JSON.parse(await notesOf('doc-scan'))
      assert.equal(read.ocr, true)
      assert.equal(read.rv, 2)
      assert.equal(read.date, '2026-11-02')
      assert.equal(read.total?.ok, true, 'итог сошёлся')
      const lines = read.lines.map((l) => [l.n.replace(/\s+/g, ' '), l.u, l.q, l.p, l.un ?? 0])
      assert.deepEqual(lines.map((l) => l.slice(1)), [['шт', 48, 512.5, 0], ['м', 1100, 99, 0]], 'цифры прочитаны верно и сошлись между собой')
      assert.match(lines[0][0], /Кран шаровой Ду15/)
      assert.match(JSON.parse(await notesOf('doc-pass')).failed, /encrypted/, 'пароль от версии чтения не зависит')

      // В окне: файл со скана помечен, цены стоят у своих позиций и отмечены сами.
      const docs = await openTenderDocs(page)
      await fileChips(docs).locator('li', { hasText: 'Скан счёта.pdf' }).getByText('со скана, итог сошёлся').waitFor()
      const row = docs.locator('tr', { hasText: 'Кран шаровой Ду15' }).first()
      await row.getByText('512,50').waitFor()
      assert.equal(await row.locator('input[type=checkbox]').isChecked(), true)
      // Цена за упаковку: «(75)» в наименовании, упак → шт.
      const pack = docs.locator('tr', { hasText: 'Хомут монтажный' }).first()
      await pack.getByText('1 упак = 75 шт').waitFor()
      await pack.getByText('9,83').waitFor()
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('автовыбор: то же наименование важнее дешёвого похожего, из двух одинаковых — самый свежий документ; другая строка — выбор человека; снятая отметка — цена не тронута', async () => {
    const { page, context, errors } = await openPage()
    try {
      const docs = await openTenderDocs(page)
      await docs.locator('input[type=file]').setInputFiles([
        { name: 'Счёт 15 ТеплоСнаб.xlsx', mimeType: XLSX_MIME, buffer: supplierXlsx() },
        { name: 'КП 3 Климат-Опт.xlsx', mimeType: XLSX_MIME, buffer: supplierXlsx2() },
      ])
      await fileChips(docs).locator('.sp-td-file', { hasText: 'КП 3 Климат-Опт.xlsx' }).waitFor({ timeout: 60000 })
      await fileChips(docs).locator('.sp-td-file', { hasText: 'Счёт 15 ТеплоСнаб.xlsx' }).waitFor({ timeout: 60000 })
      const rowOfPick = (text) => docs.locator('.sp-td-table tbody tr').filter({ has: page.locator('b.sp-td-name', { hasText: text }) })
      // Кран: 513,46 с тем же наименованием важнее 500 похожего; выбор можно поменять.
      const kran = rowOfPick('Кран шаровой Ду15')
      await kran.waitFor()
      assert.equal(plain(await kran.locator('.sp-td-price').innerText()), '513,46')
      assert.match(await kran.locator('.sp-td-line .sp-td-file').innerText(), /Счёт 15 ТеплоСнаб\.xlsx/)
      await kran.getByRole('button', { name: 'другая строка' }).click()
      await kran.locator('.sp-td-opt', { hasText: 'КП 3 Климат-Опт.xlsx' }).click()
      await page.waitForFunction(() => /500,00/.test(document.querySelector('.sp-td-table')?.innerText || ''))
      assert.equal(plain(await kran.locator('.sp-td-price').innerText()), '500,00')
      // Изоляция: свою цену заменит документ — отметку можно снять.
      const iso = rowOfPick('Изоляция K-Flex')
      assert.match(await iso.locator('.sp-td-now.is-replace').innerText(), /96,00/)
      await applyBox(iso).uncheck()

      await docs.getByRole('button', { name: /^Применить цены:/ }).click()
      await docs.waitFor({ state: 'detached', timeout: 30000 })
      await page.getByText('Цен записано:', { exact: false }).waitFor()
      await page.waitForFunction(() => window.__fakeDb.tender_supply_links.some((l) => l.material_name === 'Кран шаровой Ду15'))
      assert.equal((await rateOf(page, 'Кран шаровой Ду15', 'ОВ')).supply_price, 500)
      assert.equal((await rateOf(page, 'Изоляция K-Flex 13×15', 'ОВ')).supply_price, 96, 'своя цена не тронута')
      const docId = (name) => page.evaluate((n) => window.__fakeDb.s3_documents.find((d) => d.file_name === n).id, name)
      const linkOf = (name) => page.evaluate((n) => window.__fakeDb.tender_supply_links.find((l) => l.material_name === n)?.s3_document_id, name)
      assert.equal(await linkOf('Кран шаровой Ду15'), await docId('КП 3 Климат-Опт.xlsx'))
      // Выбор помнится при файле: при следующем открытии у крана ничего не предлагается.
      const again = await openTenderDocs(page)
      assert.equal(await again.locator('.sp-td-table tbody tr', { has: page.locator('b.sp-td-name', { hasText: 'Кран шаровой Ду15' }) }).count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('цена за упаковку, введённая руками: подсказка в строке и «исправить» — цена за единицу', async () => {
    const { page, context, errors } = await openPage()
    try {
      const docs = await openTenderDocs(page)
      await docs.locator('input[type=file]').setInputFiles({ name: 'Спецификация ЭТМ.xlsx', mimeType: XLSX_MIME, buffer: packXlsx() })
      await fileChips(docs).locator('.sp-td-file', { hasText: 'Спецификация ЭТМ.xlsx' }).waitFor({ timeout: 60000 })
      await closeTenderDocs(page)
      // Новые цены из документов — числом на кнопке окна.
      await page.getByRole('button', { name: /^Счета и КП \(1\) · новых цен: \d+/ }).waitFor()
      await enter(page.getByLabel(price('Хомут монтажный', 'ОВ')), '500')
      const row = rowOf(page, 'Хомут монтажный', 'ОВ')
      await row.getByText('Похоже, это цена за упак (50 шт): за шт — 10,00 ₽.', { exact: false }).waitFor({ timeout: 30000 })
      await row.getByRole('button', { name: 'исправить' }).click()
      await page.waitForFunction(() => Number(window.__fakeDb.tender_vor_supply_rates.find((r) => r.material_name === 'Хомут монтажный')?.supply_price) === 10)
      await row.getByText('Похоже, это цена за', { exact: false }).waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('та же позиция в другом тендере с другой ед. изм.: сама не подставляется, в похожих — с пометкой; взять с пересчётом или как есть', async () => {
    const { page, context, errors } = await openPage('&otherUnit=1')
    try {
      const row = rowOf(page, 'Хомут монтажный', 'ОВ')
      const btn = row.locator('.sp-similar-btn')
      await btn.waitFor({ timeout: 30000 })
      assert.equal(plain(await btn.innerText()), 'похожиецены:1')
      assert.equal(await page.evaluate(() => window.__fakeDb.tender_vor_supply_rates.filter((r) => r.material_name === 'Хомут монтажный' && r.tender_id === 'tender-p').length), 0, 'сама не подставилась')
      await btn.click()
      const menu = page.getByRole('dialog', { name: 'Похожие цены: Хомут монтажный' })
      const item = menu.getByRole('list', { name: 'Цены в другой ед. изм.' }).locator('li')
      await item.getByText('другая ед. изм.: цена за тыс. шт, здесь шт').waitFor()
      await item.getByText('тендер № 845').waitFor()
      await item.getByText('Пересчёт: 1 тыс. шт = 1000 шт', { exact: false }).waitFor()
      await item.getByRole('button', { name: /^Взять цену 10,00 ₽ за шт/ }).click()
      await page.waitForFunction(() => Number(window.__fakeDb.tender_vor_supply_rates.find((r) => r.material_name === 'Хомут монтажный' && r.tender_id === 'tender-p')?.supply_price) === 10)
      await btn.waitFor({ state: 'detached' })
      assert.equal((await rateOf(page, 'Хомут монтажный', 'ОВ')).source_rate_id ?? null, null, 'пересчитанная — своя цена')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('ВОР обновлён: что изменилось — в шапке и строках; цена убранной позиции — перенести по согласию; ед. изм. — подтвердить; «просмотрено»', async () => {
    const { page, context, errors } = await openPage('&vorChanges=1')
    try {
      await page.getByText('Сметный отдел обновил ВОР: «ОВ»', { exact: false }).waitFor()
      await page.getByText('файл «ВОР_ОВ.xlsx» заменён новым: новых 1 · убрано 1 (с ценой 1) · объём 1 · ед. изм. 1', { exact: false }).waitFor()
      await page.getByText('загрузил(а) Сметов С. С.', { exact: false }).first().waitFor()
      // Строки: новая позиция, объём «было», ед. изм. «была», цена за другую единицу.
      await rowOf(page, 'Хомут монтажный', 'ОВ').getByText('новая позиция в ВОР').waitFor()
      assert.match(await rowOf(page, 'Хомут монтажный', 'ОВ').getAttribute('class'), /is-new/)
      const kran = rowOf(page, 'Кран шаровой Ду15', 'ОВ')
      await kran.getByText('объём изменился — было 40').waitFor()
      assert.match(await kran.getAttribute('class'), /is-changed/)
      await rowOf(page, 'Изоляция K-Flex 13×15', 'ОВ').getByText('ед. изм. изменилась — была «м2»').waitFor()
      assert.equal(await rowOf(page, 'Изоляция K-Flex 13×15', 'ОВ').locator('s.sp-was').innerText(), 'м2')
      await kran.getByText('цена — за «компл», а в ВОР теперь «шт»', { exact: false }).waitFor()
      // Фильтр «Изменения ВОР»: только изменённые строки и предложения перенести цену.
      await page.getByRole('button', { name: 'Изменения ВОР (4)' }).click()
      assert.equal(await page.getByLabel(price('Кран шаровой Ду15', 'ВК')).count(), 0, 'неизменённые скрыты')
      await rowOf(page, TRUBA, TWO).waitFor()
      await page.getByRole('button', { name: /^Все \(/ }).click()

      // Цена убранной «трубы (бухта)» сама на «трубу» не перешла — предложение перенести.
      assert.equal(await rateOf(page, 'Труба медная Ø12,7', 'ОВ'), null)
      const pipe = rowOf(page, TRUBA, TWO)
      await pipe.getByText('похоже на убранную из ВОР «Труба медная Ø12,7 (бухта)»', { exact: false }).waitFor()
      await pipe.getByRole('button', { name: `Перенести цену «Труба медная Ø12,7 (бухта)» на «${TRUBA}»` }).click()
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.find((r) => r.id === 'rate-p-old')?.material_name === 'Труба медная Ø12,7')
      await page.waitForFunction((l) => /950,00/.test(document.querySelector(`[aria-label="${l}"]`)?.value || ''), price(TRUBA, TWO))
      await page.getByText('перенесена на «Труба медная Ø12,7»', { exact: false }).waitFor()
      // Цена перенесена на позицию одного ВОР — строка говорит, что не во всех.
      await pipe.getByText('цена не во всех ВОР', { exact: false }).waitFor()
      assert.equal(await page.locator('.sp-orphans').count(), 0, 'цен без позиции не осталось')
      assert.equal((await rateOf(page, 'Труба медная Ø12,7', 'ОВ')).id, 'rate-p-old', 'та же строка цены')

      // Кран: цена верна и за «шт».
      await kran.getByRole('button', { name: 'цена верна за «шт»' }).click()
      await page.waitForFunction(() => window.__fakeDb.tender_vor_supply_rates.find((r) => r.id === 'rate-p-kran').unit === 'шт')
      await kran.getByText('цена — за «компл»', { exact: false }).waitFor({ state: 'detached' })

      // История версий: что изменилось и цены до изменения.
      await page.getByRole('button', { name: 'Версии ВОР' }).click()
      const dialog = page.getByRole('dialog', { name: 'Версии ВОР' })
      await dialog.getByRole('button', { name: /ВОР «ОВ».*ВОР обновлён/ }).click()
      await dialog.getByText('Цены ВОР до изменения: 3', { exact: false }).waitFor()
      await dialog.getByRole('cell', { name: 'Труба медная Ø12,7 (бухта)' }).first().waitFor()
      await dialog.getByRole('button', { name: 'Закрыть' }).click()

      // Просмотрено: подсветка и уведомление уходят, версия — в истории.
      await page.getByRole('button', { name: 'изменения просмотрены', exact: true }).click()
      await page.waitForFunction(() => window.__fakeDb.tender_supply_revisions.find((r) => r.id === 7).reviewed_at)
      await page.getByText('Сметный отдел обновил ВОР', { exact: false }).waitFor({ state: 'detached' })
      assert.equal(await page.getByText('новая позиция в ВОР').count(), 0)
      const rpc = await page.evaluate(() => window.__supabaseStats.requests.filter((r) => r.op === 'rpc').map((r) => [r.table, r.args]))
      assert.deepEqual(rpc.find(([t]) => t === 'rpc:supply_revisions_review')[1], { p_tender: 'tender-p', p_ids: [7] })
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('новый файл ВОР с другим именем: спросить «новая версия или отдельный ВОР»; «да» — после окна с последствиями', async () => {
    const { page, context, errors } = await openPage('&vorQuestion=1')
    try {
      const q = page.locator('.sp-version-q')
      await q.getByText('Новый файл ВОР «ВОР_ОВ изм.1.xlsx» — это новая версия ВОР «ОВ»?', { exact: false }).waitFor()
      assert.match(plain(await q.innerText()), /Совпадаетматериалов:2из4·файлпрежнегоВОРудалён/)
      await q.getByRole('button', { name: 'Да, новая версия' }).click()
      const dialog = page.getByRole('dialog', { name: 'Новая версия ВОР «ОВ»' })
      await dialog.getByText('позиций было 4, станет 3', { exact: false }).waitFor()
      await dialog.getByText('Цена останется сама у позиций с тем же наименованием: 0', { exact: false }).waitFor()
      await dialog.getByText('позиции с ценой наименования в новом файле нет', { exact: false }).waitFor()
      assert.match(plain(await dialog.innerText()), /У1позициисценой/)
      await dialog.getByRole('button', { name: 'Да, это новая версия' }).click()
      await page.waitForFunction(() => !window.__fakeDb.tender_supply_sources.some((s) => s.estimate_name === 'ВОР_ОВ изм.1'))
      await q.first().waitFor({ state: 'detached' })
      assert.match(await (await openVors(page)).locator('.sp-vor-line', { hasText: 'ВОР «ОВ»' }).getAttribute('title'), /файл «ВОР_ОВ изм\.1\.xlsx», лист «Материалы»/)
      const rpc = await page.evaluate(() => window.__supabaseStats.requests.filter((r) => r.table === 'rpc:supply_vor_adopt').map((r) => r.args))
      assert.deepEqual(rpc, [{ p_tender: 'tender-p', p_new: 'ВОР_ОВ изм.1', p_old: 'ОВ' }])
      await page.getByText('ВОР «ОВ» — новая версия из файла «ВОР_ОВ изм.1.xlsx»', { exact: false }).waitFor()
      // Изоляции в новом файле нет — её цена в «Ценах без позиции», с переносом по согласию.
      await page.locator('.sp-orphans').getByText('Изоляция K-Flex 13×15', { exact: false }).waitFor()
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
    // «Нет, отдельный ВОР» — ответ запоминается в базе, вопрос уходит.
    const second = await openPage('&vorQuestion=1')
    try {
      await second.page.locator('.sp-version-q').getByRole('button', { name: 'Нет, отдельный ВОР' }).click()
      await second.page.waitForFunction(() => window.__fakeDb.tender_supply_sources.find((s) => s.id === 'src-p3').separate_at)
      await second.page.locator('.sp-version-q').waitFor({ state: 'detached' })
      assert.equal(await second.page.evaluate(() => window.__fakeDb.tender_supply_sources.length), 3, 'оба ВОР остались')
      assert.deepEqual(second.errors, [])
    } finally {
      await second.context.close()
    }
  })

  it('реестр тендеров на материалы: «ВОР изменён», пока снабжение не посмотрело изменения', async () => {
    const { page, context, errors } = await open('&matTenders=1&vorChanges=1', '/tenders/materials')
    try {
      const link = page.locator('a.tp-pricing-link[href$="/tenders/materials/mat-1/pricing"]')
      await link.getByText('ВОР изменён').waitFor({ timeout: 120000 })
      assert.match(await link.getAttribute('title'), /ВОР «ВОР ЭОМ»: добавлен ВОР из файла «ВОР ЭОМ\.xlsx»: позиций 12/)
      assert.equal(await page.locator('a.tp-pricing-link[href$="/tenders/materials/mat-2/pricing"]').getByText('ВОР изменён').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('таблицы версий ВОР нет (миграция 20261029 не применена) — расценка работает как раньше', async () => {
    const { page, context, errors } = await openPage('&noVersions=1')
    try {
      await vors(page, 'ВОРы тендера: 2').waitFor()
      assert.equal(await page.getByRole('button', { name: 'Версии ВОР' }).count(), 0)
      assert.equal(await page.locator('.sp-version-q, .sp-rev-banner').count(), 0)
      await pricedCount(page, 1, 5)
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
