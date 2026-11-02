// Переименование файла в окне просмотра (S3DocumentPreview, 02.11.2026, решение пользователя: кнопка «Переименовать» с
// карандашом на цветном фоне рядом с именем файла). Меняется только s3_documents.file_name: ключ в хранилище прежний,
// просмотр не перезагружается, расширение менять нельзя. Кнопка — только там, где родитель разрешил (право — как у
// удаления файла этого списка); подрядчику её нет. Сервер — tests/osp-api/server.test.mjs («переименование»).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { composeFileName, fileNameProblem, splitFileName } from '../../src/utils/fileRename.js'

const launch = browserLaunchOptions()

describe('Правила имени файла', () => {
  it('расширение — латиница с буквой; «ред.2» и дата — продолжение имени', () => {
    assert.deepEqual(splitFileName('КП вентиляция (Дом 56) согласовано.pdf'), { stem: 'КП вентиляция (Дом 56) согласовано', ext: '.pdf' })
    assert.deepEqual(splitFileName('архив.7z'), { stem: 'архив', ext: '.7z' })
    assert.deepEqual(splitFileName('КП ред.2'), { stem: 'КП ред.2', ext: '' })
    assert.deepEqual(splitFileName('Договор от 10.10.2026'), { stem: 'Договор от 10.10.2026', ext: '' })
    assert.deepEqual(splitFileName('Акт ред.б'), { stem: 'Акт ред.б', ext: '' })
    assert.deepEqual(splitFileName(null), { stem: '', ext: '' })
  })

  it('имя из ввода: края и невидимое убираются, расширение не удваивается', () => {
    assert.equal(composeFileName('  КП  ', '.pdf'), 'КП.pdf')
    assert.equal(composeFileName('КП.', '.pdf'), 'КП.pdf')
    assert.equal(composeFileName('КП.pdf', '.pdf'), 'КП.pdf')
    assert.equal(composeFileName('КП.PDF ', '.pdf'), 'КП.pdf')
    assert.equal(composeFileName('Акт 1.2', '.pdf'), 'Акт 1.2.pdf')
    assert.equal(composeFileName('a\tb​', '.pdf'), 'a b.pdf')
    assert.equal(composeFileName('Без расширения', ''), 'Без расширения')
    assert.equal(composeFileName('   ', '.pdf'), '')
    assert.equal(composeFileName('.pdf', '.pdf'), '')
  })

  it('что не пропускаем', () => {
    assert.equal(fileNameProblem('Новое.pdf', 'Старое.pdf'), null)
    assert.equal(fileNameProblem('Новое.PDF', 'Старое.pdf'), null)
    assert.equal(fileNameProblem('Новое', 'Старое'), null)
    assert.match(fileNameProblem('', 'Старое.pdf'), /Укажите/)
    assert.match(fileNameProblem('.pdf', 'Старое.pdf'), /Укажите/)
    assert.match(fileNameProblem('Новое.xlsx', 'Старое.pdf'), /Расширение/)
    assert.match(fileNameProblem('Новое', 'Старое.pdf'), /Расширение/)
    assert.match(fileNameProblem('Новое.pdf', 'Старое'), /Расширение/)
    for (const ch of ['\\', '/', ':', '*', '?', '"', '<', '>', '|', '\n', '‮']) {
      assert.match(fileNameProblem(`a${ch}b.pdf`, 'Старое.pdf'), /нельзя использовать/, JSON.stringify(ch))
    }
    assert.match(fileNameProblem(`${'я'.repeat(252)}.pdf`, 'Старое.pdf'), /длиннее/)
    assert.equal(fileNameProblem(`${'я'.repeat(251)}.pdf`, 'Старое.pdf'), null)
  })

  it('подрядчику кнопки нет: кабинет не передаёт onRenamed', () => {
    const text = fs.readFileSync(path.join(REPO, 'src', 'pages', 'ContractorCabinetPage.jsx'), 'utf8')
    assert.match(text, /<S3DocumentPreview /)
    assert.doesNotMatch(text, /onRenamed/)
  })
})

describe('Окно просмотра: переименование', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open(fileId, { query = '', flags = {}, viewport = { width: 1600, height: 1000 } } = {}) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport, acceptDownloads: true })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.addInitScript((f) => { Object.assign(window, f) }, flags)
    await page.goto(`${stand.url}?route=${encodeURIComponent(`/dc-requests?file=${fileId}`)}&dcStats=1&shell=1&latency=10${query}`)
    await page.locator('.s3-doc-preview').waitFor({ timeout: 120000 })
    return { context, page, errors, close: () => context.close() }
  }
  const row = (page, id) => page.evaluate((x) => {
    const d = window.__fakeDb.s3_documents.find((r) => r.id === x)
    return d && { file_name: d.file_name, s3_key: d.s3_key }
  }, id)
  const startRename = async (page) => {
    await page.locator('.s3-doc-rename-btn').click()
    return page.locator('.s3-doc-rename-input')
  }

  it('кнопка с карандашом на цветном фоне — сразу за именем файла', async () => {
    const { page, errors, close } = await open('dcf-3')
    try {
      const btn = page.locator('.s3-doc-rename-btn')
      assert.equal((await btn.innerText()).trim(), 'Переименовать')
      assert.equal(await btn.locator('svg').count(), 1, 'значок карандаша')
      const look = await btn.evaluate((el) => {
        const title = el.parentElement.querySelector('.s3-doc-modal-title').getBoundingClientRect()
        const box = el.getBoundingClientRect()
        return { gap: box.left - title.right, sameRow: Math.abs((box.top + box.bottom) / 2 - (title.top + title.bottom) / 2) < 2,
          bg: getComputedStyle(el).backgroundColor }
      })
      assert.ok(look.gap >= 0 && look.gap < 24, `зазор ${look.gap}`)
      assert.ok(look.sameRow, 'на одной строке с именем')
      assert.notEqual(look.bg, 'rgba(0, 0, 0, 0)', 'есть фон')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('новое имя: в базе, в окне и в списке; ключ прежний, просмотр не перезагружается', async () => {
    // В хранилище стенда — содержимое и этого файла, чтобы окно показало PDF.
    const { page, errors, close } = await open('dcf-3', { flags: { __fakeFiles: { 'dc_requests/d2/dcf-3-Отчёт.pdf': 'data:application/pdf;base64,JVBERi0xLjQKJSVFT0YK' } } })
    try {
      const was = await row(page, 'dcf-3')
      await page.locator('.s3-doc-modal-frame').evaluate((el) => { el.dataset.mark = 'same' })
      const presigns = await page.evaluate(() => window.__fakePresignRequests?.length || 0)

      const input = await startRename(page)
      assert.equal(await input.inputValue(), 'Отчёт', 'правится имя без расширения')
      assert.equal(await page.locator('.s3-doc-rename-ext').innerText(), '.pdf')
      const selected = await input.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd))
      assert.equal(selected, 'Отчёт', 'имя выделено — можно сразу печатать')

      await input.fill('Отчёт по документам, ред. 2')
      await input.press('Enter')
      await page.locator('.s3-doc-rename').waitFor({ state: 'detached' })

      assert.equal(await page.locator('.s3-doc-modal-title').innerText(), 'Отчёт по документам, ред. 2.pdf')
      assert.deepEqual(await row(page, 'dcf-3'), { file_name: 'Отчёт по документам, ред. 2.pdf', s3_key: was.s3_key })
      assert.equal(await page.locator('.s3-doc-modal-frame[data-mark="same"]').count(), 1, 'тот же просмотр')
      assert.equal(await page.evaluate(() => window.__fakePresignRequests?.length || 0), presigns, 'новой ссылки не просили')

      await page.locator('.s3-doc-modal-close').click()
      await page.locator('.s3-doc-preview').waitFor({ state: 'detached' })
      await page.getByText('Отчёт по документам, ред. 2.pdf').first().waitFor()
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('Escape снимает только правку; щелчок мимо окна при правке не закрывает; Отмена', async () => {
    const { page, errors, close } = await open('dcf-3')
    try {
      const input = await startRename(page)
      await input.fill('Другое имя')
      await input.press('Escape')
      await page.locator('.s3-doc-rename').waitFor({ state: 'detached' })
      assert.equal(await page.locator('.s3-doc-preview').count(), 1, 'окно на месте')
      assert.equal(await page.locator('.s3-doc-modal-title').innerText(), 'Отчёт.pdf')
      assert.equal((await row(page, 'dcf-3')).file_name, 'Отчёт.pdf')

      const again = await startRename(page)
      await again.fill('Другое имя')
      await page.mouse.click(3, 3)
      assert.equal(await page.locator('.s3-doc-rename-input').inputValue(), 'Другое имя', 'ввод не пропал')
      await page.locator('.s3-doc-rename-cancel').click()
      assert.equal(await page.locator('.s3-doc-rename').count(), 0)

      await page.keyboard.press('Escape')
      await page.locator('.s3-doc-preview').waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('плохое имя — подсказка в окне, запроса нет; то же имя — без записи', async () => {
    const { page, errors, close } = await open('dcf-3')
    try {
      const updates = () => page.evaluate(() => window.__fakeStats?.requests?.filter((r) => r.table === 's3_documents' && r.op === 'update').length)
      const before = await updates()
      const input = await startRename(page)
      await input.fill('Отчёт: итог')
      await input.press('Enter')
      assert.match(await page.locator('.s3-doc-rename-error').innerText(), /нельзя использовать/)
      await input.fill('   ')
      assert.equal(await page.locator('.s3-doc-rename-error').count(), 0, 'ввод снимает подсказку')
      await input.press('Enter')
      assert.match(await page.locator('.s3-doc-rename-error').innerText(), /Укажите имя/)
      assert.equal((await row(page, 'dcf-3')).file_name, 'Отчёт.pdf')

      // Дописали расширение сами — то же имя: правка просто закрывается.
      await input.fill('Отчёт.pdf')
      await input.press('Enter')
      await page.locator('.s3-doc-rename').waitFor({ state: 'detached' })
      assert.equal(await updates(), before, 'записи не было')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('отказ базы и файл, которого уже нет — причина в окне, имя прежнее, ввод не пропал', async () => {
    const { page, errors, close } = await open('dcf-3')
    try {
      await page.evaluate(() => {
        window.__fakeHold = ({ table, op }) => (table === 's3_documents' && op === 'update' ? { error: { message: 'Нет доступа', code: '42501' } } : {})
      })
      const input = await startRename(page)
      await input.fill('Новое')
      await input.press('Enter')
      assert.match(await page.locator('.s3-doc-rename-error').innerText(), /Нет доступа/)
      assert.equal(await input.inputValue(), 'Новое')

      await page.evaluate(() => {
        window.__fakeHold = null
        window.__fakeDb.s3_documents = window.__fakeDb.s3_documents.filter((d) => d.id !== 'dcf-3')
      })
      await input.press('Enter')
      assert.match(await page.locator('.s3-doc-rename-error').innerText(), /Файл не переименован/)
      assert.equal(await input.inputValue(), 'Новое')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('файл без просмотра: «Скачать» — под новым именем', async () => {
    const { page, errors, close } = await open('dcf-2', { flags: { __fakeRemoteFiles: true } })
    try {
      const input = await startRename(page)
      assert.equal(await page.locator('.s3-doc-rename-ext').innerText(), '.docx')
      await input.fill('Письмо заказчику')
      await input.press('Enter')
      const btn = page.locator('.s3-doc-preview-fallback button')
      await btn.getByText('Скачать «Письмо заказчику.docx»').waitFor()
      const [download] = await Promise.all([page.waitForEvent('download'), btn.click()])
      assert.equal(download.suggestedFilename(), 'Письмо заказчику.docx')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без права правки раздела кнопки нет', async () => {
    const { page, errors, close } = await open('dcf-3', { query: '&canEdit=0' })
    try {
      assert.equal(await page.locator('.s3-doc-modal-title').innerText(), 'Отчёт.pdf')
      assert.equal(await page.locator('.s3-doc-rename-btn').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('длинное имя и телефон: кнопка видна, шапка не вылезает за окно', async () => {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 800 }]) {
      const { page, errors, close } = await open('dcf-3', { viewport })
      try {
        await page.evaluate(() => {
          // Имя длиннее шапки: родитель уже отдал документ, поэтому подменяем подпись на экране.
          document.querySelector('.s3-doc-modal-title').textContent = 'Очень длинное имя файла '.repeat(12) + '.pdf'
        })
        const fits = () => page.evaluate(() => {
          const header = document.querySelector('.s3-doc-modal-header')
          const box = header.getBoundingClientRect()
          const inside = [...header.querySelectorAll('button, input')].every((el) => {
            const r = el.getBoundingClientRect()
            return r.left >= box.left - 1 && r.right <= box.right + 1
          })
          return { inside, overflow: header.scrollWidth - header.clientWidth }
        })
        assert.deepEqual(await fits(), { inside: true, overflow: 0 }, `имя, ${viewport.width}px`)
        await page.locator('.s3-doc-rename-btn').click()
        assert.deepEqual(await fits(), { inside: true, overflow: 0 }, `правка, ${viewport.width}px`)
        assert.deepEqual(errors, [])
      } finally { await close() }
    }
  })

  it('«Проверка КП»: новое имя сразу в строке очереди', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    try {
      await page.goto(`${stand.url}?route=/kp-review&kpReview=1&latency=10`)
      await page.locator('.kprv-table').first().waitFor({ timeout: 120000 })
      await page.locator('.kprv-stage[data-stage="all"]').click()
      // В стенде файл КП лежит встраиванием в строке очереди: заводим и строку s3_documents.
      await page.evaluate(() => {
        const r = window.__fakeDb.tender_proposal_files.find((f) => f.id === 'kp-2')
        window.__fakeDb.s3_documents.push({ ...r.s3 })
      })
      const line = page.locator('.kprv-kp[data-kp="kp-2"]')
      await line.locator('.kprv-file-btn').click()
      await page.locator('.s3-doc-preview').waitFor()
      const input = await startRename(page)
      await input.fill('КП согласовано')
      await input.press('Enter')
      await page.locator('.s3-doc-rename').waitFor({ state: 'detached' })
      await page.locator('.s3-doc-modal-close').click()
      await line.locator('.kprv-file-name', { hasText: 'КП согласовано' }).waitFor()
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  })
})
