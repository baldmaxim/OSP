// Кабинет подрядчика в браузере (миграция 20261102, стенд tests/tender/ui/cabinet.html, данные в памяти):
//   • реестр как у сотрудника («Тендеры — Основное строительство»), только идущие тендеры: № , объект, описание, участие,
//     сроки, ответственный, пакет, кнопка «Открыть тендер»; прошлых тендеров и раздела договоров нет;
//   • открытый тендер без заявки: файлов и расценки нет, «Участвовать и расценить» — заявка, затем файл ВОР
//     скачивается и разбирается: «Материалы» и «Работы» — по листам, «Структура КП» — по листу «КП»;
//   • цена пишется сама (bid_rates_save) — с ключами позиции и объёмом; сумма и итоги пересчитываются;
//   • «Цены из файла»: свой прайс сопоставляется с позициями, цены ставятся с отметкой «из файла»;
//   • анкета — поля из списка администратора (скрытого нет), ответ пишется при уходе из поля; ставка НДС — выбор из
//     списка (22, 7, 5, 0 %; 20 %, 10 % и «Без НДС» убраны 23.10.2026): пока не выбрана — «не указана» в итогах,
//     выбрана — «в т. ч. НДС» по этой ставке;
//   • «Особые условия» с «Главного листа» файла ВОР — над вкладками;
//   • администратор: реестр расценок → «Расценки подрядчиков (актуальные тендеры)» — сводка без завершённых
//     тендеров, подробности организации, позиции списком, поля анкеты.
//   • решения пользователя 24.11.2026 (миграция 20270301): расценка на сайте — основной путь, по каждой ведомости сразу (сводка по ВОР,
//     не расценённое — жёлтым), что изменилось в ВОР (стенд ?vorChanges=1, ?heldVor=1), цены снабжения с разрешения отдела (?supply=…),
//     блок инженера «Подрядчики на сайте: цены снабжения»;
//   • решение пользователя 25.11.2026 (миграция 20270302): у взятой цены снабжения — «счёт» поставщика этой позиции (своя цена — счёта
//     нет); с просьбы пользователя 25.11.2026 — своя колонка «Счёт» рядом с «Ценой СУ-10» и окно просмотра (ссылка службы «показать»,
//     в просмотре от имени подрядчика — обычный путь файлов, счёт и у цены, взятой в черновике, 20270305); прошлые цены — одним
//     запросом по ключам позиций тендера (без функции — как раньше);
//   • решения пользователя 11.11.2026 (стенд ?bidFiles=1 — миграция 20270113): файлы ВОР — только в расценке, РД — свёрнута, шаблонов
//     нет; свои файлы с расценками, загруженные тогда, — списком для скачивания (новых не принимаем: файл с ценами расценивает сайт).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { bidItemKey, bidUnitKey } from '../../src/utils/bidPrice.js'

const launch = browserLaunchOptions()

describe('Кабинет подрядчика: расценка на сайте', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  // init — скрипт до загрузки стенда (page.addInitScript): например, свои данные поверх cabinet-seed.js.
  async function open(query = '', viewport = { width: 1500, height: 950 }, { init = null } = {}) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
    page.on('dialog', (d) => d.accept())
    if (init) await page.addInitScript(init)
    await page.goto(`${stand.url.replace('index.html', 'cabinet.html')}?latency=0${query}`)
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const calls = (page, fn) => page.evaluate((name) => window.__bidCalls.filter((c) => c.fn === name), fn)
  const openTender = async (page, num) => {
    await page.getByRole('link', { name: `Открыть тендер № ${num}` }).click()
    await page.locator('.cab-head-block').waitFor({ timeout: 60000 })
  }

  it('заявка → файл ВОР → материалы, работы и структура КП; цена пишется сама, итоги пересчитываются', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('table.tenders-registry').waitFor({ timeout: 120000 })
      await openTender(page, 857)
      const head = page.locator('.cab-head-block')
      await head.getByText('Иванов Иван Иванович').waitFor()
      assert.equal(await head.locator('a[href^="tel:"]').getAttribute('href'), 'tel:+77010000000')
      assert.equal(await page.locator('.bid-ws').count(), 0, 'без заявки расценки нет')
      assert.equal(await page.locator('.cab-docs').count(), 0, 'без заявки файлов нет')

      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      await page.locator('.cab-note', { hasText: 'Заявка подана' }).waitFor()
      assert.equal((await calls(page, 'bid_request')).length, 1)
      await page.getByRole('button', { name: 'Исходный ВОР «ВОР паркинга.xlsx»' }).waitFor({ timeout: 30000 })
      assert.equal(await page.locator('.cab-doc-name', { hasText: 'ВОР паркинга.xlsx' }).count(), 0, 'ВОР — только в расценке, в документах второго нет')

      const tab = (name) => page.locator('.bid-tab', { hasText: name })
      await tab('Материалы').locator('.bid-tab-count', { hasText: '2' }).waitFor({ timeout: 30000 })
      assert.equal(await tab('Работы').locator('.bid-tab-count').textContent(), '2')

      const concrete = page.locator('.bid-table tbody tr', { hasText: 'Бетон В25 W8' })
      assert.match(await concrete.locator('.bid-col-vol').textContent(), /130,5/)
      await concrete.locator('.bid-money-input').fill('7800,5')
      await concrete.locator('.bid-money-input').press('Enter')
      await page.locator('.bid-save', { hasText: 'Все цены сохранены' }).waitFor({ timeout: 10000 })
      const saves = await calls(page, 'bid_rates_save')
      assert.equal(saves.length, 1)
      const row = saves[0].rows[0]
      assert.equal(row.kind, 'material')
      assert.equal(row.name, 'Бетон В25 W8')
      assert.equal(row.volume, 130.5)
      assert.equal(row.price, 7800.5)
      assert.equal(row.source, 'manual')
      assert.ok(row.key && row.unit_key === 'м3', JSON.stringify(row))
      assert.match(await concrete.locator('.bid-col-sum').textContent(), /1\s017\s965,25/)
      assert.match(await text(page.locator('.bid-vs-total .bid-vs-line').nth(0)), /1 017 965,25 1 из 2/, 'итог — один раз, строкой «ИТОГО по всем ВОР»')
      assert.equal(await page.locator('.bid-sum-cell', { hasText: 'Материалы' }).count(), 0, 'над сводкой сумм не дублируем')

      await tab('Структура КП').click()
      const kp = page.locator('.bid-kp-table')
      await kp.waitFor()
      const section = kp.locator('tr.bid-kp-section', { hasText: 'Плита паркинга' })
      assert.match(await section.textContent(), /939\s960,25/, 'материалы раздела: 7800,5 × 120,5')
      assert.ok(await kp.locator('tr', { hasText: 'Армирование плиты' }).locator('td', { hasText: 'нет цены' }).count() > 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('отдел обновил ВОР, пока страница открыта: позиции нет — остальные цены записаны, она из очереди ушла, без повторов по кругу', async () => {
    const { page, errors, close } = await open()
    try {
      await openTender(page, 857)
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      const concrete = page.locator('.bid-table tbody tr', { hasText: 'Бетон В25 W8' })
      await concrete.waitFor({ timeout: 60000 })
      // Как bid_rates_save после замены ведомости: арматуры в ВОР больше нет — отказ всей порции.
      await page.evaluate(() => {
        const real = window.__fakeRpc.bid_rates_save
        window.__fakeRpc.bid_rates_save = (args) => (args.p_rows.some((r) => /Арматура/.test(r.name))
          ? (window.__bidCalls.push({ fn: 'bid_rates_save', p_tender: args.p_tender, rows: args.p_rows, failed: true }),
            { data: null, error: { code: '22023', message: 'Позиции нет в ВОР этого тендера — обновите страницу' } })
          : real(args))
      })
      const rebar = page.locator('.bid-table tbody tr', { hasText: 'Арматура А500С d12' })
      await concrete.locator('.bid-money-input').fill('7800')
      await concrete.locator('.bid-money-input').press('Enter')
      await rebar.locator('.bid-money-input').fill('90000')
      await rebar.locator('.bid-money-input').press('Enter')
      await page.locator('.bid-save', { hasText: 'Остальные цены сохранены' }).waitFor({ timeout: 10000 })
      assert.match(await text(page.locator('.bid-save')), /не записано 1 поз\. \(«Арматура А500С d12»\): их нет в актуальной ВОР/)
      const before = (await calls(page, 'bid_rates_save')).length
      assert.ok(before >= 2 && before <= 4, `деление порции: ${before} вызова`)
      assert.ok((await calls(page, 'bid_rates_save')).some((c) => !c.failed && c.rows.some((r) => r.name === 'Бетон В25 W8')), 'бетон записан')
      await page.waitForTimeout(2000)
      assert.equal((await calls(page, 'bid_rates_save')).length, before, 'без повторов по кругу')
      assert.deepEqual(errors.filter((m) => !/Позиции нет/.test(m)), [])
    } finally {
      await close()
    }
  })

  it('реестр: идёт ли тендер — по статусу, а не по сроку; № по центру; от чего отказались — нет; пакет и ответственный на месте', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('table.tenders-registry').waitFor({ timeout: 120000 })
      assert.equal(await page.getByRole('link', { name: 'Открыть тендер № 910' }).count(), 0, 'организация отказалась — тендера нет')
      const row = (num) => page.locator('table.tenders-registry tbody tr', { has: page.getByRole('link', { name: `Открыть тендер № ${num}` }) })

      // Срок прошёл, статус тот же: это идущий тендер — без красного и без «просрочено».
      const late = row(911)
      assert.doesNotMatch(await late.getAttribute('class') || '', /overdue/)
      assert.equal(await late.locator('.is-overdue').count(), 0)
      assert.equal(await page.locator('table.tenders-registry tbody tr').count(), 3)
      assert.equal(await page.locator('table.tenders-registry tbody .cab-chip.is-accent', { hasText: 'Идёт тендерная процедура' }).count(), 3)

      assert.equal(await row(857).locator('a', { hasText: 'Открыть' }).first().getAttribute('href'), 'https://disk.example.ru/pack')
      assert.match(await row(857).textContent(), /\+7 701 000-00-00/)

      const align = (sel) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).textAlign)
      assert.equal(await align('table.tenders-registry thead th.cab-th-num'), 'center')
      assert.equal(await align('table.tenders-registry tbody td.tp-num'), 'center')

      // Тот же тендер открыт: пакет — кнопкой, о просрочке ни слова.
      await openTender(page, 911)
      const head = page.locator('.cab-head-block')
      assert.equal(await head.getByRole('link', { name: 'Тендерный пакет' }).getAttribute('href'), 'https://disk.example.ru/late')
      assert.match(await head.textContent(), /Идёт тендерная процедура/)
      assert.doesNotMatch(await head.textContent(), /истёк/)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('файл ВОР — кнопкой у ведомости; шаблона КП и «Шаблона Excel» нет; «Состава работ» рядом с расценкой нет; отказ убирает тендер', async () => {
    const { page, errors, close } = await open('&legacyItems=1')
    try {
      await openTender(page, 905)
      const vorBtn = page.getByRole('button', { name: 'Исходный ВОР «ВОР фасада.xlsx»' })
      await vorBtn.waitFor({ timeout: 60000 })
      const [saved] = await Promise.all([page.waitForEvent('download'), vorBtn.click()])
      assert.equal(saved.suggestedFilename(), 'ВОР фасада.xlsx')
      // Решение пользователя 24.11.2026: файл — не основной путь, «Исходный ВОР» (с 25.11.2026; было «ВОР») — кнопка у ведомости в сводке.
      assert.match(await vorBtn.getAttribute('class'), /bid-dl is-source/)
      // Решение пользователя 11.11.2026: шаблонов нет, даже если смета во вкладке «ВОР» есть.
      await page.locator('.cab-section h3', { hasText: 'Расценка' }).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Скачать шаблон' }).count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Шаблон Excel' }).count(), 0)
      assert.equal(await page.locator('.cab-section h3', { hasText: 'Коммерческое предложение по шаблону' }).count(), 0)
      assert.equal(await page.locator('.cab-section h3', { hasText: 'Состав работ' }).count(), 0)

      await page.getByRole('button', { name: 'Отказаться от участия' }).click()
      await page.locator('table.tenders-registry').waitFor()
      assert.deepEqual(await calls(page, 'contractor_set_participation'), [{ fn: 'contractor_set_participation', p_tender: 't-inv', p_status: 'declined' }])
      assert.equal(await page.getByRole('link', { name: 'Открыть тендер № 905' }).count(), 0, 'после отказа тендера в кабинете нет')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  // Заполненный ВОР стенда (тот же, что отдел даёт подрядчику): цены за единицу на листах «Материалы» и «Работы».
  function pricedVor({ concrete, rebar, slab, reinforce = '' }) {
    const wb = XLSX.utils.book_new()
    const add = (name, aoa) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
    add('Главный лист', [['', 'Особые условия, которые необходимо учесть'], ['', 'ГУ в размере 5 % (Пять процентов)']])
    add('Материалы', [
      ['№ п/п', 'Наименование', 'Ед. изм.', 'Объём', 'Цена за ед. с доставкой и НДС', 'Итого'],
      [1, 'Бетон В25 W8', 'м3', 130.5, concrete, ''],
      [2, 'Арматура А500С d12', 'т', 3.25, rebar, ''],
    ])
    add('Работы', [
      ['№ п/п', 'Наименование', 'Ед. изм.', 'Объём', 'Цена за ед. с НДС', 'Итого'],
      [1, 'Устройство монолитной плиты', 'м3', 130.5, slab, ''],
      [2, 'Армирование плиты', 'т', 3.25, reinforce, ''],
    ])
    return { name: 'ВОР с расценками.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })) }
  }
  const text = (loc) => loc.evaluate((el) => el.innerText.replace(/\s+/g, ' ').trim())

  // Решение пользователя 24.11.2026: расценка на сайте — основной путь, по каждой ведомости сразу, как только есть доступ; не расценённое —
  // жёлтым, как в «Сравнении КП»; позиции — с сервера (книгу не скачиваем), файл, который служба не разобрала, — в браузере.
  it('расценка по ведомостям сразу: сводка по ВОР с суммами, неполное — жёлтым, строка выбирает ведомость; позиции с сервера', async () => {
    const { page, errors, close } = await open('&bidFiles=1')
    try {
      await page.locator('table.tenders-registry').waitFor({ timeout: 120000 })
      const before = await page.evaluate(() => window.__supabaseStats.requests.length)
      await openTender(page, 857)
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      const summary = page.locator('.bid-vs-wrap')
      await summary.waitFor({ timeout: 60000 })
      await summary.locator('li.bid-vs-row', { hasText: 'ВОР корпус 2' }).waitFor({ timeout: 60000 })
      assert.deepEqual(await summary.locator('li.bid-vs-row .bid-vs-pick').allTextContents(), ['ВОР корпус 2', 'ВОР паркинга'], 'ведомости — по имени')
      // Меньше пяти ведомостей — плитки растягиваются на весь ряд (две — по половине).
      const widths = await summary.locator('li.bid-vs-row').evaluateAll((els) => els.map((e) => {
        const r = e.getBoundingClientRect()
        return { top: r.top, width: r.width }
      }))
      assert.equal(Math.round(widths[0].top), Math.round(widths[1].top), 'две плитки — в одном ряду')
      assert.ok(widths[0].width > (await summary.locator('ul.bid-vs').evaluate((e) => e.clientWidth)) / 3, 'плитки растянуты на ряд')
      // Ничего не расценено — всё выделено: строки таблицы, суммы плиток и итог.
      assert.equal(await summary.locator('.bid-vs-line.is-incomplete').count(), 9)
      await page.locator('.bid-tab', { hasText: 'Материалы' }).locator('.bid-tab-missing', { hasText: 'без цены 2' }).waitFor()
      assert.equal(await page.locator('.bid-table tbody tr.is-unpriced').count(), 2)
      const bg = await page.locator('.bid-table tbody tr.is-unpriced .bid-col-price').first().evaluate((el) => getComputedStyle(el).backgroundColor)
      assert.match(bg, /rgb\(251, 241, 223\)/, 'не расценено — мягким тёплым тоном (25.11.2026: прежний жёлтый пользователь счёл токсичным)')

      // Цена бетона — одна на тендер, суммы — по каждой ведомости (130,5 м3 в каждой).
      const concrete = page.locator('.bid-table tbody tr', { hasText: 'Бетон В25 W8' })
      assert.match(await concrete.locator('.bid-col-vol').textContent(), /261/, 'все ВОР — объём суммой')
      await concrete.locator('.bid-money-input').fill('7800')
      await concrete.locator('.bid-money-input').press('Enter')
      await page.locator('.bid-save', { hasText: 'Все цены сохранены' }).waitFor({ timeout: 10000 })
      const row = (name) => summary.locator('li.bid-vs-row', { hasText: name })
      assert.match(await text(row('ВОР паркинга').locator('.bid-vs-line').nth(0)), /1 017 900,00 1 из 2/)
      assert.match(await text(summary.locator('.bid-vs-total .bid-vs-line').nth(0)), /2 035 800,00 1 из 2/)
      assert.equal(await page.locator('.bid-table tbody tr.is-priced').count(), 1)

      // Плитка сводки — ведомость таблицы: объём и сумма — по ней.
      await row('ВОР паркинга').locator('.bid-vs-pick').click()
      assert.equal(await row('ВОР паркинга').getAttribute('class'), 'bid-vs-row is-selected')
      assert.match(await concrete.locator('.bid-col-vol').textContent(), /130,5/)
      assert.match(await concrete.locator('.bid-col-sum').textContent(), /1\s017\s900,00/)
      assert.equal(await page.locator('.bid-select').inputValue(), 'doc-vor')
      await page.locator('.bid-select').selectOption('')
      assert.equal(await row('ВОР паркинга').getAttribute('class'), 'bid-vs-row')

      // Скачать ВОР отдела — у ведомости; «ВОР паркинга» пришёл с сервера (не скачивался), корпус 2 служба не разобрала — разбор в браузере.
      const [saved] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Исходный ВОР «ВОР корпус 2.xlsx»' }).click()])
      assert.equal(saved.suggestedFilename(), 'ВОР корпус 2.xlsx')
      const reqs = await page.evaluate((n) => window.__supabaseStats.requests.slice(n).map((r) => r.table), before)
      assert.ok(reqs.includes('rpc:bid_positions'))
      assert.equal(await page.locator('.bid-pairs, .bid-files').count(), 0, 'своего ВОР рядом с ведомостью больше нет')
      assert.equal(await page.locator('.cab-doc-name', { hasText: 'ВОР паркинга.xlsx' }).count(), 0, 'ВОР — только в расценке')
      assert.equal(await page.locator('.cab-docs-fold summary', { hasText: 'Рабочая документация' }).count(), 1)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('что изменилось в ВОР: отметки в строках и в сводке, убранное — списком, цену можно перенести; неподтверждённая версия — не в расценке', async () => {
    const { page, errors, close } = await open('&vorChanges=1&heldVor=1')
    try {
      await openTender(page, 857)
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      const summary = page.locator('.bid-vs-wrap')
      await summary.locator('.bid-vs-badge.is-changed').waitFor({ timeout: 60000 })
      assert.match(await text(summary.locator('.bid-vs-badge.is-changed')), /Отдел обновил ВОР 20\.10\.2026: новых 1 · убрано 1 · изменено 1/)
      // Новая версия, которую отдел не подтвердил: видна, но не расценивается и в итог не входит; позиций не удваивает.
      const held = summary.locator('li.bid-vs-row.is-held')
      await held.waitFor({ timeout: 60000 })
      assert.match(await text(held), /ВОР паркинга изм\.1.*ждёт подтверждения отдела.*не входит в итог/)
      await page.locator('.bid-tab', { hasText: 'Материалы' }).locator('.bid-tab-count', { hasText: '2' }).waitFor()
      const concrete = page.locator('.bid-table tbody tr', { hasText: 'Бетон В25 W8' })
      assert.match(await concrete.locator('.bid-col-vol').textContent(), /130,5/, 'объём только актуальной ведомости')
      assert.match(await text(concrete.locator('.bid-change')), /объём: было 100 м3/)

      await page.locator('.bid-tab', { hasText: 'Работы' }).click()
      assert.match(await text(page.locator('.bid-table tbody tr', { hasText: 'Армирование плиты' }).locator('.bid-change')), /новая/)
      await page.getByLabel('только изменения ВОР').check()
      assert.equal(await page.locator('.bid-table tbody tr').count(), 1)

      // Убранное — списком; своя цена убранной позиции — «перенести» на похожую без цены.
      const removed = page.locator('details.bid-removed', { hasText: 'Убрано из ВОР' })
      assert.match(await text(removed), /Демонтаж опалубки/)
      assert.match(await text(removed), /ваша цена 15 000,00 ₽/)
      await removed.getByRole('button', { name: /перенести на «Армирование плиты, т»/ }).click()
      await page.locator('.bid-save', { hasText: 'Все цены сохранены' }).waitFor({ timeout: 10000 })
      const rows = (await calls(page, 'bid_rates_save')).flatMap((c) => c.rows)
      assert.deepEqual(rows.map((r) => [r.name, r.price]).sort((x, y) => x[0].localeCompare(y[0], 'ru')),
        [['Армирование плиты', 15000], ['Армирование плиты перекрытия', null]], 'цена — на похожую позицию, у убранной — снята')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('цены снабжения: попросить → ждёт отдела; разрешено — колонка «Цена СУ-10», взять для позиций без цены и заменить свою; цену пишет база', async () => {
    let { page, errors, close } = await open('&supply=none')
    try {
      await openTender(page, 857)
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      const bar = page.locator('.bid-supply')
      await bar.waitFor({ timeout: 60000 })
      assert.match(await text(bar), /Отдел может разрешить взять наши цены материалов/)
      await bar.getByRole('button', { name: 'Попросить разрешение' }).click()
      await bar.filter({ hasText: 'ждёт решения отдела' }).waitFor({ timeout: 10000 })
      assert.equal((await calls(page, 'bid_supply_request')).length, 1)
      assert.equal(await page.locator('th', { hasText: 'Цена СУ-10' }).count(), 0, 'без разрешения цен снабжения нет')
      assert.equal((await calls(page, 'bid_supply_prices')).length, 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }

    ;({ page, errors, close } = await open('&supply=granted'))
    try {
      await openTender(page, 857)
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      const bar = page.locator('.bid-supply.is-granted')
      await bar.waitFor({ timeout: 60000 })
      assert.match(await text(bar), /у 1 поз\. материалов/)
      const concrete = page.locator('.bid-table tbody tr', { hasText: 'Бетон В25 W8' })
      await page.locator('th', { hasText: 'Цена СУ-10' }).waitFor()
      assert.match(await text(concrete.locator('.bid-col-supply')), /7 500,00/)

      await bar.getByRole('button', { name: 'Взять для позиций без цены (1)' }).click()
      await concrete.locator('.bid-source', { hasText: 'цена снабжения' }).waitFor({ timeout: 10000 })
      const take = await calls(page, 'bid_supply_take')
      assert.equal(take.length, 1)
      assert.equal(take[0].replace, false)
      assert.equal(take[0].rows[0].price, undefined, 'цену браузер не присылает')
      assert.match(await concrete.locator('.bid-money-input').inputValue(), /^7\s?500(,00)?$/)
      assert.equal(await concrete.locator('.bid-take').count(), 0, 'уже взята — «взять» нет')

      // Своя цена — отметка уходит; «Заменить мои цены» — снова цена снабжения.
      await concrete.locator('.bid-money-input').fill('7000')
      await concrete.locator('.bid-money-input').press('Enter')
      await page.locator('.bid-save', { hasText: 'Все цены сохранены' }).waitFor({ timeout: 10000 })
      assert.equal(await concrete.locator('.bid-source').count(), 0)
      await bar.getByRole('button', { name: 'Заменить мои цены (1)' }).click()
      await concrete.locator('.bid-source', { hasText: 'цена снабжения' }).waitFor({ timeout: 10000 })
      assert.equal((await calls(page, 'bid_supply_take')).at(-1).replace, true)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }

    // Решение пользователя 25.11.2026: у взятой цены снабжения — счёт поставщика; своя цена — счёта нет. Просьба пользователя 25.11.2026
    // «не вижу столбец со счётом и возможностью его посмотреть»: своя колонка «Счёт» рядом с «Ценой СУ-10», кнопка — окно просмотра по
    // ссылке службы «показать»; «Скачать» в окне — ссылкой на скачивание.
    // Скачивание ждём по имени файла: рамка с PDF в браузере без просмотрщика PDF сама может начать скачивание.
    const invoiceDownload = (p) => p.waitForEvent('download', { predicate: (d) => d.suggestedFilename() === 'Счёт ПСК № 072813.pdf' })
    ;({ page, errors, close } = await open('&supply=granted'))
    try {
      await openTender(page, 857)
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      const bar = page.locator('.bid-supply.is-granted')
      await bar.waitFor({ timeout: 60000 })
      const concrete = page.locator('.bid-table tbody tr', { hasText: 'Бетон В25 W8' })
      const invoice = concrete.getByRole('button', { name: 'Счёт снабжения «Счёт ПСК № 072813.pdf»: Бетон В25 W8' })
      const heads = (await page.locator('.bid-table thead th').allTextContents()).map((h) => h.trim())
      assert.equal(heads[heads.indexOf('Цена СУ-10, ₽') + 1], 'Счёт', 'колонка «Счёт» — сразу после «Цены СУ-10»')
      assert.equal(await invoice.count(), 0, 'цену не брали — счёта нет')
      assert.equal(await text(concrete.locator('.bid-col-supdoc')), '—')
      assert.doesNotMatch(await text(bar), /колонке «Счёт»/)

      await bar.getByRole('button', { name: 'Взять для позиций без цены (1)' }).click()
      await invoice.waitFor({ timeout: 10000 })
      assert.equal(await invoice.textContent(), 'счёт')
      assert.equal(await text(concrete.locator('.bid-source')), 'цена снабжения', 'счёт — только в колонке, под ценой его нет')
      assert.match(await text(bar), /У взятой цены в колонке «Счёт»/)
      const docCalls = (await calls(page, 'bid_supply_docs'))
      assert.ok(docCalls.length >= 2, 'счета — вместе с ценами и снова после «взять»')

      await invoice.click()
      const viewer = page.getByRole('dialog', { name: 'Счёт снабжения «Счёт ПСК № 072813.pdf»' })
      const frame = viewer.locator('iframe.s3-doc-modal-frame')
      await frame.waitFor({ timeout: 10000 })
      assert.match(await frame.getAttribute('src'), /^data:application\/pdf/, 'PDF — по ссылке «показать», не из памяти страницы')
      const [saved] = await Promise.all([invoiceDownload(page), viewer.getByRole('button', { name: 'Скачать', exact: true }).click()])
      assert.equal(saved.suggestedFilename(), 'Счёт ПСК № 072813.pdf')
      // Ключа файла у подрядчика нет — ссылки выдаёт служба по id: окну — «показать» (в разработке StrictMode зовёт эффект окна дважды),
      // «Скачать» — одна ссылка на скачивание.
      const svc = await page.evaluate(() => window.__supplyDocCalls)
      assert.ok(svc.every((c) => c.tender_id === 't-open' && c.document_id === 'doc-supply-inv'), JSON.stringify(svc))
      assert.ok(svc.some((c) => c.view === true), 'окно — ссылкой «показать»')
      assert.equal(svc.filter((c) => c.view !== true).length, 1, '«Скачать» — ссылкой на скачивание')
      await page.keyboard.press('Escape')
      assert.equal(await viewer.count(), 0, 'Escape закрывает окно')

      // Своя цена — счёта нет сразу (до перечитывания); снова цена снабжения — счёт снова.
      await concrete.locator('.bid-money-input').fill('7000')
      await concrete.locator('.bid-money-input').press('Enter')
      assert.equal(await invoice.count(), 0)
      await page.locator('.bid-save', { hasText: 'Все цены сохранены' }).waitFor({ timeout: 10000 })
      await concrete.getByRole('button', { name: /Взять цену снабжения/ }).click()
      await invoice.waitFor({ timeout: 10000 })
      assert.equal(await page.locator('.bid-doc-link').count(), 1, 'у работ и у материалов без цены снабжения счетов нет')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }

    // Просмотр от имени подрядчика: счёт виден, окно и скачивание — обычным путём файлов (сотруднику строка файла видна), служба не зовётся.
    ;({ page, errors, close } = await open('&supply=granted&supplyTaken=1&preview=1'))
    try {
      await openTender(page, 857)
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      const invoice = page.getByRole('button', { name: 'Счёт снабжения «Счёт ПСК № 072813.pdf»: Бетон В25 W8' })
      await invoice.waitFor({ timeout: 60000 })
      assert.deepEqual((await calls(page, 'bid_supply_docs')).map((c) => c.p_counterparty), ['cp-alpha'], 'организация просмотра')
      await invoice.click()
      const viewer = page.getByRole('dialog', { name: 'Счёт снабжения «Счёт ПСК № 072813.pdf»' })
      await viewer.locator('iframe.s3-doc-modal-frame').waitFor({ timeout: 10000 })
      const [saved] = await Promise.all([invoiceDownload(page), viewer.getByRole('button', { name: 'Скачать', exact: true }).click()])
      assert.equal(saved.suggestedFilename(), 'Счёт ПСК № 072813.pdf')
      assert.deepEqual(await page.evaluate(() => window.__supplyDocCalls), [])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }

    // Просмотр от имени подрядчика, цена взята в черновике (20270305: база отдаёт администратору счета всех открытых позиций): счёт
    // появляется у взятой цены, как у подрядчика, — а до «взять» его нет, и подсказка та же, что у подрядчика. «Взять» в просмотре есть
    // (кабинет 1 в 1, 25.11.2026; прежняя проверка «в просмотре кнопок нет» была до этого), но в базу ничего не уходит.
    ;({ page, errors, close } = await open('&supply=granted&preview=1'))
    try {
      await openTender(page, 857)
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      const bar = page.locator('.bid-supply.is-granted')
      await bar.waitFor({ timeout: 60000 })
      const invoice = page.getByRole('button', { name: 'Счёт снабжения «Счёт ПСК № 072813.pdf»: Бетон В25 W8' })
      assert.equal(await invoice.count(), 0, 'цену в черновике не брали — счёта нет')
      assert.doesNotMatch(await text(bar), /колонке «Счёт»/)
      await bar.getByRole('button', { name: 'Взять для позиций без цены (1)' }).click()
      await invoice.waitFor({ timeout: 10000 })
      assert.match(await text(bar), /У взятой цены в колонке «Счёт»/)
      assert.equal((await calls(page, 'bid_supply_take')).length, 0, 'черновик просмотра — в базу не пишется')
      assert.equal((await calls(page, 'bid_supply_request')).length, 0)
      await invoice.click()
      await page.getByRole('dialog', { name: 'Счёт снабжения «Счёт ПСК № 072813.pdf»' }).locator('iframe.s3-doc-modal-frame').waitFor({ timeout: 10000 })
      assert.deepEqual(await page.evaluate(() => window.__supplyDocCalls), [])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('прошлые цены: один запрос по ключам позиций тендера (последняя цена, без цен снабжения); без функции — постранично, как раньше', async () => {
    for (const query of ['', '&historyFn=0']) {
      const { page, errors, close } = await open(query)
      try {
        await page.locator('table.tenders-registry').waitFor({ timeout: 120000 })
        // Своя цена арматуры в тендере № 905 (старая и новая) — в подсказку идёт новая; ключ позиции — как у разбора ВОР.
        await page.evaluate(([item, unit, concrete, m3, withSupply]) => {
          const base = { counterparty_id: 'cp-alpha', kind: 'material', item_key: item, unit_key: unit, name: 'Арматура А500С d12', unit: 'т', volume: 1, total: 1, note: null, source: 'manual' }
          window.__fakeDb.tender_bid_rates.push({ ...base, id: 'h-1', tender_id: 't-inv', price: 61000, updated_at: '2026-09-01T00:00:00Z' },
            { ...base, id: 'h-2', tender_id: 't-inv', price: 64000, updated_at: '2026-10-01T00:00:00Z' })
          // Цена бетона, взятая у снабжения в другом тендере, — не своя цена: в подсказку не идёт. Только для функции: прежний путь отбирает
          // это .neq('source', 'supply'), а подделка базы стенда .neq не разбирает.
          if (withSupply) {
            window.__fakeDb.tender_bid_rates.push({ ...base, id: 'h-3', tender_id: 't-inv', item_key: concrete, unit_key: m3, name: 'Бетон В25 W8', unit: 'м3',
              price: 7500, source: 'supply', updated_at: '2026-10-02T00:00:00Z' })
          }
        }, [bidItemKey('Арматура А500С d12'), bidUnitKey('т'), bidItemKey('Бетон В25 W8'), bidUnitKey('м3'), !query])
        await openTender(page, 857)
        await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
        const rebar = page.locator('.bid-table tbody tr', { hasText: 'Арматура А500С d12' })
        await rebar.locator('.bid-hint', { hasText: 'ваша цена в тендере № 905' }).waitFor({ timeout: 60000 })
        assert.match(await text(rebar.locator('.bid-hint')), /64 000,00 ₽/, 'последняя цена')
        await page.getByRole('button', { name: 'Мои прошлые цены (1)' }).waitFor()
        const viaFn = await calls(page, 'bid_rate_history')
        if (query) assert.equal(viaFn.length, 0)
        else {
          assert.deepEqual(viaFn.map((c) => [c.p_tender, c.keys]), [['t-open', 4]], 'один запрос: 4 позиции тендера')
          assert.equal(await page.locator('.bid-table tbody tr', { hasText: 'Бетон В25 W8' }).locator('.bid-hint').count(), 0, 'цена снабжения — не подсказка')
        }
        assert.deepEqual(errors, [])
      } finally {
        await close()
      }
    }
  })

  it('анкета и «Моя компания» — одни сведения: название и НДС — из карточки, СРО и сайт — один ответ на компанию, посещение — по тендеру', async () => {
    const { page, errors, close } = await open('&formLinks=1')
    try {
      await page.locator('table.tenders-registry').waitFor({ timeout: 120000 })
      // «Моя компания»: что из карточки само стоит в анкете; СРО — заполнить один раз здесь.
      await page.locator('.cab-tab', { hasText: 'Моя компания' }).click()
      const own = page.locator('.cab-org-form')
      await own.waitFor({ timeout: 30000 })
      assert.match(await text(page.locator('.cab-org-linked')), /название, ставка НДС/)
      assert.equal(await own.getByLabel('Наименование контрагента').count(), 0, 'из карточки — не здесь, а в карточке выше')
      await own.getByLabel('Наличие СРО').fill('да, 500 000 ₽')
      await own.getByLabel('Наличие СРО').blur()
      await own.locator('.cab-org-state.is-saved').waitFor()
      assert.deepEqual((await calls(page, 'bid_company_save')).map((c) => c.answers), [{ 'f-sro': 'да, 500 000 ₽' }])

      // Тендер: поля о компании — сверху; название и НДС — из карточки, без поля ввода; СРО уже стоит; анкета тендера записалась сама.
      await page.locator('.cab-tab', { hasText: 'Тендеры' }).click()
      await openTender(page, 857)
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      await page.locator('.bid-tab', { hasText: 'Анкета' }).click()
      const company = page.locator('.bid-form-group.is-company')
      await company.waitFor({ timeout: 60000 })
      const nameRow = company.locator('.bid-form-row', { hasText: 'Наименование контрагента' })
      assert.match(await text(nameRow.locator('.bid-form-value')), /ООО Альфа/)
      assert.equal(await nameRow.locator('textarea').count(), 0, 'название — из карточки, в анкете не меняется')
      assert.match(await text(company.locator('.bid-form-row', { hasText: 'Ставка НДС' })), /22 %/)
      assert.equal(await company.locator('.bid-form-row', { hasText: 'Наличие СРО' }).locator('textarea').inputValue(), 'да, 500 000 ₽')
      assert.equal(await page.locator('.bid-tab .bid-tab-warn').count(), 0, 'НДС из карточки — выбирать не нужно')
      await page.waitForFunction(() => window.__fakeDb.tender_bid_forms.some((f) => f.tender_id === 't-open' && f.answers['f-sro']), null, { timeout: 30000 })
      const form = await page.evaluate(() => window.__fakeDb.tender_bid_forms.find((f) => f.tender_id === 't-open').answers)
      assert.deepEqual([form['f-name']?.value, form['f-vat']?.value, form['f-sro']?.value], ['ООО Альфа', '22 %', 'да, 500 000 ₽'], 'отдел видит анкету заполненной')

      // Сайта в карточке нет — ответ в анкете уходит и в «Мою компанию».
      const site = company.locator('.bid-form-row', { hasText: 'Ссылка на сайт' })
      await site.locator('textarea').fill('alpha.ru')
      await site.locator('textarea').blur()
      await site.locator('.bid-form-state.is-saved').waitFor()
      assert.deepEqual((await calls(page, 'bid_company_save')).at(-1).answers, { 'f-site': 'alpha.ru' })
      // По тендеру — своё, в «Мою компанию» не идёт.
      const visit = page.locator('.bid-form-group:not(.is-company) .bid-form-row', { hasText: 'посещении' })
      await visit.locator('textarea').fill('были 05.11')
      await visit.locator('textarea').blur()
      await visit.locator('.bid-form-state.is-saved').waitFor()
      assert.equal((await calls(page, 'bid_company_save')).length, 2)

      // Обратно в «Мою компанию»: сайт — уже там.
      await page.locator('.cab-tab', { hasText: 'Моя компания' }).click()
      await page.locator('.cab-org-form').waitFor()
      assert.equal(await page.locator('.cab-org-form').getByLabel('Ссылка на сайт компании').inputValue(), 'alpha.ru')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('анкета от имени подрядчика (просмотр): сведения из карточки видны, ничего не записывается', async () => {
    const { page, errors, close } = await open('&formLinks=1&preview=1')
    try {
      await page.locator('table.tenders-registry').waitFor({ timeout: 120000 })
      await openTender(page, 857)
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      await page.locator('.bid-tab', { hasText: 'Анкета' }).click()
      const company = page.locator('.bid-form-group.is-company')
      await company.waitFor({ timeout: 60000 })
      assert.match(await text(company.locator('.bid-form-row', { hasText: 'Наименование контрагента' })), /ООО Альфа/)
      await page.waitForTimeout(800)
      assert.deepEqual([...await calls(page, 'bid_form_save'), ...await calls(page, 'bid_company_save')], [])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('«Моя компания»: номер на сайте — и в шапке, и во вкладке; контактные лица; статуса и примечаний отдела нет', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('table.tenders-registry').waitFor({ timeout: 120000 })
      assert.match(await page.locator('.cab-header .cab-company-number').textContent(), /Номер на сайте: 1234/)
      await page.locator('.cab-tab', { hasText: 'Моя компания' }).click()
      const company = page.locator('.cab-org')
      await company.locator('.cab-org-row', { hasText: 'Номер на сайте' }).locator('dd', { hasText: '1234' }).waitFor()
      assert.match(await company.locator('.cab-org-row', { hasText: 'Ставка НДС' }).textContent(), /22 %/)
      const persons = company.locator('.cab-org-contact')
      assert.equal(await persons.count(), 2)
      assert.equal(await persons.first().locator('a[href^="tel:"]').count(), 1)
      assert.equal(await persons.nth(1).locator('a[href="mailto:smeta@alpha.ru"]').count(), 1)
      assert.doesNotMatch(await company.textContent(), /служебное/)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('просмотр от имени подрядчика: кабинет 1 в 1 (цены, заявка, учётная запись) — правится на экране, в базу ничего не записывается, чужих цен нет', async () => {
    const { page, errors, close } = await open('&preview=1')
    try {
      await page.locator('table.tenders-registry').waitFor({ timeout: 120000 })
      const row = (num) => page.getByRole('link', { name: `Открыть тендер № ${num}` })
      for (const num of [857, 905, 911]) await row(num).waitFor()
      for (const num of [910, 704, 950, 951, 952]) assert.equal(await row(num).count(), 0, `тендер № ${num}: отказ, прошлый, без объекта, удалённый, на материалы`)
      const open857 = page.locator('table.tenders-registry tbody tr', { has: row(857) })
      assert.equal(await open857.locator('a', { hasText: 'Открыть' }).first().getAttribute('href'), 'https://disk.example.ru/pack')
      assert.match(await open857.textContent(), /Иванов/)

      await page.locator('.cab-tab', { hasText: 'Моя компания' }).click()
      const company = page.locator('.cab-org')
      await company.getByText('7707083893').waitFor()
      assert.match(await company.locator('.cab-org-row', { hasText: 'Номер на сайте' }).textContent(), /1234/)
      assert.equal(await company.locator('.cab-org-contact').count(), 2)
      assert.doesNotMatch(await company.textContent(), /служебное/)
      assert.equal(await company.getByRole('heading', { name: 'Учётная запись' }).count(), 1, 'учётная запись — как у подрядчика (учётки организации)')
      // Смена пароля в просмотре сменила бы пароль администратора — вместо формы пояснение.
      if (await company.getByRole('button', { name: 'Сменить пароль' }).count()) {
        await company.getByRole('button', { name: 'Сменить пароль' }).click()
        await company.locator('.cab-note', { hasText: 'пароль организации здесь не меняется' }).waitFor()
        assert.equal(await company.locator('input[type=password]').count(), 0)
      }

      await page.locator('.cab-tab', { hasText: 'Тендеры' }).click()
      await openTender(page, 857)
      assert.equal(await page.locator('.cab-note', { hasText: 'Просмотр от имени подрядчика' }).count(), 0, 'пометка — в полосе просмотра, не на странице')
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      await page.getByRole('button', { name: 'Исходный ВОР «ВОР паркинга.xlsx»' }).waitFor({ timeout: 60000 })
      await page.locator('.bid-tab', { hasText: 'Материалы' }).locator('.bid-tab-count', { hasText: '2' }).waitFor({ timeout: 60000 })
      await page.locator('.bid-save', { hasText: 'в базу не записываются' }).waitFor()
      assert.match(await text(page.locator('.bid-vs-total .bid-vs-line').nth(0)), /0 из 2/, 'цена другой организации в просмотр не попала')
      await page.getByRole('button', { name: 'Загрузить файл с ценами' }).waitFor()
      // Цену можно ввести, как подрядчику: она остаётся на экране (черновик просмотра), в базу не уходит.
      const input = page.locator('.bid-table .bid-money-input:not([disabled])').first()
      await input.fill('1234')
      await input.press('Tab')
      await page.waitForTimeout(1200)
      assert.match(await text(page.locator('.bid-vs-total .bid-vs-line').nth(0)), /1 из 2/, 'цена встала в сводку')
      assert.deepEqual(await calls(page, 'bid_request'), [], 'заявка не записана')
      assert.deepEqual(await calls(page, 'bid_rates_save'), [], 'цена не записана')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('скорость (25.11.2026): ВОР в браузере качаются по нескольку сразу, не больше 4; список файлов тендера — один запрос; просмотр — позиции с сервера (20270304), без неё — разбор в браузере', async () => {
    // Пять корпусов сверх «ВОР паркинга» (копии книги под своими ключами), заявка «ООО Альфа»; хранилище отвечает через 300 мс.
    const corpora = () => {
      let fdb
      Object.defineProperty(window, '__fakeDb', {
        configurable: true,
        get() { return fdb },
        set(v) {
          fdb = v
          for (let i = 1; i <= 5; i++) {
            const key = `tenders/t-open/korpus-${i}.xlsx`
            window.__fakeFiles[key] = window.__fakeFiles['tenders/t-open/vor.xlsx']
            v.s3_documents.push({ id: `doc-k${i}`, owner_type: 'tender', owner_id: 't-open', doc_category: 'vor_statement', file_name: `ВОР корпус ${i}.xlsx`,
              s3_key: key, mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size_bytes: 9000 + i, created_at: '2026-10-22T10:00:00Z' })
          }
          v.tender_bid_requests.push({ id: 'req-speed', tender_id: 't-open', counterparty_id: 'cp-alpha', status: 'pending', requested_at: '2026-10-20T10:00:00Z' })
        },
      })
      window.__fakeRemoteFiles = true
      window.__fakeFileDelay = 300
    }
    const vorKeys = (page) => page.evaluate(() => (window.__fakeFileRequests || []).filter((k) => /^tenders\/t-open\/.*\.xlsx$/.test(k)))
    {
      // Просмотр, база раньше 20270304: функция отказывает администратору — шесть ведомостей разбираются в браузере.
      const { page, errors, close } = await open('&preview=1', undefined, { init: corpora })
      try {
        await page.locator('table.tenders-registry').waitFor({ timeout: 120000 })
        const before = await page.evaluate(() => window.__supabaseStats.requests.length)
        await openTender(page, 857)
        await page.waitForFunction(() => !document.body.innerText.includes('Читаем ведомости')
          && document.querySelectorAll('.bid-vs-wrap li.bid-vs-row').length >= 6, null, { timeout: 60000 })
        assert.equal((await calls(page, 'bid_positions')).length, 1, 'сначала — разбор службы')
        assert.equal((await vorKeys(page)).length, 6, 'все шесть ведомостей скачаны')
        const atOnce = await page.evaluate(() => window.__fakeFileMaxInFlight)
        assert.ok(atOnce >= 2 && atOnce <= 4, `одновременно скачивалось ${atOnce}: нужно по нескольку, но не больше 4`)
        // Просьба пользователя 25.11.2026: плиток ВОР не больше 5 в ряд; шестая — во втором ряду той же ширины.
        const rowsOf = await page.evaluate(() => [...document.querySelectorAll('.bid-vs-wrap li.bid-vs-row')]
          .map((e) => ({ top: Math.round(e.getBoundingClientRect().top), width: Math.round(e.getBoundingClientRect().width) })))
        assert.equal(rowsOf.filter((t) => t.top === rowsOf[0].top).length, 5, 'в первом ряду — 5 плиток')
        assert.ok(Math.abs(rowsOf[5].width - rowsOf[0].width) <= 1, 'плитка второго ряда — той же ширины')
        const tables = await page.evaluate((n) => window.__supabaseStats.requests.slice(n).map((r) => r.table), before)
        assert.equal(tables.filter((t) => t === 's3_documents').length, 1, 'документы тендера и ведомости расценки — один запрос списка файлов')
        assert.deepEqual(errors, [])
      } finally {
        await close()
      }
    }
    {
      // Просмотр после 20270304: позиции — разбор службы, книги ВОР не скачиваются.
      const { page, errors, close } = await open('&preview=1&previewPositions=1')
      try {
        await page.locator('table.tenders-registry').waitFor({ timeout: 120000 })
        await openTender(page, 857)
        await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
        await page.locator('.bid-tab', { hasText: 'Материалы' }).locator('.bid-tab-count', { hasText: '2' }).waitFor({ timeout: 60000 })
        assert.ok((await calls(page, 'bid_positions')).length >= 1)
        assert.deepEqual(await vorKeys(page), [], 'книга ВОР не скачивалась')
        assert.deepEqual(errors, [])
      } finally {
        await close()
      }
    }
  })

  it('«Цены из файла»: свой прайс — сопоставление, цены «из файла»; своя цена заменяется только по отметке', async () => {
    const { page, errors, close } = await open()
    try {
      await openTender(page, 857)
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      await page.locator('.bid-tab', { hasText: 'Работы' }).locator('.bid-tab-count', { hasText: '2' }).waitFor({ timeout: 60000 })
      await page.getByRole('button', { name: 'Загрузить файл с ценами' }).click()
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Наименование', 'Ед. изм.', 'Цена с НДС'],
        ['бетон  в25 w8', 'м3', 7700],
        ['Устройство монолитной плиты', 'м3', 2500],
        ['Кирпич облицовочный', 'шт', 30],
      ]), 'Прайс')
      const buffer = Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
      await page.locator('.bid-modal input[type=file]').setInputFiles({ name: 'Прайс Альфа.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer })
      await page.locator('.bid-import-table tbody tr').first().waitFor({ timeout: 30000 })
      assert.equal(await page.locator('.bid-import-table tbody tr').count(), 3)
      assert.match(await page.locator('.bid-filters-total', { hasText: 'сопоставлено' }).textContent(), /сопоставлено 2 из 3 · поставим цен: 2/)
      await page.getByRole('button', { name: 'Поставить цены: 2' }).click()
      await page.locator('.bid-save', { hasText: 'Все цены сохранены' }).waitFor({ timeout: 10000 })
      const rows = (await calls(page, 'bid_rates_save')).flatMap((c) => c.rows)
      assert.deepEqual(rows.map((r) => [r.name, r.price, r.source]).sort(), [
        ['Бетон В25 W8', 7700, 'import'], ['Устройство монолитной плиты', 2500, 'import'],
      ])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('«Цены из файла» (просьба пользователя 25.11.2026): несколько файлов сразу; своя цена остаётся, пока не выбрали «Заменить все мои цены»; потом — вернуть все прежние, заменить всё, отменить загрузку', async () => {
    const { page, errors, close } = await open()
    try {
      await openTender(page, 857)
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      const row = (name) => page.locator('.bid-table tbody tr', { hasText: name })
      const priceIs = (name, re) => page.waitForFunction(([n, src]) => {
        const tr = [...document.querySelectorAll('.bid-table tbody tr')].find((t) => t.textContent.includes(n))
        return new RegExp(src).test(String(tr?.querySelector('.bid-money-input')?.value || '').replace(/\s/g, ' '))
      }, [name, re.source], { timeout: 10000 })
      await row('Бетон В25 W8').waitFor({ timeout: 60000 })
      await row('Бетон В25 W8').locator('.bid-money-input').fill('7800')
      await row('Бетон В25 W8').locator('.bid-money-input').press('Enter')
      await page.locator('.bid-save', { hasText: 'Все цены сохранены' }).waitFor({ timeout: 10000 })

      const file = (rows, name) => {
        const wb = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Наименование', 'Ед. изм.', 'Цена с НДС'], ...rows]), 'Прайс')
        return { name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })) }
      }
      await page.getByRole('button', { name: 'Загрузить файл с ценами' }).click()
      await page.locator('.bid-modal input[type=file]').setInputFiles([
        file([['Бетон В25 W8', 'м3', 9100]], 'ВОР 1 — свой.xlsx'), file([['Арматура А500С d12', 'т', 65000]], 'ВОР 2 — свой.xlsx'),
      ])
      const conflicts = page.locator('.bid-import-conflicts')
      await conflicts.waitFor({ timeout: 30000 })
      assert.equal(await page.locator('.bid-import-table tbody tr').count(), 2, 'строки обоих файлов')
      assert.match(await text(conflicts), /У 1 поз\. уже стоит ваша цена, а в файле — другая\. Сейчас все ваши цены остаются/)
      assert.equal(await page.locator('.bid-modal-foot .cab-btn-primary').textContent(), 'Поставить цены: 1', 'по умолчанию своя цена не заменяется')
      await conflicts.getByRole('button', { name: 'Заменить все мои цены (1)' }).click()
      await page.getByRole('button', { name: 'Поставить цены: 2' }).click()
      await page.locator('.bid-save', { hasText: 'Все цены сохранены' }).waitFor({ timeout: 10000 })
      await priceIs('Бетон В25 W8', /^9 100,00$/)
      await priceIs('Арматура А500С d12', /^65 000,00$/)

      const log = page.locator('.bid-import-log')
      assert.match(await text(log.locator('.bid-import-log-text')), /новых цен — 1, у 1 поз\. ваша цена и цена файла различаются \(сейчас из файла — 1, ваши — 0\)/)
      assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('osp.bidImportLog:'))), ['osp.bidImportLog:t-open:cp-alpha'],
        'прежние цены — в браузере, по тендеру и организации')
      await log.getByRole('button', { name: 'Вернуть все мои прежние цены (1)' }).click()
      await priceIs('Бетон В25 W8', /^7 800,00$/)
      await priceIs('Арматура А500С d12', /^65 000,00$/)
      await log.getByRole('button', { name: 'Заменить всё ценами файла (1)' }).click()
      await priceIs('Бетон В25 W8', /^9 100,00$/)
      await log.getByRole('button', { name: 'Отменить загрузку целиком' }).click()
      await priceIs('Бетон В25 W8', /^7 800,00$/)
      await priceIs('Арматура А500С d12', /^$/)
      await page.locator('.bid-save', { hasText: 'Все цены сохранены' }).waitFor({ timeout: 10000 })
      const last = new Map((await calls(page, 'bid_rates_save')).flatMap((c) => c.rows).map((r) => [r.name, [r.price, r.source]]))
      assert.deepEqual(last.get('Бетон В25 W8'), [7800, 'manual'], 'прежняя цена — с прежним источником')
      assert.deepEqual(last.get('Арматура А500С d12'), [null, 'manual'], 'новая цена из файла убрана')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('анкета: поля администратора без скрытых, ответ — при уходе из поля; ставка НДС — из списка, видна в итогах', async () => {
    const { page, errors, close } = await open()
    try {
      await openTender(page, 857)
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      // Особые условия «Главного листа» — над вкладками.
      await page.locator('.bid-conditions li', { hasText: 'ГУ в размере 5 %' }).waitFor({ timeout: 60000 })
      assert.equal(await page.locator('.bid-conditions li').count(), 2)
      // Ставка не выбрана — в итогах «не указана», у вкладки «Анкета» — знак; нажатие ведёт в анкету.
      const warn = page.locator('.bid-sum-warn')
      await warn.waitFor()
      assert.equal(await page.locator('.bid-tab', { hasText: 'Анкета' }).locator('.bid-tab-warn').count(), 1)
      await warn.click()
      await page.locator('.bid-form-row').first().waitFor({ timeout: 30000 })
      assert.equal(await page.locator('.bid-form-row').count(), 2)
      assert.equal(await page.getByText('Скрытое поле').count(), 0)
      await page.getByLabel('Наименование контрагента').fill('ООО «Альфа»')
      await page.getByLabel('Наименование контрагента').press('Tab')
      await page.locator('.bid-form-state.is-saved').first().waitFor({ timeout: 10000 })
      const vat = page.getByLabel('Ставка НДС')
      assert.deepEqual(await vat.locator('option').allTextContents(), ['— выберите —', '22 %', '7 %', '5 %', '0 %'])
      await vat.selectOption('22 %')
      await page.locator('.bid-form-state.is-saved').nth(1).waitFor({ timeout: 10000 })
      let saves = await calls(page, 'bid_form_save')
      assert.deepEqual(saves.map((s) => s.answers), [{ 'f-name': 'ООО «Альфа»' }, { 'f-vat': '22 %' }])
      assert.match(await page.locator('.bid-filters-total', { hasText: 'Заполнено' }).textContent(), /Заполнено 2 из 2/)
      assert.equal(await page.locator('.bid-sum-warn').count(), 0)
      assert.match(await page.locator('.bid-sum-cell', { hasText: 'НДС: 22 %' }).textContent(), /в т\. ч\. 0,00 ₽/)
      // Цена → в т. ч. НДС 22 %: 1000 × 130,5 = 130 500 → НДС 23 532,79.
      await page.locator('.bid-tab', { hasText: 'Материалы' }).click()
      const concrete = page.locator('.bid-table tbody tr', { hasText: 'Бетон В25 W8' })
      await concrete.locator('.bid-money-input').fill('1000')
      await concrete.locator('.bid-money-input').press('Enter')
      await page.locator('.bid-sum-cell', { hasText: 'НДС: 22 %' }).filter({ hasText: /23\s532,79/ }).waitFor({ timeout: 10000 })
      // Сменили ставку — «в т. ч. НДС» по новой: 130 500 × 5 / 105 = 6 214,29.
      await page.locator('.bid-tab', { hasText: 'Анкета' }).click()
      await page.getByLabel('Ставка НДС').selectOption('5 %')
      await page.locator('.bid-sum-cell', { hasText: 'НДС: 5 %' }).filter({ hasText: /6\s214,29/ }).waitFor({ timeout: 10000 })
      saves = await calls(page, 'bid_form_save')
      assert.deepEqual(saves.at(-1).answers, { 'f-vat': '5 %' })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('реестр: как у сотрудника, только идущие тендеры; прошлых тендеров и договоров нет; «Открыть тендер» — заметная кнопка', async () => {
    const { page, errors, close } = await open()
    try {
      const table = page.locator('table.tenders-registry')
      await table.waitFor({ timeout: 120000 })
      assert.equal(await page.locator('.tenders-page.ui-work.tp-dense').count(), 1, 'те же стили, что реестр сотрудника')
      const rows = table.locator('tbody > tr')
      assert.equal(await rows.count(), 3, 'три идущих тендера, отказавшегося нет')
      assert.equal(await table.getByText('Слаботочные системы').count(), 0, 'прошлый тендер (704) не показан')
      assert.deepEqual(await page.locator('.cab-tab').allTextContents(), ['Тендеры3', 'Моя компания'], 'раздела договоров нет')

      const headers = (await table.locator('thead th').allTextContents()).join('|')
      for (const secret of ['Участник', 'КП', 'ВОР', 'План', 'материал', 'Примечание', 'Победител']) {
        assert.ok(!headers.includes(secret), `столбец «${secret}» подрядчику не показывается: ${headers}`)
      }
      const row = rows.filter({ hasText: 'Бетонные полы паркинга' })
      assert.match(await row.locator('td').first().textContent(), /857/)
      assert.match(await row.textContent(), /ЖК Primavera к14/)
      assert.match(await row.textContent(), /Не участвуете/)
      assert.match(await row.textContent(), /20\.10.*30\.11\.2026/, 'срок приёма')
      assert.equal(await row.locator('a[href^="tel:"]').getAttribute('href'), 'tel:+77010000000')
      assert.equal(await row.locator('td a[target="_blank"]', { hasText: 'Открыть' }).getAttribute('href'), 'https://disk.example.ru/pack')
      await row.getByRole('button', { name: 'Показать адрес' }).click()
      assert.equal(await row.locator('.tp-obj-address').textContent(), 'Москва')

      // Кнопка, а не текст-ссылка: залита цветом, в одну строку, помещается в свою ячейку.
      const btn = row.getByRole('link', { name: 'Открыть тендер № 857' })
      assert.equal(await btn.textContent(), 'Открыть тендер')
      const look = await btn.evaluate((el) => {
        const cs = getComputedStyle(el)
        const box = el.getBoundingClientRect()
        const cell = el.parentElement.getBoundingClientRect()
        return { background: cs.backgroundColor, color: cs.color, line: cs.textDecorationLine, fits: box.left >= cell.left && box.right <= cell.right, height: box.height }
      })
      assert.notEqual(look.background, 'rgba(0, 0, 0, 0)', 'кнопка залита')
      assert.equal(look.color, 'rgb(255, 255, 255)')
      assert.equal(look.line, 'none')
      assert.ok(look.fits, 'кнопка в пределах ячейки')
      assert.ok(look.height >= 28, `высота ${look.height}`)

      // Поиск и вкладка «Участвую».
      await page.locator('.cab-registry .tp-search').fill('фасад')
      assert.equal(await rows.count(), 1)
      await page.locator('.cab-registry .tp-search').fill('')
      await page.locator('.cab-registry .tender-tab', { hasText: 'Участвую' }).click()
      assert.equal(await rows.count(), 1)
      assert.match(await rows.first().textContent(), /Фасадные работы/)
      await page.locator('.cab-registry .tender-tab', { hasText: 'Все тендеры' }).click()

      // Открытие и возврат (стенд — MemoryRouter: кнопку браузера здесь не проверить).
      await openTender(page, 857)
      await page.locator('.cab-back').click()
      await table.waitFor()
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('отметка участия — функцией кабинета; договоры не запрашиваются; прямых обращений к таблицам организации и тендеров нет', async () => {
    const { page, errors, close } = await open()
    try {
      await openTender(page, 905)
      await page.getByRole('button', { name: 'Отказаться от участия' }).click()
      await page.waitForFunction(() => window.__bidCalls.some((c) => c.fn === 'contractor_set_participation'))
      assert.deepEqual(await calls(page, 'contractor_set_participation'), [{ fn: 'contractor_set_participation', p_tender: 't-inv', p_status: 'declined' }])
      await page.locator('table.tenders-registry').waitFor()
      assert.equal(await page.getByRole('link', { name: 'Открыть тендер № 905' }).count(), 0, 'после отказа тендера в кабинете нет')
      const direct = await page.evaluate(() => window.__supabaseStats.requests.map((r) => r.table))
      assert.ok(!direct.includes('rpc:contractor_contracts'), 'договоры кабинету не нужны')
      for (const table of ['tenders', 'objects', 'contracts', 'contract_counterparties', 'counterparties', 'tender_counterparties']) {
        assert.ok(!direct.includes(table), `прямое обращение к ${table}`)
      }
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('телефон: реестр карточками с кнопкой, без прокрутки страницы вбок', async () => {
    const { page, errors, close } = await open('', { width: 390, height: 844 })
    try {
      await page.getByRole('link', { name: 'Открыть тендер № 857' }).waitFor({ timeout: 60000 })
      const listOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert.ok(listOverflow <= 1, `реестр шире экрана на ${listOverflow}px`)
      const button = await page.getByRole('link', { name: 'Открыть тендер № 857' }).boundingBox()
      assert.ok(button.width > 200, `кнопка на всю карточку, ширина ${button.width}`)
      await openTender(page, 857)
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      await page.locator('.bid-tab', { hasText: 'Материалы' }).locator('.bid-tab-count', { hasText: '2' }).waitFor({ timeout: 60000 })
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert.ok(overflow <= 1, `страница шире экрана на ${overflow}px`)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('инженер: заявка с сайта в раскрытой строке реестра — организация и кто подал; «Сделать участником»', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
    try {
      await page.goto(`${stand.url}?route=/tenders/construction&tenders=5&items=20&cps=2&latency=0`)
      const rows = page.locator('table.tenders-registry > tbody > tr')
      await rows.first().waitFor({ timeout: 120000 })
      // Заявка на каждый тендер стенда: какая строка ни раскройся — блок есть.
      await page.evaluate(() => {
        window.__fakeDb.tender_bid_requests = window.__fakeDb.tenders.map((t, i) => ({
          id: `req-${i}`, tender_id: t.id, counterparty_id: 'cp-site', status: 'pending',
          requested_by_name: 'Сайтов С. С.', requested_at: '2026-10-23T09:30:00Z', counterparties: { id: 'cp-site', name: 'ООО Сайт', inn: '7700000009' },
        }))
        window.__decided = []
        window.__fakeRpc = { ...(window.__fakeRpc || {}), bid_decide: ({ p_request, p_accept }) => {
          window.__decided.push({ p_request, p_accept })
          const r = window.__fakeDb.tender_bid_requests.find((x) => x.id === p_request)
          r.status = p_accept ? 'accepted' : 'rejected'
          return { data: r.status, error: null }
        } }
      })
      await rows.first().locator('.expand-toggle').click()
      const block = page.locator('.bidreq')
      await block.waitFor({ timeout: 10000 })
      assert.match(await block.textContent(), /Заявки с сайта1 ждут решения/)
      assert.match(await block.textContent(), /ООО Сайт · ИНН 7700000009Сайтов С\. С\., /)
      await block.getByRole('button', { name: 'Сделать участником' }).click()
      await block.waitFor({ state: 'detached', timeout: 10000 })
      const decided = await page.evaluate(() => window.__decided)
      assert.equal(decided.length, 1)
      assert.equal(decided[0].p_accept, true)
      assert.deepEqual(errors, [])
    } finally {
      await context.close().catch(() => {})
    }
  })

  it('инженер: в «Тендерах на материалы» — только «просят цены: N» (ссылка в расценку, столбец раскрыт); кнопки и окна «Цены подрядчикам» нет', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    // Просьба подрядчика основного тендера tender-13 — в «базе» стенда с самого начала: счётчик читается вместе с реестром.
    await context.addInitScript(() => {
      let fakeDb
      Object.defineProperty(window, '__fakeDb', {
        configurable: true,
        get: () => fakeDb,
        set: (v) => {
          fakeDb = v
          v.tender_bid_supply_access = [{ tender_id: 'tender-13', counterparty_id: 'cp-site', status: 'requested', requested_at: '2026-11-20T09:00:00Z' }]
        },
      })
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
    try {
      // Основное строительство: блока цен снабжения в раскрытой строке нет.
      await page.goto(`${stand.url}?route=/tenders/construction&tenders=5&items=20&cps=2&latency=0`)
      const rows = page.locator('table.tenders-registry > tbody > tr')
      await rows.first().waitFor({ timeout: 120000 })
      await rows.first().locator('.expand-toggle').click()
      await page.locator('.expanded-cp-row').first().waitFor({ timeout: 10000 })
      assert.equal(await page.locator('.bidreq.bidsup').count(), 0, 'в реестре основного строительства блока нет')

      // «Тендеры на материалы»: у тендера, чей основной (tender-13) получил просьбу, — ссылка в расценку со столбцом «Цены подрядчику».
      await page.goto(`${stand.url}?route=/tenders/materials&tenders=13&matTenders=1&latency=0`)
      await page.locator('table.tenders-registry > tbody > tr').first().waitFor({ timeout: 120000 })
      const link = page.getByRole('link', { name: 'просят цены: 1' })
      await link.first().waitFor({ timeout: 10000 })
      assert.match(await link.first().getAttribute('href'), /\/tenders\/materials\/.+\/pricing\?prices=contractors$/)
      assert.equal(await page.getByRole('button', { name: /Цены подрядчикам/ }).count(), 0, 'отдельного окна больше нет')

      // Снабжение (раздел «Тендеры на материалы» с правкой) ссылки не видит: решает только инженер ОСП или администратор.
      await page.goto(`${stand.url}?route=/tenders/materials&tenders=13&matTenders=1&latency=0&asRole=snabjenie`)
      await page.locator('table.tenders-registry > tbody > tr').first().waitFor({ timeout: 120000 })
      await page.waitForTimeout(300)
      assert.equal(await page.getByRole('link', { name: /просят цены/ }).count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await context.close().catch(() => {})
    }
  })

  it('администратор: реестр расценок → «Расценки подрядчиков (актуальные тендеры)»: сводка, подробности, позиции, анкета', async () => {
    const { page, errors, close } = await open('&page=admin')
    try {
      const tab = page.getByRole('tab', { name: 'Расценки подрядчиков (актуальные тендеры)' })
      await tab.waitFor({ timeout: 120000 })
      assert.equal(await tab.getAttribute('aria-selected'), 'true', 'открыта по ссылке ?tab=bids')
      const row = page.locator('.cbp-table tbody tr', { hasText: 'ООО Альфа' })
      await row.waitFor({ timeout: 60000 })
      assert.equal(await page.getByText('ООО Бета (завершён)').count(), 0, 'завершённый тендер — в реестре КП, не здесь')
      assert.match(await row.textContent(), /Заявка: ждёт решения/)
      assert.match(await row.textContent(), /1\s344\s150,00/)
      assert.match(await row.textContent(), /22 %/)
      await row.click()
      const drawer = page.locator('.cbp-drawer')
      await drawer.locator('tbody tr', { hasText: 'Бетон В25 W8' }).waitFor()
      assert.match(await drawer.locator('tbody tr', { hasText: 'Бетон В25 W8' }).textContent(), /из файла/)
      await drawer.getByRole('button', { name: /Анкета \(1\)/ }).click()
      await drawer.locator('.cbp-answers dd', { hasText: 'ООО Альфа' }).waitFor()
      await page.keyboard.press('Escape')
      // Позиции списком: цена, подрядчик, тендер, как введена.
      await page.getByRole('tab', { name: 'Позиции' }).click()
      const pos = page.locator('.cbp-table tbody tr', { hasText: 'Бетон В25 W8' })
      await pos.waitFor({ timeout: 10000 })
      assert.match(await pos.textContent(), /7\s800,00.*ООО Альфа.*№ 857.*из файла/)
      await page.getByRole('tab', { name: 'Поля анкеты' }).click()
      await page.locator('.cbp-field').first().waitFor()
      assert.equal(await page.locator('.cbp-field').count(), 3, 'администратор видит и скрытые')
      assert.equal(await page.locator('.cbp-field.is-off').count(), 1)
      // Ставку НДС не удалить и не скрыть; её варианты — списком.
      const vatRow = page.locator('.cbp-field', { has: page.locator('.cbp-chip-vat') })
      assert.equal(await vatRow.getByRole('button', { name: 'Скрыть' }).count(), 0)
      assert.equal(await vatRow.getByRole('button', { name: 'Удалить поле' }).isDisabled(), true)
      const vatOptions = vatRow.getByLabel('Варианты списка')
      assert.match(await vatOptions.inputValue(), /^22 %\n7 %\n5 %\n0 %$/)
      // Прежний список (20 %, 10 %, «Без НДС») — «вернуть ставки по умолчанию» оставляет 22, 7, 5, 0 %.
      await vatOptions.fill('22 %\n20 %\n10 %\n7 %\n5 %\n0 %\nБез НДС')
      await vatRow.getByRole('button', { name: 'вернуть ставки по умолчанию' }).click()
      assert.match(await vatOptions.inputValue(), /^22 %\n7 %\n5 %\n0 %$/)
      assert.equal(await vatRow.getByRole('button', { name: 'вернуть ставки по умолчанию' }).count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('администратор: свои ВОР подрядчиков — число и сумма в сводке, список в подробностях, скачивание своим маршрутом', async () => {
    const { page, errors, close } = await open('&page=admin&bidFiles=1')
    try {
      const row = page.locator('.cbp-table tbody tr', { hasText: 'ООО Альфа' })
      await row.waitFor({ timeout: 120000 })
      const cells = row.locator('td')
      assert.match(await cells.nth(6).textContent(), /^1\s*1\s620\s400,00$/, 'ВОР с расценками: 1 файл на 1 620 400,00')
      await page.locator('.cbp-stats', { hasText: 'по загруженным ВОР' }).waitFor()
      await row.click()
      const drawer = page.locator('.cbp-drawer')
      const fileRow = drawer.locator('tbody tr', { hasText: 'ВОР паркинга' })
      await fileRow.waitFor({ timeout: 10000 })
      assert.match(await fileRow.textContent(), /Альфа — ВОР паркинга\.xlsx.*1\s294\s150,00.*326\s250,00.*1\s620\s400,00/)
      const [saved] = await Promise.all([page.waitForEvent('download'), fileRow.getByRole('button', { name: 'Альфа — ВОР паркинга.xlsx' }).click()])
      assert.equal(saved.suggestedFilename(), 'Альфа — ВОР паркинга.xlsx')
      assert.deepEqual(await page.evaluate(() => window.__bidFileCalls.map((c) => [c.admin, c.file_id])), [[true, 'bf-alpha']])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
