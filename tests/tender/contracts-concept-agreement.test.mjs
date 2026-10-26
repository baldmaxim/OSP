// «Договоры и ДС» (/contracts): понятийное соглашение под номером договора.
//   • после загрузки и удаления файла перечитываются только файлы этого договора: реестр не пропадает под
//     «Загрузка...» и не запрашивается заново (раньше — весь реестр, приложения и файлы: на тысячах договоров
//     больше сотни запросов и полная перерисовка, браузер на секунды переставал отвечать);
//   • файл записан к своему договору с doc_category='concept_agreement' и виден в строке сразу.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const BASE = 'route=/contracts&contracts=600&cps=6&items=20&latency=20'

describe('Договоры и ДС: понятийное соглашение', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 600000 }, () => {
  let stand
  let browser

  before(async () => {
    stand = await startStand(REPO)
    browser = await chromium.launch({ ...launch, headless: true })
    // Прогрев: первая загрузка компилирует модули dev-сервером.
    const page = await browser.newPage()
    await page.goto(`${stand.url}?route=/contracts&contracts=20&latency=0`)
    await page.locator('.contracts-table tbody tr.contract-row').first().waitFor({ timeout: 120000 })
    await page.close()
  })
  after(async () => {
    await browser?.close()
    await stand?.server.close()
  })

  it('загрузка и удаление файла не перезагружают реестр', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => d.accept())
    try {
      await page.goto(`${stand.url}?${BASE}`)
      await page.locator('.contracts-table tbody tr.contract-row').first().waitFor({ timeout: 60000 })
      // Файлы договоров догружаются после таблицы — ждём их.
      await page.locator('.contracts-table .ca-chip').first().waitFor({ timeout: 60000 })

      const free = page.locator('.contracts-table tbody tr.contract-row').filter({ hasNot: page.locator('.ca-chip') }).first()
      const number = (await free.locator('.cds-main').innerText()).replace(/^№\s*/, '')
      // Строка — по номеру договора: после загрузки у неё появится файл, и «строка без файла» станет другой.
      const row = page.locator('.contracts-table tbody tr.contract-row', { has: page.locator('.cds-main', { hasText: new RegExp(`^№ ${number}$`) }) })
      const contractId = await page.evaluate((n) => window.__fakeDb.contracts.find(c => c.contract_number === n).id, number)

      const mark = await page.evaluate(() => {
        window.__sawLoader = false
        window.__loaderWatch = new MutationObserver(() => { if (document.querySelector('.loading')) window.__sawLoader = true })
        window.__loaderWatch.observe(document.body, { childList: true, subtree: true })
        return window.__supabaseStats.requests.length
      })
      const since = () => page.evaluate((m) => window.__supabaseStats.requests.slice(m).map(r => `${r.table}:${r.op}`), mark)

      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), row.locator('.ca-add').click()])
      await chooser.setFiles({ name: 'Понятийное 7.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') })
      await row.locator('.ca-chip-label', { hasText: 'Понятийное 7.pdf' }).waitFor({ timeout: 30000 })

      const saved = await page.evaluate(() => window.__fakeDb.s3_documents.find(d => d.file_name === 'Понятийное 7.pdf'))
      assert.equal(saved.owner_type, 'contract')
      assert.equal(saved.owner_id, contractId, 'файл записан к договору своей строки')
      assert.equal(saved.doc_category, 'concept_agreement')

      let requests = await since()
      assert.ok(!requests.includes('contracts:select'), `реестр не перечитывается: ${requests.join(', ')}`)
      assert.ok(!requests.includes('contract_appendices:select'), 'приложения не перечитываются')
      assert.equal(requests.filter(r => r === 's3_documents:select').length, 1, 'перечитаны только файлы этого договора')
      assert.ok(await row.locator('.ca-add').isVisible(), 'после загрузки снова можно добавить файл')

      // Удаление — так же: только файлы договора.
      await row.locator('.ca-has', { hasText: 'Понятийное 7.pdf' }).locator('.ca-danger').click()
      await row.locator('.ca-chip-label', { hasText: 'Понятийное 7.pdf' }).waitFor({ state: 'detached', timeout: 30000 })
      assert.equal(await page.evaluate(() => window.__fakeDb.s3_documents.some(d => d.file_name === 'Понятийное 7.pdf')), false)

      requests = await since()
      assert.ok(!requests.includes('contracts:select'), `реестр не перечитывается и при удалении: ${requests.join(', ')}`)
      assert.equal(await page.evaluate(() => window.__sawLoader), false, 'таблица ни разу не сменилась на «Загрузка...»')
      assert.deepEqual(errors, [])
    } finally {
      await context.close().catch(() => {})
    }
  })
})
