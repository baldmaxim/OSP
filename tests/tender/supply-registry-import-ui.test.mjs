// Реестр расценок → «Расценки от снабжения СУ-10» → «Загрузить из Excel» (миграция 20270224) в Chromium (стенд tests/tender/ui,
// маршрут /rates-registry?tab=supply, данные — kp-registry-stand.jsx): колонка «Источник»; файл в виде выгрузки вкладки →
// объекты файла (распознан / несколько — выбрать / разово «Primavera = к14»), строки с итогом (уже в реестре, повтор, ошибка);
// запись только по кнопке, порцией в базу; новые строки — в таблице сразу, тендер без ссылки — текстом; разовое правило после
// загрузки не предлагается; удаление загрузки; без права правки и без миграции — кнопки нет.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import * as XLSX from 'xlsx'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const skip = launch ? false : 'нет Chromium (Playwright, Chrome или PSDC_BROWSER)'

const HEADERS = ['№ п/п', 'Источник', 'Объект', 'Наименование', 'Ед. изм.', 'Цена, ₽', 'Тендер', 'Дата расценки']
function registryXlsx(rows) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADERS, ...rows]), 'Расценки СУ-10')
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
}
const FILE_ROWS = [
  // Выгрузка реестра обратно: та же цена с сайта — «уже в реестре».
  [1, 'СУ-10', 'ЖК  ЗИЛ 33', 'Плитка керамогранит 600х600', 'м2', 1850, 'Отделка МОП', '05.10.2026'],
  [2, 'Сайт СУ-10', 'Зил33', 'Клей плиточный', 'кг', 35, '№ 640', '06.10.2026'],
  [3, 'Петрович', 'primavera', 'Гипсокартон 12,5 мм', 'м2', '350,40', 'Отделка квартир', '07.10.2026'],
  [4, 'Петрович', 'дом56(не реновация)', 'Профиль ПН 50', 'шт', 210, '', '07.10.2026'],
  [5, 'Петрович', 'дом56(не реновация)', 'Профиль ПН 50', 'шт', 210, '', '07.10.2026'],
  [6, 'Леруа', 'Primavera', 'Шпаклёвка', 'кг', 'по запросу', '', '07.10.2026'],
]

describe('Реестр СУ-10: загрузка расценок из Excel — страница', { skip, timeout: 300000 }, () => {
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

  const open = async (query = '', viewport = { width: 1500, height: 950 }) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.goto(`${stand.url}?route=${encodeURIComponent('/rates-registry?tab=supply')}&latency=0${query}`)
    await page.locator('.rr-table tbody tr').first().waitFor({ timeout: 120000 })
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }
  const upload = async (page, rows) => {
    await page.getByRole('button', { name: 'Загрузить из Excel' }).click()
    const dialog = page.getByRole('dialog', { name: 'Загрузка расценок СУ-10 из Excel' })
    await dialog.getByRole('button', { name: 'Выбрать файл' }).waitFor()
    await dialog.locator('input[type=file]').setInputFiles({ name: 'Расценки снабжения.xlsx', mimeType: XLSX_MIME, buffer: registryXlsx(rows) })
    await dialog.locator('.sri-objects').waitFor()
    return dialog
  }
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

  it('колонка «Источник», загрузка: объекты файла, разово «Primavera = к14», итог строк; запись по кнопке; строки — в таблице', async () => {
    const { page, errors, dialogs, close } = await open()
    try {
      const heads = await page.locator('.rr-table thead th').allTextContents()
      assert.equal(heads[1], 'Источник')
      assert.equal(await page.locator('.rr-table tbody tr').count(), 2)
      const dialog = await upload(page, FILE_ROWS)

      // Объекты файла: распознанные — сами; «primavera» — разово к14 (отметка видна); «Primavera» — то же название.
      const objRow = (label) => dialog.locator('.sri-objects tbody tr').filter({ has: page.locator('.sri-label', { hasText: new RegExp(`^${label}$`) }) })
      assert.equal(await objRow('Зил33').locator('select').inputValue(), 'sr-zil33')
      assert.equal(await objRow('дом56\\(не реновация\\)').locator('select').inputValue(), 'sr-dom56')
      assert.equal(await objRow('primavera').locator('select').inputValue(), 'sr-prim14')
      assert.match(await objRow('primavera').innerText(), /разово/)
      const once = dialog.locator('.sri-once input[type=checkbox]')
      assert.equal(await once.isChecked(), true)
      assert.match(await dialog.locator('.sri-once').innerText(), /ЖК Primavera к14/)

      // Итог строк: уже в реестре 1, повтор 1, ошибка 1, к загрузке 3.
      const filters = await dialog.locator('.kpr-filter').allInnerTexts()
      assert.deepEqual(filters.map((t) => t.replace(/\s+/g, '')), ['Все6', 'Кзагрузке3', 'Ужевреестре1', 'Повторвфайле1', 'Сошибкой1'])
      assert.match(await dialog.locator('tr.is-error').innerText(), /цена не число: «по запросу»/)
      // Тендер «№ 640» — найден по номеру.
      assert.match(await dialog.locator('.sri-lines tr', { hasText: 'Клей плиточный' }).innerText(), /№ 640/)

      // Снять разовое правило — «primavera» не выбран; вернуть.
      await once.uncheck()
      assert.equal(await objRow('primavera').locator('select').inputValue(), '')
      assert.match(await objRow('primavera').innerText(), /несколько похожих \(3\)/)
      await once.check()

      assert.equal((await page.evaluate(() => window.__supplyImportCalls.length)), 0, 'до кнопки ничего не записано')
      await dialog.getByRole('button', { name: 'Загрузить в реестр: 3' }).click()
      await page.locator('.kpr-notice', { hasText: 'в реестр добавлено 3' }).waitFor()
      const calls = await page.evaluate(() => window.__supplyImportCalls)
      assert.deepEqual(calls, [{ p_import: null, p_file_name: 'Расценки снабжения.xlsx', p_options: { primavera: 'k14' }, rows: 3 }])
      assert.deepEqual(dialogs, [], 'все объекты выбраны — вопроса нет')

      // Новые строки — в таблице сразу: источник, объект портала, тендер текстом без ссылки.
      await page.locator('.rr-table tbody tr', { hasText: 'Гипсокартон 12,5 мм' }).waitFor()
      const gk = page.locator('.rr-table tbody tr', { hasText: 'Гипсокартон 12,5 мм' })
      assert.match(await gk.locator('.rr-td-source').innerText(), /Петрович/)
      assert.match(await gk.locator('.rr-td-object').innerText(), /ЖК Primavera к14/)
      assert.equal(await gk.locator('.rr-td-tender a').count(), 0)
      assert.match(await gk.locator('.rr-td-tender').innerText(), /Отделка квартир/)
      const glue = page.locator('.rr-table tbody tr', { hasText: 'Клей плиточный' }).filter({ hasText: 'Сайт СУ-10' })
      assert.equal(await glue.locator('.rr-td-tender a').count(), 1, 'тендер найден — ссылкой')

      // Тот же файл ещё раз: разового правила больше нет, «primavera» — выбрать; всё уже в реестре.
      const again = await upload(page, FILE_ROWS)
      assert.equal(await again.locator('.sri-once').count(), 0)
      const againRows = again.locator('.sri-objects tbody tr').filter({ has: page.locator('.sri-label', { hasText: /^primavera$/ }) })
      assert.equal(await againRows.locator('select').inputValue(), '')
      await againRows.locator('select').selectOption('sr-prim14')
      const againFilters = await again.locator('.kpr-filter').allInnerTexts()
      assert.deepEqual(againFilters.map((t) => t.replace(/\s+/g, '')), ['Все6', 'Ужевреестре5', 'Сошибкой1'])
      assert.equal(await again.getByRole('button', { name: 'Загрузить в реестр: 0' }).isDisabled(), true)

      // Удаление загрузки — в окне, строки уходят из реестра.
      await again.getByRole('button', { name: 'другой файл' }).click()
      const imp = again.locator('.sri-imports-table tbody tr', { hasText: 'Расценки снабжения.xlsx' })
      assert.match(await imp.innerText(), /Инженер Стендов\s+3/)
      await imp.getByRole('button', { name: 'Удалить' }).click()
      await again.locator('.sri-imports').waitFor({ state: 'detached' })
      assert.match(dialogs.at(-1), /Удалить загрузку «Расценки снабжения\.xlsx»/)
      await again.getByRole('button', { name: 'Закрыть' }).last().click()
      await page.locator('.rr-table tbody tr', { hasText: 'Гипсокартон 12,5 мм' }).waitFor({ state: 'detached' })
      assert.equal(await page.locator('.rr-table tbody tr').count(), 2)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('не выбранный объект — вопрос перед записью; строка уходит с названием из файла', async () => {
    const { page, dialogs, close } = await open()
    try {
      const dialog = await upload(page, [[1, 'Петрович', 'Неведомый ЖК', 'Саморез 3,5х25', 'шт', 2, '', '07.10.2026']])
      assert.match(await dialog.locator('.sri-objects').innerText(), /нет — выберите/)
      await dialog.getByRole('button', { name: 'Загрузить в реестр: 1' }).click()
      await page.locator('.kpr-notice', { hasText: 'в реестр добавлено 1' }).waitFor()
      assert.match(dialogs[0], /У 1 из 1 строк объект портала не выбран/)
      assert.match(await page.locator('.rr-table tbody tr', { hasText: 'Саморез 3,5х25' }).locator('.rr-td-object').innerText(), /Неведомый ЖК/)
    } finally {
      await close()
    }
  })

  it('телефон: окно во весь экран, таблица строк прокручивается внутри', async () => {
    const { page, close } = await open('', { width: 390, height: 844 })
    try {
      const dialog = await upload(page, FILE_ROWS)
      const box = await dialog.boundingBox()
      assert.ok(box.width >= 388 && box.height >= 840, JSON.stringify(box))
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      assert.ok(overflow <= 1, `страница шире экрана на ${overflow}px`)
    } finally {
      await close()
    }
  })

  it('без права правки реестра и без миграции — кнопки нет, вкладка работает', async () => {
    for (const query of ['&canEdit=0', '&supplyImportMissing=1']) {
      const { page, errors, close } = await open(query)
      try {
        await page.waitForTimeout(300)
        assert.equal(await page.getByRole('button', { name: 'Загрузить из Excel' }).count(), 0, query)
        assert.equal(await page.locator('.rr-table tbody tr').count(), 2, query)
        assert.deepEqual(errors, [], query)
      } finally {
        await close()
      }
    }
  })
})
