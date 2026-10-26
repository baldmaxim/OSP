// Реестр тендеров, контрагенты и задачи на экране телефона, внутри обвязки приложения
// (.layout / .main-content — прокручивается она, а не окно).
//   • контрагенты: список прокручивается до конца (раньше overflow: hidden
//     страницы обрезал его — сдвиг на 44 px и стоп), вкладки листаются вбок;
//   • тендеры: на экране не меньше четырёх строк (было две карточки по 270–320 px),
//     название объекта не обрезано, ряд кнопок шапки начинается у левого края,
//     отметки не уводят со страницы, а строка открывает тендер;
//   • ни на 360, ни на 390 px нет прокрутки страницы вбок;
//   • задачи: вкладки одной строкой, фильтры в пределах экрана; карточка — лист на весь экран
//     над полосой меню («×» — единственный способ закрыть), блоки не наезжают, длинный
//     чек-лист перетаскивается за край экрана (карточка прокручивается сама).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()

describe('Телефон: реестр тендеров, контрагенты, задачи', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 600000 }, () => {
  let stand
  let browser

  before(async () => {
    stand = await startStand(REPO)
    browser = await chromium.launch({ ...launch, headless: true })
    // Прогрев: первая загрузка компилирует модули dev-сервером.
    const page = await browser.newPage()
    await page.goto(`${stand.url}?route=/tenders/construction&tenders=5&items=20&cps=2&latency=0`)
    await page.locator('table tbody tr').first().waitFor({ timeout: 120000 })
    await page.close()
  })
  after(async () => {
    await browser?.close()
    await stand?.server.close()
  })

  async function phonePage(query, width = 390) {
    const context = await browser.newContext({
      locale: 'ru-RU', viewport: { width, height: 844 }, isMobile: true, hasTouch: true,
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => d.accept())
    await page.goto(`${stand.url}?${query}&items=20&latency=0&shell=1`)
    return { page, errors, close: () => context.close().catch(() => {}) }
  }

  const noSideScroll = (page) => page.evaluate(() => {
    const main = document.querySelector('.main-content')
    return {
      doc: document.documentElement.scrollWidth - window.innerWidth,
      main: main.scrollWidth - main.clientWidth,
    }
  })

  it('контрагенты: список прокручивается до конца, вкладки листаются, строка открывает карточку, звонок — отдельная ссылка', async () => {
    const { page, errors, close } = await phonePage('route=/general/counterparties&cps=60&cpContacts=1')
    try {
      await page.locator('.cp-mrow').first().waitFor({ timeout: 120000 })
      assert.equal(await page.locator('table.compact-table').count(), 0, 'на телефоне — список, не таблица')

      // До конца списка: прокручиваем .main-content до упора — последняя строка
      // (или «Показать ещё») должна оказаться на экране.
      const end = await page.evaluate(() => {
        const main = document.querySelector('.main-content')
        main.scrollTop = main.scrollHeight
        const rows = document.querySelectorAll('.cp-mrow')
        const last = document.querySelector('.cp-mlist-more') || rows[rows.length - 1]
        return { scrolled: main.scrollTop, bottom: last.getBoundingClientRect().bottom, vh: window.innerHeight, rows: rows.length }
      })
      assert.ok(end.scrolled > 2000, `страница прокручивается (${end.scrolled} px)`)
      assert.ok(end.bottom <= end.vh, `конец списка виден после прокрутки (низ ${Math.round(end.bottom)} при экране ${end.vh})`)
      assert.equal(end.rows, 59, '60 контрагентов, один — в чёрном списке')

      // Колесом / пальцем — тоже: прокрутка не перехвачена обрезанным контейнером.
      await page.evaluate(() => { document.querySelector('.main-content').scrollTop = 0 })
      const top0 = await page.locator('.cp-mrow').first().evaluate((el) => el.getBoundingClientRect().top)
      await page.mouse.move(195, 600)
      await page.mouse.wheel(0, 1500)
      await page.waitForTimeout(400)
      const top1 = await page.locator('.cp-mrow').first().evaluate((el) => el.getBoundingClientRect().top)
      assert.ok(top0 - top1 > 1000, `колесо сдвигает список (${Math.round(top0 - top1)} px)`)
      await page.evaluate(() => { document.querySelector('.main-content').scrollTop = 0 })

      // Строки плотные: на первом экране не меньше шести.
      const visible = await page.evaluate(() => [...document.querySelectorAll('.cp-mrow')]
        .filter((r) => { const b = r.getBoundingClientRect(); return b.top < window.innerHeight && b.bottom > 0 }).length)
      assert.ok(visible >= 6, `на экране ${visible} контрагентов`)

      // Вкладки: одна строка, последняя («Виды работ») достижима прокруткой вбок.
      const tabs = await page.evaluate(() => {
        const el = document.querySelector('.counterparties-tabs')
        el.scrollLeft = el.scrollWidth
        const last = [...el.querySelectorAll('.cp-tab')].pop().getBoundingClientRect()
        const box = el.getBoundingClientRect()
        const tops = new Set([...el.querySelectorAll('.cp-tab')].map((t) => Math.round(t.getBoundingClientRect().top)))
        return { rows: tops.size, lastInside: last.right <= box.right + 1 && last.left >= box.left - 1 }
      })
      assert.equal(tabs.rows, 1, 'вкладки в одну строку')
      assert.ok(tabs.lastInside, '«Виды работ» достижимы прокруткой')

      // Звонок поверх кнопки строки: в точке ссылки — сама ссылка, рядом — кнопка открытия.
      const hit = await page.evaluate(() => {
        const tel = document.querySelector('.cp-mrow-tel')
        const t = tel.getBoundingClientRect()
        const atTel = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2)
        const inn = tel.closest('.cp-mrow').querySelector('.cp-mrow-inn').getBoundingClientRect()
        const atInn = document.elementFromPoint(inn.left + 4, inn.top + inn.height / 2)
        return { href: tel.getAttribute('href'), telHit: tel.contains(atTel), innOpens: !!atInn?.closest('.cp-mrow-open') }
      })
      assert.equal(hit.href, 'tel:+77015551234', 'первый телефон первого контакта (только цифры)')
      assert.ok(hit.telHit, 'нажатие на телефон попадает в ссылку, а не в строку')
      assert.ok(hit.innOpens, 'остальная строка открывает карточку')

      // Нажатие по строке видов работ (не по названию) — как пальцем по строке.
      const wt = await page.locator('.cp-mrow-wt').first().boundingBox()
      await page.mouse.click(wt.x + wt.width / 2, wt.y + wt.height / 2)
      await page.locator('.cp-detail-modal').waitFor({ timeout: 10000 })

      assert.deepEqual(await noSideScroll(page), { doc: 0, main: 0 })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('тендеры: плотные строки, объект целиком, шапка с левого края, отметки не уводят, строка открывает тендер', async () => {
    const { page, errors, close } = await phonePage('route=/tenders/construction&tenders=40&cps=2')
    try {
      await page.locator('.tp-mrow').first().waitFor({ timeout: 120000 })
      await page.waitForTimeout(500)

      const m = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.tp-mrow')]
        const vh = window.innerHeight
        const objs = rows.slice(0, 10).map((r) => r.querySelector('.tp-mrow-obj'))
        const actions = document.querySelector('.tp-header-actions')
        return {
          visible: rows.filter((r) => { const b = r.getBoundingClientRect(); return b.top < vh && b.bottom > 0 }).length,
          maxH: Math.max(...rows.slice(0, 10).map((r) => r.getBoundingClientRect().height)),
          objCut: objs.filter((o) => o.scrollWidth > o.clientWidth + 1).length,
          actionsStart: actions.firstElementChild.getBoundingClientRect().left - actions.getBoundingClientRect().left,
        }
      })
      assert.ok(m.visible >= 4, `на первом экране ${m.visible} тендеров (было 2)`)
      assert.ok(m.maxH <= 150, `строка тендера не выше 150 px (${Math.round(m.maxH)})`)
      assert.equal(m.objCut, 0, 'название объекта не обрезано')
      assert.ok(m.actionsStart >= 0, `ряд кнопок шапки начинается у левого края (${m.actionsStart})`)

      // Отметка ТГ переключается и не уводит со страницы.
      const tg = page.locator('.tp-mrow').first().locator('.tp-mrow-flags .tgpub').first()
      const before = await tg.getAttribute('class')
      await tg.click()
      await page.waitForFunction((cls) => document.querySelector('.tp-mrow .tp-mrow-flags .tgpub')?.className !== cls, before, { timeout: 10000 })
      assert.equal(await page.locator('.tp-mlist').count(), 1, 'после отметки остаёмся в реестре')

      // Путь к папке: значок раскрывает путь, значок в раскрытом виде сворачивает.
      // Строку фиксируем по номеру: после раскрытия значка фильтр «есть значок» указал бы на другую.
      const pathIdx = await page.evaluate(() => [...document.querySelectorAll('.tp-mrow')]
        .findIndex((r) => r.querySelector('.fpath-compact.has-value')))
      assert.ok(pathIdx >= 0, 'есть тендер с путём к папке')
      const withPath = page.locator('.tp-mrow').nth(pathIdx)
      await withPath.locator('.fpath-compact').click()
      await withPath.locator('.fpath .fpath-text').waitFor({ timeout: 5000 })
      assert.match(await withPath.locator('.fpath-text').textContent(), /Тендер \d+/)
      await withPath.locator('.fpath button[aria-label="Свернуть путь к папке"]').click()
      await withPath.locator('.fpath-compact.has-value').waitFor({ timeout: 5000 })
      assert.equal(await page.locator('.tp-mlist').count(), 1, 'путь к папке не уводит со страницы')

      assert.deepEqual(await noSideScroll(page), { doc: 0, main: 0 })

      // Строка открывает тендер.
      await page.locator('.tp-mrow-main').first().click()
      await page.locator('.tender-detail-page').first().waitFor({ timeout: 30000 })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  // Карточка задачи закрывается только «×» (392d7e0) — на телефоне шапку с ним закрывала
  // полоса меню, а при ширине до 1100 px свойства наезжали на описание и чек-лист.
  const taskCard = encodeURIComponent('/tasks?task=task-1')
  const cardBlocksOverlap = (page) => page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.task-modal-columns .task-card-block')]
      .map((b) => b.getBoundingClientRect()).sort((a, b) => a.top - b.top)
    return blocks.slice(1).filter((b, i) => b.top < blocks[i].bottom - 1).length
  })

  it('задачи: вкладки одной строкой, фильтры в пределах экрана, на 360 и 390 px нет прокрутки вбок', async () => {
    for (const width of [390, 360]) {
      const { page, errors, close } = await phonePage('route=/tasks&taskList=6', width)
      try {
        await page.locator('.tasks-page .mcard').nth(6).waitFor({ timeout: 120000 })
        const m = await page.evaluate(() => {
          const tabs = document.querySelector('.tasks-tabs')
          const tops = new Set([...tabs.querySelectorAll('.tasks-tab')].map((t) => Math.round(t.getBoundingClientRect().top)))
          tabs.scrollLeft = tabs.scrollWidth
          const last = [...tabs.querySelectorAll('.tasks-tab')].pop().getBoundingClientRect()
          const box = tabs.getBoundingClientRect()
          const bar = document.querySelector('.tasks-toolbar').getBoundingClientRect()
          const outside = [...document.querySelectorAll('.tasks-toolbar > *')]
            .filter((el) => { const r = el.getBoundingClientRect(); return r.left < bar.left - 1 || r.right > bar.right + 1 }).length
          return { rows: tops.size, lastInside: last.right <= box.right + 1, outside }
        })
        assert.equal(m.rows, 1, `вкладки в одну строку (${width} px)`)
        assert.ok(m.lastInside, '«Удалённые» достижимы прокруткой вкладок')
        assert.equal(m.outside, 0, 'фильтры не выходят за край панели')
        assert.deepEqual(await noSideScroll(page), { doc: 0, main: 0 }, `${width} px`)
        assert.deepEqual(errors, [])
      } finally {
        await close()
      }
    }
  })

  it('карточка задачи: лист на весь экран над полосой меню, «×» под пальцем и закрывает, блоки не наезжают', async () => {
    const { page, errors, close } = await phonePage(`route=${taskCard}`)
    try {
      await page.locator('.task-modal .task-checklist li').nth(2).waitFor({ timeout: 120000 })
      const m = await page.evaluate(() => {
        const modal = document.querySelector('.task-modal').getBoundingClientRect()
        const x = document.querySelector('.task-modal-close')
        const r = x.getBoundingClientRect()
        return {
          sheet: [modal.left, modal.top, modal.width, modal.height].map(Math.round),
          screen: [window.innerWidth, window.innerHeight],
          closeHit: x === document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2),
          closeSize: [r.width, r.height].map(Math.round),
        }
      })
      assert.deepEqual(m.sheet, [0, 0, ...m.screen], 'лист от края до края')
      assert.ok(m.closeHit, '«×» не закрыт полосой меню')
      assert.ok(m.closeSize[0] >= 40 && m.closeSize[1] >= 40, `«×» под палец (${m.closeSize})`)
      assert.equal(await cardBlocksOverlap(page), 0, 'блоки карточки не наезжают друг на друга')

      // Выпадашка свойства — поверх карточки, поиск 16px (иначе Safari увеличивает страницу).
      await page.locator('.task-modal-side .task-field-picker .fdrop-trigger').first().click()
      const panel = await page.evaluate(() => {
        const p = document.querySelector('.fdrop-panel')
        const r = p.getBoundingClientRect()
        return {
          onTop: p.contains(document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(20, r.height / 2))),
          searchFont: getComputedStyle(p.querySelector('.fdrop-search')).fontSize,
        }
      })
      assert.ok(panel.onTop, 'панель выбора не под карточкой')
      assert.equal(panel.searchFont, '16px')
      await page.keyboard.press('Escape')

      assert.deepEqual(await noSideScroll(page), { doc: 0, main: 0 })
      await page.locator('.task-modal-close').click()
      await page.locator('.task-modal').waitFor({ state: 'detached', timeout: 10000 })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('карточка задачи в одну колонку (900 px): свойства не наезжают на работу', async () => {
    const { page, errors, close } = await phonePage(`route=${taskCard}`, 900)
    try {
      await page.locator('.task-modal .task-checklist li').nth(2).waitFor({ timeout: 120000 })
      assert.equal(await cardBlocksOverlap(page), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('чек-лист длиннее экрана: пункт тянут к краю — карточка прокручивается сама, пункт встаёт первым', async () => {
    const { page, errors, close } = await phonePage(`route=${taskCard}&taskChecklist=20`)
    try {
      const last = page.locator('.task-checklist li[data-item-id="chk-23"]')
      await last.waitFor({ timeout: 120000 })
      await last.scrollIntoViewIfNeeded()
      const box = await page.evaluate(() => {
        const el = document.querySelector('.task-modal-columns')
        const r = el.getBoundingClientRect()
        return { top: r.top, scrollTop: el.scrollTop }
      })
      assert.ok(box.scrollTop > 300, `карточка прокручена к концу чек-листа (${box.scrollTop})`)
      const first = await page.locator('.task-checklist li').first().boundingBox()
      assert.ok(first.y < box.top, 'первый пункт за верхним краем — без автопрокрутки его не достать')

      // Тянем ручку последнего пункта к верхнему краю и держим: карточка едет до начала.
      const hb = await last.locator('.task-checklist-handle').boundingBox()
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
      await page.mouse.down()
      await page.mouse.move(hb.x + hb.width / 2, box.top + 8, { steps: 10 })
      await page.waitForFunction(() => document.querySelector('.task-modal-columns').scrollTop === 0, null, { timeout: 15000 })
      assert.equal(await page.locator('.task-checklist li[data-item-id="chk-1"].drop-before').count(), 1, 'вставка — перед первым пунктом')
      await page.mouse.up()
      await page.waitForFunction(() => window.__fakeDb.task_checklist_items.find((i) => i.id === 'chk-23').sort_order === 0)
      assert.equal(await page.locator('.task-checklist li').first().getAttribute('data-item-id'), 'chk-23')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('узкий телефон (360 px): ни тендеры, ни контрагенты не прокручиваются вбок', async () => {
    for (const query of ['route=/tenders/construction&tenders=20&cps=2', 'route=/general/counterparties&cps=30&cpContacts=1']) {
      const { page, errors, close } = await phonePage(query, 360)
      try {
        await page.locator('.tp-mrow, .cp-mrow').first().waitFor({ timeout: 120000 })
        await page.waitForTimeout(300)
        assert.deepEqual(await noSideScroll(page), { doc: 0, main: 0 }, query)
        assert.deepEqual(errors, [])
      } finally {
        await close()
      }
    }
  })
})
