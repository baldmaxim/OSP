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
})
