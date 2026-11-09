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

  // 06.11.2026: «долго закрывается» в «Заявках на ДС». Раньше анимировалась ширина меню в раскладке: на каждом кадре
  // рабочая область становилась шире на несколько пикселей и страница перерисовывалась целиком (400 заявок — до 0,37 с
  // на кадр). Теперь рабочая область и меню меняют ширину один раз, в момент нажатия, а край меню едет только сдвигом
  // слоёв (transform — его ведёт видеокарта, без пересчёта страницы); при загрузке страницы ничего не едет.
  it('край меню едет сдвигом слоёв, а рабочая область меняет ширину один раз, сразу', async () => {
    const { page, errors, close } = await open()
    try {
      // Анимации меню и его «тени» (у страницы свои — индикаторы загрузки и т. п.).
      await page.evaluate(() => {
        window.__menuAnimations = () => document.getAnimations().filter((a) => {
          const t = a.effect?.target
          return t && (t.matches('.sidebar, .sidebar-ghost') || t.closest('.sidebar'))
        })
      })
      assert.equal(await page.evaluate(() => window.__menuAnimations().length), 0, 'при загрузке ничего не едет')
      const mainBefore = (await box(page, '.main-content')).w
      // По кадрам с нажатия, пока идут анимации: ширины рабочей области и меню, правый край меню на экране,
      // положение иконки; какие анимации шли и что в них меняется.
      const watch = () => page.evaluate(() => new Promise((resolve) => {
        const main = document.querySelector('.main-content')
        const sb = document.querySelector('.sidebar')
        const ghost = document.querySelector('.sidebar-ghost')
        const icon = document.querySelector('.sidebar-nav .nav-ic')
        const t0 = performance.now()
        const s = { mainW: new Set(), sbW: new Set(), edge: new Set(), iconX: new Set(), props: new Set(), durations: new Set(), ms: 0 }
        const sample = () => {
          s.mainW.add(main.getBoundingClientRect().width)
          s.sbW.add(sb.offsetWidth)
          s.edge.add(Math.round(Math.max(sb.getBoundingClientRect().right, ghost.getBoundingClientRect().right)))
          s.iconX.add(Math.round(icon.getBoundingClientRect().x * 10) / 10)
        }
        // Нажатие обрабатывает React (обновление — в микрозадаче), поэтому мерим с ближайшего кадра.
        document.querySelector('.sidebar-collapse-btn').click()
        let first = true
        const tick = () => {
          if (first) {
            first = false
            for (const a of window.__menuAnimations()) {
              s.durations.add(a.effect.getTiming().duration)
              for (const k of a.effect.getKeyframes()) for (const p of Object.keys(k)) if (!['offset', 'easing', 'composite', 'computedOffset'].includes(p)) s.props.add(p)
            }
          }
          sample()
          if (window.__menuAnimations().length) requestAnimationFrame(tick)
          else {
            s.ms = performance.now() - t0
            resolve(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v instanceof Set ? [...v] : v])))
          }
        }
        requestAnimationFrame(tick)
      }))

      const down = await watch()
      assert.deepEqual(down.mainW, [mainBefore + 148], 'свернули: рабочая область сразу шире на 148px, без промежуточных')
      assert.deepEqual(down.sbW, [52], 'меню сразу узкое')
      assert.deepEqual(down.props, ['transform'], 'анимируется только сдвиг')
      assert.deepEqual(down.durations, [180])
      assert.ok(down.edge.length > 2 && down.edge.includes(52), `край едет: ${down.edge.join(', ')}`)
      assert.ok(down.edge.every(x => x >= 52 && x <= 200), down.edge.join(', '))
      assert.ok(down.ms < 400, `${Math.round(down.ms)} мс`)
      assert.equal(down.iconX.length, 1, 'иконка стоит')

      const up = await watch()
      assert.deepEqual(up.mainW, [mainBefore], 'развернули: рабочая область сразу прежней ширины')
      assert.deepEqual(up.sbW, [200], 'меню сразу широкое')
      assert.deepEqual(up.props, ['transform'], 'анимируется только сдвиг')
      assert.ok(up.edge.length > 2 && up.edge.includes(200), `край едет: ${up.edge.join(', ')}`)
      assert.ok(up.edge.every(x => x >= 52 && x <= 200), up.edge.join(', '))
      assert.ok(up.ms < 400, `${Math.round(up.ms)} мс`)
      assert.equal(up.iconX.length, 1, `содержимое меню стоит, едет только край: ${up.iconX.join(', ')}`)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  // 30.10.2026: «расширялась не только область слева, а пропорционально все области» — раньше освободившиеся 148px
  // целиком забирал один столбец-описание. Теперь у всех столбцов ширины, и таблица растёт вся, в одной пропорции.
  it('свернули меню — все столбцы реестров растут пропорционально, а не одно описание', async () => {
    const T = 'tenders=10&items=20&cps=2&latency=0'
    const registries = [
      ['Заявка на ДС', 'route=/dc-requests&dcStats=1&dcContracts=1&dcSubmission=1&dcSubResp=1', '.dcr-table'],
      ['Тендеры — Основное строительство', `route=/tenders/construction&${T}`, 'table.tp-grid'],
      ['Тендеры — Прочее', `route=/tenders/other&tendersDept=other&${T}`, 'table.tp-grid'],
      ['Тендеры на материалы', 'route=/tenders/materials&tenders=10&matTenders=1&latency=0', 'table.tp-grid'],
      ['Планы затрат', `route=/cost-plans&${T}`, 'table.cp-table'],
      ['ВОРы и РД', `route=/vors&${T}`, 'table.vors-table'],
    ]
    for (const [name, query, table] of registries) {
      const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 2200, height: 1000 } })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      try {
        await page.goto(`${stand.url}?${query}&shell=1&sidebar=1`)
        await page.locator(`${table} tbody tr`).first().waitFor({ timeout: 120000 })
        await page.locator('.sidebar .nav-item').first().waitFor()
        await settled(page, 200)
        const cols =() => page.locator(`${table} > thead > tr:first-child > th`).evaluateAll(ths => ths.map(th => th.getBoundingClientRect().width))
        const before = await cols()
        await page.locator('.sidebar-collapse-btn').click()
        await settled(page, 52)
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
        const after = await cols()
        const sum = (a) => a.reduce((s, w) => s + w, 0)
        const k = sum(after) / sum(before)
        assert.ok(Math.abs(sum(after) - sum(before) - 148) <= 2, `${name}: таблица шире на ${sum(after) - sum(before)}px`)
        before.forEach((w, i) => assert.ok(Math.abs(after[i] - w * k) <= 1.5,
          `${name}, столбец ${i + 1}: ${w.toFixed(1)} → ${after[i].toFixed(1)}px, ожидалось ≈ ${(w * k).toFixed(1)}`))
        assert.deepEqual(errors, [], name)
      } finally { await context.close().catch(() => {}) }
    }
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
