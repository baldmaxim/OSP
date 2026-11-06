// Реестр контрагентов (/general/counterparties), решение пользователя 05.11.2026:
//   • у контрагента постоянный номер: фильтры, поиск и вкладки его не меняют, в выгрузке и карточке тот же;
//   • фильтр «С регистрацией» — как «С договором»: кнопка с числом и отметка в строке; функции в базе нет — ни кнопки, ни столбца;
//   • фильтры работают вместе: список сужается всеми сразу, число на кнопке и в списке подразделений — сколько строк будет после
//     нажатия при всех остальных, в списке видов работ — только те, с которыми что-то останется, ничего не осталось — «Сбросить фильтры»;
//   • отмеченные строки, скрытые фильтром, не теряются молча: «скрыто фильтрами: N».
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chromium } from 'playwright'
import * as XLSX from 'xlsx'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  compareByNumber, compareCounterparties, counterpartyFacets, counterpartyNumbers, counterpartyTab, filterCounterparties, isMissingSiteAccounts,
} from '../../src/utils/counterpartyFilters.js'
import { counterpartySearchIndex, searchCounterparties } from '../../src/utils/counterpartySearch.js'

// Тот же состав, что на стенде (tests/tender/ui/seed.js, cpFilters=1).
const LIST = [
  { id: 'a', name: 'Альфа', work_type: 'Монолит, Кровля', counterparty_number: 100 },
  { id: 'b', name: 'Бета', work_type: 'Монолит', counterparty_number: 97 },
  { id: 'c', name: 'Вега', work_type: 'Монолит', counterparty_number: 94 },
  { id: 'd', name: 'Гамма', work_type: 'Фасад', counterparty_number: 91 },
  { id: 'e', name: 'Дельта', work_type: 'Фасад', counterparty_number: 88 },
  { id: 'f', name: 'Ёлка', work_type: 'Клининг', counterparty_number: 85 },
  { id: 'g', name: 'Жара', work_type: 'Кровля', status: 'blacklist', counterparty_number: 82 },
  { id: 'h', name: 'Зима', work_type: 'Фасад', deleted_at: '2026-10-01', counterparty_number: 79 },
]
const contractCounts = new Map(['a', 'b', 'd', 'f', 'g', 'h'].map((id) => [id, 1]))
const siteAccounts = new Map([['a', 2], ['c', 1], ['d', 1], ['g', 1], ['h', 1]])
const divisionsById = new Map(LIST.map((c) => [c.id, c.work_type.includes('Монолит') || c.id === 'f' ? ['monolith'] : []]))
const base = { tab: 'active', workType: '', divisions: [], divisionsById, contractCounts, siteAccounts, onlyContract: false, onlySite: false }
const ids = (items) => items.map((c) => c.id).join('')
const INDEX = new Map(LIST.map((c) => [c.id, counterpartySearchIndex(c, c.counterparty_number)]))
const noSearch = (items) => items
const searching = (query) => (items) => searchCounterparties(items, query, (c) => INDEX.get(c.id)).items

describe('Реестр контрагентов: правила номера и фильтров', () => {
  it('постоянный номер: из базы; пока колонки нет — по всему реестру, порядком миграции, а не по выборке', () => {
    assert.deepEqual([...counterpartyNumbers(LIST)].slice(0, 2), [['a', 100], ['b', 97]])
    const legacy = [
      { id: '3', name: 'Удалённая', deleted_at: '2026-01-01' }, { id: '4', name: 'Я из чёрного списка', status: 'blacklist' },
      { id: '1', name: 'Бета' }, { id: '2', name: 'альфа' },
    ]
    assert.deepEqual([...counterpartyNumbers(legacy)], [['2', 1], ['1', 2], ['4', 3], ['3', 4]])
    assert.deepEqual([...legacy].sort(compareCounterparties).map((c) => c.id), ['2', '1', '4', '3'])
    assert.deepEqual([...counterpartyNumbers(null)], [])
  })

  it('строки — по «№» от меньшего к большему, не по названию; номера без колонки — порядком названий, те же строки', () => {
    const order = (items) => [...items].sort(compareByNumber(counterpartyNumbers(items))).map((c) => c.id).join('')
    assert.equal(order(LIST), 'hgfedcba')
    const legacy = [{ id: '3', name: 'Удалённая', deleted_at: '2026-01-01' }, { id: '1', name: 'Бета' }, { id: '2', name: 'альфа' }]
    assert.equal(order(legacy), '213')
  })

  it('вкладка: удаление важнее статуса', () => {
    assert.equal(counterpartyTab({}), 'active')
    assert.equal(counterpartyTab({ status: 'limited' }), 'active')
    assert.equal(counterpartyTab({ status: 'blacklist' }), 'blacklist')
    assert.equal(counterpartyTab({ status: 'blacklist', deleted_at: 'x' }), 'deleted')
  })

  it('функции ещё нет — не ошибка, отказ сервера — ошибка', () => {
    assert.ok(isMissingSiteAccounts({ code: 'PGRST202' }))
    assert.ok(isMissingSiteAccounts({ code: '42883' }))
    assert.ok(isMissingSiteAccounts({ status: 404 }))
    assert.ok(isMissingSiteAccounts({ message: 'function public.counterparty_site_accounts() does not exist' }))
    assert.ok(!isMissingSiteAccounts({ code: '57014', message: 'timeout' }))
    assert.ok(!isMissingSiteAccounts(null))
  })

  it('фильтры сужают один список все вместе, в любом порядке', () => {
    const run = (over) => ids(filterCounterparties(LIST, { ...base, ...over }))
    assert.equal(run({}), 'abcdef')
    assert.equal(run({ onlyContract: true }), 'abdf')
    assert.equal(run({ onlySite: true }), 'acd')
    assert.equal(run({ onlyContract: true, onlySite: true }), 'ad')
    assert.equal(run({ workType: 'Монолит' }), 'abc')
    assert.equal(run({ workType: 'Монолит', onlySite: true }), 'ac')
    assert.equal(run({ workType: 'Монолит', onlySite: true, onlyContract: true }), 'a')
    assert.equal(run({ divisions: ['monolith'] }), 'abcf')
    assert.equal(run({ divisions: ['monolith'], onlyContract: true }), 'abf')
    assert.equal(run({ divisions: ['monolith'], onlyContract: true, onlySite: true }), 'a')
    assert.equal(run({ workType: 'Фасад', divisions: ['monolith'] }), '')
    assert.equal(run({ tab: 'blacklist', onlySite: true }), 'g')
    assert.equal(run({ tab: 'deleted', onlyContract: true, onlySite: true }), 'h')
    assert.equal(run({ tab: 'deleted', workType: 'Монолит' }), '')
  })

  it('кнопки: данные не загрузились — фильтр не прячет список и числа нет', () => {
    assert.equal(ids(filterCounterparties(LIST, { ...base, contractCounts: null, onlyContract: true })), '', 'страница включает onlyContract только при загруженных данных')
    const facets = counterpartyFacets(LIST, { ...base, contractCounts: null, siteAccounts: null }, noSearch)
    assert.equal(facets.contract, null)
    assert.equal(facets.site, null)
  })

  it('число на кнопке — сколько строк будет после нажатия при всех остальных фильтрах и поиске', () => {
    const facets = (over, search = noSearch) => counterpartyFacets(LIST, { ...base, ...over }, search)
    assert.deepEqual([facets({}).contract, facets({}).site], [4, 3])
    assert.deepEqual([facets({ onlySite: true }).contract, facets({ onlySite: true }).site], [2, 3], 'включённая кнопка считает сама себя')
    assert.deepEqual([facets({ workType: 'Монолит' }).contract, facets({ workType: 'Монолит' }).site], [2, 2])
    assert.deepEqual([facets({ tab: 'blacklist' }).contract, facets({ tab: 'blacklist' }).site], [1, 1])
    const found = facets({}, searching('гамма'))
    assert.deepEqual([found.contract, found.site], [1, 1], 'и с поиском')
    // Нажатие даёт ровно это число: сверяем на каждом сочетании.
    for (const over of [{}, { onlySite: true }, { onlyContract: true }, { workType: 'Фасад' }, { divisions: ['monolith'] }, { tab: 'blacklist' }, { tab: 'deleted', workType: 'Фасад' }]) {
      for (const search of [noSearch, searching('а'), searching('гамма')]) {
        const f = { ...base, ...over }
        assert.equal(facets(over, search).contract, search(filterCounterparties(LIST, { ...f, onlyContract: true })).length)
        assert.equal(facets(over, search).site, search(filterCounterparties(LIST, { ...f, onlySite: true })).length)
      }
    }
  })

  it('виды работ и подразделения предлагают только то, что останется', () => {
    const facets = (over, search = noSearch) => counterpartyFacets(LIST, { ...base, ...over }, search)
    assert.deepEqual(facets({}).workTypes, ['Клининг', 'Кровля', 'Монолит', 'Фасад'])
    assert.deepEqual(facets({ onlySite: true }).workTypes, ['Кровля', 'Монолит', 'Фасад'], 'у зарегистрированных клининга нет')
    assert.deepEqual(facets({ divisions: ['monolith'] }).workTypes, ['Клининг', 'Кровля', 'Монолит'], 'подразделение и по договору: клининг остаётся')
    assert.deepEqual(facets({ workType: 'Фасад' }).workTypes, ['Клининг', 'Кровля', 'Монолит', 'Фасад'], 'свой фильтр не сужает собственный список')
    assert.deepEqual(facets({}, searching('гамма')).workTypes, ['Фасад'], 'и с поиском')
    assert.equal(ids(facets({ onlySite: true, divisions: ['monolith'] }).divisionItems), 'acd', 'счётчики подразделений — без своего фильтра')
  })

  it('поиск по номеру: «№ 97» — ровно он, «97» — он первым и совпадения в других полях', () => {
    const list = [{ id: 'x', name: 'ООО 97 Метров', counterparty_number: 5 }, ...LIST]
    const index = new Map(list.map((c) => [c.id, counterpartySearchIndex(c, c.counterparty_number)]))
    const find = (q) => ids(searchCounterparties(list, q, (c) => index.get(c.id)).items)
    assert.equal(find('№ 97'), 'b')
    assert.equal(find('№97'), 'b')
    assert.equal(find('97'), 'bx')
    assert.equal(find('№ 12345'), '')
    // Без номера в указателе поиск работает как раньше.
    assert.equal(ids(searchCounterparties(list, '97', (c) => counterpartySearchIndex(c)).items), 'x')
  })
})

const launch = browserLaunchOptions()
const BASE = 'route=/general/counterparties&cps=8&cpDivisions=1&cpFilters=1&items=20&latency=0'
const NUMBERS = {
  'Подрядчик 01': '100', 'Подрядчик 02': '97', 'Подрядчик 03': '94', 'Подрядчик 04': '91',
  'Подрядчик 05': '88', 'Подрядчик 06': '85', 'Подрядчик 07': '82', 'Подрядчик 08': '79',
}

describe('Реестр контрагентов: страница', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 600000 }, () => {
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

  async function open(query = '', viewport = { width: 1440, height: 900 }) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport, acceptDownloads: true })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
    page.on('dialog', (d) => d.accept())
    await page.goto(`${stand.url}?${BASE}${query}`)
    await page.locator('table.compact-table tbody tr.table-row, .cp-mrow').first().waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const rows = (page) => page.locator('table.compact-table tbody tr.table-row')
  // { название: номер } по строкам таблицы.
  const shown = (page) => rows(page).evaluateAll((trs) => Object.fromEntries(trs.map((tr) => [
    tr.querySelector('.company-name').textContent.trim(), tr.querySelector('td.col-num').textContent.trim(),
  ])))
  const names = async (page) => Object.keys(await shown(page))
  const button = (page, name) => page.getByRole('button', { name })
  const contractBtn = (page) => button(page, /С договором/)
  const siteBtn = (page) => button(page, /С регистрацией/)
  const waitLoaded = async (page) => {
    await page.waitForFunction(() => [...document.querySelectorAll('button.cp-contract-filter')].every((b) => !b.disabled))
  }
  const waitNames = (page, expected) => page.waitForFunction((list) => {
    const got = [...document.querySelectorAll('table.compact-table tbody tr.table-row .company-name')].map((e) => e.textContent.trim())
    return JSON.stringify(got) === JSON.stringify(list)
  }, expected, { timeout: 15000 })
  // Названия в порядке строк: на стенде номера убывают вместе с названием (100, 97, …), строки идут по «№» от меньшего к большему.
  const p = (...n) => [...n].sort((x, y) => y - x).map((i) => `Подрядчик 0${i}`)
  // Колонки номера нет: номера считаются порядком названий, и строки идут так же.
  const byName = (...n) => n.map((i) => `Подрядчик 0${i}`)

  it('номер закреплён: фильтры, поиск и вкладки его не меняют, новый столбец — не по порядку строк', async () => {
    const { page, errors, close } = await open()
    try {
      await waitLoaded(page)
      const check = async () => {
        for (const [name, no] of Object.entries(await shown(page))) assert.equal(no, NUMBERS[name], name)
      }
      await check()
      assert.deepEqual(await names(page), p(6, 5, 4, 3, 2, 1), 'по № от меньшего к большему')
      await contractBtn(page).click()
      await waitNames(page, p(6, 4, 2, 1))
      await check()
      await siteBtn(page).click()
      await waitNames(page, p(4, 1))
      await check()
      await page.getByPlaceholder('Поиск...').fill('Подрядчик 04')
      await waitNames(page, p(4))
      await check()
      await page.getByPlaceholder('Поиск...').fill('')
      await contractBtn(page).click()
      await siteBtn(page).click()
      await waitNames(page, p(6, 5, 4, 3, 2, 1))
      await button(page, /Чёрный список/).click()
      await waitNames(page, p(7))
      await check()
      await button(page, /Удалённые/).click()
      await waitNames(page, p(8))
      await check()
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('узкое окно с развёрнутым меню: столбцы не сжимаются и не наезжают друг на друга, прокручивается таблица, кнопки не закрывают фильтры', async () => {
    for (const width of [1280, 1366, 1536]) {
      const { page, errors, close } = await open('&shell=1&sidebar=1', { width, height: 800 })
      try {
        await waitLoaded(page)
        const table = page.locator('table.cp-registry-table')
        await table.locator('.worktype-tag').first().waitFor()
        await page.locator('.layout .sidebar, aside').first().waitFor()
        const got = await table.evaluate((t) => {
          const crossing = []
          const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
          for (const cell of t.querySelectorAll('th, td')) {
            const box = cell.getBoundingClientRect()
            // Текст подписи: у ячейки, которая клипует содержимое, вылезти за край он не может, в шапке — может.
            const range = document.createRange()
            range.selectNodeContents(cell)
            const r = range.getBoundingClientRect()
            if (r.width && cell.tagName === 'TH' && (r.right > box.right + 1 || r.left < box.left - 1)) crossing.push(cell.className)
          }
          const wrap = t.closest('.table-wrapper')
          return {
            crossing,
            work: t.querySelector('th.col-worktype').getBoundingClientRect().width / rem,
            scrolls: wrap.scrollWidth > wrap.clientWidth,
            wrapScroll: getComputedStyle(wrap).overflowX,
            page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          }
        })
        assert.deepEqual(got.crossing, [], `подписи за краем столбца при ${width}`)
        assert.ok(got.work >= 9.5, `«Вид работ» не уже 9,5rem при ${width}: ${got.work}`)
        assert.ok(got.scrolls && got.wrapScroll === 'auto', `таблица прокручивается в своём блоке при ${width}`)
        assert.equal(got.page, 0, 'страница целиком не прокручивается вбок')
        // Слово не рвётся по буквам: высота плашки с двумя короткими словами — не больше двух строк.
        const tagLines = await table.locator('.worktype-tag').first().evaluate((el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight))
        assert.ok(tagLines < 3, `строк в плашке вида работ: ${tagLines}`)
        // Панель над таблицей: фильтры и кнопки не пересекаются.
        const overlaps = await page.locator('.counterparties-toolbar').evaluate((bar) => {
          const rect = (el) => el.getBoundingClientRect()
          const filters = [...bar.querySelectorAll('.toolbar-center > *')].map(rect)
          const actions = [...bar.querySelectorAll('.toolbar-actions > *')].map(rect)
          return filters.flatMap((f) => actions.filter((a) => f.left < a.right && a.left < f.right && f.top < a.bottom && a.top < f.bottom)).length
        })
        assert.equal(overlaps, 0, `кнопки закрывают фильтры при ${width}`)
        assert.deepEqual(errors, [])
      } finally {
        await close()
      }
    }
  })

  it('шапка и столбец №: большой номер виден целиком, подписи стоят над значениями, разделители не пропадают при прокрутке', async () => {
    const { page, errors, close } = await open('&cpBigNumbers=1', { width: 1280, height: 800 })
    try {
      const cells = await rows(page).locator('td.col-num').evaluateAll((tds) => tds.map((td) => ({ text: td.textContent.trim(), fits: td.scrollWidth <= td.clientWidth })))
      assert.ok(cells.some((c) => c.text === '1936') && cells.some((c) => c.text.length === 5), JSON.stringify(cells))
      for (const c of cells) assert.ok(c.fits, `номер ${c.text} обрезан`)

      const style = (sel, prop) => page.locator(sel).first().evaluate((el, p) => getComputedStyle(el)[p], prop)
      // Подпись слева от значения на том же поле, по центру — там, где значения по центру.
      assert.equal(await style('thead th.col-name', 'paddingLeft'), await style('tbody td.col-name', 'paddingLeft'))
      assert.equal(await style('thead th.col-inn', 'paddingLeft'), await style('tbody td.col-inn', 'paddingLeft'))
      for (const col of ['col-num', 'col-contract', 'col-site-account', 'col-website', 'col-actions']) {
        assert.equal(await style(`thead th.${col}`, 'textAlign'), 'center', col)
      }
      // У слитых границ шапка при прокрутке теряет черту и разделители.
      assert.equal(await style('table.compact-table', 'borderCollapse'), 'separate')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('колонки номера ещё нет: номер считается по всему реестру и при фильтре тоже не меняется', async () => {
    const { page, errors, close } = await open('&cpNoNumbers=1')
    try {
      await waitLoaded(page)
      const before = await shown(page)
      assert.deepEqual(Object.values(before), ['1', '2', '3', '4', '5', '6'])
      await contractBtn(page).click()
      await waitNames(page, byName(1, 2, 4, 6))
      const after = await shown(page)
      for (const name of Object.keys(after)) assert.equal(after[name], before[name], name)
      // Чёрный список и удалённые считаются после действующих — номера те же, что без фильтра.
      await button(page, /Чёрный список/).click()
      await waitNames(page, p(7))
      assert.deepEqual(await shown(page), { 'Подрядчик 07': '7' })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('«С регистрацией»: число, отметка в строке, фильтр; подсказка без почты и ФИО', async () => {
    const { page, errors, close } = await open()
    try {
      await waitLoaded(page)
      assert.match(await siteBtn(page).innerText(), /С регистрацией\s*3/)
      const mark = (name) => rows(page).filter({ hasText: name }).locator('td.col-site-account .cp-contract-mark')
      assert.equal(await mark('Подрядчик 01').innerText(), '2', 'две учётки — число')
      assert.equal(await mark('Подрядчик 03').count(), 1)
      assert.equal(await mark('Подрядчик 02').count(), 0)
      assert.match(await mark('Подрядчик 01').getAttribute('title'), /регистрация на сайте/)
      await siteBtn(page).click()
      assert.equal(await siteBtn(page).getAttribute('aria-pressed'), 'true')
      await waitNames(page, p(1, 3, 4))
      await siteBtn(page).click()
      await waitNames(page, p(1, 2, 3, 4, 5, 6))
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('фильтры вместе: кнопки, вид работ, подразделение и поиск; числа пересчитываются; ничего не осталось — сброс', async () => {
    const { page, errors, close } = await open()
    try {
      await waitLoaded(page)
      const counts = async () => [await contractBtn(page).innerText(), await siteBtn(page).innerText()].map((t) => Number(t.replace(/\D/g, '')))
      assert.deepEqual(await counts(), [4, 3])
      assert.equal((await page.locator('.counter-badge').first().innerText()).trim(), '6')

      await siteBtn(page).click()
      await waitNames(page, p(1, 3, 4))
      assert.deepEqual(await counts(), [2, 3], 'на «С договором» — сколько будет вместе с регистрацией')
      await contractBtn(page).click()
      await waitNames(page, p(1, 4))
      assert.deepEqual(await counts(), [2, 2])
      assert.equal((await page.locator('.counter-badge').first().innerText()).trim(), '2')

      // Список видов работ — только те, с которыми что-то останется.
      const wt = page.locator('.wt-filter-input')
      await wt.focus()
      const options = await page.locator('.wt-filter-dropdown .wt-filter-item').allInnerTexts()
      assert.deepEqual(options, ['Все виды работ', 'Кровельные работы', 'Монолитные работы', 'Фасадные работы'])
      await page.locator('.wt-filter-dropdown .wt-filter-item', { hasText: 'Монолитные работы' }).click()
      await waitNames(page, p(1))
      assert.deepEqual(await counts(), [1, 1])

      // Подразделение: подпись со счётчиком — при всех остальных фильтрах.
      await page.locator('th.col-worktype .fdrop-trigger').click()
      const divs = await page.locator('.fdrop-panel .fdrop-option-text').allTextContents()
      assert.ok(divs.includes('Монолит (1)'), divs.join(', '))
      await page.locator('.fdrop-panel .fdrop-option', { hasText: 'Монолит' }).first().click()
      await page.keyboard.press('Escape')
      await waitNames(page, p(1))

      // Ничего не осталось: поиск вместе со всем остальным; «Нет контрагентов» и «Добавить» не показываем.
      await page.getByPlaceholder('Поиск...').fill('ЯЯЯЯЯЯЯЯ')
      await page.getByText('Ничего не найдено').waitFor()
      assert.deepEqual(await counts(), [0, 0])
      assert.equal(await page.getByText('Нет контрагентов').count(), 0)
      await page.getByRole('button', { name: 'Сбросить фильтры' }).click()
      await waitNames(page, p(1, 2, 3, 4, 5, 6))
      assert.deepEqual(await counts(), [4, 3])
      assert.equal(await page.getByPlaceholder('Поиск...').inputValue(), '')
      assert.equal(await siteBtn(page).getAttribute('aria-pressed'), 'false')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('только подразделение без строк — тоже «Ничего не найдено» и сброс; вкладки считают свои числа', async () => {
    const { page, errors, close } = await open()
    try {
      await waitLoaded(page)
      await page.locator('th.col-worktype .fdrop-trigger').click()
      await page.locator('.fdrop-panel .fdrop-option', { hasText: 'НВФ' }).first().click()
      await page.keyboard.press('Escape')
      await waitNames(page, p(4, 5))
      await button(page, /Чёрный список/).click()
      await page.getByText('Ничего не найдено').waitFor()
      assert.equal(await page.getByText('Нет контрагентов').count(), 0, 'фильтр подразделения раньше сюда не входил')
      await page.getByRole('button', { name: 'Сбросить фильтры' }).click()
      await waitNames(page, p(7))
      assert.match(await contractBtn(page).innerText(), /С договором\s*1/)
      assert.match(await siteBtn(page).innerText(), /С регистрацией\s*1/)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('поиск по номеру; отмеченные, скрытые фильтром, — на виду', async () => {
    const { page, errors, close } = await open()
    try {
      await waitLoaded(page)
      await page.getByPlaceholder('Поиск...').fill('№ 97')
      await waitNames(page, p(2))
      await page.getByPlaceholder('Поиск...').fill('')
      await waitNames(page, p(1, 2, 3, 4, 5, 6))

      await rows(page).filter({ hasText: 'Подрядчик 02' }).locator('input[type=checkbox]').check()
      await rows(page).filter({ hasText: 'Подрядчик 04' }).locator('input[type=checkbox]').check()
      assert.equal(await page.locator('.cp-selection-hidden').count(), 0)
      await siteBtn(page).click()
      await waitNames(page, p(1, 3, 4))
      assert.match(await page.locator('.toolbar-selection').innerText(), /Выбрано: 2.*скрыто фильтрами: 1/s)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('функции в базе нет — ни кнопки, ни столбца; отказ сервера — кнопка недоступна, реестр работает', async () => {
    const missing = await open('&cpSiteRpc=missing')
    try {
      await waitLoaded(missing.page)
      await contractBtn(missing.page).waitFor()
      assert.equal(await siteBtn(missing.page).count(), 0)
      assert.equal(await missing.page.locator('th.col-site-account').count(), 0)
      assert.deepEqual(await names(missing.page), p(1, 2, 3, 4, 5, 6))
      assert.deepEqual(missing.errors, [])
    } finally {
      await missing.close()
    }
    const failed = await open('&cpSiteRpc=error')
    try {
      await failed.page.waitForFunction(() => {
        const b = [...document.querySelectorAll('button.cp-contract-filter')].find((x) => /регистрацией/.test(x.textContent))
        return b && b.disabled && /не загрузились/.test(b.title)
      })
      await contractBtn(failed.page).click()
      await waitNames(failed.page, p(1, 2, 4, 6))
      assert.deepEqual(failed.errors, [])
    } finally {
      await failed.close()
    }
  })

  it('выгрузка в Excel — те же постоянные номера и только то, что в списке; карточка показывает номер', async () => {
    const { page, errors, close } = await open()
    try {
      await waitLoaded(page)
      await siteBtn(page).click()
      await waitNames(page, p(1, 3, 4))
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Экспорт/ }).click()])
      const book = XLSX.read(fs.readFileSync(await download.path()))
      const table = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1 })
      const start = table.findIndex((r) => r[0] === '№')
      assert.ok(start >= 0, 'заголовок «№»')
      assert.deepEqual(table.slice(start + 1).filter((r) => r[1]).map((r) => [r[0], r[1]]), [[91, 'Подрядчик 04'], [94, 'Подрядчик 03'], [100, 'Подрядчик 01']], 'в том же порядке, что на экране')

      await rows(page).filter({ hasText: 'Подрядчик 03' }).locator('.company-name').click()
      await page.locator('.cp-detail-title', { hasText: '№ 94' }).waitFor()
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('телефон: номер в строке, обе кнопки на экране, таблица не вылезает за край', async () => {
    const { page, errors, close } = await open('', { width: 375, height: 760 })
    try {
      await page.waitForFunction(() => [...document.querySelectorAll('button.cp-contract-filter')].every((b) => !b.disabled))
      assert.match(await page.locator('.cp-mrow', { hasText: 'Подрядчик 03' }).locator('.cp-mrow-no').innerText(), /№ 94/)
      const width = await page.evaluate(() => document.documentElement.scrollWidth)
      assert.ok(width <= 375, `шире экрана: ${width}`)
      for (const b of [contractBtn(page), siteBtn(page)]) {
        const box = await b.boundingBox()
        assert.ok(box.x >= 0 && box.x + box.width <= 375, `кнопка за краем: ${JSON.stringify(box)}`)
        assert.ok(await b.evaluate((el) => el.scrollWidth <= el.clientWidth), 'подпись кнопки помещается')
      }
      // Две кнопки не сжимают поля: поиск и вид работ остаются пригодными для ввода.
      for (const field of [page.locator('.search-container'), page.locator('.wt-filter-wrap')]) {
        const box = await field.boundingBox()
        assert.ok(box.width >= 130, `поле сжато: ${box.width}px`)
      }
      await page.locator('.cp-mrow', { hasText: 'Подрядчик 01' }).locator('.cp-contract-mark').nth(1).waitFor()
      await siteBtn(page).click()
      await page.waitForFunction(() => document.querySelectorAll('.cp-mrow').length === 3)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
