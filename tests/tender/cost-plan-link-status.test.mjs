// «Планы затрат»: ссылка на план затрат у плана «Не начат» сама ставит статус «В работе» (30.10.2026, решение
// пользователя) — тем же запросом, что и ссылку. Дальше «В работе» («Ожидание КП», «Завершён», «Не требуется») ссылка
// статус не меняет; очистка ссылки статус не возвращает. Стенд tests/tender/ui, тендеры 200…195 (tender-1…tender-6).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()

describe('«Планы затрат»: ссылка ставит статус «В работе»', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  it('«Не начат» + ссылка → «В работе»; другие статусы и очистка ссылки статус не трогают', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1500, height: 950 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => d.accept())
    try {
      await page.goto(`${stand.url}?route=/cost-plans&tenders=6&latency=0`)
      await page.locator('.cost-plans-page .cp-table').first().waitFor({ timeout: 120000 })

      const row = (num) => page.locator('table.cp-table > tbody > tr', { has: page.locator('td.ui-rownum', { hasText: new RegExp(`^${num}$`) }) })
      const status = (num) => row(num).locator('select.plan-status-select')
      const dbTender = (id) => page.evaluate((tid) => {
        const t = window.__fakeDb.tenders.find((x) => x.id === tid)
        return { link: t.cost_plan_link ?? null, status: t.cost_plan_status }
      }, id)
      const setStatus = async (num, id, value) => {
        await status(num).selectOption(value)
        await page.waitForFunction(([tid, v]) => window.__fakeDb.tenders.find((t) => t.id === tid).cost_plan_status === v, [id, value], { timeout: 10000 })
      }
      const saveLink = async (num, value) => {
        await row(num).locator(':is(.link-add-btn, .link-edit-btn)').click()
        const modal = page.locator('.cp-modal')
        await modal.locator('.cp-modal-input').fill(value)
        await modal.getByRole('button', { name: 'Сохранить' }).click()
        await modal.waitFor({ state: 'detached', timeout: 10000 })
      }

      // «Не начат»: ссылка и статус — одной записью, строка показывает «В работе».
      await setStatus(200, 'tender-1', 'not_started')
      await saveLink(200, '  https://docs.example.ru/plans/200  ')
      assert.deepEqual(await dbTender('tender-1'), { link: 'https://docs.example.ru/plans/200', status: 'in_progress' })
      assert.equal(await status(200).inputValue(), 'in_progress')
      assert.equal(await row(200).getByRole('link', { name: 'Открыть' }).getAttribute('href'), 'https://docs.example.ru/plans/200')

      // Очистить ссылку — статус остаётся «В работе».
      await saveLink(200, '')
      assert.deepEqual(await dbTender('tender-1'), { link: null, status: 'in_progress' })

      // «Ожидание КП» и «Завершён» — дальше «В работе»: ссылка статус не меняет.
      await setStatus(199, 'tender-2', 'awaiting_kp')
      await saveLink(199, 'https://docs.example.ru/plans/199')
      assert.deepEqual(await dbTender('tender-2'), { link: 'https://docs.example.ru/plans/199', status: 'awaiting_kp' })
      assert.equal(await status(199).inputValue(), 'awaiting_kp')

      assert.equal((await dbTender('tender-3')).status, 'completed')
      await saveLink(198, 'https://docs.example.ru/plans/198')
      assert.deepEqual(await dbTender('tender-3'), { link: 'https://docs.example.ru/plans/198', status: 'completed' })

      await setStatus(197, 'tender-4', 'not_required')
      await saveLink(197, 'https://docs.example.ru/plans/197')
      assert.equal((await dbTender('tender-4')).status, 'not_required')
      assert.deepEqual(errors, [])
    } finally {
      await context.close().catch(() => {})
    }
  })
})
