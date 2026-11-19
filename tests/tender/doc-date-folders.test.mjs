// Папки по дню загрузки в «Должной осмотрительности» карточки контрагента (/general/counterparties → «Документы»,
// решение пользователя 19.11.2026): src/utils/docDateFolders.js, проп dateFolders у S3DocumentList. Папка — календарный день
// created_at по часам браузера (как в колонке «Когда»), отдельного поля в базе нет: прежние файлы сразу лежат по папкам.
// Новая папка раскрыта, прежние свёрнуты; несколько файлов за раз ложатся в папку сегодняшнего дня; ошибка одного файла
// не останавливает остальные. «Согласование СБ» — плоским списком, как раньше.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { dayLabel, filesCountLabel, groupDocsByDay, localDayKey, localTime } from '../../src/utils/docDateFolders.js'

const TITLE = 'Должная осмотрительность'

// Время по местным часам процесса — проверка не зависит от пояса машины.
const at = (y, m, d, hh = 10, mi = 0) => new Date(y, m - 1, d, hh, mi).toISOString()

describe('Папки по дню загрузки: правила без браузера', () => {
  it('день — по местным часам, как в колонке «Когда»', () => {
    assert.equal(localDayKey(at(2026, 11, 19, 0, 30)), '2026-11-19')
    assert.equal(localDayKey(at(2026, 11, 18, 23, 59)), '2026-11-18')
    assert.equal(localTime(at(2026, 11, 19, 9, 5)), '09:05')
    assert.equal(localDayKey(null), '')
    assert.equal(localDayKey('не дата'), '')
    assert.equal(dayLabel('2026-11-19'), '19.11.2026')
    assert.equal(dayLabel(''), 'Без даты')
  })

  it('UTC-вечер — уже следующий день по Москве', () => {
    const prev = process.env.TZ
    process.env.TZ = 'Europe/Moscow'
    try {
      assert.equal(localDayKey('2024-12-02T21:30:00Z'), '2024-12-03')
      assert.equal(localTime('2024-12-02T21:30:00Z'), '00:30')
    } finally {
      if (prev === undefined) delete process.env.TZ
      else process.env.TZ = prev
    }
  })

  it('папки — от новых к старым, «Без даты» в конце; внутри папки порядок списка', () => {
    const docs = [
      { id: 'a', created_at: at(2026, 11, 19, 15) },
      { id: 'b', created_at: at(2026, 3, 14, 12) },
      { id: 'c', created_at: at(2026, 11, 19, 9) },
      { id: 'd', created_at: null },
      { id: 'e', created_at: at(2026, 3, 14, 11) },
      { id: 'f', created_at: at(2025, 12, 31, 23) },
    ]
    const folders = groupDocsByDay(docs)
    assert.deepEqual(folders.map((f) => [f.label, f.docs.map((d) => d.id)]), [
      ['19.11.2026', ['a', 'c']],
      ['14.03.2026', ['b', 'e']],
      ['31.12.2025', ['f']],
      ['Без даты', ['d']],
    ])
    assert.deepEqual(groupDocsByDay([]), [])
    assert.deepEqual(groupDocsByDay(null), [])
  })

  it('число файлов — с согласованием', () => {
    assert.deepEqual([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map(filesCountLabel), [
      '1 файл', '2 файла', '4 файла', '5 файлов', '11 файлов', '12 файлов', '14 файлов', '21 файл', '22 файла',
      '25 файлов', '101 файл', '111 файлов',
    ])
  })
})

const launch = browserLaunchOptions()
const BASE = 'route=/general/counterparties&cps=6&cpContacts=1&items=20&latency=0'
const TZ = 'Europe/Moscow'
const todayLabel = () => new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date())

describe('Папки по дню загрузки: карточка контрагента', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  // Документы контрагента: [id, категория, имя, created_at].
  const seedFiles = ([cpId, files]) => {
    window.__fakeDb.s3_documents = window.__fakeDb.s3_documents || []
    for (const [id, category, name, createdAt] of files) {
      const key = `counterparty/${cpId}/${id}-${name}`
      window.__fakeDb.s3_documents.push({ id, owner_type: 'counterparty', owner_id: cpId, doc_category: category,
        file_name: name, s3_key: key, size_bytes: 2048, created_at: createdAt, uploaded_by_name: 'Иванов И. И.' })
    }
  }

  const SEED = ['cp-1', [
    ['dd-1', 'other', 'Выписка ЕГРЮЛ.pdf', '2025-03-14T07:00:00Z'],
    ['dd-2', 'other', 'Бухгалтерская отчётность.xlsx', '2025-03-14T08:15:00Z'],
    // 21:30 UTC — 00:30 следующего дня по Москве: папка 03.12.2024, а не 02.12.
    ['dd-3', 'other', 'Устав.pdf', '2024-12-02T21:30:00Z'],
    ['sb-1', 'sb_approval', 'Заключение СБ.pdf', '2024-12-02T09:00:00Z'],
  ]]

  async function openDocsTab(query, cpName, viewport = { width: 1440, height: 900 }) {
    const context = await browser.newContext({ locale: 'ru-RU', timezoneId: TZ, viewport })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.goto(`${stand.url}?${query}`)
    await page.waitForFunction(() => window.__fakeDb?.counterparties?.length > 0, null, { timeout: 120000 })
    await page.evaluate(seedFiles, SEED)
    // Компьютер — строка реестра, телефон — карточка списка.
    const card = viewport.width > 768
      ? page.locator('table.compact-table tbody tr.table-row', { hasText: cpName }).locator('.company-name')
      : page.locator(`text=${cpName}`).first()
    await card.waitFor({ timeout: 60000 })
    await card.click()
    await page.locator('.cp-detail-modal').waitFor()
    await page.locator('.cp-detail-tab', { hasText: 'Документы' }).click()
    await page.locator('.cp-doc-section').nth(1).waitFor()
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }

  const section = (page, title) => page.locator('.cp-doc-section')
    .filter({ has: page.locator('.s3-doc-title', { hasText: title }) })
  const folders = (sec) => sec.locator('.s3-doc-folder-toggle')
  const folderText = async (sec) => (await folders(sec).allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())
  const names = (sec) => sec.locator('.s3-doc-name').allInnerTexts()

  it('прежние файлы — по папкам дня загрузки: новая раскрыта, старая свёрнута; СБ — плоским списком', async () => {
    const { page, errors, dialogs, close } = await openDocsTab(BASE, 'Подрядчик 01')
    try {
      const dd = section(page, TITLE)
      await folders(dd).first().waitFor({ timeout: 30000 })
      assert.deepEqual(await folderText(dd), ['14.03.2025 2 файла', '03.12.2024 1 файл'])
      assert.deepEqual(await folders(dd).evaluateAll((els) => els.map((e) => e.getAttribute('aria-expanded'))), ['true', 'false'])
      assert.deepEqual(await names(dd), ['Бухгалтерская отчётность.xlsx', 'Выписка ЕГРЮЛ.pdf'])
      assert.equal(await dd.locator('th').nth(3).textContent(), 'Время')
      assert.deepEqual(await dd.locator('.s3-doc-when').allInnerTexts(), ['11:15', '10:00'])

      await folders(dd).nth(1).click()
      assert.equal(await folders(dd).nth(1).getAttribute('aria-expanded'), 'true')
      await dd.locator('.s3-doc-name', { hasText: 'Устав.pdf' }).waitFor()
      assert.equal(await dd.locator('.s3-doc-when').last().innerText(), '00:30')
      await folders(dd).first().click()
      assert.deepEqual(await names(dd), ['Устав.pdf'])

      const sb = section(page, 'Согласование СБ')
      await sb.locator('.s3-doc-name', { hasText: 'Заключение СБ.pdf' }).waitFor()
      assert.equal(await sb.locator('.s3-doc-folder-row').count(), 0)
      assert.equal(await sb.locator('th').nth(3).textContent(), 'Когда')
      assert.deepEqual(dialogs, [])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('несколько файлов за раз — в папку сегодняшнего дня; не прошедший файл не останавливает остальные', async () => {
    const { page, errors, dialogs, close } = await openDocsTab(BASE, 'Подрядчик 01')
    try {
      const dd = section(page, TITLE)
      await folders(dd).first().waitFor({ timeout: 30000 })
      // Хранилище стенда отказывает одному файлу.
      await page.evaluate(() => {
        const prev = window.fetch
        window.fetch = (url, init = {}) => (String(url).includes(encodeURIComponent('Битый')) && init.method === 'PUT'
          ? Promise.resolve(new Response('', { status: 500, statusText: 'Internal Server Error' }))
          : prev(url, init))
      })
      const file = (name) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') })
      await dd.locator('input[type=file]').setInputFiles([file('Справка ФНС.pdf'), file('Битый.pdf'), file('Анкета.pdf')])
      await dd.locator('.s3-doc-name', { hasText: 'Анкета.pdf' }).waitFor({ timeout: 30000 })
      await page.waitForFunction(() => !document.querySelector('.cp-doc-section .s3-doc-btn-primary[disabled]'))

      const today = todayLabel()
      assert.deepEqual(await folderText(dd), [`${today} 2 файла`, '14.03.2025 2 файла', '03.12.2024 1 файл'])
      assert.equal(await folders(dd).first().getAttribute('aria-expanded'), 'true')
      assert.deepEqual((await names(dd)).sort(), ['Анкета.pdf', 'Справка ФНС.pdf'])
      assert.equal(dialogs.length, 1)
      assert.match(dialogs[0], /^Не загружено 1 из 3:\n• Битый\.pdf: S3 PUT не удался \(500/)
      assert.equal(await dd.locator('.s3-doc-btn-primary').innerText(), 'Загрузить')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без права правки: папки есть, загрузки нет', async () => {
    const { page, errors, close } = await openDocsTab(`${BASE}&canEdit=0`, 'Подрядчик 01')
    try {
      const dd = section(page, TITLE)
      await folders(dd).first().waitFor({ timeout: 30000 })
      assert.deepEqual(await folderText(dd), ['14.03.2025 2 файла', '03.12.2024 1 файл'])
      assert.equal(await page.locator('.cp-detail-docs .s3-doc-btn-primary').count(), 0)
      assert.equal(await dd.locator('.s3-doc-btn-danger').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  // Таблица файлов на телефоне шире карточки и прокручивается вместе с ней вбок (так было и до папок, «Согласование СБ» —
  // так же): здесь проверяется, что дата и число файлов папки видны сразу, без прокрутки.
  it('телефон: дата папки на экране, папка раскрывается, страница не уходит вбок', async () => {
    const { page, errors, close } = await openDocsTab(BASE, 'Подрядчик 01', { width: 390, height: 844 })
    try {
      const dd = section(page, TITLE)
      await folders(dd).first().waitFor({ timeout: 30000 })
      await folders(dd).nth(1).click()
      await dd.locator('.s3-doc-name', { hasText: 'Устав.pdf' }).waitFor()
      for (const part of ['.s3-doc-folder-date', '.s3-doc-folder-count']) {
        const box = await folders(dd).first().locator(part).boundingBox()
        assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `${part} в пределах экрана: ${JSON.stringify(box)}`)
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      assert.ok(overflow <= 1, `нет прокрутки вбок: ${overflow}px`)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
