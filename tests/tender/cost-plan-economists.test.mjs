// Экономисты ОСП по объектам (cost_plan_economists, миграция 20261110): помощники (без браузера) и страницы в
// Chromium (стенд tests/tender/ui).
//   • «Планы затрат» → «Документы» → «Экономисты ОСП»: карточка на экономиста с его объектами, объекты основного
//     строительства без экономиста; назначает и меняет только администратор; таблицы ещё нет — подсказка;
//   • «Отделы»: те же экономисты под «Отделом по сопровождению подрядчиков», только просмотр, без «Документов»;
//     правка из «Планов затрат» подхватывается при возврате на страницу; поиск находит отдел по экономисту;
//   • форма нового тендера «Основного строительства»: ответственным за план затрат сразу ставится экономист ОСП
//     объекта, его можно сменить (выбор человека смена объекта уже не перетирает); в базу уходит выбранный.
// Люди и объекты стенда вымышленные: настоящие ФИО в репозиторий не кладём.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  economistByObject, economistOptions, groupByEconomist, objectLabel, pickCostPlanResponsible,
} from '../../src/utils/costPlanEconomists.js'

const ECON_A = { id: 'ct-econ-a', full_name: 'Экономов Андрей Петрович', position: 'Экономист ОСП', phone: '+7 900 111-22-33', departments: { name: 'ОСП' } }
const ECON_B = { id: 'ct-econ-b', full_name: 'Бюджетова Мария Ивановна', position: 'Экономист ОСП', phone: null, departments: { name: 'ОСП' } }
const OBJECTS = [
  { id: 'o-1', name: 'ЖК  Северный 33', status: 'main_construction' },
  { id: 'o-2', name: 'ЖК Южный', status: 'main_construction' },
  { id: 'o-3', name: 'ЖК Восточный', status: 'main_construction' },
  { id: 'o-4', name: 'ЖК Гарантийный', status: 'warranty_service' },
]

describe('Экономисты ОСП: правила без базы', () => {
  it('сводка: экономист → объекты (больше объектов — выше), без экономиста — только основное строительство', () => {
    const rows = [
      { object_id: 'o-2', contact_id: ECON_B.id, contacts: ECON_B },
      { object_id: 'o-1', contact_id: ECON_A.id, contacts: ECON_A },
      { object_id: 'o-3', contact_id: ECON_A.id, contacts: ECON_A },
    ]
    const { groups, unassigned } = groupByEconomist(rows, OBJECTS)
    assert.deepEqual(groups.map(g => [g.contact.full_name, g.objects.map(o => o.name)]), [
      [ECON_A.full_name, ['ЖК Восточный', 'ЖК Северный 33']],
      [ECON_B.full_name, ['ЖК Южный']],
    ])
    assert.deepEqual(unassigned, [])
    assert.deepEqual(groupByEconomist([], OBJECTS).unassigned.map(o => o.name), ['ЖК Восточный', 'ЖК Северный 33', 'ЖК Южный'])
    assert.equal(objectLabel('ЖК  ЗИЛ 33 '), 'ЖК ЗИЛ 33')
    assert.equal(objectLabel(null), '—')
  })

  it('форма тендера: экономист объекта, пока человек не выбрал сам', () => {
    const map = economistByObject([{ object_id: 'o-1', contact_id: 'c-1' }, { object_id: 'o-2', contact_id: 'c-2' }])
    assert.equal(pickCostPlanResponsible({ objectId: 'o-1', economists: map, current: '' }), 'c-1')
    assert.equal(pickCostPlanResponsible({ objectId: 'o-3', economists: map, current: 'c-1' }), '', 'у объекта нет — не назначен')
    assert.equal(pickCostPlanResponsible({ objectId: 'o-2', economists: map, current: 'c-9', touched: true }), 'c-9')
    assert.equal(pickCostPlanResponsible({ objectId: 'o-1', economists: null, current: 'c-9' }), 'c-9', 'список не загрузился — не трогаем')
    assert.equal(pickCostPlanResponsible({ objectId: '', economists: map, current: 'c-1' }), '')
  })

  it('выбор сотрудника: ОСП первыми, двойники по ФИО — один, назначенный двойник остаётся', () => {
    const twin = { ...ECON_A, id: 'ct-econ-a-2' }
    const other = { id: 'ct-x', full_name: 'Арбузов Иван', position: 'Юрист', departments: { name: 'Юридический' } }
    const plain = economistOptions([ECON_A, twin, ECON_B, other])
    assert.deepEqual(plain.osp.map(c => c.id), [ECON_B.id, ECON_A.id])
    assert.deepEqual(plain.others.map(c => c.id), ['ct-x'])
    const kept = economistOptions([ECON_A, twin, other], [twin.id])
    assert.deepEqual(kept.osp.map(c => c.id), [twin.id])
  })
})

const launch = browserLaunchOptions()

describe('Экономисты ОСП в «Документах» и в форме тендера', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  // Данные стенда дополняются до первого запроса к ним: экономисты читаются при открытии окна или формы.
  const openPage = async (query, ready, { assigned = null, missingTable = false } = {}) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1500, height: 950 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => d.accept())
    await page.goto(`${stand.url}?${query}&latency=0`)
    await page.locator(ready).first().waitFor({ timeout: 120000 })
    await page.evaluate(([econA, econB, objects, rows, missing]) => {
      const db = window.__fakeDb
      db.contacts = [...db.contacts.filter(c => !c.id.startsWith('ct-econ')), econA, econB]
      db.objects = [...db.objects.filter(o => !o.id.startsWith('o-')), ...objects]
      db.cost_plan_economists = rows ?? [
        { id: 'cpe-1', object_id: 'o-1', contact_id: econA.id, contacts: econA },
        { id: 'cpe-2', object_id: 'o-3', contact_id: econA.id, contacts: econA },
        { id: 'cpe-3', object_id: 'obj-2', contact_id: 'ct-2', contacts: db.contacts.find(c => c.id === 'ct-2') },
      ]
      // Встраивание contacts(...) после записи — как PostgREST (стенд встраивания не разбирает; триггер стенда
      // меняет строку на месте).
      window.__fakeTriggers = { ...(window.__fakeTriggers || {}),
        cost_plan_economists: (row) => { row.contacts = db.contacts.find(c => c.id === row.contact_id) || null } }
      if (missing) {
        window.__fakeErrors = { cost_plan_economists: { code: 'PGRST205', message: "Could not find the table 'public.cost_plan_economists' in the schema cache" } }
      }
      // Страница могла уже прочитать эти таблицы — следующие чтения видят подменённые строки.
      for (const t of ['contacts', 'objects', 'cost_plan_economists']) window.__fakeTouch(t)
    }, [ECON_A, ECON_B, OBJECTS, assigned, missingTable])
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const openDocs = async (page) => {
    await page.getByRole('button', { name: 'Документы' }).click()
    const modal = page.locator('.tdm-modal')
    await modal.locator('.tdm-tab.is-active', { hasText: 'Экономисты ОСП' }).waitFor()
    await modal.locator('.cpe-cards, .tdm-note, .tdm-site-empty-state:not(:has-text("Загрузка"))').first().waitFor({ timeout: 10000 })
    return modal
  }
  const cards = (modal) => modal.locator('.cpe-card').evaluateAll((els) => els.map((el) => ({
    name: el.querySelector('.tdm-person').textContent,
    phone: el.querySelector('.cpe-phone')?.textContent || null,
    objects: [...el.querySelectorAll('.cpe-objects li')].map((li) => li.textContent),
  })))

  it('«Отделы»: экономисты под отделом по сопровождению подрядчиков — только просмотр, правка подхватывается', async () => {
    const { page, errors, close } = await openPage('route=/general/departments&canEdit=0&shell=1', '.departments-page h2')
    try {
      // Экономистов страница прочитала до того, как стенд их завёл, — подхватывает при возврате на страницу
      // (в том числе если событие пришло, пока первое чтение ещё шло).
      const econ = page.locator('.dp-row[data-dept-id="dep-3"] .dp-econ')
      await page.locator('.dp-row[data-dept-id="dep-3"]').waitFor()
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await econ.waitFor()
      const items = () => econ.locator('.dp-econ-item').evaluateAll((els) => els.map((el) => ({
        name: el.querySelector('.dp-contact-name').textContent,
        phone: el.querySelector('.dp-contact-phone')?.textContent || null,
        objects: el.querySelector('.dp-econ-objects').textContent,
      })))
      assert.deepEqual(await items(), [
        { name: ECON_A.full_name, phone: '+7 900 111-22-33', objects: 'ЖК Восточный, ЖК Северный 33' },
        { name: 'Крюкова Юлия Денисовна', phone: null, objects: 'Бизнес-центр «Нурлы»' },
      ])
      assert.equal(await econ.locator('a.dp-contact-phone').getAttribute('href'), 'tel:+79001112233')
      assert.equal(await econ.locator('.dp-econ-note a').getAttribute('href'), '/cost-plans')
      // Только под этим отделом; окна «Документы» и выбора экономиста здесь нет.
      assert.equal(await page.locator('.dp-econ').count(), 1)
      assert.equal(await page.getByRole('button', { name: 'Документы' }).count(), 0)
      assert.equal(await page.locator('.dp-econ select').count(), 0)

      // В «Планах затрат» назначили «ЖК Южный» другому экономисту — после возврата на страницу видно здесь.
      await page.evaluate((econB) => {
        window.__fakeDb.cost_plan_economists.push({ id: 'cpe-9', object_id: 'o-2', contact_id: econB.id, contacts: econB })
        window.__fakeTouch('cost_plan_economists')
        document.dispatchEvent(new Event('visibilitychange'))
      }, ECON_B)
      await econ.locator('.dp-econ-item', { hasText: ECON_B.full_name }).waitFor()
      assert.deepEqual((await items()).map(i => [i.name, i.objects]), [
        [ECON_A.full_name, 'ЖК Восточный, ЖК Северный 33'],
        [ECON_B.full_name, 'ЖК Южный'],
        ['Крюкова Юлия Денисовна', 'Бизнес-центр «Нурлы»'],
      ])

      // Поиск по экономисту или его объекту находит отдел по сопровождению подрядчиков.
      for (const q of ['Экономов', 'южный']) {
        await page.locator('.dp-search').fill(q)
        await page.waitForFunction(() => document.querySelectorAll('.dp-row[data-dept-id]').length === 1)
        assert.equal(await page.locator('.dp-row[data-dept-id]').getAttribute('data-dept-id'), 'dep-3', q)
      }
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('«Планы затрат» → «Документы»: администратор назначает, меняет и снимает экономиста объекта', async () => {
    const { page, errors, close } = await openPage('route=/cost-plans', '.cost-plans-page .cp-table')
    try {
      const modal = await openDocs(page)
      const row = (name) => modal.locator('.cpe-assign-row', { has: page.locator('.tdm-site-div', { hasText: new RegExp(`^${name}$`) }) })
      // Только основное строительство (гарантийный объект без назначения в список не попадает), по алфавиту.
      assert.deepEqual(await modal.locator('.cpe-assign-row .tdm-site-div').allTextContents(),
        ['Бизнес-центр «Нурлы»', 'ЖК «Северный квартал»', 'ЖК Восточный', 'ЖК Северный 33', 'ЖК Южный'])
      const select = row('ЖК Южный').locator('select')
      assert.equal(await select.inputValue(), '')
      assert.deepEqual(await select.locator('optgroup').evaluateAll((els) => els.map((g) => g.label)), ['ОСП'])

      await select.selectOption(ECON_B.id)
      await page.waitForFunction(() => window.__fakeDb.cost_plan_economists.some(r => r.object_id === 'o-2'))
      await modal.locator('.cpe-card', { hasText: ECON_B.full_name }).waitFor()
      assert.deepEqual((await cards(modal)).map(c => [c.name, c.objects]), [
        [ECON_A.full_name, ['ЖК Восточный', 'ЖК Северный 33']],
        [ECON_B.full_name, ['ЖК Южный']],
        ['Крюкова Юлия Денисовна', ['Бизнес-центр «Нурлы»']],
      ])
      assert.match(await modal.locator('.cpe-unassigned').textContent(), /^Без экономиста ОСП \(1\): ЖК «Северный квартал»\. Назначить — в списке ниже\.$/)

      // Сменить: одна строка на объект — запись заменяется, а не добавляется.
      await row('ЖК Южный').locator('select').selectOption(ECON_A.id)
      await page.waitForFunction((id) => window.__fakeDb.cost_plan_economists.find(r => r.object_id === 'o-2')?.contact_id === id, ECON_A.id)
      assert.equal(await page.evaluate(() => window.__fakeDb.cost_plan_economists.filter(r => r.object_id === 'o-2').length), 1)
      // Снять.
      await row('Бизнес-центр «Нурлы»').locator('select').selectOption('')
      await page.waitForFunction(() => !window.__fakeDb.cost_plan_economists.some(r => r.object_id === 'obj-2'))
      assert.deepEqual((await cards(modal)).map(c => [c.name, c.objects.length]), [[ECON_A.full_name, 3]])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('таблицы ещё нет — в «Планах затрат» подсказка про миграцию, в «Отделах» блока нет', async () => {
    const plans = await openPage('route=/cost-plans', '.cost-plans-page .cp-table', { missingTable: true })
    try {
      const modal = await openDocs(plans.page)
      assert.match(await modal.locator('.tdm-note').textContent(), /после обновления базы \(миграция 20261110_cost_plan_economists\)/)
      assert.equal(await modal.locator('.cpe-assign').count(), 0)
    } finally {
      await plans.close()
    }
    const deps = await openPage('route=/general/departments&shell=1', '.departments-page h2', { missingTable: true })
    try {
      await deps.page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await deps.page.locator('.dp-row[data-dept-id="dep-3"]').waitFor()
      await deps.page.waitForTimeout(300)
      assert.equal(await deps.page.locator('.dp-econ').count(), 0)
      assert.deepEqual(deps.errors, [])
    } finally {
      await deps.close()
    }
  })

  it('новый тендер ОС: экономист объекта — ответственный за план затрат, можно сменить', async () => {
    const { page, errors, close } = await openPage('route=/tenders/construction&tenders=6&items=20&cps=2',
      'table.tenders-registry > tbody > tr')
    try {
      await page.getByRole('button', { name: '+ Добавить тендер' }).click()
      const form = page.locator('.modal form')
      const responsible = form.locator('select[name="cost_plan_responsible_id"]')
      await responsible.waitFor()
      const hint = form.locator('.tender-cost-plan-hint')

      // «Нурлы» (obj-2) — экономист ct-2; «Северный квартал» (obj-1) — без экономиста.
      await form.locator('select[name="object_id"]').selectOption('obj-2')
      await page.waitForFunction(() => document.querySelector('select[name="cost_plan_responsible_id"]').value === 'ct-2')
      assert.equal(await hint.textContent(), 'Экономист ОСП объекта — подставлен сам, можно сменить')
      await form.locator('select[name="object_id"]').selectOption('obj-1')
      await page.waitForFunction(() => document.querySelector('select[name="cost_plan_responsible_id"]').value === '')
      assert.match(await hint.textContent(), /^У объекта нет экономиста ОСП/)

      // Выбор человека остаётся и при смене объекта.
      await form.locator('select[name="object_id"]').selectOption('obj-2')
      await page.waitForFunction(() => document.querySelector('select[name="cost_plan_responsible_id"]').value === 'ct-2')
      await responsible.selectOption('ct-1')
      await form.locator('select[name="object_id"]').selectOption('obj-1')
      await form.locator('select[name="object_id"]').selectOption('obj-2')
      assert.equal(await responsible.inputValue(), 'ct-1')
      assert.equal(await hint.textContent(), 'Выбран не экономист ОСП объекта')
      await responsible.selectOption('ct-2')

      await form.locator('textarea[name="work_description"]').fill('Устройство кровли — проверка экономиста')
      await form.getByRole('button', { name: 'Добавить' }).click()
      await page.waitForFunction(() => window.__fakeDb.tenders.some(t => t.work_description === 'Устройство кровли — проверка экономиста'))
      const created = await page.evaluate(() => window.__fakeDb.tenders
        .filter(t => t.work_description === 'Устройство кровли — проверка экономиста')
        .map(t => ({ type: t.tender_type, responsible: t.cost_plan_responsible_id ?? null })))
      assert.deepEqual(created.find(t => t.type === 'main'), { type: 'main', responsible: 'ct-2' })
      // Тендеру на материалы план затрат не нужен — ответственного у него нет.
      assert.equal(created.find(t => t.type === 'materials')?.responsible ?? null, null)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
