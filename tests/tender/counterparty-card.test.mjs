// Карточка контрагента (/general/counterparties), вкладка «Общая информация»:
//   • колонки «Примечание» в реестре нет — примечание правится во вкладке и сохраняется в базу;
//   • НДС: ставка или «без НДС», запись в базу и в журнал «Изменения»; без колонок (миграция 20261026 не
//     применена) — подпись вместо списка; без права правки — только текст;
//   • НДС меняется и в реестре (колонка «НДС»): правка в реестре видна в карточке и наоборот; без права правки —
//     текст, без колонок НДС в базе — колонки в реестре нет;
//   • аффилированные компании — группа counterparty_relations: добавить, исключить, открыть карточку компании;
//     отдельной кнопки и окна «Связи» в реестре больше нет;
//   • договоры и ДС, где контрагент — сторона (основной или вторая сторона), ДС — под своим договором,
//     чужие договоры не попадают; на телефоне — карточки, без прокрутки вбок;
//   • договор можно прикрепить к контрагенту вручную и открепить (миграция 20261031): администратор видит пометку
//     «добавлен вручную» и кто прикрепил; без права правки — ни прикрепить, ни открепить, пометки нет;
//     без таблицы привязок — раздел как раньше, без «Прикрепить договор».
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const BASE = 'route=/general/counterparties&cps=6&cpContacts=1&items=20&latency=0'

describe('Карточка контрагента: «Общая информация»', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 600000 }, () => {
  let stand
  let browser

  before(async () => {
    stand = await startStand(REPO)
    browser = await chromium.launch({ ...launch, headless: true })
    // Прогрев: первая загрузка компилирует модули dev-сервером.
    const page = await browser.newPage()
    await page.goto(`${stand.url}?${BASE}&cpCard=1`)
    await page.locator('table.compact-table tbody tr.table-row').first().waitFor({ timeout: 120000 })
    await page.close()
  })
  after(async () => {
    await browser?.close()
    await stand?.server.close()
  })

  async function openPage(query, viewport = { width: 1440, height: 900 }, extra = {}) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport, ...extra })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => d.accept())
    await page.goto(`${stand.url}?${query}`)
    return { page, errors, close: () => context.close().catch(() => {}) }
  }

  const openCard = async (page, name) => {
    const row = page.locator('table.compact-table tbody tr.table-row', { hasText: name })
    await row.waitFor({ timeout: 60000 })
    // По наименованию: ячейки контактов, телефона и статуса клик в строку не пропускают.
    await row.locator('.company-name').click()
    await page.locator('.cp-detail-modal').waitFor()
  }
  const cp1 = (page) => page.evaluate(() => window.__fakeDb.counterparties.find(c => c.id === 'cp-1'))

  it('реестр без «Примечания»; карточка открывается на «Общей информации»; примечание и НДС пишутся в базу', async () => {
    const { page, errors, close } = await openPage(`${BASE}&cpCard=1`)
    try {
      await page.locator('table.compact-table tbody tr.table-row').first().waitFor({ timeout: 60000 })
      const headers = await page.locator('table.compact-table thead th').allInnerTexts()
      assert.ok(!headers.some(h => /Примечание/i.test(h)), `в реестре нет колонки примечания: ${headers.join(' | ')}`)

      await openCard(page, 'Подрядчик 01')
      const tabs = await page.locator('.cp-detail-tab').allInnerTexts()
      assert.equal(tabs[0], 'Общая информация')
      assert.match(await page.locator('.cp-detail-tab.active').innerText(), /Общая информация/)

      const notes = page.locator('textarea.cpg-notes')
      assert.equal(await notes.inputValue(), 'Работает только по предоплате')
      await notes.fill('Работает по предоплате 30 %')
      await notes.evaluate(el => el.blur())
      await page.waitForFunction(() => window.__fakeDb.counterparties.find(c => c.id === 'cp-1').notes === 'Работает по предоплате 30 %')

      const vat = page.locator('select.cpg-vat-select')
      assert.equal(await vat.inputValue(), '22')
      await vat.selectOption('exempt')
      await page.waitForFunction(() => window.__fakeDb.counterparties.find(c => c.id === 'cp-1').vat_exempt === true)
      const saved = await cp1(page)
      assert.equal(saved.vat_rate, null)
      const log = await page.evaluate(() => window.__fakeDb.counterparty_audit_log.map(r => r.description))
      assert.ok(log.includes('НДС: 22 % → Без НДС'), log.join(' | '))

      // Вкладку переключили и вернулись — видно сохранённое, а не снимок строки при открытии.
      await page.locator('.cp-detail-tab', { hasText: 'Документы' }).click()
      await page.locator('.cp-detail-tab', { hasText: 'Общая информация' }).click()
      assert.equal(await page.locator('select.cpg-vat-select').inputValue(), 'exempt')
      assert.equal(await page.locator('textarea.cpg-notes').inputValue(), 'Работает по предоплате 30 %')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('НДС в реестре: правка в строке видна в карточке, правка в карточке — в строке', async () => {
    const { page, errors, close } = await openPage(`${BASE}&cpCard=1`)
    try {
      const rowVat = (name) => page.locator('table.compact-table tbody tr.table-row', { hasText: name }).locator('select.vat-select-mini')
      await rowVat('Подрядчик 01').waitFor({ timeout: 60000 })
      const headers = await page.locator('table.compact-table thead th').allInnerTexts()
      assert.ok(headers.some(h => /^НДС$/i.test(h.trim())), `в реестре есть колонка НДС: ${headers.join(' | ')}`)
      assert.equal(await rowVat('Подрядчик 01').inputValue(), '22')
      assert.equal(await rowVat('Подрядчик 02').inputValue(), '')

      // Выбор в строке не открывает карточку и пишет в базу и журнал так же, как вкладка.
      await rowVat('Подрядчик 02').selectOption('10')
      await page.waitForFunction(() => Number(window.__fakeDb.counterparties.find(c => c.id === 'cp-2').vat_rate) === 10)
      assert.equal(await page.locator('.cp-detail-modal').count(), 0, 'карточка не открылась')
      const log = await page.evaluate(() => window.__fakeDb.counterparty_audit_log.filter(r => r.counterparty_id === 'cp-2').map(r => r.description))
      assert.ok(log.includes('НДС: не указан → 10 %'), log.join(' | '))

      await openCard(page, 'Подрядчик 02')
      const cardVat = page.locator('select.cpg-vat-select')
      assert.equal(await cardVat.inputValue(), '10')
      await cardVat.selectOption('exempt')
      await page.waitForFunction(() => window.__fakeDb.counterparties.find(c => c.id === 'cp-2').vat_exempt === true)
      assert.equal(await rowVat('Подрядчик 02').inputValue(), 'exempt')
      assert.deepEqual(errors, [])
    } finally { await close() }

    const ro = await openPage(`${BASE}&cpCard=1&canEdit=0`)
    try {
      const cell = ro.page.locator('table.compact-table tbody tr.table-row', { hasText: 'Подрядчик 01' }).locator('td.col-vat')
      await cell.waitFor({ timeout: 60000 })
      assert.equal((await cell.innerText()).trim(), '22 %')
      assert.equal(await ro.page.locator('select.vat-select-mini').count(), 0)
      assert.deepEqual(ro.errors, [])
    } finally { await ro.close() }

    const old = await openPage(BASE)
    try {
      await old.page.locator('table.compact-table tbody tr.table-row').first().waitFor({ timeout: 60000 })
      const headers = await old.page.locator('table.compact-table thead th').allInnerTexts()
      assert.ok(!headers.some(h => /НДС/i.test(h)), `без колонок НДС в базе колонки нет: ${headers.join(' | ')}`)
      assert.equal(await old.page.locator('td.col-vat').count(), 0)
      assert.deepEqual(old.errors, [])
    } finally { await old.close() }
  })

  it('аффилированные компании: добавить, исключить, открыть карточку; кнопки «Связи» в реестре нет', async () => {
    const { page, errors, close } = await openPage(`${BASE}&cpCard=1`)
    try {
      await openCard(page, 'Подрядчик 01')
      const items = page.locator('.cpg-affiliate')
      await items.first().waitFor()
      assert.deepEqual(await page.locator('.cpg-affiliate-name').allInnerTexts(), ['Подрядчик 02'])

      await page.locator('input.cpg-search').fill('Подрядчик 05')
      await page.locator('.cpg-search-option', { hasText: 'Подрядчик 05' }).click()
      await page.locator('.cpg-affiliate', { hasText: 'Подрядчик 05' }).waitFor()
      assert.equal(await page.locator('input.cpg-search').inputValue(), '', 'поиск очищен после добавления')
      const pairs = await page.evaluate(() => window.__fakeDb.counterparty_relations.map(r => `${r.counterparty_id}>${r.related_counterparty_id}`))
      assert.ok(pairs.includes('cp-1>cp-5'), pairs.join(' '))

      // Отдельной кнопки и окна «Связи» больше нет — всё в «Общей информации».
      assert.equal(await page.locator('.cp-relations-btn').count(), 0)
      assert.equal(await page.locator('table.compact-table').getByText('Связи', { exact: false }).count(), 0)

      await page.locator('.cpg-affiliate', { hasText: 'Подрядчик 02' }).locator('.cpg-icon-btn').click()
      await page.waitForFunction(() => !window.__fakeDb.counterparty_relations.some(r => r.counterparty_id === 'cp-2' || r.related_counterparty_id === 'cp-2'))
      await page.locator('.cpg-affiliate', { hasText: 'Подрядчик 02' }).waitFor({ state: 'detached' })
      assert.deepEqual(await page.locator('.cpg-affiliate-name').allInnerTexts(), ['Подрядчик 05'])

      await page.locator('.cpg-affiliate-name', { hasText: 'Подрядчик 05' }).click()
      await page.locator('.cp-detail-title h3', { hasText: 'Подрядчик 05' }).waitFor()
      assert.deepEqual(await page.locator('.cpg-affiliate-name').allInnerTexts(), ['Подрядчик 01'])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('договоры и ДС контрагента: свои и как вторая стороны, ДС под договором, чужих нет', async () => {
    const { page, errors, close } = await openPage(`${BASE}&cpCard=1`)
    try {
      await openCard(page, 'Подрядчик 01')
      const table = page.locator('table.cpg-contracts-table')
      await table.waitFor()
      assert.equal(await page.locator('.cpg-contracts-count').innerText(), 'Договоров: 3 · ДС: 2')
      const rows = await table.locator('tbody tr').allInnerTexts()
      assert.equal(rows.length, 5, rows.join('\n'))
      assert.match(rows[0], /Договор\s+№ П-15\/26\s+от 02\.03\.2026/)
      assert.match(rows[0], /ЖК Северный/)
      assert.match(rows[0], /с учётом ДС 1\s250\s000,00 ₽/)
      assert.match(rows[1], /ДС на дополнительные работы\s+№ ДС-1/)
      assert.match(rows[2], /ДС на изменение ВОР\s+№ ДС-2/)
      assert.match(rows[3], /Договор\s+№ Т-7/)
      // Прикреплённый вручную — тоже здесь, а пометку видит только администратор (у своих договоров её нет).
      assert.match(rows[4], /Договор\s+№ Л-3\s+от 01\.06\.2024/)
      assert.match(rows[4], /ЖК Южный/)
      assert.equal(await table.locator('.cpg-manual').count(), 1)
      assert.match(await table.locator('tbody tr').nth(4).locator('.cpg-manual').innerText(), /добавлен вручную/)
      assert.ok(!rows.join('\n').includes('ЧУЖОЙ'), 'чужой договор не показан')
      assert.equal(await table.locator('tbody tr').first().locator('a.cpg-doc-link').getAttribute('href'), '/contracts/k-1')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('договор прикрепляется вручную и открепляется; в журнале «Изменения» — обе записи', async () => {
    const { page, errors, close } = await openPage(`${BASE}&cpCard=1`)
    try {
      await openCard(page, 'Подрядчик 01')
      const table = page.locator('table.cpg-contracts-table')
      await table.waitFor()
      // Пометка администратору — кто прикрепил и когда.
      const mark = table.locator('tbody tr', { hasText: 'Л-3' }).locator('.cpg-manual')
      assert.match(await mark.getAttribute('title'), /прикрепил: Петров П\. П\./)

      await page.locator('.cpg-attach-btn').click()
      const search = page.locator('.cpg-attach input.cpg-search')
      // Уже показанные договоры выбор не предлагает.
      await search.fill('П-15')
      await page.locator('.cpg-search-results', { hasText: 'Не найдено' }).waitFor()
      // Поиск — по номеру, предмету, объекту и контрагенту, слова в любом порядке.
      await search.fill('объект другой')
      const option = page.locator('.cpg-choice', { hasText: 'ЧУЖОЙ-1' })
      await option.waitFor()
      assert.match(await option.innerText(), /Другой объект · Подрядчик 04/)
      await option.click()
      await page.waitForFunction(() => window.__fakeDb.counterparty_contract_links.some(l => l.counterparty_id === 'cp-1' && l.contract_id === 'k-3'))
      await table.locator('tbody tr', { hasText: 'ЧУЖОЙ-1' }).waitFor()
      assert.equal(await page.locator('.cpg-attach').count(), 0, 'выбор закрылся')
      assert.equal(await page.locator('.cpg-contracts-count').innerText(), 'Договоров: 4 · ДС: 2')
      assert.match(await table.locator('tbody tr', { hasText: 'ЧУЖОЙ-1' }).locator('.cpg-manual').getAttribute('title'), /Стендов С\. С\./)
      const link = await page.evaluate(() => window.__fakeDb.counterparty_contract_links.find(l => l.contract_id === 'k-3'))
      assert.equal(link.created_by, 'user-1', 'кто прикрепил — ставит база, а не страница')

      // Открепить можно только прикреплённый вручную: у своих договоров кнопки нет.
      assert.equal(await table.locator('tbody tr', { hasText: 'П-15/26' }).locator('.cpg-detach').count(), 0)
      await table.locator('tbody tr', { hasText: 'Л-3' }).locator('.cpg-detach').click()
      await page.waitForFunction(() => !window.__fakeDb.counterparty_contract_links.some(l => l.contract_id === 'k-4'))
      await table.locator('tbody tr', { hasText: 'Л-3' }).waitFor({ state: 'detached' })
      assert.ok(await page.evaluate(() => window.__fakeDb.contracts.some(k => k.id === 'k-4' && !k.deleted_at)), 'сам договор остался')

      const log = await page.evaluate(() => window.__fakeDb.counterparty_audit_log.filter(r => r.counterparty_id === 'cp-1').map(r => r.description))
      assert.ok(log.includes('Прикреплён договор № ЧУЖОЙ-1 от 01.01.2026'), log.join(' | '))
      assert.ok(log.includes('Откреплён договор № Л-3 от 01.06.2024'), log.join(' | '))
      await page.locator('.cp-detail-tab', { hasText: 'Изменения' }).click()
      await page.locator('.cp-audit-item', { hasText: 'Откреплён договор № Л-3' }).waitFor()
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без права правки — только текст; без колонок НДС — подпись вместо списка', async () => {
    const ro = await openPage(`${BASE}&cpCard=1&canEdit=0`)
    try {
      await openCard(ro.page, 'Подрядчик 01')
      await ro.page.locator('.cpg-field', { hasText: 'НДС' }).waitFor()
      assert.equal(await ro.page.locator('select.cpg-vat-select').count(), 0)
      assert.match(await ro.page.locator('.cpg-field', { hasText: 'НДС' }).innerText(), /22 %/)
      assert.equal(await ro.page.locator('textarea.cpg-notes').count(), 0)
      assert.equal(await ro.page.locator('.cpg-notes-text').innerText(), 'Работает только по предоплате')
      assert.equal(await ro.page.locator('input.cpg-search').count(), 0)
      assert.equal(await ro.page.locator('.cpg-affiliate .cpg-icon-btn').count(), 0)
      // Прикреплённый вручную договор виден, но без пометки (она — администратору) и без «открепить».
      await ro.page.locator('table.cpg-contracts-table tbody tr', { hasText: 'Л-3' }).waitFor()
      assert.equal(await ro.page.locator('.cpg-attach-btn').count(), 0)
      assert.equal(await ro.page.locator('.cpg-manual').count(), 0)
      assert.equal(await ro.page.locator('.cpg-detach').count(), 0)
      assert.deepEqual(ro.errors, [])
    } finally { await ro.close() }

    const old = await openPage(BASE)
    try {
      await openCard(old.page, 'Подрядчик 01')
      await old.page.locator('.cpg-field', { hasText: 'НДС' }).waitFor()
      assert.equal(await old.page.locator('select.cpg-vat-select').count(), 0)
      assert.match(await old.page.locator('.cpg-field', { hasText: 'НДС' }).innerText(), /появится после обновления базы/)
      assert.deepEqual(old.errors, [])
    } finally { await old.close() }

    // Таблицы привязок нет (миграция 20261031 не применена): договоры — как раньше, прикрепить нельзя.
    const noLinks = await openPage(`${BASE}&cpCard=1&cpLinks=0`)
    try {
      await openCard(noLinks.page, 'Подрядчик 01')
      await noLinks.page.locator('table.cpg-contracts-table').waitFor()
      assert.equal(await noLinks.page.locator('.cpg-contracts-count').innerText(), 'Договоров: 2 · ДС: 2')
      assert.equal(await noLinks.page.locator('.cpg-attach-btn').count(), 0)
      assert.deepEqual(noLinks.errors, [])
    } finally { await noLinks.close() }
  })

  it('телефон: договоры карточками, вкладка без прокрутки вбок', async () => {
    const { page, errors, close } = await openPage(`${BASE}&cpCard=1&shell=1`,
      { width: 390, height: 844 }, { isMobile: true, hasTouch: true })
    try {
      const row = page.locator('.cp-mrow', { hasText: 'Подрядчик 01' })
      await row.waitFor({ timeout: 60000 })
      await row.locator('.cp-mrow-open').click()
      await page.locator('.cpg-contract-card').first().waitFor()
      assert.equal(await page.locator('.cpg-contract-card').count(), 3)
      assert.equal(await page.locator('.cpg-contract-card .cpg-manual').count(), 1)
      assert.equal(await page.locator('.cpg-contract-card-row.is-ds').count(), 2)
      const overflow = await page.evaluate(() => {
        const body = document.querySelector('.cp-detail-body')
        return body.scrollWidth - body.clientWidth
      })
      assert.ok(overflow <= 1, `прокрутка вбок внутри вкладки: ${overflow}px`)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
