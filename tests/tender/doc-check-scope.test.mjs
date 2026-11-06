// «Заявки на проверку ДП/ДС»: руководитель строительства и экономист объекта — просмотр, только своих объектов (06.11.2026,
// решение пользователя). Страница в Chromium (стенд tests/tender/ui, route=/doc-check-requests&docCheck=1, ?scope=<объекты>):
//   • с привязкой к объектам — заявки только своих объектов (и в «Архиве», и в «Удалённых»), без объекта — нет; запрос к базе
//     уже с отбором по объектам; в фильтре «Объект» — только свои;
//   • без права правки — ничего не двигается и не создаётся;
//   • счётчики «Договоров и ДС» — те же, что на доске.
// Правило базы (миграция 20270101) — doc-check-scope-db.test.mjs. Люди стенда вымышленные.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
// Рукстрой объекта obj-2 («Бизнес-центр «Нурлы»»): на стенде у него dcr-2 (в работе), dcr-5 (завершено), dcr-6 (ждём скан).
const MANAGER = '&scope=obj-2&canEdit=0&asRole=construction_manager'
const OWN = ['dcr-2', 'dcr-5', 'dcr-6']

describe('Заявки на проверку ДП/ДС: только свои объекты', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  const open = async (query, ready) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1700, height: 950 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => d.accept())
    await page.goto(`${stand.url}?${query}`)
    await page.locator(ready).first().waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const openBoard = (extra) => open(`route=/doc-check-requests&docCheck=1&latency=0${extra}`, '.dc-board, .dc-error')
  const cards = (page) => page.locator('.dc-board .dc-card').evaluateAll((els) => [...new Set(els.map((el) => el.dataset.id))].sort())
  const columnCount = async (page, title) => Number(await page.locator('.dc-column-head', { hasText: title })
    .locator('.dc-column-count').first().innerText())
  const docCheckReads = (page) => page.evaluate(() => window.__supabaseStats.requests.filter((r) => r.table === 'doc_check_requests'))

  it('доска: заявки только своего объекта; запрос — уже с отбором по объектам', async () => {
    const { page, errors, close } = await openBoard(MANAGER)
    try {
      assert.deepEqual(await cards(page), OWN)
      const reads = await docCheckReads(page)
      assert.ok(reads.length > 0)
      for (const r of reads) assert.deepEqual(r.ids, ['obj-2'], 'отбор по объектам — в запросе, а не только на экране')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('фильтр «Объект» — только свои объекты; архив и удалённые чужих объектов не видны', async () => {
    const { page, errors, close } = await openBoard(MANAGER)
    try {
      await page.locator('.dc-toolbar .fdrop-trigger', { hasText: 'Объект' }).click()
      const options = await page.locator('.fdrop-panel .fdrop-option').allInnerTexts()
      assert.equal(options.filter((t) => /Северный квартал/.test(t)).length, 0, options.join(' | '))
      assert.equal(options.filter((t) => /Бизнес-центр/.test(t)).length, 1, options.join(' | '))
      await page.keyboard.press('Escape')
      // Архивная (dcr-8) и удалённая (dcr-9) заявки — чужого объекта: счётчиков у кнопок нет.
      assert.equal((await page.locator('.dc-mode-toggle', { hasText: 'Архив' }).innerText()).trim(), 'Архив')
      assert.equal((await page.locator('.dc-mode-toggle', { hasText: 'Удалённые' }).innerText()).trim(), 'Удалённые')
      await page.locator('.dc-view-btn', { hasText: 'Реестр' }).click()
      const rows = await page.locator('.dc-table tbody tr').count()
      assert.equal(rows, OWN.length)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('только просмотр: нет «+ Новая заявка», «+» в колонках, кружков и меню; заявка открывается без кнопок правки', async () => {
    const { page, errors, close } = await openBoard(MANAGER)
    try {
      assert.equal(await page.getByRole('button', { name: '+ Новая заявка' }).count(), 0)
      assert.equal(await page.locator('.dc-card.is-movable').count(), 0)
      assert.equal(await page.locator('.dc-column-add').count(), 0)
      assert.equal(await page.locator('button.dc-card-check').count(), 0)
      assert.equal(await page.locator('.dc-card-more').count(), 0)
      await page.locator('.dc-card[data-id="dcr-2"]').first().click()
      await page.locator('.dc-detail-modal').waitFor()
      assert.equal(await page.locator('.dc-detail-modal').getByRole('button', { name: 'Изменить' }).count(), 0)
      assert.equal(await page.locator('.dc-detail-modal').getByRole('button', { name: 'Удалить' }).count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('без привязки — как раньше: все объекты, запрос без отбора', async () => {
    const { page, errors, close } = await openBoard('&canEdit=0')
    try {
      const all = await cards(page)
      assert.ok(all.includes('dcr-1') && all.includes('dcr-3') && OWN.every((id) => all.includes(id)), all.join())
      for (const r of await docCheckReads(page)) assert.equal(r.ids, null)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('«Договоры и ДС»: счётчики заявок на проверку — по своим объектам, как на доске', async () => {
    const { page, errors, close } = await open(`route=/contracts&contracts=12&contractsMixed=1&dcStats=1&docCheck=1&latency=0${MANAGER}`, '.contracts-hub')
    try {
      await page.waitForFunction(() => window.__supabaseStats.active === 0
        && window.__supabaseStats.requests.some((r) => r.table === 'doc_check_requests'))
      const counted = await docCheckReads(page)
      assert.ok(counted.length >= 2)
      for (const r of counted) assert.deepEqual(r.ids, ['obj-2'])
      const badge = async (label) => {
        const el = page.locator('.contracts-hub .thub-card', { hasText: 'Заявки на проверку' }).locator('.thub-count', { hasText: label })
        return (await el.count()) ? Number(await el.locator('strong').innerText()) : 0
      }
      const hub = { fresh: await badge('нов'), work: await badge('в работе') }
      await page.evaluate(() => window.__navigate('/doc-check-requests'))
      await page.locator('.dc-column-head').first().waitFor({ timeout: 120000 })
      assert.deepEqual(hub, { fresh: await columnCount(page, 'Новые заявки'), work: await columnCount(page, 'В работе') })
      assert.deepEqual(hub, { fresh: 0, work: 1 })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
