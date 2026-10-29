// «Отчёты → Тендеры → Подрядчики» (до 29.10.2026 — «Победители») в Chromium. Стенд tests/tender/ui, cpStats=1:
// пять подрядчиков в пяти тендерах (состав — в seed.js у cpStats).
//   • участники и файлы КП грузятся при первом открытии подвкладки, не раньше;
//   • КП отправлено — статус «КП предоставлено» или файл КП; победы — tender_winners, иначе основной победитель;
//   • карточки итогов, воронка, разрез по подразделениям (по видам работ), вид работ в строке;
//   • фильтры: подразделение, сумма договоров (готовые диапазоны и свой), отдел, поиск, кого показывать; сортировка;
//   • без колонки подразделения у видов работ — фильтр недоступен; без таблицы tender_winners — основной победитель.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const plain = (s) => s.replace(/[\u00A0\u202F]/g, ' ')

describe('Отчёты: подрядчики', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open(extra = '', viewport = { width: 1600, height: 1000 }) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    await page.goto(`${stand.url}?route=/reports&cpStats=1&latency=10${extra}`)
    await page.locator('.reports-tabs').waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }

  const participantRequests = (page) => page.evaluate(() => window.__supabaseStats.requests
    .filter((r) => r.table === 'tender_counterparties' || r.table === 'tender_proposal_files').length)
  const openTab = async (page) => {
    await page.locator('.reports-subtab', { hasText: 'Подрядчики' }).click()
    await page.locator('.cs-table').waitFor({ timeout: 60000 })
  }
  const kpi = async (page, label) => plain(await page.locator('.cs-kpi-card', { has: page.locator(`.kpi-label:text-is("${label}")`) })
    .locator('.cs-kpi-value').innerText())
  const names = (page) => page.locator('.cs-table tbody .cs-name-text').allInnerTexts()
  const rowCells = async (page, name) => (await page.locator('.cs-table tbody tr', { has: page.locator(`.cs-name-text:text-is("${name}")`) })
    .locator('td').allInnerTexts()).map(plain)
  const select = (page, key) => page.locator('.rf-chip', { has: page.locator(`.rf-chip-key:text-is("${key}")`) }).locator('select')

  it('вкладка переименована, грузит данные при открытии; карточки, воронка, строки', async () => {
    const { page, errors, close } = await open()
    try {
      const subs = await page.locator('.reports-subtab').evaluateAll((els) => els.map((e) => e.childNodes[0].textContent))
      assert.ok(subs.includes('Подрядчики'), subs.join(', '))
      assert.ok(!subs.includes('Победители'))
      await page.locator('.dept-table').waitFor()
      assert.equal(await participantRequests(page), 0, 'до открытия подвкладки участники не грузятся')

      await openTab(page)
      assert.equal(await kpi(page, 'Подрядчиков'), '5')
      assert.equal(await kpi(page, 'Отправлено КП'), '5', 'КП — по статусу или файлу; вложение — не КП')
      assert.match(plain(await page.locator('.cs-kpi-card', { hasText: 'Отправлено КП' }).locator('.kpi-foot').innerText()),
        /ответ на 50 % приглашений · файлов: 3/)
      assert.equal(await kpi(page, 'Тендеров с победителем'), '3')
      assert.match(await page.locator('.cs-kpi-card', { hasText: 'Тендеров с победителем' }).locator('.kpi-foot').innerText(),
        /завершённых · побед: 4 — у части тендеров несколько победителей/)
      assert.equal(await kpi(page, 'Уникальных победителей'), '2')
      assert.equal(await kpi(page, 'КП → победа'), '80 %')
      assert.equal(await kpi(page, 'Сумма договоров'), '≈ 38,5 млн ₽')
      assert.match(plain(await page.locator('.cs-kpi-card', { hasText: 'Сумма договоров' }).locator('.kpi-foot').innerText()),
        /заключённых: 2 договора и ДС у 2 подрядчиков/)

      const funnel = (await page.locator('.cs-funnel li').allInnerTexts()).map((t) => plain(t).replace(/\s+/g, ' ').trim())
      assert.deepEqual(funnel, ['Участие в тендерах 10', 'Отправлено КП 5 50 %', 'Отказались 3 30 %', 'Побед 4 40 %'])

      // Рейтинг: победы, затем сумма договоров; дальше — КП и название.
      assert.deepEqual(await names(page), ['Подрядчик 01', 'Подрядчик 02', 'Подрядчик 03', 'Подрядчик 04', 'Подрядчик 05'])
      const first = await rowCells(page, 'Подрядчик 01')
      assert.match(first[1], /Монолитные работы/)
      assert.match(first[1], /Монолит/, 'плашка подразделения')
      assert.match(first[2], /^4\s+отказ: 1$/)
      assert.match(first[3], /^3\s+75 % ответов$/)
      assert.match(first[4], /^2\s+стр\. 2 · гар\. 0$/)
      assert.equal(first[5], '100 %')
      assert.match(first[6], /^1\s+из 2$/)
      assert.equal(first[7], '30 000 000 ₽')
      const second = await rowCells(page, 'Подрядчик 02')
      assert.match(second[4], /^2\s+стр\. 1 · гар\. 1$/, 'второй победитель tender-10 и гарантийный тендер')
      assert.equal(second[7], '≈ 8 500 000 ₽')
      assert.equal((await rowCells(page, 'Подрядчик 04'))[5], '—', 'без завершённых тендеров % побед нет')
      assert.equal(await page.locator('.cs-rank--1').count(), 1)

      // Разрез по подразделениям: подрядчик — в подразделении своих видов работ, «Клининг» — «Не указано».
      const divRow = async (label) => (await page.locator('.cs-div-row', { has: page.locator(`td:first-child:text-is("${label}")`) })
        .locator('td').allInnerTexts()).map(plain)
      assert.deepEqual(await divRow('Монолит'), ['Монолит', '1', '3', '2', '30 млн ₽'])
      assert.deepEqual(await divRow('НВФ/СПК'), ['НВФ/СПК', '2', '1', '2', '≈ 8,5 млн ₽'])
      assert.deepEqual(await divRow('ЭОМ/СС'), ['ЭОМ/СС', '1', '—', '—', '—'])
      assert.deepEqual(await divRow('Не указано'), ['Не указано', '1', '1', '—', '—'])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('фильтры: подразделение, сумма, отдел, поиск, кого показывать; сортировка', async () => {
    const { page, errors, close } = await open()
    try {
      await openTab(page)

      // Строка разреза включает и снимает фильтр подразделения.
      await page.locator('.cs-div-row', { hasText: 'НВФ/СПК' }).click()
      assert.equal(await select(page, 'Подразделение:').inputValue(), 'nvf_spk')
      assert.deepEqual(await names(page), ['Подрядчик 02', 'Подрядчик 05'])
      assert.equal(await kpi(page, 'Подрядчиков'), '2')
      await page.locator('.cs-div-row', { hasText: 'НВФ/СПК' }).click()
      assert.equal((await names(page)).length, 5)

      await select(page, 'Сумма договоров:').selectOption('10-50')
      assert.deepEqual(await names(page), ['Подрядчик 01'])
      await select(page, 'Сумма договоров:').selectOption('none')
      assert.deepEqual(await names(page), ['Подрядчик 03', 'Подрядчик 04', 'Подрядчик 05'])
      await select(page, 'Сумма договоров:').selectOption('custom')
      await page.getByLabel('Сумма от, млн ₽').fill('5')
      await page.getByLabel('Сумма до, млн ₽').fill('10')
      assert.deepEqual(await names(page), ['Подрядчик 02'])
      await page.locator('.rf-reset').click()
      assert.equal((await names(page)).length, 5)

      await select(page, 'Отдел:').selectOption('warranty_service')
      assert.deepEqual(await names(page), ['Подрядчик 02'])
      assert.match((await rowCells(page, 'Подрядчик 02'))[4], /^1\s+стр\. 0 · гар\. 1$/)
      await select(page, 'Отдел:').selectOption('all')

      await page.locator('.cs-search input').fill('клининг')
      assert.deepEqual(await names(page), ['Подрядчик 03'], 'поиск — и по виду работ')
      await page.locator('.cs-search input').fill('')

      await page.locator('.cs-show-btn', { hasText: 'Победители' }).click()
      assert.deepEqual(await names(page), ['Подрядчик 01', 'Подрядчик 02'])
      await page.locator('.cs-show-btn', { hasText: 'Прислали КП' }).click()
      assert.deepEqual(await names(page), ['Подрядчик 01', 'Подрядчик 02', 'Подрядчик 03'])
      await page.locator('.cs-show-btn', { hasText: 'Все участники' }).click()

      await page.locator('.cs-sort', { hasText: 'Подрядчик' }).click()
      assert.deepEqual(await names(page), ['Подрядчик 01', 'Подрядчик 02', 'Подрядчик 03', 'Подрядчик 04', 'Подрядчик 05'])
      await page.locator('.cs-sort', { hasText: 'Подрядчик' }).click()
      assert.deepEqual(await names(page), ['Подрядчик 05', 'Подрядчик 04', 'Подрядчик 03', 'Подрядчик 02', 'Подрядчик 01'])
      await page.locator('.cs-sort', { hasText: 'Сумма' }).click()
      assert.deepEqual((await names(page)).slice(0, 2), ['Подрядчик 01', 'Подрядчик 02'])
      assert.equal(await page.locator('.cs-rank--1').count(), 0, 'медали — только у рейтинга по победам')

      // Переключение подвкладок не перечитывает участников и не сбрасывает сортировку.
      const loaded = await participantRequests(page)
      await page.locator('.reports-subtab', { hasText: 'Обзор' }).click()
      await page.locator('.reports-subtab', { hasText: 'Подрядчики' }).click()
      assert.equal(await participantRequests(page), loaded)
      assert.match((await page.locator('.cs-sort.is-active').innerText()).toLowerCase(), /^сумма\s*↓$/)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('без подразделений у видов работ и без таблицы победителей', async () => {
    const { page, errors, close } = await open('&cpDivisions=legacy&cpStatsNoWinners=1')
    try {
      await openTab(page)
      assert.equal(await select(page, 'Подразделение:').isDisabled(), true)
      assert.match(await page.locator('.cs-divisions').innerText(), /миграция 20261115/)
      assert.equal(await page.locator('.cs-divs').count(), 0)
      // Победитель tender-10 — только основной (cp-1).
      assert.match((await rowCells(page, 'Подрядчик 02'))[4], /^1\s+стр\. 0 · гар\. 1$/)
      assert.equal(await kpi(page, 'Уникальных победителей'), '2')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('телефон: таблица прокручивается в своём блоке, страница — нет', async () => {
    const { page, errors, close } = await open('', { width: 390, height: 844 })
    try {
      await openTab(page)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert.ok(overflow <= 1, `страница шире окна на ${overflow}px`)
      const wrap = await page.locator('.cs-table-wrap').last().evaluate((el) => el.scrollWidth > el.clientWidth)
      assert.equal(wrap, true)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
