// Кабинет подрядчика в браузере (миграция 20261102, стенд tests/tender/ui/cabinet.html, данные в памяти):
//   • список: «Мои тендеры» и «Открытые тендеры» — номер, объект, сроки; в карточке — ответственный и телефон;
//   • открытый тендер без заявки: файлов и расценки нет, «Участвовать и расценить» — заявка, затем файл ВОР
//     скачивается и разбирается: «Материалы» и «Работы» — по листам, «Структура КП» — по листу «КП»;
//   • цена пишется сама (bid_rates_save) — с ключами позиции и объёмом; сумма и итоги пересчитываются;
//   • «Цены из файла»: свой прайс сопоставляется с позициями, цены ставятся с отметкой «из файла»;
//   • анкета — поля из списка администратора (скрытого нет), ответ пишется при уходе из поля; ставка НДС — выбор из
//     списка (22, 7, 5, 0 %; 20 %, 10 % и «Без НДС» убраны 23.10.2026): пока не выбрана — «не указана» в итогах,
//     выбрана — «в т. ч. НДС» по этой ставке;
//   • «Особые условия» с «Главного листа» файла ВОР — над вкладками;
//   • закрытый тендер — только просмотр;
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

  it('заявка → файл ВОР → материалы, работы и структура КП; цена пишется сама, итоги пересчитываются', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('.cab-list-title', { hasText: 'Мои тендеры' }).waitFor({ timeout: 120000 })
      assert.equal(await page.locator('.cab-list-title', { hasText: 'Открытые тендеры' }).count(), 1)
      await page.locator('.cab-card', { hasText: 'Тендер № 857' }).click()
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

  it('«Цены из файла»: свой прайс — сопоставление, цены «из файла»; своя цена заменяется только по отметке', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('.cab-card', { hasText: 'Тендер № 857' }).click()
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
      await page.locator('.cab-card', { hasText: 'Тендер № 857' }).click()
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

  it('закрытый тендер, где организация участник: только просмотр, без «Участвовать»', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('.cab-card', { hasText: 'Тендер № 704' }).click()
      await page.locator('.cab-chip', { hasText: 'Приём предложений закрыт' }).waitFor({ timeout: 60000 })
      assert.equal(await page.getByRole('button', { name: 'Участвовать и расценить' }).count(), 0)
      await page.locator('.bid-save', { hasText: 'Только просмотр' }).waitFor()
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('телефон: список над тендером, без прокрутки страницы вбок', async () => {
    const { page, errors, close } = await open('', { width: 390, height: 844 })
    try {
      await page.locator('.cab-card').first().waitFor({ timeout: 60000 })
      await page.locator('.cab-card', { hasText: 'Тендер № 857' }).click()
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
