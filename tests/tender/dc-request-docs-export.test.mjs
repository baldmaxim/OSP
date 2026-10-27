// «Заявки на ДС» → Excel: файлы заявок (s3_documents, owner_type='dc_request') — лист «Документы», строка на файл со
// ссылкой на портал (/dc-requests?file=<id>: подписанная ссылка хранилища живёт час), счётчики основного листа ведут
// на первый файл раздела. Ссылка открывает файл в окне просмотра. Стенд tests/tender/ui (route=/dc-requests&dcStats=1:
// у d2 — два рабочих файла и отчёт по документам, у d4 — итоговый, у удалённой d6 — рабочий).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chromium } from 'playwright'
import * as XLSX from 'xlsx'
import { DOC_SECTIONS, dcRequestDocRows, dcRequestFileLink } from '../../src/utils/dcRequestDocs.js'
import { startStand, browserLaunchOptions, REPO as ROOT } from './lib/stand.mjs'

const launch = browserLaunchOptions()

describe('Заявки на ДС: файлы для выгрузки', () => {
  it('ссылка — на портал с id файла', () => {
    assert.equal(dcRequestFileLink('a b/1', 'https://tender.su10.ru'), 'https://tender.su10.ru/dc-requests?file=a%20b%2F1')
  })

  it('строки: заявки по порядку выгрузки, внутри — рабочие, отчёт, итоговые; в разделе — как загружены', () => {
    const docs = new Map([
      ['r1', [
        { id: 'f1', doc_category: 'final' },
        { id: 'g1', doc_category: 'general' },
        { id: 'c1', doc_category: 'check_report' },
        { id: 'g2', doc_category: null },
      ]],
      ['r2', [{ id: 'g3', doc_category: 'general' }]],
      ['r3', [{ id: 'x', doc_category: 'general' }]],
    ])
    const rows = dcRequestDocRows([{ id: 'r2' }, { id: 'r1' }, { id: 'r0' }], docs)
    assert.deepEqual(rows.map(r => [r.req.id, r.section.key, r.doc.id]), [
      ['r2', 'general', 'g3'], ['r1', 'general', 'g1'], ['r1', 'general', 'g2'], ['r1', 'check_report', 'c1'], ['r1', 'final', 'f1'],
    ])
    assert.deepEqual(DOC_SECTIONS.map(s => s.label), ['Документы', 'Отчёт по документам', 'Итоговые документы'])
  })
})

describe('Реестр заявок на ДС: файлы в Excel и ссылка на файл', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
  let stand
  let browser

  before(async () => {
    stand = await startStand(ROOT)
    browser = await chromium.launch({ ...launch, headless: true })
  })
  after(async () => {
    await browser?.close()
    await stand?.server.close()
  })

  async function open(route = '/dc-requests') {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 }, acceptDownloads: true })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept().catch(() => {}) })
    await page.goto(`${stand.url}?route=${encodeURIComponent(route)}&dcStats=1&latency=10&shell=1`)
    await page.locator('.dcr-table td.ui-rownum').first().waitFor({ timeout: 120000 })
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }

  it('выгрузка: лист «Документы» со ссылками на портал, счётчики ведут на файлы', async () => {
    const { page, errors, close } = await open()
    try {
      const origin = new URL(stand.url).origin
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.dcr-export-btn').click()])
      const wb = XLSX.read(fs.readFileSync(await download.path()), { type: 'buffer' })
      assert.deepEqual(wb.SheetNames, ['Заявки на ДС', 'Задачи', 'Документы'])

      // Вкладка «Все заявки»: файл удалённой заявки d6 не попадает. № заявок по порядку создания: d2 — 2, d4 — 4.
      const docs = wb.Sheets['Документы']
      const rows = XLSX.utils.sheet_to_json(docs)
      assert.deepEqual(rows.map(r => [r['№ заявки'], r['Раздел'], r['Файл'], r['Описание'] || '']), [
        [2, 'Документы', 'Было-стало.pdf', 'Расчёт было-стало'],
        [2, 'Документы', 'Письмо.docx', ''],
        [2, 'Отчёт по документам', 'Отчёт.pdf', ''],
        [4, 'Итоговые документы', 'ДС подписанное.pdf', ''],
      ])
      const header = Object.keys(rows[0])
      const ids = ['dcf-1', 'dcf-2', 'dcf-3', 'dcf-4']
      ids.forEach((id, i) => {
        const url = `${origin}/dc-requests?file=${id}`
        assert.equal(rows[i]['Ссылка'], url)
        for (const col of ['Файл', 'Ссылка']) {
          assert.equal(docs[XLSX.utils.encode_cell({ r: i + 1, c: header.indexOf(col) })].l?.Target, url, `${id}: ${col}`)
        }
      })

      // Основной лист: у счётчика раздела — переход на первый файл этого раздела заявки.
      const main = wb.Sheets['Заявки на ДС']
      const mainRows = XLSX.utils.sheet_to_json(main)
      const mainHeader = Object.keys(mainRows[0])
      const link = (no, col) => {
        const r = mainRows.findIndex(row => row['№'] === no) + 1
        const cell = main[XLSX.utils.encode_cell({ r, c: mainHeader.indexOf(col) })]
        return [cell?.v ?? '', cell?.l?.Target ?? null]
      }
      assert.deepEqual(link(2, 'Документы'), [2, "#'Документы'!A2"])
      assert.deepEqual(link(2, 'Отчёт по документам'), [1, "#'Документы'!A4"])
      assert.deepEqual(link(4, 'Итоговые документы'), [1, "#'Документы'!A5"])
      assert.deepEqual(link(1, 'Документы'), ['', null], 'без файлов — без ссылки')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('ссылка из выгрузки открывает файл: PDF — просмотр, docx — скачивание под своим именем', async () => {
    for (const [id, name, inside] of [['dcf-1', 'Было-стало.pdf', 'iframe'], ['dcf-2', 'Письмо.docx', 'a.s3-doc-btn-primary']]) {
      const { page, errors, dialogs, close } = await open(`/dc-requests?file=${id}`)
      try {
        const modal = page.locator('.s3-doc-modal')
        await modal.waitFor({ timeout: 10000 })
        assert.equal(await modal.locator('.s3-doc-modal-title').textContent(), name)
        await modal.locator(inside).waitFor()
        if (id === 'dcf-2') {
          const presign = await page.evaluate(() => window.__fakeLastPresign)
          assert.equal(presign?.download, true, 'ссылка на скачивание')
          assert.equal(presign?.file_name, name)
        }
        // Закрыли — окно не открывается снова (параметр ссылки убран).
        await modal.locator('.s3-doc-modal-close').click()
        await page.waitForTimeout(300)
        assert.equal(await modal.count(), 0)
        assert.deepEqual(dialogs, [])
        assert.deepEqual(errors, [])
      } finally { await close() }
    }
  })

  it('ссылка на удалённый файл — сообщение, окна нет', async () => {
    const { page, errors, dialogs, close } = await open('/dc-requests?file=dcf-missing')
    try {
      await page.waitForTimeout(500)
      assert.deepEqual(dialogs, ['Файл не найден: его удалили или заявка вам недоступна.'])
      assert.equal(await page.locator('.s3-doc-modal').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
