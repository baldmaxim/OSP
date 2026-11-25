// «Реестр по договорам» × SIGNAL (23.11.2026): значок Signal после сверки, окно сверки, фильтр «Сверка Signal», сообщение после
// сохранения (Р8). Сервер сверки — подмена в стенде (tests/tender/ui/signal-fake.js, ?signal=…), состояние — window.__signal.
//   • значок: красный (нет ссылки) / красный + синяя точка (предложена папка) / зелёный / жёлтый «!» (противоречие, папка или
//     файл не виден, файл удалён); «ссылка принята, номер не найден» и «папка недоступна» — зелёные, вне фильтра; подпись — в
//     title и aria-label; «!» читается (контраст ≥ 4,5:1 в обеих темах); без метки — как раньше;
//   • окно сверки у значка: подтвердить, заменить / оставить текущую, другая папка, отклонить, 409 на устаревшем окне, синоним;
//     мягкое предупреждение корпуса (подтвердить можно, ответ несёт warning); 409 hard_conflict — понятный текст, кнопка пропадает;
//     «ДС: N» без самого ДП (С-7); фокус после «Подтвердить» остаётся на значке (С-12);
//   • полоса «данные Signal устарели» (В-7), число «Сверка Signal» с фильтрами реестра (С-8), «не сверялась» сразу после правки
//     ссылки и при сбое сверки (С-9), прокрутка к сообщению Р8 (С-13);
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

describe('Реестр договоров × SIGNAL: значок, окно сверки, фильтр, сообщение после сохранения', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 1500000 }, () => {
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
      assert.match(ok.title, /^Signal: сверено · данные на 23\.11\.2026 · Альфа \/ Северный квартал \/ корп\.1 \/ ДП 1-26\nhttps:\/\/signal\.su10\.ru\/folder\/1-26$/)
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

      // Не сверена (папка недоступна для сверки) — зелёный, как сейчас; нет ссылки и предложений — красный; без метки — прежняя подпись.
      const pending = await inspect(markOf(page, '11/26'))
      assert.deepEqual([pending.tag, pending.color, pending.dot, pending.bang], ['a', GREEN, null, null])
      assert.equal(pending.title, 'Signal: папка недоступна для сверки\nhttps://signal.su10.ru/folder/11-26')
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
      assert.match(left, /ДП · ДС: 1(?!\d)/, 'у договора один ДС (ctr-3); сам ДП в «ДС: N» не входит (С-7)')
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
        nodeId: node(2), replace: false, expectedSignalLink: null, expectedStateVersion: 1, expectedRevision: 7, idempotencyKey: true,
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

  it('мягкое предупреждение корпуса (В-11): плашка «Корпус, очередь или секция не совпали — проверьте», подтвердить можно, ответ несёт warning — сообщение остаётся', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('.cr-kind-tab[data-kind="amendments"]').click()
      const pop = await openReview(page, '3/26')
      assert.deepEqual(await pop.locator('.srd-chip').allInnerTexts(), ['номер ДС совпал', 'Корпус, очередь или секция не совпали — проверьте'])
      assert.equal(await pop.locator('.srd-chip.is-warn').count(), 1, 'предупреждение — жёлтая плашка, не отказ')
      assert.equal(await btn(pop, 'Подтвердить').count(), 1, 'подтвердить можно')
      for (const name of ['Другая папка…', 'Отклонить', 'Позже']) assert.equal(await btn(pop, name).count(), 1, name)
      await btn(pop, 'Подтвердить').click()
      await pop.waitFor({ state: 'detached' })
      const [confirm] = await calls(page, /POST .*ctr-3\/confirm$/)
      assert.equal(confirm.body.nodeId, node(3))
      const notice = page.locator('.srd-notice.is-warn')
      await notice.waitFor({ timeout: 5000 })
      assert.match(await notice.innerText(), /Папка в Signal подтверждена[\s\S]*Корпус, очередь или секция не совпали — проверьте/)
      assert.equal(await notice.getByRole('button', { name: 'Сверить' }).count(), 0, 'это уведомление, а не предложение сверить')
      await notice.getByRole('button', { name: 'Понятно' }).click()
      await notice.waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('409 hard_conflict: понятный текст, окно остаётся, «Заменить» для этой папки пропадает, остальное доступно; данные не перечитываются', async () => {
    const { page, errors, close } = await open('&signalExtra=1')
    try {
      const pop = await openReview(page, '17/26')
      assert.deepEqual(await pop.locator('.srd-chip').allInnerTexts(), ['номер совпал'], 'у предложенной папки — только свои признаки')
      const before = (await calls(page, /GET \/api\/signal\/contracts\/ctr-17$/)).length
      await btn(pop, 'Заменить на предложенную').click()
      const msg = pop.locator('.srd-msg.is-error')
      await msg.waitFor()
      assert.match((await msg.innerText()).trim(), /^Папка противоречит данным договора \(номер, вид документа или организация в названии\) — подтвердить её нельзя\. Выберите другую папку\.$/)
      assert.equal(await pop.count(), 1, 'окно осталось')
      assert.equal(await btn(pop, 'Заменить на предложенную').count(), 0, 'заменять на эту папку больше нельзя')
      assert.equal(await btn(pop, 'Оставить текущую').count(), 1)
      assert.ok((await pop.locator('.srd-chip.is-bad').allInnerTexts()).some((t) => /противоречит данным договора/.test(t)))
      for (const name of ['Другая папка…', 'Отклонить', 'Позже']) assert.equal(await btn(pop, name).count(), 1, name)
      const [attempt] = await calls(page, /POST .*ctr-17\/confirm$/)
      assert.deepEqual([attempt.body.nodeId, attempt.body.replace, attempt.body.expectedRevision], [node(117), true, 7])
      assert.equal((await calls(page, /GET \/api\/signal\/contracts\/ctr-17$/)).length, before, 'это не «окно устарело» — данные не перечитываются')
      assert.equal(await page.evaluate(() => window.__fakeDb.contracts.find((c) => c.id === 'ctr-17').signal_link), 'https://signal.su10.ru/folder/17-26', 'ссылка не тронута')
      assert.deepEqual(errors.filter((e) => !/409/.test(e)), [])
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
      assert.equal(await countOf(page), 0, 'число — с поиском (С-8): подтверждённый ПРЕД-79 в «Сверке Signal» не остался')

      // Старая перезагрузка дошла последней — её снимок (предложение) устарел и значок не меняет.
      await page.evaluate(() => window.__signal.release())
      await page.waitForFunction(() => window.__signal.held.every((h) => h.passed))
      await page.waitForTimeout(400)
      const after = await inspect(markOf(page, 'ПРЕД-79'))
      assert.deepEqual([after.tag, after.color, after.dot, after.href, after.title], ['a', GREEN, null, fresh.href, fresh.title], 'значок остался «сверено»')
      assert.equal(await countOf(page), 0, 'число «Сверка Signal» не вернулось к прежнему (устаревший снимок дал бы 1)')
      await page.locator('.cr-search').fill('')
      assert.equal(await countOf(page), 6, 'без поиска — прежние шесть')
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
        // down — сервер ничего не считал (6); slow — досчитал, а страница после тайм-аута перечитала метки: новый документ предложен (7).
        assert.equal(await countOf(page), mode === 'slow' ? 7 : 6, mode)
        assert.deepEqual(errors, [], mode)
      } finally { await close() }
    }
  })

  // ── Волна исправлений: новые состояния, полоса «данные устарели», число с фильтрами, «не сверялась», фокус, прокрутка ─────────────
  it('новые состояния (spec §1): «ссылка принята» — зелёный и вне фильтра; предупреждение корпуса и вида документа, файл не виден, ДС / сторона — жёлтые; «недоступна» — зелёный', async () => {
    const { page, errors, close } = await open('&signalExtra=1')
    try {
      // Вне набора: accepted (ctr-12), unavailable (ctr-20), no_object (ctr-21); в наборе — ещё 7 (ctr-9, 14, 15, 17, 19, 22, 24) к прежним 6.
      assert.equal(await countOf(page), 13)
      await page.locator('.cr-kind-tab[data-kind="amendments"]').click()
      const accepted = await inspect(markOf(page, '12/26'))
      assert.deepEqual([accepted.tag, accepted.color, accepted.dot, accepted.bang], ['a', GREEN, null, null])
      assert.match(accepted.title, /^Signal: ссылка принята, номер в папке не найден · данные на 23\.11\.2026 · Альфа \/ Северный квартал \/ корп\.7 \/ Договоры подряда \/ Альфа\nhttps:/)
      const noObject = await inspect(markOf(page, '21/26'))
      assert.deepEqual([noObject.tag, noObject.color, noObject.bang, noObject.title], ['a', GREEN, null, 'Signal: у договора не указан объект\nhttps://signal.su10.ru/folder/21-26'])
      await page.locator('.cr-kind-tab[data-kind="contracts"]').click()
      const unavailable = await inspect(markOf(page, '20/26'))
      assert.deepEqual([unavailable.tag, unavailable.color, unavailable.bang, unavailable.title], ['a', GREEN, null, 'Signal: папка недоступна для сверки\nhttps://signal.su10.ru/folder/20-26'])
      for (const [number, text] of [
        ['14/26', 'Signal: корпус, очередь или секция не совпали — проверьте'],
        ['22/26', 'Signal: папка относится к допсоглашению — проверьте'],
        ['17/26', 'Signal: противоречие — номер в папке не совпадает'],
        ['19/26', 'Signal: противоречие — в названии папки ИНН другой организации'],
      ]) {
        const warn = await inspect(markOf(page, number))
        assert.deepEqual([warn.tag, warn.bang, warn.color], ['button', '!', AMBER], number)
        assert.ok(warn.title.startsWith(`${text} — нажмите, чтобы сверить\nhttps://signal.su10.ru/folder/`), warn.title)
        assert.equal(warn.aria, warn.title)
        assert.ok(contrast(warn.color, warn.background) >= 4.5, number)
      }
      await page.locator('.cr-kind-tab[data-kind="amendments"]').click()
      for (const [number, text] of [
        ['9/26', 'Signal: противоречие — номер ДС не совпал с номером в названии папки'],
        ['15/26', 'Signal: файл не виден в Signal'],
      ]) {
        const warn = await inspect(markOf(page, number))
        assert.deepEqual([warn.tag, warn.bang], ['button', '!'], number)
        assert.ok(warn.title.startsWith(`${text} — нажмите, чтобы сверить`), warn.title)
      }
      // Фильтр «Сверка Signal»: зелёные состояния в него не входят.
      await page.locator('.cr-kind-tab[data-kind="all"]').click()
      await toggleOf(page).click()
      const shown = await page.locator('.contracts-table tbody tr.contract-row').allInnerTexts()
      const numbers = shown.map((t) => /№ (\d+\/26)/.exec(t)[1])
      for (const out of ['12/26', '20/26', '21/26', '1/26']) assert.ok(!numbers.includes(out), `${out} вне «Сверки Signal»`)
      for (const inn of ['14/26', '17/26', '19/26', '22/26']) assert.ok(numbers.includes(inn), `${inn} в «Сверке Signal»`)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('окно: текущая папка с мягким предупреждением (корпус, допсоглашение) подтверждается без выбора; «файл не виден» и противоречия подтвердить нельзя (текст — по причине)', async () => {
    const { page, errors, close } = await open('&signalExtra=1')
    try {
      let pop = await openReview(page, '14/26')
      assert.deepEqual(await pop.locator('.srd-chip').allInnerTexts(), ['Корпус, очередь или секция не совпали — проверьте'])
      assert.match(await pop.locator('.srd-col[aria-label="Папка в Signal"]').innerText(), /корп\.9 \/ ДП 14-26/)
      await btn(pop, 'Подтвердить').click()
      await pop.waitFor({ state: 'detached' })
      const [confirm] = await calls(page, /POST .*ctr-14\/confirm$/)
      assert.deepEqual({ nodeId: confirm.body.nodeId, replace: confirm.body.replace, expectedSignalLink: confirm.body.expectedSignalLink, rev: confirm.body.expectedRevision },
        { nodeId: node(14), replace: false, expectedSignalLink: 'https://signal.su10.ru/folder/14-26', rev: 7 })
      assert.equal((await dbContract(page, 'ctr-14')).signal_link, 'https://signal.su10.ru/folder/14-26', 'ссылка та же: подтверждена текущая папка')
      const done = await inspect(markOf(page, '14/26'))
      assert.deepEqual([done.tag, done.color, done.bang], ['a', GREEN, null])
      await page.locator('.srd-notice.is-warn', { hasText: 'Корпус, очередь или секция не совпали — проверьте' }).waitFor()

      // С-41: папка допсоглашения у договора — тоже мягкое предупреждение; подтвердить можно, сообщение называет причину.
      pop = await openReview(page, '22/26')
      assert.deepEqual(await pop.locator('.srd-chip').allInnerTexts(), ['Папка относится к допсоглашению — проверьте'])
      assert.equal(await pop.locator('.srd-chip.is-warn').count(), 1)
      await btn(pop, 'Подтвердить').click()
      await pop.waitFor({ state: 'detached' })
      await page.locator('.srd-notice.is-warn', { hasText: 'Папка относится к допсоглашению — проверьте' }).waitFor()
      assert.deepEqual([(await inspect(markOf(page, '22/26'))).tag, (await inspect(markOf(page, '22/26'))).bang], ['a', null])

      // Противоречия: у 19/26 нет предложений — причина плашкой; у 17/26 выбрана предложенная папка (её признаки), текущую не подтвердить.
      pop = await openReview(page, '19/26')
      assert.deepEqual(await pop.locator('.srd-chip').allInnerTexts(), ['в названии папки ИНН другой организации'])
      assert.equal(await btn(pop, 'Подтвердить').count(), 0, 'противоречие не подтверждается')
      await page.keyboard.press('Escape')
      await pop.waitFor({ state: 'detached' })
      pop = await openReview(page, '17/26')
      assert.equal(await btn(pop, 'Подтвердить').count(), 0, 'у договора с противоречием — «Заменить», не «Подтвердить»')
      await page.keyboard.press('Escape')
      await pop.waitFor({ state: 'detached' })
      await page.locator('.cr-kind-tab[data-kind="amendments"]').click()
      pop = await openReview(page, '15/26')
      assert.deepEqual(await pop.locator('.srd-chip').allInnerTexts(), ['файл не виден в Signal'])
      assert.equal(await btn(pop, 'Подтвердить').count(), 0)
      assert.deepEqual(errors.filter((e) => !/409/.test(e)), [])
    } finally { await close() }
  })

  it('кандидат-папка допсоглашения у договора (флаг kind_mismatch): плашка «Папка допсоглашения, а не договора — проверьте», подтвердить можно, ответ несёт warning', async () => {
    const { page, errors, close } = await open('&signalExtra=1')
    try {
      await page.locator('.cr-kind-tab[data-kind="amendments"]').click()
      const pop = await openReview(page, '24/26')
      assert.deepEqual(await pop.locator('.srd-chip').allInnerTexts(), ['номер ДС совпал', 'Папка допсоглашения, а не договора — проверьте'])
      assert.equal(await pop.locator('.srd-chip.is-warn').count(), 1)
      await btn(pop, 'Подтвердить').click()
      await pop.waitFor({ state: 'detached' })
      const notice = page.locator('.srd-notice.is-warn')
      await notice.waitFor({ timeout: 5000 })
      assert.match(await notice.innerText(), /Папка в Signal подтверждена[\s\S]*Папка относится к допсоглашению — проверьте/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('полоса «Данные Signal обновлялись <дата по Москве> — сверка может быть устаревшей» (В-7): над реестром, подсказки — с датой данных, а не пересчёта', async () => {
    const stale = await open('&signalStale=1')
    try {
      const { page, errors } = stale
      const bar = page.locator('.srd-stale')
      await bar.waitFor()
      assert.equal((await bar.innerText()).trim(), 'Данные Signal обновлялись 21.11.2026 08:30 — сверка может быть устаревшей')
      assert.equal(await bar.getAttribute('role'), 'status')
      const box = await bar.boundingBox()
      const tabs = await page.locator('.cr-tabs').boundingBox()
      assert.ok(box.y + box.height <= tabs.y + 1, 'полоса — над вкладками реестра')
      assert.match((await inspect(markOf(page, '1/26'))).title, /^Signal: сверено · данные на 21\.11\.2026 · /, 'дата данных метки, не дата пересчёта')
      assert.equal(await page.evaluate(() => window.__signal.calls.find((c) => c.path === '/api/signal/marks') ? true : false), true)
      assert.deepEqual(errors, [])
    } finally { await stale.close() }

    const fresh = await open()
    try {
      assert.equal(await fresh.page.locator('.srd-stale').count(), 0, 'данные свежие — полосы нет')
      assert.deepEqual(fresh.errors, [])
    } finally { await fresh.close() }

    // Сверка выключена — полосы нет, даже если сервер по ошибке прислал stale.
    const off = await open('', { base: BASE.replace('signal=1', 'signal=off') + '&signalStale=1', toggle: false })
    try {
      await off.page.waitForTimeout(400)
      assert.equal(await off.page.locator('.srd-stale').count(), 0)
      assert.deepEqual(off.errors, [])
    } finally { await off.close() }

    // Без права правки полосу тоже видят (метки у них есть).
    const view = await open('&signalStale=1&signalEdit=0', { toggle: false })
    try {
      await view.page.locator('.srd-stale').waitFor()
      assert.deepEqual(view.errors, [])
    } finally { await view.close() }
  })

  it('число на «Сверке Signal» учитывает поиск, объект и контрагента (С-8) и равно числу документов, которые покажет реестр', async () => {
    const { page, errors, close } = await open()
    try {
      assert.equal(await countOf(page), 6)
      // Поиск по номеру: остаётся один документ — ctr-4.
      await page.locator('.cr-search').fill('4/26')
      assert.equal(await countOf(page), 1, 'поиск 4/26')
      await toggleOf(page).click()
      assert.equal(await page.locator('.contracts-table tbody tr.contract-row').count(), 1)
      assert.equal(await countOf(page), 1, 'переключатель число не меняет')
      await toggleOf(page).click()
      // Поиск по номеру ДС: договор остаётся ради ДС — в числе один ДС.
      await page.locator('.cr-search').fill('6/26')
      assert.equal(await countOf(page), 1, 'ctr-6 — ДС под ctr-5')
      await page.locator('.cr-search').fill('')
      assert.equal(await countOf(page), 6)

      // Объект: ЖК «Северный квартал» — ctr-7 и ДС ctr-6 (ради договора ctr-5); «Нурлы» — ctr-2, ctr-3 (ДС), ctr-4, ctr-8.
      const pickObject = async (name) => {
        await page.locator('.cr-toolbar .fdrop').first().locator('.fdrop-trigger').click()
        await page.locator('.fdrop-panel .fdrop-option', { hasText: name }).click()
        await page.keyboard.press('Escape')
      }
      await pickObject('Северный квартал')
      assert.equal(await countOf(page), 2, 'объект 1: ctr-7 и ДС ctr-6')
      await toggleOf(page).click()
      const text = await page.locator('.contracts-table tbody tr.contract-row').allInnerTexts()
      assert.deepEqual(text.map((t) => /№ (\d+\/26)/.exec(t)[1]).sort(), ['5/26', '7/26'])
      await toggleOf(page).click()
      await page.locator('.cr-toolbar .cr-filter-clear').click()
      await pickObject('Нурлы')
      assert.equal(await countOf(page), 4, 'объект 2: ctr-2, ctr-3 (ДС), ctr-4, ctr-8')
      await page.locator('.cr-toolbar .cr-filter-clear').click()

      // Контрагент: у ctr-4 — «Подрядчик 04».
      await page.locator('.cr-toolbar .fdrop').nth(1).locator('.fdrop-trigger').click()
      await page.locator('.fdrop-panel .fdrop-option', { hasText: 'Подрядчик 04' }).click()
      await page.keyboard.press('Escape')
      assert.equal(await countOf(page), 1, 'контрагент «Подрядчик 04»')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Сверка Signal»: число по видам «Договоры» и «ДС» после фильтра сходится с числом строк', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('.cr-search').fill('/26')
      const rows = page.locator('.contracts-table tbody tr.contract-row')
      for (const kind of ['contracts', 'amendments']) {
        await page.locator(`.cr-kind-tab[data-kind="${kind}"]`).click()
        const n = await countOf(page)
        await toggleOf(page).click()
        assert.equal(await rows.count(), n, kind)
        await toggleOf(page).click()
      }
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('окно: «ДС: N» не считает сам ДП (С-7): без ДС — просто «ДП», с тремя — «ДС: 3» (в базе у ДП root_contract_id = id)', async () => {
    const { page, errors, close } = await open('&contractsDivision=1')
    try {
      assert.equal(await page.evaluate(() => window.__fakeDb.contracts.find((c) => c.id === 'ctr-4').root_contract_id), 'ctr-4', 'сид — как в базе')
      let pop = await openReview(page, '4/26')
      assert.match(await pop.locator('.srd-col[aria-label="Договор"]').innerText(), /ДП · ID 4(?!\d)/, 'у ДП без ДС числа нет')
      assert.doesNotMatch(await pop.locator('.srd-col[aria-label="Договор"]').innerText(), /ДС:/)
      await page.keyboard.press('Escape')
      await pop.waitFor({ state: 'detached' })
      pop = await openReview(page, '2/26')
      await page.waitForFunction(() => /ДС: \d/.test(document.querySelector('.srd-col[aria-label="Договор"]')?.textContent || ''))
      assert.match(await pop.locator('.srd-col[aria-label="Договор"]').innerText(), /ДП · ДС: 3 · ID 2/, 'ctr-3, ДР-1 и 2: три ДС')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  // Окно путей: Signal — вторая строка (первая — путь к папке).
  const editSignalLink = async (page, number, value) => {
    const row = rowOf(page, number)
    // Карандаш есть, когда уже указан какой-нибудь путь; иначе — пустой значок Signal открывает то же окно.
    if (await row.locator('.dlm-edit').count()) await row.locator('.dlm-edit').click()
    else await row.locator('.dlm-signal').click()
    const pop = page.locator('.apop.dlm-pop')
    await pop.locator('.dlm-pop-input').nth(1).fill(value)
    await pop.locator('.dlm-pop-save').click()
    await pop.waitFor({ state: 'detached' })
  }

  it('правка ссылки в окне путей: значок сразу «не сверялась», до ответа сервера и при его сбое; прежнее «сверено» и «противоречие» не остаются (С-9)', async () => {
    for (const mode of ['down', 'slow']) {
      const { page, errors, dialogs, close } = await open('&signalPending=1', { base: BASE.replace('signal=1', `signal=${mode}`) })
      try {
        const before = await inspect(markOf(page, '1/26'))
        assert.match(before.title, /^Signal: сверено/, mode)
        await editSignalLink(page, '1/26', 'https://signal.su10.ru/folder/1-26-новая')
        // Сразу после сохранения — «не сверялась», без ожидания сервера.
        const pending = await inspect(markOf(page, '1/26'))
        assert.deepEqual([pending.tag, pending.color, pending.bang], ['a', GREEN, null], mode)
        assert.equal(pending.title, 'Signal: ссылка не сверялась\nhttps://signal.su10.ru/folder/1-26-новая', mode)
        assert.equal((await dbContract(page, 'ctr-1')).signal_link, 'https://signal.su10.ru/folder/1-26-новая')
        // Сверка не ответила (503 / дольше 3 с): состояние то же, метки перечитаны — и тоже «не сверялась».
        await page.waitForFunction(() => window.__signal.calls.some((c) => c.path === '/api/signal/match'))
        await page.waitForTimeout(mode === 'slow' ? 3800 : 700)
        await page.waitForFunction((n) => window.__signal.calls.filter((c) => c.path === '/api/signal/marks').length > n, 1, { timeout: 8000 })
        const after = await inspect(markOf(page, '1/26'))
        assert.doesNotMatch(after.title, /^Signal: сверено/, `${mode}: прежнее «сверено» не возвращается`)
        // down — сервер ничего не считал: остаётся «не сверялась». slow — сервер досчитал, пока страница не ждала: метки перечитаны.
        if (mode === 'down') assert.equal(after.title, pending.title, 'после сбоя сверки — всё ещё «не сверялась»')
        else assert.match(after.title, /^Signal: ссылка принята, номер в папке не найден/, 'сервер досчитал — метки показывают результат')
        assert.equal(await page.locator('.srd-notice').count(), 0, mode)
        assert.deepEqual(dialogs, [], mode)
        assert.deepEqual(errors, [], mode)
      } finally { await close() }
    }
  })

  it('правка ссылки у договора с «файл удалён»: жёлтый «!» уходит сразу, документ выходит из «Сверки Signal»; сверка ответила — новое состояние', async () => {
    const down = await open('&signalPending=1', { base: BASE.replace('signal=1', 'signal=down') })
    try {
      const { page, errors } = down
      await page.locator('.cr-kind-tab[data-kind="contracts"]').click()
      assert.equal(await countOf(page), 4)
      assert.equal((await inspect(markOf(page, '7/26'))).bang, '!')
      await editSignalLink(page, '7/26', 'https://signal.su10.ru/folder/7-26-другая')
      const pending = await inspect(markOf(page, '7/26'))
      assert.deepEqual([pending.bang, pending.color, pending.title], [null, GREEN, 'Signal: ссылка не сверялась\nhttps://signal.su10.ru/folder/7-26-другая'])
      assert.equal(await countOf(page), 3, 'ожидающий документ не в «Сверке Signal»')
      assert.deepEqual(errors, [])
    } finally { await down.close() }

    const ok = await open('&signalPending=1')
    try {
      const { page, errors } = ok
      const matches = (n) => page.waitForFunction((k) => window.__signal.calls.filter((c) => c.path === '/api/signal/match').length >= k, n, { timeout: 5000 })
      await editSignalLink(page, '5/26', 'https://signal.su10.ru/folder/5-26-conflict')
      // Сверка ответила: «conflict» в адресе — противоречие, окно сообщает.
      const notice = page.locator('.srd-notice.is-warn')
      await notice.waitFor({ timeout: 5000 })
      assert.match(await notice.innerText(), /Ссылка на Signal сохранена/)
      assert.equal((await inspect(markOf(page, '5/26'))).bang, '!')
      // Другая ссылка: номер в папке не найден — «ссылка принята», зелёный.
      await editSignalLink(page, '5/26', 'https://signal.su10.ru/folder/5-26-ok')
      await matches(2)
      await page.waitForTimeout(400)
      const accepted = await inspect(markOf(page, '5/26'))
      assert.match(accepted.title, /^Signal: ссылка принята, номер в папке не найден/)
      assert.deepEqual([accepted.bang, accepted.color], [null, GREEN])
      assert.deepEqual(errors, [])
    } finally { await ok.close() }
  })

  it('«ссылка принята, номер не найден» из ответа сверки: значок зелёный и подписан сразу, до перезагрузки меток (В-1)', async () => {
    const { page, errors, close } = await open('&signalPending=1')
    try {
      // Перезагрузку меток держим: пока она не пришла, значок живёт на метке из ответа /match, без подсказки сервера.
      await page.evaluate(() => window.__signal.hold('GET /api/signal/marks'))
      await editSignalLink(page, '5/26', 'https://signal.su10.ru/folder/5-26-принята')
      await page.waitForFunction(() => window.__signal.held.length === 1, null, { timeout: 5000 })
      const mark = await inspect(markOf(page, '5/26'))
      assert.deepEqual([mark.tag, mark.color, mark.bang, mark.dot], ['a', GREEN, null, null])
      assert.equal(mark.title, 'Signal: ссылка принята, номер в папке не найден\nhttps://signal.su10.ru/folder/5-26-принята')
      assert.equal(await page.locator('.srd-notice').count(), 0, 'принята — не повод для сообщения')
      await page.evaluate(() => window.__signal.release())
      await page.waitForFunction(() => window.__signal.held.every((h) => h.passed))
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('очистили ссылку: значок «ссылки нет» сразу; сбой сверки это не меняет', async () => {
    const { page, errors, close } = await open('&signalPending=1', { base: BASE.replace('signal=1', 'signal=down') })
    try {
      await editSignalLink(page, '1/26', '')
      const none = await inspect(markOf(page, '1/26'))
      assert.deepEqual([none.tag, none.color, none.dot], ['button', RED, null])
      assert.match(none.title, /^Signal: ссылки нет|^Ссылки на Signal нет/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('после «Подтвердить» в окне у значка фокус остаётся на значке строки (С-12); строка ушла из фильтра — фокус на панели фильтров', async () => {
    const { page, errors, close } = await open()
    try {
      // С клавиатуры: фокус на значок, Enter, к «Подтвердить», Enter.
      await markOf(page, '2/26').focus()
      await page.keyboard.press('Enter')
      const pop = page.locator('.apop.srd-pop')
      await pop.locator('.srd-grid').waitFor()
      await btn(pop, 'Подтвердить').focus()
      await page.keyboard.press('Enter')
      await pop.waitFor({ state: 'detached' })
      await page.waitForFunction(() => document.activeElement?.classList.contains('dlm-signal'), null, { timeout: 3000 })
      const focused = await page.evaluate(() => ({ row: document.activeElement.closest('tr')?.textContent || '', tag: document.activeElement.tagName.toLowerCase(), href: document.activeElement.getAttribute('href') }))
      assert.match(focused.row, /№ 2\/26(?![0-9])/, 'фокус — в строке договора 2/26')
      assert.deepEqual([focused.tag, focused.href], ['a', link(2)], 'на новом значке (ссылка вместо кнопки)')

      // Фильтр «Сверка Signal»: подтверждённый договор уходит из таблицы — фокус не пропадает в <body>.
      await toggleOf(page).click()
      await markOf(page, '8/26').focus()
      await page.keyboard.press('Enter')
      await pop.locator('.srd-grid').waitFor()
      await btn(pop, 'Подтвердить').focus()
      await page.keyboard.press('Enter')
      await pop.waitFor({ state: 'detached' })
      await page.waitForFunction(() => !!document.activeElement?.closest('.cr-toolbar'), null, { timeout: 3000 })
      assert.equal(await page.locator('.contracts-table tbody tr.contract-row', { hasText: /№ 8\/26(?![0-9])/ }).count(), 0, 'строка ушла из таблицы')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('Escape без решения возвращает фокус на значок, который остался прежним (кнопка)', async () => {
    const { page, errors, close } = await open()
    try {
      await markOf(page, '2/26').focus()
      await page.keyboard.press('Enter')
      await page.locator('.apop.srd-pop .srd-grid').waitFor()
      await page.keyboard.press('Escape')
      await page.locator('.apop.srd-pop').waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => document.activeElement?.closest('tr')?.textContent.includes('№ 2/26') && document.activeElement.classList.contains('dlm-signal')), true)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('сообщение Р8 прокручивается в видимую область, когда ссылку правят на прокрученной странице (С-13)', async () => {
    const { page, errors, close } = await open('', { base: BASE.replace('contracts=30', 'contracts=90') })
    try {
      // Договор в самом низу страницы: окно путей оставляет страницу там, а сообщение появляется под панелью фильтров — выше.
      // (Форма договора перезагружает список — «Загрузка…» сама возвращает страницу наверх, поэтому проверяем окно путей.)
      const last = page.locator('.contracts-table tbody tr.contract-row').last()
      await last.scrollIntoViewIfNeeded()
      const number = /№ (\d+\/26)/.exec(await last.innerText())[1]
      const barBottom = await page.evaluate(() => document.querySelector('.cr-toolbar').getBoundingClientRect().bottom)
      assert.ok(barBottom < 0, `панель фильтров ушла за верхний край страницы (${barBottom})`)
      await editSignalLink(page, number, 'https://signal.su10.ru/folder/last-conflict')
      const notice = page.locator('.srd-notice.is-warn')
      await notice.waitFor({ timeout: 5000 })
      assert.match(await notice.innerText(), /Ссылка на Signal сохранена/)
      await page.waitForFunction(() => {
        const r = document.querySelector('.srd-notice')?.getBoundingClientRect()
        return !!r && r.top >= 0 && r.bottom <= window.innerHeight
      }, null, { timeout: 3000 })
      assert.equal(await notice.getAttribute('role'), 'status')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('интеграция выключена (enabled: false): сохранение документа и правка ссылки — как до Signal, ни метки, ни полосы, ни запросов сверки', async () => {
    for (const mode of ['off', 'missing']) {
      const { page, errors, dialogs, close } = await open('&signalStale=1&signalPending=1', { base: BASE.replace('signal=1', `signal=${mode}`), toggle: false })
      try {
        await page.waitForTimeout(400)
        assert.equal(await page.locator('.srd-stale, .srd-notice, button.qfilter:has-text("Сверка Signal")').count(), 0, mode)
        // Правка ссылки в окне путей — просто запись поля: прежний значок «ссылка есть», подпись прежняя.
        await editSignalLink(page, '1/26', 'https://signal.su10.ru/folder/1-26-ещё')
        assert.equal((await dbContract(page, 'ctr-1')).signal_link, 'https://signal.su10.ru/folder/1-26-ещё')
        const one = await inspect(markOf(page, '1/26'))
        assert.deepEqual([one.tag, one.color, one.title, one.bang], ['a', GREEN, 'Signal: https://signal.su10.ru/folder/1-26-ещё', null], mode)
        // Новый договор формой — сохраняется, сверку не запрашивает, сообщений нет.
        await createViaForm(page, `ПРЕД-${mode}-1`)
        await page.waitForTimeout(500)
        assert.equal(await page.locator('.srd-notice').count(), 0, mode)
        const sent = await page.evaluate(() => (window.__signal?.calls || []).map((c) => `${c.method} ${c.path}`))
        assert.deepEqual(sent.filter((c) => c !== 'GET /api/signal/status'), [], `${mode}: кроме проверки «включено ли» запросов к Signal нет`)
        assert.deepEqual(dialogs, [], mode)
        assert.deepEqual(errors, [], mode)
      } finally { await close() }
    }
  })

  it('телефон 390 px: полоса «данные устарели» — на экране, компактна, без прокрутки вбок', async () => {
    const { page, errors, close } = await open('&signalStale=1', { viewport: { width: 390, height: 800 }, wait: '.mcard' })
    try {
      const bar = page.locator('.srd-stale')
      await bar.waitFor()
      const box = await bar.boundingBox()
      assert.ok(box.x >= 0 && box.x + box.width <= 390, 'полоса на экране')
      assert.ok(box.height < 120, `полоса компактна: ${box.height}`)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
