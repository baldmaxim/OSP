// Вкладка «Смета» карточки объекта: блок ДГП (единый ПСДЦ) в Chromium — стенд tests/tender/ui, /stand/dgp.
//   • вида нет: любые файлы, несколько сразу; паспорт (договор, ДС, цена) и состав — в карточке, в notes;
//   • файл с тем же именем заменяет прежний (после подтверждения); прежняя редакция того же договора — вниз с пометкой;
//   • не похожий на ПСДЦ — загрузка после вопроса; не Excel — понятная ошибка, ничего не загружается;
//   • файлы прежних видов (dgp_compact / dgp_full) — в том же списке; без права правки — только просмотр.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function book(rows) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Единый ПСДЦ')
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
}

const STORIES = book([
  ['ЕДИНЫЙ ПСДЦ · ЖК STORIES · ДОГОВОР №165/9/2024'],
  ['Редакция с учётом ДС №1–10 · один лист · суммы в рублях с НДС'],
  ['АКТУАЛЬНАЯ ЦЕНА ДОГОВОРА', '', '', 5932993892.39],
  ['Раздел', '№ позиции', 'Наименование работы / затрат', 'Период / НДС', 'Ед. изм', 'Объём', 'Цена за ед., ₽',
    'Прежн., ₽', 'Актуально, ₽', 'Изменение, ₽', 'Статус', 'Основание', 'Дата основания'],
])
const k14Book = (total) => book([
  ['ЕДИНЫЙ ПСДЦ  |  КОРПУС 14', '', '', 'ПСДЦ, ₽', total, 'КП · справочно, ₽', 15800053834.52],
  ['Раздел', 'Подраздел', 'Код позиции', 'Наименование работ и затрат', 'Ед. изм', 'Количество', 'Прежняя цена, ₽',
    'Изменение', 'Материалы КП, ₽', 'Работы КП, ₽', 'Связь с ПСДЦ', 'UID КП', 'Вид ресурса', 'Норма расхода'],
  [],
  ['ПСДЦ: договор №К14 от 25.04.2025, действующая редакция ДС №8 от 24.02.2026.'],
])
const OTHER = book([['Смета'], ['Код', 'Наименование', 'Ед. изм.', 'Кол-во']])

const file = (name, buffer) => ({ name, mimeType: XLSX_MIME, buffer })
// Разряды сумм разделены неразрывными пробелами (Intl, ru-RU).
const plain = (s) => s.replace(/[\u00a0\u202f]/g, ' ')

const launch = browserLaunchOptions()

describe('Смета объекта: ДГП — файлы единого ПСДЦ с паспортом', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open(query = '') {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1400, height: 900 } })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.goto(`${stand.url}?route=/stand/dgp&latency=0${query}`)
    await page.locator('.dgp-block').waitFor({ timeout: 120000 })
    // Список загружен: карточки или «ДГП не загружен».
    await page.locator('.dgp-empty, .dgp-card').first().waitFor()
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }

  const docs = (page) => page.evaluate(() => (window.__fakeDb.s3_documents || [])
    .filter(d => d.owner_type === 'object').map(d => ({ category: d.doc_category, name: d.file_name, notes: JSON.parse(d.notes) })))
  const card = (page, fileName) => page.locator('.dgp-card', { has: page.locator(`.dgp-card-file-name:text-is("${fileName}")`) })
  const cardNames = (page) => page.locator('.dgp-card-file-name').allInnerTexts()

  it('несколько файлов одной кнопкой: паспорт и состав; тот же файл заменяет прежний; прежняя редакция — вниз', async () => {
    const { page, errors, dialogs, close } = await open()
    try {
      await page.getByTestId('dgp-input').setInputFiles([file('Корпус 14 (ДС 1-8).xlsx', k14Book(15783711735.72)), file('Stories.xlsx', STORIES)])
      await page.locator('.dgp-head-meta', { hasText: '2 файла' }).waitFor()
      const stories = card(page, 'Stories.xlsx')
      assert.match(await stories.locator('.dgp-card-title').innerText(), /ЖК STORIES · ДОГОВОР №165\/9\/2024/)
      assert.match(plain(await stories.locator('.dgp-card-total').innerText()), /Актуальная цена договора\s+5 932 993 892,39 ₽/)
      // Договор и ДС уже в заголовке и подзаголовке — плашками не повторяются.
      assert.deepEqual(await stories.locator('.dgp-chip').allInnerTexts(), ['история изменений по ДС'])

      const k14 = card(page, 'Корпус 14 (ДС 1-8).xlsx')
      // Учтены ДС 1–8, цена — по ДС №8: пометки «действует по» нет.
      assert.match(plain(await k14.locator('.dgp-card-total').innerText()), /^ПСДЦ\s+15 783 711 735,72 ₽$/)
      assert.deepEqual(await k14.locator('.dgp-chip').allInnerTexts(),
        ['Договор № К14 от 25.04.2025', 'ДС №1–8', 'история изменений по ДС', 'материалы и работы отдельно', 'ресурсы КП'])
      const saved = await docs(page)
      assert.deepEqual(saved.map(d => d.category), ['dgp', 'dgp'])
      assert.equal(saved.find(d => d.name === 'Stories.xlsx').notes.v, 2)
      assert.equal(dialogs.length, 0, 'без вопросов — оба похожи на ПСДЦ, заменять нечего')

      // Тот же файл ещё раз — спрашивает про замену, прежний удаляется.
      await page.getByTestId('dgp-input').setInputFiles([file('Корпус 14 (ДС 1-8).xlsx', k14Book(15790000000))])
      await k14.locator('.dgp-card-total', { hasText: /15\s790\s000\s000,00/ }).waitFor()
      assert.match(dialogs[0], /^Заменить загруженный ДГП с тем же именем\?\n«Корпус 14 \(ДС 1-8\)\.xlsx» от \d\d\.\d\d\.\d{4}$/)
      assert.equal((await docs(page)).length, 2)

      // Новая редакция того же договора под другим именем — обе остаются, прежняя уходит вниз с пометкой.
      await page.getByTestId('dgp-input').setInputFiles([file('Корпус 14 (ДС 1-14).xlsx', k14Book(15800000000))])
      await page.locator('.dgp-head-meta', { hasText: '3 файла' }).waitFor()
      assert.equal(dialogs.length, 1)
      assert.deepEqual(await cardNames(page), ['Корпус 14 (ДС 1-14).xlsx', 'Stories.xlsx', 'Корпус 14 (ДС 1-8).xlsx'])
      const old = card(page, 'Корпус 14 (ДС 1-8).xlsx')
      assert.equal(await old.locator('.dgp-badge').innerText(), 'прежняя редакция')
      assert.match(await old.locator('.dgp-badge').getAttribute('title'), /ДС №1–14/)
      assert.equal(await page.locator('.dgp-badge').count(), 1)
      const fresh = card(page, 'Корпус 14 (ДС 1-14).xlsx')
      assert.ok((await fresh.locator('.dgp-chip').allInnerTexts()).includes('ДС №1–14'))
      assert.match(plain(await fresh.locator('.dgp-card-total').innerText()), /^ПСДЦ · действует по ДС №8\s+15 800 000 000,00 ₽$/)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('не похож на ПСДЦ — загрузка после вопроса; не Excel — ошибка; удаление', async () => {
    const { page, errors, dialogs, close } = await open()
    try {
      await page.getByTestId('dgp-input').setInputFiles([file('Смета.xlsx', OTHER)])
      await card(page, 'Смета.xlsx').waitFor()
      assert.match(dialogs[0], /«Смета\.xlsx» не похож на единый ПСДЦ/)
      assert.equal(await card(page, 'Смета.xlsx').locator('.dgp-card-title').innerText(), 'Смета')
      assert.equal(await card(page, 'Смета.xlsx').locator('.dgp-card-total').count(), 0)

      await page.getByTestId('dgp-input').setInputFiles([{ name: 'Письмо.xlsx', mimeType: XLSX_MIME, buffer: Buffer.from('это не книга Excel') }])
      await page.locator('.dgp-error', { hasText: '«Письмо.xlsx»: файл не читается как книга Excel' }).waitFor()
      assert.equal((await docs(page)).length, 1)

      await card(page, 'Смета.xlsx').getByRole('button', { name: /Удалить/ }).click()
      await page.locator('.dgp-empty', { hasText: 'ДГП не загружен' }).waitFor()
      assert.equal((await docs(page)).length, 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('файл прежнего вида (dgp_compact) — в списке, ДС — из имени; без права правки — только просмотр', async () => {
    const { page, errors, dialogs, close } = await open('&dgpLegacy=1')
    try {
      const legacy = card(page, 'Stories (ДС 1-10).xlsx')
      assert.match(plain(await legacy.locator('.dgp-card-total').innerText()), /Актуальная цена договора\s+5 932 993 892,39 ₽/)
      assert.deepEqual(await legacy.locator('.dgp-chip').allInnerTexts(), ['ДС №1–10'])
      // Тот же файл в новом виде заменяет прежний, хоть он и в старой категории.
      await page.getByTestId('dgp-input').setInputFiles([file('Stories (ДС 1-10).xlsx', STORIES)])
      await legacy.locator('.dgp-chip', { hasText: 'история изменений по ДС' }).waitFor()
      assert.equal(dialogs.length, 1)
      assert.deepEqual((await docs(page)).map(d => d.category), ['dgp'])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
    const view = await open('&canEdit=0&dgpLegacy=1')
    try {
      assert.equal(await view.page.getByRole('button', { name: 'Загрузить ДГП' }).count(), 0)
      assert.equal(await view.page.getByRole('button', { name: /Удалить/ }).count(), 0)
      await card(view.page, 'Stories (ДС 1-10).xlsx').getByRole('button', { name: /Скачать/ }).waitFor()
      assert.deepEqual(view.errors, [])
    } finally {
      await view.close()
    }
  })
})
