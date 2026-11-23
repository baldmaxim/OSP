// «Реестр по договорам»: «Юрист» — только действующий юрист ОСП (решение пользователя 23.11.2026, миграция 20270226_registry_osp_lawyers;
// база — tests/tender/registry-osp-lawyers-db.test.mjs). Юрист — учётка (contracts.responsible_user_id) из справочника сотрудников с
// ролью «Юрист ОСП»; заблокированного в справочнике нет, не юрист (экономист-администратор) не показывается и не выбирается. Проверяется:
// столбец, выбор в строке (запись и «История» с ФИО), фильтр, форма договора; правка формы не стирает скрытого юриста; без миграции
// (колонки нет) форма без юриста сохраняется как раньше. Стенд: contracts=30, contractsLawyers=1.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const BASE = 'route=/contracts/registry&contracts=30&latency=0'
const LAWYERS = ['Правова Анна Сергеевна', 'Юристова Юлия Юрьевна']

describe('Реестр договоров: юрист — только юрист ОСП', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  const open = async (extra = '&contractsLawyers=1') => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.addInitScript(() => {
      try { localStorage.removeItem('contracts-doc-kind'); localStorage.removeItem('contracts-hide-tail-columns') } catch { /* нет */ }
    })
    await page.goto(`${stand.url}?${BASE}${extra}`)
    await page.locator('.contracts-table tbody tr.contract-row').first().waitFor({ timeout: 120000 })
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }
  const row = (page, id) => page.locator('.contracts-table tbody tr.contract-row', { has: page.locator(`a.contract-ds-link[href="/contracts/${id}"]`) })
  const contract = (page, id) => page.evaluate((cid) => ({ ...window.__fakeDb.contracts.find((x) => x.id === cid) }), id)
  const openOptions = async (page, trigger) => {
    await trigger.click()
    const panel = page.locator('.fdrop-panel').last()
    await panel.waitFor()
    return panel
  }

  it('столбец: юрист ОСП — ФИО; экономист и заблокированный — «—»; выбор в строке — только юристы ОСП, запись и «История» с ФИО', async () => {
    const { page, errors, close } = await open()
    try {
      const cell = (id) => row(page, id).locator('td.cell-lawyer .fdrop-value')
      await page.waitForFunction(() => document.querySelector('td.cell-lawyer .fdrop-value')?.textContent !== '')
      assert.match(await cell('ctr-1').innerText(), /^Юристова/)
      assert.equal((await cell('ctr-2').innerText()).trim(), '—', 'экономист — не юрист ОСП')
      assert.equal((await cell('ctr-4').innerText()).trim(), '—', 'заблокированного в справочнике нет')

      const panel = await openOptions(page, row(page, 'ctr-5').locator('td.cell-lawyer .fdrop-trigger'))
      assert.deepEqual(await panel.locator('.fdrop-option-text').allInnerTexts(), ['—', ...LAWYERS])
      await panel.locator('.fdrop-option', { hasText: 'Правова Анна Сергеевна' }).click()
      await page.waitForFunction(() => window.__fakeDb.contracts.find((c) => c.id === 'ctr-5')?.responsible_user_id === 'law-2')
      assert.equal('responsible_contact_id' in (await contract(page, 'ctr-5')), false, 'прежнее поле не пишется')
      await page.waitForFunction(() => (window.__fakeDb.contract_audit_log || []).some((e) => e.contract_id === 'ctr-5'))
      const log = await page.evaluate(() => window.__fakeDb.contract_audit_log.filter((e) => e.contract_id === 'ctr-5'))
      assert.deepEqual(log.map((e) => [e.field_name, e.old_value, e.new_value, e.description]),
        [['responsible_user_id', null, 'Правова Анна Сергеевна', 'Ответственный юрист: — → Правова Анна Сергеевна']])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('фильтр «Все юристы» — только назначенные юристы ОСП; отбор по юристу', async () => {
    const { page, errors, close } = await open()
    try {
      const panel = await openOptions(page, page.locator('.fdrop', { hasText: 'Все юристы' }).locator('.fdrop-trigger'))
      assert.deepEqual(await panel.locator('.fdrop-option-text').allInnerTexts(), ['Все юристы', 'Юристова Юлия Юрьевна'])
      await panel.locator('.fdrop-option', { hasText: 'Юристова' }).click()
      await page.waitForFunction(() => document.querySelectorAll('.contracts-table tbody tr.contract-row').length === 1)
      assert.equal(await row(page, 'ctr-1').count(), 1)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('форма договора: в списке только юристы ОСП; правка договора со скрытым юристом его не стирает; новый юрист пишется', async () => {
    const { page, errors, close } = await open()
    try {
      await row(page, 'ctr-2').locator('.btn-edit').click()
      const select = page.locator('select#contract-form-lawyer')
      await select.waitFor()
      assert.deepEqual(await select.locator('option').allInnerTexts(), ['— Не назначен —', ...LAWYERS])
      assert.equal(await select.inputValue(), '', 'экономист в форме не показан')
      await page.locator('.modal input[name="contract_number"]').fill('2/26-изм')
      await page.locator('.modal button[type="submit"]').click()
      await page.waitForFunction(() => window.__fakeDb.contracts.find((c) => c.id === 'ctr-2')?.contract_number === '2/26-изм')
      assert.equal((await contract(page, 'ctr-2')).responsible_user_id, 'eco-1', 'не показанного юриста форма не трогает')

      await row(page, 'ctr-1').locator('.btn-edit').click()
      await select.waitFor()
      assert.equal(await select.inputValue(), 'law-1')
      await select.selectOption('law-2')
      await page.locator('.modal button[type="submit"]').click()
      await page.waitForFunction(() => window.__fakeDb.contracts.find((c) => c.id === 'ctr-1')?.responsible_user_id === 'law-2')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('отчёт «По ответственным юристам»: только юристы ОСП, экономист и заблокированный — в «Не назначен»', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    try {
      await page.goto(`${stand.url}?route=/reports&contracts=30&contractsLawyers=1&latency=10&shell=1`)
      await page.locator('.reports-tabs').waitFor({ timeout: 120000 })
      await page.locator('.reports-tab', { hasText: 'Договоры' }).click()
      const section = page.locator('.report-section', { has: page.locator('h3', { hasText: 'По ответственным юристам' }) })
      await section.locator('tbody tr').first().waitFor()
      await page.waitForFunction(() => [...document.querySelectorAll('.report-section tbody td')].some((td) => td.textContent === 'Юристова Юлия Юрьевна'))
      const names = await section.locator('tbody tr td:nth-child(2)').allInnerTexts()
      assert.deepEqual(names, ['Юристова Юлия Юрьевна', 'Не назначен'])
      const requested = await page.evaluate(() => window.__supabaseStats.requests.filter((r) => r.table === 'rpc:list_osp_lawyers').length)
      assert.ok(requested >= 1, 'юристы — из list_osp_lawyers, а не из справочника сотрудников')
      assert.deepEqual(errors, [])
    } finally { await context.close().catch(() => {}) }
  })

  it('без миграции (колонки юриста нет): столбец пустой, правка договора без юриста сохраняется, поле не отправляется', async () => {
    const { page, errors, dialogs, close } = await open('')
    try {
      assert.equal((await row(page, 'ctr-5').locator('td.cell-lawyer .fdrop-value').innerText()).trim(), '—')
      await row(page, 'ctr-5').locator('.btn-edit').click()
      await page.locator('.modal input[name="contract_number"]').fill('5/26-изм')
      await page.locator('.modal button[type="submit"]').click()
      await page.waitForFunction(() => window.__fakeDb.contracts.find((c) => c.id === 'ctr-5')?.contract_number === '5/26-изм')
      assert.equal('responsible_user_id' in (await contract(page, 'ctr-5')), false, 'responsible_user_id не отправлен')
      assert.deepEqual(dialogs, [])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
