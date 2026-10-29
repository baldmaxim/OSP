// «Договоры и ДС» (/contracts): вид раздела — как у других разделов (решение пользователя 29.10.2026).
//   • рабочий стиль (workUi.css, класс ui-work) и плотный вариант cr-dense на компьютере;
//   • шапка — одна строка: название с плиткой, охват реестра («Все договоры» / «Наши договоры»), справа действия;
//   • панель — одной строкой: вид документа, поиск, фильтры, «Просрочено», «Не в Larix» — одна высота;
//     «Сбросить» — только при выбранном фильтре;
//   • договоры отделены друг от друга: каждый второй — подложкой, раскрытый договор и его область — одним блоком
//     (полоса акцентом слева у обеих строк); в таблице ничего мельче 11px, пути документа — одной строкой;
//   • телефон: вкладки одной строкой с прокруткой вбок, карточки без подчёркивания.
// Правила — docs/UI_GUIDELINES.md, «Плотный вариант: реестр «Договоры и ДС»».
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const BASE = 'route=/contracts&contracts=30&contractsDivision=1&latency=0&shell=1'

describe('Договоры и ДС: вид раздела', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  const open = async (width, wait = '.contracts-table tbody tr.contract-row') => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    await page.addInitScript(() => { try { localStorage.removeItem('contracts-doc-kind') } catch { /* нет */ } })
    await page.goto(`${stand.url}?${BASE}`)
    await page.locator(wait).first().waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }

  it('шапка в одну строку, панель одной высоты, «Сбросить» — только при фильтре', async () => {
    const { page, errors, close } = await open(1600)
    try {
      const root = page.locator('.contract-registry')
      assert.match(await root.getAttribute('class'), /\bui-work\b.*\bcr-dense\b/)
      assert.ok(await page.evaluate(() => document.body.classList.contains('ui-work-portal')), 'всплывающие списки — в рабочем стиле')

      const header = page.locator('.registry-header')
      assert.equal(await header.locator('h2 .ic-tile').count(), 1, 'плитка раздела у названия')
      assert.match(await header.locator('h2').innerText(), /Договоры и ДС/)
      assert.deepEqual(await header.locator('.registry-scope-btn').evaluateAll((els) => els.map((b) => b.firstChild.textContent.trim())),
        ['Все договоры', 'Наши договоры'])
      assert.match(await header.locator('.cr-header-actions').innerText(), /Путь к общей папке/)
      assert.deepEqual(await header.locator('.cr-header-actions > button').allInnerTexts(), ['Документы', 'Компактный вид', '+ Добавить договор'])
      // Одна строка: название, охват и действия — на одной высоте.
      const rows = await header.evaluate((h) => {
        const top = (el) => Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2)
        return [top(h.querySelector('h2')), top(h.querySelector('.registry-scope')), top(h.querySelector('.btn-primary'))]
      })
      assert.ok(Math.max(...rows) - Math.min(...rows) <= 2, `шапка в одну строку: ${rows}`)

      // Панель: вид документа, поиск, фильтры и быстрые фильтры — одна высота (32px в плотном варианте).
      const heights = await page.locator('.cr-toolbar').evaluate((t) => [
        t.querySelector('.rf-doc-kind'), t.querySelector('.cr-search'), ...t.querySelectorAll('.fdrop-trigger'), ...t.querySelectorAll('.qfilter'),
      ].map((el) => Math.round(el.getBoundingClientRect().height)))
      assert.deepEqual([...new Set(heights)], [32], `высоты: ${heights}`)
      assert.equal(await page.locator('.cr-toolbar .cr-filter-clear').count(), 0, 'без фильтров «Сбросить» нет')
      await page.locator('.cr-toolbar .qfilter', { hasText: 'Не в Larix' }).click()
      assert.equal(await page.locator('.cr-toolbar .qfilter', { hasText: 'Не в Larix' }).getAttribute('aria-pressed'), 'true')
      await page.locator('.cr-toolbar .cr-filter-clear').click()
      assert.equal(await page.locator('.cr-toolbar .qfilter', { hasText: 'Не в Larix' }).getAttribute('aria-pressed'), 'false')
      assert.equal(await page.locator('.cr-toolbar .cr-filter-clear').count(), 0)

      // «Компактный вид» — переключатель, как у тендеров.
      const compact = page.locator('.cr-header-actions .btn-view-toggle', { hasText: 'Компактный вид' })
      await compact.click()
      await page.locator('.contracts-table.is-slim').waitFor()
      assert.equal(await page.locator('.cr-header-actions .btn-view-toggle.active').innerText(), 'Все столбцы')
      await page.locator('.cr-header-actions .btn-view-toggle.active').click()
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('договоры отделены: подложка через один, раскрытый — одним блоком, ничего мельче 11px, пути — одной строкой', async () => {
    const { page, errors, close } = await open(1600)
    try {
      const rows = page.locator('.contracts-table tbody tr.contract-row')
      assert.deepEqual(await rows.evaluateAll((els) => els.slice(0, 4).map((r) => r.classList.contains('is-alt'))), [false, true, false, true])
      const bg = await rows.evaluateAll((els) => els.slice(0, 2).map((r) => getComputedStyle(r.cells[1]).backgroundColor))
      assert.notEqual(bg[0], bg[1], 'у второго договора — своя подложка')

      // Мельче 11px в таблице ничего нет (раньше подписи были 9–10px) — и в виде «ДС» с колонкой изменяемого
      // документа. Стрелки списков (▾, ⇅) — значки, не текст.
      const tooSmall = () => page.locator('.contracts-table').evaluate((t) => [...t.querySelectorAll('thead *, tbody tr.contract-row *')]
        .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && /[0-9A-Za-zА-Яа-яЁё]/.test(n.textContent)))
        .map((el) => ({ text: el.textContent.trim().slice(0, 30), px: parseFloat(getComputedStyle(el).fontSize) }))
        .filter((x) => x.px < 11))
      assert.deepEqual(await tooSmall(), [])
      await page.locator('.rf-doc-kind-btn', { hasText: /^ДС$/ }).click()
      await page.locator('.contracts-table .cell-parent .parent-doc-link').first().waitFor()
      assert.deepEqual(await tooSmall(), [])
      // Заголовок «Сумма» — вправо, как сами суммы, и в виде «ДС» (колонок на одну больше).
      assert.equal(await page.locator('.contracts-table thead th.th-col-amount').evaluate((th) => getComputedStyle(th).textAlign), 'right')
      await page.locator('.rf-doc-kind-btn', { hasText: /^Договоры и ДС$/ }).click()
      await page.locator('.contracts-table .ds-toggle').first().waitFor()

      // «путь к · папке · Signal · Larix» — одной строкой.
      const lines = await page.locator('.contracts-table .cpaths').first().evaluate((c) => new Set([...c.children].map((k) => Math.round(k.getBoundingClientRect().top))).size)
      assert.equal(lines, 1)

      // Раскрытый договор и его область — один блок: полоса акцентом слева у обеих строк.
      await rows.first().locator('.ds-toggle').click()
      const expanded = page.locator('.contracts-table tbody tr.contract-expanded-row')
      await expanded.waitFor()
      const bars = await page.evaluate(() => {
        const row = document.querySelector('.contracts-table tbody tr.contract-row.is-expanded')
        return [getComputedStyle(row.cells[0]).boxShadow, getComputedStyle(row.nextElementSibling.cells[0]).boxShadow]
      })
      for (const b of bars) assert.match(b, /3px 0px 0px 0px inset/, `полоса слева: ${b}`)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('телефон: вкладки одной строкой с прокруткой, карточки без подчёркивания', async () => {
    const { page, errors, close } = await open(390, '.mcard')
    try {
      const tabs = await page.locator('.status-tabs').evaluate((t) => ({
        lines: new Set([...t.querySelectorAll('.status-tab')].map((b) => Math.round(b.getBoundingClientRect().top))).size,
        scrolls: t.scrollWidth > t.clientWidth,
      }))
      assert.deepEqual(tabs, { lines: 1, scrolls: true })
      assert.equal(await page.locator('.mcard').first().evaluate((c) => getComputedStyle(c).textDecorationLine), 'none')
      assert.equal(await page.locator('.contract-registry').getAttribute('class').then((c) => /cr-dense/.test(c)), false, 'плотный вариант — только на компьютере')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
