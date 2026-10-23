// «Скачать всё» в окне «ВОРы и РД» тендера (src/utils/vorRdArchive.js, components/VorRdZipButton.jsx):
// своя кнопка в шапке «Рабочей документации», «Ведомости объёмов работ» и «Загружены ранее» — архив
// только файлов раздела, без папок, имена файлов — исходные (без переименования, как в «Проверке КП»);
// в реестре «Основное строительство» — по скрепке в колонке «ВОР».
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import PizZipNs from 'pizzip'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  planVorRdArchive, vorRdArchiveName, buildTenderArchive, FAILED_LIST_NAME, VOR_RD_FAILED_HINT,
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
  it('архив раздела — его файлы без папок, имена — как при загрузке', () => {
    const { entries, totalBytes } = planVorRdArchive(
      [doc('2024-15-АР Изм.1.pdf', { size: 100 }), doc('2024-15-КЖ.pdf', { size: 50 })], 'rd')
    assert.deepEqual(entries.map((e) => e.path), ['2024-15-АР Изм.1.pdf', '2024-15-КЖ.pdf'])
    assert.equal(totalBytes, 150)
    assert.equal(entries[0].section, 'Рабочая документация')
    assert.equal(planVorRdArchive([doc('ВОР ОВ (корпус 1).xlsx')], 'vor').entries[0].path, 'ВОР ОВ (корпус 1).xlsx')
    assert.deepEqual(planVorRdArchive([], 'legacy').entries, [])
  })

  it('длинное имя не режется, пока путь укладывается; меняются только недопустимые в Windows знаки', () => {
    const long = `${'Раздел 3 Архитектурные решения Корпус 1 секции 1-5 '.repeat(2).trim()}.pdf`
    assert.ok(long.length > 80 && long.length < ENTRY_PATH_MAX)
    const { entries } = planVorRdArchive([doc(long), doc('АР: лист 1/2 "общий".pdf')], 'rd')
    assert.equal(entries[0].path, long)
    assert.equal(entries[1].path, "АР лист 1 2 'общий'.pdf")
  })

  it('совпадающие имена — «(2)» без учёта регистра; слишком длинное — в пределах пути, расширение целое', () => {
    const huge = `${'Очень длинное имя файла ведомости '.repeat(8)}.xlsx`
    const { entries } = planVorRdArchive([doc('ВОР.xlsx'), doc('вор.xlsx'), doc(huge)], 'vor')
    assert.deepEqual(entries.map((e) => e.path).slice(0, 2), ['ВОР.xlsx', 'вор (2).xlsx'])
    assert.ok(entries[2].path.length <= ENTRY_PATH_MAX && entries[2].path.endsWith('….xlsx'), entries[2].path)
  })

  it('имя архива: «№ работы — РД» / «— ВОР», хвост не обрезается; без тендера — «Тендер — …»', () => {
    const tender = { public_tender_number: 125, work_description: 'Монолитные работы' }
    assert.equal(vorRdArchiveName(tender, 'rd'), '125 Монолитные работы — РД')
    assert.equal(vorRdArchiveName(tender, 'vor'), '125 Монолитные работы — ВОР')
    assert.equal(vorRdArchiveName(tender, 'legacy'), '125 Монолитные работы — ВОР и РД (загружены ранее)')
    assert.equal(vorRdArchiveName(null, 'vor'), 'Тендер — ВОР')
    const name = vorRdArchiveName({ public_tender_number: 7, work_description: 'Устройство фасада '.repeat(20) }, 'legacy')
    assert.ok(name.length <= ARCHIVE_NAME_MAX, name)
    assert.ok(name.endsWith(' — ВОР и РД (загружены ранее)'), name)
  })

  it('не скачавшийся файл — в «Не скачано.txt» с разделом и подсказкой про окно «ВОРы и РД»', async () => {
    const { entries } = planVorRdArchive([doc('АР.pdf', { key: 'k-bad' }), doc('КЖ.pdf')], 'rd')
    const { bytes, added, failed } = await buildTenderArchive(entries, async (entry) => {
      if (entry.s3Key === 'k-bad') throw new Error('хранилище ответило 403')
      return bytesOf(entry.fileName)
    }, { retryDelayMs: 0, failedHint: VOR_RD_FAILED_HINT })
    assert.equal(added, 1)
    assert.equal(failed.length, 1)
    const zip = new PizZip(bytes)
    assert.equal(zip.file('КЖ.pdf').asText(), 'КЖ.pdf')
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
  const openDocs = (page, num) => registryRow(page, num).locator('button.tp-docs-btn[title="Документы ВОР и РД"]').click()
  const section = (page, title) => page.locator('.tvr-modal .tvr-section')
    .filter({ has: page.locator('.tvr-title', { hasText: title }) })

  // Файлы тендеров: [id, категория, имя]; содержимое — data: URL хранилища стенда.
  const seedFiles = ([tenderId, files]) => {
    for (const [id, category, name] of files) {
      const key = `tenders/${tenderId}/${id}-${name}`
      window.__fakeDb.s3_documents.push({ id, owner_type: 'tender', owner_id: tenderId, doc_category: category,
        file_name: name, s3_key: key, size_bytes: name.length, created_at: '2026-10-20T10:00:00Z', uploaded_by_name: 'Иванов И. И.' })
      window.__fakeFiles = { ...(window.__fakeFiles || {}), [key]: `data:application/octet-stream;base64,${btoa(unescape(encodeURIComponent(`содержимое ${name}`)))}` }
    }
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

  // Скачать архив кнопкой раздела: имя и файлы в нём (без папок).
  const downloadZip = async (page, button) => {
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), button.click()])
    const zip = new PizZip(await readFile(await download.path()))
    await button.locator('xpath=self::*[not(@disabled)]').waitFor({ timeout: 10000 })
    return { name: download.suggestedFilename(), zip, files: Object.keys(zip.files).sort() }
  }

  it('скрепка → у РД и у ВОР своя «Скачать всё»: архив только файлов раздела, исходные имена', async () => {
    const { page, errors, dialogs, close } = await openRegistry()
    try {
      await page.evaluate(seedFiles, ['tender-1', [
        ['rd-1', 'rd', '2024-15-АР Изм.1.pdf'],
        ['rd-2', 'rd', '2024-15-КЖ.pdf'],
        ['vor-1', 'vor_statement', 'ВОР фасад.xlsx'],
        ['old-1', 'vor', 'Старый ВОР.xls'],
      ]])
      await openDocs(page, 200)
      const rdButton = section(page, 'Рабочая документация').locator('.tvr-section-head .tvr-zip-btn')
      const vorButton = section(page, 'Ведомость объёмов работ').locator('.tvr-section-head .tvr-zip-btn')
      const legacyButton = section(page, 'Загружены ранее').locator('.tvr-section-head .tvr-zip-btn')
      await rdButton.waitFor({ timeout: 30000 })
      assert.equal(await page.locator('.tvr-modal .tvr-zip-btn').count(), 3, 'по кнопке на раздел, общей нет')
      assert.equal(await rdButton.textContent(), 'Скачать всё')

      const works = '200 Устройство вентилируемого фасада с облицовкой керамогранитом, секции 1–4'
      const rd = await downloadZip(page, rdButton)
      assert.equal(rd.name, `${works} — РД.zip`)
      assert.deepEqual(rd.files, ['2024-15-АР Изм.1.pdf', '2024-15-КЖ.pdf'])
      assert.equal(rd.zip.file('2024-15-КЖ.pdf').asText(), 'содержимое 2024-15-КЖ.pdf')

      const vor = await downloadZip(page, vorButton)
      assert.equal(vor.name, `${works} — ВОР.zip`)
      assert.deepEqual(vor.files, ['ВОР фасад.xlsx'])

      const legacy = await downloadZip(page, legacyButton)
      // Хвост длиннее — работы обрезаются по слову, хвост целый.
      assert.equal(legacy.name, '200 Устройство вентилируемого фасада с облицовкой керамогранитом… — ВОР и РД (загружены ранее).zip')
      assert.deepEqual(legacy.files, ['Старый ВОР.xls'])

      assert.deepEqual(dialogs, [])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('кнопка — только у раздела с файлами; без файлов кнопок нет', async () => {
    const { page, errors, close } = await openRegistry()
    try {
      await page.evaluate(seedFiles, ['tender-2', [['vor-2', 'vor_statement', 'ВОР отделка.xlsx']]])
      await openDocs(page, 199)
      await section(page, 'Ведомость объёмов работ').locator('.tvr-zip-btn').waitFor({ timeout: 30000 })
      assert.equal(await section(page, 'Рабочая документация').locator('.tvr-zip-btn').count(), 0)
      assert.equal(await page.locator('.tvr-modal .tvr-zip-btn').count(), 1)
      await page.locator('.tvr-modal .s3-doc-modal-close').click()

      await openDocs(page, 198)
      await section(page, 'Ведомость объёмов работ').waitFor({ timeout: 30000 })
      await page.locator('.tvr-modal .tvr-empty', { hasText: 'Рабочая документация не загружена' }).waitFor({ timeout: 30000 })
      assert.equal(await page.locator('.tvr-modal .tvr-zip-btn').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
