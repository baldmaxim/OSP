// UI ПСДЦ в настоящем браузере: блок карточки документа и массовая загрузка.
// Компоненты работают с тестовым PostgreSQL через прокси (tests/psdc/ui), расчёт,
// права и применение выполняют настоящие функции миграции.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as XLSXNs from 'xlsx'
import PizZip from 'pizzip'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { setupDatabase, pgAvailable, ROOT } from './lib/pg.mjs'
import { createUser, createDocument } from './lib/fixtures.mjs'
import { buildLegacyWorkbook, legacySample } from './lib/legacyWorkbook.mjs'
import { startApiServer } from './ui/api-server.mjs'

const XLSX = XLSXNs.read ? XLSXNs : XLSXNs.default
const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI = path.join(HERE, 'ui')

// Браузер Playwright, а если его сборка не скачана — установленные Chrome или Edge.
function browserLaunchOptions() {
  try {
    if (fs.existsSync(chromium.executablePath())) return {}
  } catch { /* сборка не установлена */ }
  const candidates = [
    process.env.PSDC_BROWSER,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean)
  const found = candidates.find((p) => fs.existsSync(p))
  return found ? { executablePath: found } : null
}

const launchOptions = browserLaunchOptions()
const browserAvailable = () => launchOptions !== null

const skip = (!pgAvailable() && 'PostgreSQL не найден') || (!browserAvailable() && 'Не найден Chromium/Chrome/Edge — задайте PSDC_BROWSER')

describe('ПСДЦ: интерфейс', { skip, timeout: 240000 }, () => {
  let db
  let api
  let vite
  let browser
  let base
  let lawyer
  let viewer
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'psdc-ui-'))

  before(async () => {
    db = setupDatabase()
    lawyer = createUser(db, { role: 'lawyer', canEdit: true, name: 'Юрист Тестов' })
    viewer = createUser(db, { role: 'economist', canView: true, canEdit: false, name: 'Экономист' })
    const apiPort = 47000 + Math.floor(Math.random() * 1000)
    api = await startApiServer(db, { port: apiPort })

    vite = await createServer({
      configFile: false,
      root: UI,
      logLevel: 'error',
      plugins: [react(), {
        name: 'psdc-fakes',
        enforce: 'pre',
        async resolveId(source, importer) {
          if (!importer) return null
          const resolved = path.resolve(path.dirname(importer), source)
          const norm = (p) => p.replace(/\\/g, '/').replace(/\.(js|jsx)$/, '')
          if (norm(resolved) === norm(path.join(ROOT, 'src', 'supabase')) || norm(resolved) === norm(path.join(ROOT, 'src', 'supabase', 'index'))) {
            return path.join(UI, 'fake-supabase.js')
          }
          if (norm(resolved) === norm(path.join(ROOT, 'src', 'contexts', 'RoleContext'))) {
            return path.join(UI, 'fake-role.jsx')
          }
          return null
        },
        transformIndexHtml: (html) => html.replace('<head>', `<head><script>window.__PSDC_API__ = 'http://127.0.0.1:${apiPort}/'</script>`),
      }],
      server: { host: '127.0.0.1', port: 48000 + Math.floor(Math.random() * 1000), strictPort: true, fs: { allow: [ROOT] } },
      optimizeDeps: { include: ['react', 'react-dom/client', 'react-router-dom', 'xlsx', 'xlsx-js-style', 'pizzip', 'file-saver'] },
    })
    await vite.listen()
    base = `http://127.0.0.1:${vite.config.server.port}/index.html`
    browser = await chromium.launch({ ...launchOptions, headless: true })
  })

  after(async () => {
    await browser?.close()
    await vite?.close()
    api?.close()
    db?.stop()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const newPage = async () => {
    const context = await browser.newContext({ acceptDownloads: true, locale: 'ru-RU' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
    page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'UI пакет' : undefined))
    return { page, errors }
  }

  const writeFixture = (name, bytes) => {
    const file = path.join(tmp, name)
    fs.writeFileSync(file, bytes)
    return file
  }

  const docState = (id) => db.exec(`SELECT COALESCE(psdc_total::text, 'null') || '|' || COALESCE(contract_amount::text, 'null') FROM contracts WHERE id = '${id}';`).trim()

  it('карточка: импорт → проверка → применение → экспорт → удаление', async () => {
    const doc = createDocument(db, { record_type: 'dp', status: 'in_work', vat_rate: 22, contract_amount: 10000000 })
    const { page, errors } = await newPage()
    await page.goto(`${base}?doc=${doc.id}&display=${doc.display_id}&uid=${lawyer}`)
    await page.getByText('ПСДЦ не загружена').waitFor()

    await page.locator('input[type=file]').setInputFiles(writeFixture('ВОР.xlsx', legacySample()))
    await page.getByText('Проверена, не применена').waitFor({ timeout: 30000 })
    const card = page.locator('.psdc-card.is-validated')
    await card.getByText('15 000,00', { exact: true }).waitFor()
    await card.getByText('2 704,92', { exact: true }).waitFor()
    assert.equal(docState(doc.id), 'null|10000000.00', 'до применения сумма документа не меняется')
    assert.ok(await card.getByText('Предупреждения:').isVisible(), 'предупреждения старого файла показаны')

    await card.getByRole('button', { name: 'Показать ведомость и изменения' }).or(card.getByRole('button', { name: 'Показать ведомость' })).click()
    await card.locator('.psdc-rows-table').getByText('5.10', { exact: true }).waitFor()

    await card.getByRole('button', { name: 'Применить ВОР' }).click()
    await page.locator('.psdc-chip.is-applied').waitFor({ timeout: 30000 })
    assert.equal(docState(doc.id), '15000.00|10000000.00')

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Экспорт ВОР' }).click(),
    ])
    const exported = XLSX.read(fs.readFileSync(await download.path()), { type: 'buffer', cellFormula: true })
    assert.deepEqual(exported.SheetNames, ['Ведомость объёмов работ'])
    assert.equal(exported.Sheets['Ведомость объёмов работ'].A5.v, '5.10')

    await page.getByRole('button', { name: 'Удалить ВОР' }).click()
    await page.getByText('ПСДЦ не загружена').waitFor({ timeout: 30000 })
    assert.equal(docState(doc.id), 'null|10000000.00')
    assert.deepEqual(errors, [])
  })

  it('карточка: файл с ошибками — список ошибок, копия с подсветкой, применение недоступно', async () => {
    const doc = createDocument(db, { record_type: 'dp', status: 'in_work' })
    const bad = buildLegacyWorkbook({ rows: [{ r: 2, A: '1', B: 'Секция', F: 'С' }, { r: 3, A: '2.1', B: 'Комплексный процесс', F: 'x', G: 'шт', I: 'много' }] })
    const { page, errors } = await newPage()
    await page.goto(`${base}?doc=${doc.id}&uid=${lawyer}`)
    await page.locator('input[type=file]').setInputFiles(writeFixture('плохой.xlsx', bad))
    await page.getByText('Есть ошибки').waitFor({ timeout: 30000 })
    await page.locator('.psdc-issues-table').getByText('I3', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Применить ВОР' }).isDisabled(), true)

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Файл с выделенными ошибками' }).click(),
    ])
    const copy = fs.readFileSync(await download.path())
    assert.deepEqual(Object.keys(new PizZip(copy).files).sort(), Object.keys(new PizZip(bad).files).sort())
    const ws = XLSX.read(copy, { type: 'buffer', cellStyles: true }).Sheets['Ведомость объёмов работ']
    assert.match(JSON.stringify(ws.I3.s || {}), /FFC7CE/i)

    await page.getByRole('button', { name: 'Отменить загрузку' }).click()
    await page.getByText('ПСДЦ не загружена').waitFor({ timeout: 30000 })
    assert.deepEqual(errors, [])
  })

  it('карточка: без права редактирования действия скрыты, завершённое ДС заблокировано', async () => {
    const base0 = createDocument(db, { record_type: 'dp', status: 'completed' })
    const ds = createDocument(db, { record_type: 'ds_vor', parent_contract_id: base0.id, status: 'completed' })
    const { page, errors } = await newPage()
    await page.goto(`${base}?doc=${ds.id}&uid=${lawyer}`)
    await page.getByText(/завершено\. Чтобы изменить ПСДЦ, верните его на доработку/).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Импорт ВОР' }).isDisabled(), true)

    const { page: viewPage } = await newPage()
    await viewPage.goto(`${base}?doc=${ds.id}&uid=${viewer}&edit=0`)
    await viewPage.getByText('ПСДЦ не загружена').waitFor()
    assert.equal(await viewPage.getByRole('button', { name: 'Импорт ВОР' }).count(), 0)
    assert.deepEqual(errors, [])
  })

  it('массовая загрузка: автосопоставление, ручной выбор, ошибки, применение проверенных, ZIP', async () => {
    const d1 = createDocument(db, { record_type: 'dp', status: 'in_work', contract_number: 'МАСС-001', contract_amount: 1 })
    const d2 = createDocument(db, { record_type: 'dp', status: 'in_work', contract_number: 'МАСС-002', contract_amount: 2 })
    const d3 = createDocument(db, { record_type: 'dp', status: 'in_work', contract_amount: 3 })
    const good = (price) => buildLegacyWorkbook({ rows: [{ r: 2, A: '1', B: 'Секция', F: 'С' }, { r: 3, A: '1.1', B: 'Комплексный процесс', F: 'x', G: 'шт', I: 1, J: price }] })
    const files = [
      writeFixture(`ВОР ID ${d1.display_id}.xlsx`, good(100)),
      writeFixture('ПСДЦ МАСС-002.xlsx', good(200)),
      writeFixture('ВОР без номера.xlsx', good(300)),
      writeFixture('ВОР с ошибкой.xlsx', buildLegacyWorkbook({ rows: [{ r: 2, A: '9.1', B: 'Комплексный процесс', F: 'x', G: 'шт', I: 1 }] })),
    ]

    const { page, errors } = await newPage()
    await page.goto(`${base}?view=batch&uid=${lawyer}`)
    await page.getByRole('button', { name: 'Новый пакет' }).click()
    const addFiles = page.getByRole('button', { name: 'Добавить файлы' })
    try {
      await addFiles.or(page.locator('.psdc-notice.is-error')).first().waitFor({ timeout: 15000 })
    } catch (e) {
      throw new Error(`Нет кнопки «Добавить файлы». URL: ${page.url()}\nОшибки страницы: ${errors.join(' | ')}\nТекст: ${(await page.locator('body').innerText()).slice(0, 1500)}`)
    }
    assert.ok(await addFiles.isVisible(), await page.locator('.psdc-notice').allInnerTexts().then((t) => t.join(' | ')))
    await page.locator('input[type=file][multiple]').setInputFiles(files)
    await page.getByText(/Загружено файлов: 4 из 4\. Автоматически сопоставлено: 2/).waitFor({ timeout: 60000 })

    const row = (name) => page.locator('.psdc-batch-table tbody tr').filter({ hasText: name })
    await row(`ВОР ID ${d1.display_id}.xlsx`).getByText('Автоматически').waitFor()
    await row('ПСДЦ МАСС-002.xlsx').getByText('Автоматически').waitFor()
    await row('ВОР без номера.xlsx').getByText('Не сопоставлено').waitFor()
    await row('ВОР с ошибкой.xlsx').getByText('Ошибки: 1').waitFor()

    await row('ВОР без номера.xlsx').getByRole('button', { name: 'Выбрать документ' }).click()
    const picker = page.locator('.psdc-picker input')
    await picker.fill(String(d3.display_id))
    await page.locator('.psdc-picker-list button').filter({ hasText: `ID ${d3.display_id}` }).first().waitFor()
    await picker.press('Enter')
    await row('ВОР без номера.xlsx').getByText('Вручную').waitFor({ timeout: 30000 })

    await page.getByRole('button', { name: 'Применить все проверенные (3)' }).click()
    await page.getByText(/Применено: 3\. Не применено: 0/).waitFor({ timeout: 60000 })
    assert.equal(docState(d1.id), '100.00|1.00')
    assert.equal(docState(d2.id), '200.00|2.00')
    assert.equal(docState(d3.id), '300.00|3.00')

    await page.getByRole('button', { name: /Ошибки\s*1/ }).click()
    await row('ВОР с ошибкой.xlsx').waitFor()

    const [zipDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Файлы с ошибками (ZIP)' }).click(),
    ])
    const zip = new PizZip(fs.readFileSync(await zipDownload.path()))
    assert.deepEqual(Object.keys(zip.files), ['ВОР с ошибкой — ошибки.xlsx'])

    // Пакет сохраняется в адресе и переживает перезагрузку страницы.
    await page.reload()
    await page.getByRole('button', { name: /Применено\s*3/ }).waitFor({ timeout: 30000 })
    assert.deepEqual(errors, [])
  })
})
