// Вкладка «Смета» карточки объекта: блок ДГП (единый ПСДЦ) в Chromium — стенд tests/tender/ui, /stand/dgp.
//   • одна кнопка, можно выбрать оба файла сразу: вид каждого — по шапке, заголовок и сумма — в карточке;
//   • новый файл того же вида заменяет прежний (после подтверждения), прежний удаляется из хранилища;
//   • вид не определился или оба файла одного вида — выбор в окне;
//   • не Excel — понятная ошибка, ничего не загружается; без права правки — только просмотр.
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

const COMPACT = book([
  ['ЕДИНЫЙ ПСДЦ · ЖК STORIES · ДОГОВОР №165/9/2024'],
  ['Редакция с учётом ДС №1–10 · один лист · 2 438 конечных позиций · суммы в рублях с НДС'],
  ['АКТУАЛЬНАЯ ЦЕНА ДОГОВОРА', '', '', 5932993892.39],
  ['Раздел', '№ позиции', 'Наименование работы / затрат', 'Период / НДС', 'Ед. изм', 'Объём', 'Цена за ед., ₽',
    'Прежн., ₽', 'Актуально, ₽', 'Изменение, ₽', 'Статус', 'Основание', 'Дата основания'],
])
const fullBook = (total) => book([
  ['ЕДИНЫЙ ПСДЦ  |  КОРПУС 14', '', '', 'ПСДЦ, ₽', total, 'КП · справочно, ₽', 15800053834.52],
  ['Раздел', 'Подраздел', 'Код позиции', 'Наименование работ и затрат', 'Ед. изм', 'Количество', 'Материалы КП, ₽',
    'Работы КП, ₽', 'Связь с ПСДЦ', 'UID КП', 'Вид ресурса', 'Норма расхода'],
])
const OTHER = book([['Смета'], ['Код', 'Наименование', 'Ед. изм.', 'Кол-во']])

const file = (name, buffer) => ({ name, mimeType: XLSX_MIME, buffer })
// Разряды сумм разделены неразрывными пробелами (Intl, ru-RU).
const plain = (s) => s.replace(/[\u00a0\u202f]/g, ' ')

const launch = browserLaunchOptions()

describe('Смета объекта: ДГП — комплектный и полный', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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
    await page.locator('.dgp-head-meta', { hasText: 'из 2' }).waitFor()
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }

  const docs = (page) => page.evaluate(() => (window.__fakeDb.s3_documents || [])
    .filter(d => d.owner_type === 'object').map(d => ({ category: d.doc_category, name: d.file_name, notes: JSON.parse(d.notes) })))
  const card = (page, label) => page.locator('.dgp-card', { has: page.locator(`.dgp-card-kind:text-is("${label}")`) })

  it('оба файла одной кнопкой: вид, заголовок и сумма; замена полного', async () => {
    const { page, errors, dialogs, close } = await open()
    try {
      // Порядок выбора не важен: полный первым.
      await page.getByTestId('dgp-input').setInputFiles([file('Корпус 14 полный.xlsx', fullBook(15783711735.72)), file('Stories.xlsx', COMPACT)])
      await page.locator('.dgp-head-meta', { hasText: '2 из 2' }).waitFor()
      const compact = card(page, 'Комплектный')
      assert.match(await compact.innerText(), /ЕДИНЫЙ ПСДЦ · ЖК STORIES · ДОГОВОР №165\/9\/2024/)
      assert.match(plain(await compact.locator('.dgp-card-total').innerText()), /Актуальная цена договора\s+5 932 993 892,39 ₽/)
      assert.match(await compact.innerText(), /Stories\.xlsx/)
      const full = card(page, 'Полный')
      assert.match(plain(await full.locator('.dgp-card-total').innerText()), /ПСДЦ\s+15 783 711 735,72 ₽/)
      assert.deepEqual((await docs(page)).map(d => [d.category, d.name, d.notes.detected]).sort(),
        [['dgp_compact', 'Stories.xlsx', true], ['dgp_full', 'Корпус 14 полный.xlsx', true]])
      assert.equal(dialogs.length, 0, 'без вопросов — оба вида определились, заменять нечего')

      // Новый полный: спрашивает про замену, прежний удаляется.
      await page.getByTestId('dgp-input').setInputFiles([file('Корпус 14 ред.2.xlsx', fullBook(16000000000))])
      await full.locator('.dgp-card-total', { hasText: /16\s000\s000\s000,00/ }).waitFor()
      assert.match(dialogs[0], /Заменить загруженный ДГП\?\nПолный: «Корпус 14 полный\.xlsx» → «Корпус 14 ред\.2\.xlsx»/)
      const after = await docs(page)
      assert.deepEqual(after.filter(d => d.category === 'dgp_full').map(d => d.name), ['Корпус 14 ред.2.xlsx'])
      assert.equal(after.length, 2)
      assert.equal(await page.locator('.dgp-card-extra').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('вид не определился — выбор в окне; оба одного вида — тоже', async () => {
    const { page, errors, close } = await open()
    try {
      await page.getByTestId('dgp-input').setInputFiles([file('Смета.xlsx', OTHER)])
      const dialog = page.getByRole('dialog', { name: 'Вид ДГП' })
      await dialog.waitFor()
      assert.match(await dialog.innerText(), /не удалось определить/)
      assert.equal(await dialog.getByRole('button', { name: 'Загрузить' }).isDisabled(), true)
      await dialog.getByLabel('Полный').check()
      await dialog.getByRole('button', { name: 'Загрузить' }).click()
      await card(page, 'Полный').locator('.dgp-card-file-name', { hasText: 'Смета.xlsx' }).waitFor()
      assert.equal((await docs(page))[0].notes.detected, false, 'вид выбран вручную')

      await page.getByTestId('dgp-input').setInputFiles([file('А.xlsx', fullBook(1)), file('Б.xlsx', fullBook(2))])
      await dialog.waitFor()
      assert.match(await dialog.innerText(), /Оба файла похожи на один вид/)
      assert.match(await dialog.innerText(), /заменит «Смета\.xlsx»/)
      // Оба «полный» — загрузить нельзя, пока один не станет комплектным.
      assert.equal(await dialog.getByRole('button', { name: 'Загрузить' }).isDisabled(), true)
      await dialog.getByRole('radiogroup', { name: /А\.xlsx/ }).getByLabel('Комплектный').check()
      await dialog.getByRole('button', { name: 'Загрузить' }).click()
      await page.locator('.dgp-head-meta', { hasText: '2 из 2' }).waitFor()
      await card(page, 'Полный').locator('.dgp-card-file-name', { hasText: 'Б.xlsx' }).waitFor()
      assert.deepEqual((await docs(page)).map(d => [d.category, d.name]).sort(), [['dgp_compact', 'А.xlsx'], ['dgp_full', 'Б.xlsx']])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('не Excel — ошибка, ничего не загружено; удаление; без права правки — только просмотр', async () => {
    const { page, errors, close } = await open()
    try {
      await page.getByTestId('dgp-input').setInputFiles([{ name: 'Письмо.xlsx', mimeType: XLSX_MIME, buffer: Buffer.from('это не книга Excel') }])
      await page.locator('.dgp-error', { hasText: '«Письмо.xlsx»: файл не читается как книга Excel' }).waitFor()
      assert.equal((await docs(page)).length, 0)

      await page.getByTestId('dgp-input').setInputFiles([file('Stories.xlsx', COMPACT)])
      await card(page, 'Комплектный').locator('.dgp-card-file-name').waitFor()
      await card(page, 'Комплектный').getByRole('button', { name: /Удалить/ }).click()
      await card(page, 'Комплектный').locator('.dgp-card-empty').waitFor()
      assert.equal((await docs(page)).length, 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
    const view = await open('&canEdit=0')
    try {
      assert.equal(await view.page.getByRole('button', { name: 'Загрузить ДГП' }).count(), 0)
      assert.equal(await view.page.locator('.dgp-card-empty').count(), 2)
      assert.deepEqual(view.errors, [])
    } finally {
      await view.close()
    }
  })
})
