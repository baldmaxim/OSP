// «Заявки на ДС»: ответственный заявки. В столбце «Статус и ответственный» — выбор с поиском прямо в строке (раньше только
// текст), в форме заявки — такой же выбор вместо системного списка, который раскрывался поверх всей формы.
// Стенд tests/tender/ui: route=/dc-requests&dcStats=1&dcResp=1.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { contactRepresentatives, matchPersonOption, responsibleContacts } from '../../src/utils/dcRequestOptions.js'
import { startStand, browserLaunchOptions, REPO as ROOT } from './lib/stand.mjs'

const launch = browserLaunchOptions()

describe('Заявки на ДС: список ответственных', () => {
  const contacts = [
    { id: 'a', full_name: ' Сурова Екатерина Ивановна' },
    { id: 'b', full_name: 'Архипов Антон Михайлович' },
    { id: 'c', full_name: 'архипов  антон михайлович' },
    { id: 'd', full_name: 'Ёлкин Пётр' },
    { id: 'e', full_name: '   ' },
    { id: 'f', full_name: null },
  ]

  it('по строке на ФИО, без лишних пробелов, по алфавиту; пустых нет', () => {
    assert.deepEqual(responsibleContacts(contacts).map(c => [c.id, c.full_name]), [
      ['b', 'Архипов Антон Михайлович'],
      ['d', 'Ёлкин Пётр'],
      ['a', 'Сурова Екатерина Ивановна'],
    ])
    assert.deepEqual(responsibleContacts(null), [])
  })

  it('вторая строка того же человека ведёт к первой', () => {
    const reps = contactRepresentatives(contacts)
    assert.equal(reps.c, 'b')
    assert.equal(reps.b, 'b')
    assert.equal(reps.a, 'a')
    assert.equal(reps.e, 'e', 'строка без ФИО — сама по себе')
    assert.equal(reps.f, 'f')
  })

  it('поиск: слова в любом порядке, «ё» = «е»', () => {
    const o = { label: 'Ёлкин Пётр' }
    assert.equal(matchPersonOption(o, 'елкин'), true)
    assert.equal(matchPersonOption(o, 'петр елкин'), true)
    assert.equal(matchPersonOption(o, 'пётр'), true)
    assert.equal(matchPersonOption(o, 'сурова'), false)
    assert.equal(matchPersonOption(o, 'елкин сурова'), false)
  })
})

describe('Заявки на ДС: выбор ответственного', { skip: launch ? false : 'нет Chromium', timeout: 300000 }, () => {
  let stand
  let browser

  before(async () => {
    stand = await startStand(ROOT)
    browser = await chromium.launch({ ...launch, headless: true })
  })
  after(async () => {
    await browser?.close()
    await stand?.server.close()
  })

  const open = async (extra = '', viewport = { width: 1600, height: 900 }) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport, hasTouch: viewport.width < 700 })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    const dialogs = []
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.goto(`${stand.url}?route=/dc-requests&dcStats=1&dcResp=1&latency=10&shell=1${extra}`)
    await page.locator(viewport.width < 700 ? '.mcard' : '.dcr-table td.ui-rownum').first().waitFor({ timeout: 120000 })
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }
  const rowOf = (page, ds) => page.locator('.dcr-table tbody tr', { hasText: `ДС-${ds}` })
  const pickerOf = (page, ds) => rowOf(page, ds).locator('.dcr-req-resp-fdrop .fdrop-trigger')
  const dbRow = (page, id) => page.evaluate((rid) => {
    const r = window.__fakeDb.dc_requests.find(x => x.id === rid)
    return { contact: r.responsible_contact_id, updatedAt: r.updated_at }
  }, id)
  const audit = (page, id) => page.evaluate((rid) => window.__fakeDb.dc_request_audit_log
    .filter(e => e.dc_request_id === rid && e.field_name === 'responsible_contact_id').map(e => e.description), id)
  const panel = (page) => page.locator('.fdrop-panel')

  it('в строке: найти поиском и назначить; подпись, база и журнал', async () => {
    const { page, errors, dialogs, close } = await open()
    try {
      assert.match(await pickerOf(page, 'd3').innerText(), /Не назначен/)
      await pickerOf(page, 'd3').click()
      await panel(page).locator('.fdrop-search').fill('агарков 2')
      assert.deepEqual(await panel(page).locator('.fdrop-option').allInnerTexts(), ['Агарков Сотрудник 2'])
      await panel(page).locator('.fdrop-option').click()
      await page.waitForFunction(() => window.__fakeDb.dc_requests.find(x => x.id === 'd3').responsible_contact_id === 'c-1-2')
      await rowOf(page, 'd3').locator('.dcr-req-resp-fdrop', { hasText: 'Агарков' }).waitFor()
      assert.equal(await panel(page).count(), 0, 'список закрылся')
      await page.waitForFunction(() => window.__fakeDb.dc_request_audit_log.some(e => e.dc_request_id === 'd3' && e.field_name === 'responsible_contact_id'))
      assert.deepEqual(await audit(page, 'd3'), ['Ответственный: — → Агарков Сотрудник 2'])
      assert.deepEqual(dialogs, [])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('в строке: снять ответственного; тот же человек другой строкой справочника — не запись', async () => {
    const { page, errors, close } = await open()
    try {
      // У d2 — вторая строка Архипова: в списке отмечен он же, повторный выбор ничего не пишет.
      await pickerOf(page, 'd2').click()
      assert.match(await panel(page).locator('.fdrop-option.is-current').innerText(), /Архипов Антон Михайлович/)
      await panel(page).locator('.fdrop-option.is-current').click()
      await page.waitForTimeout(100)
      assert.equal((await dbRow(page, 'd2')).contact, 'c-arh-2')
      assert.deepEqual(await audit(page, 'd2'), [])

      await pickerOf(page, 'd1').click()
      await panel(page).locator('.fdrop-option', { hasText: 'Не назначен' }).click()
      await page.waitForFunction(() => window.__fakeDb.dc_requests.find(x => x.id === 'd1').responsible_contact_id === null)
      await rowOf(page, 'd1').locator('.dcr-req-resp-fdrop', { hasText: 'Не назначен' }).waitFor()
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('список — по алфавиту, без дублей, имя с пробелом не первым', async () => {
    const { page, close } = await open()
    try {
      await pickerOf(page, 'd3').click()
      // У выбранного пункта в тексте ещё галочка.
      const names = (await panel(page).locator('.fdrop-option').allInnerTexts()).map(n => n.replace('✓', '').trim())
      assert.equal(names[0], 'Не назначен')
      assert.equal(names[1], 'Абдуллаев Сотрудник 1')
      assert.equal(names.filter(n => n.includes('Архипов')).length, 1)
      assert.equal(names.at(-1), 'Сурова Екатерина Ивановна')
    } finally { await close() }
  })

  it('без права правки и в «Удаленных» — только ФИО', async () => {
    const readOnly = await open('&canEdit=0')
    try {
      assert.equal(await readOnly.page.locator('.dcr-req-resp-fdrop').count(), 0)
      assert.match(await rowOf(readOnly.page, 'd1').locator('.dcr-resp-line').innerText(), /Архипов/)
    } finally { await readOnly.close() }

    const editor = await open()
    try {
      await editor.page.locator('.dcr-tab, .tab-btn, button', { hasText: /^Удаленные/ }).first().click()
      await rowOf(editor.page, 'd6').waitFor()
      assert.equal(await rowOf(editor.page, 'd6').locator('.dcr-resp-line').count(), 1)
      assert.equal(await editor.page.locator('.dcr-req-resp-fdrop').count(), 0)
    } finally { await editor.close() }
  })

  it('запись не задела строку — сообщение, в строке прежний ответственный', async () => {
    const { page, dialogs, close } = await open()
    try {
      await page.evaluate(() => { window.__fakeDb.dc_requests = window.__fakeDb.dc_requests.filter(x => x.id !== 'd1') })
      await pickerOf(page, 'd1').click()
      await panel(page).locator('.fdrop-option', { hasText: 'Бойцов Сотрудник 1' }).click()
      await page.waitForFunction(() => document.querySelector('.fdrop-panel') === null)
      await page.waitForTimeout(100)
      assert.equal(dialogs.length, 1)
      assert.match(dialogs[0], /Ответственный не изменён/)
      assert.match(await pickerOf(page, 'd1').innerText(), /Архипов/)
    } finally { await close() }
  })

  it('в форме: не системный список; окно поверх формы, поиск, запись', async () => {
    const { page, errors, close } = await open()
    try {
      await rowOf(page, 'd1').locator('.btn-edit, button[title*="едактир"]').first().click()
      const field = page.locator('.modal .form-group', { hasText: 'Ответственный сотрудник' })
      await field.waitFor()
      assert.equal(await page.locator('select[name="responsible_contact_id"]').count(), 0)
      const trigger = field.locator('.fdrop-trigger')
      assert.match(await trigger.innerText(), /Архипов Антон Михайлович/)

      // Поле шириной во всю форму — как «Объект» над ним.
      const objectBox = await page.locator('.modal .form-group', { hasText: 'Объект *' }).locator('.fdrop-trigger').boundingBox()
      const box = await trigger.boundingBox()
      assert.equal(Math.round(box.width), Math.round(objectBox.width))
      assert.equal(Math.round(box.height), Math.round(objectBox.height))

      await trigger.click()
      const options = panel(page).locator('.fdrop-options')
      const list = await options.boundingBox()
      assert.ok(list.height <= 320, `список со своей прокруткой, высота ${list.height}`)
      const vp = page.viewportSize()
      const whole = await panel(page).boundingBox()
      assert.ok(whole.y >= 0 && whole.y + whole.height <= vp.height, 'список целиком в окне браузера')
      // Сверху — сам список, а не окно заявки.
      const top = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.fdrop-panel'),
        { x: list.x + 20, y: list.y + 10 })
      assert.equal(top, true)

      await panel(page).locator('.fdrop-search').fill('сурова')
      await panel(page).locator('.fdrop-option').click()
      assert.match(await trigger.innerText(), /Сурова Екатерина Ивановна/)
      assert.equal(await page.locator('.modal .form-group', { hasText: 'Ответственный сотрудник' }).count(), 1, 'окно заявки не закрылось')
      await page.locator('.modal-footer button[type="submit"]').click()
      await page.waitForFunction(() => window.__fakeDb.dc_requests.find(x => x.id === 'd1').responsible_contact_id === 'c-sur')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('телефон: в карточке — ФИО, ответственного выбирают в форме заявки', async () => {
    const { page, errors, close } = await open('', { width: 390, height: 800 })
    try {
      assert.equal(await page.locator('.mcard .dcr-req-resp-fdrop').count(), 0)
      const card = page.locator('.mcard', { hasText: 'ДС-d1' })
      assert.match(await card.innerText(), /Архипов Антон Михайлович/)
      await card.locator('.btn-edit, button[title*="едактир"], button[aria-label*="едактир"]').first().click()
      const trigger = page.locator('.modal .form-group', { hasText: 'Ответственный сотрудник' }).locator('.fdrop-trigger')
      await trigger.scrollIntoViewIfNeeded()
      await trigger.click()
      const whole = await panel(page).boundingBox()
      assert.ok(whole.x >= 0 && whole.x + whole.width <= 390, `список в ширину экрана: ${whole.x}…${whole.x + whole.width}`)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
