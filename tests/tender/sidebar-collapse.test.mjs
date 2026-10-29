// Боковое меню сворачивается до колонки иконок: кнопка-шеврон в правом верхнем углу шапки (без подписи), рабочая
// область становится шире, иконки остаются на своих местах, подписи — в подсказках; выбор запоминается в браузере.
// На телефоне меню — выезжающая панель, кнопки нет. Стенд tests/tender/ui (shell=1&sidebar=1), Chromium.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO as ROOT } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const SHOTS = process.env.SIDEBAR_SHOTS || ''

describe('Боковое меню: свернуть до иконок', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open(viewport = { width: 1600, height: 900 }) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${stand.url}?route=/dc-requests&dcStats=1&shell=1&sidebar=1`)
    await page.locator('.sidebar .nav-item').first().waitFor({ timeout: 120000 })
    return { page, context, errors, close: () => context.close().catch(() => {}) }
  }
  const box = (page, selector) => page.locator(selector).first().evaluate(el => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), w: Math.round(r.width) }
  })
  // Анимация ширины закончилась (прямо в transitionend не попасть — меню могли свернуть до подписки).
  const settled = (page, width) => page.waitForFunction((w) =>
    Math.round(document.querySelector('.sidebar').getBoundingClientRect().width) === w, width)

  it('шеврон в шапке сворачивает меню до иконок и разворачивает обратно; выбор переживает обновление', async () => {
    const { page, errors, close } = await open()
    try {
      const btn = page.locator('.sidebar-header .sidebar-collapse-btn')
      assert.equal(await btn.getAttribute('aria-label'), 'Свернуть меню')
      assert.equal((await btn.textContent()).trim(), '', 'только значок, без текста')
      // Кнопка — в правом верхнем углу шапки.
      const head = await page.locator('.sidebar-header').evaluate(el => el.getBoundingClientRect().toJSON())
      const at = await btn.evaluate(el => el.getBoundingClientRect().toJSON())
      assert.ok(head.right - at.right <= 12 && at.top - head.top <= 12, JSON.stringify({ head, at }))

      assert.equal((await box(page, '.sidebar')).w, 200)
      const mainBefore = (await box(page, '.main-content')).w
      const iconBefore = await box(page, '.sidebar-nav .nav-ic')
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/sidebar-open.png`, clip: { x: 0, y: 0, width: 520, height: 520 } })

      await btn.click()
      await settled(page, 52)
      assert.equal(await btn.getAttribute('aria-label'), 'Развернуть меню')
      assert.equal(await btn.getAttribute('aria-expanded'), 'false')
      assert.equal((await box(page, '.main-content')).w, mainBefore + 148, 'рабочая область шире на 148px')
      assert.deepEqual(await box(page, '.sidebar-nav .nav-ic'), iconBefore, 'иконки на тех же местах')
      // Подписи погашены, название пункта — в подсказке; логотип скрыт; «Выйти» — значком.
      const labels = await page.locator('.sidebar-nav .nav-label').evaluateAll(els => els.map(e => getComputedStyle(e).opacity))
      assert.ok(labels.length > 3 && labels.every(o => o === '0'), labels.join(','))
      assert.equal(await page.locator('.sidebar-nav .nav-item').first().getAttribute('title'), 'Общая информация')
      assert.equal(await page.locator('.sidebar-brand').evaluate(el => getComputedStyle(el).visibility), 'hidden')
      assert.equal(await page.locator('.logout-btn .logout-ic').isVisible(), true)
      assert.equal(await page.locator('.logout-btn .logout-label').isVisible(), false)
      // Всё внутри узкой колонки: ни один пункт не вылезает за край меню.
      const overflow = await page.locator('.sidebar :is(.nav-ic, .sidebar-collapse-btn, .logout-btn, .theme-toggle)')
        .evaluateAll(els => els.filter(e => e.getBoundingClientRect().right > 52).length)
      assert.equal(overflow, 0)
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/sidebar-collapsed.png`, clip: { x: 0, y: 0, width: 520, height: 900 } })

      await page.reload()
      await page.locator('.sidebar .nav-item').first().waitFor()
      assert.equal((await box(page, '.sidebar')).w, 52, 'свёрнутое меню запомнилось')

      await page.locator('.sidebar-collapse-btn').click()
      await settled(page, 200)
      assert.equal(await page.locator('.sidebar-collapse-btn').getAttribute('aria-label'), 'Свернуть меню')
      assert.equal(await page.locator('.sidebar-brand').evaluate(el => getComputedStyle(el).visibility), 'visible')
      assert.equal(await page.evaluate(() => localStorage.getItem('sidebar:collapsed')), '0')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('анимация быстрая: меню свёрнуто меньше чем за 0,3 с', async () => {
    const { page, errors, close } = await open()
    try {
      const ms = await page.evaluate(() => new Promise((resolve) => {
        const sb = document.querySelector('.sidebar')
        const t0 = performance.now()
        sb.addEventListener('transitionend', (e) => { if (e.target === sb && e.propertyName === 'width') resolve(performance.now() - t0) })
        document.querySelector('.sidebar-collapse-btn').click()
      }))
      assert.ok(ms > 100 && ms < 300, `${Math.round(ms)} мс`)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('на телефоне кнопки нет и меню не сворачивается, даже если на компьютере его свернули', async () => {
    const { page, context, errors, close } = await open({ width: 390, height: 800 })
    try {
      await context.addInitScript(() => localStorage.setItem('sidebar:collapsed', '1'))
      await page.reload()
      await page.locator('.sidebar .nav-item').first().waitFor({ state: 'attached' })
      assert.equal(await page.locator('.sidebar-collapse-btn').count(), 0)
      assert.equal(await page.locator('.sidebar.is-collapsed').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
