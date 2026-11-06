// «Заявки на ДС»: примечание — выпадающая полоса под заявкой (миграция 20261230, обе базы; решение пользователя 05.11.2026,
// образец — примечание юриста в реестре договоров). Заметка коллеги, написанная после открытия страницы, не стирается.
// Стенд tests/tender/ui (route=/dc-requests&dcStats=1&dcNotes=1; без dcNotes — колонки в базе нет).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import * as XLSX from 'xlsx'
import { DC_NOTE_MAX, hasNoteColumn, mergeNote, notePreview } from '../../src/utils/dcRequestNotes.js'
import { TestDatabase, pgAvailable } from '../psdc/lib/pg.mjs'
import { startStand, browserLaunchOptions, REPO as ROOT } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const SUPABASE = path.join(ROOT, 'supabase/migrations/20261230_dc_request_notes.sql')
const YANDEX = path.join(ROOT, 'migration/yandex/20261230_dc_request_notes.sql')
const YANDEX_CHECK = path.join(ROOT, 'migration/yandex/20261230_dc_request_notes.check.sql')
const PROD_CHECK = path.join(ROOT, 'migration/backup/checks/20261230.sql')
const ROLLBACK = path.join(ROOT, 'migration/rollback/20261230_dc_request_notes_rollback.sql')

describe('Примечание заявки на ДС: правила', () => {
  it('никто не мешал — записывается своё', () => {
    assert.equal(mergeNote(null, 'моё', null), 'моё')
    assert.equal(mergeNote('было', 'стало', 'было'), 'стало')
    assert.equal(mergeNote('было', null, 'было'), null, 'стёр — пусто')
    assert.equal(mergeNote('было', 'то же', 'то же'), 'то же', 'коллега написал то же самое')
  })

  it('коллега успел написать — его текст остаётся, своё дописывается', () => {
    assert.equal(mergeNote(null, 'моё', 'коллеги'), 'коллеги\nмоё', 'в пустое поле написали оба')
    assert.equal(mergeNote('было', 'было\nмоё', 'было\nколлеги'), 'было\nколлеги\nмоё', 'оба дописали в конец — без повтора общего')
    assert.equal(mergeNote('было', 'переписал', 'было\nколлеги'), 'было\nколлеги\nпереписал', 'переписал начало — ничего не теряется')
    assert.equal(mergeNote('было', null, 'коллеги'), 'коллеги', 'стёр старое, а коллега написал новое — новое остаётся')
    assert.equal(mergeNote('было', 'моё', null), 'моё', 'коллега стёр — своё записывается')
  })

  it('полоса — только когда в базе есть колонка; свёрнутый текст — одной строкой', () => {
    assert.equal(hasNoteColumn([{ id: 'a' }]), false)
    assert.equal(hasNoteColumn([]), false)
    assert.equal(hasNoteColumn([{ id: 'a', notes: null }]), true)
    assert.equal(notePreview('  первая\n\n вторая '), 'первая вторая')
    assert.equal(notePreview(null), '')
  })

  it('миграции обеих баз делают одно и то же; предел тот же, что на странице', () => {
    const body = (file) => fs.readFileSync(file, 'utf8')
      .replace(/--.*$/gm, '')
      .replace(/^\s*(BEGIN|COMMIT|SET LOCAL lock_timeout = '10s');\s*$/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
    assert.equal(body(YANDEX), body(SUPABASE))
    assert.ok(body(SUPABASE).includes(`char_length(notes) <= ${DC_NOTE_MAX}`))
  })
})

const BOOTSTRAP = `
CREATE TABLE public.dc_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ds_number text);
ALTER TABLE public.dc_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dc_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY dc_requests_all ON public.dc_requests FOR ALL USING (true) WITH CHECK (true);
INSERT INTO public.dc_requests (ds_number) VALUES ('old-1');
`

describe('Примечание заявки на ДС в базе', { skip: pgAvailable() ? false : 'Нет PostgreSQL' }, () => {
  let db
  const lines = (out) => out.split('\n').filter(Boolean)
  const isAllOk = (out) => out.length >= 3 && out.every(l => l.startsWith('OK '))

  before(() => {
    db = new TestDatabase()
    db.start()
    db.exec(BOOTSTRAP)
  })
  after(() => db?.stop())

  it('проверка до миграции — FAIL, а не ошибка; после — только OK; повтор безопасен; откат убирает колонку', () => {
    const early = lines(db.exec(fs.readFileSync(PROD_CHECK, 'utf8')))
    assert.ok(early.every(l => /^(OK|FAIL) /.test(l)) && early.some(l => l.startsWith('FAIL ')), early.join('\n'))

    db.applyFile(SUPABASE)
    db.applyFile(SUPABASE)
    for (const file of [PROD_CHECK, YANDEX_CHECK]) {
      const out = lines(db.exec(fs.readFileSync(file, 'utf8')))
      assert.ok(isAllOk(out), `${path.basename(file)}:\n${out.join('\n')}`)
    }

    db.exec(`UPDATE public.dc_requests SET notes = repeat('я', ${DC_NOTE_MAX});`)
    assert.throws(() => db.exec(`UPDATE public.dc_requests SET notes = repeat('я', ${DC_NOTE_MAX + 1});`), /dc_requests_notes_check/)

    db.applyFile(ROLLBACK)
    assert.equal(db.exec(`SELECT count(*) FROM information_schema.columns
      WHERE table_name = 'dc_requests' AND column_name = 'notes';`).trim(), '0')
    db.applyFile(SUPABASE)
  })
})

describe('Реестр заявок на ДС: примечание', { skip: !launch && 'Нет Chromium/Chrome/Edge (PSDC_BROWSER)' }, () => {
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

  async function open(extra = '&dcNotes=1', { width = 1920 } = {}) {
    const context = await browser.newContext({
      locale: 'ru-RU', viewport: { width, height: 1000 }, acceptDownloads: true, hasTouch: width < 700,
    })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}) })
    await page.goto(`${stand.url}?route=/dc-requests&dcStats=1&latency=10&shell=1${extra}`)
    await page.locator(width < 700 ? '.mcard' : '.dcr-table td.ui-rownum').first().waitFor({ timeout: 120000 })
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }
  // Полоса заявки — следующая строка таблицы за строкой с её номером ДС.
  const noteOf = (page, ds) => page.locator('.dcr-table tbody tr', { hasText: `ДС-${ds}` }).locator('xpath=following-sibling::tr[1][contains(@class, "dcr-note-row")]')
  const dbNote = (page, id) => page.evaluate((rid) => window.__fakeDb.dc_requests.find(x => x.id === rid).notes, id)
  const audit = (page, id) => page.evaluate((rid) => window.__fakeDb.dc_request_audit_log
    .filter(e => e.dc_request_id === rid && e.field_name === 'notes').map(e => e.description), id)

  it('колонки в базе нет — полосы нет, строки как раньше', async () => {
    const { page, errors, close } = await open('')
    try {
      assert.equal(await page.locator('.dcr-note-row').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('свёрнуто: под каждой заявкой во всю ширину, текст одной строкой; раскрыто: поле с текстом', async () => {
    const { page, errors, close } = await open()
    try {
      const rows = await page.locator('.dcr-table tbody tr:not(.dcr-note-row)').count()
      assert.equal(await page.locator('.dcr-note-row').count(), rows)

      const empty = noteOf(page, 'd1')
      assert.match(await empty.locator('.dcr-note-toggle').innerText(), /Примечание\s*добавить/)
      const d2 = noteOf(page, 'd2')
      assert.match(await d2.locator('.dcr-note-preview').innerText(), /^Ждём письмо заказчика Срок — до 15\.11$/)
      assert.equal(await d2.locator('textarea').count(), 0)
      const widths = await d2.evaluate((tr) => [tr.getBoundingClientRect().width, tr.closest('table').getBoundingClientRect().width])
      assert.ok(Math.abs(widths[0] - widths[1]) < 1, `полоса ${widths[0]} при таблице ${widths[1]}`)

      await d2.locator('.dcr-note-toggle').click()
      assert.equal(await d2.locator('.dcr-note-toggle').getAttribute('aria-expanded'), 'true')
      assert.equal(await d2.locator('textarea').inputValue(), 'Ждём письмо заказчика\nСрок — до 15.11')
      assert.equal(await d2.locator('.dcr-note-preview').count(), 0)
      const fits = await d2.locator('textarea').evaluate((el) => el.scrollHeight <= el.clientHeight + 1)
      assert.ok(fits, 'поле растёт по тексту, без своей прокрутки')

      await d2.locator('.dcr-note-toggle').click()
      assert.equal(await d2.locator('textarea').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('пустое поле получает фокус при раскрытии; заполненное — нет', async () => {
    const { page, close } = await open()
    try {
      await noteOf(page, 'd1').locator('.dcr-note-toggle').click()
      await page.waitForFunction(() => document.activeElement?.classList.contains('dcr-note-input'))
      await page.keyboard.press('Escape')
      await noteOf(page, 'd2').locator('.dcr-note-toggle').click()
      await noteOf(page, 'd2').locator('textarea').waitFor()
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('dcr-note-input')), false)
    } finally { await close() }
  })

  it('сохраняется при уходе из поля; лишние пробелы убираются; запись в истории', async () => {
    const { page, errors, close } = await open()
    try {
      const d1 = noteOf(page, 'd1')
      await d1.locator('.dcr-note-toggle').click()
      await d1.locator('textarea').fill('  Первая заметка  ')
      await d1.locator('textarea').press('Tab')
      await page.waitForFunction(() => window.__fakeDb.dc_requests.find(x => x.id === 'd1').notes != null)
      assert.equal(await dbNote(page, 'd1'), 'Первая заметка')
      assert.deepEqual(await audit(page, 'd1'), ['Примечание: — → Первая заметка'])
      await d1.locator('.dcr-note-status').waitFor({ state: 'detached' })
      assert.equal(await d1.locator('textarea').inputValue(), 'Первая заметка')

      // Заметка осталась на экране: можно дописать сразу, перечитывать страницу не надо.
      await d1.locator('textarea').fill('Первая заметка\nВторая заметка')
      await d1.locator('textarea').press('Control+Enter')
      await page.waitForFunction(() => window.__fakeDb.dc_requests.find(x => x.id === 'd1').notes?.includes('Вторая'))
      assert.equal(await dbNote(page, 'd1'), 'Первая заметка\nВторая заметка')

      // Стереть можно: в базе снова пусто, в полосе — «добавить».
      await d1.locator('.dcr-note-status').waitFor({ state: 'detached' })
      await d1.locator('textarea').fill('   ')
      await d1.locator('textarea').press('Tab')
      await page.waitForFunction(() => window.__fakeDb.dc_requests.find(x => x.id === 'd1').notes === null)
      await d1.locator('.dcr-note-toggle').click()
      assert.match(await d1.locator('.dcr-note-toggle').innerText(), /добавить/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без изменений ничего не пишется; Esc отменяет правку', async () => {
    const { page, errors, close } = await open()
    try {
      const d2 = noteOf(page, 'd2')
      await d2.locator('.dcr-note-toggle').click()
      await d2.locator('textarea').focus()
      await d2.locator('textarea').press('Tab')
      await d2.locator('textarea').fill('черновик')
      await d2.locator('textarea').press('Escape')
      await page.waitForFunction(() => document.querySelector('.dcr-note-input') && document.activeElement?.tagName !== 'TEXTAREA')
      await page.waitForTimeout(100)
      assert.equal(await dbNote(page, 'd2'), 'Ждём письмо заказчика\nСрок — до 15.11')
      assert.deepEqual(await audit(page, 'd2'), [])
      assert.equal(await d2.locator('textarea').inputValue(), 'Ждём письмо заказчика\nСрок — до 15.11')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('коллега написал после открытия страницы — его заметка не стирается, видны оба текста', async () => {
    const { page, errors, close } = await open()
    try {
      const d2 = noteOf(page, 'd2')
      await d2.locator('.dcr-note-toggle').click()
      await page.evaluate(() => {
        window.__fakeDb.dc_requests.find(x => x.id === 'd2').notes = 'Ждём письмо заказчика\nСрок — до 15.11\nПисьмо пришло'
      })
      await d2.locator('textarea').fill('Ждём письмо заказчика\nСрок — до 15.11\nПередано юристу')
      await d2.locator('textarea').press('Tab')
      await d2.locator('.dcr-note-status.is-warn').waitFor()
      const expected = 'Ждём письмо заказчика\nСрок — до 15.11\nПисьмо пришло\nПередано юристу'
      assert.equal(await dbNote(page, 'd2'), expected)
      assert.equal(await d2.locator('textarea').inputValue(), expected)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('не сохранилось — сообщение, текст остаётся и переживает сворачивание; следующий уход из поля повторяет запись', async () => {
    const { page, errors, dialogs, close } = await open()
    try {
      const d1 = noteOf(page, 'd1')
      await d1.locator('.dcr-note-toggle').click()
      await page.evaluate(() => { window.__fakeHold = ({ table, op }) => (table === 'dc_requests' && op === 'update' ? { error: { message: 'сеть' } } : {}) })
      await d1.locator('textarea').fill('Важная заметка')
      await d1.locator('textarea').press('Tab')
      await d1.locator('.dcr-note-status.is-error').waitFor()
      assert.match(dialogs.join(), /Ошибка сохранения примечания: сеть/)
      assert.equal(await dbNote(page, 'd1'), null)
      assert.equal(await d1.locator('textarea').inputValue(), 'Важная заметка')

      await d1.locator('.dcr-note-toggle').click()
      assert.equal(await d1.locator('.dcr-note-preview').innerText(), 'Важная заметка')
      await d1.locator('.dcr-note-toggle').click()
      assert.equal(await d1.locator('textarea').inputValue(), 'Важная заметка')

      await page.evaluate(() => { window.__fakeHold = null })
      await d1.locator('textarea').focus()
      await d1.locator('textarea').press('Tab')
      await page.waitForFunction(() => window.__fakeDb.dc_requests.find(x => x.id === 'd1').notes === 'Важная заметка')
      await d1.locator('.dcr-note-status').waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Отдел по удорожанию» пишет и без права правки раздела', async () => {
    const { page, errors, close } = await open('&dcNotes=1&asRole=udorojanie&noEdit=dc_requests')
    try {
      const d1 = noteOf(page, 'd1')
      await d1.locator('.dcr-note-toggle').click()
      await d1.locator('textarea').fill('Смотрим расчёт')
      await d1.locator('textarea').press('Tab')
      await page.waitForFunction(() => window.__fakeDb.dc_requests.find(x => x.id === 'd1').notes === 'Смотрим расчёт')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('только просмотр: полоса — там, где что-то написано, текст без поля', async () => {
    const { page, errors, close } = await open('&dcNotes=1&canEdit=0')
    try {
      assert.equal(await page.locator('.dcr-note-row').count(), 1)
      const d2 = noteOf(page, 'd2')
      await d2.locator('.dcr-note-toggle').click()
      assert.equal(await d2.locator('textarea').count(), 0)
      assert.equal(await d2.locator('.dcr-note-text').innerText(), 'Ждём письмо заказчика\nСрок — до 15.11')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('сотрудник, привязанный к объектам, примечания не видит и не находит по ним', async () => {
    const all = await open()
    const scope = await all.page.evaluate(() => window.__fakeDb.dc_requests.find(x => x.id === 'd2').object_id)
    await all.close()
    const { page, errors, close } = await open(`&dcNotes=1&scope=${scope}`)
    try {
      assert.equal(await page.locator('.dcr-note-row').count(), 0)
      const search = page.locator('.dcr-toolbar input').first()
      await search.fill('Ждём письмо')
      await page.getByText('Ничего не найдено.').waitFor()
      await search.fill('')
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.dcr-export-btn').click()])
      const wb = XLSX.read(fs.readFileSync(await download.path()), { type: 'buffer' })
      const head = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 })[0]
      assert.ok(!head.includes('Примечание'), head.join(' | '))
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('в «Удаленных» — только чтение, у пустых полосы нет', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('.status-tab', { hasText: 'Удаленные' }).click()
      const d6 = noteOf(page, 'd6')
      await d6.waitFor()
      await d6.locator('.dcr-note-toggle').click()
      assert.equal(await d6.locator('textarea').count(), 0)
      assert.equal(await d6.locator('.dcr-note-text').innerText(), 'Заявку сняли')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('поиск находит по примечанию; выгрузка — столбец «Примечание»', async () => {
    const { page, errors, close } = await open()
    try {
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.dcr-export-btn').click()])
      const wb = XLSX.read(fs.readFileSync(await download.path()), { type: 'buffer', cellStyles: true })
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]])
      assert.equal(rows.find(r => r['№ ДС'] === 'ДС-d2')['Примечание'], 'Ждём письмо заказчика\nСрок — до 15.11')
      const head = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 })[0]
      assert.equal(wb.Sheets[wb.SheetNames[0]]['!cols'].length, head.length, 'ширина — у каждого столбца')

      await page.locator('.dcr-toolbar input').first().fill('письмо заказчика')
      await page.waitForFunction(() => document.querySelectorAll('.dcr-table tbody tr:not(.dcr-note-row)').length === 1)
      assert.match(await page.locator('.dcr-table tbody tr').first().innerText(), /ДС-d2/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('раскрытое примечание переживает обновление страницы', async () => {
    const { page, errors, close } = await open()
    try {
      await noteOf(page, 'd2').locator('.dcr-note-toggle').click()
      await page.waitForFunction(() => sessionStorage.getItem('dcRequests:view:v1')?.includes('"notesOpen":["d2"]'))
      await page.reload()
      await noteOf(page, 'd2').locator('textarea').waitFor()
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('меню статуса последней заявки помещается: под строкой теперь полоса примечания', async () => {
    const { page, errors, close } = await open()
    try {
      // Одна заявка в реестре: меню идёт вниз и строка подрастает под него (высокий реестр открыл бы его вверх).
      await page.locator('.dcr-toolbar input').first().fill('ДС-d3')
      await page.waitForFunction(() => document.querySelectorAll('.dcr-table tbody tr:not(.dcr-note-row)').length === 1)
      const last = page.locator('.dcr-table tbody tr:not(.dcr-note-row)').last()
      assert.equal(await page.locator('.dcr-note-row').count(), 1)
      await last.locator('.dcr-status-chip, .dcr-status-wrap button').first().click()
      await last.locator('.dcr-status-popover').waitFor()
      assert.equal(await last.locator('.dcr-status-popover.is-up').count(), 0, 'места хватает — меню вниз')
      const height = await last.evaluate(tr => tr.getBoundingClientRect().height)
      const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))
      assert.ok(height >= 13 * rem - 1, `строка ${height}px`)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('ширина столбца при длинном реестре: полосы скрываются и возвращаются вместе со строками', async () => {
    const { page, errors, close } = await open('&dcNotes=1&dcMany=150')
    try {
      const handle = page.locator('.dcr-table thead th .col-resize-handle, .dcr-table thead th [role="separator"]').nth(2)
      const box = await handle.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 4 })
      assert.ok(await page.locator('tbody tr[data-col-frozen="hidden"].dcr-note-row').count() > 0, 'полосы вне экрана скрыты')
      await page.mouse.up()
      await page.waitForFunction(() => !document.querySelector('.dcr-table tbody[data-col-frozen]'), null, { timeout: 15000 })
      assert.equal(await page.locator('.dcr-table tbody tr[data-col-frozen]').count(), 0)
      const rows = await page.locator('.dcr-table tbody tr:not(.dcr-note-row)').count()
      assert.equal(await page.locator('.dcr-note-row').count(), rows)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('телефон: полоса в карточке, поле пишет так же', async () => {
    const { page, errors, close } = await open('&dcNotes=1', { width: 390 })
    try {
      const card = page.locator('.mcard', { hasText: 'ДС-d1' })
      await card.locator('.dcr-note-toggle').click()
      await card.locator('textarea').fill('С телефона')
      await card.locator('textarea').blur()
      await page.waitForFunction(() => window.__fakeDb.dc_requests.find(x => x.id === 'd1').notes === 'С телефона')
      await card.locator('.dcr-note-status').waitFor({ state: 'detached' })
      const size = await card.locator('textarea').evaluate(el => parseFloat(getComputedStyle(el).fontSize))
      assert.equal(size, 16, 'мельче iOS увеличивает страницу при вводе')
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
      assert.ok(scroll, 'страница не шире экрана')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
