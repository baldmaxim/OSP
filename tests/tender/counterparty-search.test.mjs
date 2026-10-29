// Поиск в реестре контрагентов (/general/counterparties), utils/counterpartySearch.js. 29.10.2026: «проматомстрой»
// не находил «ООО Пром Атом Строй (ПАС)» — поиск искал набранное буквально, с пробелами.
//   • регистр, ё / е, й / и, пробелы, кавычки, дефисы и скобки не важны; латиница, похожая на кириллицу, — кириллица;
//   • слова запроса — в любом порядке и в любых полях; телефон — цифрами, с 8 или 7 в начале;
//   • ничего не нашлось — другая раскладка, затем опечатки (в названии и ФИО контактов); над списком — чем заменён запрос;
//   • поиск — внутри вкладки и фильтров, как раньше.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { counterpartySearchIndex, searchCounterparties, searchKey, switchLayout, typoDistance } from '../../src/utils/counterpartySearch.js'

const launch = browserLaunchOptions()
const BASE = 'route=/general/counterparties&cps=8&cpContacts=1&cpSearch=1&items=20&latency=0'

const LIST = [
  { id: 1, name: 'ООО Пром Атом Строй (ПАС)', work_type: 'Монолит', inn: '7701234567',
    counterparty_contacts: [{ full_name: 'Сапаров Ержан Болатович', phone: '8 (910) 461-45-71; +7(925)342-24-56 доб. 12', email: 'pas@example.invalid' }] },
  { id: 2, name: 'ПромАтомСтрой', work_type: 'Фасадные работы' },
  { id: 3, name: 'ООО "Альпинист-эксперт"', work_type: 'Альпинисты' },
  { id: 4, name: 'ООО "SOFFITTI"', work_type: 'Потолки', website: 'https://soffitti.example.invalid/' },
  { id: 5, name: 'OOO «Ёлка»', work_type: 'Благоустройство' }, // «OOO» латиницей
  { id: 6, name: 'СтройАльп', work_type: 'Альпинисты' },
  { id: 7, name: 'ООО "Мосбурстрой"', work_type: 'Буровые работы' },
]
const INDEX = new Map(LIST.map((cp) => [cp.id, counterpartySearchIndex(cp)]))
const find = (query, list = LIST) => {
  const { items, fix } = searchCounterparties(list, query, (cp) => INDEX.get(cp.id) ?? counterpartySearchIndex(cp))
  return { ids: items.map((cp) => cp.id), fix }
}

describe('Поиск контрагентов: правила', () => {
  it('ключ поиска: без пробелов и знаков, ё = е, й = и, латиница, похожая на кириллицу, — кириллица', () => {
    assert.equal(searchKey('ООО Пром Атом Строй (ПАС)'), 'ооопроматомстроипас')
    assert.equal(searchKey('Пром-Атом-«Строй»'), 'проматомстрои')
    assert.equal(searchKey('OOO «Ёлка»'), searchKey('ооо елка'))
    assert.equal(searchKey('CK Монтаж'), searchKey('СК Монтаж'))
    assert.equal(searchKey('+7(910)461-45-71'), '79104614571')
    assert.equal(searchKey(null), '')
  })

  it('другая раскладка — тот же набор клавиш', () => {
    assert.equal(switchLayout('ghjvfnjvcnhjq'), 'проматомстрой')
    assert.equal(switchLayout('ыщаашееш'), 'soffitti')
    assert.equal(switchLayout('Ghjv,fpf'), 'промбаза')
    assert.equal(switchLayout('123'), '123')
  })

  it('опечатки: замена, пропуск, лишняя буква, перестановка соседних', () => {
    const name = searchKey('ООО Пром Атом Строй (ПАС)')
    assert.equal(typoDistance('проматомстрои', name), 0)
    assert.equal(typoDistance('праматомстрои', name), 1)
    assert.equal(typoDistance('пороматомстрои', name), 1)
    assert.equal(typoDistance('пратомстрои', name), 2)
    assert.equal(typoDistance('пормаотмстрои', name), 2, 'две перестановки')
  })

  it('без пробелов, словами в любом порядке, с формой собственности', () => {
    assert.deepEqual(find('проматомстрой').ids, [1, 2])
    assert.deepEqual(find('ПРОМАТОМСТРОЙ').ids, [1, 2])
    assert.deepEqual(find('пром атом строй').ids, [1, 2])
    assert.deepEqual(find('атом пром').ids, [1, 2])
    assert.deepEqual(find('ооо проматомстрой').ids, [1])
    assert.deepEqual(find('альпинистэксперт').ids, [3])
    assert.deepEqual(find('альпинист эксперт').ids, [3])
    assert.deepEqual(find('строиальп').ids, [6], 'й = и')
    assert.deepEqual(find('ооо елка').ids, [5], 'латинское «OOO» и ё')
    assert.equal(find('проматомстрой').fix, null)
  })

  it('слова — в разных полях: контакт и вид работ; телефон с 8 или 7 в начале, ИНН', () => {
    assert.deepEqual(find('сапаров монолит').ids, [1])
    assert.deepEqual(find('сапаров фасад').ids, [])
    assert.deepEqual(find('89104614571').ids, [1])
    assert.deepEqual(find('+7 910 461 45 71').ids, [1])
    assert.deepEqual(find('79253422456').ids, [1])
    assert.deepEqual(find('8 925 342').ids, [1])
    assert.deepEqual(find('7701234567').ids, [1])
    assert.deepEqual(find('soffitti.example').ids, [4])
    // Совпадение не склеивается из конца одного поля и начала другого: «…ПАС» + «Монолит».
    assert.deepEqual(find('пасмонолит').ids, [])
  })

  it('другая раскладка и опечатки — только когда набранное не нашлось', () => {
    assert.deepEqual(find('ghjvfnjvcnhjq'), { ids: [1, 2], fix: { kind: 'layout', query: 'проматомстрой' } })
    assert.deepEqual(find('ыщаашееш'), { ids: [4], fix: { kind: 'layout', query: 'soffitti' } })
    assert.deepEqual(find('праматомстрой'), { ids: [1, 2], fix: { kind: 'typo' } })
    assert.deepEqual(find('сопаров'), { ids: [1], fix: { kind: 'typo' } }, 'ФИО контакта')
    // Короткий запрос — только точно: «сибур» с одной опечаткой — в «Мосбурстрое».
    assert.deepEqual(find('сибур'), { ids: [], fix: null })
    // Ближайшие — первыми: «ПромОтомСтрой» — две опечатки, «ПромАтомСтрой» — одна.
    assert.deepEqual(find('праматомстрой', [{ id: 'x', name: 'ПромОтомСтрой' }, LIST[1]]), { ids: [2, 'x'], fix: { kind: 'typo' } })
  })

  it('пустой запрос и одни знаки — весь список', () => {
    assert.equal(find('').ids.length, LIST.length)
    assert.equal(find('  «» - ').ids.length, LIST.length)
  })
})

describe('Поиск в реестре контрагентов', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 600000 }, () => {
  let stand
  let browser

  before(async () => {
    stand = await startStand(REPO)
    browser = await chromium.launch({ ...launch, headless: true })
    const page = await browser.newPage()
    await page.goto(`${stand.url}?${BASE}`)
    await page.locator('table.compact-table tbody tr.table-row').first().waitFor({ timeout: 120000 })
    await page.close()
  })
  after(async () => {
    await browser?.close()
    await stand?.server.close()
  })

  async function openPage(viewport = { width: 1440, height: 900 }) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    await page.goto(`${stand.url}?${BASE}`)
    await page.locator('table.compact-table tbody tr.table-row, .cp-mrow').first().waitFor({ timeout: 60000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const ROWS = 'table.compact-table tbody tr.table-row'
  // Набрать запрос и дождаться списка: число в шапке и строк — count, пояснение над списком содержит fix (null — нет).
  // Список фильтруется по отложенному значению поиска — сразу после ввода он ещё прежний.
  async function search(page, query, count, fix = null, rows = ROWS) {
    await page.locator('.search-container input').fill(query)
    await page.waitForFunction(({ sel, n, text }) => {
      const hint = document.querySelector('.cp-search-fix')?.innerText ?? null
      return document.querySelector('.counter-badge')?.innerText === String(n)
        && document.querySelectorAll(sel).length === n
        && (text === null ? hint === null : hint !== null && hint.includes(text))
    }, { sel: rows, n: count, text: fix }, { timeout: 10000 })
  }
  const names = async (page) => (await page.locator(`${ROWS} .company-name`).allInnerTexts()).map((n) => n.trim())

  it('без пробелов и словами; другая раскладка и опечатки — с пояснением над списком', async () => {
    const { page, errors, close } = await openPage()
    try {
      await search(page, 'проматомстрой', 2)
      assert.deepEqual(await names(page), ['ООО Пром Атом Строй (ПАС)', 'ПромАтомСтрой'])
      await search(page, 'атом пром', 2)
      await search(page, 'альпинистэксперт', 1)
      assert.deepEqual(await names(page), ['ООО "Альпинист-эксперт"'])

      await search(page, 'ghjvfnjvcnhjq', 2, 'Показаны результаты по запросу «проматомстрой» — набран в другой раскладке')
      assert.deepEqual(await names(page), ['ООО Пром Атом Строй (ПАС)', 'ПромАтомСтрой'])
      await search(page, 'праматомстрой', 2, 'Точных совпадений нет — показаны похожие названия')

      // Телефон контакта с 8 в начале: контакты — у 1-го, 5-го и 7-го (3-й — в чёрном списке).
      await search(page, '87015551234', 3)

      await search(page, 'сибур', 0)
      assert.match(await page.locator('.empty-title:visible').innerText(), /Ничего не найдено/)

      // Поиск — внутри вкладки: «Вестаир» в чёрном списке, с опечаткой находится там.
      await search(page, 'вистаир', 0)
      await page.locator('.cp-tab-blacklist').click()
      await search(page, 'вистаир', 1, 'показаны похожие')
      assert.deepEqual(await names(page), ['ООО "Вестаир Групп" (ФАКТСТРОЙ)'])

      await search(page, '', 1)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('на телефоне — тот же поиск и пояснение', async () => {
    const { page, errors, close } = await openPage({ width: 390, height: 844 })
    try {
      await search(page, 'ghjvfnjvcnhjq', 2, 'набран в другой раскладке', '.cp-mrow')
      const box = await page.locator('.cp-search-fix').boundingBox()
      assert.ok(box && box.x >= 0 && box.x + box.width <= 390, 'пояснение — в пределах экрана')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
