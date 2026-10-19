// Реестр тендеров и контрагенты на экране телефона, внутри обвязки приложения
// (.layout / .main-content — прокручивается она, а не окно).
//   • контрагенты: список прокручивается до конца (раньше overflow: hidden
//     страницы обрезал его — сдвиг на 44 px и стоп), вкладки листаются вбок;
//   • тендеры: на экране не меньше четырёх строк (было две карточки по 270–320 px),
//     название объекта не обрезано, ряд кнопок шапки начинается у левого края,
//     отметки не уводят со страницы, а строка открывает тендер;
//   • ни на 360, ни на 390 px нет прокрутки страницы вбок.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()

describe('Телефон: реестр тендеров и контрагенты', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 600000 }, () => {
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
      assert.equal(hit.href, 'tel:+7 701 555-12-34', 'первый телефон первого контакта')
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
