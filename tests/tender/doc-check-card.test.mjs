// «Заявки на проверку ДП/ДС»: окно заявки (решения пользователя 11.11.2026). Правила без браузера и страница в Chromium
// (стенд tests/tender/ui, route=/doc-check-requests&docCheck=1; у dcr-3 — сообщения и письмо, у dcr-2 — два файла):
//   • две вкладки — «Общая» и «История»; шагов нет (их таблица в базе осталась, страница её не читает);
//   • «Общая»: слева сведения, раздел «Документы» — сведения о документе и файлы двумя частями, «Понятийное соглашение»
//     (своя категория) и «Загружаемые документы»; справа — переписка со своей прокруткой;
//   • исполнителей назначают прямо в окне, без формы «Изменить»: отметка сразу пишется в заявку и в историю;
//   • ссылки на письмо при создании нет; у прежней заявки со ссылкой — видна, в правке можно поправить или убрать;
//   • права: без права правки — только просмотр файлов, назначать нельзя, написать сообщение можно; удалённая — только чтение;
//   • миграции 20261124 ещё нет — без переписки, к её таблице нет обращений. База и права — doc-check-card-db.test.mjs.
// Исполнители в форме и поля администратора — doc-check-assignees.test.mjs. Люди вымышленные.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  DOC_CHECK_CONCEPT_CATEGORY, cardCountsById, fieldEvents, mergeRequestCounts,
} from '../../src/utils/docCheckHelpers.js'
import { safeHttpUrl } from '../../src/utils/publicTenders.js'

const PDF = (name) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') })

describe('Окно заявки: правила без браузера', () => {
  it('ссылка на письмо: только http(s), как ограничение в базе', () => {
    assert.equal(safeHttpUrl(' https://mail.example.invalid/letter/3 '), 'https://mail.example.invalid/letter/3')
    assert.equal(safeHttpUrl('http://mail.example.invalid/x'), 'http://mail.example.invalid/x')
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'mail.example.invalid/x',
      'https://a b', '\\\\server\\share\\письмо.msg', '', null, undefined, `https://x/${'я'.repeat(2000)}`]) {
      assert.equal(safeHttpUrl(bad), null, String(bad))
    }
  })

  it('заявка с прежними числами — тот же объект: её карточка не перерисовывается', () => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    const cache = new WeakMap()
    const first = mergeRequestCounts([a, b], new Map([['a', 2]]), new Map(), cache)
    assert.deepEqual(first[0], { id: 'a', docsCount: 2, commentsCount: 0 })
    const same = mergeRequestCounts([a, b], new Map([['a', 2]]), new Map(), cache)
    assert.equal(same[0], first[0])
    assert.equal(same[1], first[1])
    const changed = mergeRequestCounts([a, b], new Map([['a', 2]]), new Map([['b', { commentsCount: 3 }]]), cache)
    assert.equal(changed[0], first[0], 'соседняя заявка не меняется')
    assert.notEqual(changed[1], first[1])
    assert.equal(changed[1].commentsCount, 3)
  })

  it('история: ссылка и исполнители — отдельными полями', () => {
    const events = fieldEvents({ email_link: null, notes: 'x', assignee_ids: ['u1'] },
      { email_link: 'https://x.invalid/1', notes: 'x', assignee_ids: ['u1', 'u2'] })
    assert.deepEqual(events.map(e => [e.field_name, e.new_value]), [['email_link', 'https://x.invalid/1'], ['assignee_ids', ['u1', 'u2']]])
  })

  it('счётчик сообщений на карточке; шагов нет', () => {
    const map = cardCountsById([{ request_id: 'a' }, { request_id: 'c' }, { request_id: 'c' }])
    assert.deepEqual(map.get('a'), { commentsCount: 1 })
    assert.deepEqual(map.get('c'), { commentsCount: 2 })
    assert.equal(map.has('b'), false)
    assert.equal(DOC_CHECK_CONCEPT_CATEGORY, 'doc_check_concept_agreement')
    assert.equal(fs.existsSync(path.join(REPO, 'src', 'components', 'doccheck', 'DocCheckSteps.jsx')), false)
  })

  it('стили окна — у самой страницы: она ленивая, чужой CSS может не загрузиться', () => {
    const css = fs.readFileSync(path.join(REPO, 'src', 'pages', 'DocCheckRequestsPage.css'), 'utf8')
    for (const cls of ['.dc-general-talk', '.dc-talk-list', '.dc-talk-msg', '.dc-inline-add', '.dc-chip--mail', '.dc-files-part', '.dc-file-name', '.dc-assign']) {
      assert.ok(css.includes(cls), cls)
    }
    assert.doesNotMatch(css, /\.dc-steps?\b|\.dc-step-/, 'стилей шагов не осталось')
    const used = ['DocCheckDiscussion', 'DocCheckFiles', 'DocCheckDetailModal']
      .map((f) => fs.readFileSync(path.join(REPO, 'src', 'components', 'doccheck', `${f}.jsx`), 'utf8')).join('')
    assert.doesNotMatch(used, /task-checklist|task-comment|task-inline-add/)
  })
})

const launch = browserLaunchOptions()

describe('Окно заявки на проверку ДП/ДС в браузере', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  const openPage = async (extra = '', viewport = { width: 1700, height: 950 }) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
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
  const openCard = async (page, id, tab) => {
    await page.locator(`.dc-column .dc-card[data-id="${id}"]`).first().click()
    const modal = page.locator('.dc-detail-modal')
    await modal.waitFor()
    if (tab) await modal.getByRole('tab', { name: new RegExp(`^${tab}`) }).click()
    return modal
  }
  const row = (page, id) => page.evaluate((key) => window.__fakeDb.doc_check_requests.find((r) => r.id === key), id)
  const filesOf = (page, id) => page.evaluate((key) => window.__fakeDb.s3_documents
    .filter((d) => d.owner_type === 'doc_check_request' && d.owner_id === key)
    .map((d) => [d.file_name, d.doc_category ?? null]).sort((a, b) => a[0].localeCompare(b[0])), id)
  const part = (modal, key) => modal.locator(`.dc-files-part[data-part="${key}"]`)
  const fileNames = (modal, key) => part(modal, key).locator('.dc-file-name').allTextContents()
  const stepReads = (page) => page.evaluate(() => window.__supabaseStats.requests.filter((r) => r.table === 'doc_check_request_steps').length)

  // Сколько карточек доски заново отрисовал React: тем же способом, что React DevTools (флаг PerformedWork, обход только
  // изменившихся поддеревьев). Хук ставится до загрузки React.
  const watchCardRenders = (page) => page.addInitScript(() => {
    window.__cardRenders = 0
    const walk = (fiber, prev) => {
      if (fiber.type?.name === 'DocCheckCard' && (fiber.flags & 1)) window.__cardRenders++
      if (fiber.child !== prev?.child) {
        for (let c = fiber.child; c; c = c.sibling) walk(c, c.alternate)
      }
    }
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      isDisabled: false,
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {},
      onCommitFiberRoot: (_, root) => walk(root.current, root.current.alternate),
    }
  })

  it('окно заявки не перерисовывает доску: ни открытие, ни вкладки, ни закрытие (на сайте 844 заявки)', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1700, height: 950 } })
    const page = await context.newPage()
    await watchCardRenders(page)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    try {
      await page.goto(`${stand.url}?route=/doc-check-requests&docCheck=1&latency=0&docCheckMany=120`)
      await page.locator('.dc-board').waitFor({ timeout: 120000 })
      await page.waitForFunction(() => document.querySelectorAll('.dc-card').length > 120)
      await page.waitForTimeout(500) // догрузка счётчиков и справочников
      const rendered = await page.evaluate(() => window.__cardRenders)
      assert.ok(rendered > 100, `счётчик работает: при загрузке отрисовано ${rendered}`)

      await page.evaluate(() => { window.__cardRenders = 0 })
      const modal = await openCard(page, 'dcr-3')
      await modal.locator('.dc-talk-msg').first().waitFor()
      await modal.getByRole('tab', { name: /^История/ }).click()
      await modal.getByRole('tab', { name: /^Общая/ }).click()
      await modal.locator('.dc-talk-msg').first().waitFor()
      await modal.locator('.modal-close').click()
      await modal.waitFor({ state: 'detached' })
      await page.waitForTimeout(300)
      assert.equal(await page.evaluate(() => window.__cardRenders), 0, 'карточки доски не перерисованы')

      // Что-то изменилось в заявке — перерисована только её карточка.
      const again = await openCard(page, 'dcr-3')
      await again.locator('.dc-talk-add textarea').fill('Новое сообщение')
      await again.getByRole('button', { name: 'Отправить' }).click()
      await again.locator('.dc-talk-msg').nth(2).waitFor()
      await page.waitForTimeout(200)
      const after = await page.evaluate(() => window.__cardRenders)
      assert.ok(after >= 1 && after <= 2, `перерисовано карточек: ${after}`)
      assert.deepEqual(errors, [])
    } finally {
      await context.close().catch(() => {})
    }
  })

  it('вид окна: две вкладки, сведения в две колонки, переписка справа, постоянная высота; подписи контрастные', async () => {
    const { page, errors, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-2')
      assert.deepEqual(await modal.locator('.dc-detail-tab').allTextContents(), ['Общая', 'История'])
      assert.deepEqual(await modal.locator('.dc-box-head').evaluateAll((els) => els.map((e) => e.firstChild.textContent)),
        ['Примечание', 'Документы', 'Срок и приоритет', 'Статус', 'Исполнители', 'Создание'])
      const cols = await modal.locator('.dc-info-col').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)))
      assert.equal(cols.length, 2)
      assert.ok(cols[1] > cols[0] + 300, `колонки рядом: ${cols}`)
      const info = await modal.locator('.dc-general-main').boundingBox()
      const talk = await modal.locator('.dc-general-talk').boundingBox()
      assert.ok(talk.x >= info.x + info.width - 1, 'переписка — справа от сведений')
      assert.ok(Math.abs(talk.y - info.y) < 2 && Math.abs(talk.height - info.height) < 2, 'и на всю высоту окна')
      assert.match(await modal.locator('.dc-talk-title').innerText(), /^Обсуждение/)
      // Документы видны сразу, без прокрутки сведений.
      const concept = await part(modal, 'concept').boundingBox()
      assert.ok(concept.y + concept.height <= info.y + info.height, 'понятийное соглашение — в видимой части окна')
      assert.match(await modal.locator('.dc-detail-sub .dc-status-chip').innerText(), /В работе/)
      assert.match(await modal.locator('.dc-detail-sub').innerText(), /Договор подряда/)
      assert.equal(await modal.locator('.dc-status-opt.is-current').count(), 1)
      assert.equal(await modal.locator('.dc-status-opt').count(), 7, 'каждая колонка доски — отдельной строкой (без убранной «Проверки документов»)')

      const height = (await modal.boundingBox()).height
      for (const tab of ['История', 'Общая']) {
        await modal.getByRole('tab', { name: new RegExp(`^${tab}`) }).click()
        assert.equal((await modal.boundingBox()).height, height, `вкладка «${tab}» не меняет высоту окна`)
      }
      const size = await modal.locator('.dc-row-kv dd').first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize))
      assert.ok(size >= 14, `текст значений не мельче 14px: ${size}`)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('шагов нет: ни вкладки, ни счётчика на карточке; их таблицу страница не читает', async () => {
    const { page, errors, close } = await openPage()
    try {
      await card(page, 'dcr-3').locator('.dc-count--talk').waitFor()
      assert.equal(await page.locator('.dc-count--steps').count(), 0)
      const modal = await openCard(page, 'dcr-3')
      await modal.locator('.dc-talk-msg').first().waitFor()
      assert.equal(await modal.getByRole('tab', { name: /Шаги|Документы|Обсуждение/ }).count(), 0)
      assert.equal(await modal.locator('.dc-steps, .dc-step-handle').count(), 0)
      await modal.locator('.modal-close').click()
      await page.locator('.dc-view-btn', { hasText: 'Реестр' }).click()
      await page.locator('.dc-table').waitFor()
      assert.equal(await stepReads(page), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('документы двумя частями: понятийное соглашение — своей категорией, остальное — «Загружаемые документы»', async () => {
    const { page, errors, dialogs, close } = await openPage()
    try {
      const reads = () => page.evaluate(() => window.__supabaseStats.requests.filter((q) => q.table === 's3_documents').length)
      await page.waitForTimeout(300)
      const start = await reads()
      let modal = await openCard(page, 'dcr-2')
      await modal.locator('.dc-file-name').first().waitFor()
      assert.deepEqual(await modal.locator('.dc-files-title').allTextContents(), ['Понятийное соглашение', 'Загружаемые документы'])
      assert.deepEqual(await fileNames(modal, 'concept'), ['Понятийное соглашение СУ2.pdf'])
      assert.deepEqual(await fileNames(modal, 'files'), ['ДП СУ2-001.pdf'])
      assert.match(await part(modal, 'files').locator('.dc-file-meta').innerText(), /21\.10\.2026, \d\d:\d\d · 1,0 КБ/)
      assert.equal(await reads(), start + 1, 'обе части — одним запросом')
      await modal.locator('.modal-close').click()
      await modal.waitFor({ state: 'detached' })
      await page.waitForTimeout(200)
      assert.equal(await reads(), start + 1, 'файлы не меняли — число файлов доски не перечитывается')

      modal = await openCard(page, 'dcr-2')
      await modal.locator('.dc-file-name').first().waitFor()
      await modal.getByLabel('Загрузить: Понятийное соглашение').setInputFiles(PDF('Соглашение подписанное.pdf'))
      await part(modal, 'concept').getByText('Соглашение подписанное.pdf').waitFor()
      await modal.getByLabel('Загрузить: Загружаемые документы').setInputFiles([PDF('ДС № 1.pdf'), PDF('Приложение.pdf')])
      await part(modal, 'files').getByText('Приложение.pdf').waitFor()
      assert.deepEqual((await fileNames(modal, 'concept')).sort(), ['Понятийное соглашение СУ2.pdf', 'Соглашение подписанное.pdf'])
      assert.equal(await part(modal, 'files').locator('.dc-files-count').textContent(), '3')
      assert.deepEqual(await filesOf(page, 'dcr-2'), [
        ['ДП СУ2-001.pdf', null], ['ДС № 1.pdf', null], ['Понятийное соглашение СУ2.pdf', DOC_CHECK_CONCEPT_CATEGORY],
        ['Приложение.pdf', null], ['Соглашение подписанное.pdf', DOC_CHECK_CONCEPT_CATEGORY],
      ])

      await modal.getByRole('button', { name: 'Удалить Приложение.pdf' }).click()
      await page.waitForFunction(() => !window.__fakeDb.s3_documents.some((d) => d.file_name === 'Приложение.pdf'))
      assert.match(dialogs.at(-1), /Удалить файл «Приложение\.pdf»/)
      assert.deepEqual((await fileNames(modal, 'files')).sort(), ['ДП СУ2-001.pdf', 'ДС № 1.pdf'].sort())

      // Закрыли — скрепка на карточке доски показывает новое число.
      const clip = card(page, 'dcr-2').locator('.dc-count[title="Файлы заявки"]')
      assert.equal(await clip.textContent(), '2', 'пока окно открыто, доска не перечитывается')
      await modal.locator('.modal-close').click()
      await page.waitForFunction(() => document.querySelector('.dc-card[data-id="dcr-2"] .dc-count[title="Файлы заявки"]')?.textContent === '4')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('файл можно бросить на свою часть: она подсвечивается, файл встаёт в неё', async () => {
    const { page, errors, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-4')
      await modal.locator('.dc-files-empty').first().waitFor()
      assert.deepEqual(await modal.locator('.dc-files-empty').allTextContents(),
        ['Не загружено · можно перетащить файл сюда', 'Документы не загружены · можно перетащить файл сюда'])
      const target = part(modal, 'concept')
      const data = await page.evaluateHandle(() => {
        const dt = new DataTransfer()
        dt.items.add(new File(['%PDF-1.4'], 'Брошенное соглашение.pdf', { type: 'application/pdf' }))
        return dt
      })
      await target.dispatchEvent('dragover', { dataTransfer: data })
      assert.match(await target.getAttribute('class'), /is-over/)
      await target.dispatchEvent('drop', { dataTransfer: data })
      await target.getByText('Брошенное соглашение.pdf').waitFor()
      assert.doesNotMatch(await target.getAttribute('class'), /is-over/)
      assert.deepEqual(await filesOf(page, 'dcr-4'), [['Брошенное соглашение.pdf', DOC_CHECK_CONCEPT_CATEGORY]])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('исполнители — прямо в окне, без формы: отметка сразу в заявке, в истории и на доске; скрытый остаётся в базе', async () => {
    const { page, errors, close } = await openPage()
    try {
      await card(page, 'dcr-2').locator('.dc-avatar').first().waitFor()
      const modal = await openCard(page, 'dcr-4')
      const box = modal.locator('.dc-box', { hasText: 'Исполнители' })
      assert.match(await box.textContent(), /Не назначены/)
      const trigger = box.locator('.dc-assign .fdrop-trigger')
      const triggerText = box.locator('.dc-assign .fdrop-value')
      assert.equal(await triggerText.innerText(), 'Назначить исполнителя')
      await trigger.click()
      const options = page.locator('.fdrop-panel .fdrop-option')
      assert.deepEqual(await options.allTextContents(), ['Стендов Стенд Стендович', 'Юристова Мария Андреевна'], 'только юристы ОСП')
      await options.filter({ hasText: 'Юристова Мария Андреевна' }).click()
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-4').assignee_ids?.length === 1)
      assert.deepEqual((await row(page, 'dcr-4')).assignee_ids, ['user-3'])
      assert.deepEqual(await box.locator('.dc-person-name').allTextContents(), ['Юристова Мария Андреевна'])
      assert.equal(await triggerText.innerText(), 'Назначить или снять')
      assert.deepEqual(await card(page, 'dcr-4').locator('.dc-avatar').allTextContents(), ['ЮМ'], 'доска за окном обновилась')
      await options.filter({ hasText: 'Стендов Стенд Стендович' }).click()
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-4').assignee_ids?.length === 2)
      await page.keyboard.press('Escape')
      assert.equal(await page.locator('.dc-form-modal').count(), 0, 'форма «Изменить» не открывалась')
      const log = await page.evaluate(() => window.__fakeDb.doc_check_request_audit_log.filter((l) => l.request_id === 'dcr-4'))
      assert.deepEqual(log.map((l) => [l.field_name, l.new_value]), [['assignee_ids', ['user-3']], ['assignee_ids', ['user-3', 'user-1']]])
      await modal.getByRole('tab', { name: /^История/ }).click()
      await modal.locator('.dc-history li').nth(1).waitFor()
      assert.match(await modal.locator('.dc-history').textContent(), /Исполнители[^—]*—\s*→\s*Юристова Мария Андреевна/)
      await modal.locator('.modal-close').click()

      // У dcr-2 исполнители — юрист и сотрудник другой роли (выбор его не показывает): снять юриста — другой остаётся в базе.
      const other = await openCard(page, 'dcr-2')
      await other.locator('.dc-assign .fdrop-trigger').click()
      await options.filter({ hasText: 'Юристова Мария Андреевна' }).click()
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-2').assignee_ids.length === 1)
      assert.deepEqual((await row(page, 'dcr-2')).assignee_ids, ['user-2'])
      await page.keyboard.press('Escape')
      assert.match(await other.locator('.dc-box', { hasText: 'Исполнители' }).textContent(), /Не назначены/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('назначение не записалось — сообщение, на экране снова как в базе', async () => {
    const { page, errors, dialogs, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-4')
      await page.evaluate(() => {
        window.__fakeHold = ({ table, op }) => (table === 'doc_check_requests' && op === 'update'
          ? { error: { code: '42501', message: 'нет права' } } : {})
      })
      await modal.locator('.dc-assign .fdrop-trigger').click()
      await page.locator('.fdrop-panel .fdrop-option', { hasText: 'Юристова Мария Андреевна' }).click()
      await page.waitForFunction(() => document.querySelector('.dc-detail-modal')?.textContent.includes('Не назначены'))
      assert.match(dialogs.at(-1), /Не удалось сохранить заявку: нет права/)
      assert.deepEqual((await row(page, 'dcr-4')).assignee_ids, [])
      assert.equal(await page.evaluate(() => window.__fakeDb.doc_check_request_audit_log.length), 0, 'в истории ничего')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  // Страницы — ленивые куски со своими стилями, поэтому на сайте стили других разделов есть, только если их открывали:
  // по ссылке или после F5 их нет (окно вставало снизу, под доской, без фона), открыли раздел после доски — они позже её
  // стилей (окно сужалось). Стенд загружает их все заранее и этого не видит: здесь они убираются или переносятся в конец.
  const FOREIGN_STYLE_MODES = ['раньше страницы', 'нет', 'позже страницы']
  const setForeignStyles = (page, mode) => page.evaluate((mode) => {
    let touched = 0
    for (const s of [...document.querySelectorAll('style[data-vite-dev-id]')]) {
      if (/\/(DocCheckRequestsPage|workUi|mobile)\.css$/.test(s.dataset.viteDevId) || !/\.modal\b/.test(s.textContent)) continue
      touched += 1
      if (mode === 'нет') s.remove()
      if (mode === 'позже страницы') document.head.appendChild(s)
    }
    return touched
  }, mode)
  const measureWindow = (page, selector) => page.evaluate((selector) => {
    const modal = document.querySelector(selector)
    const overlay = modal.closest('.modal-overlay')
    const box = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round) }
    const style = getComputedStyle(modal)
    const shade = getComputedStyle(overlay)
    const form = modal.querySelector('form')
    return {
      overlay: box(overlay),
      position: shade.position,
      zIndex: shade.zIndex,
      shade: shade.backgroundColor,
      window: box(modal),
      background: style.backgroundColor,
      border: style.borderTopWidth,
      radius: style.borderTopLeftRadius,
      overflowY: style.overflowY,
      head: box(modal.querySelector('.modal-header')),
      close: box(modal.querySelector('.modal-close')),
      formPadding: form ? getComputedStyle(form).padding : null,
    }
  }, selector)

  for (const viewport of [{ width: 1700, height: 950 }, { width: 390, height: 780 }]) {
    const phone = viewport.width < 640
    it(`окно заявки и форма — всегда отдельным окном, откуда бы ни пришли на страницу (${viewport.width}px)`, async () => {
      const seen = {}
      for (const mode of FOREIGN_STYLE_MODES) {
        const { page, errors, close } = await openPage('', viewport)
        try {
          assert.ok(await setForeignStyles(page, mode) >= 3, 'стенд загрузил стили других разделов — есть что убирать')
          const detail = await openCard(page, 'dcr-3')
          const detailBox = await measureWindow(page, '.dc-detail-modal')
          await detail.locator('.modal-close').click()
          await detail.waitFor({ state: 'detached' })
          await page.getByRole('button', { name: /Новая заявка/ }).first().click()
          await page.locator('.dc-form-modal').waitFor()
          const formBox = await measureWindow(page, '.dc-form-modal')

          for (const [name, m] of [['заявка', detailBox], ['форма', formBox]]) {
            const where = `${name}, стили других разделов: ${mode}`
            assert.equal(m.position, 'fixed', `${where}: окно поверх страницы, а не в её потоке`)
            assert.deepEqual(m.overlay, [0, 0, viewport.width, viewport.height], `${where}: затемнение на весь экран`)
            assert.equal(m.shade, 'rgba(0, 0, 0, 0.5)', `${where}: страница затемнена`)
            assert.notEqual(m.background, 'rgba(0, 0, 0, 0)', `${where}: у окна свой фон`)
            assert.equal(m.zIndex, phone ? '1260' : '1000', `${where}: окно выше страницы (на телефоне — и выше полосы меню)`)
            const rightGap = m.window[0] + m.window[2] - (m.close[0] + m.close[2])
            assert.ok(rightGap >= 0 && rightGap < 40, `${where}: «×» у правого края окна: ${rightGap}`)
            assert.ok(m.close[1] < m.head[1] + m.head[3], `${where}: «×» в шапке, а не под ней`)
          }
          if (phone) {
            assert.deepEqual(detailBox.window, [0, 0, 390, 780], `стили других разделов: ${mode}: заявка на весь экран телефона`)
          } else {
            assert.deepEqual(detailBox.window, [226, 91, 1248, 768], `стили других разделов: ${mode}: заявка по центру, 78 × 48 rem`)
            assert.equal(formBox.window[2], 640, `стили других разделов: ${mode}: форма шириной 40 rem`)
            const centre = formBox.window[0] + formBox.window[2] / 2
            assert.equal(centre, viewport.width / 2, `стили других разделов: ${mode}: форма по центру`)
          }
          seen[mode] = { detailBox, formBox }
          assert.deepEqual(errors, [])
        } finally { await close() }
      }
      assert.deepEqual(seen['нет'], seen['раньше страницы'], 'сразу на страницу — то же окно, что после другого раздела')
      assert.deepEqual(seen['позже страницы'], seen['раньше страницы'], 'другой раздел после доски окно не меняет')
    })
  }

  it('телефон: окно на весь экран, разделы столбцом, переписка — под ними', async () => {
    const { page, errors, close } = await openPage('', { width: 390, height: 780 })
    try {
      const modal = await openCard(page, 'dcr-3')
      await modal.locator('.dc-talk-msg').first().waitFor()
      const box = await modal.boundingBox()
      assert.deepEqual([box.x, box.y, box.width, box.height], [0, 0, 390, 780])
      const lefts = await modal.locator('.dc-box').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)))
      assert.equal(new Set(lefts).size, 1, `один столбец: ${lefts}`)
      const lastBox = await modal.locator('.dc-box').last().boundingBox()
      const talk = await modal.locator('.dc-general-talk').boundingBox()
      assert.ok(talk.y >= lastBox.y + lastBox.height, 'переписка — под сведениями')
      assert.equal(await modal.locator('.dc-detail-body').evaluate((b) => b.scrollWidth <= b.clientWidth), true, 'без горизонтальной прокрутки')
      assert.equal(await modal.locator('.dc-detail-body').evaluate((b) => b.scrollTop), 0, 'окно открывается с начала, а не с конца переписки')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('доска: сообщения и письмо на карточке; у остальных лишнего нет', async () => {
    const { page, errors, close } = await openPage()
    try {
      const c = card(page, 'dcr-3')
      await c.locator('.dc-count--talk').waitFor()
      assert.equal(await c.locator('.dc-count--talk').textContent(), '2')
      assert.match(await c.locator('.dc-count--talk').getAttribute('title'), /2 сообщения/)
      assert.equal(await c.locator('.dc-chip--mail').textContent(), 'Письмо')
      assert.equal(await card(page, 'dcr-2').locator('.dc-count--talk, .dc-chip--mail').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('письмо открывается с карточки в новой вкладке: карточка заявки не открывается; перетаскивать можно и за ссылку', async () => {
    const { page, context, errors, close } = await openPage()
    try {
      await context.route('https://mail.example.invalid/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: 'письмо' }))
      const link = card(page, 'dcr-3').locator('.dc-chip--mail')
      await link.waitFor()
      assert.equal(await link.getAttribute('rel'), 'noopener noreferrer')
      assert.equal(await link.getAttribute('target'), '_blank')
      const [popup] = await Promise.all([context.waitForEvent('page'), link.click()])
      await popup.waitForURL('https://mail.example.invalid/letter/3')
      await popup.close()
      assert.equal(await page.locator('.dc-detail-modal').count(), 0, 'щелчок по письму карточку заявки не открыл')

      await link.dragTo(page.locator('.dc-column[data-status="signal"] .dc-column-body'))
      await page.waitForFunction(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-3').status === 'signal')

      // В окне заявки — тоже ссылка; у заявки без письма строки нет.
      const modal = await openCard(page, 'dcr-3')
      assert.equal(await modal.locator('.dc-detail-mail').getAttribute('href'), 'https://mail.example.invalid/letter/3')
      await modal.locator('.modal-close').click()
      const plain = await openCard(page, 'dcr-2')
      assert.equal(await plain.locator('.dc-row-kv', { hasText: 'Письмо' }).count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('значение не http(s) в базе (ручная правка) не становится ссылкой', async () => {
    const { page, errors, close } = await openPage('&dcBadLink=1')
    try {
      await card(page, 'dcr-3').locator('.dc-count--talk').waitFor()
      assert.equal(await page.locator('a.dc-chip--mail').count(), 0)
      const modal = await openCard(page, 'dcr-3')
      assert.equal(await modal.locator('.dc-detail-mail').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('обсуждение справа: автор, текст, время; Shift+Enter — перенос; пустое не уходит; число на доске — сразу', async () => {
    const { page, errors, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-3')
      const msgs = modal.locator('.dc-talk-msg')
      await msgs.nth(1).waitFor()
      assert.equal(await modal.locator('.dc-talk-title').textContent(), 'Обсуждение2')
      assert.equal(await msgs.nth(0).locator('b').textContent(), 'Юристова Мария Андреевна')
      assert.equal(await msgs.nth(0).locator('.dc-talk-body').textContent(), 'Договор ушёл на подпись\nждём оригинал')
      assert.match(await msgs.nth(0).locator('.dc-talk-time').textContent(), /^21\.10\.2026, \d\d:\d\d$/)
      assert.doesNotMatch(await msgs.nth(0).getAttribute('class'), /is-mine/)
      assert.match(await msgs.nth(1).getAttribute('class'), /is-mine/, 'своё сообщение прижато вправо')

      const field = modal.getByRole('textbox', { name: 'Новое сообщение' })
      const send = modal.getByRole('button', { name: 'Отправить' })
      assert.equal(await send.isDisabled(), true, 'пустое не отправить')
      await field.fill('   ')
      await field.press('Enter')
      assert.equal(await msgs.count(), 2)
      const oneLine = (await field.boundingBox()).height
      await field.fill('')
      await field.click()
      await page.keyboard.type('Первая строка')
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type('вторая строка')
      assert.ok((await field.boundingBox()).height > oneLine, 'поле выросло по строкам')
      await page.keyboard.press('Enter')
      await msgs.nth(2).waitFor()
      assert.equal(await msgs.nth(2).locator('.dc-talk-body').textContent(), 'Первая строка\nвторая строка')
      assert.equal(await msgs.nth(2).locator('b').textContent(), 'Тест', 'автора ставит база')
      assert.equal(await field.inputValue(), '')
      assert.equal((await field.boundingBox()).height, oneLine, 'после отправки — снова в одну строку')

      const last = await page.evaluate(() => window.__fakeDb.doc_check_request_comments.at(-1))
      assert.equal(last.request_id, 'dcr-3')
      assert.equal(last.body, 'Первая строка\nвторая строка')
      // Клиент автора не шлёт: его ставит база.
      const sent = await page.evaluate(() => window.__supabaseStats.requests.filter((r) => r.table === 'doc_check_request_comments' && r.op === 'insert').length)
      assert.equal(sent, 1)

      assert.equal(await modal.locator('.dc-talk-title').textContent(), 'Обсуждение3')
      assert.equal(await card(page, 'dcr-3').locator('.dc-count--talk').textContent(), '3', 'доска за окном обновилась')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('длинная переписка: прокручивается сама, при открытии виден конец, поле ввода на месте, сведения — с начала', async () => {
    const { page, errors, close } = await openPage('&dcComments=40')
    try {
      const modal = await openCard(page, 'dcr-3')
      await modal.locator('.dc-talk-msg').nth(41).waitFor()
      const list = modal.locator('.dc-talk-list')
      assert.ok(await list.evaluate((el) => el.scrollHeight > el.clientHeight + 100), 'переписка длиннее панели')
      assert.ok(await list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 2), 'видна последняя')
      assert.equal(await modal.locator('.dc-general-main').evaluate((el) => el.scrollTop), 0)
      const field = modal.getByRole('textbox', { name: 'Новое сообщение' })
      const fieldBox = await field.boundingBox()
      const talkBox = await modal.locator('.dc-general-talk').boundingBox()
      assert.ok(fieldBox.y + fieldBox.height <= talkBox.y + talkBox.height, 'поле ввода в видимой части')
      await field.fill('Новое')
      await field.press('Enter')
      await modal.locator('.dc-talk-msg').nth(42).waitFor()
      const lastMsg = await modal.locator('.dc-talk-msg').nth(42).boundingBox()
      const fieldNow = await field.boundingBox()
      assert.ok(lastMsg.y + lastMsg.height <= fieldNow.y + 1, 'новое сообщение не под полем ввода')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('больше 1000 сообщений: счётчик на доске точный (потолок строк PostgREST)', async () => {
    const { page, errors, close } = await openPage('&maxRows=1000&dcComments=1200')
    try {
      const c = card(page, 'dcr-3')
      await c.locator('.dc-count--talk').waitFor()
      assert.equal(await c.locator('.dc-count--talk').textContent(), '1202')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('щелчок мимо окна и Escape окно не закрывают: черновик сообщения остаётся', async () => {
    const { page, errors, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-3')
      const field = modal.getByRole('textbox', { name: 'Новое сообщение' })
      await field.fill('Черновик')
      const box = await modal.boundingBox()
      await page.mouse.click(Math.max(5, box.x - 40), box.y + box.height / 2)
      await page.mouse.click(5, 5)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(150)
      assert.equal(await modal.count(), 1, 'окно на месте')
      assert.equal(await field.inputValue(), 'Черновик')
      await modal.locator('.modal-close').click()
      await modal.waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('сбой отправки: текст сообщения не пропадает', async () => {
    const { page, errors, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-3')
      await modal.locator('.dc-talk-msg').nth(1).waitFor()
      await page.evaluate(() => {
        window.__fakeHold = ({ table, op }) => (table === 'doc_check_request_comments' && op === 'insert'
          ? { error: { code: '500', message: 'сбой' } } : {})
      })
      const field = modal.getByRole('textbox', { name: 'Новое сообщение' })
      await field.fill('Важное сообщение')
      await field.press('Enter')
      await page.waitForTimeout(100)
      assert.equal(await field.inputValue(), 'Важное сообщение', 'при сбое написанное остаётся')
      assert.equal(await modal.locator('.dc-talk-msg').count(), 2)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('ссылки на письмо при создании нет; у прежней заявки со ссылкой её можно поправить или убрать', async () => {
    const { page, errors, close } = await openPage()
    try {
      await page.getByRole('button', { name: /Новая заявка/ }).first().click()
      const form = page.locator('.dc-form-modal')
      await form.waitFor()
      assert.equal(await form.locator('#dc-email-link').count(), 0, 'при создании поля нет')
      assert.doesNotMatch(await form.innerText(), /Ссылка на письмо/)
      await form.locator('.modal-close').click()

      await page.evaluate(() => {
        window.__patches = []
        window.__fakeHold = ({ table, op, patch }) => {
          if (table === 'doc_check_requests' && op === 'update') window.__patches.push(patch)
          return {}
        }
      })
      let modal = await openCard(page, 'dcr-2')
      await modal.getByRole('button', { name: 'Изменить' }).click()
      assert.equal(await form.locator('#dc-email-link').count(), 0, 'у заявки без ссылки — тоже нет')
      await form.locator('#dc-num').fill('СУ2-001-1')
      await form.getByRole('button', { name: 'Сохранить' }).click()
      await form.waitFor({ state: 'detached' })
      const patches = await page.evaluate(() => window.__patches)
      assert.equal(patches.length, 1)
      assert.ok(!('email_link' in patches[0]), 'ссылку форма не шлёт')

      // У dcr-3 ссылка с прежней доски — поле в правке есть.
      modal = await openCard(page, 'dcr-3')
      await modal.getByRole('button', { name: 'Изменить' }).click()
      assert.equal(await form.locator('#dc-email-link').inputValue(), 'https://mail.example.invalid/letter/3')
      await form.locator('#dc-email-link').fill('javascript:alert(1)')
      await form.getByRole('button', { name: 'Сохранить' }).click()
      assert.match(await form.locator('.dc-form-error').textContent(), /https:/)
      assert.equal((await row(page, 'dcr-3')).email_link, 'https://mail.example.invalid/letter/3')
      // Убрать можно: пустое поле — NULL, а не ошибка ограничения.
      await form.locator('#dc-email-link').fill('')
      await form.getByRole('button', { name: 'Сохранить' }).click()
      await form.waitFor({ state: 'detached' })
      assert.equal((await row(page, 'dcr-3')).email_link, null)
      assert.equal(await card(page, 'dcr-3').locator('.dc-chip--mail').count(), 0)
      const log = await page.evaluate(() => window.__fakeDb.doc_check_request_audit_log.filter((l) => l.request_id === 'dcr-3').map((l) => l.field_name))
      assert.deepEqual(log, ['email_link'])
      const detail = await openCard(page, 'dcr-3', 'История')
      await detail.locator('.dc-history li').first().waitFor()
      assert.match(await detail.locator('.dc-history').textContent(), /Ссылка на письмо/)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('без права правки: файлы — только скачать, назначать нельзя, написать сообщение можно', async () => {
    const { page, errors, close } = await openPage('&canEdit=0&asUser=user-9')
    try {
      const modal = await openCard(page, 'dcr-2')
      await modal.locator('.dc-file-name').first().waitFor()
      assert.equal(await modal.locator('.dc-files-add, .dc-file-del, input[type="file"], .dc-assign').count(), 0)
      assert.equal(await modal.getByRole('button', { name: /^Скачать / }).count(), 2)
      assert.deepEqual(await modal.locator('.dc-files-empty').count(), 0)
      await modal.locator('.modal-close').click()

      const talk = await openCard(page, 'dcr-3')
      const field = talk.getByRole('textbox', { name: 'Новое сообщение' })
      await field.fill('Вопрос от смотрящего')
      await field.press('Enter')
      await talk.locator('.dc-talk-msg').nth(2).waitFor()
      assert.match(await talk.locator('.dc-talk-msg').nth(2).getAttribute('class'), /is-mine/)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('удалённая заявка: обсуждение, файлы и исполнители — только чтение', async () => {
    const { page, errors, close } = await openPage()
    try {
      await page.evaluate(() => {
        const fdb = window.__fakeDb
        fdb.doc_check_request_comments.forEach((c) => { c.request_id = 'dcr-9' })
        fdb.s3_documents.filter((d) => d.owner_id === 'dcr-2').forEach((d) => { d.owner_id = 'dcr-9' })
        window.__fakeTouch('doc_check_request_comments')
        window.__fakeTouch('s3_documents')
      })
      await page.locator('.dc-mode-toggle--deleted').click()
      await page.locator('.dc-table tbody tr', { hasText: '№ 9' }).click()
      const modal = page.locator('.dc-detail-modal')
      await modal.locator('.dc-talk-msg').nth(1).waitFor()
      await modal.locator('.dc-file-name').nth(1).waitFor()
      assert.equal(await modal.locator('.dc-talk-add, .dc-files-add, .dc-file-del, .dc-assign').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('миграции 20261124 ещё нет: без переписки, к её таблице нет обращений, форма новых полей не шлёт', async () => {
    const { page, errors, close } = await openPage('&docCheckNoCard=1')
    try {
      assert.match(await page.locator('.dc-note').textContent(), /Обсуждение появится после[\s\S]*20261124_doc_check_card/)
      const c = card(page, 'dcr-2')
      assert.deepEqual(await c.locator('.dc-avatar').allTextContents(), ['ЮМ'], 'поля 20261113 на месте')
      const modal = await openCard(page, 'dcr-3')
      assert.deepEqual(await modal.locator('.dc-detail-tab').allTextContents(), ['Общая', 'История'])
      assert.equal(await modal.locator('.dc-general-talk').count(), 0)
      assert.equal(await modal.locator('.dc-assign').count(), 1, 'назначать можно — это поля 20261113')
      await modal.getByRole('button', { name: 'Изменить' }).click()
      const form = page.locator('.dc-form-modal')
      assert.equal(await form.locator('#dc-email-link').count(), 0)
      await form.locator('#dc-num').fill('3-1')
      await form.getByRole('button', { name: 'Сохранить' }).click()
      await form.waitFor({ state: 'detached' })
      const saved = await row(page, 'dcr-3')
      assert.equal(saved.doc_number, '3-1')
      assert.ok(!('email_link' in saved) && !('manual_assignees' in saved), 'базе без колонок новые поля не шлются')
      const asked = await page.evaluate(() => window.__supabaseStats.requests.filter((r) => /doc_check_request_(steps|comments)/.test(r.table)).length)
      assert.equal(asked, 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('прежняя база (нет и 20261113): подсказка одна, вкладки те же, назначать нечего', async () => {
    const { page, errors, close } = await openPage('&docCheckLegacy=1')
    try {
      assert.match(await page.locator('.dc-note').textContent(), /20261113_doc_check_board/)
      const modal = await openCard(page, 'dcr-3')
      assert.deepEqual(await modal.locator('.dc-detail-tab').allTextContents(), ['Общая', 'История'])
      assert.equal(await modal.locator('.dc-assign, .dc-general-talk').count(), 0)
      await modal.locator('.dc-files-part').nth(1).waitFor()
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('телефон: вкладки в одну строку, «×» не под полосой меню, поля не шире экрана, кнопки под палец', async () => {
    const { page, errors, close } = await openPage('&shell=1&dcComments=30', { width: 390, height: 780 })
    try {
      const modal = await openCard(page, 'dcr-2')
      await modal.locator('.dc-file-name').first().waitFor()
      const tabs = await modal.locator('.dc-detail-tab').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top))
      assert.equal(new Set(tabs.map(Math.round)).size, 1, 'вкладки — в один ряд')
      const close1 = await modal.locator('.modal-close').boundingBox()
      const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.modal-close') != null, { x: close1.x + close1.width / 2, y: close1.y + close1.height / 2 })
      assert.equal(hit, true, 'полоса меню не закрывает «×»')
      const overflow = await page.evaluate(() => document.querySelector('.dc-detail-modal').scrollWidth - document.querySelector('.dc-detail-modal').clientWidth)
      assert.ok(overflow <= 0, `окно не шире экрана (лишних ${overflow}px)`)
      for (const sel of ['.dc-file-btn', '.dc-files-add', '.dc-assign .fdrop-trigger']) {
        const b = await modal.locator(sel).first().boundingBox()
        assert.ok(b.height >= 40, `${sel}: можно нажать пальцем (${b.height}px)`)
      }
      await modal.locator('.modal-close').click()

      // Длинная переписка: ряд вкладок не сжимается по высоте, поле ввода — 16 px (иначе Safari увеличивает страницу).
      const talk = await openCard(page, 'dcr-3')
      const tabHeight = (await talk.locator('.dc-detail-tabs').boundingBox()).height
      await talk.locator('.dc-talk-msg').nth(31).waitFor()
      const field = talk.getByRole('textbox', { name: 'Новое сообщение' })
      await field.scrollIntoViewIfNeeded()
      assert.equal((await talk.locator('.dc-detail-tabs').boundingBox()).height, tabHeight)
      const fb = await field.boundingBox()
      assert.ok(fb.y + fb.height <= 780, 'поле ввода на экране')
      assert.equal(await field.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)), 16)
      assert.ok((await talk.locator('.modal-close').boundingBox()).y >= 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
