// «Тендеры — Прочее» (/tenders/other) с 29.10.2026 — рабочий стиль и плотный реестр, как у «Основного
// строительства» (решение пользователя: прежняя таблица плохо смотрелась). Подразделения ВОР у «Прочего» нет
// (в «ВОРах и РД» только основное строительство), колонок «ВОРы и РД», «План затрат» и «Тендер на материалы» —
// тоже, поэтому минимальная ширина таблицы своя: в окне 1280px реестр помещается без прокрутки.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()

describe('Тендеры — Прочее: плотный реестр по образцу ОС', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  it('рабочий стиль, «№» со счётчиком участников, без подразделений ВОР; в 1280px — без прокрутки', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    try {
      await page.goto(`${stand.url}?route=/tenders/other&tendersDept=other&tenders=9&items=20&cps=2&latency=0`)
      const rows = page.locator('table.tenders-registry > tbody > tr')
      await rows.first().waitFor({ timeout: 120000 })
      const root = await page.locator('.tenders-page').getAttribute('class')
      for (const cls of ['ui-work', 'tp-dense', 'tp-dept-other']) assert.ok(root.split(' ').includes(cls), `${cls} в «${root}»`)
      assert.equal(await page.locator('.tp-num-merged').count(), 9, '«№» и счётчик участников — одна колонка')

      const heads = (await page.locator('table.tenders-registry > thead th').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())
      assert.ok(heads.includes('Объект') && heads.includes('Описание работ'), heads.join(' | '))
      for (const gone of ['ВОРы и РД', 'План затрат', 'Тендер на материалы']) {
        assert.ok(!heads.some((h) => h.includes(gone)), `${gone}: ${heads.join(' | ')}`)
      }
      // Подразделения ВОР — только у основного строительства.
      assert.equal(await page.locator('.vdivf, .vdiv, .vdiv-fdrop').count(), 0)
      // Тендер без объекта — вписанное вручную имя.
      assert.ok(await page.locator('table.tenders-registry > tbody', { hasText: 'Офис компании, ремонт кабинетов' }).count() > 0)

      const fit = await page.locator('.table-container').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
      assert.ok(fit.scroll <= fit.client + 1, `таблица шире окна: ${fit.scroll} > ${fit.client}`)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
})
