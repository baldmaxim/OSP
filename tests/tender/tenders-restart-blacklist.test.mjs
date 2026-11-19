// Решения пользователя 06.11.2026:
//  1) статус тендера «Перезапуск» — процедура закончена (сроки не горят), своя вкладка и цвет; уже перезапущенные отмечает
//     разовый скрипт migration/data/20261106_tenders_restart_status.sql;
//  2) «ЧС» маленькой плашкой с красной обводкой рядом с названием участника и победителя из чёрного списка — в «Тендерах»;
//  3) «История участия» карточки контрагента: в «№» — номер тендера, а не номер строки;
//  4) «Договорные расценки (Larix)»: счётчики подвкладок с разрядами («2 511»), и сказано, почему «Материалы» + «Работы»
//     больше «Всех позиций» (позиция с обеими ценами — в обеих).
// Стенд tests/tender/ui: restartBl=1 — tender-2 (№ 199) «Перезапуск», cp-2 в чёрном списке (участник tender-1, победитель
// tender-5 № 196); вкладка Larix — kp-registry-stand (larixMany=N).
// 18.11.2026: «Перезапуск» с выбором нового тендера (миграция 20270217) — стенд restartLink=1 (колонка есть; у № 194 в
// примечании «Перезапуск тендера № 198»), restartPair=1 — № 197 «Перезапуск», заменён № 200.
// 19.11.2026: и наоборот — в форме «Добавить новый тендер» галочка «Перезапуск тендера» и выбор прежнего: после создания прежнему —
// «Перезапуск» и ссылка на новый (тот же путь, что окно).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { mainTenderStatuses, isClosedMainStatus, RESTART_STATUS } from '../../src/utils/tenderStatuses.js'
import {
  buildRestartIndex, restartCandidates, restartTargetId, mentionsRestartOf, hasRestartLink, restartSourceCandidates, restartSourceLabel,
} from '../../src/utils/tenderRestart.js'
import { tenderWinnersOf } from '../../src/utils/tenderWinners.js'
import { fmtCount } from '../../src/utils/ratesRegistry.js'

const launch = browserLaunchOptions()
const text = (s) => String(s).replace(/\s+/g, ' ').trim()

describe('Перезапуск, «ЧС», счётчики — правила', () => {
  it('«Перезапуск» — статус каждого направления, процедура по нему закончена', () => {
    for (const dept of ['construction', 'warranty', 'joint', 'other']) {
      assert.ok(mainTenderStatuses(dept).includes(RESTART_STATUS), dept)
    }
    assert.equal(RESTART_STATUS, 'Перезапуск')
    assert.equal(isClosedMainStatus('Перезапуск'), true)
    assert.equal(isClosedMainStatus('Завершен'), true)
    assert.equal(isClosedMainStatus('Приостановка тендера'), false)
    assert.equal(isClosedMainStatus('Подведение итогов'), false)
  })

  it('победитель несёт статус контрагента (для «ЧС»)', () => {
    assert.deepEqual(tenderWinnersOf({ tender_winners: [{ counterparty_id: 'a', scope_note: 'к. 1', counterparties: { id: 'a', name: 'А', status: 'blacklist' } }] }),
      [{ id: 'a', name: 'А', scope: 'к. 1', status: 'blacklist' }])
    assert.equal(tenderWinnersOf({ tender_winners: [], winner: { id: 'b', name: 'Б' } })[0].status, null)
  })

  it('число позиций — с разрядами', () => {
    assert.equal(text(fmtCount(46323)), '46 323')
    assert.equal(fmtCount(0), '0')
    assert.equal(fmtCount(null), '0')
  })
})

describe('Перезапуск, «ЧС», № тендера, счётчики Larix — страница', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 600000 }, () => {
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

  const open = async (query, viewport = { width: 1600, height: 1000 }) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => { errors.push(`окно: ${d.message()}`); d.accept() })
    await page.goto(`${stand.url}?latency=0&${query}`)
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const registryRow = (page, num) => page.locator('table.tenders-registry > tbody > tr', { has: page.locator('td.tp-num', { hasText: new RegExp(`^${num}(?!\\d)`) }) })

  it('реестр ОС: «Перезапуск» — цвет, вкладка, без просрочки; «ЧС» у участника и победителя', async () => {
    const { page, errors, close } = await open('route=/tenders/construction&tenders=10&items=20&cps=4&restartBl=1')
    try {
      await page.locator('table.tenders-registry > tbody > tr').first().waitFor({ timeout: 120000 })

      const restarted = registryRow(page, 199)
      const trigger = restarted.getByRole('button', { name: 'Статус тендера' })
      assert.equal(text((await trigger.innerText()).replace('▾', '')), RESTART_STATUS)
      assert.match(await trigger.getAttribute('class'), /\bstatus-restarted\b/)
      assert.doesNotMatch(await restarted.getAttribute('class') || '', /overdue-row/, 'срок прошёл, но процедура закончена')
      assert.equal(await restarted.locator('td.tender-period-cell.is-overdue').count(), 0)
      // Цвет — свой, не «по умолчанию».
      const bg = await trigger.evaluate((el) => getComputedStyle(el).backgroundColor)
      assert.equal(bg, 'rgb(253, 242, 248)')

      await trigger.click()
      const options = await page.locator('.status-dropdown-menu-portal .status-dropdown-option-label').allInnerTexts()
      assert.deepEqual(options, mainTenderStatuses('construction'))
      await page.keyboard.press('Escape')

      await page.getByRole('button', { name: /Статусы тендеров/ }).click()
      assert.equal(text(await page.locator('.tender-tab-status', { hasText: RESTART_STATUS }).innerText()), `${RESTART_STATUS} 1`)

      // Участники № 200: «ЧС» только у Подрядчика 02.
      await registryRow(page, 200).locator('.expand-toggle').click()
      const names = page.locator('.expanded-cp-table-wrap td.tc-company-cell .tc-company-name')
      await names.first().waitFor({ timeout: 30000 })
      const marks = await names.evaluateAll((els) => els.map((el) => [el.firstChild?.textContent?.trim(), el.querySelector('.bl-mark')?.textContent || '']))
      assert.deepEqual(marks.map(([, m]) => m), ['', 'ЧС', '', ''])
      assert.equal(marks[1][0], 'Подрядчик 02')
      const mark = names.nth(1).locator('.bl-mark')
      const style = await mark.evaluate((el) => {
        const cs = getComputedStyle(el)
        return { border: cs.borderTopStyle, borderColor: cs.borderTopColor, color: cs.color, size: cs.fontSize }
      })
      assert.equal(style.border, 'solid')
      assert.equal(style.borderColor, style.color, 'обводка цветом текста')
      assert.equal(style.color, 'rgb(220, 38, 38)')
      assert.equal(style.size, '11px')

      // Вкладка «Завершен»: победитель № 196 — с «ЧС».
      await page.locator('.tender-tab-status', { hasText: /^Завершен/ }).click()
      const winner = registryRow(page, 196).locator('.winner-name')
      await winner.waitFor({ timeout: 30000 })
      assert.equal(await winner.locator('.bl-mark').innerText(), 'ЧС')
      // «Перезапуск» — своя вкладка, не в «Завершен».
      assert.equal(await registryRow(page, 199).count(), 0)
      await page.locator('.tender-tab-status', { hasText: RESTART_STATUS }).click()
      await registryRow(page, 199).waitFor({ timeout: 30000 })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('карточка тендера: «ЧС» у участника, «Перезапуск» — своим цветом', async () => {
    const { page, errors, close } = await open('route=/tenders/tender-1&items=20&cps=4&restartBl=1')
    try {
      await page.locator('.tender-tab', { hasText: 'Участники' }).click({ timeout: 120000 })
      const row = page.locator('.participants-section tbody tr').filter({ hasText: 'Подрядчик 02' })
      await row.waitFor({ timeout: 30000 })
      assert.equal(await row.locator('.tc-company-name .bl-mark').innerText(), 'ЧС')
      assert.equal(await page.locator('.participants-section .bl-mark').count(), 1)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
    const card = await open('route=/tenders/tender-2&items=20&cps=4&restartBl=1')
    try {
      const badge = card.page.locator('.status-badge', { hasText: RESTART_STATUS }).first()
      await badge.waitFor({ timeout: 120000 })
      assert.match(await badge.getAttribute('class'), /\bstatus-restarted\b/)
      assert.deepEqual(card.errors, [])
    } finally {
      await card.close()
    }
  })

  it('карточка контрагента: «№» в истории участия — номер тендера', async () => {
    const { page, errors, close } = await open('route=/general/counterparties&cps=6&cpContacts=1&items=20')
    try {
      const row = page.locator('table.compact-table tbody tr.table-row', { hasText: 'Подрядчик 01' })
      await row.waitFor({ timeout: 120000 })
      await row.locator('.company-name').click()
      await page.locator('.cp-detail-tab', { hasText: 'История участия' }).click()
      const nums = page.locator('.tender-history-table tbody td.tender-history-num')
      await nums.first().waitFor({ timeout: 30000 })
      const shown = (await nums.allInnerTexts()).map(Number).sort((a, b) => b - a)
      // cp-1 участвовал в tender-2 … tender-9 стенда — № 199 … 192, а не 1 … 8.
      assert.deepEqual(shown, [199, 198, 197, 196, 195, 194, 193, 192])
      assert.equal(await page.locator('.tender-history-table thead th.th-num').getAttribute('title'), 'Номер тендера')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
    // Телефон — карточками: номер перед объектом.
    const phone = await open('route=/general/counterparties&cps=6&cpContacts=1&items=20', { width: 390, height: 800 })
    try {
      const open1 = phone.page.locator('.cp-mrow-open', { hasText: 'Подрядчик 01' })
      await open1.waitFor({ timeout: 120000 })
      await open1.click()
      await phone.page.locator('.cp-detail-tab', { hasText: 'История участия' }).click()
      const first = phone.page.locator('.cp-history-card-no').first()
      await first.waitFor({ timeout: 30000 })
      assert.match(text(await first.innerText()), /^№ 19\d$/)
      assert.deepEqual(phone.errors, [])
    } finally {
      await phone.close()
    }
  })

  it('«Договорные расценки (Larix)»: счётчики с разрядами и пояснение про обе цены', async () => {
    const { page, errors, close } = await open('route=/rates-registry&maxRows=1000&larixMany=2500')
    try {
      await page.getByRole('tab', { name: 'Договорные расценки (Larix)' }).click()
      const pill = (label) => page.locator('.rr-sub-tab', { hasText: label }).locator('.rr-sub-count')
      await page.waitForFunction(() => /\d/.test(document.querySelector('.rr-sub-tab .rr-sub-count')?.textContent || ''), null, { timeout: 120000 })
      // 11 строк стенда + 2 500: цена материалов — у 2 509, работ — у 3, обе — у 1.
      assert.equal(text(await pill('Все позиции').innerText()), '2 511')
      assert.equal(text(await pill('Материалы').innerText()), '2 509')
      assert.equal(text(await pill('Работы').innerText()), '3')
      assert.equal(text(await page.locator('.rr-sub-note').innerText()), 'у 1 позиции обе цены — они и в «Материалах», и в «Работах»')
      assert.match(text(await page.locator('.rr-pagination-info').innerText()), /^1–100 из 2 511$/)
      // Подвкладка — отбор по наличию цены.
      await page.locator('.rr-sub-tab', { hasText: 'Работы' }).click()
      await page.waitForFunction(() => /из 3$/.test((document.querySelector('.rr-pagination-info')?.textContent || '').trim()))
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})

describe('Перезапуск: какой тендер заменил — правила', () => {
  const t = (id, n, extra = {}) => ({ id, public_tender_number: n, status: 'Подготовка ВОР', tender_type: 'main', deleted_at: null,
    restarted_by_tender_id: null, object_id: 'o1', work_description: 'Фасад', notes: '', ...extra })

  it('ссылка действует, только пока тендер в «Перезапуске»; на себя — не ссылка', () => {
    assert.equal(restartTargetId(t('a', 40, { status: 'Перезапуск', restarted_by_tender_id: 'b' })), 'b')
    assert.equal(restartTargetId(t('a', 40, { status: 'Завершен', restarted_by_tender_id: 'b' })), null)
    assert.equal(restartTargetId(t('a', 40, { status: 'Перезапуск', restarted_by_tender_id: 'a' })), null)
    assert.equal(hasRestartLink({ id: 'x' }), false, 'колонки нет — база до 20270217')
    assert.equal(hasRestartLink(t('a', 40)), true)
  })

  it('индекс: новый заменил несколько прежних (по номеру); удалённые не в счёт', () => {
    const list = [
      t('n', 733), t('p81', 81, { status: 'Перезапуск', restarted_by_tender_id: 'n' }),
      t('p73', 73, { status: 'Перезапуск', restarted_by_tender_id: 'n' }),
      t('gone', 70, { status: 'Перезапуск', restarted_by_tender_id: 'n', deleted_at: '2026-11-01' }),
      t('was', 60, { status: 'Подведение итогов', restarted_by_tender_id: 'n' }),
    ]
    const idx = buildRestartIndex(list)
    assert.deepEqual(idx.restartedFrom.get('n').map(x => x.public_tender_number), [73, 81], 'прежний в корзине — не в счёт')
    assert.equal(idx.byId.get('gone').public_tender_number, 70, 'номер удалённого находится (у прежнего — «заменён № …»)')
  })

  it('кандидаты: называющие номер — первыми, затем того же объекта, новые выше; поиск по номеру и тексту', () => {
    const old = t('old', 198, { status: 'Перезапуск' })
    const list = [old,
      t('a', 300, { object_id: 'o2' }), t('b', 250), t('c', 194, { object_id: 'o2', notes: 'Перезапуск тендера № 198' }),
      t('d', 260, { object_id: 'o2', notes: 'перезапуск № 1980' }), t('m', 400, { tender_type: 'materials' }),
      t('del', 500, { deleted_at: '2026-11-01' })]
    assert.equal(mentionsRestartOf(list[3], 198), true)
    assert.equal(mentionsRestartOf(list[4], 198), false, '1980 — другой номер')
    assert.deepEqual(restartCandidates(old, list).map(c => c.tender.public_tender_number), [194, 250, 300, 260])
    assert.deepEqual(restartCandidates(old, list, '№ 26').map(c => c.tender.public_tender_number), [260])
    assert.deepEqual(restartCandidates(old, list, 'фасад 194').map(c => c.tender.public_tender_number), [194])
    // Кого он сам заменил — не предлагается (круг).
    const replaced = t('r', 120, { status: 'Перезапуск', restarted_by_tender_id: 'old' })
    assert.ok(!restartCandidates(old, [...list, replaced]).some(c => c.tender.id === 'r'))
  })

  it('форма нового тендера: какой прежний он перезапускает — без удалённых, материалов и уже заменённых; свой объект выше', () => {
    const list = [
      t('a', 300, { object_id: 'o2' }), t('b', 250), t('c', 194, { object_id: 'o2' }),
      t('r', 120, { status: 'Перезапуск', restarted_by_tender_id: 'a' }), // уже заменён № 300
      t('free', 110, { status: 'Перезапуск' }), // «Перезапуск» без нового — можно указать
      t('m', 400, { tender_type: 'materials' }), t('del', 500, { deleted_at: '2026-11-01' }),
    ]
    assert.deepEqual(restartSourceCandidates(list).map(x => x.public_tender_number), [300, 250, 194, 110])
    assert.deepEqual(restartSourceCandidates(list, 'o2').map(x => x.public_tender_number), [300, 194, 250, 110])
    assert.equal(restartSourceLabel(t('b', 250, { status: 'Завершен' }), 'ЖК «Альфа»'), '№ 250 · ЖК «Альфа» · Фасад (Завершен)')
    assert.equal(restartSourceLabel(t('x', null, { work_description: '', status: null }), ''), '№ — · Объект не указан')
  })
})

describe('Перезапуск: какой тендер заменил — страница', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 600000 }, () => {
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

  const open = async (query, viewport = { width: 1600, height: 1000 }) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => { errors.push(`окно: ${d.message()}`); d.accept() })
    await page.goto(`${stand.url}?latency=0&${query}`)
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const registryRow = (page, num) => page.locator('table.tenders-registry > tbody > tr', { has: page.locator('td.tp-num', { hasText: new RegExp(`^${num}(?!\\d)`) }) })
  const fakeTender = (page, id) => page.evaluate((x) => {
    const r = window.__fakeDb.tenders.find((q) => q.id === x)
    return { status: r.status, link: r.restarted_by_tender_id }
  }, id)
  const pickStatus = async (page, num, status) => {
    await registryRow(page, num).getByRole('button', { name: 'Статус тендера' }).click()
    await page.locator('.status-dropdown-menu-portal .status-dropdown-option', { hasText: status }).click()
  }

  it('«Перезапуск» в реестре ОС: окно выбора нового тендера, отметки у обоих номеров, ссылка в прежний', async () => {
    const { page, errors, close } = await open('route=/tenders/construction&tenders=10&items=20&cps=4&restartLink=1')
    try {
      await registryRow(page, 198).waitFor({ timeout: 120000 })
      assert.equal(await page.locator('.trs-mark').count(), 0, 'связей ещё нет — отметок нет')

      // Отмена: статус не меняется.
      await pickStatus(page, 197, RESTART_STATUS)
      const dialog = page.locator('.trs-dialog')
      await dialog.waitFor()
      assert.equal(text(await dialog.locator('h3').innerText()), 'Перезапуск тендера № 197')
      await dialog.getByRole('button', { name: 'Отмена' }).click()
      await dialog.waitFor({ state: 'detached' })
      assert.deepEqual(await fakeTender(page, 'tender-4'), { status: 'Подведение итогов', link: null })

      await pickStatus(page, 198, RESTART_STATUS)
      await dialog.waitFor()
      assert.equal(text(await dialog.locator('h3').innerText()), 'Перезапуск тендера № 198')
      // Первым — тендер, который сам называет № 198 (примечание № 194), затем того же объекта.
      const first = dialog.locator('.trs-opt:not(.trs-opt--none)').first()
      assert.equal(text(await first.locator('.trs-opt-num').innerText()), '№ 194')
      assert.equal(text(await first.locator('.trs-opt-hint').innerText()), 'называет № 198')
      assert.equal(await dialog.locator('.trs-opt-num', { hasText: /^№ 198$/ }).count(), 0, 'себя в списке нет')
      assert.equal(text(await dialog.locator('.trs-btn--primary').innerText()), 'Перезапуск без нового тендера')
      await dialog.getByRole('searchbox').fill('200')
      assert.deepEqual(await dialog.locator('.trs-opt-num').allInnerTexts(), ['№ 200'])
      await dialog.locator('.trs-opt', { hasText: '№ 200' }).click()
      assert.equal(text(await dialog.locator('.trs-btn--primary').innerText()), 'Перезапуск → № 200')
      await dialog.locator('.trs-btn--primary').click()
      await dialog.waitFor({ state: 'detached' })
      await page.waitForFunction(() => window.__fakeDb.tenders.find((r) => r.id === 'tender-3').restarted_by_tender_id === 'tender-1')
      assert.deepEqual(await fakeTender(page, 'tender-3'), { status: RESTART_STATUS, link: 'tender-1' })
      const log = await page.evaluate(() => window.__fakeDb.tender_audit_log.filter((l) => l.tender_id === 'tender-3')
        .map((l) => [l.event_type, l.description]))
      assert.deepEqual(log, [['status_changed', 'Статус: Идет тендерная процедура → Перезапуск'], ['field_updated', 'Перезапущен тендером № 200']])

      // У нового (№ 200) — «перезапуск № 198», мельче и тише номера; номер — ссылка в прежний.
      const mark = registryRow(page, 200).locator('.trs-mark--from')
      await mark.waitFor({ timeout: 30000 })
      assert.equal(text(await mark.innerText()), 'перезапуск № 198')
      assert.equal(await mark.locator('a.trs-num').getAttribute('href'), '/tenders/tender-3')
      const sizes = await registryRow(page, 200).evaluate((tr) => [
        parseFloat(getComputedStyle(tr.querySelector('.tp-num-value')).fontSize),
        parseFloat(getComputedStyle(tr.querySelector('.trs-mark')).fontSize)])
      assert.ok(sizes[1] < sizes[0], `отметка мельче номера: ${sizes}`)
      // Номер 200 в узкой колонке не переносится, отметка не вылезает из ячейки.
      const fits = await registryRow(page, 200).locator('td.tp-num').evaluate((td) => td.scrollWidth <= td.clientWidth + 1)
      assert.ok(fits, 'отметка помещается в колонку «№»')
      // У прежнего (№ 198) — «заменён № 200».
      assert.equal(text(await registryRow(page, 198).locator('.trs-mark--to').innerText()), 'заменён № 200')

      // Сменить: карандаш у прежнего — то же окно, статус не трогается; «Не указан» снимает ссылку.
      await registryRow(page, 198).locator('.trs-edit').click()
      await dialog.waitFor()
      assert.equal(text(await dialog.locator('h3').innerText()), 'Тендер № 198: каким тендером перезапущен')
      assert.equal(await dialog.locator('.trs-opt.is-picked .trs-opt-num').innerText(), '№ 200')
      await dialog.locator('.trs-opt--none').click()
      await dialog.locator('.trs-btn--primary', { hasText: 'Сохранить' }).click()
      await dialog.waitFor({ state: 'detached' })
      await page.waitForFunction(() => window.__fakeDb.tenders.find((r) => r.id === 'tender-3').restarted_by_tender_id === null)
      await registryRow(page, 200).locator('.trs-mark').waitFor({ state: 'detached' })
      // Не указан — у прежнего «+ новый тендер» (у кого правка тендеров).
      await registryRow(page, 198).locator('.trs-add').click()
      await dialog.waitFor()
      await dialog.locator('.trs-opt', { hasText: '№ 194' }).click()
      await dialog.locator('.trs-btn--primary').click()
      await page.waitForFunction(() => window.__fakeDb.tenders.find((r) => r.id === 'tender-3').restarted_by_tender_id === 'tender-7')
      await registryRow(page, 194).locator('.trs-mark--from').waitFor()

      // Статус ушёл из «Перезапуска» — ссылка снимается вместе с ним.
      await pickStatus(page, 198, 'Идет тендерная процедура')
      await page.waitForFunction(() => window.__fakeDb.tenders.find((r) => r.id === 'tender-3').status === 'Идет тендерная процедура')
      assert.deepEqual(await fakeTender(page, 'tender-3'), { status: 'Идет тендерная процедура', link: null })
      await registryRow(page, 194).locator('.trs-mark').waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('«Перезапуск» из формы тендера — то же окно после сохранения формы', async () => {
    const { page, errors, close } = await open('route=/tenders/construction&tenders=10&items=20&cps=4&restartLink=1')
    try {
      await registryRow(page, 198).waitFor({ timeout: 120000 })
      await registryRow(page, 198).getByRole('button', { name: 'Редактировать тендер' }).click()
      const form = page.locator('form', { has: page.locator('select[name="status"]') })
      await form.waitFor()
      await form.locator('select[name="status"]').selectOption(RESTART_STATUS)
      await form.locator('button[type="submit"]').click()
      const dialog = page.locator('.trs-dialog')
      await dialog.waitFor({ timeout: 30000 })
      assert.equal(await form.count(), 0, 'форма закрыта, открыто окно перезапуска')
      // Пока окно не сохранено — статус прежний.
      assert.equal((await fakeTender(page, 'tender-3')).status, 'Идет тендерная процедура')
      await dialog.locator('.trs-opt', { hasText: '№ 194' }).click()
      await dialog.locator('.trs-btn--primary').click()
      await page.waitForFunction(() => window.__fakeDb.tenders.find((r) => r.id === 'tender-3').restarted_by_tender_id === 'tender-7')
      assert.equal((await fakeTender(page, 'tender-3')).status, RESTART_STATUS)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('карточка тендера: у нового — «перезапуск № 197», у прежнего — «заменён № 200»; номер ведёт в тендер', async () => {
    const card = await open('route=/tenders/tender-1&items=20&cps=4&restartLink=1&restartPair=1')
    try {
      const mark = card.page.locator('.tender-detail-header .trs-marks--header .trs-mark--from')
      await mark.waitFor({ timeout: 120000 })
      assert.equal(text(await mark.innerText()), 'перезапуск № 197')
      await mark.locator('a.trs-num').click()
      const back = card.page.locator('.tender-detail-header .trs-mark--to')
      await back.waitFor({ timeout: 30000 })
      assert.equal(text(await back.innerText()), 'заменён № 200')
      assert.equal(await card.page.locator('.tender-detail-header .trs-edit, .tender-detail-header .trs-add').count(), 0, 'в карточке — только показ')
      assert.deepEqual(card.errors, [])
    } finally {
      await card.close()
    }
  })

  it('телефон: отметка под статусом в карточке строки, номер — ссылкой', async () => {
    const { page, errors, close } = await open('route=/tenders/construction&tenders=10&items=20&cps=4&restartLink=1&restartPair=1', { width: 390, height: 800 })
    try {
      const row = page.locator('.tp-mrow', { has: page.locator('.tp-mrow-num', { hasText: /^№200$/ }) })
      await row.waitFor({ timeout: 120000 })
      const mark = row.locator('.tp-mrow-flags .trs-mark--from')
      assert.equal(text(await mark.innerText()), 'перезапуск № 197')
      assert.equal(await row.locator('.tp-mrow-main .trs-mark').count(), 0, 'не внутри ссылки строки')
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      assert.ok(overflow <= 0, `без горизонтальной прокрутки: ${overflow}`)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('«Добавить новый тендер» — перезапуск прежнего: без выбора не создать; объект и описание — от прежнего; прежнему — «Перезапуск» и ссылка', async () => {
    const { page, errors, close } = await open('route=/tenders/construction&tenders=10&items=20&cps=4&restartLink=1')
    try {
      await registryRow(page, 198).waitFor({ timeout: 120000 })
      const before = await page.evaluate(() => window.__fakeDb.tenders.length)
      await page.getByRole('button', { name: '+ Добавить тендер' }).click()
      const form = page.locator('.modal form')
      await form.waitFor()
      const toggle = form.getByLabel('Перезапуск тендера')
      assert.equal(await toggle.isChecked(), false, 'по умолчанию — обычный тендер')
      await toggle.check()
      const pick198 = async () => {
        await form.locator('.trs-create-pick .fdrop-trigger').click()
        await page.locator('.fdrop-panel .fdrop-search').fill('198')
        await page.locator('.fdrop-option', { hasText: '№ 198' }).click()
      }
      // Выбрали прежний — пустые объект и описание берутся у него.
      await pick198()
      const src = await page.evaluate(() => window.__fakeDb.tenders.find((r) => r.id === 'tender-3'))
      assert.equal(await form.locator('select[name="object_id"]').inputValue(), src.object_id, 'объект — от прежнего')
      assert.equal(await form.locator('textarea[name="work_description"]').inputValue(), src.work_description, 'описание — от прежнего')
      // Галочку сняли и поставили — выбор сброшен: без прежнего тендер не создаётся (поля формы заполнены).
      await toggle.uncheck()
      await toggle.check()
      await form.locator('button[type="submit"]').click()
      for (let i = 0; i < 100 && !errors.some((e) => e.startsWith('окно:')); i++) await page.waitForTimeout(50)
      assert.match(errors.pop() || '', /^окно: Выберите тендер, который перезапускается/)
      assert.equal(await page.evaluate(() => window.__fakeDb.tenders.length), before)
      await pick198()
      await form.locator('button[type="submit"]').click()
      await form.waitFor({ state: 'detached' })

      await page.waitForFunction(() => window.__fakeDb.tenders.find((r) => r.id === 'tender-3').status === 'Перезапуск')
      const made = await page.evaluate(() => window.__fakeDb.tenders.filter((r) => r.tender_type === 'main' && !/^tender-/.test(r.id)))
      assert.equal(made.length, 1)
      assert.equal((await fakeTender(page, 'tender-3')).link, made[0].id)
      const log = await page.evaluate(() => window.__fakeDb.tender_audit_log.filter((l) => l.tender_id === 'tender-3')
        .map((l) => [l.event_type, l.description]))
      assert.deepEqual(log, [['status_changed', 'Статус: Идет тендерная процедура → Перезапуск'],
        ['field_updated', `Перезапущен тендером № ${made[0].public_tender_number}`]], 'журнал — как у окна «Перезапуск»')
      // У прежнего (№ 198) — «заменён № …» нового.
      const mark = registryRow(page, 198).locator('.trs-mark--to')
      await mark.waitFor({ timeout: 30000 })
      assert.equal(text(await mark.innerText()), `заменён № ${made[0].public_tender_number}`)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('«Добавить новый тендер» без перезапуска — как раньше; колонки ссылки нет — галочки нет', async () => {
    const plain = await open('route=/tenders/construction&tenders=10&items=20&cps=4&restartLink=1')
    try {
      await registryRow(plain.page, 198).waitFor({ timeout: 120000 })
      await plain.page.getByRole('button', { name: '+ Добавить тендер' }).click()
      const form = plain.page.locator('.modal form')
      await form.locator('select[name="object_id"]').selectOption({ index: 1 })
      await form.locator('textarea[name="work_description"]').fill('Кровля, новый тендер')
      await form.locator('button[type="submit"]').click()
      await form.waitFor({ state: 'detached' })
      const made = await plain.page.evaluate(() => window.__fakeDb.tenders.filter((r) => r.tender_type === 'main' && !/^tender-/.test(r.id)))
      assert.equal(made.length, 1)
      assert.equal(await plain.page.evaluate(() => window.__fakeDb.tenders.filter((r) => r.status === 'Перезапуск').length), 0)
      assert.deepEqual(plain.errors, [])
    } finally {
      await plain.close()
    }
    const legacy = await open('route=/tenders/construction&tenders=10&items=20&cps=4')
    try {
      await registryRow(legacy.page, 198).waitFor({ timeout: 120000 })
      await legacy.page.getByRole('button', { name: '+ Добавить тендер' }).click()
      await legacy.page.locator('.modal form').waitFor()
      assert.equal(await legacy.page.locator('.modal form').getByLabel('Перезапуск тендера').count(), 0)
    } finally {
      await legacy.close()
    }
  })

  it('колонки ещё нет (база до 20270217): «Перезапуск» ставится сразу, без окна и отметок', async () => {
    const { page, errors, close } = await open('route=/tenders/construction&tenders=10&items=20&cps=4')
    try {
      await registryRow(page, 198).waitFor({ timeout: 120000 })
      await pickStatus(page, 198, RESTART_STATUS)
      await page.waitForFunction(() => window.__fakeDb.tenders.find((r) => r.id === 'tender-3').status === 'Перезапуск')
      assert.equal(await page.locator('.trs-dialog').count(), 0)
      assert.equal(await page.locator('.trs-marks').count(), 0)
      assert.equal(await page.evaluate(() => 'restarted_by_tender_id' in window.__fakeDb.tenders.find((r) => r.id === 'tender-3')), false,
        'в запись колонка не попадает')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
