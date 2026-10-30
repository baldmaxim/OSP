// «Заявки на ДС»: ширины столбцов меняются перетаскиванием границ в заголовке и переживают обновление страницы
// (localStorage, hooks/useColumnWidths.js); окно шире суммы — растут все столбцы пропорционально; шире окна —
// прокрутка, а не обрезка. Название «Статус ОКС» — кнопка фильтра, граница рядом его не открывает.
// Расчёт — utils/columnWidths.js; реестр — в Chromium, стенд tests/tender/ui (route=/dc-requests&dcStats=1&shell=1).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { readColumnWidths, resizedWidth, shownWidth, writeColumnWidths } from '../../src/utils/columnWidths.js'
import { startStand, browserLaunchOptions, REPO as ROOT } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const KEY = 'dcRequests:colWidths:v1'

function memoryStore(init = {}) {
  const data = new Map(Object.entries(init))
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    data,
  }
}

describe('Ширины столбцов: расчёт и хранение', () => {
  it('растянутая таблица: столбец на экране следует за мышью, сумма остаётся не больше места', () => {
    const sum = 100
    const container = 125
    const base = 10
    assert.equal(shownWidth({ base, sum, container }), 12.5)
    // Хотим на экране 20 (было 12.5): новая ширина и пересчёт обратно дают ровно 20.
    const next = resizedWidth({ base, sum, container, target: 20 })
    const nextSum = sum - base + next
    assert.ok(nextSum <= container)
    assert.ok(Math.abs(shownWidth({ base: next, sum: nextSum, container }) - 20) < 1e-9)
    // Сужение — так же.
    const narrow = resizedWidth({ base, sum, container, target: 6 })
    assert.ok(Math.abs(shownWidth({ base: narrow, sum: sum - base + narrow, container }) - 6) < 1e-9)
  })

  it('шире места — таблица прокручивается, столбец на экране равен своей ширине', () => {
    assert.equal(shownWidth({ base: 10, sum: 130, container: 125 }), 10)
    assert.equal(resizedWidth({ base: 10, sum: 130, container: 125, target: 18 }), 18)
    // Растянутая, но столбец тянут дальше, чем помещается: дальше — как есть, без скачка на границе.
    const atEdge = resizedWidth({ base: 10, sum: 100, container: 125, target: 35 })
    assert.equal(atEdge, 35)
  })

  it('хранилище: только разумные числа; пусто — запись удаляется; закрытое хранилище не роняет', () => {
    const store = memoryStore({ [KEY]: JSON.stringify({ desc: 14, num: -1, cp: 'x', sub: 500, old: 7 }) })
    assert.deepEqual(readColumnWidths(KEY, null, store), { desc: 14, sub: 48, old: 7 })
    assert.deepEqual(readColumnWidths(KEY, ['desc'], store), { desc: 14 })
    writeColumnWidths(KEY, {}, store)
    assert.equal(store.data.has(KEY), false)
    assert.deepEqual(readColumnWidths(KEY, null, memoryStore({ [KEY]: '{испорчено' })), {})
    assert.deepEqual(readColumnWidths(KEY, null, memoryStore({ [KEY]: '[1,2]' })), {})
    const closed = { getItem() { throw new Error('closed') }, setItem() { throw new Error('closed') }, removeItem() { throw new Error('closed') } }
    assert.deepEqual(readColumnWidths(KEY, null, closed), {})
    writeColumnWidths(KEY, { desc: 12 }, closed)
  })
})

describe('Реестр заявок на ДС: ширины столбцов', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open(extra = '', viewport = { width: 1920, height: 1000 }) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('dialog', (d) => { errors.push(`окно: ${d.message()}`); d.dismiss() })
    await page.goto(`${stand.url}?route=/dc-requests&dcStats=1&dcContracts=1&dcSubmission=1&dcSubResp=1&latency=10&shell=1${extra}`)
    await page.locator('.dcr-table td.ui-rownum').first().waitFor({ timeout: 120000 })
    return { page, context, errors, close: () => context.close().catch(() => {}) }
  }
  const frames = (page) => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
  const widths = (page) => page.locator('.dcr-table thead th').evaluateAll(ths => ths.map(th => th.getBoundingClientRect().width))
  const layout = (page) => page.evaluate(() => {
    const t = document.querySelector('.dcr-table')
    const c = t.closest('.table-container')
    return { table: t.getBoundingClientRect().width, client: c.clientWidth, scroll: c.scrollWidth, overflow: getComputedStyle(c).overflowX,
      fit: c.classList.contains('is-fit') }
  })
  const stored = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), KEY)
  // Тянем границу столбца i (0 — «№») на dx пикселей.
  async function drag(page, i, dx) {
    const handle = page.locator('.dcr-table thead th').nth(i).locator('.col-resize')
    const b = await handle.boundingBox()
    const x = b.x + b.width / 2
    const y = b.y + b.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    for (let s = 1; s <= 5; s++) await page.mouse.move(x + (dx * s) / 5, y)
    await page.mouse.up()
    await frames(page)
  }

  it('граница у каждого столбца, кроме «Действий»; подписи — для экранного диктора', async () => {
    const { page, errors, close } = await open()
    try {
      const labels = await page.locator('.dcr-table thead th').evaluateAll(ths => ths.map(th => th.querySelector('.col-resize')?.getAttribute('aria-label') || null))
      assert.deepEqual(labels, ['Ширина столбца «№»', 'Ширина столбца «Объект»', 'Ширина столбца «Контрагент»',
        'Ширина столбца «Договор и № ДС»', 'Ширина столбца «Описание ДС»', 'Ширина столбца «Сумма»',
        'Ширина столбца «Статус и ответственный»', 'Ширина столбца «Документы»', 'Ширина столбца «Статус ОКС»', null])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('растянутая таблица: столбец растёт за мышью, остальные уступают пропорционально; ширина переживает обновление', async () => {
    const { page, errors, close } = await open()
    try {
      const before = await widths(page)
      const lay0 = await layout(page)
      assert.equal(lay0.fit, true, 'на 1920 таблица помещается')
      await drag(page, 4, 120) // «Описание ДС»
      const after = await widths(page)
      assert.ok(Math.abs(after[4] - before[4] - 120) <= 2, `описание: ${before[4]} → ${after[4]}`)
      // Таблица по-прежнему во всё место, без прокрутки; остальные столбцы сузились в одной пропорции.
      const lay1 = await layout(page)
      assert.ok(Math.abs(lay1.table - lay0.table) <= 1 && lay1.fit && lay1.scroll <= lay1.client + 1, JSON.stringify(lay1))
      const k = (lay0.table - after[4]) / (lay0.table - before[4])
      before.forEach((w, i) => { if (i !== 4) assert.ok(Math.abs(after[i] - w * k) <= 1.5, `столбец ${i}: ${w} → ${after[i]} (k ${k})`) })
      const saved = await stored(page)
      assert.deepEqual(Object.keys(saved), ['desc'])
      assert.ok(saved.desc > 9.75)

      await page.reload()
      await page.locator('.dcr-table td.ui-rownum').first().waitFor()
      await frames(page)
      const again = await widths(page)
      assert.ok(Math.abs(again[4] - after[4]) <= 1, `после обновления: ${after[4]} → ${again[4]}`)
      // Кнопка «Ширина столбцов по умолчанию» — только когда есть свои ширины.
      const reset = page.locator('.dcr-widths-reset')
      assert.equal(await reset.isVisible(), true)
      await reset.click()
      await frames(page)
      const back = await widths(page)
      before.forEach((w, i) => assert.ok(Math.abs(back[i] - w) <= 1, `столбец ${i}: ${w} → ${back[i]}`))
      assert.equal(await stored(page), null)
      assert.equal(await reset.count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('двойной щелчок по границе — ширина по умолчанию; с клавиатуры — стрелками', async () => {
    const { page, errors, close } = await open()
    try {
      const before = await widths(page)
      await drag(page, 1, 80) // «Объект»
      assert.ok((await stored(page)).object > 11)
      await page.locator('.dcr-table thead th').nth(1).locator('.col-resize').dblclick()
      await frames(page)
      assert.equal(await stored(page), null)
      assert.ok(Math.abs((await widths(page))[1] - before[1]) <= 1)

      const handle = page.locator('.dcr-table thead th').nth(2).locator('.col-resize') // «Контрагент», 13rem
      await handle.focus()
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Shift+ArrowRight')
      assert.deepEqual(await stored(page), { cp: 15.5 })
      await page.keyboard.press('Delete')
      assert.equal(await stored(page), null)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('шире места — прокрутка, а не обрезка; уже не меньше минимума', async () => {
    const { page, errors, close } = await open('', { width: 1700, height: 1000 })
    try {
      await drag(page, 7, 400) // «Документы»
      const lay = await layout(page)
      assert.equal(lay.fit, false, JSON.stringify(lay))
      assert.equal(lay.overflow, 'auto')
      assert.ok(lay.scroll > lay.client + 100, JSON.stringify(lay))
      await drag(page, 0, -200) // «№» — не уже своего минимума (2.25rem)
      assert.ok((await widths(page))[0] >= 2.25 * 16 - 0.5)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('граница «Статуса ОКС» не открывает фильтр, название — открывает; фильтр работает и после смены ширины', async () => {
    const { page, errors, close } = await open()
    try {
      const th = page.locator('.dcr-table thead th', { hasText: 'Статус ОКС' })
      await drag(page, 8, 60)
      assert.equal(await page.locator('.fdrop-panel').count(), 0, 'перетаскивание границы фильтр не открыло')
      await th.locator('.col-resize').click()
      assert.equal(await page.locator('.fdrop-panel').count(), 0, 'щелчок по границе фильтр не открыл')
      await th.locator('.dcr-th-fdrop .fdrop-trigger').click()
      await page.locator('.fdrop-panel .fdrop-option', { hasText: 'Удорожаев' }).click()
      await page.keyboard.press('Escape')
      assert.equal(await page.locator('.dcr-table tbody tr').count(), 1)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
