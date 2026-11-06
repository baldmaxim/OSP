// «Реестр по договорам» (/contracts/registry): разделение на ОС и ГО, пять вкладок статуса, «Наши договоры» и «Без тендера» — фильтры в
// панели, тендер у договора и ДС (03.11). Правила — tests/contracts/registry-tabs.test.mjs.
// Стенд: 24 документа, 16 договоров и 8 ДС; каждый четвёртый — по объекту ГО; у ctr-2 — тендер, ДС ctr-3 берёт его же.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const BASE = 'route=/contracts/registry&contracts=24&contractsDept=1&latency=0'

describe('Договоры и ДС: ОС и ГО, тендер', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  const open = async (viewport = { width: 1600, height: 1000 }) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    await page.goto(`${stand.url}?${BASE}`)
    await page.locator('.contracts-table tbody tr.contract-row').first().waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const counts = (page, sel) => page.locator(sel).evaluateAll((els) => Object.fromEntries(els.map((b) => [
    b.firstChild.textContent.trim(), Number(b.querySelector('[class$="-count"]')?.textContent),
  ])))
  const dept = (page, label) => page.locator('.registry-scope-btn', { hasText: new RegExp(`^${label}`) })
  const rowCount = (page) => page.locator('.contracts-table tbody tr.contract-row').count()
  // Строка договора по номеру: «2/26» не должно находить «12/26».
  const rowOf = (page, number) => page.locator('.contracts-table tbody tr.contract-row', { hasText: new RegExp(`(?<![0-9])${number}/26`) }).first()

  it('шапка: «Все договоры» · ОС · ГО с числами; строки, вкладки и объекты — выбранного отдела; выбор запоминается', async () => {
    const { page, errors, close } = await open()
    try {
      const all = await counts(page, '.registry-scope-btn')
      assert.deepEqual(Object.keys(all), ['Все договоры', 'ОС', 'ГО'])
      assert.equal(all['ОС'] + all['ГО'], all['Все договоры'])
      assert.equal(all['Все договоры'], 24)
      assert.equal(all['ГО'], 6)

      await dept(page, 'ГО').click()
      assert.equal(await dept(page, 'ГО').getAttribute('aria-selected'), 'true')
      assert.equal(await rowCount(page) > 0, true)
      const shownObjects = await page.locator('.contracts-table tbody tr.contract-row td.cell-object').allInnerTexts()
      assert.ok(shownObjects.length > 0 && shownObjects.every((t) => /Гарантийный/.test(t)), shownObjects.join(' | '))
      const tabs = await counts(page, '.status-tab')
      assert.equal(tabs['Все'], 6, 'вкладки считают выбранный отдел')

      // Объекты в фильтре — только этого отдела.
      await page.locator('.cr-toolbar .fdrop-trigger').first().click()
      const options = await page.locator('.fdrop-panel .fdrop-option').allInnerTexts()
      assert.ok(options.some((o) => /Гарантийный/.test(o)))
      assert.ok(!options.some((o) => /Северный|Нурлы/.test(o)), options.join(' | '))
      await page.keyboard.press('Escape')

      await page.reload()
      await page.locator('.contracts-table tbody tr.contract-row').first().waitFor()
      assert.equal(await dept(page, 'ГО').getAttribute('aria-selected'), 'true', 'отдел помнится после обновления')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('вкладок пять, названия «Общий реестр» нет; документ «В работе», заявка и ожидание подписания — на одной; вид — «Договоры и ДС», «Договоры», «ДС»', async () => {
    const { page, errors, close } = await open()
    try {
      assert.deepEqual(
        await page.locator('.status-tab').evaluateAll((els) => els.map((b) => b.firstChild.textContent.trim())),
        ['Все', 'В работе', 'Приостановка', 'Завершено', 'Удаленные'],
      )
      assert.deepEqual(await page.locator('.rf-doc-kind-btn').allInnerTexts(), ['Договоры и ДС', 'Договоры', 'ДС'])
      assert.equal(await page.getByText('Общий реестр').count(), 0)
      assert.match(await page.locator('.registry-pagination.is-top .rp-info').innerText(), /договоров · ДС к ним: 8/, 'сколько договоров и ДС — видно над таблицей')

      const tabs = await counts(page, '.status-tab')
      assert.equal(tabs['Приостановка'], 1)
      assert.equal(tabs['Завершено'], 2)
      assert.equal(tabs['В работе'], 21, 'новая заявка и ожидание подписания — в «В работе»')
      await page.locator('.status-tab', { hasText: 'В работе' }).click()
      const statuses = (await page.locator('.contracts-table tbody tr.contract-row .cell-status').allInnerTexts()).join(' ')
      assert.match(statuses, /Новая заявка/)
      assert.match(statuses, /Ожидание подписания/, 'точный статус виден в строке')
      const clipped = await page.locator('.contracts-table tbody tr.contract-row td.cell-status .status-badge')
        .evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent))
      assert.deepEqual(clipped, [], 'статус не обрезан')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Наши договоры» — фильтр в панели: число, отбор, «Сбросить» снимает; отдел остаётся', async () => {
    const { page, errors, close } = await open()
    try {
      const ours = page.locator('.cr-toolbar .qfilter', { hasText: 'Наши договоры' })
      assert.match(await ours.innerText(), /1$/)
      await dept(page, 'ОС').click()
      await ours.click()
      assert.equal(await ours.getAttribute('aria-pressed'), 'true')
      assert.equal(await rowCount(page), 1)
      assert.match(await page.locator('.contracts-table tbody tr.contract-row').first().innerText(), /4\/26/)
      await page.locator('.cr-toolbar .cr-filter-clear').click()
      assert.equal(await ours.getAttribute('aria-pressed'), 'false')
      assert.equal(await dept(page, 'ОС').getAttribute('aria-selected'), 'true', 'отдел — не фильтр, «Сбросить» его не снимает')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('тендер: ссылка в строке, ДС — от договора, «Без тендера» — остальные; раскрытый документ тоже показывает', async () => {
    const { page, errors, close } = await open()
    try {
      const link = rowOf(page, 2).locator('a.ctender')
      assert.match(await link.innerText(), /^Тендер № \d+$/)
      assert.match(await link.getAttribute('href'), /\/tenders\/.+/)
      assert.equal(await page.locator('a.ctender').count(), 1, 'в виде «Договоры и ДС» строка — договор')

      await page.locator('.rf-doc-kind-btn', { hasText: /^ДС$/ }).click()
      const inherited = rowOf(page, 3).locator('a.ctender')
      assert.match(await inherited.getAttribute('title'), /^Тендер договора: /, 'ДС берёт тендер договора')
      await page.locator('.rf-doc-kind-btn', { hasText: 'Договоры и ДС' }).click()

      const filter = page.locator('.cr-toolbar .qfilter', { hasText: 'Без тендера' })
      assert.match(await filter.innerText(), /15$/, 'из 16 договоров один с тендером')
      await filter.click()
      assert.equal(await page.locator('.contracts-table tbody tr.contract-row', { hasText: /(?<![0-9])2\/26/ }).count(), 0)
      assert.equal(await page.locator('.registry-pagination.is-top .rp-info').innerText().then((t) => /из 15 договоров/.test(t)), true)
      await page.locator('.cr-toolbar .cr-filter-clear').click()

      await rowOf(page, 2).locator('td.cell-work .work-text').click()
      await page.locator('.ce2-info').first().waitFor()
      assert.match(await page.locator('.ce2-info').first().innerText(), /Тендер\s*Тендер № \d+/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('форма: тендер — поиском среди основных тендеров объекта; у ДС пусто значит «как у договора»', async () => {
    const { page, errors, close } = await open()
    try {
      await rowOf(page, 2).locator('td.cell-work .work-text').click()
      await page.getByRole('button', { name: '+ Создать ДС' }).first().click()
      const form = page.locator('.modal').last()
      await form.waitFor()
      const trigger = form.locator('.form-group', { hasText: 'Тендер (необязательно)' }).locator('.fdrop-trigger')
      await trigger.waitFor()
      assert.match(await trigger.innerText(), /Как у договора: Тендер № \d+/)
      await trigger.click()
      const options = await page.locator('.fdrop-panel .fdrop-option').allInnerTexts()
      assert.ok(options.length > 0 && options.every((o) => /^(№ \d+ · |— Без привязки —)/.test(o)), options.slice(0, 3).join(' | '))
      assert.equal(new Set(options).size, options.length)
      // Поиск — по номеру или описанию; выбранный виден в поле, вернуть «как у договора» — «Без привязки».
      await page.locator('.fdrop-panel .fdrop-search').fill(options[0].match(/№ (\d+)/)[1])
      const found = page.locator('.fdrop-panel .fdrop-option')
      assert.equal(await found.count(), 1)
      await found.first().click()
      assert.match(await trigger.innerText(), /^№ \d+ · /)
      await trigger.click()
      await page.locator('.fdrop-panel .fdrop-option', { hasText: '— Без привязки —' }).click()
      assert.match(await trigger.innerText(), /Как у договора/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
