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

  it('данные грузятся параллельно, таблицы виртуализированы, «учтено» не перекачивает КП, возврат на вкладку мгновенный', async () => {
    const m = await runScenario(browser, stand.url)
    console.log('    метрики:', JSON.stringify(m))
    assert.deepEqual(m.errors, [])
    assert.ok(m.maxParallelRequests > 1, 'страницы запрашиваются одновременно')
    assert.ok(m.vorDomRows < 400, `в DOM окно строк ВОР, а не все позиции (${m.vorDomRows})`)
    assert.ok(m.compareDomRows < 400, `в DOM окно строк сравнения (${m.compareDomRows})`)
    assert.equal(m.toggleProposalSelects, 0, 'после «учтено» список КП не перезагружается')
    assert.ok(m.compareReturnMs < m.compareLoadMs / 2, `возврат на вкладку показывает кэш (${m.compareReturnMs} мс против ${m.compareLoadMs} мс)`)
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
