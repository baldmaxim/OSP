// «Заявки на проверку ДП/ДС»: карточка заявки — обсуждение, шаги, ссылка на письмо (миграция 20261124; образец —
// обсуждение и чек-лист задач). Правила без браузера и страница в Chromium (стенд tests/tender/ui,
// route=/doc-check-requests&docCheck=1; у dcr-3 — шаги, сообщения и письмо). Исполнители и поля администратора —
// doc-check-assignees.test.mjs.
//   • на карточке доски: сколько шагов сделано, число сообщений, письмо открывается, не открывая карточку;
//   • обсуждение: автор, текст, время; Shift+Enter — перенос; автора ставит база; счётчик на доске — сразу;
//   • шаги: добавить, отметить, удалить, переставить ручкой и стрелками; правка текста;
//   • права: без права правки — только просмотр шагов (исполнитель отмечает), написать сообщение может любой;
//     удалённая заявка — только чтение;
//   • миграции ещё нет — всё как раньше, к новым таблицам нет обращений. База и права — doc-check-card-db.test.mjs.
// Люди стенда вымышленные.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  cardCountsById, compareSteps, fieldEvents, mergeRequestCounts, stepTitles, MAX_STEP_TITLE,
} from '../../src/utils/docCheckHelpers.js'
import { safeHttpUrl } from '../../src/utils/publicTenders.js'

describe('Карточка заявки: правила без браузера', () => {
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
    assert.deepEqual(first[0], { id: 'a', docsCount: 2, stepsTotal: 0, stepsDone: 0, commentsCount: 0 })
    const same = mergeRequestCounts([a, b], new Map([['a', 2]]), new Map(), cache)
    assert.equal(same[0], first[0])
    assert.equal(same[1], first[1])
    const changed = mergeRequestCounts([a, b], new Map([['a', 2]]), new Map([['b', { stepsTotal: 3, stepsDone: 1, commentsCount: 0 }]]), cache)
    assert.equal(changed[0], first[0], 'соседняя заявка не меняется')
    assert.notEqual(changed[1], first[1])
    assert.equal(changed[1].stepsTotal, 3)
  })

  it('история: ссылка — отдельным полем', () => {
    const events = fieldEvents({ email_link: null, notes: 'x' }, { email_link: 'https://x.invalid/1', notes: 'x' })
    assert.deepEqual(events.map(e => [e.field_name, e.new_value]), [['email_link', 'https://x.invalid/1']])
  })

  it('счётчики и порядок шагов; строки поля — отдельные шаги', () => {
    const map = cardCountsById(
      [{ request_id: 'a', is_done: true }, { request_id: 'a', is_done: false }, { request_id: 'b', is_done: false }],
      [{ request_id: 'a' }, { request_id: 'c' }, { request_id: 'c' }],
    )
    assert.deepEqual(map.get('a'), { stepsTotal: 2, stepsDone: 1, commentsCount: 1 })
    assert.deepEqual(map.get('b'), { stepsTotal: 1, stepsDone: 0, commentsCount: 0 })
    assert.deepEqual(map.get('c'), { stepsTotal: 0, stepsDone: 0, commentsCount: 2 })
    assert.deepEqual(stepTitles('  Первый \n\n Второй\r\n'), ['Первый', 'Второй'])
    assert.equal(stepTitles('я'.repeat(600))[0].length, MAX_STEP_TITLE)
    const list = [
      { id: 'b', sort_order: 10, created_at: '2026-01-02' }, { id: 'a', sort_order: 10, created_at: '2026-01-01' },
      { id: 'c', sort_order: 0, created_at: '2026-01-03' },
    ]
    assert.deepEqual(list.sort(compareSteps).map(s => s.id), ['c', 'a', 'b'])
  })

  it('стили шагов и обсуждения — у самой страницы: она ленивая, чужой CSS может не загрузиться', () => {
    const css = fs.readFileSync(path.join(REPO, 'src', 'pages', 'DocCheckRequestsPage.css'), 'utf8')
    for (const cls of ['.dc-steps', '.dc-step-handle', '.dc-talk-msg', '.dc-inline-add', '.dc-chip--mail']) {
      assert.ok(css.includes(cls), cls)
    }
    const used = ['DocCheckSteps', 'DocCheckDiscussion'].map((f) => fs.readFileSync(path.join(REPO, 'src', 'components', 'doccheck', `${f}.jsx`), 'utf8')).join('')
    assert.doesNotMatch(used, /task-checklist|task-comment|task-inline-add/)
  })
})

const launch = browserLaunchOptions()

describe('Карточка заявки на проверку ДП/ДС в браузере', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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
  const card = (page, id) => page.locator(`.dc-column[data-status="in_progress"] .dc-card[data-id="${id}"]`)
  const openCard = async (page, id, tab) => {
    await page.locator(`.dc-column .dc-card[data-id="${id}"]`).first().click()
    const modal = page.locator('.dc-detail-modal')
    await modal.waitFor()
    if (tab) await modal.getByRole('tab', { name: new RegExp(`^${tab}`) }).click()
    return modal
  }
  const stepTitlesOnPage = (modal) => modal.locator('.dc-steps li').evaluateAll((els) => els.map((el) => el.querySelector('.dc-step-label span')?.textContent ?? ''))
  const dbSteps = (page) => page.evaluate(() => window.__fakeDb.doc_check_request_steps
    .filter((s) => s.request_id === 'dcr-3')
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
    .map((s) => s.title))

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
      await modal.getByRole('tab', { name: /^Шаги/ }).click()
      await modal.locator('.dc-steps li').nth(2).waitFor()
      await modal.getByRole('tab', { name: /^Обсуждение/ }).click()
      await modal.locator('.dc-talk-msg').first().waitFor()
      await modal.locator('.modal-close').click()
      await modal.waitFor({ state: 'detached' })
      await page.waitForTimeout(300)
      assert.equal(await page.evaluate(() => window.__cardRenders), 0, 'карточки доски не перерисованы')

      // Что-то изменилось в заявке — перерисована только её карточка (в колонке статуса и, возможно, в «Сводке»).
      const again = await openCard(page, 'dcr-3', 'Обсуждение')
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

  it('число файлов перечитывается, только если открывали вкладку «Документы»', async () => {
    const { page, errors, close } = await openPage()
    try {
      const reads = () => page.evaluate(() => window.__supabaseStats.requests.filter((q) => q.table === 's3_documents').length)
      await page.waitForTimeout(300)
      const start = await reads()
      let modal = await openCard(page, 'dcr-2')
      await modal.locator('.modal-close').click()
      await modal.waitFor({ state: 'detached' })
      await page.waitForTimeout(200)
      assert.equal(await reads(), start, 'окно открыли и закрыли — лишнего запроса нет')
      modal = await openCard(page, 'dcr-2', 'Документы')
      await modal.getByText('ДП СУ2-001.pdf').waitFor()
      const inTab = await reads()
      await modal.locator('.modal-close').click()
      await page.waitForFunction((n) => window.__supabaseStats.requests.filter((q) => q.table === 's3_documents').length > n, inTab)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('вид окна: разделы с заголовками, две колонки, постоянная высота; подписи контрастные', async () => {
    const { page, errors, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-2')
      assert.deepEqual(await modal.locator('.dc-box-head').evaluateAll((els) => els.map((e) => e.firstChild.textContent)),
        ['Примечание', 'Документ', 'Срок и приоритет', 'Создание', 'Статус', 'Исполнители'])
      const cols = await modal.locator('.dc-info-col').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)))
      assert.equal(cols.length, 2)
      assert.ok(cols[1] > cols[0] + 200, `колонки рядом: ${cols}`)
      assert.match(await modal.locator('.dc-detail-sub .dc-status-chip').innerText(), /В работе/)
      assert.match(await modal.locator('.dc-detail-sub').innerText(), /Договор подряда/)
      assert.equal(await modal.locator('.dc-status-opt.is-current').count(), 1)
      assert.equal(await modal.locator('.dc-status-opt').count(), 7, 'каждая колонка доски — отдельной строкой (без убранной «Проверки документов»)')

      const height = (await modal.boundingBox()).height
      for (const tab of ['Шаги', 'Обсуждение', 'Документы', 'История', 'Заявка']) {
        await modal.getByRole('tab', { name: new RegExp(`^${tab}`) }).click()
        assert.equal((await modal.boundingBox()).height, height, `вкладка «${tab}» не меняет высоту окна`)
      }
      const size = await modal.locator('.dc-row-kv dd').first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize))
      assert.ok(size >= 14, `текст значений не мельче 14px: ${size}`)
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
            assert.deepEqual(detailBox.window, [370, 107, 960, 736], `стили других разделов: ${mode}: заявка по центру, 60 × 46 rem`)
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

  it('телефон: окно на весь экран, разделы столбцом', async () => {
    const { page, errors, close } = await openPage('', { width: 390, height: 780 })
    try {
      const modal = await openCard(page, 'dcr-3')
      const box = await modal.boundingBox()
      assert.deepEqual([box.x, box.y, box.width, box.height], [0, 0, 390, 780])
      const widths = await modal.locator('.dc-box').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)))
      assert.equal(new Set(widths).size, 1, `один столбец: ${widths}`)
      assert.equal(await modal.locator('.dc-detail-body').evaluate((b) => b.scrollWidth <= b.clientWidth), true, 'без горизонтальной прокрутки')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('доска: шаги, сообщения, письмо и вписанный исполнитель на карточке; у остальных лишнего нет', async () => {
    const { page, errors, close } = await openPage()
    try {
      const c = card(page, 'dcr-3')
      await c.locator('.dc-count--steps').waitFor()
      assert.equal(await c.locator('.dc-count--steps').textContent(), '1/3')
      assert.match(await c.locator('.dc-count--steps').getAttribute('title'), /сделано 1 из 3/)
      assert.equal(await c.locator('.dc-count--talk').textContent(), '2')
      assert.match(await c.locator('.dc-count--talk').getAttribute('title'), /2 сообщения/)
      assert.equal(await c.locator('.dc-chip--mail').textContent(), 'Письмо')
      const other = card(page, 'dcr-2')
      assert.equal(await other.locator('.dc-count--steps, .dc-count--talk, .dc-chip--mail').count(), 0)
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

      // В карточке заявки — тоже ссылка.
      const modal = await openCard(page, 'dcr-3')
      assert.equal(await modal.locator('.dc-detail-mail').getAttribute('href'), 'https://mail.example.invalid/letter/3')
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

  it('обсуждение: автор, текст, время; Shift+Enter — перенос; пустое не уходит; число на доске — сразу', async () => {
    const { page, errors, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-3', 'Обсуждение')
      const msgs = modal.locator('.dc-talk-msg')
      await msgs.nth(1).waitFor()
      assert.equal(await modal.getByRole('tab', { name: /^Обсуждение/ }).textContent(), 'Обсуждение2')
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

      const row = await page.evaluate(() => window.__fakeDb.doc_check_request_comments.at(-1))
      assert.equal(row.request_id, 'dcr-3')
      assert.equal(row.body, 'Первая строка\nвторая строка')
      // Клиент автора не шлёт: его ставит база.
      const sent = await page.evaluate(() => window.__supabaseStats.requests.filter((r) => r.table === 'doc_check_request_comments' && r.op === 'insert').length)
      assert.equal(sent, 1)

      assert.equal(await modal.getByRole('tab', { name: /^Обсуждение/ }).textContent(), 'Обсуждение3')
      assert.equal(await card(page, 'dcr-3').locator('.dc-count--talk').textContent(), '3', 'доска за окном обновилась')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('длинная переписка: при открытии виден конец, поле ввода на месте', async () => {
    const { page, errors, close } = await openPage('&dcComments=40')
    try {
      const modal = await openCard(page, 'dcr-3', 'Обсуждение')
      await modal.locator('.dc-talk-msg').nth(41).waitFor()
      const field = modal.getByRole('textbox', { name: 'Новое сообщение' })
      const fieldBox = await field.boundingBox()
      const bodyBox = await modal.locator('.dc-detail-body').boundingBox()
      assert.ok(fieldBox.y + fieldBox.height <= bodyBox.y + bodyBox.height, 'поле ввода в видимой части')
      assert.equal(await modal.locator('.dc-talk-msg').nth(41).locator('.dc-talk-body').isVisible(), true)
      await field.fill('Новое')
      await field.press('Enter')
      await modal.locator('.dc-talk-msg').nth(42).waitFor()
      const last = await modal.locator('.dc-talk-msg').nth(42).boundingBox()
      const fieldNow = await field.boundingBox()
      assert.ok(last.y + last.height <= fieldNow.y + 1, 'новое сообщение не под полем ввода')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('больше 1000 сообщений и шагов: счётчик на доске точный (потолок строк PostgREST)', async () => {
    const { page, errors, close } = await openPage('&maxRows=1000&dcComments=1200&dcSteps=1100')
    try {
      const c = card(page, 'dcr-3')
      await c.locator('.dc-count--talk').waitFor()
      assert.equal(await c.locator('.dc-count--talk').textContent(), '1202')
      assert.equal(await c.locator('.dc-count--steps').textContent(), '1/1103')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('шаги: добавить строками, отметить, удалить; счётчик на доске и вкладке — сразу', async () => {
    const { page, errors, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-3', 'Шаги')
      await modal.locator('.dc-steps li').nth(2).waitFor()
      assert.deepEqual(await stepTitlesOnPage(modal), ['Сверить реквизиты', 'Проверить суммы', 'Отправить на подпись'])
      assert.equal(await modal.getByRole('tab', { name: /^Шаги/ }).textContent(), 'Шаги1/3')
      assert.match(await modal.locator('.dc-steps-summary').textContent(), /Сделано 1 из 3/)
      assert.match(await modal.locator('.dc-steps li').nth(0).getAttribute('class'), /is-done/)

      const field = modal.getByRole('textbox', { name: 'Новый шаг' })
      await field.click()
      await page.keyboard.type('Запросить оригинал')
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type('  Занести в 1С ')
      assert.equal(await modal.locator('.dc-inline-add .btn-secondary').textContent(), 'Добавить 2 шага')
      await page.keyboard.press('Enter')
      await modal.locator('.dc-steps li').nth(4).waitFor()
      assert.deepEqual((await stepTitlesOnPage(modal)).slice(3), ['Запросить оригинал', 'Занести в 1С'])
      assert.deepEqual((await dbSteps(page)).slice(3), ['Запросить оригинал', 'Занести в 1С'])
      assert.equal(await card(page, 'dcr-3').locator('.dc-count--steps').textContent(), '1/5')

      await modal.locator('.dc-steps li').nth(1).locator('input[type="checkbox"]').check()
      await page.waitForFunction(() => window.__fakeDb.doc_check_request_steps.find((s) => s.id === 'st-2').is_done === true)
      assert.equal(await modal.getByRole('tab', { name: /^Шаги/ }).textContent(), 'Шаги2/5')
      assert.equal(await card(page, 'dcr-3').locator('.dc-count--steps').textContent(), '2/5')

      await modal.getByRole('button', { name: 'Удалить шаг «Сверить реквизиты»' }).click()
      await page.waitForFunction(() => !window.__fakeDb.doc_check_request_steps.some((s) => s.id === 'st-1'))
      assert.equal(await card(page, 'dcr-3').locator('.dc-count--steps').textContent(), '1/4')

      // Все сделаны — счётчик зелёным.
      const boxes = modal.locator('.dc-steps li input[type="checkbox"]')
      for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check()
      await page.waitForFunction(() => window.__fakeDb.doc_check_request_steps.filter((s) => s.request_id === 'dcr-3').every((s) => s.is_done))
      assert.match(await card(page, 'dcr-3').locator('.dc-count--steps').getAttribute('class'), /is-full/)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('порядок шагов: ручкой мышью и стрелками; в базе — только сменившиеся номера', async () => {
    const { page, errors, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-3', 'Шаги')
      await modal.locator('.dc-steps li').nth(2).waitFor()
      const handle = modal.locator('.dc-steps li').nth(2).locator('.dc-step-handle')
      const target = await modal.locator('.dc-steps li').nth(0).boundingBox()
      const hb = await handle.boundingBox()
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
      await page.mouse.down()
      await page.mouse.move(hb.x + hb.width / 2, target.y + 3, { steps: 8 })
      assert.equal(await modal.locator('.dc-steps li.drop-before').count(), 1, 'место вставки подсвечено')
      await page.mouse.up()
      await page.waitForFunction(() => window.__fakeDb.doc_check_request_steps.find((s) => s.id === 'st-3').sort_order === 0)
      assert.deepEqual(await stepTitlesOnPage(modal), ['Отправить на подпись', 'Сверить реквизиты', 'Проверить суммы'])
      assert.deepEqual(await dbSteps(page), ['Отправить на подпись', 'Сверить реквизиты', 'Проверить суммы'])

      // Стрелка вниз: на одно место ниже, фокус остаётся на ручке этого шага.
      await modal.locator('.dc-steps li').nth(0).locator('.dc-step-handle').focus()
      await page.keyboard.press('ArrowDown')
      await page.waitForFunction(() => window.__fakeDb.doc_check_request_steps.find((s) => s.id === 'st-3').sort_order === 10)
      assert.deepEqual(await stepTitlesOnPage(modal), ['Сверить реквизиты', 'Отправить на подпись', 'Проверить суммы'])
      assert.equal(await page.evaluate(() => document.activeElement?.closest('li')?.dataset.itemId), 'st-3')

      // Порядок переживает повторное открытие.
      await modal.getByRole('button', { name: 'Закрыть' }).first().click()
      const again = await openCard(page, 'dcr-3', 'Шаги')
      await again.locator('.dc-steps li').nth(2).waitFor()
      assert.deepEqual(await stepTitlesOnPage(again), ['Сверить реквизиты', 'Отправить на подпись', 'Проверить суммы'])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('перетаскивание шага, отпущенное за краем окна, и щелчок мимо окна карточку не закрывают', async () => {
    const { page, errors, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-3', 'Шаги')
      await modal.locator('.dc-steps li').nth(2).waitFor()
      const box = await modal.boundingBox()
      const hb = await modal.locator('.dc-steps li').nth(1).locator('.dc-step-handle').boundingBox()
      await page.mouse.move(hb.x + 2, hb.y + 2)
      await page.mouse.down()
      await page.mouse.move(Math.max(5, box.x - 40), hb.y + 2, { steps: 4 })
      await page.mouse.up()
      await page.mouse.click(Math.max(5, box.x - 40), box.y + box.height / 2)
      await page.mouse.click(5, 5)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(150)
      assert.equal(await modal.count(), 1, 'окно на месте')

      // Черновик сообщения остаётся после щелчка мимо окна.
      await modal.getByRole('tab', { name: /^Обсуждение/ }).click()
      const field = modal.getByRole('textbox', { name: 'Новое сообщение' })
      await field.fill('Черновик')
      await page.mouse.click(5, 5)
      assert.equal(await field.inputValue(), 'Черновик')
      await modal.locator('.modal-close').click()
      await modal.waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('правка текста шага: Enter сохраняет, Escape отменяет', async () => {
    const { page, errors, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-3', 'Шаги')
      await modal.locator('.dc-steps li').nth(2).waitFor()
      await modal.getByRole('button', { name: 'Изменить шаг «Проверить суммы»' }).click()
      await modal.locator('.dc-step-edit').fill('Проверить суммы и НДС')
      await modal.locator('.dc-step-edit').press('Enter')
      await page.waitForFunction(() => window.__fakeDb.doc_check_request_steps.find((s) => s.id === 'st-2').title === 'Проверить суммы и НДС')
      await modal.getByRole('button', { name: 'Изменить шаг «Отправить на подпись»' }).click()
      await modal.locator('.dc-step-edit').fill('черновик')
      await modal.locator('.dc-step-edit').press('Escape')
      assert.equal(await modal.locator('.dc-step-edit').count(), 0)
      assert.equal((await stepTitlesOnPage(modal))[2], 'Отправить на подпись')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('сбой записи: шаг возвращается как в базе, текст сообщения не пропадает', async () => {
    const { page, errors, dialogs, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-3', 'Шаги')
      await modal.locator('.dc-steps li').nth(2).waitFor()
      // Отказ базы: отметка на экране возвращается.
      await page.evaluate(() => {
        window.__fakeHold = ({ table, op }) => (table === 'doc_check_request_steps' && op === 'update'
          ? { error: { code: '42501', message: 'нет права' } } : {})
      })
      await modal.locator('.dc-steps li').nth(1).locator('label').click()
      await modal.locator('.dc-steps li').nth(1).locator('input[type="checkbox"]:not(:checked)').waitFor()
      assert.match(dialogs.at(-1), /Не удалось изменить шаг: нет права/)
      assert.equal(await page.evaluate(() => window.__fakeDb.doc_check_request_steps.find((s) => s.id === 'st-2').is_done), false)

      // Запись прошла, но не задела строку (шаг удалил коллега; нет права): правила по строкам отвечают «0 строк» без
      // ошибки — это не должно выглядеть как успех.
      await page.evaluate(() => {
        window.__fakeHold = undefined
        window.__fakeDb.doc_check_request_steps = window.__fakeDb.doc_check_request_steps.filter((s) => s.id !== 'st-2')
        window.__fakeTouch('doc_check_request_steps')
      })
      await modal.locator('.dc-steps li').nth(1).locator('label').click()
      await page.waitForFunction(() => document.querySelectorAll('.dc-steps li').length === 2)
      assert.match(dialogs.at(-1), /Не удалось изменить шаг: Шаг уже удалён или нет права/)
      assert.deepEqual(await stepTitlesOnPage(modal), ['Сверить реквизиты', 'Отправить на подпись'])

      await page.evaluate(() => {
        window.__fakeHold = ({ table, op }) => (table === 'doc_check_request_comments' && op === 'insert'
          ? { error: { code: '500', message: 'сбой' } } : {})
      })
      await modal.getByRole('tab', { name: /^Обсуждение/ }).click()
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

  it('форма: ссылка на письмо сохраняется, пишется в историю, видна на доске и в реестре', async () => {
    const { page, errors, close } = await openPage()
    try {
      const modal = await openCard(page, 'dcr-2')
      await modal.getByRole('button', { name: 'Изменить' }).click()
      const form = page.locator('.dc-form-modal')
      // Не http(s) — форма не сохраняет.
      await form.locator('#dc-email-link').fill('javascript:alert(1)')
      await form.getByRole('button', { name: 'Сохранить' }).click()
      assert.match(await form.locator('.dc-form-error').textContent(), /https:/)
      assert.equal((await page.evaluate(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-2').email_link)), null)

      await form.locator('#dc-email-link').fill(' https://mail.example.invalid/letter/2 ')
      await form.getByRole('button', { name: 'Сохранить' }).click()
      await form.waitFor({ state: 'detached' })

      const saved = await page.evaluate(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-2'))
      assert.equal(saved.email_link, 'https://mail.example.invalid/letter/2')

      const c = card(page, 'dcr-2')
      assert.equal(await c.locator('.dc-chip--mail').getAttribute('href'), 'https://mail.example.invalid/letter/2')

      const log = await page.evaluate(() => window.__fakeDb.doc_check_request_audit_log.filter((l) => l.request_id === 'dcr-2').map((l) => l.field_name))
      assert.deepEqual(log, ['email_link'])
      const detail = await openCard(page, 'dcr-2', 'История')
      await detail.locator('.dc-history li').first().waitFor()
      const history = await detail.locator('.dc-history').textContent()
      assert.match(history, /Ссылка на письмо/)
      await detail.locator('.modal-close').click()

      await page.locator('.dc-view-btn', { hasText: 'Реестр' }).click()
      const row = page.locator('.dc-table tbody tr', { hasText: 'СУ2-001' })
      assert.equal(await row.locator('.dc-chip--mail').count(), 1)
      // Убрать ссылку можно: пустое поле — NULL, а не ошибка ограничения.
      await row.click()
      await page.locator('.dc-detail-modal').getByRole('button', { name: 'Изменить' }).click()
      await page.locator('.dc-form-modal #dc-email-link').fill('')
      await page.locator('.dc-form-modal').getByRole('button', { name: 'Сохранить' }).click()
      await page.locator('.dc-form-modal').waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-2').email_link), null)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('без права правки: шаги только просмотр, написать сообщение можно', async () => {
    const { page, errors, close } = await openPage('&canEdit=0&asUser=user-9')
    try {
      const modal = await openCard(page, 'dcr-3', 'Шаги')
      await modal.locator('.dc-steps li').nth(2).waitFor()
      assert.equal(await modal.locator('.dc-step-handle, .dc-step-btn, .dc-inline-add').count(), 0)
      assert.equal(await modal.locator('.dc-steps input[type="checkbox"]:not([disabled])').count(), 0)
      await modal.getByRole('tab', { name: /^Обсуждение/ }).click()
      const field = modal.getByRole('textbox', { name: 'Новое сообщение' })
      await field.fill('Вопрос от смотрящего')
      await field.press('Enter')
      await modal.locator('.dc-talk-msg').nth(2).waitFor()
      assert.match(await modal.locator('.dc-talk-msg').nth(2).getAttribute('class'), /is-mine/)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('исполнитель без права правки: ручки, карандаша и удаления нет, отметка шага работает', async () => {
    const { page, errors, close } = await openPage('&canEdit=0&asUser=user-3')
    try {
      const modal = await openCard(page, 'dcr-3', 'Шаги')
      await modal.locator('.dc-steps li').nth(2).waitFor()
      assert.equal(await modal.locator('.dc-step-handle, .dc-step-btn, .dc-inline-add').count(), 0)
      await modal.locator('.dc-steps li').nth(1).locator('label').click()
      await page.waitForFunction(() => window.__fakeDb.doc_check_request_steps.find((s) => s.id === 'st-2').is_done === true)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('удалённая заявка: шаги и обсуждение только чтение', async () => {
    const { page, errors, close } = await openPage()
    try {
      await page.evaluate(() => {
        const fdb = window.__fakeDb
        fdb.doc_check_request_steps.forEach((s) => { s.request_id = 'dcr-9' })
        fdb.doc_check_request_comments.forEach((c) => { c.request_id = 'dcr-9' })
        window.__fakeTouch('doc_check_request_steps')
        window.__fakeTouch('doc_check_request_comments')
      })
      await page.locator('.dc-mode-toggle--deleted').click()
      await page.locator('.dc-table tbody tr', { hasText: '№ 9' }).click()
      const modal = page.locator('.dc-detail-modal')
      await modal.getByRole('tab', { name: /^Шаги/ }).click()
      await modal.locator('.dc-steps li').nth(2).waitFor()
      assert.equal(await modal.locator('.dc-step-handle, .dc-step-btn, .dc-inline-add').count(), 0)
      assert.equal(await modal.locator('.dc-steps input[type="checkbox"]:not([disabled])').count(), 0)
      await modal.getByRole('tab', { name: /^Обсуждение/ }).click()
      await modal.locator('.dc-talk-msg').nth(1).waitFor()
      assert.equal(await modal.locator('.dc-talk-add').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('миграции 20261124 ещё нет: доска как раньше, к новым таблицам нет обращений, форма новых полей не шлёт', async () => {
    const { page, errors, close } = await openPage('&docCheckNoCard=1')
    try {
      assert.match(await page.locator('.dc-note').textContent(), /20261124_doc_check_card/)
      const c = card(page, 'dcr-2')
      assert.deepEqual(await c.locator('.dc-avatar').allTextContents(), ['ЮМ'], 'поля 20261113 на месте')
      const modal = await openCard(page, 'dcr-3')
      assert.deepEqual(await modal.locator('.dc-detail-tab').allTextContents(), ['Заявка', 'Документы', 'История'])
      await modal.getByRole('button', { name: 'Изменить' }).click()
      const form = page.locator('.dc-form-modal')
      assert.equal(await form.locator('#dc-email-link').count(), 0)
      await form.locator('#dc-num').fill('3-1')
      await form.getByRole('button', { name: 'Сохранить' }).click()
      await form.waitFor({ state: 'detached' })
      const saved = await page.evaluate(() => window.__fakeDb.doc_check_requests.find((r) => r.id === 'dcr-3'))
      assert.equal(saved.doc_number, '3-1')
      assert.ok(!('email_link' in saved) && !('manual_assignees' in saved), 'базе без колонок новые поля не шлются')
      const asked = await page.evaluate(() => window.__supabaseStats.requests.filter((r) => /doc_check_request_(steps|comments)/.test(r.table)).length)
      assert.equal(asked, 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('прежняя база (нет и 20261113): подсказка одна, новых вкладок нет', async () => {
    const { page, errors, close } = await openPage('&docCheckLegacy=1')
    try {
      assert.match(await page.locator('.dc-note').textContent(), /20261113_doc_check_board/)
      const modal = await openCard(page, 'dcr-3')
      assert.deepEqual(await modal.locator('.dc-detail-tab').allTextContents(), ['Заявка', 'Документы', 'История'])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('телефон: вкладки прокручиваются в одну строку, «×» не под полосой меню, поля не шире экрана', async () => {
    const { page, errors, close } = await openPage('&shell=1&dcSteps=30&dcComments=30', { width: 390, height: 780 })
    try {
      const modal = await openCard(page, 'dcr-3', 'Шаги')
      await modal.locator('.dc-steps li').nth(5).waitFor()
      const tabs = await modal.locator('.dc-detail-tab').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top))
      assert.equal(new Set(tabs.map(Math.round)).size, 1, 'вкладки — в один ряд')
      assert.ok(await modal.locator('.dc-detail-tabs').evaluate((el) => el.scrollWidth > el.clientWidth), 'лишние — прокруткой')
      const close1 = await modal.locator('.modal-close').boundingBox()
      const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.modal-close') != null, { x: close1.x + close1.width / 2, y: close1.y + close1.height / 2 })
      assert.equal(hit, true, 'полоса меню не закрывает «×»')
      const overflow = await page.evaluate(() => document.querySelector('.dc-detail-modal').scrollWidth - document.querySelector('.dc-detail-modal').clientWidth)
      assert.ok(overflow <= 0, `окно не шире экрана (лишних ${overflow}px)`)
      const size = await modal.getByRole('textbox', { name: 'Новый шаг' }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
      assert.equal(size, 16, 'иначе Safari увеличивает страницу при фокусе')
      const handle = await modal.locator('.dc-step-handle').first().boundingBox()
      assert.ok(handle.height >= 40, 'ручку можно взять пальцем')
      // Длинная переписка: ряд вкладок не сжимается по высоте, поле ввода и «×» на месте.
      const tabHeight = (await modal.locator('.dc-detail-tabs').boundingBox()).height
      await modal.getByRole('tab', { name: /^Обсуждение/ }).click()
      await modal.locator('.dc-talk-msg').nth(31).waitFor()
      assert.equal((await modal.locator('.dc-detail-tabs').boundingBox()).height, tabHeight)
      const field = await modal.getByRole('textbox', { name: 'Новое сообщение' }).boundingBox()
      assert.ok(field.y + field.height <= 780, 'поле ввода на экране')
      assert.ok((await modal.locator('.modal-close').boundingBox()).y >= 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
