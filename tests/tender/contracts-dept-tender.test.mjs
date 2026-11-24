// «Реестр по договорам» (/contracts/registry): разделение на ОС и ГО, вид документа — вкладками с числами, статус — переключателями
// (11.11.2026: вкладки «Все» нет), тендер у договора и ДС (03.11). 24.11.2026 (решение пользователя): отдел — один список, по
// умолчанию «ОС и ГО» при каждом открытии; «Наши договоры», «Просрочено», «Не в Larix» убраны; «Тендер» — список: все / есть / без;
// «Открыть в реестре» из заявки ДП/ДС — адрес ?id=<ID документа>.
// Правила — tests/contracts/registry-tabs.test.mjs.
// Стенд: 24 документа, 16 договоров и 8 ДС; каждый четвёртый — по объекту ГО; у ctr-2 — тендер, ДС ctr-3 берёт его же.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const BASE = 'route=/contracts/registry&contracts=24&contractsDept=1&latency=0'
// Стенд — MemoryRouter: адрес приложения целиком в route, с его ?id=.
const withId = (id) => BASE.replace('route=/contracts/registry', `route=${encodeURIComponent(`/contracts/registry?id=${id}`)}`)

describe('Договоры и ДС: ОС и ГО, тендер', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  const open = async (viewport = { width: 1600, height: 1000 }) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    await page.goto(`${stand.url}?${BASE}`)
    await page.locator('.contracts-table tbody tr.contract-row').first().waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const counts = (page, sel) => page.locator(sel).evaluateAll((els) => Object.fromEntries(els.map((b) => [
    b.firstChild.textContent.trim(), Number(b.querySelector('[class$="-count"]')?.textContent),
  ])))
  const kindCount = async (page, kind) => Number(await page.locator(`.cr-kind-tab[data-kind="${kind}"] .tab-count`).innerText())
  const chip = (page, tab) => page.locator(`.cr-status-chip[data-tab="${tab}"]`)
  const deptTrigger = (page) => page.locator('.registry-header .registry-dept .fdrop-trigger')
  const pickDept = async (page, label) => {
    await deptTrigger(page).click()
    await page.locator('.fdrop-panel .fdrop-option', { hasText: new RegExp(`^${label}$`) }).click()
  }
  const tenderTrigger = (page) => page.locator('.cr-toolbar .cr-tender-filter .fdrop-trigger')
  const pickTender = async (page, label) => {
    await tenderTrigger(page).click()
    await page.locator('.fdrop-panel .fdrop-option', { hasText: label }).click()
  }
  const rowCount = (page) => page.locator('.contracts-table tbody tr.contract-row').count()
  // Строка договора по номеру: «2/26» не должно находить «12/26».
  const rowOf = (page, number) => page.locator('.contracts-table tbody tr.contract-row', { hasText: new RegExp(`(?<![0-9])${number}/26`) }).first()

  it('шапка: отдел — один список «ОС и ГО» / ОС / ГО без чисел; строки, вкладки и объекты — выбранного отдела; при открытии — «ОС и ГО»', async () => {
    const { page, errors, close } = await open()
    try {
      // Прежний запомненный отдел реестр не открывает: по умолчанию «ОС и ГО».
      await page.evaluate(() => localStorage.setItem('contracts-dept', 'warranty_service'))
      await page.reload()
      await page.locator('.contracts-table tbody tr.contract-row').first().waitFor()
      assert.equal(await page.locator('.registry-header .registry-dept').count(), 1)
      assert.equal(await deptTrigger(page).innerText().then((t) => t.replace('▾', '').trim()), 'ОС и ГО')
      assert.equal(await page.evaluate(() => localStorage.getItem('contracts-dept')), null, 'прежний ключ убран')
      await deptTrigger(page).click()
      assert.deepEqual(await page.locator('.fdrop-panel .fdrop-option').allInnerTexts().then((l) => l.map((t) => t.replace('✓', '').trim())),
        ['ОС и ГО', 'ОС', 'ГО'], 'выбор раскрывается по нажатию; чисел на отделе нет — они на вкладках вида')
      await page.keyboard.press('Escape')
      assert.equal(await kindCount(page, 'all'), 24)

      await pickDept(page, 'ГО')
      assert.equal(await deptTrigger(page).innerText().then((t) => t.replace('▾', '').trim()), 'ГО')
      assert.match(await page.locator('.registry-header .registry-dept').getAttribute('class'), /\bis-active\b/)
      assert.equal(await rowCount(page) > 0, true)
      const shownObjects = await page.locator('.contracts-table tbody tr.contract-row td.cell-object').allInnerTexts()
      assert.ok(shownObjects.length > 0 && shownObjects.every((t) => /Гарантийный/.test(t)), shownObjects.join(' | '))
      assert.equal(await kindCount(page, 'all'), 6, 'вкладки считают выбранный отдел')

      // Объекты в фильтре — только этого отдела.
      await page.locator('.cr-toolbar .fdrop-trigger').first().click()
      const options = await page.locator('.fdrop-panel .fdrop-option').allInnerTexts()
      assert.ok(options.some((o) => /Гарантийный/.test(o)))
      assert.ok(!options.some((o) => /Северный|Нурлы/.test(o)), options.join(' | '))
      await page.keyboard.press('Escape')

      await page.reload()
      await page.locator('.contracts-table tbody tr.contract-row').first().waitFor()
      assert.equal(await deptTrigger(page).innerText().then((t) => t.replace('▾', '').trim()), 'ОС и ГО', 'после обновления — снова «ОС и ГО»')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('вид — вкладки «Договоры и ДС», «Договоры», «ДС», вкладки «Все» нет; статусов четыре; заявка и ожидание подписания — в «В работе»', async () => {
    const { page, errors, close } = await open()
    try {
      assert.deepEqual(
        await page.locator('.cr-kind-tab').evaluateAll((els) => els.map((b) => b.firstChild.textContent.trim())),
        ['Договоры и ДС', 'Договоры', 'ДС'],
      )
      assert.deepEqual(
        await page.locator('.cr-status-chip').evaluateAll((els) => els.map((b) => b.firstChild.textContent.trim())),
        ['В работе', 'Приостановка', 'Завершено', 'Удаленные'],
      )
      assert.equal(await page.locator('.status-tabs button', { hasText: /^Все/ }).count(), 0, 'кнопки «Все» нет: это «Договоры и ДС»')
      assert.equal(await page.getByText('Общий реестр').count(), 0)
      assert.match(await page.locator('.registry-pagination.is-top .rp-info').innerText(), /договоров · ДС к ним: 8/, 'сколько договоров и ДС — видно над таблицей')

      const tabs = await counts(page, '.cr-status-chip')
      assert.equal(tabs['Приостановка'], 1)
      assert.equal(tabs['Завершено'], 2)
      assert.equal(tabs['В работе'], 21, 'новая заявка и ожидание подписания — в «В работе»')
      await chip(page, 'in_work').click()
      assert.equal(await chip(page, 'in_work').getAttribute('aria-pressed'), 'true')
      assert.equal(await kindCount(page, 'all'), 21, 'число вида — при выбранном статусе')
      const statuses = (await page.locator('.contracts-table tbody tr.contract-row .cell-status').allInnerTexts()).join(' ')
      assert.match(statuses, /Новая заявка/)
      assert.match(statuses, /Ожидание подписания/, 'точный статус виден в строке')
      const clipped = await page.locator('.contracts-table tbody tr.contract-row td.cell-status .status-badge')
        .evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent))
      assert.deepEqual(clipped, [], 'статус не обрезан')
      // Повторное нажатие снимает статус — снова все.
      await chip(page, 'in_work').click()
      assert.equal(await chip(page, 'in_work').getAttribute('aria-pressed'), 'false')
      assert.equal(await kindCount(page, 'all'), 24)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Наши договоры», «Просрочено», «Не в Larix» убраны; «Сбросить» отдел не снимает', async () => {
    const { page, errors, close } = await open()
    try {
      assert.equal(await page.locator('.cr-toolbar .qfilter').count(), 0)
      for (const text of ['Наши договоры', 'Просрочено', 'Не в Larix']) {
        assert.equal(await page.locator('.cr-toolbar').getByText(text).count(), 0, text)
      }
      assert.match(await page.locator('.registry-pagination.is-top .rp-info').innerText(), /из 16 договоров/, '«наш» договор не сужает реестр')
      await pickDept(page, 'ОС')
      await pickTender(page, 'Без тендера')
      await page.locator('.cr-toolbar .cr-filter-clear').click()
      assert.equal(await deptTrigger(page).innerText().then((t) => t.replace('▾', '').trim()), 'ОС', 'отдел — не фильтр, «Сбросить» его не снимает')
      assert.equal(await tenderTrigger(page).innerText().then((t) => t.replace('▾', '').trim()), 'Тендер: все')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('тендер: ссылка в строке, ДС — от договора; список «Тендер»: есть — один, без — остальные; раскрытый документ тоже показывает', async () => {
    const { page, errors, close } = await open()
    try {
      const link = rowOf(page, 2).locator('a.ctender')
      assert.match(await link.innerText(), /^Тендер № \d+$/)
      assert.match(await link.getAttribute('href'), /\/tenders\/.+/)
      assert.equal(await page.locator('a.ctender').count(), 1, 'в виде «Договоры и ДС» строка — договор')

      await page.locator('.cr-kind-tab[data-kind="amendments"]').click()
      const inherited = rowOf(page, 3).locator('a.ctender')
      assert.match(await inherited.getAttribute('title'), /^Тендер договора: /, 'ДС берёт тендер договора')
      await page.locator('.cr-kind-tab[data-kind="all"]').click()

      await tenderTrigger(page).click()
      assert.deepEqual(await page.locator('.fdrop-panel .fdrop-option').allInnerTexts().then((l) => l.map((t) => t.replace('✓', '').trim())),
        ['Тендер: все', 'Есть тендер · 1', 'Без тендера · 15'], 'из 16 договоров один с тендером')
      await page.keyboard.press('Escape')
      await pickTender(page, 'Без тендера')
      assert.equal(await tenderTrigger(page).innerText().then((t) => t.replace('▾', '').trim()), 'Без тендера', 'в кнопке — без числа')
      assert.equal(await page.locator('.contracts-table tbody tr.contract-row', { hasText: /(?<![0-9])2\/26/ }).count(), 0)
      assert.equal(await page.locator('.registry-pagination.is-top .rp-info').innerText().then((t) => /из 15 договоров/.test(t)), true)
      await pickTender(page, 'Есть тендер')
      assert.equal(await rowCount(page), 1)
      assert.match(await page.locator('.contracts-table tbody tr.contract-row').first().innerText(), /(?<![0-9])2\/26/)
      await page.locator('.cr-kind-tab[data-kind="amendments"]').click()
      assert.match(await page.locator('.contracts-table tbody tr.contract-row').first().innerText(), /(?<![0-9])3\/26/, 'ДС — с тендером своего договора')
      await page.locator('.cr-kind-tab[data-kind="all"]').click()
      await page.locator('.cr-toolbar .cr-filter-clear').click()

      // Раскрытый документ тендер не повторяет: он — ссылкой в строке.
      await rowOf(page, 2).locator('td.cell-work .work-text').click()
      await page.locator('.contracts-table tr.contract-expanded-row').first().waitFor()
      assert.equal(await page.locator('.contracts-table tr.contract-expanded-row a[href^="/tenders/"]').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Открыть в реестре» (?id=): договор — своей строкой, раскрыт; ДС — под договором; прежние фильтры не мешают', async () => {
    const { page, errors, close } = await open()
    try {
      // Браузер помнит вид «ДС» — в нём договора нет: переход переключает на «Договоры и ДС».
      await page.locator('.cr-kind-tab[data-kind="amendments"]').click()
      await page.goto(`${stand.url}?${withId(10)}`)
      const row = rowOf(page, 10)
      await row.waitFor({ timeout: 60000 })
      assert.equal(await page.locator('.cr-kind-tab[data-kind="all"]').getAttribute('aria-selected'), 'true')
      assert.equal(await deptTrigger(page).innerText().then((t) => t.replace('▾', '').trim()), 'ОС и ГО')
      assert.equal(await page.locator('.cr-toolbar .cr-search').inputValue(), '', 'не поиском: «10» нашёл бы и другие')
      assert.equal(await page.locator('.cr-toolbar .cr-focus-chip').innerText().then((t) => t.replace('×', '').trim()), 'Договор ID 10')
      assert.equal(await rowCount(page), 1, 'ровно этот документ')
      assert.match(await row.getAttribute('class'), /\bis-expanded\b/, 'строка раскрыта')
      assert.equal(await row.getAttribute('data-doc-row'), 'ctr-10')
      // Плашка снимает отбор — снова весь реестр.
      await page.locator('.cr-toolbar .cr-focus-chip').click()
      assert.equal(await page.locator('.cr-toolbar .cr-focus-chip').count(), 0)
      assert.ok(await rowCount(page) > 1)

      // ДС ctr-3 (ID 3) — под договором ctr-2, его строка в правой области раскрыта.
      await page.goto(`${stand.url}?${withId(3)}`)
      const parent = rowOf(page, 2)
      await parent.waitFor({ timeout: 60000 })
      await page.locator('.contracts-table tr.contract-expanded-row').first().waitFor()
      assert.equal(await page.locator('.cr-toolbar .cr-focus-chip').innerText().then((t) => t.replace('×', '').trim()), 'ДС ID 3')
      assert.equal(await rowCount(page), 1, 'строка — договор этого ДС; «2» поиском нашёл бы все «N/26»')
      assert.match(await page.locator('.contracts-table tr.contract-expanded-row').first().innerText(), /3\/26/)

      // Нет такого документа — понятное сообщение.
      const dialog = page.waitForEvent('dialog')
      await page.goto(`${stand.url}?${withId(999)}`)
      const d = await dialog
      assert.match(d.message(), /Документ ID 999 в реестре не найден/)
      await d.dismiss()
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('форма: тендер — поиском среди основных тендеров объекта; у ДС пусто значит «как у договора»', async () => {
    const { page, errors, close } = await open()
    try {
      await rowOf(page, 2).getByRole('button', { name: 'Создать ДС' }).click()
      const form = page.locator('.modal').last()
      await form.waitFor()
      const trigger = form.locator('.form-group', { hasText: 'Тендер (необязательно)' }).locator('.fdrop-trigger')
      await trigger.waitFor()
      assert.match(await trigger.innerText(), /Как у договора: Тендер № \d+/)
      await trigger.click()
      const options = await page.locator('.fdrop-panel .fdrop-option').allInnerTexts()
      assert.ok(options.length > 0 && options.every((o) => /^(№ \d+ · |— Без привязки —)/.test(o)), options.slice(0, 3).join(' | '))
      assert.equal(new Set(options).size, options.length)
      // Поиск — по номеру или описанию; выбранный виден в поле, вернуть «как у договора» — «Без привязки».
      await page.locator('.fdrop-panel .fdrop-search').fill(options[0].match(/№ (\d+)/)[1])
      const found = page.locator('.fdrop-panel .fdrop-option')
      assert.equal(await found.count(), 1)
      await found.first().click()
      assert.match(await trigger.innerText(), /^№ \d+ · /)
      await trigger.click()
      await page.locator('.fdrop-panel .fdrop-option', { hasText: '— Без привязки —' }).click()
      assert.match(await trigger.innerText(), /Как у договора/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
