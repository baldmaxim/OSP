// Карточка тендера на крупном тендере в настоящем браузере: вкладки «ВОР» и
// «Сравнение КП» (5 000 позиций × 10 подрядчиков ≈ 50 000 строк КП, задержка
// «сети» 120 мс на запрос).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, runScenario, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()

describe('Карточка тендера: производительность ВОР и Сравнения КП', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 600000 }, () => {
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

  it('данные грузятся параллельно, КП — одним запросом, таблицы виртуализированы, «учтено» не перекачивает КП, возврат на вкладку мгновенный', async () => {
    const m = await runScenario(browser, stand.url)
    console.log('    метрики:', JSON.stringify(m))
    assert.deepEqual(m.errors, [])
    assert.ok(m.maxParallelRequests > 1, 'страницы запрашиваются одновременно')
    assert.ok(m.vorDomRows < 400, `в DOM окно строк ВОР, а не все позиции (${m.vorDomRows})`)
    assert.equal(m.compareRequests, 1, 'все КП тендера (≈ 50 000 строк) — одним вызовом tender_compare_proposals, без страниц')
    assert.ok(m.compareDomRows < 400, `в DOM окно строк сравнения (${m.compareDomRows})`)
    assert.equal(m.toggleProposalSelects, 0, 'после «учтено» список КП не перезагружается')
    assert.equal(m.compareReturnShowedLoading, false, `возврат на вкладку показывает кэш сразу, без «Загрузки…» (${m.compareReturnMs} мс)`)
  })

  // База без миграции 20261123 (функции нет): КП читаются страницами, как раньше, — те же суммы; ответ «функции нет»
  // запоминается, повторное открытие её уже не спрашивает.
  it('«Сравнение КП» без функции tender_compare_proposals: страницами, суммы те же, функция не спрашивается повторно', async () => {
    const totals = {}
    for (const rpc of [true, false]) {
      const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
      const requests = () => page.evaluate(() => ({
        rpc: window.__supabaseStats.requests.filter((r) => r.table === 'rpc:tender_compare_proposals').length,
        pages: window.__supabaseStats.requests.filter((r) => r.table === 'tender_counterparty_proposals' && r.op === 'select' && r.range).length,
      }))
      try {
        await page.goto(`${stand.url}?items=2500&cps=4&tenders=2&latency=5${rpc ? '' : '&compareRpc=0'}`)
        await page.getByRole('button', { name: /Сравнение КП/ }).click({ timeout: 120000 })
        await page.locator('.proposals-table tbody tr').first().waitFor({ timeout: 60000 })
        totals[rpc] = await page.locator('.proposals-summary-matrix-table tfoot').textContent()
        const first = await requests()
        // 2 500 позиций × 4 подрядчика ≈ 9 600 строк КП — 10 страниц по 1000.
        assert.deepEqual(first, rpc ? { rpc: 1, pages: 0 } : { rpc: 1, pages: 10 })
        // Уход и возврат: КП перечитываются в фоне, функцию без неё уже не спрашивают.
        await page.locator('.tender-tab', { hasText: 'ВОР' }).first().click()
        await page.locator('.tender-tab', { hasText: 'Сравнение КП' }).click()
        await page.locator('.proposals-table tbody tr').first().waitFor()
        await page.waitForFunction((n) => window.__supabaseStats.requests
          .filter((r) => r.table === 'rpc:tender_compare_proposals' || (r.table === 'tender_counterparty_proposals' && r.range)).length > n,
        first.rpc + first.pages)
        await page.waitForTimeout(300)
        assert.deepEqual(await requests(), rpc ? { rpc: 2, pages: 0 } : { rpc: 1, pages: 20 })
        assert.deepEqual(errors, [])
      } finally {
        await context.close()
      }
    }
    assert.ok(/\d/.test(totals.true), 'итоги посчитаны')
    assert.equal(totals.true, totals.false, 'одним запросом и страницами — те же итоги')
  })

  // Колонок пометки «учтено» (миграция 20260606) нет ни в одной базе портала: выборка с ними отвечала 42703, и с
  // 11.09 «Сравнение КП» было пустым у всех тендеров («ещё не загружено ни одного КП»).
  it('«Сравнение КП» без колонок «учтено» в базе: КП видны, пометки «учтено» нет', async () => {
    for (const missing of [false, true]) {
      const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
      if (missing) {
        await context.addInitScript(() => {
          window.__fakeMissingColumns = { tender_counterparty_proposals: ['covered_elsewhere', 'coverage_note'] }
        })
      }
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
      try {
        await page.goto(`${stand.url}?items=300&cps=3&tenders=2&latency=5`)
        await page.getByRole('button', { name: /Сравнение КП/ }).click({ timeout: 120000 })
        await page.locator('.proposals-subtab').first().waitFor({ timeout: 60000 })
        assert.equal(await page.getByText('ещё не загружено ни одного КП', { exact: false }).count(), 0)
        await page.getByText('Подрядчик 03', { exact: false }).first().waitFor()
        // У «Подрядчика 01» часть материалов без цены — с колонками у них отметка «учтено», без колонок её нет.
        assert.equal(await page.locator('.covered-check').count() > 0, !missing, missing ? 'без колонок' : 'с колонками')
        const selects = await page.evaluate(() => window.__supabaseStats.requests
          .filter((r) => r.table === 'tender_counterparty_proposals' && r.op === 'select').length)
        assert.ok(selects >= 1)
        assert.deepEqual(errors, [])
      } finally {
        await context.close()
      }
    }
  })

  // Реестр тендеров: онлайн-события по участникам. Раньше каждое событие перечитывало участников всех
  // тендеров реестра (по запросу на каждые 60 тендеров) — сразу и в каждой открытой вкладке.
  it('реестр: правка участника перечитывает счётчики только его тендера, серия правок — одним запросом', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    const participantRequests = () => page.evaluate(() => window.__supabaseStats.requests
      .filter((r) => r.table === 'tender_counterparties' && r.op === 'select').map((r) => r.ids))
    const emit = (payload) => page.evaluate((p) => window.__realtime.emit('tender_counterparties', p), payload)
    const settle = () => page.waitForTimeout(2200) // дольше паузы накопления (1,5 с) и задержки «сети»
    const row = (n, over = {}) => ({ id: `live-${n}`, tender_id: `tender-${n}`, counterparty_id: 'cp-1', status: 'request_sent', notes: null, sort_order: 0, ...over })
    try {
      // 130 тендеров — три порции по 60 id: полный пересчёт стоит трёх запросов.
      await page.goto(`${stand.url}?route=/tenders/construction&tenders=130&items=20&cps=2&latency=20`)
      await page.locator('table tbody tr').first().waitFor({ timeout: 120000 })
      await page.waitForFunction(() => window.__realtime.subscriptions().includes('tender_counterparties'), null, { timeout: 30000 })
      await settle()
      const initial = await participantRequests()
      assert.ok(initial.length >= 3, `счётчики загружены при открытии (${initial.length} запросов)`)
      const after = async () => (await participantRequests()).slice(initial.length)

      // Правка примечания и порядка — счётчики не меняет: запросов нет.
      for (let n = 2; n <= 21; n++) await emit({ eventType: 'UPDATE', new: row(n, { notes: 'новое примечание' }), old: row(n) })
      for (let n = 2; n <= 21; n++) await emit({ eventType: 'UPDATE', new: row(n, { sort_order: 7 }), old: row(n) })
      await settle()
      assert.deepEqual(await after(), [], '40 правок примечаний и порядка — ни одного запроса')

      // Статус изменился у одного участника — один запрос, только по его тендеру.
      await emit({ eventType: 'UPDATE', new: row(5, { status: 'proposal_provided' }), old: row(5) })
      await settle()
      assert.deepEqual(await after(), [['tender-5']])

      // Серия: 30 событий по трём тендерам подряд (смена статусов и новые участники) — один запрос на три тендера.
      for (let i = 0; i < 30; i++) {
        const n = 7 + (i % 3)
        await emit(i % 2 ? { eventType: 'INSERT', new: row(n, { id: `new-${i}` }), old: {} }
          : { eventType: 'UPDATE', new: row(n, { status: 'declined' }), old: row(n) })
      }
      await settle()
      const burst = (await after()).slice(1)
      assert.equal(burst.length, 1, `30 событий — один запрос, а не ${burst.length}`)
      assert.deepEqual([...burst[0]].sort(), ['tender-7', 'tender-8', 'tender-9'])

      // Участник тендера не из этого реестра — запросов нет.
      await emit({ eventType: 'UPDATE', new: row(999, { status: 'declined', tender_id: 'tender-from-other-registry' }), old: row(999, { tender_id: 'tender-from-other-registry' }) })
      await emit({ eventType: 'INSERT', new: row(998, { tender_id: 'tender-from-other-registry' }), old: {} })
      await settle()
      assert.equal((await after()).length, 2, 'чужой реестр не перечитывается')

      // Удаление: в событии только ключ — пересчёт всех тендеров, но один раз на серию удалений.
      for (let i = 0; i < 5; i++) await emit({ eventType: 'DELETE', new: {}, old: { id: `live-${i}` } })
      await settle()
      const afterDelete = (await after()).slice(2)
      assert.equal(afterDelete.length, 3, `пять удалений — один полный пересчёт (три порции), а не пять: ${afterDelete.length}`)
      assert.equal(afterDelete.reduce((sum, ids) => sum + ids.length, 0), 130)
      assert.deepEqual(errors, [])
    } finally {
      await context.close().catch(() => {})
    }
  })
})
