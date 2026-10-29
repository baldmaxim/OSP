// Карточка задачи (/tasks?task=…): закрывается только кнопкой «×»; чек-лист — ручка слева для перестановки
// (мышью и стрелками с клавиатуры), правка текста пункта и добавление нескольких пунктов строками (Shift+Enter). Расчёт порядка — без браузера, страница — в Chromium
// (стенд tests/tender/ui: задача task-1 с тремя пунктами, у двух одинаковый sort_order).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { nextChecklistOrder, reorderChecklist, splitChecklistLines } from '../../src/utils/taskHelpers.js'

describe('Чек-лист задачи: порядок пунктов', () => {
  const items = [
    { id: 'a', sort_order: 0 }, { id: 'b', sort_order: 10 }, { id: 'c', sort_order: 10 },
  ]
  it('пункт встаёт перед / после цели; правки — только у изменившихся номеров', () => {
    const r = reorderChecklist(items, 'c', 'a', 'before')
    assert.deepEqual(r.ordered.map(i => i.id), ['c', 'a', 'b'])
    assert.deepEqual(r.updates, [{ id: 'c', sort_order: 0 }, { id: 'a', sort_order: 10 }, { id: 'b', sort_order: 20 }])
    const down = reorderChecklist(items, 'a', 'b', 'after')
    assert.deepEqual(down.ordered.map(i => i.id), ['b', 'a', 'c'])
  })
  it('на своё место, сам на себя, неизвестный пункт — null', () => {
    assert.equal(reorderChecklist(items, 'a', 'b', 'before'), null)
    assert.equal(reorderChecklist(items, 'b', 'b', 'after'), null)
    assert.equal(reorderChecklist(items, 'x', 'a', 'before'), null)
  })
  it('новый пункт — в конец, после самого большого номера', () => {
    assert.equal(nextChecklistOrder(items), 20)
    assert.equal(nextChecklistOrder([]), 0)
  })
  it('строки поля — отдельные пункты: пустые и пробелы по краям отброшены', () => {
    assert.deepEqual(splitChecklistLines('Собрать КП'), ['Собрать КП'])
    assert.deepEqual(splitChecklistLines('  Первый \n\n Второй\r\nТретий\r  \n'), ['Первый', 'Второй', 'Третий'])
    assert.deepEqual(splitChecklistLines(' \n '), [])
    assert.deepEqual(splitChecklistLines(null), [])
  })
})

const launch = browserLaunchOptions()

describe('Карточка задачи: закрытие и чек-лист', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open(query = '', viewport = { width: 1400, height: 900 }) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    await page.goto(`${stand.url}?route=${encodeURIComponent('/tasks?task=task-1')}&latency=0${query}`)
    await page.locator('.task-modal').waitFor({ timeout: 120000 })
    await page.locator('.task-checklist li').nth(2).waitFor()
    return { page, errors, close: () => context.close().catch(() => {}) }
  }

  const titles = (page) => page.locator('.task-checklist li').evaluateAll((list) => list.map(li => li.querySelector('label span')?.textContent ?? ''))
  const dbOrder = (page) => page.evaluate(() => [...window.__fakeDb.task_checklist_items]
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at)).map(i => i.title))

  it('клик рядом с окном и Escape карточку не закрывают, кнопка «×» — закрывает', async () => {
    const { page, errors, close } = await open()
    try {
      const box = await page.locator('.task-modal').boundingBox()
      await page.mouse.click(Math.max(5, box.x - 20), box.y + box.height / 2)
      await page.mouse.click(5, 5)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
      assert.equal(await page.locator('.task-modal').count(), 1, 'карточка на месте')
      await page.locator('.task-modal-close').click()
      await page.locator('.task-modal').waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('ручка: перетаскивание мышью и стрелками; порядок сохраняется в базе', async () => {
    const { page, errors, close } = await open()
    try {
      assert.deepEqual(await titles(page), ['Собрать КП', 'Сверить объёмы', 'Отправить на согласование'])
      // Третий пункт — над первым.
      const handle = page.locator('.task-checklist li').nth(2).locator('.task-checklist-handle')
      const target = await page.locator('.task-checklist li').nth(0).boundingBox()
      const hb = await handle.boundingBox()
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
      await page.mouse.down()
      await page.mouse.move(hb.x + hb.width / 2, target.y + 4, { steps: 8 })
      assert.equal(await page.locator('.task-checklist li.drop-before').count(), 1, 'место вставки подсвечено')
      await page.mouse.up()
      await page.waitForFunction(() => window.__fakeDb.task_checklist_items.find(i => i.id === 'chk-3').sort_order === 0)
      assert.deepEqual(await titles(page), ['Отправить на согласование', 'Собрать КП', 'Сверить объёмы'])
      assert.deepEqual(await dbOrder(page), ['Отправить на согласование', 'Собрать КП', 'Сверить объёмы'])

      // Стрелка вниз на ручке первого — на одно место ниже, фокус остаётся на ручке.
      await page.locator('.task-checklist li').nth(0).locator('.task-checklist-handle').focus()
      await page.keyboard.press('ArrowDown')
      await page.waitForFunction(() => window.__fakeDb.task_checklist_items.find(i => i.id === 'chk-3').sort_order === 10)
      assert.deepEqual(await titles(page), ['Собрать КП', 'Отправить на согласование', 'Сверить объёмы'])
      assert.equal(await page.evaluate(() => document.activeElement?.closest('li')?.dataset.itemId), 'chk-3')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('правка пункта: Enter сохраняет, Escape отменяет и карточку не закрывает', async () => {
    const { page, errors, close } = await open()
    try {
      const first = page.locator('.task-checklist li').nth(0)
      await first.getByRole('button', { name: /Изменить пункт/ }).click()
      const input = page.locator('.task-checklist-edit')
      await input.fill('Собрать КП от пяти подрядчиков')
      await input.press('Enter')
      await page.waitForFunction(() => window.__fakeDb.task_checklist_items.find(i => i.id === 'chk-1').title === 'Собрать КП от пяти подрядчиков')
      assert.equal((await titles(page))[0], 'Собрать КП от пяти подрядчиков')

      await page.locator('.task-checklist li').nth(1).getByRole('button', { name: /Изменить пункт/ }).click()
      await page.locator('.task-checklist-edit').fill('черновик')
      await page.locator('.task-checklist-edit').press('Escape')
      assert.equal(await page.locator('.task-checklist-edit').count(), 0)
      assert.equal((await titles(page))[1], 'Сверить объёмы')
      assert.equal(await page.locator('.task-modal').count(), 1, 'Escape в поле карточку не закрыл')
      // Отметка пункта по-прежнему работает: правка не перехватила клик по тексту.
      await page.locator('.task-checklist li').nth(0).locator('label').click()
      await page.waitForFunction(() => window.__fakeDb.task_checklist_items.find(i => i.id === 'chk-1').is_done === true)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('Shift+Enter — новая строка, Enter добавляет каждую строку отдельным пунктом в конец', async () => {
    const { page, errors, close } = await open()
    try {
      const field = page.getByRole('textbox', { name: 'Новый пункт' })
      const oneLine = (await field.boundingBox()).height
      await field.click()
      await page.keyboard.type('Запросить КП')
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type('  Сравнить цены ')
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type('Выбрать победителя')
      assert.equal(await field.inputValue(), 'Запросить КП\n\n  Сравнить цены \nВыбрать победителя', 'Shift+Enter не добавил, а перенёс строку')
      assert.ok((await field.boundingBox()).height > oneLine, 'поле выросло по строкам')
      assert.equal(await page.locator('.task-checklist-add .btn-secondary').textContent(), 'Добавить 3 пункта')
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => window.__fakeDb.task_checklist_items.length === 6)
      await page.locator('.task-checklist li').nth(5).waitFor()
      const added = ['Запросить КП', 'Сравнить цены', 'Выбрать победителя']
      assert.deepEqual((await titles(page)).slice(3), added)
      assert.deepEqual((await dbOrder(page)).slice(3), added)
      assert.equal(await field.inputValue(), '')
      assert.equal((await field.boundingBox()).height, oneLine, 'после добавления — снова в одну строку')

      // Одна строка — как раньше: один пункт.
      await field.fill('Подписать протокол')
      assert.equal(await page.locator('.task-checklist-add .btn-secondary').textContent(), 'Добавить')
      await field.press('Enter')
      await page.waitForFunction(() => window.__fakeDb.task_checklist_items.length === 7)
      await page.locator('.task-checklist li').nth(6).waitFor()
      assert.equal((await titles(page)).at(-1), 'Подписать протокол')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('исполнитель без права правки: ручки и карандаша нет, отметка пункта работает', async () => {
    const { page, errors, close } = await open('&canEdit=0&taskForeign=1')
    try {
      assert.equal(await page.locator('.task-checklist-handle').count(), 0)
      assert.equal(await page.locator('.task-checklist-edit-btn').count(), 0)
      await page.locator('.task-checklist li').nth(0).locator('label').click()
      await page.waitForFunction(() => window.__fakeDb.task_checklist_items.find(i => i.id === 'chk-1').is_done === true)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
