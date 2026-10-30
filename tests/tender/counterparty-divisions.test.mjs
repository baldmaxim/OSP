// Контрагенты: подразделения по видам работ (миграция 20261115, решение пользователя 29.10.2026) и правка явных
// дублей видов работ (migration/data/20261029_work_types_merge.sql).
//   • подразделение — у вида работ (work_types.division, коды подразделений ВОР); у контрагента — подразделения его
//     видов работ: плашки под видами в строке реестра, фильтр в заголовке «Вид работ» (на телефоне — под панелью),
//     «Не указано» — контрагенты без единого подразделения; фильтр «Все виды работ» сужается до видов подразделения;
//   • вкладка «Виды работ»: колонка «Подразделение» (выбор пишет в базу), фильтр, выбор в окне вида работ;
//     в форме контрагента подразделение видно рядом с видом работ; запятая в названии вида не принимается;
//   • база без колонки — ни плашек, ни фильтров, ни выбора, окно вида работ не шлёт division;
//   • таблицы миграции и разовой правки согласованы: коды — VOR_DIVISIONS, обе базы — одно распределение,
//     у дубля и итогового вида — одно подразделение (порядок запуска миграции и правки не важен);
//   • «Прочее» (other, миграция 20261119, решение пользователя 30.10.2026) — только у видов работ: нераспределённым
//     видам — «Прочее», в выборе, плашках и фильтрах контрагентов есть, у тендеров и договоров — нет.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { VOR_DIVISIONS, NO_VOR_DIVISION } from '../../src/utils/vorDivisions.js'
import {
  WORK_TYPE_DIVISIONS, divisionByWorkType, divisionCounts, hasDivisionColumn, isMissingWorkTypeDivision, matchesDivisions,
  workTypeDivisionSaveError, workTypesDivisions,
} from '../../src/utils/workTypeDivisions.js'

const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8')

describe('Подразделения видов работ: правила и таблицы миграции', () => {
  it('подразделения контрагента — по его видам работ, фильтр и счётчики', () => {
    const dir = [
      { name: 'Фасадные работы', division: 'nvf_spk' }, { name: 'Кровля', division: 'general' },
      { name: 'Монолитные работы', division: 'monolith' }, { name: 'Клининг', division: null },
      { name: 'Странный', division: 'нет такого' },
    ]
    const byName = divisionByWorkType(dir)
    assert.deepEqual(workTypesDivisions('Кровля, Фасадные работы , Монолитные работы', byName), ['monolith', 'nvf_spk', 'general'])
    assert.deepEqual(workTypesDivisions('Клининг, Странный, Нет в справочнике', byName), [])
    assert.deepEqual(workTypesDivisions('Кровля, Кровля', byName), ['general'])
    assert.equal(matchesDivisions(['general'], []), true)
    assert.equal(matchesDivisions(['general', 'nvf_spk'], ['nvf_spk']), true)
    assert.equal(matchesDivisions(['general'], ['monolith']), false)
    assert.equal(matchesDivisions([], ['monolith']), false)
    assert.equal(matchesDivisions([], [NO_VOR_DIVISION]), true)
    const counts = divisionCounts([['general', 'nvf_spk'], ['general'], []], (x) => x)
    assert.deepEqual([...counts].sort(), [[NO_VOR_DIVISION, 1], ['general', 2], ['nvf_spk', 1]].sort())
    assert.equal(hasDivisionColumn([{ name: 'a', division: null }]), true)
    assert.equal(hasDivisionColumn([{ name: 'a' }]), false)
    assert.equal(hasDivisionColumn([]), false)
    assert.ok(isMissingWorkTypeDivision({ code: 'PGRST204', message: "Could not find the 'division' column of 'work_types'" }))
    assert.ok(isMissingWorkTypeDivision({ code: '42703', message: 'column work_types.division does not exist' }))
    assert.ok(!isMissingWorkTypeDivision({ code: '23505', message: 'duplicate key division' }))
  })

  it('«Прочее» — подразделение только видов работ: последним в списке, отказ базы без 20261119 — понятным текстом', () => {
    assert.deepEqual(WORK_TYPE_DIVISIONS.map((d) => d.value), [...VOR_DIVISIONS.map((d) => d.value), 'other'])
    assert.equal(WORK_TYPE_DIVISIONS.at(-1).label, 'Прочее')
    assert.ok(!VOR_DIVISIONS.some((d) => d.value === 'other'), 'у тендеров, договоров и заявок «Прочего» нет')
    const byName = divisionByWorkType([{ name: 'Клининг', division: 'other' }, { name: 'Кровля', division: 'general' }])
    assert.deepEqual(workTypesDivisions('Клининг, Кровля', byName), ['general', 'other'])
    assert.match(workTypeDivisionSaveError({ code: '23514', message: 'new row violates check constraint "work_types_division_check"' }), /20261119/)
    assert.match(workTypeDivisionSaveError({ code: 'PGRST204', message: "Could not find the 'division' column" }), /20261115/)
    assert.equal(workTypeDivisionSaveError({ code: '23505', message: 'duplicate' }), null)
  })

  it('миграция «Прочего»: коды — WORK_TYPE_DIVISIONS, нераспределённым — other, обе базы одинаковы', () => {
    const sup = read('supabase/migrations/20261119_work_types_division_other.sql')
    const yan = read('migration/yandex/20261119_work_types_division_other.sql')
    const check = sup.match(/division IN \(([^)]*)\)/)[1].match(/'([^']+)'/g).map((x) => x.slice(1, -1))
    assert.deepEqual(check, WORK_TYPE_DIVISIONS.map((d) => d.value))
    assert.match(sup, /UPDATE public\.work_types SET division = 'other' WHERE division IS NULL;/)
    const body = (x) => x.slice(x.indexOf('DO $$'), x.lastIndexOf('WHERE division IS NULL;') + 23)
    assert.equal(body(yan), body(sup), 'тело миграции Яндекса = Supabase')
    assert.doesNotMatch(yan, /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im, 'транзакцию в базе Яндекса задаёт migrate.sh')
    const schema = read('supabase/schemas/work_types.sql').match(/division IN \(([^)]*)\)/)[1]
    assert.equal(schema, sup.match(/division IN \(([^)]*)\)/)[1], 'схема = миграция')
  })

  it('миграция: коды — VOR_DIVISIONS, обе базы — одно распределение; правка дублей — без запятых и без смены подразделения', () => {
    const sup = read('supabase/migrations/20261115_work_types_division.sql')
    const yan = read('migration/yandex/20261115_work_types_division.sql')
    const codes = VOR_DIVISIONS.map((d) => d.value)
    const check = sup.match(/division IN \(([^)]*)\)/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1))
    assert.deepEqual(check, codes)
    const body = (s) => s.slice(s.indexOf('ALTER TABLE'), s.lastIndexOf('division IS NULL;') + 17)
    assert.equal(body(yan), body(sup), 'тело миграции Яндекса = Supabase')
    const div = new Map([...sup.matchAll(/\('((?:[^']|'')+)', '([a-z_]+)'\)/g)].map((m) => [m[1].replace(/''/g, "'"), m[2]]))
    assert.ok(div.size > 60, `распределение: ${div.size}`)
    for (const c of div.values()) assert.ok(codes.includes(c), c)

    const fix = read('migration/data/20261029_work_types_merge.sql')
    const json = (key) => JSON.parse(fix.match(new RegExp(`'osp_fix\\.${key}', \\$json\\$([\\s\\S]*?)\\$json\\$`))[1])
    const map = json('map')
    const rename = json('rename')
    for (const [src, targets] of Object.entries(map)) {
      assert.equal(targets.length, 1, `явный дубль — один итоговый вид: ${src}`)
      const t = targets[0]
      assert.ok(!t.includes(','), `запятая в «${t}»`)
      assert.equal(div.get(src) ?? null, div.get(t) ?? null, `подразделение «${src}» и «${t}»`)
    }
    for (const [o, n] of Object.entries(rename)) assert.deepEqual(map[o], [n])
    assert.ok(Object.keys(map).length <= 12, 'только явные дубли и опечатки')
  })
})

const launch = browserLaunchOptions()
const BASE = 'route=/general/counterparties&cps=6&cpContacts=1&cpDivisions=1&items=20&latency=0'

describe('Реестр контрагентов: подразделения по видам работ', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 600000 }, () => {
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

  async function openPage(query, viewport = { width: 1440, height: 900 }, extra = {}) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport, ...extra })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.goto(`${stand.url}?${query}`)
    await page.locator('table.compact-table tbody tr.table-row, .cp-mrow').first().waitFor({ timeout: 60000 })
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }
  const row = (page, name) => page.locator('table.compact-table tbody tr.table-row', { hasText: name })
  const names = (page) => page.locator('table.compact-table tbody tr.table-row .company-name').allInnerTexts()
  // Текст плашек без подписи для читалок экрана («Подразделение: …»).
  const chips = async (loc) => (await loc.allInnerTexts()).map((t) => t.replace(/^Подразделение:\s*/, ''))
  const pick = async (page, label) => page.locator('.fdrop-panel .fdrop-option', { hasText: label }).first().click()

  it('плашки подразделений под видами работ; фильтр в заголовке «Вид работ» со счётчиками и «Не указано»', async () => {
    const { page, errors, close } = await openPage(BASE)
    try {
      assert.deepEqual(await chips(row(page, 'Подрядчик 02').locator('.cp-divs .vdiv')), ['НВФ/СПК', 'Общестроительные работы'])
      assert.deepEqual(await chips(row(page, 'Подрядчик 04').locator('.cp-divs .vdiv')), ['Монолит'])
      assert.equal(await row(page, 'Подрядчик 05').locator('.cp-divs').count(), 0, '«Клининг» без подразделения — плашек нет')

      await page.locator('th.col-worktype .fdrop-trigger').click()
      const options = await page.locator('.fdrop-panel .fdrop-option-text').allTextContents()
      for (const o of ['Монолит (1)', 'НВФ/СПК (3)', 'Общестроительные работы (2)', 'ОВиВК (0)', 'Не указано (1)']) {
        assert.ok(options.includes(o), `${o} — ${options.join(', ')}`)
      }
      await pick(page, 'Монолит')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelectorAll('table.compact-table tbody tr.table-row').length === 1)
      assert.deepEqual(await names(page), ['Подрядчик 04'])
      assert.equal(await page.locator('th.col-worktype.th-filtered').count(), 1, 'заголовок помечен')

      // Фильтр «Все виды работ» — только виды выбранного подразделения.
      await page.locator('.wt-filter-input').click()
      assert.deepEqual(await page.locator('.wt-filter-dropdown .wt-filter-item').allInnerTexts(), ['Все виды работ', 'Монолитные работы'])
      await page.keyboard.press('Escape')
      await page.locator('.wt-filter-input').evaluate((el) => el.blur())

      await page.locator('th.col-worktype .fdrop-trigger').click()
      await pick(page, 'Не указано')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelectorAll('table.compact-table tbody tr.table-row').length === 2)
      assert.deepEqual((await names(page)).sort(), ['Подрядчик 04', 'Подрядчик 05'])

      await page.locator('th.col-worktype .vdivf-clear').click()
      await page.waitForFunction(() => document.querySelectorAll('table.compact-table tbody tr.table-row').length === 5)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Виды работ»: подразделение в строке справочника пишется в базу и сразу меняет плашки и фильтр реестра', async () => {
    const { page, errors, close } = await openPage(BASE)
    try {
      await page.locator('.cp-tab-worktypes').click()
      const wtRow = page.locator('.work-types-table tbody tr', { hasText: 'Клининг' })
      await wtRow.waitFor()
      assert.match(await page.locator('.work-types-table thead').innerText(), /Подразделение/i)
      assert.match(await page.locator('.work-types-table tbody tr', { hasText: 'Монолитные работы' }).locator('.wt-col-division').innerText(), /Монолит/)
      await wtRow.locator('.wt-col-division .fdrop-trigger').click()
      await pick(page, 'Отделка')
      await page.waitForFunction(() => window.__fakeDb.work_types.find((w) => w.name === 'Клининг')?.division === 'finishing')
      assert.match(await wtRow.locator('.wt-col-division').innerText(), /Отделка/)

      // Фильтр справочника по подразделению.
      await page.locator('.work-types-directory-toolbar .fdrop-trigger').click()
      await pick(page, 'Монолит')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelectorAll('.work-types-table tbody tr').length === 1)
      assert.match(await page.locator('.work-types-table tbody').innerText(), /Монолитные работы/)

      await page.locator('.cp-tab', { hasText: 'Активные' }).click()
      await row(page, 'Подрядчик 05').waitFor()
      assert.deepEqual(await chips(row(page, 'Подрядчик 05').locator('.cp-divs .vdiv')), ['Отделка'])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Прочее»: выбор у вида работ, плашка у контрагента и пункт фильтра; в окне вида — тоже', async () => {
    const { page, errors, close } = await openPage(BASE)
    try {
      await page.locator('.cp-tab-worktypes').click()
      const wtRow = page.locator('.work-types-table tbody tr', { hasText: 'Клининг' })
      await wtRow.locator('.wt-col-division .fdrop-trigger').click()
      const options = await page.locator('.fdrop-panel .fdrop-option-text').allTextContents()
      assert.deepEqual(options.filter((o) => o !== 'Не указано'), WORK_TYPE_DIVISIONS.map((d) => d.label))
      await pick(page, 'Прочее')
      await page.waitForFunction(() => window.__fakeDb.work_types.find((w) => w.name === 'Клининг')?.division === 'other')
      assert.match(await wtRow.locator('.wt-col-division').innerText(), /Прочее/)

      await page.locator('.work-types-directory-toolbar .btn-add').click()
      const modal = page.locator('.modal').filter({ hasText: 'Новый вид работ' })
      assert.ok((await modal.locator('select option').allTextContents()).includes('Прочее'))
      await modal.locator('.modal-footer .btn-secondary').click()

      await page.locator('.cp-tab', { hasText: 'Активные' }).click()
      await row(page, 'Подрядчик 05').waitFor()
      assert.deepEqual(await chips(row(page, 'Подрядчик 05').locator('.cp-divs .vdiv')), ['Прочее'])
      await page.locator('th.col-worktype .fdrop-trigger').click()
      const filter = await page.locator('.fdrop-panel .fdrop-option-text').allTextContents()
      for (const o of ['Прочее (1)', 'Не указано (0)']) assert.ok(filter.includes(o), `${o} — ${filter.join(', ')}`)
      await pick(page, 'Прочее')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelectorAll('table.compact-table tbody tr.table-row').length === 1)
      assert.deepEqual(await names(page), ['Подрядчик 05'])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('окно вида работ: подразделение при добавлении; запятая в названии не принимается', async () => {
    const { page, dialogs, errors, close } = await openPage(BASE)
    try {
      await page.locator('.cp-tab-worktypes').click()
      await page.locator('.work-types-directory-toolbar .btn-add').click()
      const modal = page.locator('.modal').filter({ hasText: 'Новый вид работ' })
      await modal.locator('input[type="text"]').fill('Окраска, шпатлёвка')
      await modal.locator('select').selectOption('finishing')
      await modal.locator('button[type="submit"]').click()
      for (let i = 0; i < 40 && !dialogs.length; i++) await page.waitForTimeout(50)
      assert.match(dialogs.join(' | '), /запят/)
      assert.equal(await page.evaluate(() => window.__fakeDb.work_types.some((w) => w.name.startsWith('Окраска'))), false)

      await modal.locator('input[type="text"]').fill('Малярные работы')
      await modal.locator('button[type="submit"]').click()
      await page.waitForFunction(() => window.__fakeDb.work_types.find((w) => w.name === 'Малярные работы')?.division === 'finishing')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('форма контрагента: подразделение рядом с видом работ в выборе', async () => {
    const { page, close } = await openPage(BASE)
    try {
      await page.locator('button.btn-add', { hasText: /^\+ Добавить$/ }).first().click()
      await page.locator('.modal-overlay .modal .wt-search-input').click()
      const item = page.locator('.wt-search-dropdown .wt-search-item', { hasText: 'Монолитные работы' })
      await item.waitFor()
      assert.equal(await item.locator('.wt-search-div').innerText(), 'Монолит')
      assert.equal(await page.locator('.wt-search-dropdown .wt-search-item', { hasText: 'Клининг' }).locator('.wt-search-div').count(), 0)
    } finally { await close() }
  })

  it('база без колонки division — как раньше: ни плашек, ни фильтров, ни выбора; окно не шлёт division', async () => {
    const { page, errors, close } = await openPage(BASE.replace('cpDivisions=1', 'cpDivisions=legacy'))
    try {
      await row(page, 'Подрядчик 04').waitFor()
      assert.equal(await page.locator('.cp-divs').count(), 0)
      assert.equal(await page.locator('th.col-worktype .fdrop').count(), 0)
      await page.locator('.cp-tab-worktypes').click()
      await page.locator('.work-types-table tbody tr').first().waitFor()
      assert.doesNotMatch(await page.locator('.work-types-table thead').innerText(), /Подразделение/i)
      assert.equal(await page.locator('.work-types-directory-toolbar .fdrop').count(), 0)
      await page.locator('.work-types-directory-toolbar .btn-add').click()
      const modal = page.locator('.modal').filter({ hasText: 'Новый вид работ' })
      assert.equal(await modal.locator('select').count(), 0)
      await modal.locator('input[type="text"]').fill('Малярные работы')
      await modal.locator('button[type="submit"]').click()
      await page.waitForFunction(() => window.__fakeDb.work_types.some((w) => w.name === 'Малярные работы'))
      assert.equal(await page.evaluate(() => 'division' in window.__fakeDb.work_types.find((w) => w.name === 'Малярные работы')), false)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('телефон: фильтр подразделений под панелью, без прокрутки вбок', async () => {
    const { page, errors, close } = await openPage(`${BASE}&shell=1`, { width: 390, height: 844 }, { isMobile: true, hasTouch: true })
    try {
      await page.locator('.cp-phone-divisions .fdrop-trigger').click()
      await pick(page, 'Монолит')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelectorAll('.cp-mrow').length === 1)
      assert.match(await page.locator('.cp-mrow').innerText(), /Подрядчик 04/)
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      assert.ok(scroll <= 0, `прокрутка вбок ${scroll}px`)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
