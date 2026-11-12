// «Администрирование» → «Пользователи»: меню «Ещё» (три точки) у строки пользователя. Стенд — route=/admin (admin-stand.jsx).
// 12.11.2026: меню рисовалось внутри ячейки, а таблица лежит в блоке с горизонтальной прокруткой — он обрезал меню:
// при одном найденном пользователе от меню оставалась полоска «Редактировать» и лишняя полоса прокрутки. Теперь меню —
// в <body>, под кнопкой (не помещается — над ней), целиком на экране.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()

describe('«Пользователи»: меню «Ещё» у строки', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open({ viewport = { width: 1400, height: 800 }, users = 1 } = {}) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${stand.url}?route=/admin&latency=0&adminUsers=${users}`)
    await page.locator('.users-table tbody tr').first().waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }

  // Каждый пункт меню виден и нажимается: в его середине — он сам, а не таблица или край блока прокрутки.
  const menuState = (page) => page.evaluate(() => {
    const pop = document.querySelector('.adm-menu-pop')
    const btn = document.querySelector('.adm-menu-btn.is-open')
    const wrap = document.querySelector('.users-table-wrap')
    const r = pop.getBoundingClientRect()
    const b = btn.getBoundingClientRect()
    return {
      inBody: pop.parentElement === document.body,
      inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth,
      hidden: [...pop.querySelectorAll('[role=menuitem]')].filter((el) => {
        const e = el.getBoundingClientRect()
        return !el.contains(document.elementFromPoint(e.left + e.width / 2, e.top + e.height / 2))
      }).map((el) => el.textContent.trim()),
      below: r.top >= b.bottom,
      rightAligned: Math.abs(r.right - b.right) <= 1,
      wrapScrolls: wrap.scrollHeight > wrap.clientHeight,
    }
  })

  it('один пользователь: меню целиком под кнопкой, таблица не прокручивается', async () => {
    const { page, errors, close } = await open()
    try {
      await page.getByRole('button', { name: 'Действия' }).click()
      await page.locator('.adm-menu-pop').waitFor()
      assert.deepEqual(await menuState(page), {
        inBody: true, inViewport: true, hidden: [], below: true, rightAligned: true, wrapScrolls: false,
      })
      // Пункт работает: «Редактировать» открывает окно пользователя, меню закрывается.
      await page.getByRole('menuitem', { name: 'Редактировать' }).click()
      await page.getByRole('heading', { name: 'Редактирование пользователя' }).waitFor()
      assert.equal(await page.locator('.adm-menu-pop').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('у нижнего края окна — над кнопкой; Escape закрывает и возвращает фокус на кнопку, щелчок мимо — закрывает', async () => {
    const { page, errors, close } = await open({ users: 12, viewport: { width: 1400, height: 700 } })
    try {
      const last = page.getByRole('button', { name: 'Действия' }).last()
      await last.scrollIntoViewIfNeeded()
      // Строка — у нижнего края окна: под кнопкой меню не помещается.
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('.adm-menu-btn')].pop().getBoundingClientRect()
        window.scrollBy(0, b.bottom - window.innerHeight + 20)
      })
      await last.click()
      const state = await menuState(page)
      assert.equal(state.below, false, 'над кнопкой')
      assert.equal(state.inViewport, true)
      assert.deepEqual(state.hidden, [])
      await page.keyboard.press('Escape')
      assert.equal(await page.locator('.adm-menu-pop').count(), 0)
      assert.equal(await last.evaluate((el) => el === document.activeElement), true)

      await last.click()
      await page.mouse.click(20, 20)
      assert.equal(await page.locator('.adm-menu-pop').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('телефон: меню не выходит за края экрана', async () => {
    const { page, errors, close } = await open({ viewport: { width: 390, height: 800 } })
    try {
      await page.getByRole('button', { name: 'Действия' }).click()
      const state = await menuState(page)
      assert.equal(state.inViewport, true)
      assert.deepEqual(state.hidden, [])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
