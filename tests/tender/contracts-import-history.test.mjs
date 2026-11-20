// «Договоры и ДС» → «Документы» → «Импорт из Excel»: каждому созданному документу — «Создание» в «Истории» с файлом и строкой
// (до 19.11.2026 импорт его не писал). Стенд реестра (contracts=24): файл из двух строк — договор и ДС к договору ID 1;
// проверяется, что записалось в contract_audit_log подставной базы. Нужен Chromium (PSDC_BROWSER или сборка Playwright).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Buffer } from 'node:buffer'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import * as XLSX from 'xlsx'
import * as esbuild from 'esbuild'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const QUERY = 'route=/contracts/registry&contracts=24&latency=0'
const FILE = 'Импорт проверка.xlsx'

// Шаблон импорта — из самого модуля (колонки узнаются по заголовкам, нужно не меньше половины).
async function template() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osp-import-tpl-')), 'contractsImport.mjs')
  await esbuild.build({
    entryPoints: [path.join(REPO, 'src', 'utils', 'contractsImport.js')],
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent', external: ['xlsx'], absWorkingDir: REPO,
  })
  fs.writeFileSync(out, fs.readFileSync(out, 'utf8').replaceAll('from "xlsx"', `from ${JSON.stringify(pathToFileURL(path.join(REPO, 'node_modules', 'xlsx', 'xlsx.mjs')).href)}`))
  const { IMPORT_COLUMNS, TEMPLATE_HEADERS } = await import(pathToFileURL(out).href)
  return { keys: IMPORT_COLUMNS.map((c) => c.key), headers: TEMPLATE_HEADERS }
}

function workbook({ keys, headers }) {
  const line = (values) => keys.map((k) => values[k] ?? '')
  const ws = XLSX.utils.aoa_to_sheet([
    headers,
    line({ record_type: 'Договор', contract_number: 'ИМП-77', contract_date: '01.11.2026', counterparty_name: 'Подрядчик 02',
      object_name: 'ЖК «Северный квартал»', handled_by_us: 'Нет' }),
    line({ record_type: 'ДС на дополнительные работы', parent_display_id: 1, contract_number: '9', contract_date: '02.11.2026', handled_by_us: 'Нет' }),
  ])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Договоры')
  return Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
}

describe('Импорт договоров из Excel пишет «Создание» в «Историю»', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
  let stand
  let browser
  let tpl

  before(async () => {
    tpl = await template()
    stand = await startStand(REPO)
    browser = await chromium.launch({ ...launch, headless: true })
  })
  after(async () => {
    await browser?.close()
    await stand?.server.close()
  })

  it('договор и ДС — по событию «Создание» с файлом и строкой; ошибок нет', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource|счётчики номеров/.test(msg.text())) errors.push(msg.text()) })
    try {
      await page.addInitScript(() => { try { localStorage.clear() } catch { /* нет */ } })
      await page.goto(`${stand.url}?${QUERY}`)
      await page.locator('.contracts-table tbody tr.contract-row').first().waitFor({ timeout: 120000 })

      await page.locator('.contracts-docs-btn').click()
      await page.locator('.tdm-card', { hasText: 'Импорт из Excel' }).click()
      const input = page.locator('.cim-modal input[type="file"]')
      await page.waitForFunction(() => document.querySelector('.cim-modal input[type="file"]') && !document.querySelector('.cim-modal input[type="file"]').disabled,
        null, { timeout: 60000 })
      await input.setInputFiles({ name: FILE, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbook(tpl) })
      const confirm = page.locator('.cim-footer .btn-primary', { hasText: 'Завершить импорт' })
      await confirm.waitFor({ timeout: 60000 })
      assert.equal((await confirm.innerText()).trim(), 'Завершить импорт (2)', await page.locator('.cim-modal').innerText())
      await confirm.click()
      await page.locator('.cim-result-big', { hasText: 'Создано договоров: 2' }).waitFor({ timeout: 60000 })
      assert.equal(await page.locator('.cim-result', { hasText: 'не записалось событие создания' }).count(), 0)

      const events = await page.evaluate(() => {
        const db = window.__fakeDb
        const byId = new Map((db.contracts || []).map((c) => [c.id, c]))
        return (db.contract_audit_log || []).filter((e) => e.event_type === 'created')
          .map((e) => ({ number: byId.get(e.contract_id)?.contract_number, description: e.description, value: e.new_value }))
      })
      const dp = events.find((e) => e.number === 'ИМП-77')
      const ds = events.find((e) => e.number === '9')
      assert.ok(dp, JSON.stringify(events))
      assert.equal(dp.description, `Создан договор № ИМП-77. Документ загружен импортом из Excel: «${FILE}», строка 2.`)
      assert.deepEqual(dp.value, { source: 'import', file: FILE, row: 2 })
      assert.ok(ds, JSON.stringify(events))
      assert.equal(ds.description, `Создано ДС на дополнительные работы № 9 к документу ID 1. Документ загружен импортом из Excel: «${FILE}», строка 3.`)
      assert.deepEqual(errors, [])
    } finally {
      await context.close().catch(() => {})
    }
  })
})
