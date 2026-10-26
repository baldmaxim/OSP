// Контрагенты (/general/counterparties): добавочный номер у телефона контактного лица.
//   • хранится в той же строке, что и номер: «+7(916)712-69-10 доб. 123», у каждого номера (через «;») — свой;
//   • в форме контакта у каждого номера поле «Добавочный» (только цифры);
//   • в реестре добавочный — строкой под номером, ссылка для звонка набирает его после паузы (tel:…,123);
//     так же в карточке контрагента.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { splitPhoneExt, joinPhoneExt, formatPhoneEntry, phoneHref } from '../../src/utils/phoneFormat.js'

const launch = browserLaunchOptions()
const BASE = 'route=/general/counterparties&cps=6&cpContacts=1&phoneExt=1&items=20&latency=0'

describe('Добавочный номер: разбор и ссылка', () => {
  it('номер и добавочный — из строки и обратно', () => {
    assert.deepEqual(splitPhoneExt('+7(916)712-69-10 доб. 123'), { number: '+7(916)712-69-10', ext: '123' })
    assert.deepEqual(splitPhoneExt('+7(916)712-69-10'), { number: '+7(916)712-69-10', ext: '' })
    // Прежние записи из Excel.
    assert.deepEqual(splitPhoneExt('8 727 300-00-00, доп.45'), { number: '8 727 300-00-00', ext: '45' })
    assert.deepEqual(splitPhoneExt('+7 727 300 00 00 вн 7'), { number: '+7 727 300 00 00', ext: '7' })
    assert.deepEqual(splitPhoneExt('доб. 12'), { number: '', ext: '12' })
    assert.equal(joinPhoneExt('+7(916)712-69-10', '12a3'), '+7(916)712-69-10 доб. 123')
    assert.equal(joinPhoneExt('+7(916)712-69-10', ''), '+7(916)712-69-10')
    assert.equal(joinPhoneExt('', '5'), 'доб. 5')
    assert.equal(joinPhoneExt('+7(916)712-69-10', '12345678'), '+7(916)712-69-10 доб. 123456', 'не больше 6 цифр')
    assert.equal(formatPhoneEntry('89167126910 доб. 77'), '+7(916)712-69-10 доб. 77')
    assert.equal(formatPhoneEntry('+7 701 111 22 33'), '+7(701)111-22-33')
  })

  it('ссылка для звонка: цифры номера, добавочный после паузы', () => {
    assert.equal(phoneHref('+7(916)712-69-10 доб. 123'), 'tel:+79167126910,123')
    assert.equal(phoneHref('+7 701 555-12-34'), 'tel:+77015551234')
    assert.equal(phoneHref('доб. 12'), undefined)
    assert.equal(phoneHref(''), undefined)
  })
})

describe('Добавочный номер в реестре контрагентов', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 600000 }, () => {
  let stand
  let browser

  before(async () => {
    stand = await startStand(REPO)
    browser = await chromium.launch({ ...launch, headless: true })
    // Прогрев: первая загрузка компилирует модули dev-сервером.
    const page = await browser.newPage()
    await page.goto(`${stand.url}?${BASE}`)
    await page.locator('table.compact-table tbody tr.table-row').first().waitFor({ timeout: 120000 })
    await page.close()
  })
  after(async () => {
    await browser?.close()
    await stand?.server.close()
  })

  async function openPage() {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => d.accept())
    await page.goto(`${stand.url}?${BASE}`)
    await page.locator('table.compact-table tbody tr.table-row').first().waitFor({ timeout: 60000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const cpRow = (page, name) => page.locator('table.compact-table tbody tr.table-row', { hasText: name })

  it('реестр и карточка: добавочный под номером, звонок набирает его', async () => {
    const { page, errors, close } = await openPage()
    try {
      const link = cpRow(page, 'Подрядчик 01').locator('.col-contact-phone a.contact-link').first()
      assert.equal(await link.getAttribute('href'), 'tel:+77015551234,123')
      assert.equal(await link.locator('.phone-ext').innerText(), 'доб. 123')
      const lines = await link.evaluate((a) => {
        const ext = a.querySelector('.phone-ext').getBoundingClientRect()
        return { extBelow: ext.top >= a.getBoundingClientRect().top + 4, fits: a.scrollWidth <= a.closest('td').clientWidth }
      })
      assert.ok(lines.extBelow, 'добавочный — отдельной строкой')
      assert.ok(lines.fits, 'номер с добавочным помещается в колонку')
      // Второй номер — без добавочного.
      assert.equal(await cpRow(page, 'Подрядчик 01').locator('.col-contact-phone a.contact-link').nth(1).getAttribute('href'), 'tel:+77273000000')

      await cpRow(page, 'Подрядчик 01').locator('.company-name').click()
      await page.locator('.cp-detail-modal').waitFor()
      const cardLink = page.locator('.cpg-contact-links a.cpg-link[href^="tel:"]').first()
      assert.equal(await cardLink.getAttribute('href'), 'tel:+77015551234,123')
      assert.equal(await cardLink.innerText(), '+7 701 555-12-34 доб. 123')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('форма контакта: у каждого номера свой добавочный, пишется в ту же строку', async () => {
    const { page, errors, close } = await openPage()
    try {
      await cpRow(page, 'Подрядчик 02').locator('.btn-add-contact-inline').click()
      const modal = page.locator('.modal', { hasText: 'Добавить контакт' })
      await modal.waitFor()
      await modal.locator('.form-group', { hasText: 'ФИО' }).locator('input').fill('Иванов Иван Иванович')

      await modal.locator('input[type="tel"]').first().fill('89167126910')
      const ext = modal.locator('input[aria-label="Добавочный номер"]')
      assert.equal(await ext.count(), 1, 'поле добавочного у номера')
      await ext.first().fill('45a6')
      assert.equal(await modal.locator('input[type="tel"]').first().inputValue(), '+7(916)712-69-10', 'номер не задет добавочным')
      assert.equal(await ext.first().inputValue(), '456', 'в добавочном только цифры')

      await modal.getByRole('button', { name: '+ Ещё номер' }).click()
      assert.equal(await ext.count(), 2, 'у второго номера — своё поле добавочного')
      await modal.locator('input[type="tel"]').nth(1).fill('87011112233')

      await modal.getByRole('button', { name: 'Добавить', exact: true }).click()
      await modal.waitFor({ state: 'detached' })
      const saved = await page.evaluate(() => window.__fakeDb.counterparty_contacts.find(c => c.full_name === 'Иванов Иван Иванович'))
      assert.equal(saved.counterparty_id, 'cp-2')
      assert.equal(saved.phone, '+7(916)712-69-10 доб. 456; +7(701)111-22-33')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
