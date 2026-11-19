// «Скачать всё» в «Должной осмотрительности» карточки контрагента (/general/counterparties → «Документы»):
// src/utils/docListArchive.js, components/DocListZipButton.jsx, проп downloadAllOwner у S3DocumentList.
// Архив «<контрагент> — Должная осмотрительность.zip» — все файлы раздела без папок, имена — исходные;
// у «Согласования СБ» кнопки нет; без права правки кнопка есть (скачивание — по праву просмотра); без файлов — нет.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import PizZipNs from 'pizzip'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  planDocListArchive, docListArchiveName, docListFailedHint, buildTenderArchive, FAILED_LIST_NAME,
} from '../../src/utils/docListArchive.js'
import { ARCHIVE_NAME_MAX, ENTRY_PATH_MAX } from '../../src/utils/tenderFilesArchive.js'

const PizZip = typeof PizZipNs === 'function' ? PizZipNs : PizZipNs.default
const bytesOf = (text) => new TextEncoder().encode(text)
const TITLE = 'Должная осмотрительность'

let seq = 0
function doc(fileName, { size = 10, key } = {}) {
  seq++
  return { id: `d${seq}`, file_name: fileName, s3_key: key === undefined ? `counterparty/cp-1/${seq}-${fileName}` : key, size_bytes: size, created_at: '2026-11-19T10:00:00Z' }
}

describe('Скачать всё в «Должной осмотрительности»: раскладка без браузера', () => {
  it('все файлы раздела без папок, имена — как при загрузке; совпадения — «(2)» без учёта регистра', () => {
    const { entries, totalBytes } = planDocListArchive(
      [doc('Выписка ЕГРЮЛ.pdf', { size: 100 }), doc('Устав.pdf', { size: 50 }), doc('устав.pdf'), doc('Отчёт: проверка "СПАРК".pdf')], TITLE)
    assert.deepEqual(entries.map((e) => e.path), ['Выписка ЕГРЮЛ.pdf', 'Устав.pdf', 'устав (2).pdf', "Отчёт проверка 'СПАРК'.pdf"])
    assert.equal(totalBytes, 170)
    assert.equal(entries[0].section, TITLE)
    assert.equal(entries[0].fileName, 'Выписка ЕГРЮЛ.pdf')
    assert.deepEqual(planDocListArchive([], TITLE).entries, [])
    const huge = `${'Очень длинное имя файла проверки контрагента '.repeat(6)}.pdf`
    const long = planDocListArchive([doc(huge)], TITLE).entries[0].path
    assert.ok(long.length <= ENTRY_PATH_MAX && long.endsWith('….pdf'), long)
  })

  it('имя архива: «контрагент — раздел», название раздела не обрезается; без имени — «Документы — …»', () => {
    assert.equal(docListArchiveName('ООО «Альфа»', TITLE), `ООО «Альфа» — ${TITLE}`)
    assert.equal(docListArchiveName('ООО "Бета/Строй"', TITLE), `ООО 'Бета Строй' — ${TITLE}`)
    assert.equal(docListArchiveName('', TITLE), `Документы — ${TITLE}`)
    const name = docListArchiveName('Общество с ограниченной ответственностью Строительная компания '.repeat(3), TITLE)
    assert.ok(name.length <= ARCHIVE_NAME_MAX, name)
    assert.ok(name.endsWith(` — ${TITLE}`), name)
  })

  it('не скачавшийся файл — в «Не скачано.txt» с подсказкой, где скачать по одному', async () => {
    const { entries } = planDocListArchive([doc('Устав.pdf', { key: 'k-bad' }), doc('ИНН.pdf')], TITLE)
    const { bytes, added, failed } = await buildTenderArchive(entries, async (entry) => {
      if (entry.s3Key === 'k-bad') throw new Error('хранилище ответило 403')
      return bytesOf(entry.fileName)
    }, { retryDelayMs: 0, failedHint: docListFailedHint(TITLE) })
    assert.equal(added, 1)
    assert.equal(failed.length, 1)
    const zip = new PizZip(bytes)
    assert.equal(zip.file('ИНН.pdf').asText(), 'ИНН.pdf')
    const list = zip.file(FAILED_LIST_NAME).asText()
    assert.ok(list.includes(`скачайте их по одному в разделе «${TITLE}»`), list)
    assert.match(list, /Должная осмотрительность — Устав\.pdf: хранилище ответило 403/)
  })
})

const launch = browserLaunchOptions()
const BASE = 'route=/general/counterparties&cps=6&cpContacts=1&items=20&latency=0'

describe('Скачать всё в «Должной осмотрительности»: карточка контрагента', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  // Документы контрагента: [id, категория, имя]; содержимое — data: URL хранилища стенда.
  const seedFiles = ([cpId, files]) => {
    window.__fakeDb.s3_documents = window.__fakeDb.s3_documents || []
    for (const [id, category, name] of files) {
      const key = `counterparty/${cpId}/${id}-${name}`
      window.__fakeDb.s3_documents.push({ id, owner_type: 'counterparty', owner_id: cpId, doc_category: category,
        file_name: name, s3_key: key, size_bytes: name.length, created_at: '2026-11-19T10:00:00Z', uploaded_by_name: 'Иванов И. И.' })
      window.__fakeFiles = { ...(window.__fakeFiles || {}), [key]: `data:application/octet-stream;base64,${btoa(unescape(encodeURIComponent(`содержимое ${name}`)))}` }
    }
  }

  async function openDocsTab(query, cpName) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1440, height: 900 }, acceptDownloads: true })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.goto(`${stand.url}?${query}`)
    const row = page.locator('table.compact-table tbody tr.table-row', { hasText: cpName })
    await row.waitFor({ timeout: 120000 })
    return {
      page, errors, dialogs,
      seed: (args) => page.evaluate(seedFiles, args),
      open: async () => {
        await row.locator('.company-name').click()
        await page.locator('.cp-detail-modal').waitFor()
        await page.locator('.cp-detail-tab', { hasText: 'Документы' }).click()
        await page.locator('.cp-doc-section').nth(1).waitFor()
      },
      close: () => context.close().catch(() => {}),
    }
  }

  const section = (page, title) => page.locator('.cp-doc-section')
    .filter({ has: page.locator('.s3-doc-title', { hasText: title }) })

  it('кнопка в шапке раздела: архив всех его файлов с исходными именами; у «Согласования СБ» кнопки нет', async () => {
    const { page, errors, dialogs, seed, open, close } = await openDocsTab(BASE, 'Подрядчик 01')
    try {
      await seed(['cp-1', [
        ['dd-1', 'other', 'Выписка ЕГРЮЛ.pdf'],
        ['dd-2', 'other', 'Бухгалтерская отчётность 2025.xlsx'],
        ['sb-1', 'sb_approval', 'Заключение СБ.pdf'],
        ['dd-x', 'other', 'Чужой.pdf'],
      ]])
      // Документ другого контрагента в архив не попадает.
      await page.evaluate(() => { window.__fakeDb.s3_documents.find((d) => d.id === 'dd-x').owner_id = 'cp-2' })
      await open()
      const button = section(page, TITLE).locator('.s3-doc-btn-secondary')
      await button.waitFor({ timeout: 30000 })
      assert.equal(await button.innerText(), 'Скачать всё')
      assert.equal(await section(page, 'Согласование СБ').locator('.s3-doc-btn-secondary').count(), 0)
      await section(page, 'Согласование СБ').locator('.s3-doc-name', { hasText: 'Заключение СБ.pdf' }).waitFor()

      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), button.click()])
      const zip = new PizZip(await readFile(await download.path()))
      assert.equal(download.suggestedFilename(), `Подрядчик 01 — ${TITLE}.zip`)
      assert.deepEqual(Object.keys(zip.files).sort(), ['Бухгалтерская отчётность 2025.xlsx', 'Выписка ЕГРЮЛ.pdf'])
      assert.equal(zip.file('Выписка ЕГРЮЛ.pdf').asText(), 'содержимое Выписка ЕГРЮЛ.pdf')
      await button.locator('xpath=self::*[not(@disabled)]').waitFor({ timeout: 10000 })
      assert.deepEqual(dialogs, [])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без права правки: «Загрузить» нет, «Скачать всё» есть; без файлов кнопки нет', async () => {
    const ro = await openDocsTab(`${BASE}&canEdit=0`, 'Подрядчик 01')
    try {
      await ro.seed(['cp-1', [['dd-3', 'other', 'Устав.pdf']]])
      await ro.open()
      const dd = section(ro.page, TITLE)
      await dd.locator('.s3-doc-btn-secondary').waitFor({ timeout: 30000 })
      assert.equal(await ro.page.locator('.cp-detail-docs .s3-doc-btn-primary').count(), 0, 'без права правки загрузки нет')
      assert.deepEqual(ro.errors, [])
    } finally { await ro.close() }

    const empty = await openDocsTab(BASE, 'Подрядчик 02')
    try {
      await empty.open()
      await section(empty.page, TITLE).locator('.s3-doc-empty').waitFor({ timeout: 30000 })
      assert.equal(await empty.page.locator('.cp-detail-docs .s3-doc-btn-secondary').count(), 0)
      assert.deepEqual(empty.errors, [])
    } finally { await empty.close() }
  })

  it('телефон: кнопки шапки переносятся, страница не уходит вбок', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 390, height: 844 }, acceptDownloads: true })
    const page = await context.newPage()
    try {
      await page.goto(`${stand.url}?${BASE}`)
      await page.waitForFunction(() => window.__fakeDb?.counterparties?.length > 0, null, { timeout: 120000 })
      await page.evaluate(seedFiles, ['cp-2', [['dd-m', 'other', 'Выписка ЕГРЮЛ.pdf']]])
      const card = page.locator('text=Подрядчик 02').first()
      await card.waitFor({ timeout: 60000 })
      await card.click()
      await page.locator('.cp-detail-modal').waitFor()
      await page.locator('.cp-detail-tab', { hasText: 'Документы' }).click()
      const button = section(page, TITLE).locator('.s3-doc-btn-secondary')
      await button.waitFor({ timeout: 30000 })
      const box = await button.boundingBox()
      assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `кнопка в пределах экрана: ${JSON.stringify(box)}`)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      assert.ok(overflow <= 1, `нет прокрутки вбок: ${overflow}px`)
    } finally { await context.close().catch(() => {}) }
  })
})
