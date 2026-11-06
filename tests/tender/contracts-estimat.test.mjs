// «Реестр по договорам» (/contracts/registry): плашка «Estimat» рядом с номером договора и в строке ДС — три состояния по кругу, цвет
// меняется, как у «ТГ» в тендерах ОС (миграция 20261211). Стенд: contractsEstimat=1 — колонки есть, ctr-1 загружен, ctr-4 —
// «не загружать», ctr-3 — ДС договора ctr-2, ctr-7 удалён, ctr-10 с длинным номером. Правила — tests/contracts/contract-estimat.test.mjs.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const BASE = 'route=/contracts/registry&contracts=24&latency=0'
const ESTIMAT = `${BASE}&contractsEstimat=1`
const CHIP = '.estimat-chip'

describe('Договоры и ДС: плашка Estimat', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  const open = async (query, { viewport = { width: 1600, height: 1000 }, wait = '.contracts-table tbody tr.contract-row' } = {}) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    await page.addInitScript(() => { try { localStorage.clear() } catch { /* нет */ } })
    await page.goto(`${stand.url}?${query}`)
    await page.locator(wait).first().waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  // Строка договора по номеру: «2/26» не должно находить «12/26».
  const rowOf = (page, number) => page.locator('.contracts-table tbody tr.contract-row', { hasText: new RegExp(`(?<![0-9])${number}/26`) }).first()
  const dbDoc = (page, id) => page.evaluate((x) => {
    const { estimat_status: status, estimat_status_at: at, estimat_status_by: by } = window.__fakeDb.contracts.find((c) => c.id === x)
    return { status, at, by }
  }, id)
  const waitStatus = (page, id, status) => page.waitForFunction(([x, s]) => (
    window.__fakeDb.contracts.find((c) => c.id === x)?.estimat_status === s
  ), [id, status])
  const color = (chip) => chip.evaluate((el) => getComputedStyle(el).color)

  it('плашка в строке договора: справа от номера, в той же ячейке и той же строке; три цвета', async () => {
    const { page, errors, close } = await open(ESTIMAT)
    try {
      const chip = rowOf(page, 2).locator(`td.cell-contract-num ${CHIP}`)
      assert.equal((await chip.innerText()).trim(), 'Estimat')
      const number = rowOf(page, 2).locator('.cds-main')
      const [c, n] = [await chip.boundingBox(), await number.boundingBox()]
      assert.ok(c.y < n.y + n.height && n.y < c.y + c.height, 'плашка — на строке номера, а не под ним')
      assert.ok(c.x >= n.x + 20, 'плашка правее номера')
      assert.ok(c.height <= 20, `мини-блок, высота ${c.height}px`)

      // Отдельного столбца нет.
      assert.equal(await page.locator('.contracts-table thead th', { hasText: 'Estimat' }).count(), 0)

      const none = await color(chip)
      const uploaded = await color(rowOf(page, 1).locator(CHIP))
      const skip = await color(rowOf(page, 4).locator(CHIP))
      assert.equal(new Set([none, uploaded, skip]).size, 3, `цвета: ${none}, ${uploaded}, ${skip}`)
      assert.match(await rowOf(page, 1).locator(CHIP).getAttribute('class'), /\bis-pub\b/)
      assert.match(await rowOf(page, 4).locator(CHIP).getAttribute('class'), /\bis-skip\b/)
      assert.match(await chip.getAttribute('class'), /\bis-unpub\b/)
      assert.equal(await rowOf(page, 1).locator(CHIP).getAttribute('title'), 'Загружено в Estimat · Иванов И. И. · 20.10.2026')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('нажатие — следующее состояние по кругу, кто и когда, журнал; строка не раскрывается', async () => {
    const { page, errors, close } = await open(ESTIMAT)
    try {
      const chip = rowOf(page, 2).locator(CHIP)

      await chip.click()
      await waitStatus(page, 'ctr-2', 'uploaded')
      await page.waitForFunction(() => (window.__fakeDb.contract_audit_log || []).length === 1)
      let doc = await dbDoc(page, 'ctr-2')
      assert.equal(doc.by, 'Тест')
      assert.ok(doc.at)
      await page.waitForFunction(() => document.querySelector('tr.contract-row .estimat-chip.is-pub:not([title*="Иванов"])'))
      assert.match(await chip.getAttribute('class'), /\bis-pub\b/)
      assert.match(await chip.getAttribute('title'), /^Загружено в Estimat · Тест · /)
      assert.equal(await page.locator('.ce2-ds').count(), 0, 'нажатие на плашку не раскрывает строку')

      await chip.click()
      await waitStatus(page, 'ctr-2', 'skip')
      await page.waitForFunction(() => (window.__fakeDb.contract_audit_log || []).length === 2)
      assert.match(await chip.getAttribute('class'), /\bis-skip\b/)
      assert.equal((await dbDoc(page, 'ctr-2')).by, 'Тест')

      await chip.click()
      await waitStatus(page, 'ctr-2', 'none')
      await page.waitForFunction(() => (window.__fakeDb.contract_audit_log || []).length === 3)
      doc = await dbDoc(page, 'ctr-2')
      assert.deepEqual([doc.at, doc.by], [null, null], 'снятая отметка не помнит, кто её ставил')
      assert.match(await chip.getAttribute('class'), /\bis-unpub\b/)

      const log = await page.evaluate(() => window.__fakeDb.contract_audit_log.map((e) => [e.contract_id, e.event_type, e.field_name, e.old_value, e.new_value]))
      assert.deepEqual(log[0], ['ctr-2', 'field_updated', 'estimat_status', 'Не загружено в Estimat', 'Загружено в Estimat'])
      assert.deepEqual(log[2].slice(3), ['Не загружать в Estimat', 'Не загружено в Estimat'])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('у ДС плашка своя: не внутри кнопки строки, не меняет договор, список не сворачивает', async () => {
    const { page, errors, close } = await open(ESTIMAT)
    try {
      await rowOf(page, 2).locator('.ds-count-badge.ds-toggle').click()
      const ds = page.locator('.ce2-ds', { hasText: '№ 3/26' })
      await ds.waitFor()
      assert.equal(await page.locator(`.ce2-ds-toggle ${CHIP}`).count(), 0, 'кнопка в кнопке недопустима')
      const chip = ds.locator(`.ce2-ds-head > ${CHIP}`)
      const expanded = await ds.locator('.ce2-ds-toggle').getAttribute('aria-expanded')

      await chip.click()
      await waitStatus(page, 'ctr-3', 'uploaded')
      await page.waitForFunction(() => document.querySelector('.ce2-ds-head > .estimat-chip.is-pub'))
      assert.equal((await dbDoc(page, 'ctr-2')).status, 'none', 'договор не задет')
      assert.match(await rowOf(page, 2).locator(CHIP).getAttribute('class'), /\bis-unpub\b/)
      assert.equal(await ds.locator('.ce2-ds-toggle').getAttribute('aria-expanded'), expanded)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('длинный номер в узком окне: переносится, плашка на месте и не вылезает из ячейки', async () => {
    const { page, errors, close } = await open(ESTIMAT, { viewport: { width: 1280, height: 900 } })
    try {
      const row = page.locator('.contracts-table tbody tr.contract-row', { hasText: 'СУ10-2026/00123' })
      const chip = row.locator(CHIP)
      await chip.scrollIntoViewIfNeeded()
      const [c, link, cell] = await Promise.all([
        chip.boundingBox(), row.locator('.contract-ds-link').boundingBox(), row.locator('td.cell-contract-num').boundingBox(),
      ])
      assert.ok(link.x + link.width <= c.x + 1, 'номер не наезжает на плашку')
      assert.ok(c.x + c.width <= cell.x + cell.width, 'плашка в пределах ячейки')
      assert.ok(c.width >= 50, `плашка не сжата, ширина ${c.width}px`)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без права правки: только просмотр, нажатие ничего не пишет', async () => {
    const { page, errors, close } = await open(`${ESTIMAT}&canEdit=0`)
    try {
      assert.equal(await page.locator(`button${CHIP}`).count(), 0)
      const chip = rowOf(page, 1).locator(CHIP)
      assert.match(await chip.getAttribute('class'), /\bis-pub\b.*\bis-readonly\b/)
      assert.match(await chip.getAttribute('title'), /Иванов И\. И\./)
      await chip.click()
      assert.equal((await dbDoc(page, 'ctr-1')).status, 'uploaded')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('запись не задела строку (нет права, документ удалён): сообщение, цвет прежний', async () => {
    const { page, close } = await open(ESTIMAT)
    try {
      const chip = rowOf(page, 2).locator(CHIP)
      await page.evaluate(() => { window.__fakeDb.contracts = window.__fakeDb.contracts.filter((c) => c.id !== 'ctr-2') })
      // Обработчик — до нажатия: alert держит нажатие, пока окно не закрыто.
      const shown = new Promise((resolve) => page.once('dialog', async (d) => { await d.accept(); resolve(d.message()) }))
      await chip.click()
      assert.match(await shown, /не сохранена/)
      assert.match(await chip.getAttribute('class'), /\bis-unpub\b/)
      assert.equal(await page.evaluate(() => (window.__fakeDb.contract_audit_log || []).length), 0, 'несуществующее в журнал не пишем')
    } finally { await close() }
  })

  it('удалённые документы — без плашки', async () => {
    const { page, errors, close } = await open(ESTIMAT)
    try {
      await page.locator('.status-tab', { hasText: 'Удаленные' }).click()
      const row = rowOf(page, 7)
      await row.waitFor()
      assert.equal(await row.locator(CHIP).count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('телефон: плашка в карточке, нажатие меняет отметку и не открывает карточку', async () => {
    const { page, errors, close } = await open(ESTIMAT, { viewport: { width: 390, height: 800 }, wait: '.mcard' })
    try {
      const card = page.locator('.mcard', { hasText: /(?<![0-9])2\/26/ }).first()
      const chip = card.locator(CHIP)
      const box = await chip.boundingBox()
      assert.ok(box.height >= 32, `палец попадает: высота ${box.height}px`)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'нет прокрутки вбок')

      await chip.click()
      await waitStatus(page, 'ctr-2', 'uploaded')
      await page.waitForFunction(() => document.querySelector('.mcard .estimat-chip.is-pub:not([title*="Иванов"])'))
      assert.ok(await card.isVisible(), 'остались в реестре, карточка договора не открылась')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('миграции нет (колонок нет): плашки нет, остальной реестр как раньше', async () => {
    const { page, errors, close } = await open(BASE)
    try {
      assert.equal(await page.locator(CHIP).count(), 0)
      assert.equal(await rowOf(page, 2).locator('.contract-ds-link').count(), 1)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
