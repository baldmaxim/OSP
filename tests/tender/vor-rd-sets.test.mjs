// «ВОРы и РД»: комплекты РД под строкой тендера или заявки (миграция 20261027_vor_rd_sets).
// Нажатие по строке раскрывает список: № п/п (порядковый), комплект РД, ВОР готов (да / нет), срок выдачи
// ВОРа, ссылка на РД и ВОР, примечание. Поля сохраняются сами; без права правки — только просмотр; без
// таблицы в базе — подсказка про обновление базы, остальная страница работает.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { isValidRdLink, compareRdSets, rdSetOwnerId } from '../../src/utils/vorRdSets.js'

describe('Комплекты РД: правила без браузера', () => {
  it('ссылка — адрес http(s) или сетевой путь, как CHECK в базе', () => {
    assert.equal(isValidRdLink('https://drive.google.com/drive/folders/abc'), true)
    assert.equal(isValidRdLink('  http://su10.ru/rd  '), true)
    assert.equal(isValidRdLink('\\\\su10-fs\\Тендеры\\РД'), true)
    assert.equal(isValidRdLink('ftp://host/file'), false)
    assert.equal(isValidRdLink('javascript:alert(1)'), false)
    assert.equal(isValidRdLink('C:\\Тендеры'), false)
    assert.equal(isValidRdLink('https://' + 'a'.repeat(2000)), false)
  })

  it('порядок списка (он же № п/п): sort_order, затем дата создания; владелец — тендер или заявка', () => {
    const rows = [
      { id: 'c', sort_order: 20, created_at: '2026-10-21T10:00:00Z' },
      { id: 'b', sort_order: 10, created_at: '2026-10-21T11:00:00Z' },
      { id: 'a', sort_order: 10, created_at: '2026-10-21T09:00:00Z' },
    ]
    assert.deepEqual([...rows].sort(compareRdSets).map((r) => r.id), ['a', 'b', 'c'])
    assert.equal(rdSetOwnerId({ tender_id: 't-1', vor_request_id: null }), 't-1')
    assert.equal(rdSetOwnerId({ tender_id: null, vor_request_id: 'r-1' }), 'r-1')
  })
})

const launch = browserLaunchOptions()

describe('Комплекты РД в «ВОРах и РД»', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  // seed(): подложить строки в «базу» стенда. Стенд кэширует выборки до записи через клиент, поэтому
  // данные кладутся до первого открытия «ВОРов и РД»: старт в реестре тендеров, затем переход.
  const openVors = async (query = '', seed = null) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    const base = `${stand.url}?tenders=10&items=20&cps=2&latency=0${query}`
    if (seed) {
      await page.goto(`${base}&route=/tenders/construction`)
      await page.locator('table.tenders-registry > tbody > tr').first().waitFor({ timeout: 120000 })
      await page.evaluate(seed)
      await page.evaluate(() => window.__navigate('/vors'))
    } else {
      await page.goto(`${base}&route=/vors`)
    }
    await page.locator('table.vors-table > tbody > tr.vr-main-row').first().waitFor({ timeout: 120000 })
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }
  // Строка тендера по номеру — подпись кнопки раскрытия в первой колонке.
  const mainRow = (page, num) => page.locator('table.vors-table > tbody > tr.vr-main-row')
    .filter({ has: page.locator('td:first-child .vr-rd-toggle', { hasText: new RegExp(`^${num}$`) }) })
  // Раскрытый список — следующая строка таблицы.
  const panelOf = (page, num) => mainRow(page, num).locator('xpath=following-sibling::tr[1][contains(@class, "vr-rd-row")]')
  const dbSets = (page) => page.evaluate(() => (window.__fakeDb.vor_rd_sets || []).map((s) => ({ ...s })))
  // Перечитать раздел: уйти и вернуться (данные в памяти сохраняются; новые выборки — только после записи
  // через клиент или ответа ошибкой).
  const remount = async (page) => {
    await page.evaluate(() => window.__navigate('/tenders/construction'))
    await page.locator('table.tenders-registry > tbody > tr').first().waitFor({ timeout: 60000 })
    await page.evaluate(() => window.__navigate('/vors'))
    await page.locator('table.vors-table > tbody > tr.vr-main-row').first().waitFor({ timeout: 60000 })
  }

  it('нажатие по строке раскрывает список; добавить, заполнить все поля, удалить — всё пишется в базу', async () => {
    const { page, errors, dialogs, close } = await openVors()
    try {
      const row = mainRow(page, 197)
      const toggle = row.locator('.vr-rd-toggle')
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false')

      // Нажатие по свободному месту строки («Ответственный по тендеру») — раскрывает.
      await row.locator('td').nth(5).click()
      const panel = panelOf(page, 197)
      await panel.waitFor()
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
      assert.match(await panel.textContent(), /Комплектов РД пока нет/)

      // Первый комплект: курсор сразу в названии.
      await panel.getByRole('button', { name: '+ Комплект РД' }).click()
      const name = panel.getByRole('textbox', { name: 'Комплект РД, комплект № 1' })
      await name.waitFor()
      assert.equal(await name.evaluate((el) => el === document.activeElement), true, 'фокус в новом комплекте')
      await name.fill('  АР — Архитектурные решения  ')
      await name.press('Enter')
      await page.waitForFunction(() => window.__fakeDb.vor_rd_sets?.[0]?.rd_set === 'АР — Архитектурные решения', null, { timeout: 10000 })
      const [set] = await dbSets(page)
      assert.equal(set.tender_id, 'tender-4')
      assert.equal(set.vor_request_id, null)

      // Заголовки — те, что просили.
      assert.deepEqual((await panel.locator('table.vrs-table thead th').allTextContents()).slice(0, 6),
        ['№ п/п', 'Комплект РД', 'ВОР готов', 'Срок выдачи ВОРа', 'Ссылка на РД и ВОР', 'Примечание'])
      assert.equal(await panel.locator('tbody tr td.vrs-num').first().textContent(), '1')

      // ВОР готов — «Да».
      const ready = panel.getByRole('group', { name: 'ВОР готов, комплект № 1' })
      assert.equal(await ready.getByRole('button', { name: 'Нет' }).getAttribute('aria-pressed'), 'true')
      await ready.getByRole('button', { name: 'Да' }).click()
      await page.waitForFunction(() => window.__fakeDb.vor_rd_sets[0].vor_ready === true, null, { timeout: 10000 })
      assert.equal(await ready.getByRole('button', { name: 'Да' }).getAttribute('aria-pressed'), 'true')
      // Сводка в строке тендера — без раскрытия видно, по скольким комплектам ВОР готов.
      assert.equal(await row.locator('.vr-rd-count').textContent(), '1 из 1')

      // Срок выдачи ВОРа — полная дата пишется по Enter / уходу из поля.
      const due = panel.getByLabel('Срок выдачи ВОРа, комплект № 1')
      await due.fill('2026-11-05')
      await due.press('Enter')
      await page.waitForFunction(() => window.__fakeDb.vor_rd_sets[0].vor_due_date === '2026-11-05', null, { timeout: 10000 })

      // Ссылка: неверный адрес не пишется, верный — пишется и открывается в новой вкладке.
      await panel.getByRole('button', { name: '+ ссылка' }).click()
      const link = panel.getByRole('textbox', { name: 'Ссылка на РД и ВОР, комплект № 1' })
      await link.fill('ftp://files/rd')
      await link.press('Enter')
      assert.match(await panel.locator('.vrs-field-error').textContent(), /https:\/\/… или сетевой путь/)
      assert.equal((await dbSets(page))[0].link, undefined)
      await link.fill('https://drive.example.com/rd/197')
      await panel.getByRole('button', { name: 'Сохранить' }).click()
      await page.waitForFunction(() => window.__fakeDb.vor_rd_sets[0].link === 'https://drive.example.com/rd/197', null, { timeout: 10000 })
      const open = panel.getByRole('link', { name: 'Открыть' })
      assert.equal(await open.getAttribute('href'), 'https://drive.example.com/rd/197')
      assert.equal(await open.getAttribute('target'), '_blank')

      // Примечание — многострочное, пишется при уходе из поля.
      const note = panel.getByRole('textbox', { name: 'Примечание, комплект № 1' })
      await note.fill('Ждём изм. 1\nот проектировщика')
      await note.blur()
      await page.waitForFunction(() => window.__fakeDb.vor_rd_sets[0].note === 'Ждём изм. 1\nот проектировщика', null, { timeout: 10000 })

      // Esc возвращает сохранённое, ничего не пишет.
      await name.fill('Черновик')
      await name.press('Escape')
      assert.equal(await name.inputValue(), 'АР — Архитектурные решения')
      assert.equal((await dbSets(page))[0].rd_set, 'АР — Архитектурные решения')

      // Второй комплект — № 2; сводка 1 из 2.
      await panel.getByRole('button', { name: '+ Комплект РД' }).click()
      const name2 = panel.getByRole('textbox', { name: 'Комплект РД, комплект № 2' })
      await name2.fill('КЖ')
      await name2.press('Enter')
      await page.waitForFunction(() => window.__fakeDb.vor_rd_sets.some((s) => s.rd_set === 'КЖ'), null, { timeout: 10000 })
      assert.equal(await row.locator('.vr-rd-count').textContent(), '1 из 2')
      const sets = await dbSets(page)
      assert.ok(sets[1].sort_order > sets[0].sort_order, 'новый — в конце списка')

      // Удаление первого — с подтверждением; оставшийся становится № 1.
      await panel.getByRole('button', { name: 'Удалить комплект № 1' }).click()
      await page.waitForFunction(() => window.__fakeDb.vor_rd_sets.length === 1, null, { timeout: 10000 })
      assert.match(dialogs.at(-1), /Удалить комплект РД № 1 «АР — Архитектурные решения»\?/)
      assert.equal(await panel.getByRole('textbox', { name: 'Комплект РД, комплект № 1' }).inputValue(), 'КЖ')
      assert.equal(await row.locator('.vr-rd-count').textContent(), '0 из 1')

      // Кнопка в первой колонке сворачивает.
      await toggle.click()
      assert.equal(await panelOf(page, 197).count(), 0)
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('нажатия по ссылкам, спискам и выбору срока в строке список не раскрывают', async () => {
    const { page, errors, close } = await openVors()
    try {
      const row = mainRow(page, 199)
      // Выпадающий список подразделения: открытие и выбор (выбор — в окошке поверх страницы).
      await row.locator('.vor-div-fdrop .fdrop-trigger').click()
      await page.locator('.fdrop-panel .fdrop-option', { hasText: /^ОВиВК/ }).click()
      await page.waitForFunction(() => window.__fakeDb.tenders.find((t) => t.id === 'tender-2').vor_division === 'hvac_water', null, { timeout: 10000 })
      // Окошко срока подготовки ВОР.
      await row.locator('.drc-btn').click()
      await page.keyboard.press('Escape')
      // Выделение текста мышью — тоже не раскрытие.
      await row.locator('td').nth(5).dblclick()
      assert.equal(await panelOf(page, 199).count(), 0)
      // А по номеру — раскрывает; можно держать открытыми несколько строк.
      await row.locator('.vr-rd-toggle').click()
      await mainRow(page, 198).locator('.vr-rd-toggle').click()
      assert.equal(await page.locator('table.vors-table > tbody > tr.vr-rd-row').count(), 2)
      // С клавиатуры: Enter на кнопке.
      await mainRow(page, 198).locator('.vr-rd-toggle').focus()
      await page.keyboard.press('Enter')
      assert.equal(await panelOf(page, 198).count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('заявка на ВОР без тендера — свои комплекты; ссылка комплекта открывает статус «Завершён»', async () => {
    const { page, errors, dialogs, close } = await openVors('', () => {
      window.__fakeDb.vor_requests = [{
        id: 'req-1', request_number: 7, department: 'construction', object_id: 'obj-1', objects: { name: 'ЖК «Северный квартал»', status: 'main_construction' },
        work_description: 'ВОР по кровле заранее', vor_status: 'in_progress', created_at: '2026-10-01T09:00:00Z', deleted_at: null,
      }]
      window.__fakeDb.vor_rd_sets = [{
        id: 'set-x', tender_id: 'tender-5', vor_request_id: null, sort_order: 10, rd_set: 'ОВ', vor_ready: true,
        link: '\\\\su10-fs\\РД\\196', created_at: '2026-10-20T10:00:00Z',
      }]
    })
    try {
      const reqRow = page.locator('table.vors-table > tbody > tr.vr-main-row.vor-request-row')
      await reqRow.locator('.vr-rd-toggle').click()
      const panel = reqRow.locator('xpath=following-sibling::tr[1]')
      await panel.getByRole('button', { name: '+ Комплект РД' }).click()
      await panel.getByRole('textbox', { name: 'Комплект РД, комплект № 1' }).fill('КР')
      await panel.getByRole('textbox', { name: 'Комплект РД, комплект № 1' }).press('Enter')
      await page.waitForFunction(() => window.__fakeDb.vor_rd_sets.some((s) => s.rd_set === 'КР'), null, { timeout: 10000 })
      const set = (await dbSets(page)).find((s) => s.rd_set === 'КР')
      assert.equal(set.vor_request_id, 'req-1')
      assert.equal(set.tender_id, null)
      assert.match(await panel.locator('table.vrs-table').getAttribute('aria-label'), /заявка № 7/)

      // Тендер без ссылки и файлов: «Завершён» не ставится…
      await mainRow(page, 195).locator('select.plan-status-select').selectOption('completed')
      assert.match(dialogs.at(-1), /Нельзя установить статус «Завершён»/)
      assert.equal(await page.evaluate(() => window.__fakeDb.tenders.find((t) => t.id === 'tender-6').vor_status), 'in_progress')
      // …а со ссылкой у комплекта РД — ставится.
      await mainRow(page, 196).locator('select.plan-status-select').selectOption('completed')
      await page.waitForFunction(() => window.__fakeDb.tenders.find((t) => t.id === 'tender-5').vor_status === 'completed', null, { timeout: 10000 })
      // Сетевой путь не ссылка: его копируют.
      await mainRow(page, 196).locator('.vr-rd-toggle').click()
      assert.equal(await panelOf(page, 196).getByRole('button', { name: 'Скопировать путь' }).count(), 1)
      assert.equal(await panelOf(page, 196).getByRole('link').count(), 0)
      assert.equal(await panelOf(page, 196).getByRole('button', { name: 'Скопировать путь' }).getAttribute('title'), '\\\\su10-fs\\РД\\196')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('без права правки: только просмотр; без таблицы в базе — подсказка, страница работает', async () => {
    const { page, errors, close } = await openVors('&canEdit=0', () => {
      window.__fakeDb.vor_rd_sets = [
        { id: 's1', tender_id: 'tender-1', vor_request_id: null, sort_order: 10, rd_set: 'АР', vor_ready: true,
          vor_due_date: '2026-11-01', link: 'https://drive.example.com/ar', note: 'Получено', created_at: '2026-10-20T10:00:00Z' },
        { id: 's2', tender_id: 'tender-1', vor_request_id: null, sort_order: 20, rd_set: 'КЖ', vor_ready: false,
          vor_due_date: null, link: null, note: null, created_at: '2026-10-20T10:01:00Z' },
      ]
    })
    try {
      const row = page.locator('table.vors-table > tbody > tr.vr-main-row')
        .filter({ has: page.locator('td:first-child .vr-rd-toggle', { hasText: /^200$/ }) })
      assert.equal(await row.locator('.vr-rd-count').textContent(), '1 из 2')
      await row.locator('.vr-rd-toggle').click()
      const panel = row.locator('xpath=following-sibling::tr[1]')
      await panel.locator('table.vrs-table').waitFor()
      assert.equal(await panel.locator('input, textarea').count(), 0, 'полей правки нет')
      assert.equal(await panel.getByRole('button', { name: /Комплект РД|Удалить|ссылка/ }).count(), 0)
      const cells = await panel.locator('tbody tr').first().locator('td').allTextContents()
      assert.deepEqual(cells.slice(0, 3), ['1', 'АР', 'Да'])
      assert.equal(cells[3], '01.11.2026')
      assert.match(cells[4], /Открыть/)
      assert.equal(cells[5], 'Получено')
      assert.match(await panel.locator('.vrs-sum').textContent(), /ВОР готов: 1 из 2/)

      // Таблицы ещё нет — список не грузится, страница и сводки работают.
      await page.evaluate(() => {
        window.__fakeErrors = { ...(window.__fakeErrors || {}), vor_rd_sets: { code: 'PGRST205', message: "Could not find the table 'public.vor_rd_sets' in the schema cache" } }
      })
      await remount(page)
      await mainRow(page, 200).locator('.vr-rd-toggle').click()
      assert.match(await panelOf(page, 200).textContent(), /появятся после обновления базы \(миграция 20261027_vor_rd_sets\)/)
      assert.equal(await page.locator('.vr-rd-count').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
