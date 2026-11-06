// «Заявки на проверку ДП/ДС», 06.11.2026 (просьбы пользователя):
//   • контрагента в форме заявки (и в фильтре над доской) ищут по названию, ИНН и постоянному номеру реестра контрагентов
//     («№» — counterparty_number; без колонки — тем же счётом, что реестр); предлагаются, как вкладка «Активные» реестра;
//   • у каждой колонки — кнопка порядка: свой (как расставили мышью) → новые сверху → старые сверху → свой. Выбор переживает
//     обновление страницы, свой порядок по дате не трогается: в базу ничего не пишется. В колонке по дате бросок решает
//     только колонку, место — дата.
// Правила — без браузера; страница — стенд tests/tender/ui (route=/doc-check-requests&docCheck=1, dcCpSearch, dcSortDates).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  counterpartyOptionMeta, counterpartyPickerOptions, filterCounterpartyOptions, isPickableCounterparty,
} from '../../src/utils/counterpartyPicker.js'
import { counterpartyNumbers } from '../../src/utils/counterpartyFilters.js'
import {
  COLUMN_SORTS, SUMMARY_COLUMN, columnSortOf, datePlaceBefore, nextColumnSort, normalizeColumnSorts, withColumnSort,
} from '../../src/utils/docCheckHelpers.js'

const CPS = [
  { id: 'a', name: 'ООО «МАСТЕР»', inn: '7708203762', counterparty_number: 101, status: 'active' },
  { id: 'b', name: 'ООО "Пром Атом Строй"', inn: '7701 000012', counterparty_number: 12, status: 'active' },
  { id: 'c', name: 'ИП Сидоров', inn: '501234567890', counterparty_number: 7, status: 'limited' },
  { id: 'd', name: 'ООО Чёрный', inn: '7708999999', counterparty_number: 13, status: 'blacklist' },
  { id: 'e', name: 'ООО Удалённый', inn: '7708555555', counterparty_number: 14, status: 'active', deleted_at: '2026-10-01' },
  { id: 'f', name: 'СУ-12 Монтаж', inn: null, counterparty_number: 300, status: 'active' },
]
const names = (list) => list.map(o => o.label)

describe('Поиск контрагента и порядок колонок: правила без браузера', () => {
  it('предлагаются как вкладка «Активные» реестра: действующие и «Малые суммы», без чёрного списка и удалённых', () => {
    assert.deepEqual(CPS.filter(isPickableCounterparty).map(c => c.id), ['a', 'b', 'c', 'f'])
  })

  it('поиск: ИНН, «№ N», одни цифры — номер первым, «ИНН …», название без кавычек и регистра, слова в любом порядке', () => {
    const options = counterpartyPickerOptions(CPS.filter(isPickableCounterparty))
    assert.equal(options[1].inn, '7701000012', 'пробелы в ИНН не мешают')
    assert.deepEqual(names(filterCounterpartyOptions(options, '7708203762')), ['ООО «МАСТЕР»'])
    assert.deepEqual(names(filterCounterpartyOptions(options, ' 7708 ')), ['ООО «МАСТЕР»'])
    assert.deepEqual(names(filterCounterpartyOptions(options, '№ 12')), ['ООО "Пром Атом Строй"'])
    assert.deepEqual(names(filterCounterpartyOptions(options, '№12')), ['ООО "Пром Атом Строй"'])
    assert.deepEqual(names(filterCounterpartyOptions(options, '№ 1')), [], '«№» — только точный номер')
    // «12»: контрагент № 12 первым, затем 12 в ИНН и в названии.
    assert.deepEqual(names(filterCounterpartyOptions(options, '12')), ['ООО "Пром Атом Строй"', 'ИП Сидоров', 'СУ-12 Монтаж'])
    assert.deepEqual(names(filterCounterpartyOptions(options, '7')), ['ИП Сидоров', 'ООО «МАСТЕР»', 'ООО "Пром Атом Строй"'])
    assert.deepEqual(names(filterCounterpartyOptions(options, 'ИНН 5012')), ['ИП Сидоров'])
    assert.deepEqual(names(filterCounterpartyOptions(options, 'инн: 12')), ['ООО "Пром Атом Строй"', 'ИП Сидоров'])
    assert.deepEqual(names(filterCounterpartyOptions(options, 'мастер')), ['ООО «МАСТЕР»'])
    assert.deepEqual(names(filterCounterpartyOptions(options, 'проматом')), ['ООО "Пром Атом Строй"'])
    assert.deepEqual(names(filterCounterpartyOptions(options, 'строй пром')), ['ООО "Пром Атом Строй"'])
    assert.deepEqual(names(filterCounterpartyOptions(options, 'мастер 7708')), ['ООО «МАСТЕР»'], 'название и ИНН вместе')
    assert.deepEqual(names(filterCounterpartyOptions(options, 'су-12')), ['СУ-12 Монтаж'])
    assert.equal(filterCounterpartyOptions(options, '  ').length, 4)
    assert.equal(counterpartyOptionMeta(options[0]), '№ 101 · ИНН 7708203762')
    assert.equal(counterpartyOptionMeta(options[3]), '№ 300')
    assert.equal(counterpartyOptionMeta({ no: null, inn: '' }), '')
  })

  it('без колонки номера — номер тем же счётом, что в реестре контрагентов (по всему реестру)', () => {
    const legacy = CPS.map(({ counterparty_number: _n, ...cp }) => cp)
    const numbers = counterpartyNumbers(legacy)
    const options = counterpartyPickerOptions(legacy.filter(isPickableCounterparty), numbers)
    assert.deepEqual(options.map(o => o.no), ['a', 'b', 'c', 'f'].map(id => numbers.get(id)))
    const no = numbers.get('b')
    assert.deepEqual(names(filterCounterpartyOptions(options, `№ ${no}`)), ['ООО "Пром Атом Строй"'])
  })

  it('порядок колонки: свой → новые → старые → свой; у «Сводки» — только по дате; в браузере хранится только не по умолчанию', () => {
    assert.equal(columnSortOf({}, 'in_progress'), 'manual')
    assert.equal(columnSortOf({}, SUMMARY_COLUMN), 'newest')
    assert.equal(columnSortOf({ in_progress: 'bogus' }, 'in_progress'), 'manual')
    assert.equal(columnSortOf({ summary: 'manual' }, SUMMARY_COLUMN), 'newest', 'своего порядка у «Сводки» нет')
    const seen = []
    let sorts = {}
    for (let i = 0; i < 4; i++) {
      sorts = withColumnSort(sorts, 'done', nextColumnSort(sorts, 'done'))
      seen.push(columnSortOf(sorts, 'done'))
    }
    assert.deepEqual(seen, ['newest', 'oldest', 'manual', 'newest'])
    assert.deepEqual(withColumnSort({ done: 'oldest' }, 'done', 'manual'), {})
    assert.equal(nextColumnSort({}, SUMMARY_COLUMN), 'oldest')
    assert.equal(nextColumnSort({ summary: 'oldest' }, SUMMARY_COLUMN), 'newest')
    assert.deepEqual(normalizeColumnSorts({ done: 'oldest', new: 'manual', summary: 'newest', x: 'zzz', y: 5 }), { done: 'oldest' })
    assert.deepEqual(normalizeColumnSorts('[1]'), {})
    assert.deepEqual(normalizeColumnSorts(['oldest']), {})
  })

  it('три порядка — три разных списка; по дате при равной дате — номер; место по дате — перед первой, что идёт после', () => {
    const r = (id, created_at, sort_order) => ({ id, created_at, sort_order })
    const rows = [r('x', '2026-10-20T09:00:00Z', 2), r('y', '2026-10-23T09:00:00Z', 1), r('z', '2026-10-22T09:00:00Z', 3),
      r('w', '2026-10-20T09:00:00Z', 5)]
    const order = (mode) => [...rows].sort(COLUMN_SORTS[mode].compare).map(q => q.id)
    assert.deepEqual(order('manual'), ['w', 'z', 'x', 'y'])
    assert.deepEqual(order('newest'), ['y', 'z', 'w', 'x'])
    assert.deepEqual(order('oldest'), ['x', 'w', 'z', 'y'])
    const newest = [...rows].sort(COLUMN_SORTS.newest.compare)
    assert.equal(datePlaceBefore(newest, r('n', '2026-10-21T00:00:00Z', 9), COLUMN_SORTS.newest.compare), 'w')
    assert.equal(datePlaceBefore(newest, r('n', '2026-10-01T00:00:00Z', 9), COLUMN_SORTS.newest.compare), null)
    assert.equal(datePlaceBefore(newest, rows[2], COLUMN_SORTS.newest.compare), 'w', 'сама карточка пропускается')
  })
})

const launch = browserLaunchOptions()

describe('Поиск контрагента и порядок колонок в браузере', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  const openContext = async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1700, height: 950 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => d.accept())
    return { context, page, errors }
  }
  const go = async (page, extra = '') => {
    await page.goto(`${stand.url}?route=/doc-check-requests&docCheck=1&latency=0${extra}`)
    await page.locator('.dc-board, .dc-error').first().waitFor({ timeout: 120000 })
  }
  const column = (page, status) => page.locator(`.dc-column[data-status="${status}"]`)
  const cardsIn = (page, status) => column(page, status).locator('.dc-card').evaluateAll((els) => els.map((el) => el.dataset.id))
  const sortBtn = (page, status) => column(page, status).locator('.dc-sort-btn')
  const updates = (page) => page.evaluate(() => window.__supabaseStats.requests
    .filter((r) => r.table === 'doc_check_requests' && r.op === 'update').length)
  const row = (page, id) => page.evaluate((x) => {
    const r = window.__fakeDb.doc_check_requests.find((q) => q.id === x)
    return { status: r.status, sort_order: r.sort_order, counterparty_id: r.counterparty_id }
  }, id)
  // Набрать в поиске открытого списка и прочитать найденное: название и подпись «№ · ИНН».
  const searchIn = async (page, text) => {
    await page.locator('.fdrop-panel .fdrop-search').fill(text)
    return page.locator('.fdrop-panel .fdrop-option').evaluateAll((els) => els.map((el) => {
      const name = el.querySelector('.dc-cp-option-name')?.textContent ?? el.textContent.trim()
      const meta = el.querySelector('.dc-cp-option-meta')?.textContent
      return meta ? `${name} | ${meta}` : name
    }))
  }

  it('форма: контрагент находится по ИНН, «№» и цифрам номера; чёрный список и удалённые не предлагаются; выбранный сохраняется', async () => {
    const { context, page, errors } = await openContext()
    try {
      await go(page, '&dcCpSearch=1')
      await page.getByRole('button', { name: /Новая заявка/ }).click()
      const form = page.locator('.dc-form-modal')
      await form.locator('.dc-form-row', { hasText: 'Контрагент' }).locator('.fdrop-trigger').click()
      assert.equal(await page.locator('.fdrop-panel .fdrop-search').getAttribute('placeholder'), 'Название, ИНН или №')
      assert.deepEqual(await searchIn(page, '7708203762'), ['Подрядчик 01 | № 101 · ИНН 7708203762'])
      // 7708 — ещё у чёрного списка (04) и удалённого (05): их в списке нет. «Малые суммы» (03) — есть.
      assert.deepEqual(await searchIn(page, '7708'), ['Подрядчик 01 | № 101 · ИНН 7708203762'])
      assert.deepEqual(await searchIn(page, '№ 12'), ['Подрядчик 02 | № 12 · ИНН 7701000012'])
      assert.deepEqual(await searchIn(page, '№ 13'), [])
      assert.deepEqual(await searchIn(page, 'ИНН 5012'), ['Подрядчик 03 | № 7 · ИНН 501234567890'])
      const twelve = await searchIn(page, '12')
      assert.equal(twelve[0], 'Подрядчик 02 | № 12 · ИНН 7701000012', 'номер — первым')
      assert.ok(twelve.includes('ООО «СУ-10 Монтаж» | № 205 · ИНН 7712000000'), 'дальше — 12 в ИНН')
      assert.deepEqual(await searchIn(page, 'су 10 монтаж'), ['ООО «СУ-10 Монтаж» | № 205 · ИНН 7712000000'])

      await searchIn(page, '7708203762')
      await page.locator('.fdrop-panel .fdrop-option').first().click()
      assert.equal(await form.locator('.dc-form-row', { hasText: 'Контрагент' }).locator('.fdrop-value').textContent(), 'Подрядчик 01')
      await form.getByRole('button', { name: 'Создать заявку' }).click()
      await form.waitFor({ state: 'detached' })
      const created = await page.evaluate(() => window.__fakeDb.doc_check_requests.at(-1))
      assert.equal(created.counterparty_id, 'cp-1')
      assert.equal(created.status, 'new')
      assert.deepEqual(errors, [])
    } finally {
      await context.close().catch(() => {})
    }
  })

  it('фильтр над доской: «№ 12» находит контрагента, на доске — только его заявки', async () => {
    const { context, page, errors } = await openContext()
    try {
      await go(page, '&dcCpSearch=1')
      await page.locator('.dc-toolbar .fdrop-trigger', { hasText: 'Контрагент' }).click()
      assert.deepEqual(await searchIn(page, '№ 12'), ['Подрядчик 02'])
      await page.locator('.fdrop-panel .fdrop-option').first().click()
      await page.keyboard.press('Escape')
      await page.locator('.fdrop-panel').waitFor({ state: 'detached' })
      const shown = await page.locator('.dc-column:not(.dc-column--summary) .dc-card').evaluateAll((els) => els.map((el) => el.dataset.id))
      assert.deepEqual(shown.sort(), ['dcr-2', 'dcr-5'])
      assert.deepEqual(errors, [])
    } finally {
      await context.close().catch(() => {})
    }
  })

  it('колонки номера ещё нет: номер — тем же счётом, что в реестре контрагентов, без ошибок', async () => {
    const { context, page, errors } = await openContext()
    try {
      await go(page, '&dcCpSearch=legacy')
      const all = await page.evaluate(() => window.__fakeDb.counterparties.map(({ id, name, status, deleted_at }) => ({ id, name, status, deleted_at })))
      const no = counterpartyNumbers(all).get('cp-2')
      await page.getByRole('button', { name: /Новая заявка/ }).click()
      await page.locator('.dc-form-modal .dc-form-row', { hasText: 'Контрагент' }).locator('.fdrop-trigger').click()
      assert.deepEqual(await searchIn(page, `№ ${no}`), [`Подрядчик 02 | № ${no} · ИНН 7701000012`])
      assert.deepEqual(await searchIn(page, '7708203762'), [`Подрядчик 01 | № ${counterpartyNumbers(all).get('cp-1')} · ИНН 7708203762`])
      assert.deepEqual(errors, [])
    } finally {
      await context.close().catch(() => {})
    }
  })

  it('кнопка порядка: свой → новые → старые → свой; выбор переживает обновление; свой порядок не трогается, записей нет', async () => {
    const { context, page, errors } = await openContext()
    try {
      await go(page, '&dcSortDates=1')
      const manual = ['dcr-10', 'dcr-3', 'dcr-2']
      assert.deepEqual(await cardsIn(page, 'in_progress'), manual)
      assert.equal(await sortBtn(page, 'in_progress').getAttribute('data-sort'), 'manual')
      assert.match(await sortBtn(page, 'in_progress').getAttribute('aria-label'), /свой порядок.*Нажмите — новые сверху/)
      // Кнопка — сразу за названием колонки, счётчик — у правого края.
      const title = await column(page, 'in_progress').locator('.dc-column-title').boundingBox()
      const btn = await sortBtn(page, 'in_progress').boundingBox()
      const count = await column(page, 'in_progress').locator('.dc-column-count').boundingBox()
      assert.ok(btn.x - (title.x + title.width) < 8, 'кнопка вплотную к названию')
      assert.ok(count.x > btn.x + btn.width + 20, 'счётчик правее, не вплотную')

      await sortBtn(page, 'in_progress').click()
      assert.deepEqual(await cardsIn(page, 'in_progress'), ['dcr-2', 'dcr-10', 'dcr-3'])
      assert.equal(await sortBtn(page, 'in_progress').textContent(), 'Новые')
      await sortBtn(page, 'in_progress').click()
      assert.deepEqual(await cardsIn(page, 'in_progress'), ['dcr-3', 'dcr-10', 'dcr-2'])
      assert.equal(await sortBtn(page, 'in_progress').textContent(), 'Старые')
      // Остальные колонки — как были.
      assert.equal(await sortBtn(page, 'done').getAttribute('data-sort'), 'manual')
      assert.equal(await sortBtn(page, 'summary').getAttribute('data-sort'), 'newest')
      assert.equal(await updates(page), 0, 'по дате — только показ, в базу ничего')

      await go(page, '&dcSortDates=1')
      assert.equal(await sortBtn(page, 'in_progress').getAttribute('data-sort'), 'oldest', 'выбор пережил обновление')
      assert.deepEqual(await cardsIn(page, 'in_progress'), ['dcr-3', 'dcr-10', 'dcr-2'])
      await sortBtn(page, 'in_progress').click()
      assert.deepEqual(await cardsIn(page, 'in_progress'), manual, 'свой порядок — прежний')
      assert.equal(await sortBtn(page, 'in_progress').textContent(), '')

      // «Сводка»: новые ↔ старые, своего порядка нет.
      await sortBtn(page, 'summary').click()
      assert.equal(await sortBtn(page, 'summary').getAttribute('data-sort'), 'oldest')
      await sortBtn(page, 'summary').click()
      assert.equal(await sortBtn(page, 'summary').getAttribute('data-sort'), 'newest')
      assert.equal(await updates(page), 0)
      assert.deepEqual(errors, [])
    } finally {
      await context.close().catch(() => {})
    }
  })

  it('колонка по дате: заглушка — где карточка встанет по дате; бросок меняет только колонку; в своей колонке — ничего', async () => {
    const { context, page, errors } = await openContext()
    try {
      await go(page, '&dcSortDates=1')
      await sortBtn(page, 'in_progress').click()   // новые сверху: dcr-2, dcr-10, dcr-3
      const slotAt = () => column(page, 'in_progress').locator('.dc-column-body > *').evaluateAll((els) => els
        .map((el) => (el.classList.contains('dc-card-slot') ? 'место' : el.hidden ? null : el.dataset.card)).filter(Boolean))
      // dcr-1 добавлена 20.10, как dcr-3, но придёт наверх своего порядка — значит, выше dcr-3; куда бы ни вели — там же.
      const from = await column(page, 'new').locator('.dc-card[data-id="dcr-1"]').boundingBox()
      const top = await column(page, 'in_progress').locator('.dc-card[data-id="dcr-2"]').boundingBox()
      await page.mouse.move(from.x + 60, from.y + 10)
      await page.mouse.down()
      await page.mouse.move(top.x + 40, top.y + 4, { steps: 5 })
      await page.waitForTimeout(50)
      assert.deepEqual(await slotAt(), ['dcr-2', 'dcr-10', 'место', 'dcr-3'])
      await page.mouse.move(top.x + 40, top.y + top.height + 40, { steps: 3 })
      await page.waitForTimeout(50)
      assert.deepEqual(await slotAt(), ['dcr-2', 'dcr-10', 'место', 'dcr-3'])
      await page.mouse.up()
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-1').status === 'in_progress')
      assert.deepEqual(await cardsIn(page, 'in_progress'), ['dcr-2', 'dcr-10', 'dcr-1', 'dcr-3'])
      assert.deepEqual(await row(page, 'dcr-1'), { status: 'in_progress', sort_order: 4, counterparty_id: 'cp-1' }, 'в своём порядке — наверх')
      const log = await page.evaluate(() => window.__fakeDb.doc_check_request_audit_log.map((l) => [l.request_id, l.event_type, l.new_value]))
      assert.deepEqual(log, [['dcr-1', 'status_changed', 'in_progress']])

      // Внутри колонки по дате: заглушка — на месте карточки, бросок ничего не пишет.
      const before = await updates(page)
      const own = await column(page, 'in_progress').locator('.dc-card[data-id="dcr-3"]').boundingBox()
      await page.mouse.move(own.x + 60, own.y + 10)
      await page.mouse.down()
      await page.mouse.move(top.x + 40, top.y + 4, { steps: 5 })
      await page.waitForTimeout(50)
      assert.deepEqual(await slotAt(), ['dcr-2', 'dcr-10', 'dcr-1', 'место'])
      await page.mouse.up()
      await page.waitForTimeout(150)
      assert.equal(await updates(page), before)
      assert.deepEqual(await cardsIn(page, 'in_progress'), ['dcr-2', 'dcr-10', 'dcr-1', 'dcr-3'])

      // Обратно к своему порядку: перенесённая — сверху, остальные — как были.
      await sortBtn(page, 'in_progress').click()
      await sortBtn(page, 'in_progress').click()
      assert.deepEqual(await cardsIn(page, 'in_progress'), ['dcr-1', 'dcr-10', 'dcr-3', 'dcr-2'])
      assert.deepEqual(errors, [])
    } finally {
      await context.close().catch(() => {})
    }
  })
})
