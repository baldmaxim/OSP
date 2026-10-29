// Скачивание файла без новой вкладки и без ухода со страницы (components/FileDownload.jsx, 29.10.2026: «чтобы
// визуально не обновлялась страница при нажатии скачки в любом месте сайта»). Раньше подписанная ссылка открывалась
// в новой вкладке (target=_blank) или в этой же (location.assign) — окно мигало.
// Стенд tests/tender/ui: window.__fakeRemoteFiles — ссылка ведёт в «хранилище» на другом домене, как настоящая
// (переход по ней открыл бы вкладку), __fakeFileDelay — хранилище отвечает не сразу.
//   • «Проверка КП»: КП скачивается под своим именем, вкладок и переходов нет; нет файла в хранилище — сообщение;
//   • окно просмотра файла (docx): «Скачать» — так же; долгий файл — плашка внизу с отменой, повторное нажатие
//     второй файл не качает.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { kpDownloadName } from '../../src/utils/kpDownloadName.js'

const launch = browserLaunchOptions()

describe('Скачивание файла: без новой вкладки и перехода', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open(query, ready, flags) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 }, acceptDownloads: true })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    const popups = []
    const downloads = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept().catch(() => {}) })
    page.on('download', (d) => downloads.push(d))
    context.on('page', (p) => popups.push(p.url()))
    await page.addInitScript((f) => {
      Object.assign(window, f)
      window.__leaving = 0
      window.addEventListener('beforeunload', () => { window.__leaving += 1 })
    }, { __fakeRemoteFiles: true, ...flags })
    await page.goto(`${stand.url}?${query}&latency=10`)
    await page.locator(ready).first().waitFor({ timeout: 120000 })
    const url = page.url()
    // Страница не уходила и не начинала уходить, вкладок не открывалось.
    const stayed = async () => {
      assert.deepEqual(popups, [], 'новых вкладок нет')
      assert.equal(page.url(), url)
      assert.equal(await page.evaluate(() => window.__leaving), 0, 'страница не начинала уходить')
    }
    return { context, page, errors, dialogs, downloads, stayed, close: () => context.close() }
  }

  const openKp = (flags = {}) => open('route=/kp-review&kpReview=1', '.kprv-table', flags)
  const openPreview = (flags = {}) => open(`route=${encodeURIComponent('/dc-requests?file=dcf-2')}&dcStats=1&shell=1`,
    '.s3-doc-modal button.s3-doc-btn-primary', flags)
  const kpButton = async (page) => {
    await page.locator('.kprv-stage[data-stage="all"]').click()
    return page.locator('.kprv-kp[data-kp="kp-2"] .kprv-icon-btn[aria-label="Скачать КП"]')
  }

  it('«Проверка КП»: КП — под своим именем, без вкладки и перехода', async () => {
    const { page, errors, dialogs, stayed, close } = await openKp()
    try {
      const seed = await page.evaluate(() => {
        const r = window.__fakeDb.tender_proposal_files.find((f) => f.id === 'kp-2')
        return { s3: { file_name: r.s3.file_name }, counterparties: r.counterparties, tenders: r.tenders }
      })
      const dl = await kpButton(page)
      const [download] = await Promise.all([page.waitForEvent('download'), dl.click()])
      assert.equal(download.suggestedFilename(), kpDownloadName(seed))
      await stayed()
      assert.deepEqual(dialogs, [])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('нет файла в хранилище — сообщение, страница на месте', async () => {
    const { page, errors, dialogs, downloads, stayed, close } = await openKp({ __fakeRemoteFiles: 'missing' })
    try {
      await (await kpButton(page)).click()
      await page.waitForFunction(() => !document.querySelector('.kprv-icon-btn[aria-label="Скачать КП"][disabled]'))
      await page.waitForTimeout(200)
      assert.deepEqual(dialogs, ['Не удалось скачать КП: файла нет в хранилище'])
      assert.equal(downloads.length, 0)
      await stayed()
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('окно просмотра: долгий файл — плашка внизу, повторное нажатие второй файл не качает', async () => {
    const { page, errors, dialogs, downloads, stayed, close } = await openPreview({ __fakeFileDelay: 1200 })
    try {
      const btn = page.locator('.s3-doc-modal button.s3-doc-btn-primary')
      const first = page.waitForEvent('download')
      await btn.click()
      const toast = page.locator('.fdl-toast')
      await toast.waitFor()
      assert.match(await toast.innerText(), /Скачиваем «Письмо\.docx»/)
      await btn.click()
      assert.equal((await first).suggestedFilename(), 'Письмо.docx')
      await toast.waitFor({ state: 'detached' })
      await page.waitForTimeout(300)
      assert.equal(downloads.length, 1, 'один файл')
      await stayed()
      assert.deepEqual(dialogs, [])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('отмена на плашке: файла нет, сообщений нет', async () => {
    const { page, errors, dialogs, downloads, stayed, close } = await openPreview({ __fakeFileDelay: 5000 })
    try {
      await page.locator('.s3-doc-modal button.s3-doc-btn-primary').click()
      await page.locator('.fdl-toast').waitFor()
      await page.getByRole('button', { name: 'Отменить скачивание «Письмо.docx»' }).click()
      await page.locator('.fdl-toast').waitFor({ state: 'detached', timeout: 1000 })
      await page.waitForTimeout(300)
      assert.equal(downloads.length, 0)
      assert.equal(await page.locator('.s3-doc-error').count(), 0)
      await stayed()
      assert.deepEqual(dialogs, [])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
