// «Договоры и ДС» (/contracts), решения пользователя 29.10.2026:
//   • раскрытый договор — две области под строкой: «Работа юриста» (юрист, сроки, примечание, приложения) и
//     «Дополнительные соглашения» — выпадающий список ДС; ДС больше не раскрываются полными строками таблицы;
//     позже в тот же день («рабочая область юриста слишком маленькая») — области одна под другой во всю
//     ширину: работа юриста сверху (примечание — в строке с юристом и сроками), ДС ниже — по строке на ДС;
//   • подразделение договора, как у тендеров (contracts.division, миграция 20261112): плашка под «Работами»,
//     фильтр в заголовке колонки; у ДС — подразделение договора, только показ. Колонки ещё нет — ни плашки, ни
//     фильтра, и форма не шлёт division (иначе PostgREST отказал бы во всей записи).
// Стенд: contracts=30 (у каждого третьего — ДС), contractsDivision=1 — колонка есть, у договора ctr-2 три ДС.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const BASE = 'route=/contracts&contracts=30&latency=0'

describe('Договоры и ДС: раскрытый договор и подразделение', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  const open = async (extra = '') => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    // «Договоры и ДС» — вид по умолчанию; выбор вида живёт в localStorage.
    await page.addInitScript(() => { try { localStorage.removeItem('contracts-doc-kind') } catch { /* нет */ } })
    await page.goto(`${stand.url}?${BASE}${extra}`)
    await page.locator('.contracts-table tbody tr.contract-row').first().waitFor({ timeout: 120000 })
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }
  const row = (page, id) => page.locator('.contracts-table tbody tr.contract-row', { has: page.locator(`a.contract-ds-link[href="/contracts/${id}"]`) })
  const contract = (page, id) => page.evaluate((cid) => {
    const c = window.__fakeDb.contracts.find((x) => x.id === cid)
    return c ? { ...c } : null
  }, id)

  it('«ДС: N» раскрывает две области: работа юриста и выпадающий список ДС, строк таблицы не добавляется', async () => {
    const { page, errors, close } = await open('&contractsDivision=1')
    try {
      const rows = await page.locator('.contracts-table tbody tr.contract-row').count()
      await row(page, 'ctr-2').locator('.ds-toggle', { hasText: 'ДС: 3' }).click()
      const expanded = page.locator('.contracts-table tbody tr.contract-expanded-row')
      await expanded.waitFor()
      assert.equal(await page.locator('.contracts-table tbody tr.contract-row').count(), rows, 'ДС — не строки таблицы')
      assert.match(await expanded.locator('.ce2-area-lawyer .ce2-area-title').innerText(), /Работа юриста/)
      assert.match(await expanded.locator('.ce2-area-ds .ce2-area-title').innerText(), /Дополнительные соглашения/)
      // Работа юриста — во всю ширину, ДС — под ней; ДС — одной строкой (предмет — в строке, сумма справа).
      const areas = await expanded.evaluate((tr) => {
        const box = (sel) => tr.querySelector(sel).getBoundingClientRect()
        const wrap = box('.ce2-wrap')
        const lawyer = box('.ce2-area-lawyer')
        const ds = box('.ce2-area-ds')
        const head = tr.querySelector('.ce2-ds-toggle')
        const line = parseFloat(getComputedStyle(head.querySelector('.ce2-ds-num')).lineHeight) || 20
        return {
          lawyerFull: Math.abs(lawyer.width - wrap.width) < 2,
          dsBelow: ds.top >= lawyer.bottom,
          dsFull: Math.abs(ds.width - wrap.width) < 2,
          dsOneLine: head.getBoundingClientRect().height < line * 2,
        }
      })
      assert.deepEqual(areas, { lawyerFull: true, dsBelow: true, dsFull: true, dsOneLine: true })
      // Примечание юриста — в строке с юристом и сроками, «Открыть карточку» — в шапке области.
      assert.deepEqual(await expanded.locator('.ce2-area-lawyer > .ce2-fields .ce2-label').allInnerTexts(),
        ['ЮРИСТ', 'ПРИНЯТ В РАБОТУ', 'ПЛАН. ПОДПИСАНИЯ', 'ПРИМЕЧАНИЕ ЮРИСТА'])
      assert.equal(await expanded.locator('.ce2-area-lawyer .ce2-area-head .ce-open-card').innerText(), 'Открыть карточку договора')
      assert.match(await expanded.locator('.ce2-info').innerText(), /ID портала\s*2/)
      // Три ДС по ID: изменение ВОР, доп. работы и ДС к ДС (с пометкой, к какому).
      const items = expanded.locator('.ce2-ds')
      assert.equal(await items.count(), 3)
      assert.deepEqual(await expanded.locator('.ce2-ds-num').allInnerTexts(), ['№ 3/26', '№ ДР-1', '№ 2'])
      assert.match(await items.nth(2).locator('.ds-parent-note').innerText(), /к ДС № 3\/26/)
      assert.match(await items.nth(1).innerText(), /просрочено/)

      // Стрелка ДС — его работа юриста (со статусом), пути и действия; щелчок по строке договора тут ни при чём.
      await items.nth(1).locator('.ce2-ds-toggle').click()
      const body = items.nth(1).locator('.ce2-ds-body')
      await body.waitFor()
      assert.equal(await items.nth(1).locator('.ce2-ds-toggle').getAttribute('aria-expanded'), 'true')
      assert.deepEqual(await body.locator('.ce2-label').allInnerTexts(), ['СТАТУС', 'ЮРИСТ', 'ПРИНЯТ В РАБОТУ', 'ПЛАН. ПОДПИСАНИЯ', 'ПРИМЕЧАНИЕ ЮРИСТА'])
      assert.match(await body.locator('.ce-block-title').last().innerText(), /Приложения к ДС/)
      const note = body.locator('textarea.ce-note')
      await note.fill('Ждём подпись подрядчика')
      await note.blur()
      await page.waitForFunction(() => window.__fakeDb.contracts.find((c) => c.id === 'ctr-x1')?.notes === 'Ждём подпись подрядчика')
      assert.equal((await contract(page, 'ctr-2')).notes ?? null, null, 'примечание ДС не попало в договор')
      assert.equal(await page.locator('.contracts-table tbody tr.contract-expanded-row').count(), 1, 'договор остался раскрыт')

      // Раскрытых договоров может быть несколько.
      await row(page, 'ctr-5').locator('.cell-counterparty').click()
      await page.waitForFunction(() => document.querySelectorAll('.contracts-table tbody tr.contract-expanded-row').length === 2)
      // Второй щелчок по «ДС: 3» сворачивает.
      await row(page, 'ctr-2').locator('.ds-toggle').click()
      await page.waitForFunction(() => document.querySelectorAll('.contracts-table tbody tr.contract-expanded-row').length === 1)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('подразделение: плашка под работами у договора, у его ДС — то же, только показ; фильтр в заголовке', async () => {
    const { page, errors, close } = await open('&contractsDivision=1')
    try {
      const r = row(page, 'ctr-2')
      await r.locator('.cdiv .fdrop-trigger').click()
      await page.locator('.fdrop-panel .fdrop-option', { hasText: 'Отделка' }).click()
      await page.waitForFunction(() => window.__fakeDb.contracts.find((c) => c.id === 'ctr-2')?.division === 'finishing')
      // Щелчок по плашке строку не раскрывает.
      assert.equal(await page.locator('.contracts-table tbody tr.contract-expanded-row').count(), 0)
      assert.match(await r.locator('.cdiv').innerText(), /Отделка/)
      // История — подписями.
      const log = await page.evaluate(() => (window.__fakeDb.contract_audit_log || []).filter((l) => l.contract_id === 'ctr-2' && l.field_name === 'division'))
      assert.equal(log.at(-1)?.new_value, 'Отделка')

      // Фильтр в заголовке «Работы»: числа — по реестру без него; «Отделка» — один договор.
      await page.locator('.cth-work .fdrop-trigger').click()
      const options = await page.locator('.fdrop-panel .fdrop-option-text').allTextContents()
      assert.ok(options.includes('Отделка (1)'), options.join(', '))
      await page.locator('.fdrop-panel .fdrop-option', { hasText: 'Отделка' }).click()
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelectorAll('.contracts-table tbody tr.contract-row').length === 1)
      assert.ok(await page.locator('.contracts-table thead th.th-filtered').count() === 1, 'заголовок помечен')

      // Вид «ДС»: ДС договора ctr-2 показывают его подразделение без выбора.
      await page.locator('.rf-doc-kind-btn', { hasText: /^ДС$/ }).click()
      const ds = row(page, 'ctr-3')
      await ds.waitFor()
      assert.match(await ds.locator('.cdiv').innerText(), /Отделка/)
      assert.equal(await ds.locator('.cdiv .fdrop-trigger').count(), 0, 'у ДС — только показ')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('форма: подразделение договора сохраняется; без колонки в базе — ни плашки, ни фильтра, division не отправляется', async () => {
    const withColumn = await open('&contractsDivision=1')
    try {
      const { page } = withColumn
      await row(page, 'ctr-5').locator('.btn-edit').click()
      await page.locator('#contract-form-division').selectOption('electrical')
      await page.locator('.modal button[type="submit"]').click()
      await page.waitForFunction(() => window.__fakeDb.contracts.find((c) => c.id === 'ctr-5')?.division === 'electrical')
      // У ДС выбора нет — подразделение договора.
      await row(page, 'ctr-2').locator('.ds-toggle').click()
      await page.locator('.ce2-ds').first().locator('.ce2-ds-toggle').click()
      await page.locator('.ce2-ds-body .ce-edit-link', { hasText: 'Редактировать ДС' }).click()
      assert.equal(await page.locator('select#contract-form-division').count(), 0)
      assert.match(await page.locator('#contract-form-division').innerText(), /Как у договора/)
      assert.deepEqual(withColumn.errors, [])
    } finally { await withColumn.close() }

    const noColumn = await open()
    try {
      const { page } = noColumn
      assert.equal(await page.locator('.cdiv').count(), 0)
      assert.equal(await page.locator('.cth-work').count(), 0)
      await row(page, 'ctr-5').locator('.btn-edit').click()
      assert.equal(await page.locator('#contract-form-division').count(), 0)
      await page.locator('.modal input[name="contract_number"]').fill('5/26-изм')
      await page.locator('.modal button[type="submit"]').click()
      await page.waitForFunction(() => window.__fakeDb.contracts.find((c) => c.id === 'ctr-5')?.contract_number === '5/26-изм')
      assert.equal('division' in (await contract(page, 'ctr-5')), false, 'division не отправлен')
      assert.deepEqual(noColumn.dialogs, [])
      assert.deepEqual(noColumn.errors, [])
    } finally { await noColumn.close() }
  })
})
