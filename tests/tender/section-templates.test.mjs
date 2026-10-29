// Шаблоны разделов (section_templates, миграция 20261107): «Шаблон Было-Стало» в окне «Документы» реестра
// «Заявка на ДС» (одна вкладка «Материалы», как у тендеров). Файл — s3_documents (owner_type 'general',
// doc_category 'section_template'): скачивает каждый, прикрепляет, заменяет и удаляет администратор; новый файл
// заменяет прежний. Таблицы ещё нет — файл не прикрепить, администратору подсказка про миграцию.
// «Понятийное соглашение» (тендеры ОС и «Договоры и ДС») с 27.10.2026 — ссылка, а не файл: одна на оба раздела
// (app_settings 'concept_agreement_template_link'); адрес — «Открыть», сетевой путь — «Скопировать путь»; файл,
// прикреплённый раньше, виден, пока администратор его не удалит. «Шаблон ДП» (договор подряда) в «Документах»
// договоров с 28.10.2026 — тоже ссылка, своя (app_settings 'contracts_dp_template_link'), вместо файла «Шаблон ДГП».
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const word = (name, text = 'шаблон') => ({ name, mimeType: DOCX, buffer: Buffer.from(text) })
const TEMPLATES = [
  { id: 'tpl-concept', code: 'tenders_concept_agreement', title: 'Понятийное соглашение' },
  { id: 'tpl-was', code: 'dc_was_became', title: 'Шаблон Было-Стало' },
]
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8')

describe('Шаблоны разделов: миграции и сервер', () => {
  it('обе базы заводят те же два шаблона; файл шаблона на сервере — только администратору', () => {
    for (const f of ['supabase/migrations/20261107_section_templates.sql', 'migration/yandex/20261107_section_templates.sql']) {
      const sql = read(f)
      assert.match(sql, /\('tenders_concept_agreement', 'Понятийное соглашение'\),\s*\('dc_was_became', 'Шаблон Было-Стало'\)\s*ON CONFLICT \(code\) DO NOTHING/, f)
      assert.match(sql, /osp_is_employee\(\)/, `${f}: читает сотрудник`)
      assert.doesNotMatch(sql, /FOR (INSERT|UPDATE|DELETE|ALL) TO (authenticated|PUBLIC)\s+USING \(CASE/, `${f}: правил записи нет`)
    }
    assert.match(read('supabase/migrations/20261107_section_templates.sql'), /GRANT SELECT ON TABLE public\.section_templates TO authenticated;/)
    const presign = read('server/osp-api/src/routes/s3Presign.js')
    assert.match(presign, /general: \['psdc', 'vor_requests', 'section_templates'\]/)
    assert.match(presign, /section_templates: \[\['admin', 'edit'\]\]/)
    const allow = JSON.parse(read('server/osp-api/src/data/allow.json'))
    assert.deepEqual(allow.tables.section_templates, { authenticated: ['select'] })
    // Коды в коде страницы — те же, что в миграции.
    const service = read('src/services/sectionTemplates.js')
    for (const { code } of TEMPLATES) assert.ok(service.includes(`'${code}'`), code)
  })
})

const launch = browserLaunchOptions()

describe('Шаблоны разделов в «Документах» тендеров и заявок на ДС', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  // ready — селектор загруженной страницы; data — до открытия окна (шаблоны читаются при открытии).
  const openPage = async (query, ready, { templates = TEMPLATES, files = [], missingTable = false } = {}) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 }, acceptDownloads: true })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.goto(`${stand.url}?${query}`)
    await page.locator(ready).first().waitFor({ timeout: 120000 })
    await page.evaluate(([t, f, missing]) => {
      window.__fakeDb.section_templates = t
      window.__fakeDb.s3_documents.push(...f)
      if (missing) {
        window.__fakeErrors = { ...(window.__fakeErrors || {}), section_templates: { code: 'PGRST205', message: "Could not find the table 'public.section_templates' in the schema cache" } }
      }
    }, [templates, files, missingTable])
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }
  const openTenders = (opts, extra = '') => openPage(`route=/tenders/construction&tenders=6&items=20&cps=2&latency=0${extra}`, 'table.tenders-registry > tbody > tr', opts)
  const openDc = (opts, extra = '') => openPage(`route=/dc-requests&dcStats=1&latency=0${extra}`, '.dcr-table tbody tr', opts)
  const card = (page, code) => page.locator(`.tdm-tpl-card[data-template="${code}"]`)
  const templateDocs = (page) => page.evaluate(() => window.__fakeDb.s3_documents
    .filter((d) => d.doc_category === 'section_template')
    .map((d) => ({ owner_type: d.owner_type, owner_id: d.owner_id, file_name: d.file_name })))

  it('«Понятийное соглашение» — ссылка, одна на тендеры и договоры: указать, открыть, сетевой путь, убрать', async () => {
    const { page, errors, dialogs, close } = await openTenders()
    try {
      await page.locator('button.btn-view-toggle', { hasText: 'Документы' }).click()
      assert.equal(await page.locator('.tdm-tab.is-active').textContent(), 'Материалы')
      const c = card(page, 'tenders_concept_agreement')
      await c.locator('.tdm-tpl-empty', { hasText: 'Ссылка ещё не указана' }).waitFor({ timeout: 10000 })
      assert.equal(await c.locator('.tdm-card-title').textContent(), 'Понятийное соглашение')
      assert.deepEqual(await page.locator('.tdm-cards > .tdm-card .tdm-card-title').allTextContents(),
        ['Шаблон письма', 'Структура хранения документов', 'Напоминание об обзвоне', 'Понятийное соглашение', 'Шаблон ДП'])
      // Файла у шаблона-ссылки не прикрепить.
      assert.equal(await page.getByTestId('template-input-tenders_concept_agreement').count(), 0)

      await c.getByRole('button', { name: 'Указать ссылку' }).click()
      const input = c.getByRole('textbox', { name: 'Ссылка на шаблон «Понятийное соглашение»' })
      await input.fill('понятийка.docx')
      await c.getByRole('button', { name: 'Сохранить' }).click()
      await c.getByRole('alert').waitFor({ timeout: 5000 })
      assert.match(await c.getByRole('alert').textContent(), /https:\/\/|сетевой путь/)
      await input.fill('https://docs.example.invalid/pc.docx')
      await c.getByRole('button', { name: 'Сохранить' }).click()
      const open = c.getByRole('link', { name: 'Открыть' })
      await open.waitFor({ timeout: 10000 })
      assert.equal(await open.getAttribute('href'), 'https://docs.example.invalid/pc.docx')
      assert.equal(await open.getAttribute('target'), '_blank')
      assert.deepEqual(await page.evaluate(() => window.__fakeDb.app_settings
        .filter((r) => r.key === 'concept_agreement_template_link').map((r) => r.value)), ['https://docs.example.invalid/pc.docx'])

      // Сетевой путь браузер не откроет — «Скопировать путь».
      await c.getByRole('button', { name: 'Изменить' }).click()
      await input.fill('\\\\192.168.5.55\\SharA_Tender\\Шаблоны\\ПС.docx')
      await c.getByRole('button', { name: 'Сохранить' }).click()
      await c.getByRole('button', { name: 'Скопировать путь' }).waitFor({ timeout: 10000 })
      assert.equal(await c.getByRole('link', { name: 'Открыть' }).count(), 0)

      await c.getByRole('button', { name: 'Убрать ссылку на шаблон «Понятийное соглашение»' }).click()
      assert.match(dialogs.at(-1), /Убрать ссылку на шаблон «Понятийное соглашение»/)
      await c.locator('.tdm-tpl-empty', { hasText: 'Ссылка ещё не указана' }).waitFor({ timeout: 10000 })
      assert.deepEqual(await templateDocs(page), [], 'файлов шаблон-ссылка не создаёт')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('тендеры ОС: «Шаблон ДП» — та же ссылка, что в договорах (app_settings contracts_dp_template_link)', async () => {
    const { page, errors, close } = await openTenders()
    try {
      await page.evaluate(() => {
        window.__fakeDb.app_settings.push({ key: 'contracts_dp_template_link', value: 'https://docs.example.invalid/dp.docx' })
      })
      await page.locator('button.btn-view-toggle', { hasText: 'Документы' }).click()
      const dp = card(page, 'contracts_dgp')
      const open = dp.getByRole('link', { name: 'Открыть' })
      await open.waitFor({ timeout: 10000 })
      assert.equal(await dp.locator('.tdm-card-title').textContent(), 'Шаблон ДП')
      assert.equal(await open.getAttribute('href'), 'https://docs.example.invalid/dp.docx')
      // Файла у шаблона-ссылки не прикрепить и здесь.
      assert.equal(await page.getByTestId('template-input-contracts_dgp').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('прежний файл «Понятийного соглашения» виден под ссылкой: скачать, администратор удаляет', async () => {
    const files = [{ id: 'f-pc', owner_type: 'general', owner_id: 'tpl-concept', doc_category: 'section_template',
      s3_key: 'general/tpl-concept/1-ПС.docx', file_name: 'ПС.docx', size_bytes: 10240, created_at: '2026-10-27T08:00:00Z' }]
    const { page, errors, close } = await openTenders({ files })
    try {
      await page.evaluate(() => {
        window.__fakeDb.app_settings.push({ key: 'concept_agreement_template_link', value: 'https://docs.example.invalid/pc.docx' })
        window.__fakeFiles = { ...(window.__fakeFiles || {}), 'general/tpl-concept/1-ПС.docx': 'data:application/octet-stream;base64,UEsDBA==' }
      })
      await page.locator('button.btn-view-toggle', { hasText: 'Документы' }).click()
      const c = card(page, 'tenders_concept_agreement')
      await c.locator('.tdm-tpl-legacy .tdm-tpl-name', { hasText: 'ПС.docx' }).waitFor({ timeout: 10000 })
      await c.getByRole('link', { name: 'Открыть' }).waitFor()
      const download = page.waitForEvent('download')
      await c.locator('.tdm-tpl-legacy').getByRole('button', { name: 'Скачать' }).click()
      assert.equal((await download).suggestedFilename(), 'ПС.docx')
      await c.getByRole('button', { name: 'Удалить прежний файл шаблона «Понятийное соглашение»' }).click()
      await c.locator('.tdm-tpl-legacy').waitFor({ state: 'detached', timeout: 10000 })
      assert.deepEqual(await templateDocs(page), [])
      await c.getByRole('link', { name: 'Открыть' }).waitFor()
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('договоры: «Документы» в шапке — та же ссылка «Понятийного соглашения» и своя ссылка «Шаблон ДП»', async () => {
    const templates = [...TEMPLATES, { id: 'tpl-dgp', code: 'contracts_dgp', title: 'Шаблон ДГП' }]
    const { page, errors, dialogs, close } = await openPage('route=/contracts&contracts=6&latency=0', '.contracts-table tbody tr.contract-row', { templates })
    try {
      await page.evaluate(() => window.__fakeDb.app_settings.push({ key: 'concept_agreement_template_link', value: 'https://docs.example.invalid/pc.docx' }))
      const header = page.locator('.registry-header')
      for (const gone of ['Структура хранения', 'Приложения', 'Импорт Excel', 'Загрузка ПСДЦ']) {
        assert.equal(await header.getByText(gone, { exact: true }).count(), 0, `«${gone}» — в окне «Документы», не в шапке`)
      }
      await header.getByRole('button', { name: 'Документы' }).click()
      const modal = page.getByRole('dialog', { name: 'Документы раздела' })
      await modal.waitFor({ timeout: 10000 })
      assert.deepEqual(await modal.locator('.tdm-cards > .tdm-card .tdm-card-title').allTextContents(),
        ['Понятийное соглашение', 'Шаблон ДП', 'Структура хранения документов', 'Стандартные приложения', 'Импорт из Excel', 'Загрузка ПСДЦ'])
      const pc = card(page, 'tenders_concept_agreement')
      assert.equal(await pc.getByRole('link', { name: 'Открыть' }).getAttribute('href'), 'https://docs.example.invalid/pc.docx')

      // «Шаблон ДП» — ссылка, файла не прикрепить.
      const dp = card(page, 'contracts_dgp')
      assert.equal(await dp.locator('.tdm-card-desc').textContent(), 'Шаблон договора подряда — ссылка на документ; та же в тендерах и в договорах')
      await dp.locator('.tdm-tpl-empty', { hasText: 'Ссылка ещё не указана' }).waitFor({ timeout: 10000 })
      assert.equal(await page.getByTestId('template-input-contracts_dgp').count(), 0)
      await dp.getByRole('button', { name: 'Указать ссылку' }).click()
      const input = dp.getByRole('textbox', { name: 'Ссылка на шаблон «Шаблон ДП»' })
      assert.match(await input.getAttribute('placeholder'), /Шаблон ДП\.docx$/)
      await input.fill('https://docs.example.invalid/dp.docx')
      await dp.getByRole('button', { name: 'Сохранить' }).click()
      const open = dp.getByRole('link', { name: 'Открыть' })
      await open.waitFor({ timeout: 10000 })
      assert.equal(await open.getAttribute('href'), 'https://docs.example.invalid/dp.docx')
      // Своя ссылка: «Понятийное соглашение» не меняется.
      assert.deepEqual(await page.evaluate(() => Object.fromEntries(window.__fakeDb.app_settings
        .filter((r) => /_template_link$/.test(r.key)).map((r) => [r.key, r.value]))), {
        concept_agreement_template_link: 'https://docs.example.invalid/pc.docx',
        contracts_dp_template_link: 'https://docs.example.invalid/dp.docx',
      })
      assert.equal(await pc.getByRole('link', { name: 'Открыть' }).getAttribute('href'), 'https://docs.example.invalid/pc.docx')

      await dp.getByRole('button', { name: 'Убрать ссылку на шаблон «Шаблон ДП»' }).click()
      assert.match(dialogs.at(-1), /Убрать ссылку на шаблон «Шаблон ДП»/)
      await dp.locator('.tdm-tpl-empty', { hasText: 'Ссылка ещё не указана' }).waitFor({ timeout: 10000 })
      assert.deepEqual(await templateDocs(page), [], 'файлов шаблон-ссылка не создаёт')

      // Плитка открывает своё окно, «Документы» закрываются.
      await modal.locator('.tdm-card', { hasText: 'Структура хранения документов' }).click()
      await modal.waitFor({ state: 'detached', timeout: 5000 })
      await page.getByText('01_Понятийное соглашение').first().waitFor({ timeout: 5000 })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('договоры: файл «Шаблона ДГП», прикреплённый раньше, виден под ссылкой «Шаблон ДП» — администратор удаляет', async () => {
    const templates = [...TEMPLATES, { id: 'tpl-dgp', code: 'contracts_dgp', title: 'Шаблон ДГП' }]
    const files = [{ id: 'f-dgp', owner_type: 'general', owner_id: 'tpl-dgp', doc_category: 'section_template',
      s3_key: 'general/tpl-dgp/1-ДГП.docx', file_name: 'ДГП.docx', size_bytes: 10240, created_at: '2026-10-27T08:00:00Z' }]
    const { page, errors, close } = await openPage('route=/contracts&contracts=3&latency=0', '.contracts-table tbody tr.contract-row', { templates, files })
    try {
      await page.evaluate(() => window.__fakeDb.app_settings.push({ key: 'contracts_dp_template_link', value: '\\\\192.168.5.55\\SharA_Tender\\Шаблоны\\ДП.docx' }))
      await page.locator('.registry-header').getByRole('button', { name: 'Документы' }).click()
      const dp = card(page, 'contracts_dgp')
      await dp.locator('.tdm-tpl-legacy .tdm-tpl-name', { hasText: 'ДГП.docx' }).waitFor({ timeout: 10000 })
      await dp.getByRole('button', { name: 'Скопировать путь' }).waitFor()
      await dp.getByRole('button', { name: 'Удалить прежний файл шаблона «Шаблон ДП»' }).click()
      await dp.locator('.tdm-tpl-legacy').waitFor({ state: 'detached', timeout: 10000 })
      assert.deepEqual(await templateDocs(page), [])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('договоры: базы шаблонов ещё нет — ссылка «Шаблон ДП» работает, подсказки про миграцию нет', async () => {
    const { page, errors, close } = await openPage('route=/contracts&contracts=3&latency=0', '.contracts-table tbody tr.contract-row', { missingTable: true })
    try {
      await page.locator('.registry-header').getByRole('button', { name: 'Документы' }).click()
      const dp = card(page, 'contracts_dgp')
      await dp.getByRole('button', { name: 'Указать ссылку' }).waitFor({ timeout: 10000 })
      assert.equal(await dp.locator('.tdm-tpl-hint').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без права администратора — только «Скачать»; файла нет — его добавит администратор', async () => {
    const files = [{ id: 'f-was', owner_type: 'general', owner_id: 'tpl-was', doc_category: 'section_template',
      s3_key: 'general/tpl-was/1-Было-Стало.docx', file_name: 'Было-Стало.docx', size_bytes: 20480, created_at: '2026-10-27T08:00:00Z' }]
    const { page, errors, close } = await openDc({ files }, '&canEdit=0')
    try {
      await page.locator('.dcr-header-actions button', { hasText: 'Документы' }).click()
      const c = card(page, 'dc_was_became')
      await c.locator('.tdm-tpl-name', { hasText: 'Было-Стало.docx' }).waitFor({ timeout: 10000 })
      assert.match(await c.locator('.tdm-tpl-meta').textContent(), /^20 КБ · 27\.10\.2026$/)
      assert.deepEqual(await c.locator('.tdm-tpl-actions button').allTextContents(), [' Скачать'])
      assert.equal(await page.getByTestId('template-input-dc_was_became').count(), 0)
    } finally { await close() }

    const t = await openTenders({}, '&canEdit=0')
    try {
      await t.page.locator('button.btn-view-toggle', { hasText: 'Документы' }).click()
      await card(t.page, 'tenders_concept_agreement').locator('.tdm-tpl-empty', { hasText: 'Ссылка ещё не указана — её добавит администратор' }).waitFor({ timeout: 10000 })
      assert.equal(await card(t.page, 'tenders_concept_agreement').locator('button').count(), 0)
      assert.deepEqual([...errors, ...t.errors], [])
    } finally { await t.close() }
  })

  it('заявки на ДС: «Документы» в шапке — окно с одной вкладкой «Материалы» и «Шаблон Было-Стало»', async () => {
    const { page, errors, close } = await openDc()
    try {
      await page.locator('.dcr-header-actions button', { hasText: 'Документы' }).click()
      const modal = page.getByRole('dialog', { name: 'Документы раздела' })
      await modal.waitFor({ timeout: 10000 })
      assert.deepEqual(await modal.locator('.tdm-tab').allTextContents(), ['Материалы'])
      const c = card(page, 'dc_was_became')
      assert.equal(await c.locator('.tdm-card-title').textContent(), 'Шаблон Было-Стало')
      await c.locator('.tdm-tpl-empty', { hasText: 'Файл ещё не прикреплён' }).waitFor({ timeout: 10000 })
      await page.getByTestId('template-input-dc_was_became').setInputFiles([word('Было-Стало.docx')])
      await c.locator('.tdm-tpl-name', { hasText: 'Было-Стало.docx' }).waitFor({ timeout: 10000 })
      assert.deepEqual(await templateDocs(page), [{ owner_type: 'general', owner_id: 'tpl-was', file_name: 'Было-Стало.docx' }])
      // Фон окна — свой, не общий .modal реестра договоров.
      assert.equal(await modal.evaluate((el) => getComputedStyle(el).overflow), 'hidden')
      await page.keyboard.press('Escape')
      await modal.waitFor({ state: 'detached', timeout: 5000 })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('таблицы шаблонов ещё нет: файл не прикрепить, администратору — подсказка про миграцию', async () => {
    const { page, errors, close } = await openDc({ missingTable: true })
    try {
      await page.locator('.dcr-header-actions button', { hasText: 'Документы' }).click()
      const c = card(page, 'dc_was_became')
      await c.locator('.tdm-tpl-hint').waitFor({ timeout: 10000 })
      assert.match(await c.locator('.tdm-tpl-hint').textContent(), /миграция 20261107_section_templates/)
      assert.equal(await c.locator('button').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
