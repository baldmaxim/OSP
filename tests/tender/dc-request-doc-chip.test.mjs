// Строка файла в «Заявках на ДС» (03.11.2026, решение пользователя): нажатие на надпись — правка прямо в строке,
// двойное — скачать; в окне просмотра переименования нет. Надпись — описание файла, а его нет — имя.
// Сервер — tests/osp-api/server.test.mjs («описание файла заявки»).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()

describe('Заявки на ДС: строка файла', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open({ query = '', route = '/dc-requests', flags = {}, viewport = { width: 1600, height: 1000 } } = {}) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport, acceptDownloads: true })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.addInitScript((f) => { Object.assign(window, f) }, flags)
    await page.goto(`${stand.url}?route=${encodeURIComponent(route)}&dcStats=1&shell=1&latency=10${query}`)
    await page.locator('.dcr-report-docs .dcr-doc-chip').first().waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const row = (page, id) => page.evaluate((x) => {
    const d = window.__fakeDb.s3_documents.find((r) => r.id === x)
    return d && { file_name: d.file_name, notes: d.notes, s3_key: d.s3_key }
  }, id)
  const writes = (page) => page.evaluate(() => window.__supabaseStats.requests
    .filter((r) => r.table === 's3_documents' && r.op === 'update').length)
  const d2 = (page) => page.locator('.dcr-table tbody tr', { hasText: 'ДС-d2' })
  // Рабочие файлы заявки свёрнуты: раскрываем.
  const generalChips = async (page) => {
    await d2(page).locator('.dcr-docs-toggle').click()
    return d2(page).locator('.dcr-docs .dcr-doc-chip')
  }
  const reportName = (page) => d2(page).locator('.dcr-report-docs .dcr-doc-chip-main')
  const input = (page) => page.locator('.dcr-doc-edit-input')
  // Дольше ожидания второго нажатия: одиночное нажатие успело бы сработать.
  const pastDoubleClick = (page) => page.waitForTimeout(500)

  it('в окне просмотра переименования нет', async () => {
    const { page, errors, close } = await open({ route: '/dc-requests?file=dcf-3' })
    try {
      await page.locator('.s3-doc-preview').waitFor()
      assert.equal(await page.locator('.s3-doc-modal-title').innerText(), 'Отчёт.pdf')
      assert.equal(await page.locator('.s3-doc-rename-btn').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('файл без описания: нажатие — правка имени без расширения; новое имя в базе и в строке, ключ прежний', async () => {
    const { page, errors, close } = await open()
    try {
      const was = await row(page, 'dcf-3')
      await reportName(page).click()
      await input(page).waitFor()
      assert.equal(await input(page).inputValue(), 'Отчёт')
      assert.equal(await page.locator('.dcr-doc-edit-ext').innerText(), '.pdf')
      assert.equal(await input(page).evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd)), 'Отчёт', 'имя выделено')
      assert.equal(await page.locator('.s3-doc-preview').count(), 0, 'просмотр не открылся')

      await input(page).fill('Отчёт по документам, ред. 2')
      await input(page).press('Enter')
      await d2(page).locator('.dcr-report-docs .dcr-doc-chip-desc', { hasText: 'Отчёт по документам, ред. 2.pdf' }).waitFor()
      assert.equal(await input(page).count(), 0, 'правка закрылась')
      assert.deepEqual(await row(page, 'dcf-3'), { ...was, file_name: 'Отчёт по документам, ред. 2.pdf' })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('файл с описанием: правится описание, имя файла прежнее; пустое — в строке снова имя файла', async () => {
    const { page, errors, close } = await open()
    try {
      const chips = await generalChips(page)
      await chips.locator('.dcr-doc-chip-main', { hasText: 'Расчёт было-стало' }).click()
      await input(page).waitFor()
      assert.equal(await input(page).inputValue(), 'Расчёт было-стало')
      assert.equal(await page.locator('.dcr-doc-edit-ext').count(), 0, 'расширения у описания нет')

      await input(page).fill('Было-стало, ред. 2')
      await page.getByRole('button', { name: 'ОК', exact: true }).click()
      await chips.locator('.dcr-doc-chip-desc', { hasText: 'Было-стало, ред. 2' }).waitFor()
      const after = await row(page, 'dcf-1')
      assert.equal(after.notes, 'Было-стало, ред. 2')
      assert.equal(after.file_name, 'Было-стало.pdf')

      await chips.locator('.dcr-doc-chip-main', { hasText: 'Было-стало, ред. 2' }).click()
      await input(page).waitFor()
      await input(page).fill('')
      await input(page).press('Enter')
      await chips.locator('.dcr-doc-chip-desc-empty', { hasText: 'Было-стало.pdf' }).waitFor()
      assert.equal((await row(page, 'dcf-1')).notes, null)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('двойное нажатие скачивает файл; правка и просмотр не открываются', async () => {
    const { page, errors, close } = await open({ flags: { __fakeRemoteFiles: true } })
    try {
      const chips = await generalChips(page)
      for (const [name, file] of [['Письмо.docx', 'Письмо.docx'], ['Расчёт было-стало', 'Было-стало.pdf']]) {
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          chips.locator('.dcr-doc-chip-main', { hasText: name }).dblclick(),
        ])
        assert.equal(download.suggestedFilename(), file)
        await pastDoubleClick(page)
        assert.equal(await input(page).count(), 0, 'правка не открылась')
        assert.equal(await page.locator('.s3-doc-preview').count(), 0, 'просмотр не открылся')
      }
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('значки в строке прежние: просмотр и скачивание', async () => {
    const { page, errors, close } = await open({ flags: { __fakeRemoteFiles: true } })
    try {
      const chip = (await generalChips(page)).filter({ hasText: 'Расчёт было-стало' })
      const [download] = await Promise.all([page.waitForEvent('download'), chip.getByRole('button', { name: 'Скачать' }).click()])
      assert.equal(download.suggestedFilename(), 'Было-стало.pdf')
      await chip.getByRole('button', { name: 'Просмотр' }).click()
      await page.locator('.s3-doc-preview').waitFor()
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('Escape и «Отмена» — без записи; то же имя — без записи; щелчок мимо ввод не теряет', async () => {
    const { page, errors, close } = await open()
    try {
      const before = await writes(page)
      await reportName(page).click()
      await input(page).fill('Другое')
      await input(page).press('Escape')
      await input(page).waitFor({ state: 'detached' })

      await reportName(page).click()
      await input(page).fill('Другое')
      await page.mouse.click(3, 3)
      assert.equal(await input(page).inputValue(), 'Другое', 'ввод на месте')
      await page.getByRole('button', { name: 'Отмена', exact: true }).click()
      await input(page).waitFor({ state: 'detached' })

      await reportName(page).click()
      await input(page).fill('Отчёт.pdf')
      await input(page).press('Enter')
      await input(page).waitFor({ state: 'detached' })

      assert.equal(await writes(page), before, 'записи не было')
      assert.equal((await row(page, 'dcf-3')).file_name, 'Отчёт.pdf')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('плохое имя и отказ базы — причина в строке, ввод не пропал, имя прежнее', async () => {
    const { page, errors, close } = await open()
    try {
      await reportName(page).click()
      await input(page).fill('Отчёт: итог')
      await input(page).press('Enter')
      assert.match(await page.locator('.dcr-doc-edit-error').innerText(), /нельзя использовать/)
      await input(page).fill('   ')
      assert.equal(await page.locator('.dcr-doc-edit-error').count(), 0, 'ввод снимает подсказку')
      await input(page).press('Enter')
      assert.match(await page.locator('.dcr-doc-edit-error').innerText(), /Укажите имя/)

      await page.evaluate(() => {
        window.__fakeHold = ({ table, op }) => (table === 's3_documents' && op === 'update' ? { error: { message: 'Нет доступа', code: '42501' } } : {})
      })
      await input(page).fill('Новое')
      await input(page).press('Enter')
      await page.locator('.dcr-doc-edit-error', { hasText: 'Нет доступа' }).waitFor()
      assert.equal(await input(page).inputValue(), 'Новое')

      await page.evaluate(() => {
        window.__fakeHold = null
        window.__fakeDb.s3_documents = window.__fakeDb.s3_documents.filter((d) => d.id !== 'dcf-3')
      })
      await input(page).press('Enter')
      await page.locator('.dcr-doc-edit-error', { hasText: 'Файл не переименован' }).waitFor()
      assert.equal(await input(page).inputValue(), 'Новое')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без права правки: нажатие на PDF и Word — просмотр, двойное — скачать; правки и удаления нет', async () => {
    const { page, errors, close } = await open({ query: '&canEdit=0', flags: { __fakeRemoteFiles: true } })
    try {
      const chips = await generalChips(page)
      assert.equal(await page.locator('.dcr-doc-chip-del').count(), 0)

      // Word (13.11.2026) — тоже просмотр: глазик и нажатие.
      assert.equal(await chips.filter({ hasText: 'Письмо.docx' }).getByRole('button', { name: 'Просмотр' }).count(), 1)
      await chips.locator('.dcr-doc-chip-main', { hasText: 'Письмо.docx' }).click()
      await page.locator('.s3-doc-preview .docx-preview-wrap').waitFor()
      assert.equal(await input(page).count(), 0)
      await page.locator('.s3-doc-modal-close').click()
      await page.locator('.s3-doc-preview').waitFor({ state: 'detached' })

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        chips.locator('.dcr-doc-chip-main', { hasText: 'Письмо.docx' }).dblclick(),
      ])
      assert.equal(download.suggestedFilename(), 'Письмо.docx')

      await chips.locator('.dcr-doc-chip-main', { hasText: 'Расчёт было-стало' }).click()
      await page.locator('.s3-doc-preview').waitFor()
      assert.equal(await input(page).count(), 0)
      assert.equal(await page.locator('.s3-doc-rename-btn').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('поле и подсказка помещаются в столбец', async () => {
    const { page, errors, close } = await open({ viewport: { width: 1280, height: 800 } })
    try {
      await reportName(page).click()
      await input(page).waitFor()
      await input(page).fill('Отчёт: итог')
      await input(page).press('Enter')
      await page.locator('.dcr-doc-edit-error').waitFor()
      const look = await page.evaluate(() => {
        const chip = document.querySelector('.dcr-doc-chip.is-editing').getBoundingClientRect()
        const inside = [...document.querySelectorAll('.dcr-doc-edit input, .dcr-doc-edit button, .dcr-doc-edit-ext, .dcr-doc-edit-error')]
          .every((el) => { const r = el.getBoundingClientRect(); return r.left >= chip.left - 1 && r.right <= chip.right + 1 && r.bottom <= chip.bottom + 1 })
        return { inside, inputWidth: document.querySelector('.dcr-doc-edit-input').getBoundingClientRect().width }
      })
      assert.ok(look.inside, 'всё внутри строки файла')
      assert.ok(look.inputWidth >= 96, `ширина поля ${look.inputWidth}`)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('окно итога проверки: та же правка; Escape не закрывает окно; новое имя и в реестре', async () => {
    const { page, errors, close } = await open()
    try {
      await d2(page).locator(':is(.dcr-verdict-badge, .dcr-verdict-add)').first().click()
      const modal = page.locator('.dcr-verdict-modal')
      await modal.waitFor()
      await modal.locator('.dcr-doc-chip-main', { hasText: 'Отчёт.pdf' }).click()
      await modal.locator('.dcr-doc-edit-input').fill('Другое')
      await modal.locator('.dcr-doc-edit-input').press('Escape')
      await modal.locator('.dcr-doc-edit-input').waitFor({ state: 'detached' })
      assert.equal(await modal.count(), 1, 'окно на месте')

      await modal.locator('.dcr-doc-chip-main', { hasText: 'Отчёт.pdf' }).click()
      await modal.locator('.dcr-doc-edit-input').fill('Отчёт ред. 2')
      await modal.locator('.dcr-doc-edit-input').press('Enter')
      await modal.locator('.dcr-doc-chip-desc', { hasText: 'Отчёт ред. 2.pdf' }).waitFor()
      assert.equal(await modal.count(), 1, 'окно на месте')
      await d2(page).locator('.dcr-report-docs .dcr-doc-chip-desc', { hasText: 'Отчёт ред. 2.pdf' }).waitFor({ state: 'attached' })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
