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
      await page.locator('.cab-doc-name', { hasText: 'ВОР паркинга.xlsx' }).waitFor()

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

  it('файл ВОР — главная кнопка, шаблон — маленькая; файл не того вида не стирает КП; «Состава работ» рядом с расценкой нет; отказ убирает тендер', async () => {
    const { page, errors, close } = await open('&legacyItems=1')
    try {
      await openTender(page, 905)
      const vorBtn = page.getByRole('button', { name: 'Скачать ВОР «ВОР фасада.xlsx»' })
      await vorBtn.waitFor({ timeout: 60000 })
      const [saved] = await Promise.all([page.waitForEvent('download'), vorBtn.click()])
      assert.equal(saved.suggestedFilename(), 'ВОР фасада.xlsx')
      assert.match(await vorBtn.getAttribute('class'), /cab-btn-primary/)
      const template = page.getByRole('button', { name: 'Скачать шаблон' })
      assert.match(await template.getAttribute('class'), /cab-btn-small/)
      assert.match(await page.getByRole('button', { name: 'Шаблон Excel' }).getAttribute('class'), /cab-btn-small/)
      const height = (loc) => loc.evaluate((el) => el.getBoundingClientRect().height)
      assert.ok(await height(template) < await height(vorBtn), 'шаблон заметно меньше кнопки ВОР')

      // Смета во вкладке «ВОР» есть, но рядом расценка: тот же ВОР — во вкладке «Структура КП», второго показа нет.
      await page.locator('.cab-section h3', { hasText: 'Расценка' }).waitFor()
      assert.equal(await page.locator('.cab-section h3', { hasText: 'Состав работ' }).count(), 0)

      // Заполненный файл ВОР в загрузку шаблона: столбцы другие — отказ с подсказкой, КП не трогаем.
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['№ п/п', 'Наименование', 'Ед. изм.', 'Объём'], [1, 'Монтаж фасада', 'м2', 100]]), 'Материалы')
      const notTemplate = Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
      await page.locator('.cab-kp-actions input[type=file]').setInputFiles({ name: 'ВОР фасада.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: notTemplate })
      await page.locator('.cab-note.is-warn', { hasText: 'Это не шаблон КП' }).waitFor({ timeout: 10000 })
      const writes = await page.evaluate(() => window.__supabaseStats.requests.filter((r) => r.table === 'tender_counterparty_proposals' && r.op !== 'select'))
      assert.deepEqual(writes, [])

      await page.getByRole('button', { name: 'Отказаться от участия' }).click()
      await page.locator('table.tenders-registry').waitFor()
      assert.deepEqual(await calls(page, 'contractor_set_participation'), [{ fn: 'contractor_set_participation', p_tender: 't-inv', p_status: 'declined' }])
      assert.equal(await page.getByRole('link', { name: 'Открыть тендер № 905' }).count(), 0, 'после отказа тендера в кабинете нет')
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
})
