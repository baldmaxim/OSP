// «Реестр по договорам» × SIGNAL (23.11.2026): значок Signal после сверки, окно сверки, фильтр «Сверка Signal», сообщение после
// сохранения (Р8). Сервер сверки — подмена в стенде (tests/tender/ui/signal-fake.js, ?signal=…), состояние — window.__signal.
//   • значок: красный (нет ссылки) / красный + синяя точка (предложена папка) / зелёный / жёлтый «!» (противоречие, папка не
//     видна, файл удалён); подпись — в title и aria-label; «!» читается (контраст ≥ 4,5:1 в обеих темах); без метки — как раньше;
//   • окно сверки у значка: подтвердить, заменить / оставить текущую, другая папка, отклонить, 409 на устаревшем окне, синоним;
//   • без права правки — ни окна, ни переключателя; телефон 390 px — без прокрутки вбок, окно на весь экран;
//   • ключ идемпотентности — на попытку «действие + папка»: повтор после потерянного ответа — тот же, другое действие или
//     папка — новый; медленная перезагрузка меток не затирает более новую (только что подтверждённую);
//   • «Сверка Signal»: число и строки (ДС под сверенным ДП — один договор-предок), по видам документа;
//   • Р8: после формы и окна путей сообщение «Найдена папка в Signal…», «Сверить» открывает окно по id, не меняя фильтры;
//     сверка недоступна (down) или медленна (slow) — сохранение не задерживается и не падает.
// Сценарий — шапка signal-fake.js: ctr-2 и ctr-8 — предложены папки, ctr-4 — папка не видна, ctr-5 — сверено (под ним ДС ctr-6 с
// противоречием), ctr-7 — файл удалён, ctr-11 — не сверялась; в «Сверке Signal» — 6 документов.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const BASE = 'route=/contracts/registry&contracts=30&contractsPaths=1&signal=1&latency=0&shell=1'
const GREEN = 'rgb(21, 128, 61)'
const RED = 'rgb(185, 28, 28)'
const AMBER = 'rgb(133, 77, 14)'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const node = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const link = (n) => `https://signal.su10.ru/folder/${node(n)}`
const ROOT = 'Альфа / Северный квартал'

// Цвет из computed style: rgb(...) или color(srgb ...) (результат color-mix).
function rgbOf(v) {
  let m = /rgba?\(([^)]+)\)/.exec(v)
  if (m) return m[1].split(/[ ,/]+/).filter(Boolean).slice(0, 3).map(Number)
  m = /color\(srgb ([^)]+)\)/.exec(v)
  if (m) return m[1].split(/[ /]+/).filter(Boolean).slice(0, 3).map((x) => Math.round(Number(x) * 255))
  throw new Error(`цвет не разобран: ${v}`)
}
const lum = ([r, g, b]) => {
  const f = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const contrast = (a, b) => { const [hi, lo] = [lum(rgbOf(a)), lum(rgbOf(b))].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }

describe('Реестр договоров × SIGNAL: значок, окно сверки, фильтр, сообщение после сохранения', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 600000 }, () => {
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

  // wait — что дождаться после открытия страницы (по умолчанию — переключатель «Сверка Signal»: метки загружены).
  const open = async (extra = '', { viewport = { width: 1600, height: 1000 }, wait = '.contracts-table tbody tr.contract-row', toggle = true, base = BASE } = {}) => {
    const context = await browser.newContext({ locale: 'ru-RU', timezoneId: 'Europe/Moscow', viewport })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource|счётчики номеров/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', async (d) => { dialogs.push({ type: d.type(), text: d.message() }); await d.accept() })
    await page.addInitScript(() => { try { localStorage.clear() } catch { /* нет */ } })
    await page.goto(`${stand.url}?${base}${extra}`)
    // Сервер разработки перезагружает страницу, когда рядом правят исходники: одна повторная загрузка — не ошибка теста.
    try { await page.locator(wait).first().waitFor({ timeout: 40000 }) } catch {
      await page.reload()
      await page.locator(wait).first().waitFor({ timeout: 80000 })
    }
    if (toggle) await page.locator('button.qfilter', { hasText: 'Сверка Signal' }).waitFor({ timeout: 30000 })
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }
  const rowOf = (page, number) => page.locator('.contracts-table tbody tr.contract-row', { hasText: new RegExp(`№ ${number.replace('/', '\\/')}(?![0-9])`) }).first()
  const markOf = (page, number) => rowOf(page, number).locator('.cmarks .dlm-signal')
  const toggleOf = (page) => page.locator('button.qfilter', { hasText: 'Сверка Signal' })
  const countOf = async (page) => Number((await toggleOf(page).locator('.qfilter-count').innerText()).trim())
  const calls = (page, re) => page.evaluate((src) => window.__signal.calls.filter((c) => new RegExp(src).test(`${c.method} ${c.path}`)), re.source)
  const dbContract = (page, id) => page.evaluate((i) => ({ ...window.__fakeDb.contracts.find((c) => c.id === i) }), id)
  const inspect = (loc) => loc.evaluate((el) => {
    const cs = getComputedStyle(el)
    const dot = getComputedStyle(el, '::after')
    return {
      tag: el.tagName.toLowerCase(), cls: el.className, color: cs.color, background: cs.backgroundColor, href: el.getAttribute('href'),
      title: el.getAttribute('title'), aria: el.getAttribute('aria-label'), role: el.getAttribute('role'),
      bang: el.querySelector('.dlm-bang')?.textContent ?? null, dot: dot.content !== 'none' && dot.content !== 'normal' ? dot.backgroundColor : null,
    }
  })
  // Окно у значка и содержимое после загрузки данных сервера.
  const openReview = async (page, number) => {
    await markOf(page, number).click()
    const pop = page.locator('.apop.srd-pop')
    await pop.waitFor()
    await pop.locator('.srd-grid').waitFor()
    return pop
  }
  const btn = (pop, name) => pop.getByRole('button', { name, exact: true })

  it('значок: красный, красный с точкой, зелёный, жёлтый с «!»; подпись в title и aria-label; без метки — как раньше', async () => {
    const { page, errors, close } = await open()
    try {
      const ok = await inspect(markOf(page, '1/26'))
      assert.deepEqual([ok.tag, ok.color, ok.href, ok.dot, ok.bang], ['a', GREEN, 'https://signal.su10.ru/folder/1-26', null, null])
      assert.match(ok.title, /^Signal: сверено 23\.11\.2026 · Альфа \/ Северный квартал \/ корп\.1 \/ ДП 1-26\nhttps:\/\/signal\.su10\.ru\/folder\/1-26$/)
      assert.equal(ok.aria, ok.title, 'подпись и для диктора')

      const suggest = await inspect(markOf(page, '2/26'))
      assert.equal(suggest.tag, 'button')
      assert.match(suggest.cls, /is-off/)
      assert.match(suggest.cls, /is-suggest/)
      assert.equal(suggest.color, RED)
      assert.equal(suggest.dot, 'rgb(37, 99, 235)', 'синяя точка в углу')
      assert.equal(suggest.title, `Signal: предложена папка ${ROOT} / корп.2 / ДП 2-26 — нажмите, чтобы сверить`)
      assert.equal(suggest.aria, suggest.title)

      for (const [number, text] of [['4/26', 'Signal: папка не видна в Signal'], ['7/26', 'Signal: файл удалён в Signal']]) {
        const warn = await inspect(markOf(page, number))
        assert.equal(warn.tag, 'button', number)
        assert.match(warn.cls, /is-warn/)
        assert.equal(warn.bang, '!', 'не только цвет: «!» в значке')
        assert.equal(warn.color, AMBER)
        assert.equal(warn.dot, null)
        assert.ok(warn.title.startsWith(`${text} — нажмите, чтобы сверить\nhttps://signal.su10.ru/folder/`), warn.title)
        assert.equal(warn.aria, warn.title)
        assert.ok(contrast(warn.color, warn.background) >= 4.5, `«!» ${warn.color} на ${warn.background}: ${contrast(warn.color, warn.background).toFixed(2)}:1`)
      }

      // Не сверена — зелёный, как сейчас; нет ссылки и предложений — красный; без метки — прежняя подпись.
      const pending = await inspect(markOf(page, '11/26'))
      assert.deepEqual([pending.tag, pending.color, pending.dot], ['a', GREEN, null])
      assert.match(pending.title, /^Signal: ссылка не сверялась — данные на 23\.11\.2026 14:00\nhttps:\/\/signal\.su10\.ru\/folder\/11-26$/)
      const none = await inspect(markOf(page, '10/26'))
      assert.deepEqual([none.tag, none.color, none.dot, none.bang], ['button', RED, null, null])
      assert.equal(none.title, 'Signal: ссылки нет — нажмите, чтобы указать')
      const plain = await inspect(markOf(page, '13/26'))
      assert.deepEqual([plain.color, plain.title, plain.dot, plain.bang], [RED, 'Ссылки на Signal нет — нажмите, чтобы указать', null, null])

      // Тёмная тема: «!» тоже читается.
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
      const dark = await inspect(markOf(page, '4/26'))
      assert.ok(contrast(dark.color, dark.background) >= 4.5, `тёмная тема: ${dark.color} на ${dark.background}`)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('окно сверки у значка: договор и папка рядом, причины плашками; «Подтвердить» пишет решение и меняет значок; Escape возвращает фокус', async () => {
    const { page, errors, close } = await open()
    try {
      assert.equal(await countOf(page), 6)
      const pop = await openReview(page, '2/26')
      assert.equal(await pop.getAttribute('role'), 'dialog')
      const left = await pop.locator('.srd-col[aria-label="Договор"]').innerText()
      assert.match(left, /№ 2\/26 от 01\.09\.2026/)
      assert.match(left, /ДП · ДС: 1/, 'у договора один ДС (ctr-3)')
      const right = await pop.locator('.srd-col[aria-label="Папка в Signal"]').innerText()
      assert.match(right, /корп\.2 \/ ДП 2-26/)
      assert.deepEqual(await pop.locator('.srd-chip').allInnerTexts(), ['номер совпал', 'корпус, очередь или секция совпали'])
      assert.equal(await pop.locator('.srd-cand').count(), 2, 'две предложенные папки — выбор')
      for (const name of ['Подтвердить', 'Другая папка…', 'Отклонить', 'Позже']) assert.equal(await btn(pop, name).count(), 1, name)
      assert.equal(await pop.locator('.srd-foot').innerText(), 'Данные Signal на 23.11.2026 14:00')

      // Escape закрывает без записи, фокус — на значке.
      await page.keyboard.press('Escape')
      await pop.waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('dlm-signal')), true, 'фокус вернулся на значок')
      assert.equal((await calls(page, /POST/)).length, 0)

      await openReview(page, '2/26')
      await btn(pop, 'Подтвердить').click()
      await pop.waitFor({ state: 'detached' })
      const [confirm] = await calls(page, /POST .*\/confirm$/)
      assert.equal(confirm.path, '/api/signal/contracts/ctr-2/confirm')
      assert.deepEqual({ ...confirm.body, idempotencyKey: UUID.test(confirm.body.idempotencyKey) }, {
        nodeId: node(2), replace: false, expectedSignalLink: null, expectedStateVersion: 1, idempotencyKey: true,
      })
      const done = await inspect(markOf(page, '2/26'))
      assert.deepEqual([done.tag, done.color, done.href, done.dot], ['a', GREEN, link(2), null])
      assert.equal((await dbContract(page, 'ctr-2')).signal_link, link(2), 'ссылка договора записана сервером')
      assert.equal(await countOf(page), 5)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('ссылка уже есть и другая: «Сейчас / Предложено», «Заменить на предложенную»; «Оставить текущую» ничего не пишет', async () => {
    const { page, errors, close } = await open()
    try {
      let pop = await openReview(page, '4/26')
      const replace = pop.locator('.srd-replace')
      assert.match(await replace.innerText(), /Сейчас\s+https:\/\/signal\.su10\.ru\/folder\/4-26\s+Альфа \/ Северный квартал \/ корп\.3 \/ ДП 4-26/)
      assert.match(await replace.innerText(), /Предложено\s+Альфа \/ Северный квартал \/ корп\.3 \/ ДП 4-26 \(новая\)/)
      assert.equal(await btn(pop, 'Подтвердить').count(), 0, 'вместо «Подтвердить» — замена')

      await btn(pop, 'Оставить текущую').click()
      assert.equal(await pop.locator('.srd-replace').count(), 0)
      assert.deepEqual(await pop.locator('.srd-chip').allInnerTexts(), ['папка не видна в Signal'])
      assert.equal((await calls(page, /POST/)).length, 0, 'оставить текущую — не решение')
      await page.keyboard.press('Escape')
      await pop.waitFor({ state: 'detached' })

      pop = await openReview(page, '4/26')
      await btn(pop, 'Заменить на предложенную').click()
      await pop.waitFor({ state: 'detached' })
      const [confirm] = await calls(page, /POST .*\/confirm$/)
      assert.deepEqual({ nodeId: confirm.body.nodeId, replace: confirm.body.replace, expectedSignalLink: confirm.body.expectedSignalLink },
        { nodeId: node(44), replace: true, expectedSignalLink: 'https://signal.su10.ru/folder/4-26' })
      const done = await inspect(markOf(page, '4/26'))
      assert.deepEqual([done.tag, done.color, done.href, done.bang], ['a', GREEN, link(44), null])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Отклонить» с причиной: пара отклонена, значок красный без точки; осталось второе предложение — окно показывает его, ключ новый', async () => {
    const { page, errors, close } = await open()
    try {
      let pop = await openReview(page, '8/26')
      await btn(pop, 'Отклонить').click()
      await pop.getByLabel('Причина (необязательно)').fill('Не та папка')
      await btn(pop, 'Отклонить предложение').click()
      await pop.waitFor({ state: 'detached' })
      const [reject] = await calls(page, /POST .*\/reject$/)
      assert.deepEqual({ ...reject.body, idempotencyKey: UUID.test(reject.body.idempotencyKey) },
        { nodeId: node(8), note: 'Не та папка', expectedStateVersion: 1, idempotencyKey: true })
      const none = await inspect(markOf(page, '8/26'))
      assert.deepEqual([none.color, none.dot], [RED, null])
      assert.equal(none.title, 'Signal: ссылки нет — нажмите, чтобы указать')
      assert.equal(await countOf(page), 5)

      // Два предложения: отклонили первое — осталось второе, подтверждается уже с новым ключом.
      pop = await openReview(page, '2/26')
      await btn(pop, 'Отклонить').click()
      await btn(pop, 'Отклонить предложение').click()
      await pop.locator('.srd-msg.is-ok', { hasText: 'Предложение отклонено — осталось другое' }).waitFor()
      assert.match(await pop.locator('.srd-col[aria-label="Папка в Signal"]').innerText(), /корп\.2 \/ Архив \/ 2-26/)
      await btn(pop, 'Подтвердить').click()
      await pop.waitFor({ state: 'detached' })
      const [r2] = (await calls(page, /POST .*ctr-2\/reject$/))
      const [c2] = (await calls(page, /POST .*ctr-2\/confirm$/))
      assert.equal(c2.body.nodeId, node(22))
      assert.equal(c2.body.expectedStateVersion, 2, 'версия после отклонения')
      assert.notEqual(c2.body.idempotencyKey, r2.body.idempotencyKey)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Другая папка…»: поиск по папкам объекта, выбранная подставляется вместо предложенной и подтверждается; «Отклонить» для неё нет', async () => {
    const { page, errors, close } = await open()
    try {
      const pop = await openReview(page, '8/26')
      await btn(pop, 'Другая папка…').click()
      const input = pop.getByLabel('Поиск папки объекта договора')
      await input.waitFor()
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('placeholder')), 'Название или путь папки', 'фокус — в поле поиска')
      assert.ok(await pop.locator('.srd-folder').count() > 2, 'пустой запрос — все папки объекта')
      await input.fill('входящие')
      await page.waitForFunction(() => document.querySelectorAll('.srd-folder').length === 2)
      assert.deepEqual((await calls(page, /GET \/api\/signal\/folders/)).map((c) => new URLSearchParams(c.query).get('contractId')).filter(Boolean).slice(-1), ['ctr-8'])
      await pop.locator('.srd-folder', { hasText: 'корп.2 / Входящие' }).click()
      assert.equal(await pop.locator('.srd-folder').count(), 0, 'поиск закрылся')
      assert.match(await pop.locator('.srd-col[aria-label="Папка в Signal"]').innerText(), /корп\.2 \/ Входящие\s+Выбрана вручную/)
      assert.equal(await btn(pop, 'Отклонить').count(), 0)
      await btn(pop, 'Подтвердить').click()
      await pop.waitFor({ state: 'detached' })
      const [confirm] = await calls(page, /POST .*\/confirm$/)
      assert.equal(confirm.body.nodeId, node(92))
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('окно устарело (другой человек изменил состояние): 409 — «Данные изменились — откройте сверку заново», данные перечитаны, повтор проходит', async () => {
    const { page, errors, close } = await open()
    try {
      const pop = await openReview(page, '2/26')
      await page.evaluate(() => window.__signal.bump('ctr-2'))
      await btn(pop, 'Подтвердить').click()
      const msg = pop.locator('.srd-msg.is-error')
      await msg.waitFor()
      assert.equal((await msg.innerText()).trim(), 'Данные изменились — откройте сверку заново')
      await page.waitForFunction(() => window.__signal.calls.filter((c) => c.path === '/api/signal/contracts/ctr-2' && c.method === 'GET').length === 2)
      assert.equal(await pop.count(), 1, 'окно осталось')
      await btn(pop, 'Подтвердить').click()
      await pop.waitFor({ state: 'detached' })
      const [first, second] = await calls(page, /POST .*\/confirm$/)
      assert.deepEqual([first.body.expectedStateVersion, second.body.expectedStateVersion], [1, 2])
      assert.equal(first.body.idempotencyKey, second.body.idempotencyKey, 'то же действие с той же папкой — тот же ключ')
      assert.equal((await dbContract(page, 'ctr-2')).signal_link, link(2))
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('ключ идемпотентности — на попытку «действие + папка»: повтор после потерянного ответа с тем же ключом, другое действие или папка — с новым', async () => {
    // Потерянный ответ: сервер решение выполнил, до страницы оно не дошло (сеть оборвалась) — окно открыто, кнопки доступны.
    const lostConfirm = async (page, pop) => {
      await page.evaluate(() => window.__signal.lose('POST .*/confirm$'))
      await btn(pop, 'Подтвердить').click()
      await pop.locator('.srd-msg.is-error').waitFor()
      assert.equal(await pop.count(), 1, 'окно осталось')
    }
    const keyOf = (c) => ({ key: c.body.idempotencyKey, node: c.body.nodeId, version: c.body.expectedStateVersion })

    // Тот же confirm по той же папке — тот же ключ, сервер отдаёт сохранённый результат, решение одно.
    let session = await open()
    try {
      const { page, errors } = session
      const pop = await openReview(page, '2/26')
      await lostConfirm(page, pop)
      await btn(pop, 'Подтвердить').click()
      await pop.waitFor({ state: 'detached' })
      const [first, second] = (await calls(page, /POST .*\/confirm$/)).map(keyOf)
      assert.ok(UUID.test(first.key))
      assert.deepEqual(second, first, 'повтор той же попытки: тот же ключ, папка и версия')
      assert.equal(await page.evaluate(() => window.__signal.state.get('ctr-2').stateVersion), 2, 'решение принято один раз')
      assert.equal((await dbContract(page, 'ctr-2')).signal_link, link(2))
      assert.equal((await inspect(markOf(page, '2/26'))).color, GREEN)
      assert.deepEqual(errors.filter((e) => !/Failed to fetch/.test(e)), [])
    } finally { await session.close() }

    // Другая папка: confirm(A) потерян, затем confirm(B) — новый ключ (сервер не вернёт чужой сохранённый ответ).
    session = await open()
    try {
      const { page } = session
      const pop = await openReview(page, '2/26')
      await lostConfirm(page, pop)
      await pop.locator('.srd-cand', { hasText: 'Архив' }).locator('input').check()
      await btn(pop, 'Подтвердить').click()
      await page.waitForFunction(() => window.__signal.calls.filter((c) => c.method === 'POST' && /\/confirm$/.test(c.path)).length === 2)
      const [a, b] = (await calls(page, /POST .*\/confirm$/)).map(keyOf)
      assert.deepEqual([a.node, b.node], [node(2), node(22)])
      assert.ok(UUID.test(b.key))
      assert.notEqual(b.key, a.key, 'другая папка — новый ключ')
    } finally { await session.close() }

    // Другое действие: confirm(A) потерян, затем reject(A) — новый ключ.
    session = await open()
    try {
      const { page } = session
      const pop = await openReview(page, '2/26')
      await lostConfirm(page, pop)
      await btn(pop, 'Отклонить').click()
      await btn(pop, 'Отклонить предложение').click()
      await page.waitForFunction(() => window.__signal.calls.some((c) => c.method === 'POST' && /\/reject$/.test(c.path)))
      const [confirm] = (await calls(page, /POST .*\/confirm$/)).map(keyOf)
      const [reject] = (await calls(page, /POST .*\/reject$/)).map(keyOf)
      assert.equal(reject.node, confirm.node)
      assert.ok(UUID.test(reject.key))
      assert.notEqual(reject.key, confirm.key, 'другое действие — новый ключ')
    } finally { await session.close() }
  })

  it('папка с флагом «папка договора ДС не определена» подтвердить нельзя: кнопки «Подтвердить» нет, плашка объясняет, остальное доступно', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('.cr-kind-tab[data-kind="amendments"]').click()
      const pop = await openReview(page, '3/26')
      assert.deepEqual(await pop.locator('.srd-chip').allInnerTexts(),
        ['номер ДС совпал', 'папка договора, к которому относится ДС, не определена — подтвердить нельзя'])
      assert.equal(await btn(pop, 'Подтвердить').count(), 0)
      assert.equal(await pop.locator('.srd-alias').count(), 0)
      for (const name of ['Другая папка…', 'Отклонить', 'Позже']) assert.equal(await btn(pop, name).count(), 1, name)
      assert.equal((await calls(page, /POST/)).length, 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('синоним: флажок «Запомнить … как название объекта» — когда у папки нет признака «объект назван»; текст уходит с подтверждением', async () => {
    const { page, errors, close } = await open()
    try {
      let pop = await openReview(page, '8/26')
      assert.equal(await pop.locator('.srd-alias').count(), 0, 'у папки есть object_name — объект уже узнан, флажка нет')
      await page.keyboard.press('Escape')
      await pop.waitFor({ state: 'detached' })

      pop = await openReview(page, '2/26')
      const check = pop.getByLabel(/Запомнить «Альфа \/ Северный квартал \/ корп\.2» как название объекта/)
      assert.equal(await check.isChecked(), false)
      await check.check()
      await pop.getByLabel('Название объекта в Signal').fill('Альфа / корп.2')
      await btn(pop, 'Подтвердить').click()
      await pop.waitFor({ state: 'detached' })
      const [confirm] = await calls(page, /POST .*\/confirm$/)
      assert.equal(confirm.body.rememberAlias, 'Альфа / корп.2')
      assert.deepEqual(await page.evaluate(() => window.__signal.aliases.map((a) => a.text)), ['Альфа / корп.2'])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без права правки «Договоров» — ни переключателя, ни окна: значок — отметка с безопасной подписью, переход по ссылке остаётся', async () => {
    for (const extra of ['&noEdit=contracts', '&signalEdit=0&noEdit=contracts']) {
      const { page, errors, close } = await open(extra, { toggle: false })
      try {
        await page.waitForFunction(() => document.querySelector('.cmarks .dlm-signal.is-suggest'))
        assert.equal(await page.locator('button.qfilter', { hasText: 'Сверка Signal' }).count(), 0, extra)
        const suggest = await inspect(markOf(page, '2/26'))
        assert.deepEqual([suggest.tag, suggest.role, suggest.dot, suggest.color], ['span', 'img', 'rgb(37, 99, 235)', RED], extra)
        assert.match(suggest.title, /^Signal: предложена папка/)
        assert.ok(!/нажмите/.test(suggest.title), 'без права — не зовём нажимать')
        const warn = await inspect(markOf(page, '4/26'))
        assert.deepEqual([warn.tag, warn.href, warn.bang], ['a', 'https://signal.su10.ru/folder/4-26', '!'], 'ссылка есть — переход, как раньше')
        await markOf(page, '2/26').click()
        assert.equal(await page.locator('.apop, .srd-modal').count(), 0, 'окна нет')
        assert.equal((await calls(page, /POST/)).length, 0)
        assert.deepEqual(errors, [], extra)
      } finally { await close() }
    }
  })

  it('сервер не отдаёт сверку (выключено, нет маршрутов): ни переключателя, ни окна, значки как раньше', async () => {
    for (const mode of ['off', 'missing']) {
      const { page, errors, close } = await open('', { base: BASE.replace('signal=1', `signal=${mode}`), toggle: false })
      try {
        await page.waitForTimeout(500)
        assert.equal(await page.locator('button.qfilter', { hasText: 'Сверка Signal' }).count(), 0, mode)
        assert.equal(await page.locator('.dlm-signal.is-suggest, .dlm-signal.is-warn, .dlm-bang').count(), 0, mode)
        const one = await inspect(markOf(page, '1/26'))
        assert.deepEqual([one.tag, one.color, one.title], ['a', GREEN, 'Signal: https://signal.su10.ru/folder/1-26'], mode)
        const two = await inspect(markOf(page, '2/26'))
        assert.deepEqual([two.tag, two.color, two.title], ['button', RED, 'Ссылки на Signal нет — нажмите, чтобы указать'], mode)
        assert.deepEqual(errors, [], mode)
      } finally { await close() }
    }
  })

  it('«Сверка Signal»: число по документам, строки до дерева — ДС с замечанием под договором, договор без замечаний один раз «ради ДС»', async () => {
    const { page, errors, close } = await open()
    try {
      const toggle = toggleOf(page)
      assert.equal(await toggle.getAttribute('aria-pressed'), 'false')
      assert.equal(await countOf(page), 6, 'ctr-2, ctr-3 (ДС), ctr-4, ctr-6 (ДС), ctr-7, ctr-8')
      const all = await page.locator('.contracts-table tbody tr.contract-row').count()
      assert.ok(all > 6)

      await toggle.click()
      assert.equal(await toggle.getAttribute('aria-pressed'), 'true')
      const rows = page.locator('.contracts-table tbody tr.contract-row')
      assert.equal(await rows.count(), 5)
      const text = await rows.allInnerTexts()
      assert.deepEqual(text.map((t) => /№ (\d+\/26)/.exec(t)[1]).sort(), ['2/26', '4/26', '5/26', '7/26', '8/26'])
      const five = text.find((t) => /№ 5\/26/.test(t))
      assert.match(five, /ДС: 1/)
      assert.match(five, /показан ради ДС/, 'сверенный ДП 5/26 — строка ради своего ДС')
      assert.equal(await page.locator('.contracts-table tr.contract-expanded-row').count(), 1, 'ради ДС раскрыт один договор — ctr-5')
      assert.match(await page.locator('.contracts-table tr.contract-expanded-row').innerText(), /№ 6\/26/)
      assert.equal(text.filter((t) => /показан ради ДС/.test(t)).length, 1, 'ради ДС показан один договор')
      assert.equal(await countOf(page), 6, 'число не меняется от самого переключателя')

      // Вид документа: договоры — 4, ДС — 2 (число — по документам этого вида).
      await page.locator('.cr-kind-tab[data-kind="contracts"]').click()
      assert.equal(await countOf(page), 4)
      assert.equal(await rows.count(), 4)
      await page.locator('.cr-kind-tab[data-kind="amendments"]').click()
      assert.equal(await countOf(page), 2)
      assert.equal(await rows.count(), 2)
      await page.locator('.cr-kind-tab[data-kind="all"]').click()

      // Другие фильтры работают как обычно; «Сбросить» снимает и этот.
      await page.locator('.cr-search').fill('4/26')
      assert.equal(await rows.count(), 1)
      await page.locator('.cr-toolbar .cr-filter-clear').click()
      assert.equal(await toggle.getAttribute('aria-pressed'), 'false')
      assert.equal(await rows.count(), all)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('телефон 390 px: переключатель и окно без прокрутки вбок; окно на весь экран, договор и папка один под другим; фокус возвращается на кнопку', async () => {
    const { page, errors, close } = await open('', { viewport: { width: 390, height: 800 }, wait: '.mcard' })
    try {
      const noScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      assert.equal(await noScroll(), true)
      assert.equal(await countOf(page), 6)
      const box = await toggleOf(page).boundingBox()
      assert.ok(box.x >= 0 && box.x + box.width <= 390, 'переключатель на экране')

      await toggleOf(page).click()
      assert.equal(await noScroll(), true)
      const cards = page.locator('.mcard')
      assert.equal(await cards.count(), 5)
      const card = page.locator('.mcard', { hasText: /№ 2\/26(?![0-9])/ })
      const open = card.locator('.dlm-card')
      assert.match(await open.innerText(), /Signal: предложена папка .* — сверить/)
      assert.ok((await open.boundingBox()).height >= 32, 'палец попадает')
      await open.click()
      const modal = page.locator('.srd-modal')
      await modal.waitFor()
      await modal.locator('.srd-grid').waitFor()
      assert.equal(await page.locator('.apop').count(), 0, 'на телефоне — самостоятельное окно, не у значка')
      const geo = await page.evaluate(() => {
        const r = document.querySelector('.srd-modal').getBoundingClientRect()
        const [a, b] = [...document.querySelectorAll('.srd-col')].map((c) => c.getBoundingClientRect())
        return { x: r.x, y: r.y, w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight, stacked: b.top >= a.bottom - 1 && Math.abs(a.left - b.left) < 2 }
      })
      assert.deepEqual([geo.x, geo.y, geo.w, geo.h], [0, 0, geo.vw, geo.vh], 'на весь экран')
      assert.equal(geo.stacked, true, 'договор и папка — один под другим')
      assert.equal(await noScroll(), true, 'с окном — тоже без прокрутки вбок')
      const buttons = await modal.locator('.srd-actions .srd-btn').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))
      assert.ok(buttons.every((h) => h >= 40), `кнопки под палец: ${buttons}`)

      await page.keyboard.press('Escape')
      await modal.waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('dlm-card')), true, 'фокус вернулся на кнопку карточки')
      assert.equal(await page.locator('.mcard-list').count(), 1, 'остались в реестре, карточка договора не открылась')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  // Форма нового договора: объект и контрагент — первые из списка, номер — свой (по нему стенд решает, что нашёл «Signal»).
  const createViaForm = async (page, number) => {
    await page.locator('.cr-header-actions button', { hasText: '+ Добавить договор' }).click()
    await page.locator('#contract-form-number').waitFor()
    await page.locator('.contract-object-picker .fdrop-trigger').click()
    await page.locator('.fdrop-panel .fdrop-option', { hasText: 'Северный квартал' }).first().click()
    await page.locator('#contract-form-number').fill(number)
    await page.locator('.cp-search-input').click()
    await page.locator('.cp-search-item').first().dispatchEvent('mousedown')
    const t0 = Date.now()
    await page.locator('.modal form button[type="submit"]').click()
    await page.waitForFunction((n) => window.__fakeDb.contracts.some((c) => c.contract_number === n), number)
    await page.locator('.modal form').waitFor({ state: 'detached' })
    return Date.now() - t0
  }

  it('после формы: «Найдена папка в Signal…» с «Сверить» и «Позже»; «Сверить» открывает окно по id у документа вне поиска, фильтры не меняются', async () => {
    const { page, errors, close } = await open()
    try {
      // Поиск оставляет в реестре один документ — новый в него не попадёт.
      await page.locator('.cr-search').fill('1/26')
      const rows = page.locator('.contracts-table tbody tr.contract-row')
      const shown = await rows.count()
      await createViaForm(page, 'ПРЕД-77')
      assert.equal(await rows.filter({ hasText: 'ПРЕД-77' }).count(), 0, 'новый документ в поиск не попал')
      const notice = page.locator('.srd-notice')
      await notice.waitFor({ timeout: 5000 })
      assert.equal(await notice.getAttribute('role'), 'status')
      const text = await notice.innerText()
      assert.match(text, /Документ сохранён/)
      assert.match(text, /Найдена папка в Signal: Альфа \/ Северный квартал \/ корп\.9 \/ ДП ПРЕД-77/)
      const [match] = await calls(page, /POST \/api\/signal\/match$/)
      assert.equal(match.body.contractIds.length, 1)
      const created = await page.evaluate(() => window.__fakeDb.contracts.find((c) => c.contract_number === 'ПРЕД-77').id)
      assert.deepEqual(match.body.contractIds, [created])

      await notice.getByRole('button', { name: 'Сверить' }).click()
      const modal = page.locator('.srd-modal')
      await modal.waitFor()
      await modal.locator('.srd-grid').waitFor()
      assert.equal(await page.locator('.apop').count(), 0, 'строки документа в таблице нет — самостоятельное окно')
      assert.match(await modal.locator('.srd-col[aria-label="Договор"]').innerText(), /№ ПРЕД-77/)
      assert.match(await modal.locator('.srd-col[aria-label="Папка в Signal"]').innerText(), /корп\.9 \/ ДП ПРЕД-77/)
      // Фильтры, вид документа и страница не тронуты.
      assert.equal(await page.locator('.cr-search').inputValue(), '1/26')
      assert.equal(await toggleOf(page).getAttribute('aria-pressed'), 'false')
      assert.equal(await page.locator('.cr-kind-tab[data-kind="all"]').getAttribute('aria-selected'), 'true')
      assert.equal(await rows.count(), shown, 'строки те же')

      // Клавиатура: Tab не уходит из окна; Escape закрывает, фокус — на «Сверить» сообщения.
      for (let i = 0; i < 12; i++) await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.srd-modal')), true, 'Tab ходит по кругу внутри окна')
      await page.keyboard.press('Escape')
      await modal.waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Сверить')
      assert.equal(await notice.count(), 1, 'сообщение осталось')

      // «Позже» убирает сообщение; метка предложения остаётся (значок у строки после снятия поиска).
      await notice.getByRole('button', { name: 'Позже' }).click()
      await notice.waitFor({ state: 'detached' })
      await page.locator('.cr-search').fill('ПРЕД-77')
      await markOf(page, 'ПРЕД-77').waitFor()
      assert.match((await inspect(markOf(page, 'ПРЕД-77'))).cls, /is-suggest/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('после подтверждения из окна по id: сообщение исчезает, фокус — в панель фильтров, ссылка договора обновлена', async () => {
    const { page, errors, close } = await open()
    try {
      await createViaForm(page, 'ПРЕД-78')
      const notice = page.locator('.srd-notice')
      await notice.waitFor({ timeout: 5000 })
      await notice.getByRole('button', { name: 'Сверить' }).click()
      const modal = page.locator('.srd-modal')
      await modal.getByRole('button', { name: 'Подтвердить', exact: true }).click()
      await modal.waitFor({ state: 'detached' })
      await notice.waitFor({ state: 'detached' })
      const row = await page.evaluate(() => window.__fakeDb.contracts.find((c) => c.contract_number === 'ПРЕД-78'))
      assert.match(row.signal_link, /^https:\/\/signal\.su10\.ru\/folder\//)
      assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.cr-toolbar')), true, 'фокус не потерян')
      await page.locator('.cr-search').fill('ПРЕД-78')
      assert.deepEqual([(await inspect(markOf(page, 'ПРЕД-78'))).tag, (await inspect(markOf(page, 'ПРЕД-78'))).href], ['a', row.signal_link])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('медленная перезагрузка меток после сохранения не затирает подтверждённую метку: значок остаётся «сверено»', async () => {
    const { page, errors, close } = await open()
    try {
      // Перезагрузка после сохранения формы: сервер считает ответ сразу (ПРЕД-79 — «предложена папка»), страница получит его позже.
      await page.evaluate(() => window.__signal.hold('GET /api/signal/marks'))
      await createViaForm(page, 'ПРЕД-79')
      const notice = page.locator('.srd-notice')
      await notice.waitFor({ timeout: 5000 })
      await page.waitForFunction(() => window.__signal.held.length === 1, null, { timeout: 5000 })
      const marksCalls = (await calls(page, /GET \/api\/signal\/marks/)).length

      // Подтверждение в окне по id — вторая перезагрузка, быстрая: в её ответе ПРЕД-79 уже «сверено».
      await notice.getByRole('button', { name: 'Сверить' }).click()
      const modal = page.locator('.srd-modal')
      await modal.getByRole('button', { name: 'Подтвердить', exact: true }).click()
      await modal.waitFor({ state: 'detached' })
      await page.waitForFunction((n) => window.__signal.calls.filter((c) => c.path === '/api/signal/marks').length > n, marksCalls, { timeout: 5000 })
      await page.locator('.cr-search').fill('ПРЕД-79')
      await markOf(page, 'ПРЕД-79').waitFor()
      await page.waitForFunction(() => /^Signal: сверено/.test(document.querySelector('.cmarks .dlm-signal')?.getAttribute('title') || ''))
      const fresh = await inspect(markOf(page, 'ПРЕД-79'))
      assert.deepEqual([fresh.tag, fresh.color, fresh.dot], ['a', GREEN, null], 'после подтверждения значок зелёный')
      assert.equal(await countOf(page), 6)

      // Старая перезагрузка дошла последней — её снимок (предложение) устарел и значок не меняет.
      await page.evaluate(() => window.__signal.release())
      await page.waitForFunction(() => window.__signal.held.every((h) => h.passed))
      await page.waitForTimeout(400)
      const after = await inspect(markOf(page, 'ПРЕД-79'))
      assert.deepEqual([after.tag, after.color, after.dot, after.href, after.title], ['a', GREEN, null, fresh.href, fresh.title], 'значок остался «сверено»')
      assert.equal(await countOf(page), 6, 'число «Сверка Signal» не вернулось к прежнему')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('после окна путей: новая ссылка сверяется, противоречие — «Signal: … — проверьте»; ничего не нашлось — без сообщения', async () => {
    const { page, errors, close } = await open()
    try {
      // Ничего: ссылка как ссылка, сервер ничего не находит.
      await markOf(page, '13/26').click()
      let pop = page.locator('.apop.dlm-pop')
      await pop.locator('.dlm-pop-input').nth(1).fill('https://signal.su10.ru/folder/13-26')
      await pop.locator('.dlm-pop-save').click()
      await pop.waitFor({ state: 'detached' })
      await page.waitForFunction(() => window.__signal.calls.some((c) => c.path === '/api/signal/match'))
      await page.waitForTimeout(300)
      assert.equal(await page.locator('.srd-notice').count(), 0)
      assert.equal((await dbContract(page, 'ctr-13')).signal_link, 'https://signal.su10.ru/folder/13-26')

      // Противоречие.
      await markOf(page, '16/26').click()
      pop = page.locator('.apop.dlm-pop')
      await pop.locator('.dlm-pop-input').nth(1).fill('https://signal.su10.ru/folder/conflict-16')
      await pop.locator('.dlm-pop-save').click()
      await pop.waitFor({ state: 'detached' })
      const notice = page.locator('.srd-notice.is-warn')
      await notice.waitFor({ timeout: 5000 })
      const text = await notice.innerText()
      assert.match(text, /Ссылка на Signal сохранена/)
      assert.match(text, /Signal: объект папки не совпадает с объектом договора — проверьте/)
      const warn = await inspect(markOf(page, '16/26'))
      assert.deepEqual([warn.bang, warn.tag], ['!', 'button'], 'значок сразу жёлтый')
      await notice.getByRole('button', { name: 'Сверить' }).click()
      const modal = page.locator('.srd-modal')
      await modal.locator('.srd-grid').waitFor()
      assert.deepEqual(await modal.locator('.srd-chip').allInnerTexts(), ['объект папки не совпадает с объектом договора'])
      assert.equal(await modal.getByRole('button', { name: 'Подтвердить', exact: true }).count(), 0, 'жёсткое противоречие не подтверждается')
      assert.equal(await modal.getByRole('button', { name: 'Другая папка…' }).count(), 1)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('сверка недоступна (503) или не отвечает: сохранение формы не задерживается, сообщений и ошибок нет', async () => {
    for (const [mode, extra] of [['down', ''], ['slow', '&signalDelay=4500']]) {
      const { page, errors, dialogs, close } = await open(extra, { base: BASE.replace('signal=1', `signal=${mode}`) })
      try {
        const saved = await createViaForm(page, `ПРЕД-${mode}`)
        assert.ok(saved < 3000, `${mode}: форма закрылась за ${saved} мс — не ждёт сверку`)
        const row = await page.evaluate((n) => window.__fakeDb.contracts.find((c) => c.contract_number === n), `ПРЕД-${mode}`)
        assert.ok(row, 'документ сохранён')
        await page.waitForFunction(() => window.__signal.calls.some((c) => c.path === '/api/signal/match'))
        // slow: ждём дольше 3 с — браузер перестаёт ждать, сообщения не будет; down — сразу отказ.
        await page.waitForTimeout(mode === 'slow' ? 3600 : 600)
        assert.equal(await page.locator('.srd-notice').count(), 0, mode)
        assert.deepEqual(dialogs, [], `${mode}: окон alert нет`)
        // Реестр жив: метки на месте.
        assert.match((await inspect(markOf(page, '2/26'))).cls, /is-suggest/, mode)
        assert.equal(await countOf(page), 6, mode)
        assert.deepEqual(errors, [], mode)
      } finally { await close() }
    }
  })
})
