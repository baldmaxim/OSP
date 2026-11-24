// «Администрирование» → «Signal» (интеграция с SIGNAL, 23.11.2026; пакет P5b). Стенд — tests/tender/ui/signal-stand.html
// (page=admin — страница «Администрирование» целиком, page=tab — только вкладка), «сервер сверки» — signal-fake.js (P5a) и
// надстройка signal-admin-fake.js, всё из памяти. Подписи и счётчики — src/utils/signalPathRow.js; сервер и база —
// tests/osp-api, tests/db. Проверяем:
//   • вкладка «Signal» — только администратору и только если сервер её отдаёт (status: enabled и isAdmin); у остальных её нет;
//   • «Подключение: настроено / не настроено», корни (проект → путь, вкл./выкл., объекты корня, обходы, ошибка), журнал прогонов
//     (дата, кто, вид, итог, папок, элементов), синонимы объектов, «Папки без объекта» у многообъектных корней;
//   • «Добавить корень»: ссылка и обязательный шаг «Объекты корня» (без объекта — предупреждение: корень закрыт), отказ сервера;
//   • «Выключить/Включить» (с подтверждением), «Объекты…», «Синхронизировать» (идёт, busy и not_configured понятным текстом),
//     «Удалить» синоним, «Связать с объектом…» — выбор только из объектов корня, «Показать ещё»;
//   • телефон 390 px — только просмотр: ни одной кнопки изменений, без прокрутки вбок.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { runOutcome, runCounts, runReasonText, runKindText, isRunning, RUN_INITIATOR_TEXT, DAY_MODE_TEXT } from '../../src/utils/signalPathRow.js'

describe('Signal в администрировании: подписи прогонов', () => {
  it('итог прогона словами: успех, идёт, отложен, сбой, отменён — с причиной', () => {
    assert.deepEqual(runOutcome({ status: 'ok' }), { tone: 'ok', text: 'успешно' })
    assert.deepEqual(runOutcome({ status: 'running' }), { tone: 'info', text: 'идёт' })
    assert.deepEqual(runOutcome({ status: 'held', reason: 'shrink' }), { tone: 'warn', text: 'отложен: данных стало заметно меньше — снимок не заменён' })
    assert.deepEqual(runOutcome({ status: 'failed', reason: 'auth' }), { tone: 'bad', text: 'сбой: ключ Signal не принят' })
    assert.deepEqual(runOutcome({ status: 'cancelled', reason: 'read_only' }), { tone: 'neutral', text: 'отменён: портал в режиме только чтения' })
    assert.equal(runOutcome({ status: 'failed', reason: 'что-то новое' }).text, 'сбой: причина не определена', 'неизвестный код — без показа кода как есть')
    assert.equal(runOutcome({ status: 'failed' }).text, 'сбой')
    assert.equal(runReasonText(null), '')
  })
  it('папок и элементов — сумма по корням из stats; нет счётчиков — null', () => {
    assert.deepEqual(runCounts({ stats: { roots: [{ id: 1, folders: 10, items: 100 }, { id: 2, folders: 5, items: 20 }] } }), { folders: 15, items: 120 })
    assert.equal(runCounts({ stats: {} }), null)
    assert.equal(runCounts({ stats: { roots: [] } }), null)
    assert.equal(runCounts({}), null)
    assert.deepEqual(runCounts({ stats: { roots: [{ id: 1, folders: 'x' }] } }), { folders: 0, items: 0 })
  })
  it('вид прогона и «кто»', () => {
    assert.equal(runKindText({ kind: 'night', mode: 'full' }), 'ночной')
    assert.equal(runKindText({ kind: 'day', mode: 'known' }), 'дневной, по известным папкам')
    assert.equal(runKindText({ kind: 'manual', mode: 'full' }), 'ручной')
    assert.deepEqual(Object.keys(RUN_INITIATOR_TEXT), ['schedule', 'cli', 'admin'])
    assert.deepEqual(Object.keys(DAY_MODE_TEXT), ['full', 'known'])
    assert.equal(isRunning([{ status: 'ok' }, { status: 'running' }]), true)
    assert.equal(isRunning([{ status: 'ok' }]), false)
  })
})

const launch = browserLaunchOptions()
const BASE = 'contracts=30&latency=0&signal=1'
const PHONE = { width: 390, height: 900 }

describe('Администрирование → Signal', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  // page: 'tab' — вкладка отдельно (ждём её), 'admin' — страница целиком (ждём вкладки страницы); extra переопределяет основу.
  async function open(extra = '', { page: kind = 'tab', viewport = { width: 1400, height: 900 } } = {}) {
    const context = await browser.newContext({ locale: 'ru-RU', timezoneId: 'Europe/Moscow', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    const query = new URLSearchParams(`${BASE}&page=${kind}`)
    for (const [k, v] of new URLSearchParams(extra)) query.set(k, v)
    await page.goto(`${stand.url.replace('index.html', 'signal-stand.html')}?${query}`)
    if (kind === 'tab') await page.locator('.sg-tab').waitFor({ timeout: 120000 })
    else if (/asRole=/.test(extra)) await page.getByText('Доступ запрещён').waitFor({ timeout: 120000 }) // страница — только администраторам
    else await page.locator('.admin-tab', { hasText: 'Пользователи' }).waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const calls = (page, filter = () => true) => page.evaluate(() => window.__signal.calls).then((all) => all.filter(filter))
  const rootRow = (page, name) => page.locator('.sg-roots tbody tr', { hasText: name })
  const toast = (page) => page.locator('.admin-toast')
  const noScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  const tabButton = (page) => page.locator('.admin-tab', { hasText: /^Signal$/ })

  it('вкладка «Signal» — администратору и только когда сервер её отдаёт: выключено, нет маршрутов, не администратор, роль — нет', async () => {
    const on = await open('', { page: 'admin' })
    try {
      await tabButton(on.page).waitFor()
      assert.equal(await tabButton(on.page).count(), 1)
      assert.ok((await calls(on.page, (c) => c.path === '/api/signal/status')).length >= 1)
      await tabButton(on.page).click()
      await on.page.locator('.sg-tab').waitFor()
      assert.match(await on.page.locator('.sg-conn').textContent(), /Подключение:\s*настроено/)
      assert.equal(await tabButton(on.page).evaluate((b) => b.classList.contains('active')), true)
      assert.deepEqual(on.errors, [])
    } finally { await on.close() }

    for (const [extra, why] of [
      ['&signal=off', 'сверка выключена'],
      ['&signal=missing', 'маршрутов нет (старый сервер)'],
      ['&sigAdmin=0', 'сервер не признал администратором'],
    ]) {
      const off = await open(extra, { page: 'admin' })
      try {
        await off.page.waitForTimeout(500) // ответ status (если он вообще уходит) успел прийти
        assert.equal(await tabButton(off.page).count(), 0, why)
        assert.deepEqual(off.errors, [], why)
      } finally { await off.close() }
    }
    // Вошёл не администратор: страница «Администрирование» закрыта целиком, о Signal сервер не спрашиваем.
    const role = await open('&asRole=engineer', { page: 'admin' })
    try {
      assert.equal(await role.page.locator('.admin-tab').count(), 0)
      assert.equal((await calls(role.page, (c) => c.path === '/api/signal/status')).length, 0)
      assert.deepEqual(role.errors, [])
    } finally { await role.close() }
    // Без стенда сервера сверки (запрос уходит на «страницу», не JSON) — вкладки тоже нет.
    const none = await open('&signal=', { page: 'admin' })
    try {
      await none.page.waitForTimeout(400)
      assert.equal(await tabButton(none.page).count(), 0)
      assert.deepEqual(none.errors, [])
    } finally { await none.close() }
  })

  it('не администратор по ответу сервера: вкладка не рисуется, админские маршруты не вызываются', async () => {
    const { page, errors, close } = await open('&sigAdmin=0')
    try {
      await page.locator('.sg-tab').waitFor()
      assert.match(await page.locator('.sg-tab').textContent(), /доступна только администратору/)
      assert.equal(await page.locator('.sg-tab button').count(), 0)
      assert.deepEqual(await calls(page, (c) => /\/(runs|aliases|sources|unassigned|sync|bindings)/.test(c.path)), [])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('подключение, корни: проект → путь, вкл./выкл., объекты корня, обходы, ошибка; корень без объекта закрыт', async () => {
    const { page, errors, close } = await open()
    try {
      assert.match(await page.locator('.sg-conn').textContent(), /Подключение:\s*настроено/)
      assert.match(await page.locator('.sg-conn').textContent(), /данные Signal на 23\.11\.2026 14:00/)
      const rows = page.locator('.sg-roots tbody tr')
      assert.equal(await rows.count(), 3)

      const alpha = rootRow(page, 'Альфа')
      assert.match(await alpha.locator('td').nth(0).textContent(), /^Альфа → Договора подряда$/)
      assert.equal((await alpha.locator('td').nth(1).textContent()).trim(), 'вкл.')
      assert.match(await alpha.locator('td').nth(2).textContent(), /ЖК «Северный квартал»/)
      assert.equal((await alpha.locator('td').nth(3).textContent()).trim(), '23.11.2026 05:12')
      assert.equal((await alpha.locator('td').nth(4).textContent()).trim(), '23.11.2026 05:12')
      assert.equal((await alpha.locator('td').nth(5).textContent()).trim(), '412 / 1300')
      assert.equal((await alpha.locator('td').nth(6).textContent()).trim(), '—')
      assert.deepEqual(await alpha.locator('button').allTextContents(), ['Выключить', 'Объекты…'])

      const beta = rootRow(page, 'Бета')
      assert.deepEqual(await beta.locator('td').nth(2).locator('.sg-chip').allTextContents(), ['ЖК «Северный квартал»', 'Бизнес-центр «Нурлы»'])

      const gamma = rootRow(page, 'Гамма')
      assert.equal((await gamma.locator('td').nth(1).textContent()).trim(), 'выкл.')
      assert.match(await gamma.locator('td').nth(2).textContent(), /нет объекта — корень закрыт для сотрудников/)
      assert.equal((await gamma.locator('td').nth(3).textContent()).trim(), 'ещё не было')
      assert.match(await gamma.locator('td').nth(6).textContent(), /папки корня нет в дереве Signal/)
      assert.deepEqual(await gamma.locator('button').allTextContents(), ['Включить', 'Объекты…'])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('не настроено: понятная подпись, «Добавить корень» закрыт; корней нет — подсказка', async () => {
    const off = await open('&sigConn=off')
    try {
      assert.match(await off.page.locator('.sg-conn').textContent(), /Подключение:\s*не настроено/)
      assert.equal(await off.page.locator('button', { hasText: 'Добавить корень' }).isDisabled(), true)
      assert.deepEqual(off.errors, [])
    } finally { await off.close() }
    const empty = await open('&sigSources=none')
    try {
      assert.match(await empty.page.locator('[aria-label="Корни"]').textContent(), /Корней пока нет/)
      assert.equal(await empty.page.locator('.sg-roots').count(), 0)
      assert.deepEqual(empty.errors, [])
    } finally { await empty.close() }
  })

  it('журнал прогонов: дата, кто, вид, итог, папок, элементов; отложен и сбой — с причиной', async () => {
    const { page, errors, close } = await open()
    try {
      const head = await page.locator('.sg-runs thead th').allTextContents()
      assert.deepEqual(head, ['Дата', 'Кто', 'Вид', 'Итог', 'Папок', 'Элементов'])
      const rows = page.locator('.sg-runs tbody tr')
      assert.equal(await rows.count(), 4)
      const cells = async (i) => (await rows.nth(i).locator('td').allTextContents()).map((t) => t.trim())
      assert.deepEqual(await cells(0), ['23.11.2026 11:00', 'по расписанию', 'дневной, по известным папкам', 'отложен: данных стало заметно меньше — снимок не заменён', '50', '1000'])
      assert.deepEqual(await cells(1), ['23.11.2026 05:00', 'по расписанию', 'ночной', 'успешно', '500', '1940'])
      assert.deepEqual(await cells(2), ['22.11.2026 13:00', 'администратор', 'ручной', 'сбой: ключ Signal не принят', '—', '—'])
      assert.deepEqual(await cells(3), ['21.11.2026 15:00', 'с сервера (консоль)', 'ручной', 'успешно', '400', '1250'])
      assert.match(await page.locator('[aria-label="Журнал прогонов"] .sg-hint').textContent(), /signal-cli accept-held/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Добавить корень»: ссылка, затем обязательный шаг «Объекты корня» с выбором нескольких объектов', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('button', { hasText: 'Добавить корень' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      assert.match(await dialog.textContent(), /Шаг 1 из 2/)
      const next = dialog.locator('button', { hasText: 'Далее' })
      assert.equal(await next.isDisabled(), true, 'без ссылки дальше нельзя')
      await dialog.locator('input').fill('http://signal.su10.ru/x')
      assert.equal(await next.isDisabled(), true, 'не https — нельзя')
      await dialog.locator('input').fill('https://signal.su10.ru/project/p1/folder/f1')
      await next.click()
      assert.match(await dialog.textContent(), /Шаг 2 из 2/)
      assert.equal(await dialog.getByRole('heading', { name: 'Объекты корня' }).count(), 1)
      assert.match(await dialog.locator('.sg-warn').textContent(), /Объект не выбран: корень будет закрыт/)
      const boxes = dialog.locator('.sg-pick-list input[type=checkbox]')
      assert.ok(await boxes.count() >= 2)
      await boxes.nth(0).check()
      await boxes.nth(1).check()
      assert.equal(await dialog.locator('.sg-warn').count(), 0, 'объекты выбраны — предупреждения нет')
      assert.match(await dialog.locator('.sg-picker .sg-hint').textContent(), /Выбрано: 2/)
      await dialog.locator('input[type=search]').fill('Нурлы')
      assert.equal(await dialog.locator('.sg-pick-list li').count(), 1, 'поиск по названию')
      await dialog.locator('button', { hasText: 'Добавить корень' }).click()
      await dialog.waitFor({ state: 'detached' })
      await toast(page).filter({ hasText: 'Корень добавлен: Дельта → Новые договоры' }).waitFor()

      const [req] = await calls(page, (c) => c.method === 'POST' && c.path === '/api/signal/sources')
      assert.equal(req.body.url, 'https://signal.su10.ru/project/p1/folder/f1')
      assert.equal(req.body.objectIds.length, 2)
      const row = rootRow(page, 'Дельта')
      await row.waitFor()
      assert.equal(await row.locator('td').nth(2).locator('.sg-chip').count(), 2)
      assert.match(await row.locator('td').nth(1).textContent(), /вкл\.\s*ждёт первого обхода/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без объекта: предупреждение, что корень будет закрыт; корень добавляется закрытым', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('button', { hasText: 'Добавить корень' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.locator('input').fill('https://signal.su10.ru/project/p1/folder/f2')
      await dialog.locator('button', { hasText: 'Далее' }).click()
      assert.match(await dialog.locator('.sg-warn').textContent(), /корень будет закрыт — сотрудники не увидят его папки и файлы/)
      await dialog.locator('button', { hasText: 'Добавить корень' }).click()
      await dialog.waitFor({ state: 'detached' })
      await toast(page).filter({ hasText: 'закрыт для сотрудников' }).waitFor()
      const [req] = await calls(page, (c) => c.method === 'POST' && c.path === '/api/signal/sources')
      assert.deepEqual(req.body.objectIds, [])
      assert.match(await rootRow(page, 'Дельта').locator('td').nth(2).textContent(), /нет объекта — корень закрыт для сотрудников/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('отказ сервера при добавлении (перекрытие, чужая ссылка, папки нет) — текст в окне, «Назад» и Escape работают', async () => {
    const { page, errors, close } = await open()
    try {
      const dialog = page.getByRole('dialog')
      const tryUrl = async (url) => {
        await dialog.locator('input').fill(url)
        await dialog.locator('button', { hasText: 'Далее' }).click()
        await dialog.locator('button', { hasText: 'Добавить корень' }).click()
        return dialog.locator('.sg-error')
      }
      await page.locator('button', { hasText: 'Добавить корень' }).click()
      assert.match(await (await tryUrl('https://signal.su10.ru/overlap')).textContent(), /пересекается с уже добавленным корнем/)
      await dialog.locator('button', { hasText: 'Назад' }).click()
      assert.match(await dialog.textContent(), /Шаг 1 из 2/)
      assert.match(await (await tryUrl('https://other.example.invalid/x')).textContent(), /Ссылка не распознана/)
      await dialog.locator('button', { hasText: 'Назад' }).click()
      assert.match(await (await tryUrl('https://signal.su10.ru/missing')).textContent(), /Папки нет в дереве проекта Signal/)
      assert.equal(await rootRow(page, 'Дельта').count(), 0, 'ничего не добавлено')
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Объекты…»: у корня без объекта — предупреждение; выбор объекта снимает его и уходит на сервер; без правки «Сохранить» закрыт', async () => {
    const { page, errors, close } = await open()
    try {
      await rootRow(page, 'Гамма').locator('button', { hasText: 'Объекты…' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      assert.match(await dialog.getByRole('heading').first().textContent(), /Объекты корня: Гамма → Архив/)
      assert.match(await dialog.locator('.sg-warn').textContent(), /корень будет закрыт/)
      const save = dialog.locator('button', { hasText: 'Сохранить' })
      assert.equal(await save.isDisabled(), true)
      await dialog.locator('.sg-pick-list input[type=checkbox]').first().check()
      assert.equal(await dialog.locator('.sg-warn').count(), 0)
      await save.click()
      await dialog.waitFor({ state: 'detached' })
      await toast(page).filter({ hasText: 'Объекты корня сохранены' }).waitFor()
      const [req] = await calls(page, (c) => c.method === 'PATCH' && c.path === '/api/signal/sources/3')
      assert.equal(req.body.objectIds.length, 1)
      assert.equal(await rootRow(page, 'Гамма').locator('td').nth(2).locator('.sg-chip').count(), 1)
      assert.doesNotMatch(await rootRow(page, 'Гамма').locator('td').nth(2).textContent(), /закрыт/)

      // Снять все объекты — снова предупреждение.
      await rootRow(page, 'Альфа').locator('button', { hasText: 'Объекты…' }).click()
      const again = page.getByRole('dialog')
      assert.equal(await again.locator('.sg-pick-list input[type=checkbox]:checked').count(), 1, 'текущий объект отмечен')
      await again.locator('.sg-pick-list input[type=checkbox]:checked').uncheck()
      assert.match(await again.locator('.sg-warn').textContent(), /корень будет закрыт/)
      await again.locator('button', { hasText: 'Отмена' }).click()
      await again.waitFor({ state: 'detached' })
      assert.equal((await calls(page, (c) => c.path === '/api/signal/sources/1')).length, 0, 'отмена — ничего не ушло')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Выключить»: подтверждение; отказ — ничего не уходит; согласие — корень выключен, кнопка «Включить»; включить — без вопросов', async () => {
    const { page, errors, close } = await open()
    try {
      const texts = []
      let accept = false
      page.on('dialog', (d) => { texts.push(d.message()); return accept ? d.accept() : d.dismiss() })
      await rootRow(page, 'Альфа').locator('button', { hasText: 'Выключить' }).click()
      assert.match(texts[0], /Выключить корень «Альфа → Договора подряда»\?/)
      assert.match(texts[0], /Сотрудники перестанут видеть его папки и файлы/)
      assert.equal((await calls(page, (c) => c.method === 'PATCH')).length, 0)
      accept = true
      await rootRow(page, 'Альфа').locator('button', { hasText: 'Выключить' }).click()
      await toast(page).filter({ hasText: 'Корень выключен' }).waitFor()
      const [req] = await calls(page, (c) => c.method === 'PATCH')
      assert.equal(req.path, '/api/signal/sources/1')
      assert.deepEqual(req.body, { enabled: false })
      const alpha = rootRow(page, 'Альфа')
      await alpha.locator('button', { hasText: 'Включить' }).waitFor()
      assert.equal((await alpha.locator('td').nth(1).textContent()).trim(), 'выкл.')
      const before = texts.length
      await alpha.locator('button', { hasText: 'Включить' }).click()
      await toast(page).filter({ hasText: 'Корень включён' }).waitFor()
      assert.equal(texts.length, before, 'включение без подтверждения')
      assert.deepEqual((await calls(page, (c) => c.method === 'PATCH')).map((c) => c.body), [{ enabled: false }, { enabled: true }])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Синхронизировать»: запускает обход, журнал показывает «идёт», кнопка занята; по завершении журнал обновляется сам', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('button', { hasText: 'Синхронизировать' }).click()
      await page.locator('.sg-runs tbody tr').first().locator('.sg-chip', { hasText: 'идёт' }).waitFor()
      assert.match(await page.locator('[aria-label="Синхронизация"] [role=status]').first().textContent(), /Обход запущен|Идёт обход/)
      const btn = page.locator('[aria-label="Синхронизация"] button')
      assert.equal(await btn.isDisabled(), true)
      assert.match(await btn.textContent(), /Обход идёт/)
      const [req] = await calls(page, (c) => c.method === 'POST' && c.path === '/api/signal/sync')
      assert.deepEqual(req.body, {})
      const first = (await page.locator('.sg-runs tbody tr').first().locator('td').allTextContents()).map((t) => t.trim())
      assert.equal(first[1], 'администратор')
      assert.equal(first[2], 'ручной')
      await page.evaluate(() => window.__signalAdmin.finishRun('ok'))
      await page.locator('.sg-runs tbody tr').first().locator('.sg-chip', { hasText: 'успешно' }).waitFor({ timeout: 15000 })
      assert.equal(await page.locator('[aria-label="Синхронизация"] button', { hasText: 'Синхронизировать' }).isDisabled(), false)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Синхронизировать»: занято (409 busy) и не настроено (409 not_configured) — понятным текстом, без ошибки на страницу', async () => {
    const busy = await open('&sigBusy=1')
    try {
      await busy.page.locator('button', { hasText: 'Синхронизировать' }).click()
      const msg = busy.page.locator('[aria-label="Синхронизация"] .sg-error')
      await msg.waitFor()
      assert.match(await msg.textContent(), /Обход уже идёт — дождитесь его завершения/)
      assert.equal(await busy.page.locator('[aria-label="Синхронизация"] button', { hasText: 'Синхронизировать' }).isDisabled(), false, 'повторить можно')
      assert.equal(await busy.page.locator('.sg-roots tbody tr').count(), 3, 'остальное на месте')
      assert.deepEqual(busy.errors, [])
    } finally { await busy.close() }
    const nc = await open('&sigSyncNc=1')
    try {
      await nc.page.locator('button', { hasText: 'Синхронизировать' }).click()
      const msg = nc.page.locator('[aria-label="Синхронизация"] .sg-error')
      await msg.waitFor()
      assert.match(await msg.textContent(), /Подключение к Signal не настроено на сервере/)
      assert.deepEqual(nc.errors, [])
    } finally { await nc.close() }
  })

  it('синонимы объектов: текст, объект, кто, когда; «Удалить» — с подтверждением', async () => {
    const { page, errors, close } = await open()
    try {
      const rows = page.locator('.sg-aliases tbody tr')
      assert.equal(await rows.count(), 1)
      assert.deepEqual((await rows.first().locator('td').allTextContents()).slice(0, 4).map((t) => t.trim()), ['Северный кв. 1', 'ЖК «Северный квартал»', 'Иванов И. И.', '20.11.2026 12:30'])
      let accept = false
      const texts = []
      page.on('dialog', (d) => { texts.push(d.message()); return accept ? d.accept() : d.dismiss() })
      await rows.first().locator('button', { hasText: 'Удалить' }).click()
      assert.match(texts[0], /Удалить название «Северный кв\. 1»\?/)
      assert.equal((await calls(page, (c) => c.method === 'DELETE')).length, 0)
      accept = true
      await rows.first().locator('button', { hasText: 'Удалить' }).click()
      await toast(page).filter({ hasText: 'Название удалено' }).waitFor()
      assert.equal((await calls(page, (c) => c.method === 'DELETE'))[0].path, '/api/signal/aliases/al-1')
      await page.locator('[aria-label="Синонимы объектов"] .sg-muted').waitFor()
      assert.equal(await page.locator('.sg-aliases').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Папки без объекта» — только у многообъектных корней; «Связать с объектом…» предлагает объекты этого корня', async () => {
    const { page, errors, close } = await open()
    try {
      const section = page.locator('[aria-label="Папки без объекта"]')
      await section.locator('tbody tr').first().waitFor()
      assert.equal(await section.locator('h5').count(), 1, 'один многообъектный корень (Бета)')
      assert.match(await section.locator('h5').textContent(), /Бета → Корпуса/)
      assert.deepEqual(await calls(page, (c) => c.path === '/api/signal/unassigned').then((l) => l.map((c) => c.query)), ['?sourceId=2&limit=50'])
      const rows = section.locator('tbody tr')
      assert.equal(await rows.count(), 3)
      assert.match(await rows.first().textContent(), /Бета \/ Корпуса \/ Паркинг 1/)
      assert.equal((await rows.first().locator('td').nth(1).textContent()).trim(), '12')

      await rows.first().locator('button', { hasText: 'Связать с объектом…' }).click()
      const select = rows.first().locator('select')
      assert.deepEqual(await select.locator('option').allTextContents(), ['Выберите объект…', 'ЖК «Северный квартал»', 'Бизнес-центр «Нурлы»'], 'только объекты корня')
      const link = rows.first().locator('button', { hasText: 'Связать' }).first()
      assert.equal(await link.isDisabled(), true, 'пока объект не выбран')
      await select.selectOption({ label: 'Бизнес-центр «Нурлы»' })
      await link.click()
      await toast(page).filter({ hasText: 'Папка связана с объектом «Бизнес-центр «Нурлы»»' }).waitFor()
      const [req] = await calls(page, (c) => c.method === 'POST' && c.path === '/api/signal/bindings')
      assert.equal(req.body.sourceId, 2)
      assert.equal(req.body.objectId, 'obj-2')
      assert.match(req.body.nodeId, /^00000000-0000-4000-8000-/)
      await page.waitForFunction(() => document.querySelectorAll('[aria-label="Папки без объекта"] tbody tr').length === 2)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Папки без объекта»: длинный список — «Показать ещё» подгружает следующую страницу; нет папок — «Все папки корня связаны»', async () => {
    const { page, errors, close } = await open('&sigUnassigned=many')
    try {
      const section = page.locator('[aria-label="Папки без объекта"]')
      await section.locator('tbody tr').first().waitFor()
      assert.equal(await section.locator('tbody tr').count(), 50)
      assert.match(await section.locator('.sg-hint').last().textContent(), /Показано папок: 50 — это не все/)
      await section.locator('button', { hasText: 'Показать ещё' }).click()
      await page.waitForFunction(() => document.querySelectorAll('[aria-label="Папки без объекта"] tbody tr').length === 75)
      assert.equal(await section.locator('button', { hasText: 'Показать ещё' }).count(), 0)
      const qs = (await calls(page, (c) => c.path === '/api/signal/unassigned')).map((c) => c.query)
      assert.deepEqual(qs, ['?sourceId=2&limit=50', '?sourceId=2&after=50&limit=50'])
      assert.deepEqual(errors, [])
    } finally { await close() }
    const { page: p2, errors: e2, close: c2 } = await open()
    try {
      const section = p2.locator('[aria-label="Папки без объекта"]')
      await section.locator('tbody tr').first().waitFor()
      for (let i = 0; i < 3; i++) {
        await section.locator('tbody tr').first().locator('button', { hasText: 'Связать с объектом…' }).click()
        await section.locator('tbody tr').first().locator('select').selectOption({ index: 1 })
        await section.locator('tbody tr').first().locator('button', { hasText: /^Связать$/ }).click()
        await p2.waitForFunction((n) => document.querySelectorAll('[aria-label="Папки без объекта"] tbody tr').length === n, 2 - i)
      }
      await section.locator('.sg-muted', { hasText: 'Все папки корня связаны с объектами' }).waitFor()
      assert.deepEqual(e2, [])
    } finally { await c2() }
  })

  it('телефон 390 px — только просмотр: состояние видно, ни одной кнопки изменений, без прокрутки вбок', async () => {
    const { page, errors, close } = await open('', { viewport: PHONE })
    try {
      assert.match(await page.locator('.sg-note').first().textContent(), /только просмотр состояния/)
      assert.match(await page.locator('.sg-conn').textContent(), /Подключение:\s*настроено/)
      assert.equal(await page.locator('.sg-roots tbody tr').count(), 3)
      assert.match(await rootRow(page, 'Гамма').textContent(), /нет объекта — корень закрыт для сотрудников/)
      assert.equal(await page.locator('.sg-runs tbody tr').count(), 4)
      assert.equal(await page.locator('.sg-aliases tbody tr').count(), 1)
      assert.equal(await page.locator('[aria-label="Папки без объекта"] tbody tr').count(), 3)
      assert.equal(await page.locator('.sg-tab button').count(), 0, 'на телефоне в содержимом вкладки нет кнопок')
      for (const label of ['Добавить корень', 'Синхронизировать', 'Выключить', 'Включить', 'Объекты…', 'Удалить', 'Связать с объектом…']) {
        assert.equal(await page.locator('button', { hasText: label }).count(), 0, label)
      }
      assert.equal(await noScroll(page), true, 'нет прокрутки вбок')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('телефон: окна изменений не открываются, страница «Администрирование» с вкладкой не раздвигается', async () => {
    const { page, errors, close } = await open('', { page: 'admin', viewport: PHONE })
    try {
      await tabButton(page).waitFor()
      await tabButton(page).click()
      await page.locator('.sg-tab').waitFor()
      assert.equal(await page.locator('.sg-tab button').count(), 0)
      assert.equal(await page.getByRole('dialog').count(), 0)
      assert.equal(await noScroll(page), true)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
