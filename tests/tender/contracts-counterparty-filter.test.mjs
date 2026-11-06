// «Реестр по договорам» (/contracts/registry): фильтр «Контрагент» в панели. Правила — tests/contracts/counterparty-filter.test.mjs.
// Стенд: 24 документа (ДС — у каждого третьего), стороны — «Подрядчик 01» … «Подрядчик 10» по кругу, по объекту ГО — каждый
// четвёртый договор с его ДС.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const BASE = 'route=/contracts/registry&contracts=24&contractsDept=1&latency=0'

describe('Договоры и ДС: фильтр по контрагентам', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  const open = async (viewport = { width: 1600, height: 1000 }, extra = '') => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    await page.goto(`${stand.url}?${BASE}${extra}`)
    await page.locator(viewport.width <= 640 ? '.mcard-list .mcard, .mcard-list > *' : '.contracts-table tbody tr.contract-row').first().waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const trigger = (page) => page.locator('.cr-toolbar .fdrop').nth(1).locator('.fdrop-trigger')
  const shown = async (page) => (await page.locator('.cr-toolbar .fdrop').nth(1).locator('.fdrop-value').innerText()).trim()
  const rows = (page) => page.locator('.contracts-table tbody tr.contract-row')
  const optionsOf = (page) => page.locator('.fdrop-panel .fdrop-option').allInnerTexts()
  const pick = (page, name) => page.locator('.fdrop-panel .fdrop-option', { hasText: name }).click()

  it('сужает реестр до документов контрагента; несколько — вместе; «Сбросить» снимает', async () => {
    const { page, errors, close } = await open()
    try {
      assert.equal(await shown(page), 'Все контрагенты')
      const before = await rows(page).count()

      await trigger(page).click()
      const options = await optionsOf(page)
      assert.equal(options.length, 10, options.join(' | '))
      assert.deepEqual(options, [...options].sort((a, b) => a.localeCompare(b, 'ru')), 'по алфавиту')

      await pick(page, 'Подрядчик 01')
      await page.keyboard.press('Escape')
      assert.equal(await shown(page), 'Подрядчик 01', 'выбранный виден на кнопке')
      const one = await rows(page).count()
      assert.ok(one > 0 && one < before, `строк: ${one} из ${before}`)
      for (const text of await rows(page).allInnerTexts()) assert.match(text, /Подрядчик 01/)

      await trigger(page).click()
      await pick(page, 'Подрядчик 02')
      await page.keyboard.press('Escape')
      assert.equal(await shown(page), 'Выбрано: 2')
      const two = await rows(page).count()
      assert.ok(two > one, `при двух строк больше: ${two} и ${one}`)
      for (const text of await rows(page).allInnerTexts()) assert.match(text, /Подрядчик 0[12]/)

      await page.locator('.cr-toolbar .cr-filter-clear').click()
      assert.equal(await shown(page), 'Все контрагенты')
      assert.equal(await rows(page).count(), before)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('работает вместе с остальными: выбран объект — в списке только контрагенты его документов', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('.cr-toolbar .fdrop').first().locator('.fdrop-trigger').click()
      await page.locator('.fdrop-panel .fdrop-option', { hasText: 'Гарантийный' }).click()
      await page.keyboard.press('Escape')
      const onObject = new Set((await rows(page).allInnerTexts()).flatMap((t) => t.match(/Подрядчик \d\d/g) || []))
      assert.ok(onObject.size > 0)

      await trigger(page).click()
      const options = await optionsOf(page)
      assert.deepEqual(new Set(options), onObject, 'только контрагенты выбранного объекта')
      assert.ok(options.length < 10)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('виден и при смене отдела, где документов этого контрагента нет: на кнопке имя, реестр пуст, но ясно почему', async () => {
    const { page, errors, close } = await open()
    try {
      // На стенде договоры ГО — каждый четвёртый: ищем контрагента, у которого все документы только в ОС.
      await page.locator('.registry-scope-btn', { hasText: /^ГО/ }).click()
      const inGo = new Set((await rows(page).allInnerTexts()).flatMap((t) => t.match(/Подрядчик \d\d/g) || []))
      await page.locator('.registry-scope-btn', { hasText: /^ОС/ }).click()
      await trigger(page).click()
      const only = (await optionsOf(page)).find((name) => !inGo.has(name))
      assert.ok(only, 'на стенде есть контрагент только из ОС')
      await pick(page, only)
      await page.keyboard.press('Escape')

      await page.locator('.registry-scope-btn', { hasText: /^ГО/ }).click()
      assert.equal(await rows(page).count(), 0)
      assert.equal(await shown(page), only, 'выбор виден на кнопке, а не сброшен молча')
      await page.locator('.cr-toolbar .cr-filter-clear').click()
      assert.ok(await rows(page).count() > 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('поиск в списке: написание неважно', async () => {
    const { page, errors, close } = await open()
    try {
      await trigger(page).click()
      const search = page.locator('.fdrop-panel .fdrop-search')
      await search.fill('подрядчик03')
      assert.deepEqual(await optionsOf(page), ['Подрядчик 03'])
      await search.fill('нет такого')
      assert.equal(await page.locator('.fdrop-panel .fdrop-empty').count(), 1)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  // С развёрнутым меню панель в одну строку — от 1820 px окна (05.11, с третьей кнопкой вида «Договоры»), уже — переносится.
  it('панель — одной строкой на мониторе 1920 с развёрнутым меню, на телефоне фильтр во всю ширину', async () => {
    const wide = await open({ width: 1920, height: 1000 }, '&shell=1&sidebar=1')
    try {
      const tops = await wide.page.locator('.cr-toolbar').evaluate((t) => [...t.children].map((el) => Math.round(el.getBoundingClientRect().top)))
      assert.equal(new Set(tops).size, 1, `верх элементов панели: ${tops}`)
    } finally { await wide.close() }

    const phone = await open({ width: 390, height: 800 })
    try {
      const f = phone.page.locator('.cr-toolbar .fdrop').nth(1)
      const [fw, tw] = await Promise.all([f.evaluate((el) => el.getBoundingClientRect().width), phone.page.locator('.cr-toolbar').evaluate((el) => el.clientWidth)])
      assert.ok(fw > tw * 0.8, `ширина фильтра ${fw} из ${tw}`)
      assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'нет сдвига страницы вбок')
    } finally { await phone.close() }
  })
})
