// «Заявки на проверку ДП/ДС» — доска по образцу прежней доски отдела (миграция 20261113): правила без браузера и
// страница в Chromium (стенд tests/tender/ui, route=/doc-check-requests&docCheck=1).
//   • колонки от «Новых заявок» до «Проверки документов (исключение налоговой оговорки)», «Сводка по ДП» —
//     выборка ДП не из «Завершено»; карточка: «Контрагент / ДС № 1» с примечанием, объект, метки, срок,
//     приоритет, файлы, кружки исполнителей, цвет; просроченная — красной рамкой;
//   • кружок «завершить», меню карточки (цвет, перенос в колонку, архив), «+ Добавить заявку» в колонке,
//     «В архив» у «Завершено» и «Архив» с возвратом, перетаскивание; в базу — только сменившийся порядок;
//   • быстрый отбор: объекты над доской, «Мои заявки»;
//   • колонок 20261113 ещё нет — доска как раньше, без ошибок; без права правки — только просмотр.
// Люди стенда вымышленные.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  DEFAULT_SUMMARY, avatarTone, boardColumns, dueState, fieldEvents, initials, labelSuggestions, matchesDeadline,
  matchesSummary, nextSortOrder, normalizeLabels, normalizeSummary, reorderUpdates, AVATAR_TONES, cardTitle,
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

  it('порядок: в базу — только сменившиеся номера; конец колонки — без архива и удалённых', () => {
    const rows = [{ id: 'a', sort_order: 1 }, { id: 'b', sort_order: 2 }, { id: 'c', sort_order: 3 }]
    assert.deepEqual(reorderUpdates(rows, ['a', 'b', 'c', 'x']), [{ id: 'x', sort_order: 4 }])
    assert.deepEqual(reorderUpdates(rows, ['b', 'a', 'c']), [{ id: 'b', sort_order: 1 }, { id: 'a', sort_order: 2 }])
    assert.equal(nextSortOrder([
      { status: 'done', sort_order: 3 }, { status: 'done', sort_order: 9, archived_at: '2026-10-01' },
      { status: 'done', sort_order: 7, deleted_at: '2026-10-01' }, { status: 'new', sort_order: 5 },
    ], 'done'), 4)
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
      assert.deepEqual(await card.locator('.dc-avatar').allTextContents(), ['ПП', 'ЮМ'])
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

  it('быстрый отбор: объект над доской и «Мои заявки»; поиск — по метке', async () => {
    const { page, errors, close } = await openPage()
    try {
      const chips = await page.locator('.dc-quick-chip').allTextContents()
      assert.deepEqual(chips, ['Мои заявки', 'ЖК «Северный квартал»4', 'Бизнес-центр «Нурлы»3'])
      await page.locator('.dc-quick-chip', { hasText: 'Бизнес-центр' }).click()
      assert.deepEqual((await counts(page)).in_progress, 1)
      assert.deepEqual(await cardsIn(page, 'in_progress'), ['dcr-2'])
      await page.locator('.dc-reset').click()
      await page.locator('.dc-quick-chip', { hasText: 'Мои заявки' }).click()
      assert.deepEqual(await page.locator('.dc-card').evaluateAll((els) => els.map((el) => el.dataset.id)), ['dcr-1'])
      await page.locator('.dc-quick-chip', { hasText: 'Мои заявки' }).click()
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
      assert.equal((await cardsIn(page, 'done')).at(-1), 'dcr-3', 'в конец колонки')
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

  it('перетаскивание: в другую колонку и на место перед карточкой; в «Сводку» не бросить', async () => {
    const { page, errors, close } = await openPage()
    try {
      const writes = () => page.evaluate(() => window.__supabaseStats.requests.filter((r) => r.table === 'doc_check_requests' && r.op === 'update').length)
      await column(page, 'new').locator('.dc-card[data-id="dcr-1"]').dragTo(column(page, 'signal').locator('.dc-column-body'))
      await column(page, 'signal').locator('.dc-card[data-id="dcr-1"]').waitFor()
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-1').status === 'signal')
      // Перед первой карточкой «В работе»: переписаны только сдвинутые.
      const before = await writes()
      await column(page, 'in_progress').locator('.dc-card[data-id="dcr-3"]')
        .dragTo(column(page, 'in_progress').locator('.dc-card[data-id="dcr-2"]'))
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-2').sort_order === 2)
      assert.equal((await row(page, 'dcr-3')).sort_order, 1)
      assert.deepEqual(await cardsIn(page, 'in_progress'), ['dcr-3', 'dcr-2'])
      assert.equal(await writes() - before, 2)
      // В «Сводку» — ничего не меняется.
      await column(page, 'in_progress').locator('.dc-card[data-id="dcr-3"]').dragTo(column(page, 'summary').locator('.dc-column-body'))
      await page.waitForTimeout(150)
      assert.equal((await row(page, 'dcr-3')).status, 'in_progress')
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
      assert.equal(await page.locator('.dc-card[draggable="true"]').count(), 0)
      await column(page, 'in_progress').locator('.dc-card[data-id="dcr-2"]').click()
      await page.locator('.dc-detail-modal').waitFor()
      assert.equal(await page.locator('.dc-detail-modal .dc-status-opt:not([disabled])').count(), 0)
      assert.match(await page.locator('.dc-detail-modal .dc-detail-people').textContent(), /Петров П\. П\., Юристова Мария Андреевна/)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
