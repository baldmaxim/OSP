// Реестр расценок → «Расценки от подрядчиков (КП)» (миграция 20261122) в Chromium (стенд tests/tender/ui, маршрут
// /rates-registry): колонка «Документ (ВОР)» рядом с описанием тендера — файл КП и ВОР, кабинет подрядчика, ручная
// расценка со ссылкой; фильтр по источнику; «Добавить расценку» (подрядчик обязателен, ссылка или файл); «Проверить
// по файлу» — распознанный счёт против реестра (дороже / в рынке / нет аналогов), добавление отмеченных строк в
// реестр с файлом документом; удаление ручной расценки; без права правки — только проверка; база раньше миграции —
// реестр как прежде, без колонки и кнопок. Данные стенда вымышленные.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import * as XLSX from 'xlsx'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const skip = launch ? false : 'нет Chromium (Playwright, Chrome или PSDC_BROWSER)'

function invoiceXlsx() {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Счёт на оплату № 77 от 29.10.2026'], [],
    ['№', 'Товар', 'Кол-во', 'Ед.', 'Цена', 'Сумма'],
    [1, 'Кабель ВВГнг(А)-LS 3х2,5', 500, 'м', 180, 90000],
    [2, 'Лоток перфорированный 100х50', 40, 'м', 440, 17600],
    [3, 'Розетка накладная двойная', 12, 'шт', 350, 4200],
    ['', 'Итого', '', '', '', 111800],
    ['В том числе НДС 22 %'],
  ]), 'TDSheet')
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
}

describe('Реестр КП: документ строки, ручные расценки, проверка по файлу — страница', { skip, timeout: 300000 }, () => {
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
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1500, height: 950 } })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.goto(`${stand.url}?route=/rates-registry&latency=0${query}`)
    await page.locator('.rr-table tbody tr').first().waitFor({ timeout: 120000 })
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }
  const rowOf = (page, name) => page.locator('.rr-table tbody tr', { hasText: name })
  const pick = async (page, scope, trigger, label) => {
    await scope.locator('.fdrop').filter({ hasText: trigger }).locator('.fdrop-trigger').click()
    const panel = page.locator('.fdrop-panel')
    const search = panel.locator('.fdrop-search')
    if (await search.count()) await search.fill(label.slice(0, 8))
    await panel.locator('.fdrop-option', { hasText: label }).first().click()
  }

  it('«Документ (ВОР)» — рядом с описанием тендера: файл КП и ВОР, кабинет подрядчика, ручная расценка со ссылкой', async () => {
    const { page, errors, close } = await open()
    try {
      const heads = await page.locator('.rr-table thead th').allTextContents()
      const at = heads.findIndex((h) => h.startsWith('Описание работ (тендер)'))
      assert.equal(heads[at + 1], 'Документ (ВОР)')
      const kp = rowOf(page, 'КП Стенд-Электро.xlsx').first()
      await assert.doesNotReject(kp.waitFor())
      assert.match(await kp.locator('.rr-td-doc').innerText(), /КП Стенд-Электро\.xlsx\s*ВОР: ВОР ЭОМ/)
      assert.match(await rowOf(page, 'ООО Кабельщик').filter({ hasText: 'ВВГнг' }).locator('.rr-td-doc').innerText(), /файл КП не найден\s*ВОР: ВОР ЭОМ/)
      const site = rowOf(page, 'кабинет подрядчика')
      assert.equal(await site.count(), 1)
      const manual = rowOf(page, 'добавлено вручную')
      assert.equal(await manual.count(), 1)
      assert.equal(await manual.locator('a', { hasText: 'Открыть документ' }).getAttribute('href'), 'https://disk.example.invalid/kp-lotok.pdf')
      assert.match(await manual.innerText(), /Цена с доставкой до объекта/)
      assert.equal(await manual.getByRole('button', { name: /Изменить расценку/ }).count(), 1)
      // Файл КП открывается просмотром.
      await kp.locator('.kpr-doc-file').click()
      await page.locator('.s3-doc-modal, .s3-doc-preview').first().waitFor({ timeout: 10000 })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('фильтр «Источник»: только добавленные вручную — запросом к базе', async () => {
    const { page, errors, close } = await open()
    try {
      await pick(page, page.locator('.rr-filters'), 'Все источники', 'Добавлено вручную')
      await page.waitForFunction(() => document.querySelectorAll('.rr-table tbody tr').length === 1)
      assert.match(await page.locator('.rr-table tbody tr').innerText(), /Лоток перфорированный/)
      const asked = await page.evaluate(() => window.__supabaseStats.requests.filter((r) => r.table === 'kp_rates_registry').length)
      assert.ok(asked > 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Добавить расценку»: подрядчик обязателен; ссылка на документ; строка сразу в реестре', async () => {
    const { page, errors, close } = await open()
    try {
      await page.getByRole('button', { name: '+ Добавить расценку' }).click()
      const dlg = page.getByRole('dialog', { name: 'Добавить расценку подрядчика' })
      await dlg.getByLabel('Наименование').fill('Кабель ВВГнг(А)-LS 3х4')
      await dlg.getByLabel('Ед. изм.').fill('м')
      await dlg.getByLabel('Цена за единицу с НДС, ₽').fill('1500,5')
      await dlg.getByRole('button', { name: 'Добавить в реестр' }).click()
      await dlg.getByText('Выберите подрядчика').last().waitFor()
      assert.match(await dlg.locator('.kpr-error').innerText(), /подрядчика/)
      await pick(page, dlg, 'Выберите подрядчика', 'ООО Кабельщик')
      await pick(page, dlg, 'Без тендера', 'Электромонтаж корпуса 1')
      await dlg.getByLabel('ссылка или сетевой путь').check()
      await dlg.getByLabel('Ссылка на документ').fill('ftp://x')
      await dlg.getByRole('button', { name: 'Добавить в реестр' }).click()
      assert.match(await dlg.locator('.kpr-error').innerText(), /https/)
      await dlg.getByLabel('Ссылка на документ').fill('\\\\192.168.5.55\\SharA_Tender\\КП Кабельщик.pdf')
      await dlg.getByRole('button', { name: 'Добавить в реестр' }).click()
      await dlg.waitFor({ state: 'detached' })
      await page.locator('.kpr-notice', { hasText: 'Расценка добавлена в реестр' }).waitFor()
      const saved = await page.evaluate(() => window.__fakeDb.kp_manual_rates.find((r) => r.item_name === 'Кабель ВВГнг(А)-LS 3х4'))
      assert.equal(saved.price, 1500.5)
      assert.equal(saved.counterparty_id, 'kr-cp-2')
      assert.equal(saved.tender_id, 'kr-t1')
      assert.equal(saved.object_id, 'kr-obj-1', 'объект подставлен из тендера')
      assert.equal(saved.item_type, 'material', 'вид — открытой подвкладки')
      assert.equal(saved.doc_url, '\\\\192.168.5.55\\SharA_Tender\\КП Кабельщик.pdf')
      const row = rowOf(page, 'Кабель ВВГнг(А)-LS 3х4')
      await row.waitFor()
      assert.match(await row.innerText(), /добавлено вручную/)
      assert.equal(await row.getByRole('button', { name: 'Скопировать путь к документу' }).count(), 1)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Проверить по файлу»: дороже реестра, в рынке, нет аналогов; отмеченные — в реестр с файлом документом', async () => {
    const { page, errors, close } = await open()
    try {
      await page.getByRole('button', { name: 'Проверить по файлу' }).click()
      const dlg = page.getByRole('dialog', { name: 'Проверка расценок по файлу' })
      await dlg.locator('input[type=file]').setInputFiles({ name: 'Счёт 77.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: invoiceXlsx() })
      await dlg.locator('.kpr-table tbody tr').first().waitFor({ timeout: 20000 })
      const line = (name) => dlg.locator('.kpr-table tbody tr', { hasText: name }).first()
      // Кабель: в реестре 100 и 120 (медиана 110), в счёте 180 с НДС — дороже.
      assert.match(await line('Кабель ВВГнг(А)-LS 3х2,5').innerText(), /100\s*·\s*110\s*·\s*120[\s\S]*дороже реестра[\s\S]*\+63,6 %/)
      // Лоток: 450 (кабинет) и 430 (вручную) — медиана 440, в счёте 440: в рынке.
      assert.match(await line('Лоток перфорированный').innerText(), /в рынке/)
      assert.match(await line('Розетка накладная').innerText(), /нет аналогов/)
      assert.match(await dlg.locator('.kpr-filters').innerText(), /Дороже реестра\s*1/)
      const calls = await page.evaluate(() => window.__lookupCalls)
      assert.equal(calls.length, 1, 'строки — одним вызовом поиска')
      assert.deepEqual(calls[0].names, ['Кабель ВВГнг(А)-LS 3х2,5', 'Лоток перфорированный 100х50', 'Розетка накладная двойная'])
      // Добавить строку розетки — расценкой подрядчика с файлом счёта.
      await line('Розетка накладная').locator('input[type=checkbox]').check()
      await pick(page, dlg, 'Выберите подрядчика', 'ООО Стенд-Электро')
      await dlg.getByRole('button', { name: 'Добавить в реестр: 1' }).click()
      await dlg.waitFor({ state: 'detached' })
      await page.locator('.kpr-notice', { hasText: 'Добавлено в реестр расценок: 1' }).waitFor()
      const added = await page.evaluate(() => {
        const r = window.__fakeDb.kp_manual_rates.find((x) => x.item_name === 'Розетка накладная двойная')
        const doc = window.__fakeDb.s3_documents.find((d) => d.id === r?.s3_document_id)
        return r && { price: r.price, unit: r.unit, cp: r.counterparty_id, kind: r.item_type, doc: doc && [doc.owner_type, doc.owner_id === r.id, doc.doc_category, doc.file_name] }
      })
      assert.deepEqual(added, { price: 350, unit: 'шт', cp: 'kr-cp-1', kind: 'material', doc: ['general', true, 'kp_manual_rate', 'Счёт 77.xlsx'] })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('правка ручной расценки: поля из базы, новая цена; ссылка заменяется файлом', async () => {
    const { page, errors, close } = await open()
    try {
      await rowOf(page, 'добавлено вручную').getByRole('button', { name: /Изменить расценку/ }).click()
      const dlg = page.getByRole('dialog', { name: 'Расценка, добавленная вручную' })
      await assert.doesNotReject(dlg.getByLabel('Наименование').waitFor())
      await page.waitForFunction(() => document.querySelector('#kpr-name')?.value === 'Лоток перфорированный 100х50')
      assert.equal(await dlg.getByLabel('Цена за единицу с НДС, ₽').inputValue(), '430')
      assert.equal(await dlg.getByLabel('Ссылка на документ').inputValue(), 'https://disk.example.invalid/kp-lotok.pdf')
      await dlg.getByLabel('Цена за единицу с НДС, ₽').fill('415')
      await dlg.getByLabel('файл', { exact: true }).check()
      await dlg.locator('input[type=file]').setInputFiles({ name: 'КП лоток.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') })
      await dlg.getByRole('button', { name: 'Сохранить' }).click()
      await dlg.waitFor({ state: 'detached' })
      await page.locator('.kpr-notice', { hasText: 'Расценка сохранена' }).waitFor()
      const r = await page.evaluate(() => {
        const m = window.__fakeDb.kp_manual_rates[0]
        const doc = window.__fakeDb.s3_documents.find((d) => d.id === m.s3_document_id)
        return { price: m.price, url: m.doc_url, file: doc?.file_name, by: m.created_by_name }
      })
      assert.deepEqual(r, { price: 415, url: null, file: 'КП лоток.pdf', by: 'Инженер Стендов' })
      await rowOf(page, 'КП лоток.pdf').waitFor()
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('удаление ручной расценки — после подтверждения', async () => {
    const { page, errors, dialogs, close } = await open()
    try {
      const manual = rowOf(page, 'добавлено вручную')
      await manual.getByRole('button', { name: /Удалить расценку/ }).click()
      await page.locator('.kpr-notice', { hasText: 'Расценка удалена' }).waitFor()
      assert.match(dialogs[0], /Удалить расценку «Лоток перфорированный 100х50»/)
      assert.equal(await page.evaluate(() => window.__fakeDb.kp_manual_rates.length), 0)
      await page.waitForFunction(() => !document.querySelector('.kpr-tag.is-manual'))
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без права правки: проверка по файлу есть, добавить и изменить — нет', async () => {
    const { page, errors, close } = await open('&canEdit=0')
    try {
      assert.equal(await page.getByRole('button', { name: '+ Добавить расценку' }).count(), 0)
      assert.equal(await page.getByRole('button', { name: /Изменить расценку|Удалить расценку/ }).count(), 0)
      await page.getByRole('button', { name: 'Проверить по файлу' }).click()
      const dlg = page.getByRole('dialog', { name: 'Проверка расценок по файлу' })
      await dlg.locator('input[type=file]').setInputFiles({ name: 'Счёт.xlsx', mimeType: 'application/octet-stream', buffer: invoiceXlsx() })
      await dlg.locator('.kpr-table tbody tr').first().waitFor({ timeout: 20000 })
      assert.equal(await dlg.locator('.kpr-add').count(), 0)
      assert.equal(await dlg.getByRole('button', { name: /Добавить в реестр/ }).count(), 0)
      assert.equal(await dlg.getByRole('button', { name: 'Выгрузить проверку в Excel' }).count(), 1)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('база раньше миграции: реестр как прежде — без колонки «Документ (ВОР)» и кнопок', async () => {
    const { page, errors, close } = await open('&kpRegistryLegacy=1')
    try {
      await page.waitForFunction(() => [...document.querySelectorAll('.rr-table thead th')].length === 8)
      const heads = await page.locator('.rr-table thead th').allTextContents()
      assert.ok(!heads.includes('Документ (ВОР)'))
      assert.equal(await page.getByRole('button', { name: 'Проверить по файлу' }).count(), 0)
      assert.equal(await page.getByRole('button', { name: '+ Добавить расценку' }).count(), 0)
      assert.ok(await page.locator('.rr-table tbody tr').count() >= 3)
      // Колонки спрошены один раз: первая выборка (с колонками источника — 42703) и повтор без них; дальше — сразу без них.
      const pageLoads = () => page.evaluate(() => window.__supabaseStats.requests
        .filter((r) => r.table === 'kp_rates_registry' && r.op === 'select' && !r.count).length)
      assert.equal(await pageLoads(), 2)
      await page.getByRole('tab', { name: /Работы/ }).click()
      await page.waitForFunction(() => document.querySelector('.rr-sub-tab.active')?.textContent.startsWith('Работы'))
      await page.locator('.rr-table tbody tr', { hasText: 'Прокладка кабеля' }).waitFor()
      assert.equal(await pageLoads(), 3, 'подвкладка «Работы» — одна выборка, колонки не спрашиваются снова')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
