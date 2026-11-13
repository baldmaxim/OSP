// «Заявки на проверку ДП/ДС»: окно заявки 12.11.2026 (решения пользователя; миграция 20270216). Правила без браузера и
// страница в Chromium (стенд tests/tender/ui, route=/doc-check-requests&docCheck=1; «база» стенда ведёт себя как миграция —
// снимок файлов сообщения, история заявки, «прочитано» по пользователю, см. seed.js):
//   • окно больше, переписка шире;
//   • файлы в переписке: скрепка, перетаскивание в любое место переписки, вставка из буфера; выбранные ждут у поля ввода и
//     уходят вместе с сообщением; файл в сообщении — открыть и скачать, ни переименовать, ни удалить; в «Документах» —
//     частью «Из обсуждения», только просмотр; не ушло сообщение — черновики убираются, текст и файлы остаются;
//   • «Согласование ПСДЦ» под исполнителями: ответственный — только экономист ОСП, необязателен, назначает право правки
//     (юрист ОСП), сразу и в историю;
//   • история — от базы: страница её не пишет; файлы — кто прикрепил и открепил;
//   • «прочитано» — в базе, у каждого своё; отметки браузера переносятся туда при первом входе;
//   • миграции ещё нет — всё как раньше. База и права — doc-check-chat-db.test.mjs. Люди вымышленные.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  DOC_CHECK_CHAT_CATEGORY, DOC_CHECK_SELECTS, MAX_CHAT_FILES, fileCategoryLabel, formatBytes, postedChatFileIds, psdcStaffOptions,
  shownPsdcResponsible,
} from '../../src/utils/docCheckHelpers.js'
import { normalizeTalkReads, readMarkOf, withSeen } from '../../src/utils/docCheckTalkRead.js'

const PDF = (name) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') })

describe('Окно заявки 12.11: правила без браузера', () => {
  it('ответственный за ПСДЦ — только экономист ОСП; сменили роль — не показывается, значение в базе остаётся', () => {
    const employees = new Map([
      ['e1', { user_id: 'e1', display_name: 'Экономова Е. С.', role: 'economist' }],
      ['e2', { user_id: 'e2', display_name: 'Аданов А. А.', role: 'economist' }],
      ['o1', { user_id: 'o1', display_name: 'Объектова О. О.', role: 'economist_object' }],
      ['l1', { user_id: 'l1', display_name: 'Юристова Ю. Ю.', role: 'lawyer' }],
    ])
    assert.deepEqual(psdcStaffOptions(employees).map((o) => o.value), ['e2', 'e1'], 'только экономисты ОСП, по алфавиту')
    assert.equal(shownPsdcResponsible({ psdc_responsible_id: 'e1' }, employees), 'e1')
    assert.equal(shownPsdcResponsible({ psdc_responsible_id: 'o1' }, employees), null, 'экономист объекта — не он')
    assert.equal(shownPsdcResponsible({ psdc_responsible_id: 'gone' }, employees), null)
    assert.equal(shownPsdcResponsible({}, employees), null)
  })

  it('файлы обсуждения: своя категория, отправленные — из снимков сообщений; подписи частей и размеров', () => {
    assert.equal(DOC_CHECK_CHAT_CATEGORY, 'doc_check_chat')
    assert.equal(MAX_CHAT_FILES, 20)
    assert.deepEqual([...postedChatFileIds([{ attachments: [{ id: 'a' }, { id: 'b' }] }, { attachments: null }, {}, { attachments: [{ id: 'a' }] }])], ['a', 'b'])
    assert.deepEqual(['doc_check_concept_agreement', 'doc_check_chat', 'general', null].map(fileCategoryLabel),
      ['Понятийное соглашение', 'Обсуждение', 'Загружаемые документы', 'Загружаемые документы'])
    assert.deepEqual([0, 1023, 1024, 1536, 5 * 1024 * 1024, null, 'x'].map(formatBytes), ['0 Б', '1023 Б', '1,0 КБ', '1,5 КБ', '5,0 МБ', '', ''])
  })

  it('выборка заявок: сначала с колонкой миграции 20270216 (признак файлов, истории от базы, ПСДЦ), без неё — прежние', () => {
    assert.match(DOC_CHECK_SELECTS[0].select, /psdc_responsible_id/)
    assert.equal(DOC_CHECK_SELECTS[0].chat, true)
    const rest = DOC_CHECK_SELECTS.filter((x) => !x.chat)
    assert.ok(rest.length >= 6 && rest.every((x) => !/psdc_responsible_id/.test(x.select)))
  })

  it('«прочитано» из базы: числа, испорченное — без непрочитанных; отметка только растёт', () => {
    assert.deepEqual(normalizeTalkReads({ since: '1000', seen: { a: 5000, b: 'x' } }), { since: 1000, seen: { a: 5000 } })
    assert.equal(normalizeTalkReads(null), null)
    assert.equal(normalizeTalkReads({ seen: {} }), null)
    const reads = { since: 1000, seen: { a: 5000 } }
    assert.equal(withSeen(reads, 'a', 4000), reads, 'назад не идёт — тот же объект')
    assert.equal(readMarkOf(withSeen(reads, 'a', 7000), 'a'), 7000)
    assert.equal(readMarkOf(withSeen(reads, 'b', 2000), 'b'), 2000)
    assert.equal(withSeen(null, 'a', 1), null)
  })

  it('стили новых частей окна — у самой страницы; окно — до 104 × 64 rem', () => {
    const css = fs.readFileSync(path.join(REPO, 'src', 'pages', 'DocCheckRequestsPage.css'), 'utf8')
    for (const cls of ['.dc-talk-files', '.dc-talk-file-name', '.dc-talk-pending', '.dc-talk-attach', '.dc-talk-drop', '.dc-person-role']) {
      assert.ok(css.includes(cls), cls)
    }
    assert.match(css, /width: min\(104rem, calc\(100vw - 2rem\)\)/)
    assert.match(css, /height: min\(64rem, calc\(100vh - 2rem\)\)/)
  })
})

const launch = browserLaunchOptions()

describe('Окно заявки 12.11 в браузере', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  const openPage = async (extra = '', { viewport = { width: 1700, height: 950 }, init } = {}) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    if (init) await page.addInitScript(init)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    const dialogs = []
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.goto(`${stand.url}?route=/doc-check-requests&docCheck=1&latency=0${extra}`)
    await page.locator('.dc-board, .dc-error').first().waitFor({ timeout: 120000 })
    return { page, context, errors, dialogs, close: () => context.close().catch(() => {}) }
  }
  const card = (page, id) => page.locator(`.dc-column .dc-card[data-id="${id}"]`)
  const openCard = async (page, id) => {
    await card(page, id).first().click()
    const modal = page.locator('.dc-detail-modal')
    await modal.waitFor()
    return modal
  }
  const fdb = (page, fn, arg) => page.evaluate(fn, arg)
  const chatFilesOf = (page, id) => fdb(page, (key) => window.__fakeDb.s3_documents
    .filter((d) => d.owner_type === 'doc_check_request' && d.owner_id === key && d.doc_category === 'doc_check_chat')
    .map((d) => d.file_name).sort(), id)
  const historyOf = (page, id) => fdb(page, (key) => window.__fakeDb.doc_check_request_audit_log
    .filter((l) => l.request_id === key).map((l) => [l.event_type, l.field_name, l.description]), id)
  const pageAuditWrites = (page) => fdb(page, () => window.__supabaseStats.requests
    .filter((r) => r.table === 'doc_check_request_audit_log' && r.op !== 'select').length)
  const dataTransfer = (page, names) => page.evaluateHandle((list) => {
    const dt = new DataTransfer()
    for (const n of list) dt.items.add(new File(['%PDF-1.4'], n, { type: 'application/pdf' }))
    return dt
  }, names)

  it('окно больше, переписка шире: около трети окна, а в узком окне — не уже 22 rem', async () => {
    for (const [viewport, want] of [[{ width: 1700, height: 950 }, [1664, 918]], [{ width: 1280, height: 800 }, [1248, 768]]]) {
      const { page, errors, close } = await openPage('', { viewport })
      try {
        const modal = await openCard(page, 'dcr-3')
        await modal.locator('.dc-talk-msg').first().waitFor()
        const box = await modal.boundingBox()
        assert.deepEqual([Math.round(box.width), Math.round(box.height)], want, `${viewport.width}px`)
        const talk = await modal.locator('.dc-general-talk').boundingBox()
        const info = await modal.locator('.dc-general-main').boundingBox()
        assert.ok(talk.width >= 352 && talk.width >= box.width * 0.35, `переписка ${Math.round(talk.width)} из ${Math.round(box.width)}`)
        assert.ok(info.width > talk.width, 'сведения — шире переписки')
        assert.deepEqual(errors, [])
      } finally { await close() }
    }
  })

  it('файл в сообщение — скрепкой: выбранные ждут у поля, «×» убирает; уходят с сообщением, снимок — от базы', async () => {
    const { page, errors, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-4')
      await modal.getByText('Сообщений пока нет.').waitFor()
      assert.match(await modal.locator('.dc-talk-list').innerText(), /Файл можно перетащить сюда/)
      await modal.getByLabel('Файлы к сообщению', { exact: true }).setInputFiles([PDF('Протокол разногласий.pdf'), PDF('Лишний.pdf')])
      const chips = modal.locator('.dc-talk-pending-item')
      await chips.nth(1).waitFor()
      assert.deepEqual(await modal.locator('.dc-talk-pending-name').allTextContents(), ['Протокол разногласий.pdf', 'Лишний.pdf'])
      assert.equal(await chatFilesOf(page, 'dcr-4').then((l) => l.length), 0, 'до отправки в хранилище ничего нет')
      await modal.getByRole('button', { name: 'Убрать Лишний.pdf' }).click()
      assert.equal(await chips.count(), 1)

      await modal.getByRole('textbox', { name: 'Новое сообщение' }).fill('Протокол — во вложении')
      await modal.getByRole('button', { name: 'Отправить' }).click()
      const msg = modal.locator('.dc-talk-msg').first()
      await msg.locator('.dc-talk-file').waitFor()
      assert.equal(await msg.locator('.dc-talk-body').textContent(), 'Протокол — во вложении')
      assert.equal(await msg.locator('.dc-talk-file-name').textContent(), 'Протокол разногласий.pdf')
      assert.equal(await msg.locator('.dc-talk-file-size').textContent(), '8 Б')
      assert.equal(await chips.count(), 0, 'поле ввода очищено')
      assert.match(await modal.locator('.dc-talk-title').innerText(), /1/)

      const saved = await fdb(page, () => window.__fakeDb.doc_check_request_comments.find((c) => c.request_id === 'dcr-4'))
      const file = await fdb(page, () => window.__fakeDb.s3_documents.find((d) => d.owner_id === 'dcr-4' && d.doc_category === 'doc_check_chat'))
      assert.deepEqual(saved.attachments, [{ id: file.id, file_name: 'Протокол разногласий.pdf', mime_type: 'application/pdf',
        size_bytes: 8, sha256: null, s3_key: file.s3_key }])
      assert.deepEqual(await historyOf(page, 'dcr-4'), [['file_attached', 'file', 'Обсуждение: Протокол разногласий.pdf']])
      assert.equal(await pageAuditWrites(page), 0, 'историю пишет база, не страница')

      // В «Документах» — частью «Из обсуждения»: только открыть и скачать.
      const part = modal.locator('.dc-files-part[data-part="chat"]')
      await part.getByText('Протокол разногласий.pdf').waitFor()
      assert.equal(await part.locator('.dc-files-add, .dc-file-del, input[type="file"]').count(), 0)
      await part.locator('.dc-file-name').click()
      const preview = page.locator('.s3-doc-preview')
      await preview.waitFor()
      assert.equal(await preview.getByRole('button', { name: /Переименовать/ }).count(), 0, 'файл из переписки не переименовать')
      await preview.locator('.modal-close, [aria-label="Закрыть"]').first().click()

      await modal.locator('.modal-close').click()
      await page.waitForFunction(() => document.querySelector('.dc-card[data-id="dcr-4"] .dc-count[title="Файлы заявки"]')?.textContent === '1')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('файл можно бросить в переписку: рамка-подсказка, файл — к сообщению; сообщение из одних файлов', async () => {
    const { page, errors, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-3')
      await modal.locator('.dc-talk-msg').first().waitFor()
      const talk = modal.locator('.dc-talk')
      const data = await dataTransfer(page, ['Скан ДС.pdf'])
      await modal.locator('.dc-talk-list').dispatchEvent('dragover', { dataTransfer: data })
      await modal.locator('.dc-talk-drop').waitFor()
      assert.match(await talk.getAttribute('class'), /is-over/)
      assert.match(await modal.locator('.dc-talk-drop').innerText(), /Отпустите — файлы прикрепятся к сообщению/)
      await modal.locator('.dc-talk-list').dispatchEvent('drop', { dataTransfer: data })
      await modal.locator('.dc-talk-pending-item').waitFor()
      assert.doesNotMatch(await talk.getAttribute('class'), /is-over/)
      assert.equal(await modal.locator('.dc-talk-drop').count(), 0)
      await modal.getByRole('button', { name: 'Отправить' }).click()
      await modal.locator('.dc-talk-msg').nth(2).locator('.dc-talk-file').waitFor()
      assert.equal(await modal.locator('.dc-talk-msg').nth(2).locator('.dc-talk-body').count(), 0, 'без текста — только файл')
      assert.deepEqual(await chatFilesOf(page, 'dcr-3'), ['Скан ДС.pdf'])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('вставка файла из буфера — к сообщению; файл, брошенный мимо частей окна, не открывается вместо заявки', async () => {
    const { page, errors, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-4')
      const field = modal.getByRole('textbox', { name: 'Новое сообщение' })
      await field.waitFor()
      await field.evaluate((el) => {
        const dt = new DataTransfer()
        dt.items.add(new File(['%PDF-1.4'], 'Из буфера.pdf', { type: 'application/pdf' }))
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      })
      await modal.getByText('Из буфера.pdf').waitFor()
      const prevented = await modal.locator('.dc-detail-head').evaluate((el) => {
        const dt = new DataTransfer()
        dt.items.add(new File(['x'], 'мимо.pdf', { type: 'application/pdf' }))
        const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })
        const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
        el.dispatchEvent(over)
        el.dispatchEvent(drop)
        return [over.defaultPrevented, drop.defaultPrevented]
      })
      assert.deepEqual(prevented, [true, true], 'браузер не уходит на файл')
      assert.equal(await modal.locator('.dc-talk-pending-item').count(), 1, 'мимо переписки — не к сообщению')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('скриншот (13.11.2026): Ctrl+V в поле и в любом месте окна — к сообщению с именем «Скриншот …»; в переписке — миниатюрой; текст из буфера — текстом', async () => {
    const { page, errors, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-4')
      const field = modal.getByRole('textbox', { name: 'Новое сообщение' })
      await field.waitFor()
      assert.match(await field.getAttribute('placeholder'), /скриншот \(Ctrl\+V\)/)
      // PNG 1×1 — как снимок экрана из буфера: браузер называет его «image.png».
      const paste = (target, { text = '' } = {}) => target.evaluate((el, t) => {
        const dt = new DataTransfer()
        const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
        dt.items.add(new File([png], 'image.png', { type: 'image/png' }))
        if (t) dt.setData('text/plain', t)
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
        el.dispatchEvent(ev)
        return ev.defaultPrevented
      }, text)
      assert.equal(await paste(field), true)
      const pending = modal.locator('.dc-talk-pending-item')
      await pending.first().waitFor()
      const shotName = /^Скриншот \d\d\.\d\d\.\d{4} \d\d-\d\d-\d\d( \(\d\))?\.png$/
      assert.match(await pending.first().locator('.dc-talk-pending-name').innerText(), shotName)
      await pending.first().locator('img.dc-talk-pending-thumb').waitFor()
      // Вставка в любом месте окна (не в поле ввода) — тоже к сообщению; второе имя — с номером, если та же секунда.
      assert.equal(await paste(modal.locator('.dc-info')), true)
      await pending.nth(1).waitFor()
      const names = await modal.locator('.dc-talk-pending-name').allInnerTexts()
      assert.equal(new Set(names).size, 2, `имена разные: ${names}`)
      // Ячейки из Excel кладут в буфер и картинку: есть текст — вставляется текст, файла нет.
      assert.equal(await paste(field, { text: 'Сумма 1 200 000' }), false)
      assert.equal(await pending.count(), 2)
      await field.fill('Скрин замечаний')
      await modal.getByRole('button', { name: 'Отправить' }).click()
      const shots = modal.locator('.dc-talk-msg').last().locator('.dc-talk-shot')
      await shots.nth(1).waitFor({ timeout: 30000 })
      await shots.first().locator('img').waitFor()
      assert.equal(await modal.locator('.dc-talk-msg').last().locator('.dc-talk-file').count(), 0, 'картинки — миниатюрами, не строками файлов')
      const sent = await chatFilesOf(page, 'dcr-4')
      assert.equal(sent.length, 2)
      for (const n of sent) assert.match(n, shotName)
      // Нажатие — картинка во весь экран.
      await shots.first().locator('.dc-talk-shot-open').click()
      await page.locator('.s3-doc-preview img.s3-doc-modal-img').waitFor()
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('сообщение не ушло: загруженные черновики убираются, текст и выбранные файлы остаются', async () => {
    const { page, errors, dialogs, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-4')
      await modal.getByLabel('Файлы к сообщению', { exact: true }).setInputFiles([PDF('Первый.pdf'), PDF('Второй.pdf')])
      await modal.getByRole('textbox', { name: 'Новое сообщение' }).fill('Не дойдёт')
      await page.evaluate(() => {
        window.__fakeHold = ({ table, op }) => (table === 'doc_check_request_comments' && op === 'insert'
          ? { error: { code: '42501', message: 'нет права' } } : {})
      })
      await modal.getByRole('button', { name: 'Отправить' }).click()
      await page.waitForFunction(() => document.querySelector('.dc-talk .btn-primary')?.textContent === 'Отправить')
      assert.match(dialogs.at(-1), /Не удалось отправить сообщение: нет права/)
      await page.waitForFunction(() => !window.__fakeDb.s3_documents.some((d) => d.doc_category === 'doc_check_chat' && d.owner_id === 'dcr-4'))
      assert.equal(await modal.getByRole('textbox', { name: 'Новое сообщение' }).inputValue(), 'Не дойдёт')
      assert.equal(await modal.locator('.dc-talk-pending-item').count(), 2)
      assert.equal(await modal.locator('.dc-talk-msg').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('больше 20 файлов в сообщении — нельзя: лишние не добавляются, причина — сообщением', async () => {
    const { page, errors, dialogs, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-4')
      await modal.getByLabel('Файлы к сообщению', { exact: true }).setInputFiles(Array.from({ length: 21 }, (_, i) => PDF(`Лист ${i + 1}.pdf`)))
      await modal.locator('.dc-talk-pending-item').nth(19).waitFor()
      assert.equal(await modal.locator('.dc-talk-pending-item').count(), 20)
      assert.match(dialogs.at(-1), /не больше 20 файлов/)
      assert.equal(await modal.getByRole('button', { name: 'Прикрепить файл' }).isDisabled(), true)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('файл в сообщении коллеги: открыть и скачать; ни переименовать, ни удалить', async () => {
    const { page, errors, close } = await openPage('&dcChatFiles=1')
    try {
      const modal = await openCard(page, 'dcr-3')
      const file = modal.locator('.dc-talk-file').first()
      await file.waitFor()
      assert.equal(await file.locator('.dc-talk-file-name').textContent(), 'Замечания юриста.pdf')
      assert.equal(await file.locator('.dc-talk-file-size').textContent(), '2,0 КБ')
      assert.match(await modal.locator('.dc-talk-title-files').innerText(), /1/)
      assert.equal(await file.getByRole('button', { name: /Удалить|Переименовать/ }).count(), 0)
      await file.getByRole('button', { name: 'Скачать Замечания юриста.pdf' }).click()
      await page.waitForFunction(() => window.__fakeFileRequests?.includes('doc-check-requests/dcr-3/remarks.pdf'))
      await file.locator('.dc-talk-file-name').click()
      const preview = page.locator('.s3-doc-preview')
      await preview.waitFor()
      assert.equal(await preview.getByRole('button', { name: /Переименовать/ }).count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Согласование ПСДЦ»: под исполнителями; ответственный — только экономист ОСП; назначение сразу и в истории', async () => {
    const { page, errors, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-4')
      const heads = await modal.locator('.dc-box-head').evaluateAll((els) => els.map((e) => e.firstChild.textContent))
      assert.equal(heads.indexOf('Согласование ПСДЦ'), heads.indexOf('Исполнители') + 1, 'сразу под исполнителями')
      const box = modal.locator('.dc-box', { hasText: 'Согласование ПСДЦ' })
      assert.match(await box.textContent(), /Ответственный не назначен/)
      await box.locator('.dc-assign .fdrop-trigger').click()
      const options = page.locator('.fdrop-panel .fdrop-option')
      const labels = async () => (await options.allTextContents()).map((t) => t.replace('✓', '').trim())
      assert.deepEqual(await labels(), ['Не назначен', 'Расчётов Роман Игоревич', 'Экономова Елена Сергеевна'],
        'только экономисты ОСП — не юристы и не другие роли')
      await options.filter({ hasText: 'Экономова Елена Сергеевна' }).click()
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-4').psdc_responsible_id === 'user-4')
      assert.match(await box.locator('.dc-person-name').textContent(), /Экономова Елена Сергеевна/)
      assert.match(await box.locator('.dc-person-role').textContent(), /экономист ОСП/)
      assert.equal(await page.locator('.dc-form-modal').count(), 0, 'без формы «Изменить»')

      await box.locator('.dc-assign .fdrop-trigger').click()
      await page.locator('.fdrop-panel .fdrop-option', { hasText: 'Не назначен' }).click()
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-4').psdc_responsible_id === null)
      assert.deepEqual((await historyOf(page, 'dcr-4')).map((h) => h[1]), ['psdc_responsible_id', 'psdc_responsible_id'])
      assert.equal(await pageAuditWrites(page), 0)

      await modal.getByRole('tab', { name: /^История/ }).click()
      await modal.locator('.dc-history li').nth(1).waitFor()
      const text = await modal.locator('.dc-history').textContent()
      assert.match(text, /Согласование ПСДЦ: ответственный\s*\d/)
      assert.match(text, /—\s*→\s*Экономова Елена Сергеевна/)
      assert.match(text, /Экономова Елена Сергеевна\s*→\s*—/)
      assert.deepEqual(errors, [])
    } finally { await close() }

    // Без права правки — только видно, назначить нельзя; у удалённой — тоже.
    const viewer = await openPage('&canEdit=0&asUser=user-9')
    try {
      const modal = await openCard(viewer.page, 'dcr-4')
      const box = modal.locator('.dc-box', { hasText: 'Согласование ПСДЦ' })
      await box.waitFor()
      assert.equal(await box.locator('.dc-assign').count(), 0)
      assert.deepEqual(viewer.errors, [])
    } finally { await viewer.close() }
  })

  it('история — от базы, страница её не пишет: файлы документов — кто прикрепил и открепил, статус, исполнители', async () => {
    const { page, errors, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-4')
      await modal.locator('.dc-files-empty').first().waitFor()
      await modal.getByLabel('Загрузить: Загружаемые документы').setInputFiles(PDF('ДП СУ2-004.pdf'))
      await modal.locator('.dc-files-part[data-part="files"]').getByText('ДП СУ2-004.pdf').waitFor()
      await modal.getByRole('button', { name: 'Удалить ДП СУ2-004.pdf' }).click()
      await page.waitForFunction(() => !window.__fakeDb.s3_documents.some((d) => d.file_name === 'ДП СУ2-004.pdf'))
      await modal.locator('.dc-status-opt', { hasText: 'В работе' }).click()
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-4').status === 'in_progress')
      assert.deepEqual(await historyOf(page, 'dcr-4'), [
        ['file_attached', 'file', 'Загружаемые документы: ДП СУ2-004.pdf'],
        ['file_removed', 'file', 'Загружаемые документы: ДП СУ2-004.pdf'],
        ['status_changed', 'status', null],
      ])
      assert.equal(await pageAuditWrites(page), 0)
      await modal.getByRole('tab', { name: /^История/ }).click()
      await modal.locator('.dc-history li').nth(2).waitFor()
      assert.deepEqual(await modal.locator('.dc-history-event').allTextContents(), ['Смена статуса', 'Файл откреплён', 'Файл прикреплён'],
        'сначала последние')
      assert.match(await modal.locator('.dc-history').textContent(), /Загружаемые документы: ДП СУ2-004\.pdf · 8 Б/)
      assert.match(await modal.locator('.dc-history-who').first().textContent(), /^Тест$/, 'автор — вошедший (ставит база)')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«прочитано» — у каждого своё и в базе: открыл — отмечено только у него; браузер отметок не хранит', async () => {
    const { page, errors, close } = await openPage('&asUser=user-1&dcTalkSince=0&dcComments=2')
    try {
      const badge = card(page, 'dcr-3').locator('.dc-count--talk.is-unread')
      await badge.waitFor()
      await page.evaluate(() => { window.__fakeDb.doc_check_talk_reads['user-3'] = { since: 0, seen: {} } })
      const modal = await openCard(page, 'dcr-3')
      await modal.locator('.dc-talk-msg').nth(3).waitFor()
      assert.deepEqual(await modal.locator('.dc-talk-msg.is-unread .dc-talk-body').allTextContents(), ['Сообщение 3', 'Сообщение 4'])
      await page.waitForFunction(() => !document.querySelector('.dc-card[data-id="dcr-3"] .dc-count--talk.is-unread'))
      await page.waitForFunction(() => window.__fakeDb.doc_check_talk_reads['user-1'].seen['dcr-3'] > 0)
      const reads = await fdb(page, () => window.__fakeDb.doc_check_talk_reads)
      assert.equal(reads['user-1'].seen['dcr-3'], Date.parse('2026-10-22T09:04:00Z'), 'до последнего показанного сообщения')
      assert.deepEqual(reads['user-3'].seen, {}, 'у коллеги — своё, не тронуто')
      const marks = await fdb(page, () => window.__supabaseStats.requests.filter((r) => r.table === 'rpc:doc_check_talk_mark').map((r) => r.args))
      assert.deepEqual(marks, [{ p_request: 'dcr-3', p_at: Date.parse('2026-10-22T09:04:00Z') }], 'одна отметка — без повторов')
      assert.equal(await page.evaluate(() => localStorage.getItem('docCheckTalkRead:v1:user-1')), null, 'браузер отметок не хранит')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«прочитано»: отметки этого браузера при первом входе переносятся в базу и из браузера убираются', async () => {
    const init = () => localStorage.setItem('docCheckTalkRead:v1:user-1', JSON.stringify({ since: 0, seen: { 'dcr-9': 5 } }))
    const { page, errors, close } = await openPage('&asUser=user-1&dcComments=2', { init })
    try {
      await card(page, 'dcr-3').locator('.dc-count--talk.is-unread').waitFor()
      const call = await fdb(page, () => window.__supabaseStats.requests.find((r) => r.table === 'rpc:doc_check_talk_state').args)
      assert.deepEqual(call, { p_since: 0, p_seen: { 'dcr-9': 5 } })
      assert.deepEqual(await fdb(page, () => window.__fakeDb.doc_check_talk_reads['user-1']), { since: 0, seen: { 'dcr-9': 5 } })
      assert.equal(await page.evaluate(() => localStorage.getItem('docCheckTalkRead:v1:user-1')), null)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('миграции 20270216 ещё нет: ни файлов в переписке, ни ПСДЦ; историю пишет страница, «прочитано» — в браузере', async () => {
    const { page, errors, close } = await openPage('&dcNoChat=1')
    try {
      const modal = await openCard(page, 'dcr-4')
      await modal.getByText('Сообщений пока нет.').waitFor()
      assert.equal(await modal.getByRole('button', { name: 'Прикрепить файл' }).count(), 0)
      assert.equal(await modal.locator('.dc-box', { hasText: 'Согласование ПСДЦ' }).count(), 0)
      await modal.locator('.dc-box', { hasText: 'Исполнители' }).locator('.dc-assign .fdrop-trigger').click()
      await page.locator('.fdrop-panel .fdrop-option', { hasText: 'Юристова Мария Андреевна' }).click()
      await page.waitForFunction(() => window.__fakeDb.doc_check_request_audit_log.some((l) => l.request_id === 'dcr-4'))
      assert.equal(await pageAuditWrites(page), 1, 'историю пишет страница, как раньше')
      const rpc = await fdb(page, () => window.__supabaseStats.requests.filter((r) => r.table.startsWith('rpc:doc_check_talk')).length)
      assert.equal(rpc, 0)
      assert.notEqual(await page.evaluate(() => localStorage.getItem('docCheckTalkRead:v1:user-1')), null)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
