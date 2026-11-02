// Реестр расценок → «Договорные расценки (Larix)» → «Проверить по файлу» в Chromium (стенд tests/tender/ui, маршрут
// /rates-registry): файл бросают в окно — договорные цены, отклонение и итог; снять и включить расценку; цена материалов
// и работ, период договоров; незаполненный ВОР и две колонки цены; весь реестр читается страницами; база прежнего
// портала — кнопки нет. Данные стенда вымышленные.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import * as XLSX from 'xlsx'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const skip = launch ? false : 'нет Chromium (Playwright, Chrome или PSDC_BROWSER)'

const xlsxOf = (sheets) => {
  const wb = XLSX.utils.book_new()
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
}
const invoice = () => xlsxOf({ TDSheet: [
  ['Счёт на оплату № 77'], [],
  ['№', 'Товар', 'Кол-во', 'Ед.', 'Цена', 'Сумма'],
  [1, 'Кабель ВВГнг(А)-LS 3х2,5', 500, 'м', 180, 90000],
  [2, 'Лоток перфорированный 100х50', 40, 'м', 440, 17600],
  [3, 'Гайка особая редкая', 12, 'шт', 350, 4200],
  ['', 'Итого', '', '', '', 111800], ['В том числе НДС 22 %'],
] })

describe('Договорные расценки: проверка цен по файлу — страница', { skip, timeout: 300000 }, () => {
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

  const open = async (query = '') => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1500, height: 950 }, acceptDownloads: true })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    await page.goto(`${stand.url}?route=/rates-registry&latency=0${query}`)
    await page.getByRole('tab', { name: 'Договорные расценки (Larix)' }).click()
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const openDialog = async (page) => {
    await page.getByRole('button', { name: 'Проверить по файлу' }).click()
    return page.getByRole('dialog', { name: 'Проверка цен по договорным расценкам' })
  }
  const pickFile = async (dlg, name, buffer) => {
    await dlg.locator('input[type=file]').setInputFiles({ name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer })
    await dlg.locator('.kpr-table tbody tr').first().waitFor({ timeout: 30000 })
  }
  // Бросить файл в окно: как настоящее перетаскивание, с файлом в dataTransfer.
  const dropFile = async (page, selector, name, buffer) => {
    const dataTransfer = await page.evaluateHandle(({ name: fileName, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], fileName))
      return dt
    }, { name, base64: buffer.toString('base64') })
    await page.dispatchEvent(selector, 'dragover', { dataTransfer })
    await page.dispatchEvent(selector, 'drop', { dataTransfer })
  }
  const lineOf = (dlg, name) => dlg.locator('.kpr-table > tbody > tr', { hasText: name }).first()

  it('файл бросают в зону: цены договоров, цена свежего документа, другая марка и размер — не аналоги', async () => {
    const { page, errors, close } = await open()
    try {
      const dlg = await openDialog(page)
      await dropFile(page, '.kpr-drop', 'Счёт 77.xlsx', invoice())
      await dlg.locator('.kpr-table tbody tr').first().waitFor({ timeout: 30000 })
      const cable = lineOf(dlg, 'Кабель ВВГнг(А)-LS 3х2,5')
      // Договор на 100 заменён ДС на 110; у второго подрядчика 130: медиана 120, в счёте 180.
      assert.match(await cable.innerText(), /110\s*·\s*120\s*·\s*130[\s\S]*дороже договоров[\s\S]*\+50 %/)
      assert.match(await cable.innerText(), /цен: 2, подрядчиков: 2/)
      assert.match(await cable.innerText(), /сравнивается: цена материалов, нет её — работ/)
      assert.match(await cable.innerText(), /в прежних документах: 1/, 'договор, заменённый ДС, виден в строке ДС')
      assert.match(await cable.innerText(), /Цена с доставкой/, 'примечание договора')
      assert.doesNotMatch(await cable.innerText(), /900 ₽/, 'другая марка не считается')
      // Лоток без размера и работа — только возможные: сравнивать не с чем, но видно, что есть.
      const tray = lineOf(dlg, 'Лоток перфорированный 100х50')
      assert.match(await tray.innerText(), /нет аналогов/)
      assert.match(await tray.innerText(), /только возможные/)
      assert.match(await lineOf(dlg, 'Гайка особая редкая').innerText(), /аналогов нет/)
      assert.match(await dlg.locator('.kpr-filters').innerText(), /Дороже договоров\s*1/)
      assert.match(await dlg.locator('.kpr-total').innerText(), /90\s000 ₽[\s\S]*60\s000 ₽[\s\S]*\+30\s000 ₽ \(\+50 %\)/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('файл можно бросить в любое место окна и поверх результата: браузер его не открывает, проверка идёт заново', async () => {
    const { page, errors, close } = await open()
    try {
      const url = page.url()
      const dlg = await openDialog(page)
      await dropFile(page, '.kpr-modal-head', 'Первый.xlsx', invoice())
      await dlg.locator('.kpr-table tbody tr').first().waitFor({ timeout: 30000 })
      assert.match(await dlg.locator('.kpr-file-name').innerText(), /Первый\.xlsx/)
      await dropFile(page, '.kpr-table-wrap', 'Второй.xlsx', xlsxOf({ TDSheet: [['Наименование', 'Ед.', 'Кол-во', 'Цена'], ['Герметик силиконовый', 'шт', 2, 510]] }))
      await dlg.locator('.kpr-file-name', { hasText: 'Второй.xlsx' }).waitFor({ timeout: 30000 })
      await lineOf(dlg, 'Герметик силиконовый').waitFor()
      assert.equal(await dlg.locator('.kpr-table > tbody > tr').count(), 1)
      assert.equal(page.url(), url)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('расценку снимают и включают — медиана, итог и сумма пересчитываются сразу', async () => {
    const { page, errors, close } = await open()
    try {
      const dlg = await openDialog(page)
      await pickFile(dlg, 'Счёт.xlsx', invoice())
      const cable = lineOf(dlg, 'Кабель ВВГнг(А)-LS 3х2,5')
      // Снять цену 130 — остаётся 110, файл дороже уже на 63,6 %.
      await cable.getByRole('checkbox', { name: /Учитывать: Кабель ВВГнг\(А\)-LS 3х2,5$/ }).uncheck()
      assert.match(await cable.innerText(), /110\s*·\s*110\s*·\s*110[\s\S]*\+63,6 %/)
      // Включить возможную расценку у лотка — появляются цены и итог.
      const tray = lineOf(dlg, 'Лоток перфорированный 100х50')
      await tray.getByRole('checkbox', { name: 'Учитывать: Лоток перфорированный', exact: true }).check()
      assert.match(await tray.innerText(), /450\s*·\s*450\s*·\s*450/)
      assert.match(await tray.innerText(), /в рынке/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('заполненный ВОР: материалы — с ценой материалов, работы — с ценой работ; кг в договоре и т в файле; приписка «(04.24г)» не мешает', async () => {
    const { page, errors, close } = await open()
    try {
      const dlg = await openDialog(page)
      await pickFile(dlg, 'ВОР подрядчика.xlsx', xlsxOf({
        Материалы: [['№', 'Наименование материала', 'Ед. изм.', 'Объем', 'Цена с НДС'], [1, 'Арматура А500С d12', 'т', 2, 75000], [2, 'Устройство цементно-песчаной стяжки 50 мм', 'м2', 100, 400]],
        Работы: [['№', 'Наименование работ', 'Ед. изм.', 'Объем', 'Цена с НДС'], [1, 'Устройство цементно-песчаной стяжки 50 мм', 'м2', 100, 950]],
      }))
      const rows = dlg.locator('.kpr-table > tbody > tr')
      assert.equal(await rows.count(), 3)
      const rebar = await rows.nth(0).innerText()
      assert.match(rebar, /70\s000/, 'цена договора за кг пересчитана на тонну')
      assert.match(rebar, /в договоре 70 ₽ \/ кг/)
      assert.match(rebar, /в рынке/)
      assert.match(await rows.nth(1).innerText(), /материал[\s\S]*сравнивается: цена материалов[\s\S]*400\s*·\s*400\s*·\s*400/)
      assert.match(await rows.nth(2).innerText(), /работа[\s\S]*сравнивается: цена работ[\s\S]*900\s*·\s*950\s*·\s*1\s000/)
      assert.match(await rows.nth(2).innerText(), /материалы 400 \+ работы 900/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('незаполненный ВОР не отказ: договорные цены по позициям, пометка, выгрузка в Excel', async () => {
    const { page, errors, close } = await open()
    try {
      const dlg = await openDialog(page)
      await pickFile(dlg, 'ВОР пустой.xlsx', xlsxOf({
        МАТЕРИАЛЫ: [['№', 'Наименование материала', 'Ед. изм.', 'Объем', 'ЦЕНА руб., с учетом доставки и НДС 22%', 'ИТОГО, руб. с учетом НДС 22%'], [1, 'Кабель ВВГнг(А)-LS 3х2,5', 'м', 10, '', '']],
      }))
      assert.match(await dlg.locator('.kpr-note').innerText(), /В файле нет цен/)
      const line = lineOf(dlg, 'Кабель ВВГнг(А)-LS 3х2,5')
      assert.match(await line.innerText(), /110\s*·\s*120\s*·\s*130[\s\S]*нет цены/)
      const [download] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: 'Выгрузить проверку в Excel' }).click()])
      const wb = XLSX.read(readFileSync(await download.path()))
      const out = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 })
      assert.equal(out[0][1], 'Наименование в файле')
      const at = out[0].indexOf('Медиана, ₽')
      assert.equal(out[1][at], 120)
      assert.equal(out[1][out[0].indexOf('Итог')], 'цены в файле нет')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('две колонки цены — две строки сравнения; «цену файла сравнивать с» и период договоров пересчитывают без нового файла', async () => {
    const { page, errors, close } = await open()
    try {
      const dlg = await openDialog(page)
      await pickFile(dlg, 'КП.xlsx', xlsxOf({ КП: [
        ['№', 'Наименование работ', 'Ед. изм.', 'Кол-во', 'Цена материалов с НДС', 'Цена работ с НДС'],
        [1, 'Устройство цементно-песчаной стяжки 50 мм', 'м2', 100, 400, 950],
      ] }))
      assert.equal(await dlg.locator('.kpr-table > tbody > tr').count(), 2)
      const lookups = await page.evaluate(() => window.__supabaseStats.requests.filter((r) => r.table === 'larix_rates_registry' && !r.count).length)
      // Счёт с одной ценой на монтаж — вся цена позиции; выбор в окне меняет сравнение.
      await dlg.getByRole('button', { name: 'другой файл' }).click()
      await pickFile(dlg, 'Счёт.xlsx', xlsxOf({ TDSheet: [['Наименование', 'Ед.', 'Кол-во', 'Цена'], ['Устройство цементно-песчаной стяжки 50 мм', 'м2', 10, 1300]] }))
      const line = lineOf(dlg, 'Устройство цементно-песчаной стяжки')
      assert.match(await line.innerText(), /сравнивается: материалы \+ работы[\s\S]*1\s000\s*·\s*1\s150\s*·\s*1\s300/)
      await dlg.getByLabel('Цену файла сравнивать с').selectOption({ label: 'цена работ' })
      assert.match(await line.innerText(), /сравнивается: цена работ[\s\S]*900\s*·\s*950\s*·\s*1\s000/)
      // За полгода: договор 300-дневной давности не считается.
      await dlg.getByLabel('Период договоров').selectOption({ label: 'за полгода' })
      assert.match(await line.innerText(), /1\s000\s*·\s*1\s000\s*·\s*1\s000/)
      // Реестр прочитан один раз: второй файл его не читал.
      const after = await page.evaluate(() => window.__supabaseStats.requests.filter((r) => r.table === 'larix_rates_registry' && !r.count).length)
      assert.equal(after, lookups)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('реестр больше потолка строк: читается весь, страницами, и находит строку с последней страницы', async () => {
    const { page, errors, close } = await open('&maxRows=1000&larixMany=2500')
    try {
      const dlg = await openDialog(page)
      await pickFile(dlg, 'Счёт.xlsx', xlsxOf({ TDSheet: [['Наименование', 'Ед.', 'Кол-во', 'Цена'], ['Позиция заполнения 2499', 'шт', 1, 2509]] }))
      assert.match(await dlg.locator('.kpr-summary').innerText(), /договорных расценок:\s*2\s511/)
      assert.match(await lineOf(dlg, 'Позиция заполнения 2499').innerText(), /2\s509[\s\S]*в рынке/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('нечитаемый файл — понятный отказ, можно выбрать другой; Escape закрывает', async () => {
    const { page, errors, close } = await open()
    try {
      const dlg = await openDialog(page)
      await dlg.locator('input[type=file]').setInputFiles({ name: 'Письмо.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('x') })
      await dlg.locator('.kpr-error').waitFor()
      assert.match(await dlg.locator('.kpr-error').innerText(), /Письмо\.docx.*Excel/)
      await pickFile(dlg, 'Счёт.xlsx', invoice())
      await page.keyboard.press('Escape')
      await dlg.waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('база прежнего портала, представления нет: подсказка на вкладке, кнопки нет', async () => {
    const { page, close } = await open('&larixMissing=1')
    try {
      await page.locator('.rr-error').waitFor({ timeout: 20000 })
      assert.equal(await page.getByRole('button', { name: 'Проверить по файлу' }).count(), 0)
    } finally { await close() }
  })

  it('вкладка КП: прежняя проверка работает на общих частях окна, файл бросают так же', async () => {
    const { page, errors, close } = await open()
    try {
      await page.getByRole('tab', { name: 'Расценки от подрядчиков (КП)' }).click()
      await page.getByRole('button', { name: 'Проверить по файлу' }).click()
      const dlg = page.getByRole('dialog', { name: 'Проверка расценок по файлу' })
      await dropFile(page, '.kpr-modal-head', 'Счёт.xlsx', invoice())
      await dlg.locator('.kpr-table tbody tr').first().waitFor({ timeout: 30000 })
      assert.match(await lineOf(dlg, 'Кабель ВВГнг(А)-LS 3х2,5').innerText(), /дороже реестра/)
      await dlg.getByRole('radio', { name: 'цены без НДС — добавить' }).check()
      assert.match(await lineOf(dlg, 'Лоток перфорированный').innerText(), /536,8/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
