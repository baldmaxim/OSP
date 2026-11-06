// Решения пользователя 06.11.2026:
//  1) статус тендера «Перезапуск» — процедура закончена (сроки не горят), своя вкладка и цвет; уже перезапущенные отмечает
//     разовый скрипт migration/data/20261106_tenders_restart_status.sql;
//  2) «ЧС» маленькой плашкой с красной обводкой рядом с названием участника и победителя из чёрного списка — в «Тендерах»;
//  3) «История участия» карточки контрагента: в «№» — номер тендера, а не номер строки;
//  4) «Договорные расценки (Larix)»: счётчики подвкладок с разрядами («2 511»), и сказано, почему «Материалы» + «Работы»
//     больше «Всех позиций» (позиция с обеими ценами — в обеих).
// Стенд tests/tender/ui: restartBl=1 — tender-2 (№ 199) «Перезапуск», cp-2 в чёрном списке (участник tender-1, победитель
// tender-5 № 196); вкладка Larix — kp-registry-stand (larixMany=N).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { mainTenderStatuses, isClosedMainStatus, RESTART_STATUS } from '../../src/utils/tenderStatuses.js'
import { tenderWinnersOf } from '../../src/utils/tenderWinners.js'
import { fmtCount } from '../../src/utils/ratesRegistry.js'

const launch = browserLaunchOptions()
const text = (s) => String(s).replace(/\s+/g, ' ').trim()

describe('Перезапуск, «ЧС», счётчики — правила', () => {
  it('«Перезапуск» — статус каждого направления, процедура по нему закончена', () => {
    for (const dept of ['construction', 'warranty', 'joint', 'other']) {
      assert.ok(mainTenderStatuses(dept).includes(RESTART_STATUS), dept)
    }
    assert.equal(RESTART_STATUS, 'Перезапуск')
    assert.equal(isClosedMainStatus('Перезапуск'), true)
    assert.equal(isClosedMainStatus('Завершен'), true)
    assert.equal(isClosedMainStatus('Приостановка тендера'), false)
    assert.equal(isClosedMainStatus('Подведение итогов'), false)
  })

  it('победитель несёт статус контрагента (для «ЧС»)', () => {
    assert.deepEqual(tenderWinnersOf({ tender_winners: [{ counterparty_id: 'a', scope_note: 'к. 1', counterparties: { id: 'a', name: 'А', status: 'blacklist' } }] }),
      [{ id: 'a', name: 'А', scope: 'к. 1', status: 'blacklist' }])
    assert.equal(tenderWinnersOf({ tender_winners: [], winner: { id: 'b', name: 'Б' } })[0].status, null)
  })

  it('число позиций — с разрядами', () => {
    assert.equal(text(fmtCount(46323)), '46 323')
    assert.equal(fmtCount(0), '0')
    assert.equal(fmtCount(null), '0')
  })
})

describe('Перезапуск, «ЧС», № тендера, счётчики Larix — страница', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 600000 }, () => {
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

  const open = async (query, viewport = { width: 1600, height: 1000 }) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => { errors.push(`окно: ${d.message()}`); d.accept() })
    await page.goto(`${stand.url}?latency=0&${query}`)
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const registryRow = (page, num) => page.locator('table.tenders-registry > tbody > tr', { has: page.locator('td.tp-num', { hasText: new RegExp(`^${num}(?!\\d)`) }) })

  it('реестр ОС: «Перезапуск» — цвет, вкладка, без просрочки; «ЧС» у участника и победителя', async () => {
    const { page, errors, close } = await open('route=/tenders/construction&tenders=10&items=20&cps=4&restartBl=1')
    try {
      await page.locator('table.tenders-registry > tbody > tr').first().waitFor({ timeout: 120000 })

      const restarted = registryRow(page, 199)
      const trigger = restarted.getByRole('button', { name: 'Статус тендера' })
      assert.equal(text((await trigger.innerText()).replace('▾', '')), RESTART_STATUS)
      assert.match(await trigger.getAttribute('class'), /\bstatus-restarted\b/)
      assert.doesNotMatch(await restarted.getAttribute('class') || '', /overdue-row/, 'срок прошёл, но процедура закончена')
      assert.equal(await restarted.locator('td.tender-period-cell.is-overdue').count(), 0)
      // Цвет — свой, не «по умолчанию».
      const bg = await trigger.evaluate((el) => getComputedStyle(el).backgroundColor)
      assert.equal(bg, 'rgb(253, 242, 248)')

      await trigger.click()
      const options = await page.locator('.status-dropdown-menu-portal .status-dropdown-option-label').allInnerTexts()
      assert.deepEqual(options, mainTenderStatuses('construction'))
      await page.keyboard.press('Escape')

      await page.getByRole('button', { name: /Статусы тендеров/ }).click()
      assert.equal(text(await page.locator('.tender-tab-status', { hasText: RESTART_STATUS }).innerText()), `${RESTART_STATUS} 1`)

      // Участники № 200: «ЧС» только у Подрядчика 02.
      await registryRow(page, 200).locator('.expand-toggle').click()
      const names = page.locator('.expanded-cp-table-wrap td.tc-company-cell .tc-company-name')
      await names.first().waitFor({ timeout: 30000 })
      const marks = await names.evaluateAll((els) => els.map((el) => [el.firstChild?.textContent?.trim(), el.querySelector('.bl-mark')?.textContent || '']))
      assert.deepEqual(marks.map(([, m]) => m), ['', 'ЧС', '', ''])
      assert.equal(marks[1][0], 'Подрядчик 02')
      const mark = names.nth(1).locator('.bl-mark')
      const style = await mark.evaluate((el) => {
        const cs = getComputedStyle(el)
        return { border: cs.borderTopStyle, borderColor: cs.borderTopColor, color: cs.color, size: cs.fontSize }
      })
      assert.equal(style.border, 'solid')
      assert.equal(style.borderColor, style.color, 'обводка цветом текста')
      assert.equal(style.color, 'rgb(220, 38, 38)')
      assert.equal(style.size, '11px')

      // Вкладка «Завершен»: победитель № 196 — с «ЧС».
      await page.locator('.tender-tab-status', { hasText: /^Завершен/ }).click()
      const winner = registryRow(page, 196).locator('.winner-name')
      await winner.waitFor({ timeout: 30000 })
      assert.equal(await winner.locator('.bl-mark').innerText(), 'ЧС')
      // «Перезапуск» — своя вкладка, не в «Завершен».
      assert.equal(await registryRow(page, 199).count(), 0)
      await page.locator('.tender-tab-status', { hasText: RESTART_STATUS }).click()
      await registryRow(page, 199).waitFor({ timeout: 30000 })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('карточка тендера: «ЧС» у участника, «Перезапуск» — своим цветом', async () => {
    const { page, errors, close } = await open('route=/tenders/tender-1&items=20&cps=4&restartBl=1')
    try {
      await page.locator('.tender-tab', { hasText: 'Участники' }).click({ timeout: 120000 })
      const row = page.locator('.participants-section tbody tr').filter({ hasText: 'Подрядчик 02' })
      await row.waitFor({ timeout: 30000 })
      assert.equal(await row.locator('.tc-company-name .bl-mark').innerText(), 'ЧС')
      assert.equal(await page.locator('.participants-section .bl-mark').count(), 1)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
    const card = await open('route=/tenders/tender-2&items=20&cps=4&restartBl=1')
    try {
      const badge = card.page.locator('.status-badge', { hasText: RESTART_STATUS }).first()
      await badge.waitFor({ timeout: 120000 })
      assert.match(await badge.getAttribute('class'), /\bstatus-restarted\b/)
      assert.deepEqual(card.errors, [])
    } finally {
      await card.close()
    }
  })

  it('карточка контрагента: «№» в истории участия — номер тендера', async () => {
    const { page, errors, close } = await open('route=/general/counterparties&cps=6&cpContacts=1&items=20')
    try {
      const row = page.locator('table.compact-table tbody tr.table-row', { hasText: 'Подрядчик 01' })
      await row.waitFor({ timeout: 120000 })
      await row.locator('.company-name').click()
      await page.locator('.cp-detail-tab', { hasText: 'История участия' }).click()
      const nums = page.locator('.tender-history-table tbody td.tender-history-num')
      await nums.first().waitFor({ timeout: 30000 })
      const shown = (await nums.allInnerTexts()).map(Number).sort((a, b) => b - a)
      // cp-1 участвовал в tender-2 … tender-9 стенда — № 199 … 192, а не 1 … 8.
      assert.deepEqual(shown, [199, 198, 197, 196, 195, 194, 193, 192])
      assert.equal(await page.locator('.tender-history-table thead th.th-num').getAttribute('title'), 'Номер тендера')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
    // Телефон — карточками: номер перед объектом.
    const phone = await open('route=/general/counterparties&cps=6&cpContacts=1&items=20', { width: 390, height: 800 })
    try {
      const open1 = phone.page.locator('.cp-mrow-open', { hasText: 'Подрядчик 01' })
      await open1.waitFor({ timeout: 120000 })
      await open1.click()
      await phone.page.locator('.cp-detail-tab', { hasText: 'История участия' }).click()
      const first = phone.page.locator('.cp-history-card-no').first()
      await first.waitFor({ timeout: 30000 })
      assert.match(text(await first.innerText()), /^№ 19\d$/)
      assert.deepEqual(phone.errors, [])
    } finally {
      await phone.close()
    }
  })

  it('«Договорные расценки (Larix)»: счётчики с разрядами и пояснение про обе цены', async () => {
    const { page, errors, close } = await open('route=/rates-registry&maxRows=1000&larixMany=2500')
    try {
      await page.getByRole('tab', { name: 'Договорные расценки (Larix)' }).click()
      const pill = (label) => page.locator('.rr-sub-tab', { hasText: label }).locator('.rr-sub-count')
      await page.waitForFunction(() => /\d/.test(document.querySelector('.rr-sub-tab .rr-sub-count')?.textContent || ''), null, { timeout: 120000 })
      // 11 строк стенда + 2 500: цена материалов — у 2 509, работ — у 3, обе — у 1.
      assert.equal(text(await pill('Все позиции').innerText()), '2 511')
      assert.equal(text(await pill('Материалы').innerText()), '2 509')
      assert.equal(text(await pill('Работы').innerText()), '3')
      assert.equal(text(await page.locator('.rr-sub-note').innerText()), 'у 1 позиции обе цены — они и в «Материалах», и в «Работах»')
      assert.match(text(await page.locator('.rr-pagination-info').innerText()), /^1–100 из 2 511$/)
      // Подвкладка — отбор по наличию цены.
      await page.locator('.rr-sub-tab', { hasText: 'Работы' }).click()
      await page.waitForFunction(() => /из 3$/.test((document.querySelector('.rr-pagination-info')?.textContent || '').trim()))
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
