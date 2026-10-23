// «Скачать всё» в окне «ВОРы и РД» тендера (src/utils/vorRdArchive.js, components/VorRdZipButton.jsx):
// все файлы окна одним ZIP, папка на раздел, имена файлов — исходные (без переименования, как в
// «Проверке КП»); в реестре «Основное строительство» — по скрепке в колонке «ВОР».
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import PizZipNs from 'pizzip'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  planVorRdArchive, vorRdArchiveName, buildTenderArchive, FAILED_LIST_NAME,
  VOR_RD_ARCHIVE_SUFFIX, VOR_RD_FAILED_HINT,
} from '../../src/utils/vorRdArchive.js'
import { ARCHIVE_NAME_MAX, ENTRY_PATH_MAX } from '../../src/utils/tenderFilesArchive.js'

const PizZip = typeof PizZipNs === 'function' ? PizZipNs : PizZipNs.default
const bytesOf = (text) => new TextEncoder().encode(text)

let seq = 0
function doc(fileName, { size = 10, key } = {}) {
  seq++
  return { id: `d${seq}`, file_name: fileName, s3_key: key === undefined ? `tenders/t1/${seq}-${fileName}` : key, size_bytes: size, created_at: '2026-10-20T10:00:00Z' }
}

describe('Скачать всё в «ВОРах и РД»: раскладка без браузера', () => {
  it('папки — разделы окна по порядку, имена файлов — как при загрузке, пустой раздел папки не даёт', () => {
    const { entries, totalBytes } = planVorRdArchive({
      rdDocs: [doc('2024-15-АР Изм.1.pdf', { size: 100 }), doc('2024-15-КЖ.pdf', { size: 50 })],
      vorDocs: [doc('ВОР ОВ (корпус 1).xlsx', { size: 7 })],
      legacyDocs: [],
    })
    assert.deepEqual(entries.map((e) => e.path), [
      'Рабочая документация/2024-15-АР Изм.1.pdf',
      'Рабочая документация/2024-15-КЖ.pdf',
      'Ведомость объёмов работ/ВОР ОВ (корпус 1).xlsx',
    ])
    assert.equal(totalBytes, 157)
    assert.equal(entries[2].section, 'Ведомость объёмов работ')
  })

  it('длинное имя РД не режется, пока путь укладывается; меняются только недопустимые в Windows знаки', () => {
    const long = `${'Раздел 3 Архитектурные решения Корпус 1 секции 1-5 '.repeat(2).trim()}.pdf`
    assert.ok(long.length > 80 && long.length < ENTRY_PATH_MAX - 'Рабочая документация/'.length)
    const { entries } = planVorRdArchive({ rdDocs: [doc(long), doc('АР: лист 1/2 "общий".pdf')] })
    assert.equal(entries[0].path, `Рабочая документация/${long}`)
    assert.equal(entries[1].path, "Рабочая документация/АР лист 1 2 'общий'.pdf")
  })

  it('совпадающие имена в папке — «(2)», в разных папках — как есть; путь не длиннее предела', () => {
    const huge = `${'Очень длинное имя файла ведомости '.repeat(8)}.xlsx`
    const { entries } = planVorRdArchive({
      rdDocs: [doc('Общий.pdf')],
      vorDocs: [doc('ВОР.xlsx'), doc('вор.xlsx'), doc(huge)],
      legacyDocs: [doc('Общий.pdf')],
    })
    assert.deepEqual(entries.map((e) => e.path).slice(0, 3), [
      'Рабочая документация/Общий.pdf', 'Ведомость объёмов работ/ВОР.xlsx', 'Ведомость объёмов работ/вор (2).xlsx',
    ])
    assert.equal(entries.at(-1).path, 'Загружены ранее/Общий.pdf')
    assert.ok(entries[3].path.length <= ENTRY_PATH_MAX && entries[3].path.endsWith('….xlsx'), entries[3].path)
  })

  it('имя архива: «№ работы — ВОР и РД», хвост не обрезается; без тендера — «Тендер — ВОР и РД»', () => {
    assert.equal(vorRdArchiveName({ public_tender_number: 125, work_description: 'Монолитные работы' }), '125 Монолитные работы — ВОР и РД')
    assert.equal(vorRdArchiveName(null), 'Тендер — ВОР и РД')
    const name = vorRdArchiveName({ public_tender_number: 7, work_description: 'Устройство фасада '.repeat(20) })
    assert.ok(name.length <= ARCHIVE_NAME_MAX, name)
    assert.ok(name.endsWith(VOR_RD_ARCHIVE_SUFFIX), name)
  })

  it('не скачавшийся файл — в «Не скачано.txt» с разделом и подсказкой про окно «ВОРы и РД»', async () => {
    const { entries } = planVorRdArchive({ rdDocs: [doc('АР.pdf', { key: 'k-bad' })], vorDocs: [doc('ВОР.xlsx')] })
    const { bytes, added, failed } = await buildTenderArchive(entries, async (entry) => {
      if (entry.s3Key === 'k-bad') throw new Error('хранилище ответило 403')
      return bytesOf(entry.fileName)
    }, { retryDelayMs: 0, failedHint: VOR_RD_FAILED_HINT })
    assert.equal(added, 1)
    assert.equal(failed.length, 1)
    const zip = new PizZip(bytes)
    assert.equal(zip.file('Ведомость объёмов работ/ВОР.xlsx').asText(), 'ВОР.xlsx')
    const list = zip.file(FAILED_LIST_NAME).asText()
    assert.ok(list.includes(VOR_RD_FAILED_HINT))
    assert.match(list, /Рабочая документация — АР\.pdf: хранилище ответило 403/)
  })
})

const launch = browserLaunchOptions()

describe('Скачать всё в «ВОРах и РД»: реестр «Основное строительство»', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  const registryRow = (page, num) => page.locator('table.tenders-registry > tbody > tr')
    .filter({ has: page.locator('.tp-num-value', { hasText: new RegExp(`^${num}$`) }) })

  // Тендер № 200 (tender-1): два файла РД, ВОР и файл прежней категории; содержимое — data: URL хранилища стенда.
  const seedFiles = () => {
    const file = (id, category, name, at) => {
      const key = `tenders/tender-1/${id}-${name}`
      window.__fakeDb.s3_documents.push({ id, owner_type: 'tender', owner_id: 'tender-1', doc_category: category,
        file_name: name, s3_key: key, size_bytes: name.length, created_at: at, uploaded_by_name: 'Иванов И. И.' })
      window.__fakeFiles = { ...(window.__fakeFiles || {}), [key]: `data:application/octet-stream;base64,${btoa(unescape(encodeURIComponent(`содержимое ${name}`)))}` }
    }
    file('rd-1', 'rd', '2024-15-АР Изм.1.pdf', '2026-10-20T10:00:00Z')
    file('rd-2', 'rd', '2024-15-КЖ.pdf', '2026-10-20T09:00:00Z')
    file('vor-1', 'vor_statement', 'ВОР фасад.xlsx', '2026-10-21T10:00:00Z')
    file('old-1', 'vor', 'Старый ВОР.xls', '2026-09-01T10:00:00Z')
  }

  const openRegistry = async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 }, acceptDownloads: true })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.goto(`${stand.url}?tenders=10&items=20&cps=2&latency=0&route=/tenders/construction`)
    await page.locator('table.tenders-registry > tbody > tr').first().waitFor({ timeout: 120000 })
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }

  it('скрепка → «Скачать всё» над разделами → ZIP с папками разделов и исходными именами', async () => {
    const { page, errors, dialogs, close } = await openRegistry()
    try {
      await page.evaluate(seedFiles)
      await registryRow(page, 200).locator('button.tp-docs-btn[title="Документы ВОР и РД"]').click()
      const panel = page.locator('.tvr-modal .tvr-panel')
      const button = panel.locator('.tvr-toolbar .tvr-zip-btn')
      await button.waitFor({ timeout: 30000 })

      // Кнопка — над обоими разделами.
      const order = await panel.evaluate((el) => {
        const btn = el.querySelector('.tvr-zip-btn')
        return [...el.querySelectorAll('.tvr-title')].map((t) => ({
          title: t.textContent, below: !!(btn.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING),
        }))
      })
      assert.ok(order.find((o) => o.title.includes('Рабочая документация'))?.below)
      assert.ok(order.find((o) => o.title.includes('Ведомость объёмов работ'))?.below)

      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), button.click()])
      assert.equal(download.suggestedFilename(), '200 Устройство вентилируемого фасада с облицовкой керамогранитом, секции 1–4 — ВОР и РД.zip')
      const zip = new PizZip(await readFile(await download.path()))
      const files = Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort()
      assert.deepEqual(files, [
        'Ведомость объёмов работ/ВОР фасад.xlsx',
        'Загружены ранее/Старый ВОР.xls',
        'Рабочая документация/2024-15-АР Изм.1.pdf',
        'Рабочая документация/2024-15-КЖ.pdf',
      ])
      assert.equal(zip.file('Рабочая документация/2024-15-КЖ.pdf').asText(), 'содержимое 2024-15-КЖ.pdf')
      await page.locator('.tvr-zip-btn:not([disabled])', { hasText: 'Скачать всё' }).waitFor({ timeout: 10000 })
      assert.deepEqual(dialogs, [])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('без файлов кнопки нет', async () => {
    const { page, errors, close } = await openRegistry()
    try {
      await registryRow(page, 199).locator('button.tp-docs-btn[title="Документы ВОР и РД"]').click()
      await page.locator('.tvr-modal .tvr-panel .tvr-title', { hasText: 'Ведомость объёмов работ' }).waitFor({ timeout: 30000 })
      assert.equal(await page.locator('.tvr-zip-btn').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
