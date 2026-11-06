// «Реестр по договорам» (/contracts/registry): страница-хаб, как у «Тендеров», внутри четыре блока — реестр и три вида заявок. Один пункт
// меню вместо четырёх; права прежние: у каждого блока своё, закрытый блок не виден и к его таблице нет запроса.
// Стенд tests/tender/ui, Chromium. Сами страницы блоков — их тесты (contracts-*, dc-request-*, dp-requests, doc-check-*).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO as ROOT } from './lib/stand.mjs'
import { CONTRACT_SECTIONS, CONTRACT_SECTION_KEYS, contractsEntry, isContractsPath } from '../../src/utils/contractsHub.js'
import { SECTIONS } from '../../src/contexts/roleConstants.js'

const launch = browserLaunchOptions()
const SHOTS = process.env.CONTRACTS_HUB_SHOTS || ''
const TITLES = ['Реестр по договорам', 'Заявка на ДС', 'Заявка на заключение ДП', 'Заявки на проверку ДП/ДС']
const DATA = 'contracts=12&contractsMixed=1&dcStats=1&docCheck=1&latency=0'
const canViewOnly = (...open) => (section) => open.includes(section)

describe('Договоры и ДС: правила блоков', () => {
  it('подпись блока и раздела прав — одна и та же, ключи прав прежние', () => {
    assert.deepEqual(CONTRACT_SECTION_KEYS, ['contracts', 'dc_requests', 'dp_requests', 'doc_check_requests'])
    assert.deepEqual(CONTRACT_SECTIONS.map((s) => s.title), TITLES)
    for (const { section, title } of CONTRACT_SECTIONS) assert.equal(SECTIONS[section], title)
  })

  it('куда ведёт пункт меню: хаб, единственный блок или никуда', () => {
    assert.equal(contractsEntry(() => true), '/contracts')
    assert.equal(contractsEntry(canViewOnly('contracts', 'dp_requests')), '/contracts')
    assert.equal(contractsEntry(canViewOnly('contracts')), '/contracts/registry')
    assert.equal(contractsEntry(canViewOnly('dc_requests')), '/dc-requests')
    assert.equal(contractsEntry(canViewOnly('dp_requests')), '/dp-requests')
    assert.equal(contractsEntry(canViewOnly('doc_check_requests')), '/doc-check-requests')
    assert.equal(contractsEntry(canViewOnly('tenders')), null, 'чужой раздел не открывает пункт')
    // «Заявка на заключение ДП: создание» без просмотра реестра заявок страницу не открывает — как раньше.
    assert.equal(contractsEntry(canViewOnly('dp_requests_create')), null)
  })

  it('пункт меню подсвечен на всех страницах блоков, на чужих — нет', () => {
    for (const p of ['/contracts', '/contracts/registry', '/contracts/psdc-batch', '/contracts/ab-12', '/dc-requests', '/dp-requests', '/doc-check-requests']) {
      assert.equal(isContractsPath(p), true, p)
    }
    for (const p of ['/contractor', '/contractor-bids', '/reports', '/tenders', '/general']) assert.equal(isContractsPath(p), false, p)
  })

  it('маршруты: у каждой страницы прежнее право, хаб открыт при любом из четырёх', () => {
    const app = readFileSync(resolve(ROOT, 'src/App.jsx'), 'utf8')
    const gate = (path) => {
      const line = app.split('\n').find((l) => l.includes(`<Route path=${path} `))
      assert.ok(line, `нет маршрута ${path}`)
      return line.match(/<PermissionRoute ([^>]*)>/)?.[1]
    }
    assert.equal(gate('"/contracts"'), 'anyOf={CONTRACT_SECTION_KEYS}')
    assert.equal(gate('{CONTRACTS_REGISTRY_PATH}'), 'section="contracts"')
    assert.equal(gate('"/contracts/psdc-batch"'), 'section="contracts"')
    assert.equal(gate('"/contracts/:contractId"'), 'section="contracts"')
    assert.equal(gate('"/dc-requests"'), 'section="dc_requests"')
    assert.equal(gate('"/dp-requests"'), 'section="dp_requests"')
    assert.equal(gate('"/doc-check-requests"'), 'section="doc_check_requests"')
    assert.match(app, /contractsEntry\(canView\)\) to = contractsEntry\(canView\)/, 'стартовая страница знает все четыре блока')
  })
})

describe('Договоры и ДС: страница-хаб', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open(query, viewport = { width: 1600, height: 900 }) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${stand.url}?${query}`)
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const titles = (page) => page.locator('.contracts-hub .thub-card .thub-title').allInnerTexts()
  const card = (page, title) => page.locator('.contracts-hub .thub-card', { hasText: title })
  const badge = async (page, title, label) => {
    const el = card(page, title).locator('.thub-count', { hasText: label })
    return (await el.count()) ? Number(await el.locator('strong').innerText()) : 0
  }
  const tabCount = async (page, label) => Number(await page.locator('.status-tab', { hasText: label }).locator('.tab-count').innerText())
  const requested = (page) => page.evaluate(() => [...new Set(window.__supabaseStats.requests.map((r) => r.table))])
  // Счётчики подгружаются после карточек.
  const countersLoaded = (page) => page.waitForFunction(() => {
    const tables = new Set(window.__supabaseStats.requests.map((r) => r.table))
    return window.__supabaseStats.active === 0 && tables.size > 0
  })

  it('четыре блока одной сетки: заголовок, описание, переход; вид как у «Тендеров»', async () => {
    const { page, errors, close } = await open(`route=/contracts&${DATA}&shell=1`)
    try {
      await page.locator('.contracts-hub').waitFor({ timeout: 120000 })
      assert.equal(await page.locator('.thub-header h2').innerText(), 'Договоры и ДС')
      assert.deepEqual(await titles(page), TITLES)
      const hrefs = await page.locator('.contracts-hub .thub-btn').evaluateAll((els) => els.map((a) => a.getAttribute('href')))
      assert.deepEqual(hrefs, ['/contracts/registry', '/dc-requests', '/dp-requests', '/doc-check-requests'])
      assert.equal(await page.locator('.contracts-hub .thub-desc').count(), 4)

      // Стили «Тендеров» подключены самой страницей: блоки — по два в ряд, одной высоты.
      const boxes = await page.locator('.contracts-hub .thub-card').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()))
      assert.equal(Math.round(boxes[0].top), Math.round(boxes[1].top))
      assert.equal(Math.round(boxes[2].top), Math.round(boxes[3].top))
      assert.ok(boxes[2].top > boxes[0].top)
      assert.equal(Math.round(boxes[0].height), Math.round(boxes[1].height))
      await countersLoaded(page)
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/contracts-hub.png` })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('блоки ведут на свои страницы; назад — снова хаб', async () => {
    const { page, errors, close } = await open(`route=/contracts&${DATA}`)
    try {
      await card(page, 'Реестр по договорам').locator('.thub-btn').click()
      await page.locator('.contracts-page-v2 h2', { hasText: 'Реестр по договорам' }).waitFor({ timeout: 120000 })
      await page.evaluate(() => window.__navigate(-1))
      await card(page, 'Заявка на ДС').locator('.thub-btn').click()
      await page.locator('.dc-requests-page').waitFor({ timeout: 120000 })
      await page.evaluate(() => window.__navigate('/contracts'))
      await card(page, 'Заявки на проверку ДП/ДС').locator('.thub-btn').click()
      await page.locator('.doc-check-page').waitFor({ timeout: 120000 })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('число на карточке равно вкладке или колонке на странице блока', async () => {
    // Сначала страница заявок на ДП: её данные подгружает стенд этой страницы.
    const { page, errors, close } = await open(`route=/dp-requests&${DATA}`)
    try {
      await page.locator('.dp-requests-page .status-tab').first().waitFor({ timeout: 120000 })
      const dp = { new: await tabCount(page, 'Новые'), work: await tabCount(page, 'В работе') }
      await page.evaluate(() => window.__navigate('/contracts'))
      await page.locator('.contracts-hub').waitFor()
      await page.waitForFunction(() => document.querySelectorAll('.contracts-hub .thub-count').length >= 4)
      assert.ok(dp.new > 0 && dp.work > 0)
      assert.equal(await badge(page, 'Заявка на заключение ДП', 'нов'), dp.new)
      assert.equal(await badge(page, 'Заявка на заключение ДП', 'в работе'), dp.work)

      const shown = {
        registry: await badge(page, 'Реестр по договорам', 'в работе'),
        dc: await badge(page, 'Заявка на ДС', 'в работе'),
        checkNew: await badge(page, 'Заявки на проверку', 'нов'),
        checkWork: await badge(page, 'Заявки на проверку', 'в работе'),
      }
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/contracts-hub-counters.png` })
      assert.ok(Object.values(shown).every((n) => n > 0), JSON.stringify(shown))

      await card(page, 'Реестр по договорам').locator('.thub-btn').click()
      await page.locator('.contracts-page-v2 .status-tab').first().waitFor({ timeout: 120000 })
      assert.equal(await tabCount(page, 'В работе'), shown.registry)

      await page.evaluate(() => window.__navigate('/dc-requests'))
      await page.locator('.dc-requests-page .status-tab').first().waitFor({ timeout: 120000 })
      assert.equal(await tabCount(page, 'В работе'), shown.dc)

      await page.evaluate(() => window.__navigate('/doc-check-requests'))
      await page.locator('.dc-column-head').first().waitFor({ timeout: 120000 })
      const column = (title) => page.locator('.dc-column-head', { hasText: title }).locator('.dc-column-count').first().innerText()
      assert.equal(Number(await column('Новые заявки')), shown.checkNew)
      assert.equal(Number(await column('В работе')), shown.checkWork)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('сотрудник объекта: счётчики реестра и заявок на ДС — только по его объектам', async () => {
    const { page, close } = await open(`route=/contracts&${DATA}&scope=obj-1`)
    try {
      await page.locator('.contracts-hub').waitFor({ timeout: 120000 })
      await page.waitForFunction(() => document.querySelectorAll('.contracts-hub .thub-count').length > 0)
      await countersLoaded(page)
      const shown = await badge(page, 'Реестр по договорам', 'в работе')
      await card(page, 'Реестр по договорам').locator('.thub-btn').click()
      await page.locator('.contracts-page-v2 .status-tab').first().waitFor({ timeout: 120000 })
      assert.equal(await tabCount(page, 'В работе'), shown)
    } finally { await close() }
  })

  it('закрытых блоков нет на странице, к их таблицам нет запросов', async () => {
    const { page, errors, close } = await open(`route=/contracts&${DATA}&noView=dc_requests,dp_requests`)
    try {
      await page.locator('.contracts-hub').waitFor({ timeout: 120000 })
      assert.deepEqual(await titles(page), ['Реестр по договорам', 'Заявки на проверку ДП/ДС'])
      await page.waitForFunction(() => document.querySelectorAll('.contracts-hub .thub-count').length > 0)
      await countersLoaded(page)
      const tables = await requested(page)
      assert.ok(tables.includes('contracts') && tables.includes('doc_check_requests'), tables.join())
      assert.ok(!tables.includes('dc_requests') && !tables.includes('dp_requests'), tables.join())
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/contracts-hub-two.png` })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без права на реестр — только заявки', async () => {
    const { page, close } = await open(`route=/contracts&${DATA}&noView=contracts`)
    try {
      await page.locator('.contracts-hub').waitFor({ timeout: 120000 })
      assert.deepEqual(await titles(page), TITLES.slice(1))
      await page.waitForFunction(() => document.querySelectorAll('.contracts-hub .thub-count').length > 0)
      await countersLoaded(page)
      assert.ok(!(await requested(page)).includes('contracts'))
    } finally { await close() }
  })

  for (const [closed, selector] of [
    ['dc_requests,dp_requests,doc_check_requests', '.contracts-page-v2'],
    ['contracts,dp_requests,doc_check_requests', '.dc-requests-page'],
    ['contracts,dc_requests,dp_requests', '.doc-check-page'],
  ]) {
    it(`один доступный блок открывается сразу, выбирать не из чего (${selector})`, async () => {
      const { page, errors, close } = await open(`route=/contracts&${DATA}&noView=${closed}`)
      try {
        await page.locator(selector).first().waitFor({ timeout: 120000 })
        assert.equal(await page.locator('.contracts-hub').count(), 0)
        assert.deepEqual(errors, [])
      } finally { await close() }
    })
  }

  it('ни одного доступного блока — отказ, а не пустая страница', async () => {
    const { page, close } = await open(`route=/contracts&${DATA}&noView=contracts,dc_requests,dp_requests,doc_check_requests`)
    try {
      await page.getByRole('heading', { name: 'Нет прав для просмотра раздела' }).waitFor({ timeout: 120000 })
      assert.equal(await page.locator('.contracts-hub').count(), 0)
      assert.deepEqual(await requested(page).then((t) => t.filter((n) => ['contracts', 'dc_requests', 'dp_requests', 'doc_check_requests'].includes(n))), [])
    } finally { await close() }
  })

  it('прежняя ссылка /contracts?ds=… открывает реестр с тем же действием', async () => {
    const route = encodeURIComponent('/contracts?ds=1&ds_type=ds_vor')
    const { page, errors, close } = await open(`route=${route}&contracts=6&latency=0`)
    try {
      await page.locator('.contracts-page-v2').waitFor({ timeout: 120000 })
      assert.equal(await page.locator('.contracts-hub').count(), 0)
      // Форма нового ДС открылась по параметрам адреса, как раньше.
      await page.locator('.modal-content, .modal').first().waitFor({ timeout: 30000 })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('боковое меню: один пункт вместо четырёх, подсвечен на всех страницах блоков', async () => {
    const { page, close } = await open(`route=/contracts&${DATA}&shell=1&sidebar=1`)
    try {
      await page.locator('.sidebar .nav-item').first().waitFor({ timeout: 120000 })
      const labels = await page.locator('.sidebar-nav .nav-item').evaluateAll((els) => els.map((a) => a.getAttribute('title')))
      assert.equal(labels.filter((l) => l === 'Договоры и ДС').length, 1)
      for (const old of ['Заявка на ДС', 'Заявка на заключение ДП', 'Заявки на проверку ДП/ДС']) assert.ok(!labels.includes(old), old)
      const item = page.locator('.sidebar-nav .nav-item[title="Договоры и ДС"]')
      assert.equal(await item.getAttribute('href'), '/contracts')
      for (const path of ['/contracts', '/contracts/registry', '/dc-requests', '/doc-check-requests']) {
        await page.evaluate((p) => window.__navigate(p), path)
        await page.waitForFunction(() => document.querySelector('.sidebar-nav .nav-item[title="Договоры и ДС"]')?.classList.contains('active'))
      }
      await page.evaluate(() => window.__navigate('/reports'))
      await page.waitForFunction(() => !document.querySelector('.sidebar-nav .nav-item[title="Договоры и ДС"]')?.classList.contains('active'))
    } finally { await close() }
  })

  it('боковое меню по правам: один блок — сразу в него, ни одного — пункта нет', async () => {
    const single = await open(`route=/dc-requests&dcStats=1&latency=0&shell=1&sidebar=1&noView=contracts,dp_requests,doc_check_requests`)
    try {
      const item = single.page.locator('.sidebar-nav .nav-item[title="Договоры и ДС"]')
      await item.waitFor({ timeout: 120000 })
      assert.equal(await item.getAttribute('href'), '/dc-requests')
      assert.match(await item.getAttribute('class'), /\bactive\b/)
    } finally { await single.close() }

    const none = await open(`route=/reports&latency=0&shell=1&sidebar=1&noView=contracts,dc_requests,dp_requests,doc_check_requests`)
    try {
      await none.page.locator('.sidebar .nav-item').first().waitFor({ timeout: 120000 })
      assert.equal(await none.page.locator('.sidebar-nav .nav-item[title="Договоры и ДС"]').count(), 0)
    } finally { await none.close() }
  })

  it('телефон: блоки столбцом, без горизонтальной прокрутки', async () => {
    const { page, close } = await open(`route=/contracts&${DATA}`, { width: 390, height: 844 })
    try {
      await page.locator('.contracts-hub').waitFor({ timeout: 120000 })
      const boxes = await page.locator('.contracts-hub .thub-card').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()))
      assert.ok(boxes[1].top >= boxes[0].bottom, 'блоки друг под другом')
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/contracts-hub-phone.png`, fullPage: true })
    } finally { await close() }
  })
})
