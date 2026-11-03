// «Заявки на ДС»: ширины столбцов меняются перетаскиванием границ в заголовке и переживают обновление страницы
// (localStorage, hooks/useColumnWidths.js); окно шире суммы — растут все столбцы пропорционально; шире окна —
// прокрутка, а не обрезка. Название «Статус ОКС» — кнопка фильтра, граница рядом его не открывает.
// Граница идёт за мышью (03.11: «лагает» — граница «Документов» проходила 22 px из 120 мыши, «Статуса ОКС» — 3 из 60):
// место отдаёт сосед справа, остальные столбцы стоят.
// Расчёт — utils/columnWidths.js; реестр — в Chromium, стенд tests/tender/ui (route=/dc-requests&dcStats=1&shell=1).
// Длинный реестр (30.10: «автомасштабирование столбцов очень сильно лагает»): пока тянут границу, строки вне экрана
// скрыты, верхняя видимая строка не сдвигается; отпустили — строки показываются фоном (dcMany=N).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { dragWidths, readColumnWidths, writeColumnWidths } from '../../src/utils/columnWidths.js'
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
  // Где окажется граница справа от столбца на экране: при сумме меньше места браузер растягивает столбцы пропорционально.
  const edge = (widths, index, container) => {
    const sum = widths.reduce((t, w) => t + w, 0)
    const k = sum < container ? container / sum : 1
    return widths.slice(0, index + 1).reduce((t, w) => t + w, 0) * k
  }
  const same = (a, b, what) => assert.ok(Math.abs(a - b) < 0.01, `${what}: ${a} и ${b}`)
  const mins = [2, 2, 2, 2]
  const drag = (over) => dragWidths({ widths: [10, 20, 30, 40], mins, index: 1, delta: 0, container: 125, ...over })

  it('растянутая таблица: граница — ровно за мышью в обе стороны, у любого столбца; сумма и остальные столбцы те же', () => {
    const widths = [10, 20, 30, 40]
    for (const index of [0, 1, 2]) {
      for (const delta of [-5, 5, 12]) {
        const next = dragWidths({ widths, mins, index, delta, container: 125 })
        same(edge(next, index, 125), edge(widths, index, 125) + delta, `столбец ${index}, сдвиг ${delta}`)
        same(next.reduce((t, w) => t + w, 0), 100, 'сумма')
        next.forEach((w, j) => { if (j !== index && j !== index + 1) assert.equal(w, widths[j], `столбец ${j} не меняется`) })
      }
    }
  })

  it('сосед упёрся в минимум: граница идёт дальше, таблица шире места, столбцы на экране без скачка', () => {
    const justFits = drag({ index: 0, delta: 22.5 }) // сосед 20 → 2: всего он отдаёт 18 × 1.25 = 22.5 на экране
    same(justFits[1], 2, 'сосед на минимуме')
    same(justFits.reduce((t, w) => t + w, 0), 100, 'сумма пока та же')
    const over = drag({ index: 0, delta: 24 })
    const sum = over.reduce((t, w) => t + w, 0)
    assert.ok(sum > 125, `таблица шире места: ${sum}`)
    same(edge(over, 0, 125), edge([10, 20, 30, 40], 0, 125) + 24, 'граница')
    same(over[1], 2.5, 'сосед — как был на экране')
    same(over[2], 37.5, 'столбец правее — как был на экране')
    same(over[3], 50, 'и следующий')
  })

  it('свой минимум: граница дальше не идёт, сосед получает только то, что столбец отдал', () => {
    const next = drag({ delta: -100 })
    assert.deepEqual(next, [10, 2, 48, 40])
  })

  it('таблица шире места: столбец растёт сам, сосед не меняется', () => {
    assert.deepEqual(drag({ container: 90, delta: 8 }), [10, 28, 30, 40])
  })

  it('таблица шире места, столбец уже: сама сужается до места, дальше — сосед; прокрутка не упирается в край', () => {
    assert.deepEqual(drag({ container: 90, delta: -6 }), [10, 14, 30, 40])
    assert.deepEqual(drag({ container: 90, delta: -15 }), [10, 5, 35, 40], 'лишнее — 10, остальное соседу')
    // Прокручено до края: сузиться таблице значит сдвинуть её вправо — граница не пошла бы за мышью.
    assert.deepEqual(drag({ container: 90, delta: -6, scrollLeft: 10 }), [10, 14, 36, 40])
    assert.deepEqual(drag({ container: 90, delta: -6, scrollLeft: 7 }), [10, 14, 33, 40], 'до края — 3')
  })

  it('последний столбец без соседа: шире — таблица раздвигается, уже — сосед не появляется', () => {
    const args = { widths: [10, 20], mins: [2, 2], index: 1, container: 30 }
    assert.deepEqual(dragWidths({ ...args, delta: 5 }), [10, 25])
    assert.deepEqual(dragWidths({ ...args, delta: -5 }), [10, 15])
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

  it('растянутая таблица: граница каждого столбца идёт за мышью, отдаёт сосед, остальные стоят; ширины переживают обновление', async () => {
    const { page, errors, close } = await open()
    try {
      const before = await widths(page)
      const lay0 = await layout(page)
      assert.equal(lay0.fit, true, 'на 1920 таблица помещается')
      await drag(page, 4, 120) // «Описание ДС»
      const after = await widths(page)
      assert.ok(Math.abs(after[4] - before[4] - 120) <= 2, `описание: ${before[4]} → ${after[4]}`)
      assert.ok(Math.abs(after[5] - before[5] + 120) <= 2, `сумма уступила: ${before[5]} → ${after[5]}`)
      // Таблица по-прежнему во всё место, без прокрутки; остальные столбцы не сдвинулись.
      const lay1 = await layout(page)
      assert.ok(Math.abs(lay1.table - lay0.table) <= 1 && lay1.fit && lay1.scroll <= lay1.client + 1, JSON.stringify(lay1))
      before.forEach((w, i) => { if (i !== 4 && i !== 5) assert.ok(Math.abs(after[i] - w) <= 1, `столбец ${i}: ${w} → ${after[i]}`) })
      const saved = await stored(page)
      assert.deepEqual(Object.keys(saved), ['desc', 'amount'])
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
      // Двойной щелчок по границе возвращает оба столбца, которые она делит: сосед тоже менялся.
      await page.locator('.dcr-table thead th').nth(1).locator('.col-resize').dblclick()
      await frames(page)
      assert.equal(await stored(page), null)
      assert.ok(Math.abs((await widths(page))[1] - before[1]) <= 1)

      const handle = page.locator('.dcr-table thead th').nth(2).locator('.col-resize') // «Контрагент», 13rem
      const edge = () => handle.evaluate(el => el.parentElement.getBoundingClientRect().right)
      const e0 = await edge()
      await handle.focus()
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Shift+ArrowRight')
      assert.ok(Math.abs(await edge() - e0 - 40) <= 1, 'стрелка двигает границу на свой шаг: 0.5rem + 2rem')
      assert.deepEqual(Object.keys(await stored(page)), ['cp', 'contract'])
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

  it('граница идёт за мышью у всех столбцов: то, что отставало, и в обе стороны', async () => {
    const { page, errors, close } = await open()
    try {
      const reset = page.locator('.dcr-widths-reset')
      for (const [i, dx] of [[1, 80], [2, -80], [3, -60], [4, -80], [6, -80], [7, -120], [7, 120], [8, -60], [8, 60]]) {
        if (await reset.count()) { await reset.click(); await frames(page) }
        const edges = () => page.locator('.dcr-table thead th').evaluateAll(ths => ths.map(th => th.getBoundingClientRect().right))
        const e0 = await edges()
        await drag(page, i, dx)
        const e1 = await edges()
        assert.ok(Math.abs(e1[i] - e0[i] - dx) <= 2, `граница ${i}, мышь ${dx}: сдвинулась на ${e1[i] - e0[i]}`)
        // «Статус ОКС» шире: «Действия» уже не сжимаются, поэтому таблица раздвигается — только правый край уезжает.
        const pushesTable = i === 8 && dx > 0
        e0.forEach((x, j) => {
          if (j === i || (pushesTable && j === 9)) return
          assert.ok(Math.abs(e1[j] - x) <= 2, `граница ${j} стоит (тянули ${i}): ${x} → ${e1[j]}`)
        })
      }
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('таблица шире окна, прокручена до края: граница идёт за мышью, таблица не прыгает', async () => {
    const { page, errors, close } = await open('', { width: 1400, height: 900 })
    try {
      const box = () => page.evaluate(() => {
        const c = document.querySelector('.dcr-table').closest('.table-container')
        return { left: c.scrollLeft, max: c.scrollWidth - c.clientWidth }
      })
      await page.evaluate(() => { const c = document.querySelector('.dcr-table').closest('.table-container'); c.scrollLeft = c.scrollWidth })
      await frames(page)
      const s0 = await box()
      assert.ok(s0.max > 100 && Math.abs(s0.left - s0.max) <= 1, `прокручено до края: ${JSON.stringify(s0)}`)
      const edges = () => page.locator('.dcr-table thead th').evaluateAll(ths => ths.map(th => th.getBoundingClientRect().right))
      const e0 = await edges()
      await drag(page, 7, -80) // левая граница «Статуса ОКС»
      const e1 = await edges()
      assert.ok(Math.abs(e1[7] - e0[7] + 80) <= 2, `граница за мышью: ${e1[7] - e0[7]}`)
      assert.ok(Math.abs(e1[6] - e0[6]) <= 2, `столбец левее стоит: ${e1[6] - e0[6]}`)
      assert.ok(Math.abs((await box()).left - s0.left) <= 1, 'прокрутка на месте')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('таблица вплотную к рамке раздела, хотя стили карточки тендера (padding у .table-container) уже загружены', async () => {
    const { page, errors, close } = await open()
    try {
      const pos = await page.evaluate(() => {
        const t = document.querySelector('.dcr-table')
        const c = t.closest('.table-container')
        const th = t.querySelector('thead th').getBoundingClientRect()
        const b = c.getBoundingClientRect()
        const cs = getComputedStyle(c)
        const css = [...document.styleSheets].some((sheet) => {
          try { return [...sheet.cssRules].some(r => r.selectorText === '.table-container' && r.style.paddingLeft === '1rem') } catch { return false }
        })
        return { thLeft: th.left - b.left, tableRight: b.right - t.getBoundingClientRect().right, padding: cs.paddingLeft, css }
      })
      assert.equal(pos.css, true, 'чужое правило на месте — иначе проверка ничего не значит')
      assert.equal(pos.padding, '0px')
      assert.ok(Math.abs(pos.thLeft) < 0.5, `слева: ${pos.thLeft}`)
      assert.ok(Math.abs(pos.tableRight) < 0.5, `справа: ${pos.tableRight}`)
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

  it('длинный реестр: щелчок по границе без движения — ширины те же, ничего не запомнено, все строки снова на месте', async () => {
    const { page, errors, close } = await open('&dcMany=150')
    try {
      const before = await widths(page)
      const handle = page.locator('.dcr-table thead th').nth(4).locator('.col-resize')
      await handle.click()
      await page.waitForFunction(() => !document.querySelector('.dcr-table [data-col-frozen]'), null, { timeout: 30000 })
      await frames(page)
      const state = await page.evaluate(() => ({
        hidden: [...document.querySelectorAll('.dcr-table tbody tr')].filter(r => getComputedStyle(r).display === 'none').length,
        veils: document.querySelectorAll('.col-resize-veil').length,
        resizing: document.body.classList.contains('is-col-resizing'),
      }))
      assert.deepEqual(state, { hidden: 0, veils: 0, resizing: false })
      assert.deepEqual(await widths(page), before)
      assert.equal(await stored(page), null)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('длинный реестр: пока тянут, строки вне экрана скрыты, видимое на месте; отпустили — все строки снова на месте', async () => {
    const { page, errors, close } = await open('&dcMany=150')
    try {
      // Таблица прокручена в середину; верхняя строка на экране — якорь.
      const anchor = () => page.evaluate(() => {
        const box = document.querySelector('.dcr-table').closest('.table-container')
        const top = box.getBoundingClientRect().top + 60
        const rows = [...document.querySelectorAll('.dcr-table tbody tr')]
        const i = rows.findIndex(r => r.getBoundingClientRect().bottom > top)
        return { i, top: rows[i].getBoundingClientRect().top, no: rows[i].querySelector('.ui-rownum').textContent }
      })
      const state = () => page.evaluate(() => {
        const rows = [...document.querySelectorAll('.dcr-table tbody tr')]
        return {
          rows: rows.length,
          hidden: rows.filter(r => getComputedStyle(r).display === 'none').length,
          marked: document.querySelectorAll('.dcr-table [data-col-frozen]').length,
          inlineHeights: rows.filter(r => r.style.height).length,
          veils: document.querySelectorAll('.col-resize-veil').length, // курсор над всей страницей
          selected: window.getSelection().toString(),
        }
      })
      await page.evaluate(() => { document.querySelector('.dcr-table').closest('.table-container').scrollTop = 6000 })
      await frames(page)
      const a0 = await anchor()
      assert.ok(a0.i > 20, `прокручено: ${JSON.stringify(a0)}`)
      const before = await widths(page)

      const handle = page.locator('.dcr-table thead th').nth(4).locator('.col-resize') // «Описание ДС»
      const b = await handle.boundingBox()
      const x = b.x + b.width / 2
      const y = b.y + b.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      await frames(page)
      // Скрытие — самая дорогая часть, поэтому при нажатии, пока граница стоит, а не рывком на первом движении.
      const pressed = await state()
      assert.ok(pressed.hidden > 100, `скрыты уже при нажатии: ${JSON.stringify(pressed)}`)
      const a00 = await anchor()
      assert.ok(a00.no === a0.no && Math.abs(a00.top - a0.top) <= 1, 'на экране при нажатии ничего не сдвинулось')
      for (let s = 1; s <= 6; s++) { await page.mouse.move(x + s * 30, y); await frames(page) }
      const during = await state()
      assert.ok(during.hidden > 100, `во время перетаскивания скрыты строки вне экрана: ${JSON.stringify(during)}`)
      assert.equal(during.veils, 1)
      const a1 = await anchor()
      assert.equal(a1.no, a0.no, 'верхняя строка на экране — та же')
      assert.ok(Math.abs(a1.top - a0.top) <= 1, `и на том же месте: ${a0.top} → ${a1.top}`)
      const visible = await page.locator('.dcr-table tbody tr', { hasText: a0.no }).first().evaluate(r => getComputedStyle(r).display)
      assert.notEqual(visible, 'none')

      await page.mouse.up()
      await page.waitForFunction(() => !document.querySelector('.dcr-table [data-col-frozen]'), null, { timeout: 30000 })
      await frames(page)
      const after = await state()
      assert.deepEqual(after, { rows: during.rows, hidden: 0, marked: 0, inlineHeights: 0, veils: 0, selected: '' })
      const a2 = await anchor()
      assert.equal(a2.no, a0.no, 'после — та же строка вверху')
      assert.ok(Math.abs(a2.top - a0.top) <= 1, `на том же месте: ${a0.top} → ${a2.top}`)
      const now = await widths(page)
      assert.ok(Math.abs(now[4] - before[4] - 180) <= 2, `описание: ${before[4]} → ${now[4]}`)
      assert.ok((await stored(page)).desc > 9.75)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
