// Подразделение ВОР (tenders.vor_division) — одно поле в двух разделах: плашка под описанием
// работ в реестре «Тендеры — Основное строительство» и столбец «Подразделение» в «ВОРах и РД».
// Правка в одном разделе видна в другом: при переходе (данные из базы) и онлайн (подписка на tenders).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { VOR_DIVISIONS, VOR_DIVISION_LABEL, vorDivisionLogPayload } from '../../src/utils/vorDivisions.js'

describe('Подразделение ВОР: справочник и журнал', () => {
  it('коды — те же, что в CHECK миграции 20260927', () => {
    assert.deepEqual(VOR_DIVISIONS.map((d) => d.value), ['monolith', 'nvf_spk', 'general', 'hvac_water', 'electrical'])
    assert.equal(VOR_DIVISION_LABEL.general, 'Общестроительные работы')
  })

  it('запись в журнал тендера одинакова из обоих разделов', () => {
    assert.deepEqual(vorDivisionLogPayload(null, 'monolith'), {
      fieldName: 'vor_division', oldValue: null, newValue: 'Монолит', description: 'Указано подразделение ВОР: Монолит',
    })
    assert.equal(vorDivisionLogPayload('monolith', 'electrical').description, 'Сменено подразделение ВОР: Монолит → ЭОМ/СС')
    assert.equal(vorDivisionLogPayload('general', null).description, 'Снято подразделение ВОР (было: Общестроительные работы)')
  })
})

const launch = browserLaunchOptions()

describe('Подразделение ВОР в реестре тендеров и в «ВОРах и РД»', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  const openPage = async (query) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => d.accept())
    await page.goto(`${stand.url}?${query}`)
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  // Строка тендера по номеру: в реестре — колонка «№», в «ВОРах и РД» — первая ячейка.
  const registryRow = (page, num) => page.locator('table.tenders-registry > tbody > tr').filter({ has: page.locator('.tp-num-value', { hasText: new RegExp(`^${num}$`) }) })
  const vorsRow = (page, num) => page.locator('table.vors-table > tbody > tr').filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^${num}$`) }) })
  const pick = async (page, label) => page.locator('.fdrop-panel .fdrop-option', { hasText: new RegExp(`^${label}`) }).click()
  const dbDivision = (page, id) => page.evaluate((tid) => window.__fakeDb.tenders.find((t) => t.id === tid).vor_division, id)

  it('реестр: выбор под описанием пишет поле и журнал, «ВОРы и РД» показывают то же; обратно — тоже', async () => {
    const { page, errors, close } = await openPage('route=/tenders/construction&tenders=10&items=20&cps=2&latency=0')
    try {
      await page.locator('table.tenders-registry > tbody > tr').first().waitFor({ timeout: 120000 })
      // tender-1 (№ 200) — без подразделения: пунктирная плашка «Подразделение» под описанием.
      const row = registryRow(page, 200)
      const chip = row.locator('td.tender-desc-cell .tender-flags .fdrop.vdiv-fdrop')
      assert.equal(await chip.locator('.fdrop-value').textContent(), 'Подразделение')
      // У tender-2 (№ 199) подразделение уже есть — видно сразу.
      assert.match(await registryRow(page, 199).locator('.vdiv-fdrop .fdrop-value').textContent(), /Монолит$/)

      await chip.locator('.fdrop-trigger').click()
      await pick(page, 'ОВиВК')
      await page.waitForFunction(() => window.__fakeDb.tenders.find((t) => t.id === 'tender-1').vor_division === 'hvac_water', null, { timeout: 10000 })
      assert.match(await chip.locator('.fdrop-value').textContent(), /ОВиВК$/)
      const log = await page.evaluate(() => window.__fakeDb.tender_audit_log.filter((e) => e.field_name === 'vor_division'))
      assert.equal(log.length, 1)
      assert.equal(log[0].description, 'Указано подразделение ВОР: ОВиВК')

      // Переход в «ВОРы и РД» — то же значение в столбце «Подразделение».
      await page.evaluate(() => window.__navigate('/vors'))
      await page.locator('table.vors-table > tbody > tr').first().waitFor({ timeout: 60000 })
      const vorCell = vorsRow(page, 200).locator('.vor-div-fdrop')
      assert.equal(await vorCell.locator('.vor-div-chip').textContent(), 'ОВиВК')

      // Правка в «ВОРах и РД» — видна в реестре тендеров.
      await vorCell.locator('.fdrop-trigger').click()
      await pick(page, 'ЭОМ/СС')
      await page.waitForFunction(() => window.__fakeDb.tenders.find((t) => t.id === 'tender-1').vor_division === 'electrical', null, { timeout: 10000 })
      await page.evaluate(() => window.__navigate('/tenders/construction'))
      await registryRow(page, 200).waitFor({ timeout: 60000 })
      assert.match(await registryRow(page, 200).locator('.vdiv-fdrop .fdrop-value').textContent(), /ЭОМ\/СС$/)

      // «Не указано» снимает подразделение.
      await registryRow(page, 200).locator('.vdiv-fdrop .fdrop-trigger').click()
      await pick(page, 'Не указано')
      await page.waitForFunction(() => window.__fakeDb.tenders.find((t) => t.id === 'tender-1').vor_division === null, null, { timeout: 10000 })
      assert.equal(await registryRow(page, 200).locator('.vdiv-fdrop .fdrop-value').textContent(), 'Подразделение')
      assert.equal(await dbDivision(page, 'tender-1'), null)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('онлайн: правка коллеги приходит в открытые «ВОРы и РД» и в реестр без перезагрузки', async () => {
    const { page, errors, close } = await openPage('route=/vors&tenders=10&items=20&cps=2&latency=0')
    try {
      await page.locator('table.vors-table > tbody > tr').first().waitFor({ timeout: 120000 })
      await page.waitForFunction(() => window.__realtime.subscriptions().includes('tenders'), null, { timeout: 30000 })
      // Событие несёт строку без связей — объект и ответственные в строке остаются.
      const emit = (id, value) => page.evaluate(([tid, v]) => {
        const old = window.__fakeDb.tenders.find((t) => t.id === tid)
        const { objects: _o, responsible_contact: _r, tender_winners: _w, materials_tender: _m, ...plain } = old
        window.__realtime.emit('tenders', { eventType: 'UPDATE', new: { ...plain, vor_division: v }, old: { id: tid } })
      }, [id, value])
      await emit('tender-3', 'nvf_spk')
      await page.waitForFunction(() => [...document.querySelectorAll('table.vors-table > tbody > tr')]
        .some((r) => r.cells[0].textContent.trim() === '198' && r.querySelector('.vor-div-chip')?.textContent === 'НВФ/СПК'), null, { timeout: 10000 })
      assert.match(await vorsRow(page, 198).locator('td').nth(1).textContent(), /Северный квартал/, 'связь «объект» не потерялась')

      await page.evaluate(() => window.__navigate('/tenders/construction'))
      await registryRow(page, 198).waitFor({ timeout: 60000 })
      await page.waitForFunction(() => window.__realtime.subscriptions().includes('tenders'), null, { timeout: 30000 })
      await emit('tender-3', 'monolith')
      await page.waitForFunction(() => [...document.querySelectorAll('table.tenders-registry > tbody > tr')]
        .some((r) => r.querySelector('.tp-num-value')?.textContent === '198' && /Монолит$/.test(r.querySelector('.vdiv-fdrop .fdrop-value')?.textContent || '')), null, { timeout: 10000 })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('без права правки: заполненное подразделение — только надпись, пустое не показывается', async () => {
    const { page, errors, close } = await openPage('route=/tenders/construction&tenders=10&items=20&cps=2&latency=0&canEdit=0')
    try {
      await page.locator('table.tenders-registry > tbody > tr').first().waitFor({ timeout: 120000 })
      assert.equal(await page.locator('.vdiv-fdrop').count(), 0, 'списка выбора нет')
      assert.equal(await registryRow(page, 200).locator('.vdiv').count(), 0, 'пустое — без плашки')
      assert.match(await registryRow(page, 198).locator('.vdiv').textContent(), /Общестроительные работы$/)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
