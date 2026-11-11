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
//   • решения пользователя 11.11.2026 (стенд ?bidFiles=1 — миграция 20270113): файлы ВОР — только в расценке, РД — свёрнута,
//     шаблонов нет, расценка на сайте скрыта: рядом с каждой ведомостью — свой ВОР с расценками, суммы по ведомостям (корпусам)
//     и итог — сводкой как в «Сравнении КП»; видны только свои файлы. Без миграции (по умолчанию) — прежняя расценка на сайте.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

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

  async function open(query = '', viewport = { width: 1500, height: 950 }) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
    page.on('dialog', (d) => d.accept())
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
      await page.getByRole('button', { name: 'Скачать ВОР «ВОР паркинга.xlsx»' }).waitFor({ timeout: 30000 })
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
      assert.match(await page.locator('.bid-sum-cell', { hasText: 'Материалы' }).textContent(), /1 из 2/)

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

  it('файл ВОР — главная кнопка; шаблона КП и «Шаблона Excel» нет; «Состава работ» рядом с расценкой нет; отказ убирает тендер', async () => {
    const { page, errors, close } = await open('&legacyItems=1')
    try {
      await openTender(page, 905)
      const vorBtn = page.getByRole('button', { name: 'Скачать ВОР «ВОР фасада.xlsx»' })
      await vorBtn.waitFor({ timeout: 60000 })
      const [saved] = await Promise.all([page.waitForEvent('download'), vorBtn.click()])
      assert.equal(saved.suggestedFilename(), 'ВОР фасада.xlsx')
      assert.match(await vorBtn.getAttribute('class'), /cab-btn-primary/)
      // Решение пользователя 11.11.2026: подрядчик заполняет сам файл ВОР — шаблонов нет, даже если смета во вкладке «ВОР» есть.
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

  it('свой ВОР с расценками: рядом с каждой ведомостью, суммы по корпусам и итог; только свои файлы; ВОР — только здесь, РД свёрнута', async () => {
    const { page, errors, close } = await open('&bidFiles=1')
    try {
      await page.locator('table.tenders-registry').waitFor({ timeout: 120000 })
      await openTender(page, 857)
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      await page.locator('.cab-note', { hasText: 'Заявка подана' }).waitFor()

      // Документы: пакет — списком, РД — свёрнута (PDF из «ВОР и РД» туда же), Excel-файлов ВОР в документах нет.
      await page.locator('.cab-docs-title', { hasText: 'Тендерный пакет' }).waitFor({ timeout: 30000 })
      const fold = page.locator('details.cab-docs-fold')
      assert.match(await text(fold.locator('summary')), /Рабочая документация\s*2$/i)
      assert.equal(await fold.evaluate((el) => el.open), false, 'РД свёрнута')
      assert.equal(await page.locator('.cab-doc-name', { hasText: 'РД КЖ лист 1.pdf' }).isVisible(), false)
      await fold.locator('summary').click()
      await page.locator('.cab-doc-name', { hasText: 'РД КЖ лист 2.pdf' }).waitFor()
      assert.equal(await page.locator('.cab-doc-name', { hasText: /\.xlsx$/ }).count(), 0, 'ВОР — только в расценке')

      // Расценка на сайте скрыта: ни таблиц, ни «Цен из файла», ни шаблона; анкета осталась.
      // Ведомости — по имени: «корпус 2», затем «паркинга».
      const pairs = page.locator('.bid-pair')
      await pairs.nth(1).waitFor({ timeout: 60000 })
      assert.equal(await pairs.count(), 2)
      assert.match(await text(pairs.nth(0).locator('.bid-pair-vor')), /ВОР корпус 2/)
      assert.match(await text(pairs.nth(1).locator('.bid-pair-vor')), /ВОР паркинга/)
      const parking = pairs.nth(1)
      const block2 = pairs.nth(0)
      for (const name of ['Цены из файла', 'Шаблон Excel', 'Скачать шаблон']) assert.equal(await page.getByRole('button', { name }).count(), 0, name)
      assert.equal(await page.locator('.bid-tab').count(), 0, 'вкладок расценки на сайте нет')
      assert.equal(await page.locator('.bid-money-input').count(), 0)
      await page.locator('.bid-form-section h4', { hasText: 'Анкета участника' }).waitFor()
      await page.locator('.bid-conditions', { hasText: 'ГУ в размере 5 %' }).waitFor()

      // Чужой файл к той же ведомости лежит в базе — в кабинете его нет: обе ведомости «ждут вашего файла», сводки до первого файла нет.
      const matrix = page.locator('table.bid-matrix')
      assert.equal(await matrix.count(), 0, 'своих файлов нет — сводки нет')
      assert.equal(await page.locator('.bid-pair.is-empty').count(), 2)
      assert.equal(await page.locator('.bid-state-chip', { hasText: 'Ждёт вашего файла' }).count(), 2)
      assert.doesNotMatch(await text(page.locator('.bid-files')), /777|Бета/)
      assert.match(await text(page.locator('.bid-progress')), /С расценкой: 0 из 2/)
      assert.equal(await page.locator('.bid-steps li').count(), 3, 'три шага: скачать, заполнить, загрузить')

      // Корпус 1: армирование без цены — итог неполный (жёлтым, как в «Сравнении КП»).
      await page.waitForFunction(() => !document.querySelector('.bid-note')?.textContent.includes('Читаем файлы ВОР'), null, { timeout: 60000 })
      await parking.locator('input[type=file]').setInputFiles(pricedVor({ concrete: 7800, rebar: '85 000', slab: 2500 }))
      await parking.locator('.bid-file-name').waitFor({ timeout: 30000 })
      await matrix.waitFor()
      assert.match(await text(matrix.locator('thead')), /ООО Альфа/)
      // Армирование без цены — жёлтым: «не у всех позиций есть цена».
      assert.match(await parking.getAttribute('class'), /is-partial/)
      await parking.locator('.bid-state-chip', { hasText: 'Не у всех позиций есть цена' }).waitFor()
      const row1 = matrix.locator('tbody tr', { hasText: 'ВОР паркинга' })
      await row1.locator('td', { hasText: '1 620 400,00' }).waitFor()
      assert.match(await text(row1), /ВОР паркинга 1 294 150,00 326 250,00 1 620 400,00/)
      assert.match(await row1.locator('td').nth(2).getAttribute('class'), /is-incomplete/)
      assert.equal(await row1.locator('td').nth(2).getAttribute('title'), 'Цены у 1 из 2 позиций работ')
      assert.match(await text(parking), /Итого 1 620 400,00 ₽/)

      // Корпус 2: всё с ценой; итог — по обоим корпусам.
      await block2.locator('input[type=file]').setInputFiles(pricedVor({ concrete: 8000, rebar: 90000, slab: 2600, reinforce: 30000 }))
      const row2 = matrix.locator('tbody tr', { hasText: 'ВОР корпус 2' })
      await row2.locator('td', { hasText: '1 773 300,00' }).waitFor({ timeout: 30000 })
      assert.match(await text(matrix.locator('tfoot')), /ИТОГО, ₽ 2 630 650,00 763 050,00 3 393 700,00/)
      assert.match(await text(page.locator('.bid-matrix-block')), /Итог — по всем 2 ведомостям/)
      assert.match(await text(page.locator('.bid-progress')), /С расценкой: 2 из 2/)

      // В базу — файл к своей ведомости и сводка; ключ задаёт служба (стенд — как она).
      const confirms = await page.evaluate(() => window.__bidFileCalls.filter((c) => c.action === 'confirm'))
      assert.deepEqual(confirms.map((c) => [c.tender_id, c.vor_file_id]), [['t-open', 'doc-vor'], ['t-open', 'doc-vor2']])
      assert.deepEqual(confirms[0].summary.priced, { material: 2, work: 1 })
      assert.equal(confirms[0].summary.total, 1620400)

      // Новый файл к той же ведомости заменяет прежний: строка одна, прежнего объекта в хранилище нет.
      const firstKey = await page.evaluate(() => window.__fakeDb.tender_bid_files.find((f) => f.vor_file_id === 'doc-vor' && f.counterparty_id === 'cp-alpha').s3_key)
      await parking.locator('input[type=file]').setInputFiles(pricedVor({ concrete: 7800, rebar: 85000, slab: 2500, reinforce: 30000 }))
      await row1.locator('td', { hasText: '1 717 900,00' }).waitFor({ timeout: 30000 })
      assert.equal(await page.evaluate((k) => !!window.__fakeFiles[k], firstKey), false)
      assert.equal(await page.evaluate(() => window.__fakeDb.tender_bid_files.filter((f) => f.counterparty_id === 'cp-alpha').length), 2)
      assert.equal(await row1.locator('td.is-incomplete').count(), 0)
      assert.match(await parking.getAttribute('class'), /is-ok/, 'всё с ценой — зелёным')

      // Скачать свой файл — под своим именем; убрать — строка корпуса снова пустая, итог пересчитан.
      const [saved] = await Promise.all([page.waitForEvent('download'), parking.getByRole('button', { name: /Скачать свой файл/ }).click()])
      assert.equal(saved.suggestedFilename(), 'ВОР с расценками.xlsx')
      await block2.getByRole('button', { name: 'Убрать' }).click()
      await row2.locator('td', { hasText: '—' }).first().waitFor({ timeout: 30000 })
      assert.match(await text(matrix.locator('tfoot')), /1 717 900,00/)
      assert.match(await text(page.locator('.bid-matrix-block')), /Итог — только по 1 ведомости из 2/)
      assert.deepEqual(await calls(page, 'bid_rates_save'), [], 'цены на сайте не пишутся')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('свой ВОР: файл, где цен нет, — только после вопроса; просмотр от имени подрядчика — без загрузки, файл скачивается маршрутом администратора', async () => {
    const { page, errors, close } = await open('&bidFiles=1&preview=1')
    try {
      await page.locator('table.tenders-registry').waitFor({ timeout: 120000 })
      await openTender(page, 857)
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      const pairs = page.locator('.bid-pair')
      await pairs.nth(1).waitFor({ timeout: 60000 })
      assert.equal(await page.locator('.bid-upload-btn').count(), 0, 'просмотр ничего не загружает')
      const parking = page.locator('.bid-pair', { hasText: 'ВОР паркинга' })
      assert.match(await text(parking), /Альфа — ВОР паркинга\.xlsx/)
      assert.equal(await parking.getByRole('button', { name: 'Заменить' }).count(), 0)
      assert.match(await text(page.locator('table.bid-matrix tbody tr', { hasText: 'ВОР паркинга' })), /1 620 400,00/)
      const [saved] = await Promise.all([page.waitForEvent('download'), parking.getByRole('button', { name: /Скачать свой файл/ }).click()])
      assert.equal(saved.suggestedFilename(), 'Альфа — ВОР паркинга.xlsx')
      assert.deepEqual(await page.evaluate(() => window.__bidFileCalls.map((c) => c.admin)), [true])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }

    const second = await open('&bidFiles=1')
    try {
      const { page } = second
      await page.locator('table.tenders-registry').waitFor({ timeout: 120000 })
      await openTender(page, 905)
      const pair = page.locator('.bid-pair').first()
      await pair.waitFor({ timeout: 60000 })
      await page.waitForFunction(() => !document.querySelector('.bid-note')?.textContent.includes('Читаем файлы ВОР'), null, { timeout: 60000 })
      // Прайс без позиций этой ведомости: вопрос (стенд соглашается), файл загружен, сумма «не посчитано», в итог не входит.
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Наименование', 'Ед. изм.', 'Цена'], ['Кирпич облицовочный', 'шт', 30]]), 'Прайс')
      const dialogs = []
      page.removeAllListeners('dialog')
      page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
      await pair.locator('input[type=file]').setInputFiles({ name: 'Прайс.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })) })
      await pair.locator('.bid-file-name', { hasText: 'Прайс.xlsx' }).waitFor({ timeout: 30000 })
      assert.match(dialogs[0], /Цен по позициям этой ведомости в файле не нашлось/)
      assert.match(await text(pair), /Цен по позициям этой ведомости в файле не нашлось/)
      assert.match(await text(page.locator('table.bid-matrix tbody tr').first()), /не посчитано/)
      assert.match(await text(page.locator('table.bid-matrix tfoot')), /ИТОГО, ₽ — — —/)
      assert.deepEqual(second.errors, [])
    } finally {
      await second.close()
    }
  })

  it('прежняя версия ведомости (как тендер № 847) не показывается; своя расценка к ней — у новой, красным и не в итоге; «Загрузить заново» её заменяет', async () => {
    const { page, errors, close } = await open('&bidFiles=1&vorVersions=1')
    try {
      await page.locator('table.tenders-registry').waitFor({ timeout: 120000 })
      await openTender(page, 857)
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      const pairs = page.locator('.bid-pair')
      await pairs.nth(1).waitFor({ timeout: 60000 })
      assert.equal(await pairs.count(), 2, 'прежняя версия паркинга — не отдельной ведомостью')
      assert.equal(await page.getByRole('button', { name: 'Скачать ВОР «ВОР паркинга старая.xlsx»' }).count(), 0)
      assert.ok((await calls(page, 'bid_vor_superseded')).length >= 1)

      const parking = pairs.nth(1)
      assert.match(await parking.getAttribute('class'), /is-stale/)
      assert.match(await text(parking), /Отдел обновил ВОР — загрузите заново/)
      assert.match(await text(parking), /Альфа — по старой ведомости\.xlsx/)
      const matrix = page.locator('table.bid-matrix')
      await matrix.waitFor()
      assert.match(await text(matrix.locator('tbody tr', { hasText: 'ВОР паркинга' })), /по прежней версии ВОР — не в итоге/)
      assert.match(await text(matrix.locator('tfoot')), /ИТОГО, ₽ — — —/, 'расценка по старым объёмам в итог не входит')
      assert.match(await text(page.locator('.bid-progress')), /С расценкой: 0 из 2/)

      await page.waitForFunction(() => !document.querySelector('.bid-note')?.textContent.includes('Читаем файлы ВОР'), null, { timeout: 60000 })
      await parking.locator('input[type=file]').setInputFiles(pricedVor({ concrete: 7800, rebar: 85000, slab: 2500, reinforce: 30000 }))
      await matrix.locator('tbody tr', { hasText: 'ВОР паркинга' }).locator('td', { hasText: '1 717 900,00' }).waitFor({ timeout: 30000 })
      assert.match(await parking.getAttribute('class'), /is-ok/)
      const mine = await page.evaluate(() => window.__fakeDb.tender_bid_files.filter((f) => f.counterparty_id === 'cp-alpha').map((f) => f.vor_file_id))
      assert.deepEqual(mine, ['doc-vor'], 'файл — к новой версии, прежний убран')
      const confirms = await page.evaluate(() => window.__bidFileCalls.filter((c) => c.action === 'confirm').map((c) => c.vor_file_id))
      assert.deepEqual(confirms, ['doc-vor'])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('анкета и «Моя компания» — одни сведения: название и НДС — из карточки, СРО и сайт — один ответ на компанию, посещение — по тендеру', async () => {
    const { page, errors, close } = await open('&bidFiles=1&formLinks=1')
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
      const company = page.locator('.bid-form-group.is-company')
      await company.waitFor({ timeout: 60000 })
      const nameRow = company.locator('.bid-form-row', { hasText: 'Наименование контрагента' })
      assert.match(await text(nameRow.locator('.bid-form-value')), /ООО Альфа/)
      assert.equal(await nameRow.locator('textarea').count(), 0, 'название — из карточки, в анкете не меняется')
      assert.match(await text(company.locator('.bid-form-row', { hasText: 'Ставка НДС' })), /22 %/)
      assert.equal(await company.locator('.bid-form-row', { hasText: 'Наличие СРО' }).locator('textarea').inputValue(), 'да, 500 000 ₽')
      assert.equal(await page.locator('.bid-form-section .bid-tab-warn').count(), 0, 'НДС из карточки — выбирать не нужно')
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
    const { page, errors, close } = await open('&bidFiles=1&formLinks=1&preview=1')
    try {
      await page.locator('table.tenders-registry').waitFor({ timeout: 120000 })
      await openTender(page, 857)
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
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

  it('просмотр от имени подрядчика: те же тендеры, пакет, ответственный и сведения компании; ничего не записывается, чужих цен нет', async () => {
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
      assert.equal(await company.getByRole('heading', { name: 'Учётная запись' }).count(), 0, 'учётки у просмотра нет')
      assert.equal(await company.getByRole('button', { name: 'Сменить пароль' }).count(), 0, 'пароль сменился бы у администратора')

      await page.locator('.cab-tab', { hasText: 'Тендеры' }).click()
      await openTender(page, 857)
      await page.locator('.cab-note', { hasText: 'Просмотр от имени подрядчика' }).waitFor()
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      await page.getByRole('button', { name: 'Скачать ВОР «ВОР паркинга.xlsx»' }).waitFor({ timeout: 60000 })
      await page.locator('.bid-tab', { hasText: 'Материалы' }).locator('.bid-tab-count', { hasText: '2' }).waitFor({ timeout: 60000 })
      await page.locator('.bid-save', { hasText: 'цены не записываются' }).waitFor()
      assert.match(await page.locator('.bid-sum-cell', { hasText: 'Материалы' }).textContent(), /0 из 2/, 'цена другой организации в просмотр не попала')
      assert.equal(await page.locator('.bid-table .bid-money-input:not([disabled])').count(), 0, 'ввода цен нет')
      assert.deepEqual(await calls(page, 'bid_request'), [], 'заявка не записана')
      assert.deepEqual(await calls(page, 'bid_rates_save'), [])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('«Цены из файла»: свой прайс — сопоставление, цены «из файла»; своя цена заменяется только по отметке', async () => {
    const { page, errors, close } = await open()
    try {
      await openTender(page, 857)
      await page.getByRole('button', { name: 'Участвовать и расценить' }).click()
      await page.locator('.bid-tab', { hasText: 'Работы' }).locator('.bid-tab-count', { hasText: '2' }).waitFor({ timeout: 60000 })
      await page.getByRole('button', { name: 'Цены из файла' }).click()
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
