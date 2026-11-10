// «Заявки на проверку ДП/ДС» (решения пользователя 05.11.2026): исполнители — только действующие юристы ОСП; дату создания
// и автора заявки меняет администратор. Правила без браузера и страница в Chromium (стенд tests/tender/ui,
// route=/doc-check-requests&docCheck=1): у dcr-2 исполнители — сотрудник снабжения и юрист, у dcr-3 — юрист и вписанное
// текстом имя, у dcr-5 — заблокированный (в справочнике сотрудников его нет). Запрет в базе и правка данных —
// doc-check-created-db.test.mjs. Люди стенда вымышленные.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  NO_ASSIGNEE, assigneeIdsToSave, assigneeStaffOptions, createdFieldsPatch, fieldEvents, labelSuggestions, matchesAssignees,
  shownAssigneeIds, toDateTimeInput,
} from '../../src/utils/docCheckHelpers.js'

describe('Исполнители и создание заявки: правила без браузера', () => {
  const employees = new Map([
    ['law-2', { user_id: 'law-2', role: 'lawyer', display_name: 'Яковлева Я. Я.' }],
    ['law-1', { user_id: 'law-1', role: 'lawyer', display_name: 'Антонова А. А.' }],
    ['eng', { user_id: 'eng', role: 'engineer', display_name: 'Инженеров И. И.' }],
    ['dept', { user_id: 'dept', role: 'yurist', display_name: 'Отделов О. О.' }],
  ])

  it('показываем только юриста ОСП: другая роль и заблокированный (его нет в справочнике) — нет', () => {
    assert.deepEqual(shownAssigneeIds({ assignee_ids: ['eng', 'law-2', 'blocked', 'dept', 'law-1'] }, employees), ['law-2', 'law-1'])
    assert.deepEqual(shownAssigneeIds({ assignee_ids: ['law-1'] }, new Map()), [], 'справочник ещё не загрузился')
    assert.deepEqual(shownAssigneeIds({}, employees), [], 'строка прежней базы: поля нет')
  })

  it('выбрать можно только юриста, по алфавиту', () => {
    assert.deepEqual(assigneeStaffOptions(employees), [
      { value: 'law-1', label: 'Антонова А. А.' },
      { value: 'law-2', label: 'Яковлева Я. Я.' },
    ])
    assert.deepEqual(assigneeStaffOptions(new Map()), [])
  })

  it('«Без исполнителя» — когда на карточке нет ни одного', () => {
    const hidden = { assignee_ids: ['eng', 'blocked'] }
    const lawyer = { assignee_ids: ['eng', 'law-1'] }
    assert.equal(matchesAssignees(hidden, [NO_ASSIGNEE], employees), true)
    assert.equal(matchesAssignees(lawyer, [NO_ASSIGNEE], employees), false)
    assert.equal(matchesAssignees(lawyer, ['law-1'], employees), true)
    assert.equal(matchesAssignees(lawyer, ['law-2'], employees), false)
    assert.equal(matchesAssignees(hidden, [], employees), true)
    assert.equal(matchesAssignees({}, [NO_ASSIGNEE], employees), true)
  })

  it('запись формы не трогает тех, кого форма не показывала, и не меняет порядок', () => {
    const prev = ['eng', 'law-1', 'blocked']
    assert.deepEqual(assigneeIdsToSave(prev, ['law-1'], employees), prev, 'ничего не меняли — в истории пусто')
    assert.deepEqual(fieldEvents({ assignee_ids: prev }, { assignee_ids: assigneeIdsToSave(prev, ['law-1'], employees) }), [])
    assert.deepEqual(assigneeIdsToSave(prev, ['law-2', 'law-1'], employees), ['eng', 'law-1', 'blocked', 'law-2'])
    assert.deepEqual(assigneeIdsToSave(prev, [], employees), ['eng', 'blocked'], 'снять можно только показанного')
    assert.deepEqual(assigneeIdsToSave(undefined, ['law-1'], employees), ['law-1'], 'новая заявка')
    assert.deepEqual(assigneeIdsToSave(prev, [], new Map()), prev, 'справочник не загрузился — никого не теряем')
  })

  it('дата создания: в запись идёт только изменённое, секунды неизменённой даты не теряются', () => {
    const request = { created_at: '2026-11-02T10:15:42.123Z', created_by_name: 'Импорт' }
    const at = toDateTimeInput(request.created_at)
    assert.match(at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    assert.deepEqual(createdFieldsPatch(request, at, 'Импорт'), { patch: {} })

    const changed = createdFieldsPatch(request, '2026-10-15T09:30', 'Импорт')
    assert.deepEqual(changed, { patch: { created_at: new Date('2026-10-15T09:30').toISOString() } })
    assert.equal(toDateTimeInput(changed.patch.created_at), '2026-10-15T09:30', 'туда и обратно — то же значение')

    assert.deepEqual(createdFieldsPatch(request, '', 'Импорт'), { error: 'Укажите дату создания заявки' })
    const now = new Date('2026-11-05T12:00:00').getTime()
    assert.match(createdFieldsPatch(request, '2026-11-05T12:01', 'Импорт', now).error, /позже текущего/)
    assert.equal(toDateTimeInput('не дата'), '')
    assert.equal(toDateTimeInput(null), '')
  })

  it('автор заявки: без лишних пробелов; пустое — нет автора; не менялся — не пишется', () => {
    const request = { created_at: '2026-11-02T10:15:42Z', created_by_name: 'Импорт' }
    const at = toDateTimeInput(request.created_at)
    assert.deepEqual(createdFieldsPatch(request, at, '  Иванова   Анна '), { patch: { created_by_name: 'Иванова Анна' } })
    assert.deepEqual(createdFieldsPatch(request, at, '   '), { patch: { created_by_name: null } })
    assert.deepEqual(createdFieldsPatch({ created_at: request.created_at, created_by_name: null }, at, ''), { patch: {} })
  })

  it('история: дата создания и автор — отдельными полями', () => {
    const events = fieldEvents(
      { created_at: '2026-11-02T10:00:00Z', created_by_name: 'Импорт' },
      { created_at: '2026-10-15T09:00:00.000Z', created_by_name: 'Иванова' },
    )
    assert.deepEqual(events.map(e => e.field_name), ['created_at', 'created_by_name'])
  })

  it('подсказки меток: удалённой метки в них нет, частые первыми', () => {
    assert.deepEqual(labelSuggestions([{ labels: ['Б'] }, { labels: ['А', 'б'] }, {}]), ['Б', 'А'])
  })
})

const launch = browserLaunchOptions()

describe('Исполнители и создание заявки в браузере', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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
    await page.goto(`${stand.url}?route=/doc-check-requests&docCheck=1&latency=0${extra}`)
    await page.locator('.dc-board').waitFor({ timeout: 120000 })
    // Справочник сотрудников читается отдельно от заявок.
    await page.locator('.dc-card[data-id="dcr-1"] .dc-avatar').waitFor()
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const card = (page, id) => page.locator(`.dc-column .dc-card[data-id="${id}"]`)
  const row = (page, id) => page.evaluate((key) => window.__fakeDb.doc_check_requests.find((r) => r.id === key), id)
  const log = (page, id) => page.evaluate((key) => window.__fakeDb.doc_check_request_audit_log.filter((l) => l.request_id === key), id)
  const openForm = async (page, id) => {
    await card(page, id).click()
    const modal = page.locator('.dc-detail-modal')
    await modal.getByRole('button', { name: 'Изменить' }).click()
    const form = page.locator('.dc-form-modal')
    await form.waitFor()
    return form
  }
  const save = async (form) => {
    await form.getByRole('button', { name: 'Сохранить' }).click()
    await form.waitFor({ state: 'detached' })
  }

  it('на карточке, в окне заявки и в реестре — только юристы; другая роль, вписанное имя и заблокированный не видны', async () => {
    const { page, errors, close } = await openPage()
    try {
      assert.deepEqual(await card(page, 'dcr-2').locator('.dc-avatar').allTextContents(), ['ЮМ'])
      assert.doesNotMatch(await card(page, 'dcr-2').locator('.dc-avatars').getAttribute('title'), /Петров/)
      assert.deepEqual(await card(page, 'dcr-3').locator('.dc-avatar').allTextContents(), ['ЮМ'])
      assert.equal(await card(page, 'dcr-5').locator('.dc-avatar').count(), 0, 'заблокированный — без «Пользователь удалён»')

      await card(page, 'dcr-3').click()
      const modal = page.locator('.dc-detail-modal')
      assert.deepEqual(await modal.locator('.dc-detail-people li').allTextContents(), ['ЮМЮристова Мария Андреевна'])
      await modal.locator('.modal-close').click()

      await card(page, 'dcr-5').click()
      assert.match(await modal.locator('.dc-box', { hasText: 'Исполнители' }).textContent(), /Не назначены/)
      await modal.locator('.modal-close').click()

      await page.getByRole('tab', { name: 'Реестр' }).click()
      const text = await page.locator('.dc-table').textContent()
      assert.doesNotMatch(text, /Петров|Сидорова|Пользователь удалён/)
      assert.match(text, /Юристова Мария Андреевна/)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('фильтр — только юристы и «Без исполнителя»; скрытые не находятся поиском и не считаются исполнителями', async () => {
    const { page, errors, close } = await openPage()
    try {
      const ids = () => page.locator('.dc-column .dc-card').evaluateAll((els) => els.map((el) => el.dataset.id))
      for (const hidden of ['сидорова', 'петров']) {
        await page.locator('.dc-search').fill(hidden)
        assert.deepEqual(await ids(), [], hidden)
      }
      await page.locator('.dc-search').fill('юристова')
      assert.deepEqual((await ids()).sort(), ['dcr-2', 'dcr-3'])
      await page.locator('.dc-reset').click()

      await page.locator('.dc-toolbar .fdrop-trigger', { hasText: 'Исполнитель' }).click()
      const options = page.locator('.fdrop-panel .fdrop-option')
      assert.deepEqual(await options.allTextContents(), ['Без исполнителя', 'Стендов Стенд Стендович', 'Юристова Мария Андреевна'])
      await options.filter({ hasText: 'Без исполнителя' }).click()
      const none = await ids()
      assert.ok(none.includes('dcr-5'), 'только заблокированный — исполнителя нет')
      assert.ok(none.includes('dcr-4'))
      assert.ok(!none.includes('dcr-2') && !none.includes('dcr-3'), 'есть юрист')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('в форме выбирают только юриста, вписать имя нельзя; скрытый исполнитель при сохранении остаётся в базе', async () => {
    const { page, errors, close } = await openPage()
    try {
      const form = await openForm(page, 'dcr-2')
      assert.equal(await form.getByText('Исполнители без учётной записи').count(), 0)
      await form.locator('.dc-form-assignees .fdrop-trigger').click()
      const options = page.locator('.fdrop-panel .fdrop-option')
      assert.deepEqual(await options.allTextContents(), ['Стендов Стенд Стендович', 'Юристова Мария Андреевна'])
      await page.keyboard.press('Escape')

      await form.locator('#dc-num').fill('СУ2-001-1')
      await save(form)
      assert.deepEqual((await row(page, 'dcr-2')).assignee_ids, ['user-2', 'user-3'])
      assert.deepEqual((await log(page, 'dcr-2')).map((l) => l.field_name), ['doc_number'], 'исполнители не менялись — в истории их нет')

      const again = await openForm(page, 'dcr-2')
      await again.locator('.dc-form-assignees .fdrop-trigger').click()
      await page.locator('.fdrop-panel .fdrop-option', { hasText: 'Стендов Стенд Стендович' }).click()
      await page.locator('.fdrop-panel .fdrop-option', { hasText: 'Юристова Мария Андреевна' }).click()
      await page.keyboard.press('Escape')
      await save(again)
      assert.deepEqual((await row(page, 'dcr-2')).assignee_ids, ['user-2', 'user-1'])
      assert.deepEqual(await card(page, 'dcr-2').locator('.dc-avatar').allTextContents(), ['СС'])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('администратор меняет дату создания и автора: карточка, окно заявки и история', async () => {
    const { page, errors, close } = await openPage()
    try {
      const form = await openForm(page, 'dcr-1')
      const names = await form.locator('#dc-created-by-names option').evaluateAll((els) => els.map((el) => el.value))
      assert.ok(names.includes('Петров П. П.'), 'автором может быть любой сотрудник, не только юрист')

      await form.locator('#dc-created-at').fill('2026-09-15T09:30')
      await form.locator('#dc-created-by').fill('  Автор   Настоящий ')
      await save(form)

      const saved = await row(page, 'dcr-1')
      const iso = await page.evaluate(() => new Date('2026-09-15T09:30').toISOString())
      assert.equal(saved.created_at, iso)
      assert.equal(saved.created_by_name, 'Автор Настоящий')
      assert.equal(await card(page, 'dcr-1').locator('.dc-chip--created').textContent(), '15.09')
      assert.deepEqual((await log(page, 'dcr-1')).map((l) => l.field_name).sort(), ['created_at', 'created_by_name'])

      await card(page, 'dcr-1').click()
      const modal = page.locator('.dc-detail-modal')
      const info = await modal.locator('.dc-box', { hasText: 'Создание' }).textContent()
      assert.match(info, /Автор Настоящий/)
      assert.match(info, /15\.09\.2026/)
      await modal.getByRole('tab', { name: /^История/ }).click()
      await modal.locator('.dc-history li').first().waitFor()
      const history = await modal.locator('.dc-history').textContent()
      assert.match(history, /Дата создания20\.10\.2026.*→\s*15\.09\.2026, 09:30/)
      assert.match(history, /Кто создалСтендов С\. С\.\s*→\s*Автор Настоящий/)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('дата создания обязательна и не может быть в будущем; без правки поля в запись не идут', async () => {
    const { page, errors, close } = await openPage()
    try {
      const form = await openForm(page, 'dcr-1')
      const before = await row(page, 'dcr-1')
      await form.locator('#dc-created-at').fill('')
      await form.getByRole('button', { name: 'Сохранить' }).click()
      assert.match(await form.locator('.dc-form-error').textContent(), /Укажите дату создания/)
      await form.locator('#dc-created-at').fill('2099-01-01T10:00')
      await form.getByRole('button', { name: 'Сохранить' }).click()
      assert.match(await form.locator('.dc-form-error').textContent(), /позже текущего/)
      assert.equal((await row(page, 'dcr-1')).created_at, before.created_at)

      await form.locator('#dc-created-at').fill(await page.evaluate((at) => {
        const d = new Date(at)
        const p = (n) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
      }, before.created_at))
      await save(form)
      assert.equal((await row(page, 'dcr-1')).created_at, before.created_at, 'дата как была — значение прежнее, до секунд')
      assert.deepEqual(await log(page, 'dcr-1'), [])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('не администратору полей нет, новая заявка — без них', async () => {
    const { page, errors, close } = await openPage('&asRole=lawyer&asUser=user-3')
    try {
      const form = await openForm(page, 'dcr-1')
      assert.equal(await form.locator('#dc-created-at, #dc-created-by, .dc-form-admin').count(), 0)
      await form.locator('#dc-num').fill('1-1')
      await save(form)
      const saved = await row(page, 'dcr-1')
      assert.equal(saved.created_by_name, 'Стендов С. С.')
      assert.equal(saved.created_at, '2026-10-20T09:00:00Z')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
    const admin = await openPage()
    try {
      await admin.page.getByRole('button', { name: '+ Новая заявка' }).click()
      const form = admin.page.locator('.dc-form-modal')
      await form.waitFor()
      assert.equal(await form.locator('#dc-created-at, #dc-created-by, .dc-form-admin').count(), 0)
      assert.deepEqual(admin.errors, [])
    } finally {
      await admin.close()
    }
  })

  it('поля администратора на телефоне — в столбик, окно не шире экрана', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 390, height: 800 } })
    const page = await context.newPage()
    try {
      await page.goto(`${stand.url}?route=/doc-check-requests&docCheck=1&latency=0`)
      await page.locator('.dc-board').waitFor({ timeout: 120000 })
      const form = await openForm(page, 'dcr-1')
      const at = await form.locator('#dc-created-at').boundingBox()
      const by = await form.locator('#dc-created-by').boundingBox()
      assert.ok(by.y > at.y, 'одно под другим')
      assert.ok(at.x >= 0 && at.x + at.width <= 390, 'дата не шире экрана')
      const size = await form.locator('#dc-created-at').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
      assert.equal(size, 16, 'иначе Safari увеличивает страницу при фокусе')
    } finally {
      await context.close().catch(() => {})
    }
  })
})
