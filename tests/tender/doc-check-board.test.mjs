// «Заявки на проверку ДП/ДС» — доска по образцу прежней доски отдела (миграция 20261113): правила без браузера и
// страница в Chromium (стенд tests/tender/ui, route=/doc-check-requests&docCheck=1).
//   • колонки от «Новых заявок» до «Проверки документов (исключение налоговой оговорки)», «Сводка по ДП» —
//     выборка ДП не из «Завершено»; карточка: «Контрагент / ДС № 1» с примечанием, объект, метки, срок,
//     приоритет, файлы, кружки исполнителей, цвет; просроченная — красной рамкой;
//   • кружок «завершить», меню карточки (цвет, перенос в колонку, архив), «+ Добавить заявку» в колонке,
//     «В архив» у «Завершено» и «Архив» с возвратом, перетаскивание; в базу — только сменившийся порядок;
//   • шапка: объект — выпадающим списком (со счётчиком заявок); ни плашек объектов, ни «Мои заявки», ни фильтра меток;
//   • жесты мышью (boardGestures.js): предпросмотр и заглушка места, автопрокрутка, Escape; касание карточки не двигает её;
//     прокрутка удержанием; шапка в две низкие строки, доска на всё окно; «Удалённые»: кто удалил;
//   • колонок 20261113 ещё нет — доска как раньше, без ошибок; без права правки — только просмотр.
// Люди стенда вымышленные.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  DEFAULT_SUMMARY, avatarTone, boardColumns, compareForBoard, compareNewestFirst, createdShort, dueState, fieldEvents, initials,
  labelSuggestions, matchesDeadline,
  matchesSummary, nextSortOrder, normalizeLabels, normalizeSummary, placeInColumn, AVATAR_TONES, cardTitle,
} from '../../src/utils/docCheckHelpers.js'

const day = (n) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

describe('Заявки на проверку ДП/ДС: правила без браузера', () => {
  it('колонки: как на прежней доске, «Сводка» — между «Ожидаем скан» и «Проверкой документов»', () => {
    assert.deepEqual(boardColumns(true).map(c => c.label), [
      'Новые заявки', 'В работе', 'Выгрузка по ЭДО', 'Загрузка в Signal', 'Загрузка в 1С', 'Завершено',
      'Ожидаем скан ДП/ДС, подписанного в бумажном виде', 'Сводка по ДП',
      'Проверка документов (исключение налоговой оговорки)',
    ])
    // До миграции статуса tax_clause в базе нет — и колонки нет.
    assert.ok(!boardColumns(false).some(c => c.value === 'tax_clause'))
    assert.equal(boardColumns(false).at(-1).value, 'summary')
  })

  it('сводка: по умолчанию ДП не из «Завершено»; пустой отбор — все; чужая настройка — по умолчанию', () => {
    assert.deepEqual(DEFAULT_SUMMARY.types, ['dp'])
    assert.ok(!DEFAULT_SUMMARY.statuses.includes('done'))
    assert.equal(matchesSummary({ doc_type: 'dp', status: 'in_progress' }, DEFAULT_SUMMARY), true)
    assert.equal(matchesSummary({ doc_type: 'dp', status: 'done' }, DEFAULT_SUMMARY), false)
    assert.equal(matchesSummary({ doc_type: 'ds', status: 'in_progress' }, DEFAULT_SUMMARY), false)
    assert.equal(matchesSummary({ doc_type: 'ds', status: 'done' }, { types: [], statuses: [] }), true)
    assert.deepEqual(normalizeSummary(null), DEFAULT_SUMMARY)
    assert.deepEqual(normalizeSummary({ types: ['xx', 'ds'], statuses: ['done', 'bogus'] }), { types: ['ds'], statuses: ['done'] })
    assert.deepEqual(normalizeSummary({ types: 'dp' }).types, ['dp'])
  })

  it('срок: просрочено / сегодня / неделя / без срока; у завершённой срок не горит', () => {
    const r = (due, status = 'in_progress') => ({ due_date: due, status })
    assert.equal(dueState(r(day(-1))), 'overdue')
    assert.equal(dueState(r(day(0))), 'today')
    assert.equal(dueState(r(day(2))), 'soon')
    assert.equal(dueState(r(day(10))), 'upcoming')
    assert.equal(dueState(r(day(-5), 'done')), 'closed')
    assert.equal(dueState(r(null)), 'none')
    assert.equal(matchesDeadline(r(day(-1)), 'overdue'), true)
    assert.equal(matchesDeadline(r(day(-1), 'done'), 'overdue'), false)
    assert.equal(matchesDeadline(r(day(7)), 'week'), true)
    assert.equal(matchesDeadline(r(day(8)), 'week'), false)
    assert.equal(matchesDeadline(r(null), 'none'), true)
    assert.equal(matchesDeadline(r(day(1)), ''), true)
  })

  it('метки: без пробелов и повторов, не больше 12; подсказки — частые первыми', () => {
    assert.deepEqual(normalizeLabels(['  В  бумажном виде ', 'в бумажном виде', '', 'ДП']), ['В бумажном виде', 'ДП'])
    assert.equal(normalizeLabels(Array.from({ length: 20 }, (_, i) => `м${i}`)).length, 12)
    assert.equal(normalizeLabels(['я'.repeat(80)])[0].length, 60)
    assert.deepEqual(labelSuggestions([
      { labels: ['Переподписание'] }, { labels: ['ДП', 'переподписание'] }, { labels: [] }, {},
    ]), ['Переподписание', 'ДП'])
  })

  it('исполнители: инициалы и постоянный цвет кружка', () => {
    assert.equal(initials('Иванова Роза Петровна'), 'ИР')
    assert.equal(initials('Петров П. П.'), 'ПП')
    assert.equal(initials('ivanov@example.invalid'), 'IV')
    assert.equal(initials(''), '?')
    const t = avatarTone('user-1')
    assert.equal(avatarTone('user-1'), t)
    assert.ok(t >= 0 && t < AVATAR_TONES)
  })

  it('порядок: соседей сдвигаем, только если нет места, и с той стороны, где меньше; конец колонки — без архива и удалённых', () => {
    // Сверху вниз номера убывают.
    const rows = [{ id: 'a', sort_order: 4 }, { id: 'b', sort_order: 3 }, { id: 'c', sort_order: 2 }, { id: 'd', sort_order: 1 }]
    // Края и пустая колонка — ни одного соседа.
    assert.deepEqual(placeInColumn([], null), { sortOrder: 1, shifted: [] })
    assert.deepEqual(placeInColumn(rows, null), { sortOrder: 0, shifted: [] })
    assert.deepEqual(placeInColumn(rows, 'a'), { sortOrder: 5, shifted: [] })
    assert.deepEqual(placeInColumn(rows, 'нет такой'), { sortOrder: 0, shifted: [] }, 'карточка, перед которой бросили, пропала — в конец')
    // Между соседями есть номер — только сама карточка.
    assert.deepEqual(placeInColumn([{ id: 'a', sort_order: 5 }, { id: 'b', sort_order: 1 }], 'b'), { sortOrder: 4, shifted: [] })
    // Места нет: ближе к верху сдвигаются верхние, ближе к низу — нижние.
    assert.deepEqual(placeInColumn(rows, 'b'), { sortOrder: 4, shifted: [{ id: 'a', sort_order: 5 }] })
    assert.deepEqual(placeInColumn(rows, 'd'), { sortOrder: 1, shifted: [{ id: 'd', sort_order: 0 }] })
    // Одинаковые номера (прежние данные): порядок после вставки — строгий рядом с местом вставки.
    const same = [{ id: 'a', sort_order: 1 }, { id: 'b', sort_order: 1 }, { id: 'c', sort_order: 1 }]
    const placed = placeInColumn(same, 'b')
    const after = new Map(same.map(r => [r.id, r.sort_order]))
    for (const u of placed.shifted) after.set(u.id, u.sort_order)
    assert.ok(after.get('a') > placed.sortOrder && placed.sortOrder > after.get('b'))
    // Следующий номер — это верх колонки.
    assert.equal(nextSortOrder([
      { status: 'done', sort_order: 3 }, { status: 'done', sort_order: 9, archived_at: '2026-10-01' },
      { status: 'done', sort_order: 7, deleted_at: '2026-10-01' }, { status: 'new', sort_order: 5 },
    ], 'done'), 4)
  })

  it('новые сверху: больший номер выше, при равных — добавленная позже; «Сводка» — только по дате; дата на карточке — без года', () => {
    const ids = (list, compare) => [...list].sort(compare).map(r => r.id)
    const rows = [
      { id: 'старая', sort_order: 1, created_at: '2026-10-01T09:00:00Z' },
      { id: 'с большим номером', sort_order: 2, created_at: '2026-10-02T09:00:00Z' },
      { id: 'позже, тот же номер', sort_order: 1, created_at: '2026-10-03T09:00:00Z' },
    ]
    assert.deepEqual(ids(rows, compareForBoard), ['с большим номером', 'позже, тот же номер', 'старая'])
    assert.deepEqual(ids(rows, compareNewestFirst), ['позже, тот же номер', 'с большим номером', 'старая'])
    assert.equal(createdShort('2026-10-23T09:00:00Z'), '23.10')
    assert.equal(createdShort('2025-03-05T09:00:00Z'), '05.03', 'и прошлогодняя — без года')
    assert.equal(createdShort(null), '')
    assert.equal(createdShort('не дата'), '')
  })

  it('история: только изменившиеся поля, массивы — по составу', () => {
    const prev = { notes: 'a', labels: ['x'], assignee_ids: ['u1'], due_date: null }
    assert.deepEqual(fieldEvents(prev, { notes: 'a', labels: ['x'], assignee_ids: ['u1', 'u2'], due_date: null, status: 'done' })
      .map(e => e.field_name), ['assignee_ids'])
    assert.equal(cardTitle({ doc_type: 'ds', doc_number: '1', counterparties: { name: 'ООО «Ромашка»' } }), 'ООО «Ромашка» / ДС № 1')
    assert.equal(cardTitle({ doc_type: 'dp' }), 'ДП')
  })
})

const launch = browserLaunchOptions()

describe('«Заявки на проверку ДП/ДС» в браузере', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  const openPage = async (extra = '') => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1700, height: 950 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => d.accept())
    await page.goto(`${stand.url}?route=/doc-check-requests&docCheck=1&latency=0${extra}`)
    await page.locator('.dc-board, .dc-error').first().waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const column = (page, status) => page.locator(`.dc-column[data-status="${status}"]`)
  // Отбор по объекту — выпадающий список в шапке (несколько на выбор, окно закрывается Escape).
  const pickObject = async (page, name) => {
    await page.locator('.dc-toolbar .fdrop-trigger', { hasText: 'Объект' }).click()
    await page.locator('.fdrop-panel .fdrop-option', { hasText: name }).click()
    await page.keyboard.press('Escape')
    await page.locator('.fdrop-panel').waitFor({ state: 'detached' })
  }
  const cardsIn = (page, status) => column(page, status).locator('.dc-card').evaluateAll((els) => els.map((el) => el.dataset.id))
  const counts = (page) => page.locator('.dc-column').evaluateAll((els) => Object.fromEntries(els.map((el) => [
    el.dataset.status, Number(el.querySelector('.dc-column-count').textContent)])))
  const row = (page, id) => page.evaluate((x) => {
    const r = window.__fakeDb.doc_check_requests.find((q) => q.id === x)
    return r && { status: r.status, sort_order: r.sort_order, color: r.color, archived_at: r.archived_at, labels: r.labels }
  }, id)

  it('доска: колонки, счётчики, «Сводка по ДП», карточка как на прежней доске', async () => {
    const { page, errors, close } = await openPage()
    try {
      assert.deepEqual(await page.locator('.dc-column-title').allTextContents(), boardColumns(true).map(c => c.label))
      // Архивная и удалённая — не на доске; «Сводка» — ДП не из «Завершено».
      assert.deepEqual(await counts(page), {
        new: 1, in_progress: 2, edo: 0, signal: 0, accounting: 0, done: 2, awaiting_scan: 1, summary: 3, tax_clause: 1,
      })
      assert.deepEqual(await cardsIn(page, 'summary'), ['dcr-2', 'dcr-6', 'dcr-7'])
      assert.equal(await column(page, 'summary').locator('.dc-card[data-id="dcr-6"] .dc-card-status').textContent(),
        'Ожидаем скан ДП/ДС, подписанного в бумажном виде')
      // В «Сводку» не добавляют и не бросают — это выборка, не колонка статуса.
      assert.equal(await column(page, 'summary').locator('.dc-column-add').count(), 0)

      const card = column(page, 'in_progress').locator('.dc-card[data-id="dcr-2"]')
      assert.equal(await card.locator('.dc-card-name').textContent(), 'Подрядчик 02 / ДП № СУ2-001')
      assert.match(await card.locator('.dc-card-notes').textContent(), /нет ред\. формата договора/)
      assert.equal(await card.locator('.dc-chip--object').textContent(), 'Бизнес-центр «Нурлы»')
      assert.deepEqual(await card.locator('.dc-chip--label').allTextContents(), ['Переподписание'])
      assert.deepEqual(await card.locator('.dc-avatar').allTextContents(), ['ЮМ'], 'исполнители — только юристы ОСП')
      assert.equal(await card.locator('.dc-count').textContent(), '1', 'файл заявки — скрепка с числом')
      assert.match(await card.getAttribute('class'), /\bhas-color dc-c-red\b/)
      assert.match(await card.getAttribute('class'), /\bis-overdue\b/, 'срок прошёл — красная рамка')
      assert.match(await card.locator('.dc-due').getAttribute('class'), /is-overdue/)
      assert.equal(await card.locator('.dc-prio.is-high').count(), 1)
      assert.doesNotMatch(await column(page, 'in_progress').locator('.dc-card[data-id="dcr-3"]').getAttribute('class'), /is-overdue/)
      assert.equal(await column(page, 'done').locator('.dc-card.is-done').count(), 2)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('шапка: объект — выпадающим списком со счётчиком; плашек, «Мои заявки» и фильтра меток нет; поиск — по метке', async () => {
    const { page, errors, close } = await openPage()
    try {
      assert.equal(await page.locator('.dc-quick, .dc-quick-chip').count(), 0, 'плашек над доской нет')
      assert.equal(await page.getByText('Мои заявки').count(), 0)
      const toolbar = await page.locator('.dc-toolbar .fdrop-trigger').allTextContents()
      assert.ok(toolbar.some((t) => t.includes('Объект')), toolbar.join())
      assert.ok(!toolbar.some((t) => t.includes('Метка')), 'фильтра меток нет')

      await pickObject(page, 'Бизнес-центр')
      assert.deepEqual((await counts(page)).in_progress, 1)
      assert.deepEqual(await cardsIn(page, 'in_progress'), ['dcr-2'])
      await page.locator('.dc-reset').click()
      await page.locator('.dc-search').fill('бумажном')
      assert.deepEqual(await page.locator('.dc-card').evaluateAll((els) => els.map((el) => el.dataset.id)), ['dcr-3'])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('кружок «завершить», меню карточки: цвет и перенос в колонку; история пишется', async () => {
    const { page, errors, close } = await openPage()
    try {
      await column(page, 'in_progress').locator('.dc-card[data-id="dcr-3"] .dc-card-check').click()
      await column(page, 'done').locator('.dc-card[data-id="dcr-3"]').waitFor()
      // Карточка переезжает сразу, запись в базу — следом.
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-3').status === 'done')
      assert.deepEqual(await row(page, 'dcr-3'), { status: 'done', sort_order: 3, color: null, archived_at: null, labels: ['В бумажном виде'] })
      assert.equal((await cardsIn(page, 'done'))[0], 'dcr-3', 'наверх колонки')
      // Обратно — «В работу».
      await column(page, 'done').locator('.dc-card[data-id="dcr-3"] .dc-card-check').click()
      await column(page, 'in_progress').locator('.dc-card[data-id="dcr-3"]').waitFor()

      await column(page, 'new').locator('.dc-card[data-id="dcr-1"] .dc-card-more').click()
      await page.locator('.dc-menu .dc-swatch[aria-label="Зелёный"]').click()
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-1').color === 'green')
      assert.match(await column(page, 'new').locator('.dc-card[data-id="dcr-1"]').getAttribute('class'), /dc-c-green/)

      await column(page, 'new').locator('.dc-card[data-id="dcr-1"] .dc-card-more').click()
      await page.locator('.dc-menu .dc-menu-status', { hasText: 'Загрузка в 1С' }).click()
      await column(page, 'accounting').locator('.dc-card[data-id="dcr-1"]').waitFor()
      await page.waitForFunction(() => window.__fakeDb.doc_check_request_audit_log.length === 4)
      assert.equal((await row(page, 'dcr-1')).status, 'accounting')

      const log = await page.evaluate(() => window.__fakeDb.doc_check_request_audit_log.map((l) => [l.request_id, l.event_type, l.field_name, l.new_value]))
      assert.deepEqual(log, [
        ['dcr-3', 'status_changed', 'status', 'done'],
        ['dcr-3', 'status_changed', 'status', 'in_progress'],
        ['dcr-1', 'field_updated', 'color', 'green'],
        ['dcr-1', 'status_changed', 'status', 'accounting'],
      ])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('«+ Добавить заявку» в колонке: заявка встаёт в эту колонку с метками, сроком и исполнителем', async () => {
    const { page, errors, close } = await openPage()
    try {
      await column(page, 'edo').locator('.dc-column-add').click()
      const form = page.locator('.dc-form-modal')
      assert.match(await form.locator('.dc-detail-sub').textContent(), /Колонка: Выгрузка по ЭДО/)
      // Без контрагента и примечания — не создаётся.
      await form.getByRole('button', { name: 'Создать заявку' }).click()
      await form.locator('.dc-form-error').waitFor()
      await form.locator('#dc-notes').fill('Письмо застройщика: проверить ДС по лоту 18')
      await form.locator('#dc-due').fill(day(3))
      const labels = form.locator('.dc-labels-input input')
      await labels.fill('Направлены правки')
      await labels.press('Enter')
      await labels.fill('ДП')
      await labels.press('Enter')
      await form.locator('.dc-form-assignees .fdrop-trigger').click()
      await page.locator('.fdrop-panel .fdrop-option', { hasText: 'Юристова Мария Андреевна' }).click()
      await page.keyboard.press('Escape')
      await form.getByRole('button', { name: 'Высокий' }).click()
      await form.locator('.dc-swatch[aria-label="Синий"]').click()
      await form.getByRole('button', { name: 'Создать заявку' }).click()
      await column(page, 'edo').locator('.dc-card').waitFor()
      const created = await page.evaluate(() => window.__fakeDb.doc_check_requests.find((r) => r.status === 'edo'))
      assert.equal(created.notes, 'Письмо застройщика: проверить ДС по лоту 18')
      assert.deepEqual(created.labels, ['Направлены правки', 'ДП'])
      assert.equal(created.priority, 'high')
      assert.equal(created.color, 'blue')
      assert.equal(created.due_date, day(3))
      assert.equal(created.sort_order, 1)
      assert.equal(created.counterparty_id, null)
      assert.deepEqual(created.assignee_ids, ['user-3'])
      assert.deepEqual(await column(page, 'edo').locator('.dc-chip--label').allTextContents(), ['Направлены правки', 'ДП'])
      assert.deepEqual(await column(page, 'edo').locator('.dc-avatar').allTextContents(), ['ЮМ'])
      const ev = await page.evaluate((id) => window.__fakeDb.doc_check_request_audit_log.filter((l) => l.request_id === id).map((l) => l.event_type), created.id)
      assert.deepEqual(ev, ['created'])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('«В архив» у «Завершено», «Архив» с возвратом на доску', async () => {
    const { page, errors, close } = await openPage()
    try {
      await column(page, 'done').getByRole('button', { name: 'Отправить завершённые в архив' }).click()
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.filter((r) => r.status === 'done' && r.archived_at).length === 3)
      assert.equal((await counts(page)).done, 0)
      const archive = page.locator('.dc-mode-toggle', { hasText: 'Архив' })
      assert.equal(await archive.textContent(), 'Архив (3)')
      await archive.click()
      const ids = await page.locator('.dc-table tbody tr .dc-row-title').allTextContents()
      assert.deepEqual(ids.sort(), ['Подрядчик 01 / ДП № СУ2-004', 'Подрядчик 01 / ДП № СУ2-008', 'Подрядчик 02 / ДС № 5'])
      await page.locator('.dc-table tbody tr', { hasText: 'СУ2-004' }).getByRole('button', { name: 'Вернуть' }).click()
      await page.waitForFunction(() => !window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-4').archived_at)
      await page.getByRole('button', { name: 'К доске' }).click()
      assert.deepEqual(await cardsIn(page, 'done'), ['dcr-4'])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  const writes = (page) => page.evaluate(() => window.__supabaseStats.requests.filter((r) => r.table === 'doc_check_requests' && r.op === 'update').length)
  // Нажать на карточку (за верх: там заголовок) и повести; остальное — по шагам в самом тесте.
  const press = async (page, status, id) => {
    const b = await column(page, status).locator(`.dc-card[data-id="${id}"]`).boundingBox()
    await page.mouse.move(b.x + 60, b.y + 10)
    await page.mouse.down()
    return b
  }
  const boardLeft = (page) => page.locator('.dc-board').evaluate((el) => el.scrollLeft)

  it('перетаскивание: в другую колонку и на место перед карточкой; в «Сводку» не бросить', async () => {
    const { page, errors, close } = await openPage()
    try {
      await column(page, 'new').locator('.dc-card[data-id="dcr-1"]').dragTo(column(page, 'signal').locator('.dc-column-body'))
      await column(page, 'signal').locator('.dc-card[data-id="dcr-1"]').waitFor()
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-1').status === 'signal')
      // На верхнюю половину первой карточки «В работе» — встаёт перед ней; соседей двигать незачем: одна запись.
      const before = await writes(page)
      await column(page, 'in_progress').locator('.dc-card[data-id="dcr-2"]')
        .dragTo(column(page, 'in_progress').locator('.dc-card[data-id="dcr-3"]'), { targetPosition: { x: 40, y: 3 } })
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-2').sort_order === 3)
      assert.equal((await row(page, 'dcr-3')).sort_order, 2)
      assert.deepEqual(await cardsIn(page, 'in_progress'), ['dcr-2', 'dcr-3'])
      assert.equal(await writes(page) - before, 1)
      // В «Сводку» — ничего не меняется.
      await column(page, 'in_progress').locator('.dc-card[data-id="dcr-3"]').dragTo(column(page, 'summary').locator('.dc-column-body'))
      await page.waitForTimeout(150)
      assert.equal((await row(page, 'dcr-3')).status, 'in_progress')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('задел карточку: она не улетает вниз. Дрогнула рука — это щелчок; бросил на себя или в промежуток — порядок прежний, записей нет', async () => {
    const { page, errors, close } = await openPage()
    try {
      const order = ['dcr-3', 'dcr-2']
      assert.deepEqual(await cardsIn(page, 'in_progress'), order)
      const start = await writes(page)

      // Сдвиг меньше порога: щелчок открывает заявку.
      const a = await press(page, 'in_progress', 'dcr-3')
      await page.mouse.move(a.x + 63, a.y + 11)
      await page.mouse.up()
      const modal = page.locator('.dc-detail-modal')
      await modal.waitFor()
      await modal.getByRole('button', { name: 'Закрыть', exact: true }).last().click()
      await modal.waitFor({ state: 'detached' })

      // Сдвиг больше порога, отпустили на самой себе.
      const b = await press(page, 'in_progress', 'dcr-3')
      await page.mouse.move(b.x + 72, b.y + 16, { steps: 3 })
      await page.mouse.up()
      // В промежуток между карточками: раньше — конец колонки.
      const gapBox = await column(page, 'in_progress').locator('.dc-card[data-id="dcr-2"]').boundingBox()
      const c = await press(page, 'in_progress', 'dcr-3')
      await page.mouse.move(c.x + 60, gapBox.y - 2, { steps: 4 })
      await page.mouse.up()
      await page.waitForTimeout(100)
      assert.equal(await modal.count(), 0, 'отпускание после жеста заявку не открывает')
      // Escape над самой карточкой: кнопка отпущена уже над ней, но это не щелчок.
      const d = await press(page, 'in_progress', 'dcr-3')
      await page.mouse.move(d.x + 72, d.y + 16, { steps: 3 })
      await page.keyboard.press('Escape')
      await page.mouse.up()
      await page.waitForTimeout(100)

      assert.deepEqual(await cardsIn(page, 'in_progress'), order)
      assert.equal(await writes(page), start)
      assert.equal(await modal.count(), 0, 'отпускание после жеста заявку не открывает')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('предпросмотр: копия карточки едет за указателем, заглушка — там, куда встанет; Escape отменяет', async () => {
    const { page, errors, close } = await openPage()
    try {
      const start = await writes(page)
      const b = await press(page, 'in_progress', 'dcr-2')
      const edo = await column(page, 'edo').locator('.dc-column-body').boundingBox()
      await page.mouse.move(edo.x + 100, edo.y + 150, { steps: 8 })
      await page.waitForTimeout(50)

      const ghost = page.locator('.dc-board > .dc-drag-ghost')
      assert.equal(await ghost.count(), 1)
      assert.equal(await ghost.locator('.dc-card-name').textContent(), 'Подрядчик 02 / ДП № СУ2-001')
      const g = await ghost.boundingBox()
      assert.ok(Math.abs(g.x - (edo.x + 100 - 60)) < 12 && Math.abs(g.y - (edo.y + 150 - 10)) < 12, `копия у указателя: ${g.x}, ${g.y}`)
      assert.ok(Math.abs(g.width - b.width) < 12, 'копия размером с карточку')
      const slot = column(page, 'edo').locator('.dc-card-slot')
      assert.equal(await slot.count(), 1)
      assert.equal(Math.round((await slot.boundingBox()).height), Math.round(b.height), 'заглушка — высотой с карточку')
      assert.match(await column(page, 'edo').getAttribute('class'), /\bis-over\b/)
      assert.equal(await column(page, 'edo').locator('.dc-column-empty').count(), 0, '«Пусто» заглушке не мешает')
      assert.equal(await column(page, 'in_progress').locator('.dc-card[data-id="dcr-2"]').isVisible(), false, 'оригинал поднят')

      // Над «Сводкой» бросить нельзя: заглушка на прежнем месте, отпускание ничего не изменит.
      await column(page, 'summary').scrollIntoViewIfNeeded()
      const sum = await column(page, 'summary').boundingBox()
      await page.mouse.move(sum.x + 100, sum.y + 200, { steps: 3 })
      await page.waitForTimeout(50)
      assert.equal(await column(page, 'summary').locator('.dc-card-slot').count(), 0)
      assert.equal(await column(page, 'in_progress').locator('.dc-card-slot').count(), 1)

      await page.keyboard.press('Escape')
      assert.equal(await page.locator('.dc-drag-ghost, .dc-card-slot, .dc-gesture-veil').count(), 0)
      await page.mouse.up()
      await page.waitForTimeout(100)
      assert.equal(await writes(page), start, 'отмена ничего не пишет')
      assert.equal(await page.locator('.dc-detail-modal').count(), 0, 'отпускание после отмены заявку не открывает')
      assert.deepEqual(await cardsIn(page, 'in_progress'), ['dcr-3', 'dcr-2'])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('заглушка показывает место точно: верхняя половина карточки — перед ней, нижняя — после; бросок туда и встаёт', async () => {
    const { page, errors, close } = await openPage()
    try {
      const slotAt = () => column(page, 'in_progress').locator('.dc-column-body > *').evaluateAll((els) => els
        .map((el) => (el.classList.contains('dc-card-slot') ? 'место' : el.hidden ? null : el.dataset.card)).filter(Boolean))
      const third = await column(page, 'in_progress').locator('.dc-card[data-id="dcr-2"]').boundingBox()
      await press(page, 'new', 'dcr-1')
      await page.mouse.move(third.x + 40, third.y + 4, { steps: 4 })
      await page.waitForTimeout(50)
      assert.deepEqual(await slotAt(), ['dcr-3', 'место', 'dcr-2'])
      // Заглушка сдвинула карточку вниз: ведём к её нижней половине там, где она теперь.
      const moved = await column(page, 'in_progress').locator('.dc-card[data-id="dcr-2"]').boundingBox()
      await page.mouse.move(moved.x + 40, moved.y + moved.height - 3, { steps: 3 })
      await page.waitForTimeout(50)
      assert.deepEqual(await slotAt(), ['dcr-3', 'dcr-2', 'место'])
      await page.mouse.up()
      await column(page, 'in_progress').locator('.dc-card[data-id="dcr-1"]').waitFor()
      assert.deepEqual(await cardsIn(page, 'in_progress'), ['dcr-3', 'dcr-2', 'dcr-1'])
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-1').status === 'in_progress')
      assert.equal((await row(page, 'dcr-1')).sort_order, 0)
      const log = await page.evaluate(() => window.__fakeDb.doc_check_request_audit_log.map((l) => [l.request_id, l.event_type, l.new_value]))
      assert.deepEqual(log, [['dcr-1', 'status_changed', 'in_progress']])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('колонка за краем экрана: доска едет сама, карточка долетает до последней колонки', async () => {
    const { page, errors, close } = await openPage()
    try {
      assert.equal(await boardLeft(page), 0)
      await press(page, 'new', 'dcr-1')
      await page.mouse.move(1697, 400, { steps: 6 })
      await page.waitForFunction(() => {
        const el = document.querySelector('.dc-board')
        return el.scrollLeft >= el.scrollWidth - el.clientWidth - 1
      }, null, { timeout: 8000 })
      assert.match(await column(page, 'tax_clause').getAttribute('class'), /\bis-over\b/)
      await page.mouse.up()
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-1').status === 'tax_clause')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('прокрутка удержанием: тянуть за пустое место и шапку колонки; щелчок не срабатывает; положение переживает реестр', async () => {
    const { page, errors, close } = await openPage()
    try {
      const edo = await column(page, 'edo').locator('.dc-column-body').boundingBox()
      await page.mouse.move(edo.x + 200, edo.y + 300)
      await page.mouse.down()
      await page.mouse.move(edo.x + 100, edo.y + 300, { steps: 3 })
      assert.equal(await boardLeft(page), 100)
      assert.equal(await page.locator('.dc-board.is-panning').count(), 1)
      assert.equal(await page.locator('.dc-gesture-veil').evaluate((el) => getComputedStyle(el).cursor), 'grabbing')
      await page.mouse.up()
      assert.equal(await page.locator('.dc-gesture-veil').count(), 0)
      assert.equal(await boardLeft(page), 100)

      const head = await column(page, 'signal').locator('.dc-column-title').boundingBox()
      await page.mouse.move(head.x + 150, head.y + 5)
      await page.mouse.down()
      await page.mouse.move(head.x + 200, head.y + 5, { steps: 2 })
      await page.mouse.up()
      assert.equal(await boardLeft(page), 50, 'вправо — обратно')

      // Вертикальный сдвиг и нажатие на кнопку — не прокрутка.
      await page.mouse.move(edo.x + 100, edo.y + 300)
      await page.mouse.down()
      await page.mouse.move(edo.x + 100, edo.y + 500, { steps: 2 })
      await page.mouse.up()
      assert.equal(await boardLeft(page), 50)
      const add = column(page, 'signal').locator('.dc-column-add')
      const a = await add.boundingBox()
      await page.mouse.move(a.x + 3, a.y + 3)
      await page.mouse.down()
      await page.mouse.move(a.x - 80, a.y + 3, { steps: 2 })
      await page.mouse.up()
      assert.equal(await boardLeft(page), 50)
      assert.equal(await page.locator('.dc-form-modal').count(), 0)

      await page.waitForTimeout(200)
      await page.getByRole('tab', { name: 'Реестр' }).click()
      await page.getByRole('tab', { name: 'Доска' }).click()
      await page.locator('.dc-board').waitFor()
      assert.equal(await boardLeft(page), 50)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('без права правки карточка не двигается: за неё тоже можно тянуть доску, щелчок открывает заявку', async () => {
    const { page, errors, close } = await openPage('&canEdit=0')
    try {
      const start = await writes(page)
      const b = await column(page, 'in_progress').locator('.dc-card[data-id="dcr-2"]').boundingBox()
      await page.mouse.move(b.x + 60, b.y + 10)
      await page.mouse.down()
      await page.mouse.move(b.x - 20, b.y + 10, { steps: 3 })
      assert.equal(await page.locator('.dc-drag-ghost').count(), 0)
      assert.equal(await boardLeft(page), 80)
      await page.mouse.up()
      assert.equal(await page.locator('.dc-detail-modal').count(), 0, 'отпускание после прокрутки заявку не открывает')
      assert.equal(await writes(page), start)
      await column(page, 'in_progress').locator('.dc-card[data-id="dcr-2"]').click()
      await page.locator('.dc-detail-modal').waitFor()
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('при фильтре порядок скрытых карточек не страдает: номера считаются по всей колонке', async () => {
    const { page, errors, close } = await openPage('&docCheckMany=10')
    try {
      assert.deepEqual(await cardsIn(page, 'in_progress'), ['dcr-many-10', 'dcr-many-5', 'dcr-3', 'dcr-2'])
      await pickObject(page, 'Бизнес-центр')
      assert.deepEqual(await cardsIn(page, 'in_progress'), ['dcr-many-10', 'dcr-2'])

      // Между видимыми стоят скрытые. Из другой колонки — перед второй видимой: встаёт рядом с ней. По одним видимым соседям
      // номер вышел бы сразу за первой видимой: карточка встала бы среди скрытых и совпала бы номером с одной из них.
      const start = await writes(page)
      const second = await column(page, 'in_progress').locator('.dc-card[data-id="dcr-2"]').boundingBox()
      await press(page, 'done', 'dcr-5')
      await page.mouse.move(second.x + 40, second.y + 3, { steps: 4 })
      await page.mouse.up()
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-5').status === 'in_progress')
      // Сама карточка и один сосед снизу: между номерами 2 и 1 свободного нет.
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-2').sort_order === 0)
      assert.equal(await writes(page) - start, 2)
      await page.locator('.dc-reset').click()
      assert.deepEqual(await cardsIn(page, 'in_progress'), ['dcr-many-10', 'dcr-many-5', 'dcr-3', 'dcr-5', 'dcr-2'])

      // Видимую — в конец видимых: скрытые остаются на своих местах (раньше видимым раздавались номера 1, 2, 3).
      await pickObject(page, 'Бизнес-центр')
      const last = await column(page, 'in_progress').locator('.dc-card[data-id="dcr-2"]').boundingBox()
      await press(page, 'in_progress', 'dcr-many-10')
      await page.mouse.move(last.x + 40, last.y + last.height - 3, { steps: 4 })
      await page.mouse.up()
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-many-10').sort_order === -1)
      await page.locator('.dc-reset').click()
      assert.deepEqual(await cardsIn(page, 'in_progress'), ['dcr-many-5', 'dcr-3', 'dcr-5', 'dcr-2', 'dcr-many-10'])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('новые сверху: новая заявка — первой в колонке и в «Сводке»; внизу карточки — дата добавления без года', async () => {
    const { page, errors, close } = await openPage('&dcDates=1')
    try {
      assert.deepEqual(await cardsIn(page, 'in_progress'), ['dcr-3', 'dcr-2'])
      // В «Сводке» заявки разных колонок, номера несравнимы: у самой старой номер самый большой, а она внизу.
      assert.deepEqual(await cardsIn(page, 'summary'), ['dcr-6', 'dcr-2', 'dcr-7'])

      const chip = column(page, 'in_progress').locator('.dc-card[data-id="dcr-2"] .dc-card-foot .dc-chip--created')
      assert.equal(await chip.textContent(), '23.10')
      assert.equal(await chip.getAttribute('title'), 'Дата добавления: 23.10.2026')
      const look = await chip.evaluate((el) => ({
        weight: Number(getComputedStyle(el).fontWeight),
        neighbour: Number(getComputedStyle(el.parentElement.querySelector('.dc-chip--object')).fontWeight),
        background: getComputedStyle(el).backgroundColor,
      }))
      assert.ok(look.weight > look.neighbour, `плотнее соседних подписей: ${look.weight} и ${look.neighbour}`)
      assert.notEqual(look.background, 'rgba(0, 0, 0, 0)', 'на подложке')
      // Два исполнителя и длинное название объекта: дата всё равно рядом с объектом, карточка не растёт на строку.
      const apart = await page.locator('.dc-card').evaluateAll((els) => els.filter((el) => {
        const object = el.querySelector('.dc-chip--object').getBoundingClientRect()
        const date = el.querySelector('.dc-chip--created').getBoundingClientRect()
        return Math.abs(object.top - date.top) > 2
      }).map((el) => el.dataset.id))
      assert.deepEqual(apart, [])

      await column(page, 'in_progress').locator('.dc-column-add').click()
      const form = page.locator('.dc-form-modal')
      await form.getByRole('button', { name: 'ДП — Договор подряда' }).click()
      await form.locator('#dc-notes').fill('Свежая заявка')
      await form.getByRole('button', { name: 'Создать заявку' }).click()
      await form.waitFor({ state: 'detached' })
      const id = await page.evaluate(() => window.__fakeDb.doc_check_requests.find((r) => r.notes === 'Свежая заявка').id)
      await column(page, 'in_progress').locator(`.dc-card[data-id="${id}"]`).waitFor()
      assert.deepEqual(await cardsIn(page, 'in_progress'), [id, 'dcr-3', 'dcr-2'])
      assert.equal((await cardsIn(page, 'summary'))[0], id)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('перечитывание, начатое до переноса, не возвращает карточку обратно', async () => {
    const { page, errors, close } = await openPage()
    try {
      // Вернулись на вкладку браузера (перечитывание не чаще раза в 30 с) и сразу перенесли карточку.
      await page.evaluate(() => {
        const real = Date.now.bind(Date)
        Date.now = () => real() + 120000
        window.__fakeHold = ({ table, op }) => (table === 'doc_check_requests' && op === 'select' ? { delay: 500, stale: true } : {})
        window.dispatchEvent(new Event('focus'))
      })
      await column(page, 'new').locator('.dc-card[data-id="dcr-1"]').dragTo(column(page, 'signal').locator('.dc-column-body'))
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-1').status === 'signal')
      await page.waitForTimeout(800)
      assert.deepEqual(await cardsIn(page, 'signal'), ['dcr-1'])
      assert.deepEqual(await cardsIn(page, 'new'), [])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('перенос не перерисовывает доску: пока несут — ни одной карточки, после броска — только сдвинутые', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1700, height: 950 } })
    const page = await context.newPage()
    try {
      await page.addInitScript(() => {
        window.__cardRenders = 0
        // Как React DevTools: флаг PerformedWork, обход только изменившихся поддеревьев.
        const walk = (fiber, prev) => {
          if (fiber.type?.name === 'DocCheckCard' && (fiber.flags & 1)) window.__cardRenders++
          if (fiber.child !== prev?.child) {
            for (let c = fiber.child; c; c = c.sibling) walk(c, c.alternate)
          }
        }
        window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
          isDisabled: false,
          supportsFiber: true,
          renderers: new Map(),
          inject: () => 1,
          onCommitFiberUnmount: () => {},
          onPostCommitFiberRoot: () => {},
          onCommitFiberRoot: (_, root) => walk(root.current, root.current.alternate),
        }
      })
      await page.goto(`${stand.url}?route=/doc-check-requests&docCheck=1&latency=0&docCheckMany=200`)
      await page.locator('.dc-board').waitFor({ timeout: 120000 })
      await page.waitForFunction(() => window.__supabaseStats.active === 0)
      await page.waitForTimeout(300)
      await press(page, 'new', 'dcr-1')
      await page.evaluate(() => { window.__cardRenders = 0 })
      for (const status of ['in_progress', 'edo', 'signal', 'accounting']) {
        const body = await column(page, status).locator('.dc-column-body').boundingBox()
        await page.mouse.move(body.x + 60, body.y + 80, { steps: 3 })
        await page.waitForTimeout(40)
      }
      assert.equal(await page.evaluate(() => window.__cardRenders), 0, 'пока несут — карточки не перерисованы')
      await page.mouse.up()
      await column(page, 'accounting').locator('.dc-card[data-id="dcr-1"]').waitFor()
      assert.ok(await page.evaluate(() => window.__cardRenders) <= 2, 'после броска — только перенесённая')
    } finally {
      await context.close().catch(() => {})
    }
  })

  it('шапка низкая, доска — на всё окно, вплотную к меню; своей прокрутки у страницы нет, в реестре поля те же', async () => {
    const { page, errors, close } = await openPage('&shell=1&docCheckMany=120')
    try {
      const geo = await page.evaluate(() => {
        const main = document.querySelector('.main-content')
        const board = document.querySelector('.dc-board').getBoundingClientRect()
        const col = document.querySelector('.dc-column').getBoundingClientRect()
        return {
          scroll: main.scrollHeight - main.clientHeight,
          top: board.top,
          bottom: board.bottom,
          gap: col.left - main.getBoundingClientRect().left,
          columnBottom: col.bottom,
          innerHeight: window.innerHeight,
          page: document.documentElement.scrollHeight - window.innerHeight,
        }
      })
      assert.equal(geo.scroll, 0, 'страница не прокручивается: полоса доски всегда на экране')
      assert.equal(geo.page, 0)
      assert.ok(geo.top <= 100, `шапка над доской: ${geo.top} px (было 233)`)
      assert.equal(geo.bottom, geo.innerHeight, 'доска — до низа окна')
      assert.ok(geo.gap <= 10, `пустое место слева: ${geo.gap} px (было 52)`)
      assert.ok(geo.columnBottom >= geo.innerHeight - 16, 'колонка на всю высоту: бросить можно в любое её место')
      // В колонке со списком длиннее окна прокручивается она сама.
      const done = column(page, 'done').locator('.dc-column-body')
      assert.ok(await done.evaluate((el) => el.scrollHeight > el.clientHeight))
      // Длинное название колонки — в одну строку и целиком в подсказке.
      const heads = await page.locator('.dc-column-head').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)))
      assert.equal(new Set(heads).size, 1, `шапки колонок вровень: ${heads}`)
      assert.equal(await column(page, 'tax_clause').locator('.dc-column-title').getAttribute('title'),
        'Проверка документов (исключение налоговой оговорки)')

      await page.getByRole('tab', { name: 'Реестр' }).click()
      await page.locator('.dc-table').waitFor()
      assert.ok(await page.locator('.dc-table-wrap').evaluate((el) => el.getBoundingClientRect().left - document.querySelector('.main-content').getBoundingClientRect().left) <= 12)
      assert.ok(await page.locator('.main-content').evaluate((el) => el.scrollHeight > el.clientHeight), 'длинный реестр прокручивается')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('телефон: поля под полосой меню остаются, страница не шире экрана, касание открывает заявку, а не берёт карточку', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true })
    const page = await context.newPage()
    try {
      await page.goto(`${stand.url}?route=/doc-check-requests&docCheck=1&latency=0&shell=1`)
      await page.locator('.dc-board').waitFor({ timeout: 120000 })
      const geo = await page.evaluate(() => ({
        top: document.querySelector('.page-header').getBoundingClientRect().top,
        wide: document.documentElement.scrollWidth - window.innerWidth,
      }))
      assert.ok(geo.top >= 52, `шапка не под полосой меню: ${geo.top}`)
      assert.equal(geo.wide, 0)
      await column(page, 'in_progress').locator('.dc-card[data-id="dcr-2"]').tap()
      await page.locator('.dc-detail-modal').waitFor()
      assert.equal(await page.locator('.dc-drag-ghost').count(), 0)
    } finally {
      await context.close().catch(() => {})
    }
  })

  it('«Удалённые»: кто и когда удалил, последние сверху; нет записи в истории — так и сказано; в окне заявки — то же, без «Удалить»', async () => {
    const { page, errors, close } = await openPage()
    try {
      // Удалить с доски: кто вошёл, тот и записан. Раньше её уже удаляли и восстанавливали: важна последняя запись.
      await column(page, 'new').locator('.dc-card[data-id="dcr-1"] .dc-card-more').click()
      await page.locator('.dc-menu .dc-menu-item.is-danger').click()
      await page.waitForFunction(() => window.__fakeDb.doc_check_request_audit_log.some((l) => l.request_id === 'dcr-1' && l.event_type === 'soft_deleted'))
      await page.evaluate(() => {
        // Время записи ставит база (значение колонки по умолчанию), стенд их не знает.
        window.__fakeDb.doc_check_request_audit_log.find((l) => l.request_id === 'dcr-1').changed_at = new Date().toISOString()
        window.__fakeDb.doc_check_request_audit_log.push(
          { id: 'l-1', request_id: 'dcr-1', event_type: 'soft_deleted', changed_by_name: 'Прежний Удаливший', changed_at: '2026-01-01T10:00:00Z' },
          { id: 'l-2', request_id: 'dcr-1', event_type: 'restored', changed_by_name: 'Вернувший', changed_at: '2026-01-02T10:00:00Z' },
        )
      })

      await page.locator('.dc-mode-toggle--deleted').click()
      const rows = page.locator('.dc-table tbody tr')
      await rows.first().locator('.dc-col-deleted').getByText('Тест').waitFor()
      assert.deepEqual(await page.locator('.dc-table thead th').allTextContents(),
        ['Документ', 'Объект', 'Исполнители', 'Срок', 'Статус', 'Метки', 'Создал', 'Удалил', ''])
      // Последние удалённые — сверху; у dcr-9 в истории записи нет.
      assert.deepEqual(await rows.locator('.dc-row-title').allTextContents(), ['Подрядчик 01 / ДС № 1', 'Подрядчик 01 / ДС № 9'])
      assert.match(await rows.nth(0).locator('.dc-col-deleted').textContent(), /^Тест\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/)
      assert.match(await rows.nth(1).locator('.dc-col-deleted').textContent(), /^не записано26\.10\.2026, \d{2}:\d{2}$/)

      // Окно заявки: то же; удалённую не правят и не удаляют снова — вторая запись подменила бы, кто её удалил.
      await rows.nth(0).click()
      const modal = page.locator('.dc-detail-modal')
      await modal.waitFor()
      assert.equal(await modal.locator('.dc-row-kv', { hasText: 'Удалил' }).locator('dd').textContent(), 'Тест')
      assert.equal(await modal.getByRole('button', { name: 'Удалить' }).count(), 0)
      assert.equal(await modal.getByRole('button', { name: 'Изменить' }).count(), 0)
      assert.equal(await modal.locator('.dc-status-opt:not([disabled])').count(), 0)
      await modal.getByRole('button', { name: 'Закрыть' }).last().click()
      await modal.waitFor({ state: 'detached' })

      await rows.nth(0).getByRole('button', { name: 'Восстановить' }).click()
      await page.waitForFunction(() => !window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-1').deleted_at)
      assert.equal(await rows.count(), 1)

      // Фильтры видны и здесь: пусто из-за них — так и сказано.
      await page.locator('.dc-search').fill('нет такого')
      assert.match(await page.locator('.dc-empty').textContent(), /Ничего не найдено/)
      await page.locator('.dc-search').fill('')

      // В «Архиве» столбца нет.
      await page.locator('.dc-mode-toggle', { hasText: 'Архив' }).click()
      assert.ok(!(await page.locator('.dc-table thead th').allTextContents()).includes('Удалил'))
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('колонок миграции 20261113 ещё нет: доска как раньше, без ошибок и без новых полей', async () => {
    const { page, errors, close } = await openPage('&docCheckLegacy=1')
    try {
      const statuses = await page.locator('.dc-column').evaluateAll((els) => els.map((el) => el.dataset.status))
      assert.ok(!statuses.includes('tax_clause'))
      assert.ok(statuses.includes('summary'))
      assert.equal((await counts(page)).in_progress, 2)
      assert.equal(await page.locator('.dc-mode-toggle', { hasText: 'Архив' }).count(), 0)
      assert.equal(await page.locator('.dc-card .dc-avatar, .dc-card .dc-due').count(), 0)
      assert.match(await page.locator('.dc-note').textContent(), /20261113_doc_check_board/)
      await column(page, 'new').locator('.dc-card[data-id="dcr-1"] .dc-card-more').click()
      assert.equal(await page.locator('.dc-menu .dc-swatch').count(), 0)
      assert.equal(await page.locator('.dc-menu', { hasText: 'В архив' }).count(), 0)
      await page.keyboard.press('Escape')
      await column(page, 'new').locator('.dc-column-add').click()
      assert.equal(await page.locator('.dc-form-modal', { hasText: 'Исполнители' }).count(), 0)
      await page.locator('.dc-form-modal #dc-notes').fill('Без новых полей')
      await page.locator('.dc-form-modal').getByRole('button', { name: 'Создать заявку' }).click()
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.some((r) => r.notes === 'Без новых полей'))
      const created = await page.evaluate(() => window.__fakeDb.doc_check_requests.find((r) => r.notes === 'Без новых полей'))
      assert.ok(!('labels' in created) && !('assignee_ids' in created), 'прежней базе новые поля не шлются')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('без права правки: только просмотр', async () => {
    const { page, errors, close } = await openPage('&canEdit=0')
    try {
      assert.equal(await page.locator('.dc-column-add, .dc-card-more, button.dc-card-check').count(), 0)
      assert.equal(await page.getByRole('button', { name: '+ Новая заявка' }).count(), 0)
      assert.equal(await page.locator('.dc-card.is-movable').count(), 0)
      await column(page, 'in_progress').locator('.dc-card[data-id="dcr-2"]').click()
      await page.locator('.dc-detail-modal').waitFor()
      assert.equal(await page.locator('.dc-detail-modal .dc-status-opt:not([disabled])').count(), 0)
      assert.deepEqual(await page.locator('.dc-detail-modal .dc-detail-people .dc-person-name').allTextContents(), ['Юристова Мария Андреевна'])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
