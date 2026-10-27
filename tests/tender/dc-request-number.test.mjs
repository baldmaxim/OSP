// «Заявки на ДС»: постоянный «№» заявки (миграция 20261106) — не зависит от вкладки и фильтров; пока колонки нет,
// номер считается на странице тем же порядком, что в миграции. Тела миграций обеих баз совпадают.
// Реестр в Chromium — стенд tests/tender/ui (route=/dc-requests&dcStats=1: пять заявок и одна удалённая).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { matchesRequestNo, withRequestNumbers } from '../../src/utils/dcRequestOptions.js'
import { startStand, browserLaunchOptions, REPO as ROOT } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const at = (d) => new Date(2026, 9, d, 10).toISOString()

describe('Заявки на ДС: постоянный номер', () => {
  it('номер из базы — как есть, список — по номеру', () => {
    const rows = withRequestNumbers([
      { id: 'b', request_number: 7, created_at: at(2) },
      { id: 'a', request_number: 3, created_at: at(5) },
    ])
    assert.deepEqual(rows.map(r => [r.id, r.requestNo]), [['a', 3], ['b', 7]])
  })

  it('без колонки: не удалённые по дате создания, затем удалённые — как в миграции', () => {
    const rows = withRequestNumbers([
      { id: 'c', created_at: at(3), deleted_at: null },
      { id: 'del', created_at: at(1), deleted_at: at(4) },
      { id: 'a', created_at: at(1), deleted_at: null },
      { id: 'b', created_at: at(2), deleted_at: null },
    ])
    assert.deepEqual(rows.map(r => [r.id, r.requestNo]), [['a', 1], ['b', 2], ['c', 3], ['del', 4]])
  })

  it('номер не меняется от вкладки: выборка берёт номер заявки, а не строки', () => {
    const all = withRequestNumbers([
      { id: 'a', request_number: 1, status: 'in_work' },
      { id: 'b', request_number: 2, status: 'completed' },
      { id: 'c', request_number: 3, status: 'completed' },
    ])
    const completed = all.filter(r => r.status === 'completed')
    assert.deepEqual(completed.map(r => r.requestNo), [2, 3])
  })

  it('поиск: «12» и «№ 12» — ровно эта заявка; не число — не номер', () => {
    const req = { requestNo: 12 }
    assert.equal(matchesRequestNo(req, '12'), true)
    assert.equal(matchesRequestNo(req, '№ 12'), true)
    assert.equal(matchesRequestNo(req, '№12'), true)
    assert.equal(matchesRequestNo(req, '1'), false)
    assert.equal(matchesRequestNo(req, '120'), false)
    assert.equal(matchesRequestNo(req, 'ДС 12'), false)
  })

  it('миграции Supabase и базы Яндекса делают одно и то же', () => {
    const body = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')
      .replace(/--.*$/gm, '')
      .replace(/^\s*(BEGIN|COMMIT|SET LOCAL lock_timeout = '10s');\s*$/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
    assert.equal(body('migration/yandex/20261106_dc_request_number.sql'), body('supabase/migrations/20261106_dc_request_number.sql'))
  })
})

describe('Реестр заявок на ДС: «№» при смене вкладки', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open(extra = '') {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${stand.url}?route=/dc-requests&dcStats=1&latency=10&shell=1${extra}`)
    await page.locator('.dcr-table td.ui-rownum').first().waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  // Строки таблицы: [«№», заявка (d1…d6 из № ДС)].
  const rows = (page) => page.locator('.dcr-table tbody tr').evaluateAll((trs) => trs.map((tr) => [
    tr.querySelector('td.ui-rownum')?.textContent.trim(), (tr.textContent.match(/ДС-(d\d)/) || [])[1],
  ]))
  const tab = async (page, label) => {
    await page.locator('.status-tab', { hasText: label }).click()
    await page.waitForTimeout(50)
  }

  it('без колонки в базе: номер по порядку создания, во вкладках тот же', async () => {
    const { page, errors, close } = await open()
    try {
      assert.deepEqual(await rows(page), [['1', 'd5'], ['2', 'd2'], ['3', 'd3'], ['4', 'd4'], ['5', 'd1']])
      await tab(page, 'Завершено')
      assert.deepEqual(await rows(page), [['1', 'd5'], ['4', 'd4']], 'не 1 и 2 — номера заявок, а не строк')
      await tab(page, 'Удаленные')
      assert.deepEqual(await rows(page), [['6', 'd6']])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('номер из базы — как есть; поиск «№ 15» находит заявку', async () => {
    const { page, errors, close } = await open('&dcNumbers=1')
    try {
      assert.deepEqual(await rows(page), [['11', 'd5'], ['12', 'd2'], ['14', 'd3'], ['15', 'd4'], ['17', 'd1']])
      await tab(page, 'Завершено')
      assert.deepEqual(await rows(page), [['11', 'd5'], ['15', 'd4']])
      await tab(page, 'Все заявки')
      await page.locator('input.dcr-search').fill('№ 15')
      assert.deepEqual(await rows(page), [['15', 'd4']])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
