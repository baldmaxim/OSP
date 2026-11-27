// «Администрирование» → «Signal» (интеграция с SIGNAL, 23.11.2026; пакет P5b; волна исправлений 24.11.2026: В-5, В-6/К-7, В-7, В-8,
// С-2, С-48, С-50). Стенд — tests/tender/ui/signal-stand.html (page=admin — страница «Администрирование» целиком, page=tab — только
// вкладка), «сервер сверки» — signal-fake.js (P5a) и надстройка signal-admin-fake.js, всё из памяти. Подписи и счётчики —
// src/utils/signalPathRow.js; сервер и база — tests/osp-api, tests/db. Проверяем:
//   • вкладка «Signal» — администратору и только если сервер её отдаёт (status: enabled и isAdmin) либо сверка выключена по причине
//     (disabledReason: вкладка показывает только её, В-8); у остальных её нет; на ярлыке — число оповещений (В-5);
//   • «Подключение: настроено / не настроено», корни (проект → путь, вкл./выкл., объекты корня, обходы, сбой с даты, проблемные
//     подпапки), оповещения баннером, полоса свежести данных (В-7), журнал прогонов (№, дата, кто, вид, итог, папок, элементов),
//     отложенный прогон с готовой командой accept-held (С-50), зависший прогон (С-48), синонимы объектов (с отметкой конфликта);
//   • многообъектный корень (В-6, К-7, сценарий «Дельта / корп.14 / корп.22»): «Папки без объекта», дерево папок любой глубины с
//     поиском и «Показать ещё», «Привязать к объекту…» с проверкой до записи (предупреждение, число папок и файлов, подтверждение),
//     «Привязки папок» и «Снять» (папка снова без объекта);
//   • «Добавить корень»: ссылка и обязательный шаг «Объекты корня» (без объекта — предупреждение: корень закрыт), отказ сервера;
//   • «Выключить/Включить» (с подтверждением), «Объекты…», «Синхронизировать» (идёт, busy и not_configured понятным текстом),
//     «Удалить» синоним;
//   • телефон 390 px — только просмотр: ни одной кнопки изменений, без прокрутки вбок.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import * as signalText from '../../src/utils/signalPathRow.js'

// Через пространство имён: чего в модуле нет (старый код), то падает в своём тесте, а не рушит весь файл.
const {
  runOutcome, runCounts, runReasonText, runKindText, isRunning, RUN_INITIATOR_TEXT, DAY_MODE_TEXT, runningOf, stuckText, acceptHeldCommand,
  staleText, alertView, alertCount, signalTabVisible, disabledView, rootStatusChips, rootProblems, folderObjectView, bindWarningText,
  bindAffectedText, aliasesForObject,
} = signalText

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
  it('итог «частично» (часть корней не обновлена) и вытесненный прогон — по-русски, без показа кода', () => {
    assert.deepEqual(runOutcome({ status: 'partial', reason: 'root_failed' }), { tone: 'warn', text: 'частично: корень не удалось обойти' })
    assert.equal(runOutcome({ status: 'partial' }).tone, 'warn')
    assert.equal(runReasonText('superseded'), 'вытеснен более новым прогоном')
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

describe('Signal в администрировании: оповещения, зависший и отложенный прогон, причина выключения', () => {
  it('зависший прогон (С-48): status.running.stuck; без поля — по журналу; текст со временем по Москве', () => {
    const running = { runId: 13, startedAt: '2026-11-23T08:05:00.000Z', heartbeatAt: '2026-11-23T08:10:00.000Z', stuck: true }
    assert.deepEqual(runningOf({ running }, []), running)
    assert.equal(runningOf({ running: null }, [{ id: 1, status: 'running' }]), null, 'сервер сказал «нет» — журналу не верим')
    assert.deepEqual(runningOf({}, [{ id: 7, status: 'running', startedAt: '2026-11-23T08:05:00.000Z' }]), { runId: 7, startedAt: '2026-11-23T08:05:00.000Z', heartbeatAt: null, stuck: false })
    assert.equal(runningOf({}, [{ id: 7, status: 'ok' }]), null)
    assert.equal(stuckText(running), 'Прогон не отвечает с 23.11.2026 11:10; будет снят при следующем запуске')
    assert.equal(stuckText({ startedAt: '2026-11-23T08:05:00.000Z' }), 'Прогон не отвечает с 23.11.2026 11:05; будет снят при следующем запуске', 'нет heartbeat — с начала')
  })
  it('команда принятия отложенного прогона (С-50): номер и поколение — только целые числа', () => {
    assert.equal(acceptHeldCommand({ runId: 12, generation: 7 }), 'deploy.sh signal accept-held --run 12 --expected-generation 7 --reason "…"')
    assert.equal(acceptHeldCommand({ runId: '12', generation: '7' }), 'deploy.sh signal accept-held --run 12 --expected-generation 7 --reason "…"')
    for (const bad of [null, {}, { runId: 12 }, { runId: 'x; rm', generation: 7 }, { runId: 1.5, generation: 7 }, { runId: -1, generation: 7 }, { runId: 12, generation: '7 && echo' }]) {
      assert.equal(acceptHeldCommand(bad), '', JSON.stringify(bad))
    }
  })
  it('свежесть данных (В-7): «Данные Signal обновлялись <дата> — сверка может быть устаревшей»', () => {
    assert.equal(staleText('2026-11-21T05:30:00.000Z'), 'Данные Signal обновлялись 21.11.2026 08:30 — сверка может быть устаревшей')
    assert.match(staleText(null), /сверка может быть устаревшей/)
  })
  it('оповещения (В-5): сбой корня с именем, отложен, не отвечает, данные устарели; неизвестный вид — не показывается; число — на ярлык', () => {
    const sources = [{ id: 2, projectName: 'Бета', rootPath: 'Корпуса' }]
    assert.deepEqual(alertView({ kind: 'root_failed', sourceId: 2, since: '2026-11-22T02:15:00.000Z' }, sources), { tone: 'bad', text: 'Корень «Бета → Корпуса» не обновляется с 22.11.2026 05:15' })
    assert.equal(alertView({ kind: 'root_failed', sourceId: 99, since: '2026-11-22T02:15:00.000Z' }, sources).text, 'Корень не обновляется с 22.11.2026 05:15', 'корня нет в списке — без выдуманного имени')
    assert.match(alertView({ kind: 'run_held', since: '2026-11-23T08:09:00.000Z' }).text, /^Прогон отложен с 23\.11\.2026 11:09: снимок папок не заменён/)
    assert.equal(alertView({ kind: 'run_stuck', since: '2026-11-23T08:10:00.000Z' }).text, 'Прогон не отвечает с 23.11.2026 11:10; будет снят при следующем запуске')
    assert.equal(alertView({ kind: 'data_stale', since: '2026-11-21T05:30:00.000Z' }).text, 'Данные Signal не обновлялись с 21.11.2026 08:30')
    assert.equal(alertView({ kind: 'что-то новое' }), null)
    assert.equal(alertCount({ alerts: [{}, {}, {}] }), 3)
    assert.equal(alertCount({}), 0)
    assert.equal(alertCount(null), 0)
  })
  it('вкладка видна администратору: сверка включена и isAdmin, либо выключена по причине (В-8); сотруднику и пустому ответу — нет', () => {
    assert.equal(signalTabVisible({ enabled: true, isAdmin: true }), true)
    assert.equal(signalTabVisible({ enabled: true, isAdmin: false }), false)
    assert.equal(signalTabVisible({ enabled: false }), false)
    assert.equal(signalTabVisible({ enabled: false, disabledReason: 'config_invalid', configErrors: ['SIGNAL_URL_FORMATS'] }), true)
    assert.equal(signalTabVisible({ enabled: false, disabledReason: 'no_schema' }), true)
    assert.equal(signalTabVisible({ enabled: false, disabledReason: 'db_error' }), true)
    assert.equal(signalTabVisible({ enabled: false, disabledReason: 'not_enabled' }), false, 'выключено намеренно (SIGNAL_SYNC≠1) — вкладки нет')
    assert.equal(signalTabVisible({ enabled: false, disabledReason: 'что-то новое' }), false)
    assert.equal(signalTabVisible({ enabled: false, disabledReason: '' }), false, 'без причины — вкладки нет')
    assert.equal(signalTabVisible(null), false)
  })
  it('причина выключения (В-8): имена переменных SIGNAL_…, значений и чужого текста нет', () => {
    assert.equal(disabledView({ disabledReason: 'config_invalid', configErrors: ['SIGNAL_URL_FORMATS', 'SIGNAL_UI_FOLDER_URL'] }).text, 'Ошибка настройки: SIGNAL_URL_FORMATS, SIGNAL_UI_FOLDER_URL')
    const dirty = disabledView({ disabledReason: 'config_invalid', configErrors: ['SIGNAL_URL_FORMATS', 'SIGNAL_TOKEN=abc123', 'PATH', 'signal_x', '<b>SIGNAL_A</b>'] })
    assert.equal(dirty.text, 'Ошибка настройки: SIGNAL_URL_FORMATS', 'значение, чужая переменная, нижний регистр, разметка — отброшены')
    assert.equal(disabledView({ disabledReason: 'config_invalid', configErrors: [] }).text, 'Ошибка настройки')
    for (const reason of ['no_schema', 'db_error']) assert.ok(disabledView({ disabledReason: reason }).text, reason)
    assert.equal(disabledView({ disabledReason: 'not_enabled' }), null, 'выключено намеренно — причину не рисуем (вкладки нет)')
    assert.equal(disabledView({ disabledReason: 'что-то новое' }), null, 'неизвестная причина — как «просто выключено»')
    assert.equal(disabledView({}), null)
  })
  it('состояние корня: сбой с даты и причиной, отложен, число проблемных подпапок (список или число), без имён папок', () => {
    assert.deepEqual(rootStatusChips({ status: 'ok', lastError: null, problems: [] }), [])
    assert.deepEqual(rootStatusChips({ status: 'failed', failedSince: '2026-11-22T02:15:00.000Z', lastError: 'root_unavailable' }),
      [{ key: 'error', tone: 'bad', text: 'сбой с 22.11.2026: корень недоступен ключу', title: 'root_unavailable' }])
    assert.equal(rootStatusChips({ status: 'never', lastError: 'root_missing' })[0].text, 'ошибка: папки корня нет в дереве Signal')
    assert.equal(rootStatusChips({ status: 'held' })[0].text, 'отложен: снимок корня не заменён')
    const withList = rootStatusChips({ status: 'ok', problems: [{ nodeId: 'a', code: 'forbidden' }, { nodeId: 'b', code: 'forbidden' }, { nodeId: 'c', code: 'not_found' }, { nodeId: 'd', code: 'новый' }] })
    assert.equal(withList[0].text, 'проблемных подпапок: 4')
    assert.equal(withList[0].title, 'нет доступа к папке: 2; папки нет в Signal: 1; другая причина: 1')
    assert.doesNotMatch(JSON.stringify(withList), /"a"|"b"/, 'id папок в подписи не попадают')
    assert.deepEqual(rootProblems({ problems: 3 }), { count: 3, title: '' })
    assert.equal(rootProblems({ problems: 'x' }).count, 0)
    assert.equal(rootProblems({}).count, 0)
  })
  it('разметка папок (В-6): объект папки — своя привязка, унаследованный, без объекта; предупреждение и охват привязки с падежами', () => {
    assert.deepEqual(folderObjectView({ objectId: null }).text, 'без объекта')
    assert.deepEqual(folderObjectView({ objectId: 'o', objectName: 'ЖК Альфа', bound: true }), { tone: 'info', text: 'привязана: ЖК Альфа', title: 'Своя привязка папки' })
    assert.equal(folderObjectView({ objectId: 'o', objectName: 'ЖК Альфа', bound: false }).text, 'ЖК Альфа (унаследован)')
    assert.equal(bindWarningText({ objectName: 'БЦ Бета', folders: 1 }), 'Внутри папки есть номера договоров объекта БЦ Бета: 1 папка')
    assert.equal(bindWarningText({ objectName: 'БЦ Бета', folders: 3 }), 'Внутри папки есть номера договоров объекта БЦ Бета: 3 папки')
    assert.equal(bindWarningText({ objectName: 'БЦ Бета', folders: 12 }), 'Внутри папки есть номера договоров объекта БЦ Бета: 12 папок')
    assert.equal(bindAffectedText({ folders: 7, items: 38 }), 'Привязка заденет 7 папок и 38 файлов')
    assert.equal(bindAffectedText({ folders: 1, items: 1 }), 'Привязка заденет 1 папку и 1 файл')
    assert.equal(bindAffectedText({ folders: 22, items: 2 }), 'Привязка заденет 22 папки и 2 файла')
  })
  it('синонимы объекта договора (С-2): только свой объект, без пустых и без записей без id', () => {
    const items = [{ id: 'a', text: 'СК-1', objectId: 'o1' }, { id: 'b', text: 'Нурлы', objectId: 'o2' }, { id: 'c', text: '  ', objectId: 'o1' }, { text: 'без id', objectId: 'o1' }]
    assert.deepEqual(aliasesForObject(items, 'o1').map((a) => a.id), ['a'])
    assert.deepEqual(aliasesForObject(items, null), [])
    assert.deepEqual(aliasesForObject(null, 'o1'), [])
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
    const context = await browser.newContext({ locale: 'ru-RU', timezoneId: 'Europe/Moscow', viewport, permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    const query = new URLSearchParams(`${BASE}&page=${kind}`)
    for (const [k, v] of new URLSearchParams(extra)) query.set(k, v)
    await page.goto(`${stand.url.replace('index.html', 'signal-stand.html')}?${query}`)
    if (kind === 'tab') {
      await page.locator('.sg-tab').waitFor({ timeout: 120000 })
      await tabLoaded(page) // вкладка рисует «Загрузка…», пока не пришли состояние, журнал и синонимы
    }
    else if (/asRole=/.test(extra)) await page.getByText('Доступ запрещён').waitFor({ timeout: 120000 }) // страница — только администраторам
    else await page.locator('.admin-tab', { hasText: 'Пользователи' }).waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const tabLoaded = (page) => page.waitForFunction(() => {
    const text = document.querySelector('.sg-tab')?.textContent?.trim() || ''
    return text !== '' && text !== 'Загрузка…'
  })
  const calls = (page, filter = () => true) => page.evaluate(() => window.__signal.calls).then((all) => all.filter(filter))
  const rootRow = (page, name) => page.locator('.sg-roots tbody tr', { hasText: name })
  const toast = (page) => page.locator('.admin-toast')
  const noScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  const tabButton = (page) => page.locator('.admin-tab', { hasText: /^Signal/ })
  const section = (page, label) => page.locator(`[aria-label="${label}"]`)

  it('вкладка «Signal» — администратору и только когда сервер её отдаёт: выключено, нет маршрутов, не администратор, роль — нет', async () => {
    const on = await open('', { page: 'admin' })
    try {
      await tabButton(on.page).waitFor()
      assert.equal(await tabButton(on.page).count(), 1)
      assert.ok((await calls(on.page, (c) => c.path === '/api/signal/status')).length >= 1)
      await tabButton(on.page).click()
      await tabLoaded(on.page)
      assert.match(await on.page.locator('.sg-conn').textContent(), /Подключение:\s*настроено/)
      assert.equal(await tabButton(on.page).evaluate((b) => b.classList.contains('active')), true)
      assert.deepEqual(on.errors, [])
    } finally { await on.close() }

    for (const [extra, why] of [
      ['&signal=off', 'сверка выключена'],
      ['&signal=missing', 'маршрутов нет (старый сервер)'],
      ['&sigAdmin=0', 'сервер не признал администратором'],
      ['&signal=off&sigAdmin=0&sigDisabled=config_invalid', 'сверка выключена, но вошёл не администратор — причину ему не отдают'],
      ['&signal=off&sigDisabled=not_enabled', 'выключено намеренно (not_enabled) — вкладки нет, как до интеграции'],
    ]) {
      const off = await open(extra, { page: 'admin' })
      try {
        await off.page.waitForTimeout(500) // ответ status (если он вообще уходит) успел прийти
        assert.equal(await tabButton(off.page).count(), 0, why)
        assert.deepEqual(off.errors, [], why)
      } finally { await off.close() }
    }
    // В-8: сверка выключена по ошибочной причине, администратору сервер отдаёт её — вкладка видна и открывается.
    for (const reason of ['config_invalid', 'no_schema', 'db_error']) {
      const bad = await open(`&signal=off&sigDisabled=${reason}`, { page: 'admin' })
      try {
        await tabButton(bad.page).waitFor()
        assert.equal(await tabButton(bad.page).count(), 1, reason)
        assert.equal(await tabButton(bad.page).locator('.admin-tab-count').count(), 0, `${reason}: оповещений нет — отметки нет`)
        assert.deepEqual(bad.errors, [], reason)
      } finally { await bad.close() }
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
      await tabLoaded(page)
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
      assert.deepEqual(head, ['№', 'Дата', 'Кто', 'Вид', 'Итог', 'Папок', 'Элементов'])
      const rows = page.locator('.sg-runs tbody tr')
      assert.equal(await rows.count(), 4)
      const cells = async (i) => (await rows.nth(i).locator('td').allTextContents()).map((t) => t.trim())
      assert.deepEqual(await cells(0), ['12', '23.11.2026 11:00', 'по расписанию', 'дневной, по известным папкам', 'отложен: данных стало заметно меньше — снимок не заменён', '50', '1000'])
      assert.deepEqual(await cells(1), ['11', '23.11.2026 05:00', 'по расписанию', 'ночной', 'успешно', '500', '1940'])
      assert.deepEqual(await cells(2), ['10', '22.11.2026 13:00', 'администратор', 'ручной', 'сбой: ключ Signal не принят', '—', '—'])
      assert.deepEqual(await cells(3), ['9', '21.11.2026 15:00', 'с сервера (консоль)', 'ручной', 'успешно', '400', '1250'])
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
      assert.equal(first[2], 'администратор')
      assert.equal(first[3], 'ручной')
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

  it('синонимы объектов: администратору — все, конфликтующий помечен «конфликт» с пояснением (С-6)', async () => {
    const { page, errors, close } = await open('&sigAliasMore=1&sigAliasConflict=1')
    try {
      const rows = page.locator('.sg-aliases tbody tr')
      assert.equal(await rows.count(), 4, 'администратор видит чужие синонимы тоже')
      const conflict = page.locator('.sg-aliases tbody tr', { hasText: 'Нурлы корп. А' })
      assert.equal(await conflict.locator('.sg-chip', { hasText: 'конфликт' }).count(), 1)
      assert.equal(await page.locator('.sg-aliases .sg-chip', { hasText: 'конфликт' }).count(), 1, 'у остальных отметки нет')
      assert.match(await section(page, 'Синонимы объектов').locator('.sg-hint').textContent(), /при сверке оно не используется/)
      assert.deepEqual(errors, [])
    } finally { await close() }
    const calm = await open('&sigAliasMore=1')
    try {
      assert.equal(await calm.page.locator('.sg-aliases .sg-chip', { hasText: 'конфликт' }).count(), 0, 'без конфликта отметки нет')
      assert.equal(await section(calm.page, 'Синонимы объектов').locator('.sg-hint').count(), 0)
    } finally { await calm.close() }
  })

  it('«Папки без объекта» — только у многообъектных корней; «Привязать к объекту…» предлагает объекты этого корня', async () => {
    const { page, errors, close } = await open()
    try {
      const unassigned = section(page, 'Папки без объекта')
      await unassigned.locator('tbody tr').first().waitFor()
      assert.equal(await unassigned.locator('h5').count(), 1, 'один многообъектный корень (Бета)')
      assert.match(await unassigned.locator('h5').textContent(), /Бета → Корпуса/)
      assert.deepEqual(await calls(page, (c) => c.path === '/api/signal/unassigned').then((l) => l.map((c) => c.query)), ['?sourceId=2&limit=50'])
      const rows = unassigned.locator('tbody tr')
      assert.equal(await rows.count(), 3)
      assert.match(await rows.first().textContent(), /Бета \/ Корпуса \/ Дельта/)
      assert.match(await rows.nth(1).textContent(), /Бета \/ Корпуса \/ Паркинг 1/)
      assert.equal((await rows.nth(1).locator('td').nth(1).textContent()).trim(), '12')

      await rows.nth(1).locator('button', { hasText: 'Привязать к объекту…' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      assert.match(await dialog.locator('.sg-path').textContent(), /^Бета \/ Корпуса \/ Паркинг 1$/)
      const select = dialog.locator('select')
      assert.deepEqual(await select.locator('option').allTextContents(), ['Выберите объект…', 'ЖК «Северный квартал»', 'Бизнес-центр «Нурлы»'], 'только объекты корня')
      const bindBtn = dialog.locator('button', { hasText: /^Привязать$/ })
      assert.equal(await bindBtn.isDisabled(), true, 'пока объект не выбран')
      await select.selectOption({ label: 'Бизнес-центр «Нурлы»' })
      await bindBtn.click()
      await toast(page).filter({ hasText: 'Папка привязана к объекту «Бизнес-центр «Нурлы»»' }).waitFor()
      await dialog.waitFor({ state: 'detached' })
      const reqs = await calls(page, (c) => c.method === 'POST' && /bindings/.test(c.path))
      assert.deepEqual(reqs.map((c) => c.path), ['/api/signal/bindings/preview', '/api/signal/bindings'], 'сначала проверка, потом запись')
      assert.equal(reqs[1].body.sourceId, 2)
      assert.equal(reqs[1].body.objectId, 'obj-2')
      assert.match(reqs[1].body.nodeId, /^00000000-0000-4000-8000-/)
      assert.deepEqual(reqs[0].body, reqs[1].body, 'проверяется ровно то, что потом записывается')
      await page.waitForFunction(() => document.querySelectorAll('[aria-label="Папки без объекта"] tbody tr').length === 2)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Папки без объекта»: длинный список — «Показать ещё» подгружает следующую страницу; нет папок — «Все папки корня связаны»', async () => {
    const { page, errors, close } = await open('&sigUnassigned=many')
    try {
      const unassigned = section(page, 'Папки без объекта')
      await unassigned.locator('tbody tr').first().waitFor()
      assert.equal(await unassigned.locator('tbody tr').count(), 50)
      assert.match(await unassigned.locator('.sg-hint').last().textContent(), /Показано папок: 50 — это не все/)
      await unassigned.locator('button', { hasText: 'Показать ещё' }).click()
      await page.waitForFunction(() => document.querySelectorAll('[aria-label="Папки без объекта"] tbody tr').length === 75)
      assert.equal(await unassigned.locator('button', { hasText: 'Показать ещё' }).count(), 0)
      const qs = (await calls(page, (c) => c.path === '/api/signal/unassigned')).map((c) => c.query)
      assert.deepEqual(qs, ['?sourceId=2&limit=50', '?sourceId=2&after=50&limit=50'])
      assert.deepEqual(errors, [])
    } finally { await close() }
    const { page: p2, errors: e2, close: c2 } = await open()
    try {
      const unassigned = section(p2, 'Папки без объекта')
      await unassigned.locator('tbody tr').first().waitFor()
      for (let i = 0; i < 3; i++) {
        await bindFirst(p2, unassigned, 2 - i)
      }
      await unassigned.locator('.sg-muted', { hasText: 'Все папки корня связаны с объектами' }).waitFor()
      assert.deepEqual(e2, [])
    } finally { await c2() }
  })

  // Первую строку «Папок без объекта» — к первому объекту корня; предупреждение (если есть) подтверждается; ждём, пока строк станет left.
  async function bindFirst(page, unassigned, left) {
    await unassigned.locator('tbody tr').first().locator('button', { hasText: 'Привязать к объекту…' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('select').selectOption({ index: 1 })
    await dialog.locator('button', { hasText: /^Привязать$/ }).click()
    const all = dialog.locator('button', { hasText: 'Привязать всё равно' })
    await Promise.race([all.waitFor(), dialog.waitFor({ state: 'detached' })])
    if (await all.count()) await all.click()
    await page.waitForFunction((n) => document.querySelectorAll('[aria-label="Папки без объекта"] tbody tr').length === n, left)
  }

  // ── В-6, К-7: дерево папок любой глубины (сценарий судьи «Дельта / корп.14 / корп.22») ────────────────────────────────────────────
  const treeBox = (page) => section(page, 'Дерево папок')
  // Строка папки (не её раскрытые дети): у строки собственное название — прямой потомок.
  const treeRow = (page, name) => treeBox(page).locator('.sg-tree-row', { has: page.locator(':scope > .sg-tree-name', { hasText: new RegExp(`^${name}$`) }) }).first()
  const expand = (page, name) => treeRow(page, name).locator('.sg-tree-toggle').click()
  const objectChip = (page, name) => treeRow(page, name).locator('.sg-chip')
  const treeCalls = (page) => calls(page, (c) => c.path === '/api/signal/tree').then((l) => l.map((c) => decodeURIComponent(c.query)))

  it('дерево: папки любой глубины раскрываются по клику отдельным запросом, у папки — объект (без объекта / привязана / унаследован)', async () => {
    const { page, errors, close } = await open('&sigBound=1')
    try {
      await treeBox(page).locator('.sg-tree-item').first().waitFor()
      assert.deepEqual(await treeBox(page).locator('.sg-tree-box > .sg-tree > .sg-tree-item > .sg-tree-row .sg-tree-name').allTextContents(), ['Дельта', 'Паркинг 1', 'Паркинг 2'])
      assert.equal((await objectChip(page, 'Дельта').textContent()).trim(), 'без объекта')
      assert.equal(await treeRow(page, 'Паркинг 1').locator('.sg-tree-toggle').count(), 0, 'у папки без вложенных — раскрывать нечего')
      assert.deepEqual(await treeCalls(page), ['?sourceId=2'], 'корень — одним запросом, без детей')

      await expand(page, 'Дельта')
      await treeRow(page, 'корп.22').waitFor()
      assert.match((await treeCalls(page)).at(-1), /^\?sourceId=2&parentId=00000000-0000-4000-8000-000000006000$/)
      assert.deepEqual(await treeBox(page).locator('.sg-tree-kids .sg-tree-row .sg-tree-name').allTextContents(), ['корп.14', 'корп.22', 'Общие документы'])
      assert.equal((await objectChip(page, 'корп.14').textContent()).trim(), 'привязана: ЖК «Северный квартал»', 'своя привязка')
      assert.equal((await objectChip(page, 'корп.22').textContent()).trim(), 'привязана: Бизнес-центр «Нурлы»')
      assert.equal((await objectChip(page, 'Общие документы').textContent()).trim(), 'без объекта', 'рядом с привязанными — без объекта')

      // Глубже: Дельта → корп.22 → Договоры → Приложения; объект унаследован от привязки корп.22.
      await expand(page, 'корп.22')
      await treeRow(page, 'Договоры').waitFor()
      assert.equal((await objectChip(page, 'Договоры').textContent()).trim(), 'Бизнес-центр «Нурлы» (унаследован)')
      await expand(page, 'Договоры')
      await treeRow(page, 'Приложения').waitFor()
      assert.equal((await objectChip(page, 'Приложения').textContent()).trim(), 'Бизнес-центр «Нурлы» (унаследован)')
      assert.equal(await treeBox(page).locator('.sg-tree-item[data-node]').count(), 3 + 3 + 1 + 1 + 0, 'три верхних, три в Дельте, Договоры и Приложения')

      // Свернули и раскрыли снова — из памяти, без нового запроса.
      const before = (await treeCalls(page)).length
      await expand(page, 'Дельта')
      assert.equal(await treeRow(page, 'корп.22').count(), 0, 'свёрнуто')
      await expand(page, 'Дельта')
      await treeRow(page, 'корп.22').waitFor()
      assert.equal((await treeCalls(page)).length, before, 'повторно не запрашивали')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('дерево: поиск по всему корню — плоский список с полными путями; «Показать ещё» по курсору; очистка возвращает дерево', async () => {
    const { page, errors, close } = await open()
    try {
      const box = treeBox(page)
      await box.locator('.sg-tree-item').first().waitFor()
      await box.locator('input[type=search]').fill('приложения')
      const found = box.locator('.sg-found')
      await found.locator('.sg-tree-item').first().waitFor()
      assert.deepEqual(await found.locator('.sg-tree-path').allTextContents(), ['Бета / Корпуса / Дельта / корп.22 / Договоры / Приложения'], 'папка на глубине четыре найдена')
      assert.match((await treeCalls(page)).at(-1), /^\?sourceId=2&q=приложения$/)
      assert.equal(await found.locator('.sg-tree-toggle').count(), 0, 'поиск — плоский список')
      assert.equal((await found.locator('.sg-chip').textContent()).trim(), 'без объекта')
      await box.locator('input[type=search]').fill('нет такой папки')
      await found.locator('.sg-muted', { hasText: 'Папок с таким названием не нашлось' }).waitFor()
      await box.locator('input[type=search]').fill('')
      await box.locator('.sg-tree-box > .sg-tree').waitFor()
      assert.equal(await found.count(), 0, 'поиск очищен — снова дерево')
      assert.deepEqual(errors, [])
    } finally { await close() }
    const many = await open('&sigUnassigned=many')
    try {
      const box = treeBox(many.page)
      await box.locator('.sg-tree-item').first().waitFor()
      assert.equal(await box.locator('.sg-tree-box > .sg-tree > .sg-tree-item').count(), 50, 'первая страница корня')
      await box.locator('.sg-tree-more').click()
      await many.page.waitForFunction(() => document.querySelectorAll('[aria-label="Дерево папок"] .sg-tree-box > .sg-tree > .sg-tree-item').length === 75)
      assert.equal(await box.locator('.sg-tree-more').count(), 0)
      assert.deepEqual((await treeCalls(many.page)), ['?sourceId=2', '?sourceId=2&after=50'])
      await box.locator('input[type=search]').fill('парк')
      await box.locator('.sg-found .sg-tree-item').first().waitFor()
      await many.page.waitForFunction(() => document.querySelectorAll('[aria-label="Дерево папок"] .sg-found .sg-tree-item').length === 50)
      await box.locator('.sg-found .sg-tree-more').click()
      await many.page.waitForFunction(() => document.querySelectorAll('[aria-label="Дерево папок"] .sg-found .sg-tree-item').length === 75)
      assert.deepEqual((await treeCalls(many.page)).slice(2), ['?sourceId=2&q=парк', '?sourceId=2&q=парк&after=50'])
      assert.deepEqual(many.errors, [])
    } finally { await many.close() }
  })

  it('привязка вложенной папки без чужих номеров: проверка, затем запись сразу; корп.14 → объект 1, дети наследуют, Дельта остаётся без объекта', async () => {
    const { page, errors, close } = await open()
    try {
      await expand(page, 'Дельта')
      await treeRow(page, 'корп.14').waitFor()
      await treeRow(page, 'корп.14').locator('button', { hasText: 'Привязать к объекту…' }).click()
      const dialog = page.getByRole('dialog')
      assert.match(await dialog.locator('.sg-path').textContent(), /^Бета \/ Корпуса \/ Дельта \/ корп\.14$/)
      await dialog.locator('select').selectOption({ label: 'ЖК «Северный квартал»' })
      await dialog.locator('button', { hasText: /^Привязать$/ }).click()
      await toast(page).filter({ hasText: 'Папка привязана к объекту «ЖК «Северный квартал»»' }).waitFor()
      assert.equal(await dialog.count(), 0)
      assert.deepEqual((await calls(page, (c) => c.method === 'POST')).map((c) => c.path), ['/api/signal/bindings/preview', '/api/signal/bindings'])
      // Дерево перечитано: раскрытая «Дельта» осталась раскрытой, у корп.14 — своя привязка, у Дельты объекта по-прежнему нет.
      await page.waitForFunction(() => /привязана: ЖК/.test(document.querySelector('[aria-label="Дерево папок"] .sg-tree-kids')?.textContent || ''))
      assert.equal((await objectChip(page, 'корп.14').textContent()).trim(), 'привязана: ЖК «Северный квартал»')
      assert.equal((await objectChip(page, 'Дельта').textContent()).trim(), 'без объекта')
      await expand(page, 'корп.14')
      await treeRow(page, 'Договоры').waitFor()
      assert.equal((await objectChip(page, 'Договоры').textContent()).trim(), 'ЖК «Северный квартал» (унаследован)')
      // Список привязок и «Папки без объекта»: Дельта всё ещё без объекта (её договоры не сверяются), три верхних папки на месте.
      await page.waitForFunction(() => document.querySelectorAll('[aria-label="Привязки папок"] tbody tr').length === 1)
      assert.match(await section(page, 'Привязки папок').locator('tbody tr').textContent(), /Бета \/ Корпуса \/ Дельта \/ корп\.14\s*ЖК «Северный квартал»/)
      assert.equal(await section(page, 'Папки без объекта').locator('tbody tr').count(), 3)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('привязка верхней папки «Дельта» к объекту, когда внутри номера другого: предупреждение с числом папок и охватом, «Назад», «Отмена» — ничего не пишется; подтверждение — привязка', async () => {
    const { page, errors, close } = await open()
    try {
      await treeRow(page, 'Дельта').locator('button', { hasText: 'Привязать к объекту…' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.locator('select').selectOption({ label: 'ЖК «Северный квартал»' })
      await dialog.locator('button', { hasText: /^Привязать$/ }).click()
      const warn = dialog.locator('.sg-warn')
      await warn.waitFor()
      assert.match(await warn.textContent(), /Внутри папки есть номера договоров объекта Бизнес-центр «Нурлы»: 1 папка/)
      assert.match(await warn.textContent(), /Привязка заденет 7 папок и 38 файлов/, 'сколько папок и файлов затронет')
      assert.match(await warn.textContent(), /сотрудники объекта «ЖК «Северный квартал»» увидят их папки и файлы/)
      assert.equal(await dialog.locator('button', { hasText: 'Привязать всё равно' }).count(), 1)
      assert.deepEqual((await calls(page, (c) => c.method === 'POST')).map((c) => c.path), ['/api/signal/bindings/preview'], 'до подтверждения запись не уходит')

      await dialog.locator('button', { hasText: 'Назад' }).click()
      assert.equal(await dialog.locator('.sg-warn').count(), 0)
      assert.equal(await dialog.locator('select').inputValue(), 'obj-1', 'выбор объекта сохранён')
      await dialog.locator('button', { hasText: /^Привязать$/ }).click()
      await dialog.locator('.sg-warn').waitFor()
      await dialog.locator('button', { hasText: 'Отмена' }).click()
      await dialog.waitFor({ state: 'detached' })
      assert.deepEqual((await calls(page, (c) => c.method === 'POST' && c.path === '/api/signal/bindings')), [], 'отмена — привязки нет')
      assert.equal((await objectChip(page, 'Дельта').textContent()).trim(), 'без объекта')

      // Подтверждение — привязка.
      await treeRow(page, 'Дельта').locator('button', { hasText: 'Привязать к объекту…' }).click()
      await dialog.locator('select').selectOption({ label: 'ЖК «Северный квартал»' })
      await dialog.locator('button', { hasText: /^Привязать$/ }).click()
      await dialog.locator('button', { hasText: 'Привязать всё равно' }).click()
      await toast(page).filter({ hasText: 'Папка привязана к объекту «ЖК «Северный квартал»»' }).waitFor()
      const [bind] = await calls(page, (c) => c.method === 'POST' && c.path === '/api/signal/bindings')
      assert.deepEqual([bind.body.sourceId, bind.body.objectId], [2, 'obj-1'])
      await page.waitForFunction(() => document.querySelectorAll('[aria-label="Папки без объекта"] tbody tr').length === 2)
      assert.equal((await objectChip(page, 'Дельта').textContent()).trim(), 'привязана: ЖК «Северный квартал»')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('привязка: отказ проверки и отказ записи — текст в окне, ничего не привязано, окно не закрывается', async () => {
    const pf = await open('&sigPreviewFail=1')
    try {
      await treeRow(pf.page, 'Паркинг 1').locator('button', { hasText: 'Привязать к объекту…' }).click()
      const dialog = pf.page.getByRole('dialog')
      await dialog.locator('select').selectOption({ index: 1 })
      await dialog.locator('button', { hasText: /^Привязать$/ }).click()
      await dialog.locator('.sg-error').waitFor()
      assert.match(await dialog.locator('.sg-error').textContent(), /Проверка привязки временно недоступна/)
      assert.deepEqual((await calls(pf.page, (c) => c.method === 'POST' && c.path === '/api/signal/bindings')), [], 'без проверки не пишем')
      assert.equal(await dialog.locator('button', { hasText: /^Привязать$/ }).isEnabled(), true, 'повторить можно')
      assert.deepEqual(pf.errors, [])
    } finally { await pf.close() }
    const bf = await open('&sigBindFail=1')
    try {
      await treeRow(bf.page, 'Паркинг 1').locator('button', { hasText: 'Привязать к объекту…' }).click()
      const dialog = bf.page.getByRole('dialog')
      await dialog.locator('select').selectOption({ index: 1 })
      await dialog.locator('button', { hasText: /^Привязать$/ }).click()
      await dialog.locator('.sg-error').waitFor()
      assert.match(await dialog.locator('.sg-error').textContent(), /Корень сейчас обновляется/)
      assert.equal(await bf.page.getByRole('dialog').count(), 1)
      assert.equal(await toast(bf.page).count(), 0, 'привязано не было')
      assert.equal((await objectChip(bf.page, 'Паркинг 1').textContent()).trim(), 'без объекта')
      await bf.page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      assert.deepEqual(bf.errors, [])
    } finally { await bf.close() }
  })

  it('привязки корня: список с папкой, объектом и датой; «Снять» — с подтверждением; после «Снять» папка снова в «Папках без объекта»', async () => {
    const { page, errors, close } = await open('&sigBound=1')
    try {
      const bindings = section(page, 'Привязки папок')
      const rows = bindings.locator('tbody tr')
      await rows.first().waitFor()
      assert.equal(await rows.count(), 2)
      assert.deepEqual((await rows.first().locator('td').allTextContents()).slice(0, 3).map((t) => t.trim()), ['Бета / Корпуса / Дельта / корп.14', 'ЖК «Северный квартал»', '22.11.2026'])
      assert.deepEqual(await calls(page, (c) => c.path === '/api/signal/bindings').then((l) => l.map((c) => c.query)), ['?sourceId=2'])

      // Верхняя папка: привяжем «Паркинг 1» и снимем — она возвращается в «Папки без объекта».
      await treeRow(page, 'Паркинг 1').locator('button', { hasText: 'Привязать к объекту…' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.locator('select').selectOption({ label: 'Бизнес-центр «Нурлы»' })
      await dialog.locator('button', { hasText: /^Привязать$/ }).click()
      await dialog.waitFor({ state: 'detached' })
      await page.waitForFunction(() => document.querySelectorAll('[aria-label="Привязки папок"] tbody tr').length === 3)
      assert.equal(await section(page, 'Папки без объекта').locator('tbody tr').count(), 2, 'Паркинг 1 больше не «без объекта»')

      const texts = []
      let accept = false
      page.on('dialog', (d) => { texts.push(d.message()); return accept ? d.accept() : d.dismiss() })
      const parking = bindings.locator('tbody tr', { hasText: 'Паркинг 1' })
      await parking.locator('button', { hasText: 'Снять' }).click()
      assert.match(texts[0], /Снять привязку папки «Бета \/ Корпуса \/ Паркинг 1» к объекту «Бизнес-центр «Нурлы»»\?/)
      assert.match(texts[0], /снова станут «без объекта»/)
      assert.deepEqual(await calls(page, (c) => c.method === 'POST' && c.path === '/api/signal/bindings').then((l) => l.map((c) => c.body.objectId)), ['obj-2'], 'отказ — ничего не ушло')
      accept = true
      await parking.locator('button', { hasText: 'Снять' }).click()
      await toast(page).filter({ hasText: 'Привязка снята' }).waitFor()
      const unbind = (await calls(page, (c) => c.method === 'POST' && c.path === '/api/signal/bindings')).at(-1)
      assert.equal(unbind.body.objectId, null, '«Снять» — тот же маршрут с objectId: null')
      assert.equal(unbind.body.sourceId, 2)
      await page.waitForFunction(() => document.querySelectorAll('[aria-label="Привязки папок"] tbody tr').length === 2)
      await page.waitForFunction(() => document.querySelectorAll('[aria-label="Папки без объекта"] tbody tr').length === 3)
      assert.match(await section(page, 'Папки без объекта').locator('tbody').textContent(), /Паркинг 1/, 'папка снова без объекта')
      assert.equal((await objectChip(page, 'Паркинг 1').textContent()).trim(), 'без объекта')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('привязок нет — подсказка; «Снять» вложенной папки возвращает ей объект родителя (унаследованный), а не «без объекта»', async () => {
    const { page, errors, close } = await open()
    try {
      await section(page, 'Привязки папок').locator('.sg-muted', { hasText: 'Привязок папок нет' }).waitFor()
      assert.equal(await section(page, 'Привязки папок').locator('table').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
    const nested = await open('&sigBound=1')
    try {
      // Вложенная привязка под привязанным родителем: привяжем «Договоры» корп.22 к объекту 1, затем снимем — снова объект корп.22.
      await expand(nested.page, 'Дельта')
      await expand(nested.page, 'корп.22')
      await treeRow(nested.page, 'Договоры').waitFor()
      await treeRow(nested.page, 'Договоры').locator('button', { hasText: 'Привязать к объекту…' }).click()
      const dialog = nested.page.getByRole('dialog')
      await dialog.locator('select').selectOption({ label: 'ЖК «Северный квартал»' })
      await dialog.locator('button', { hasText: /^Привязать$/ }).click()
      await Promise.race([dialog.locator('button', { hasText: 'Привязать всё равно' }).waitFor(), dialog.waitFor({ state: 'detached' })])
      if (await dialog.count()) await dialog.locator('button', { hasText: 'Привязать всё равно' }).click()
      await nested.page.waitForFunction(() => /привязана: ЖК/.test(document.querySelector('[aria-label="Дерево папок"] .sg-tree-kids .sg-tree-kids')?.textContent || ''))
      nested.page.on('dialog', (d) => d.accept())
      await section(nested.page, 'Привязки папок').locator('tbody tr', { hasText: 'Договоры' }).locator('button', { hasText: 'Снять' }).click()
      await nested.page.waitForFunction(() => /Бизнес-центр «Нурлы» \(унаследован\)/.test(document.querySelector('[aria-label="Дерево папок"] .sg-tree-kids .sg-tree-kids')?.textContent || ''))
      assert.deepEqual(nested.errors, [])
    } finally { await nested.close() }
  })

  it('телефон 390 px — только просмотр: состояние видно, ни одной кнопки изменений, дерева нет, привязки — списком, без прокрутки вбок', async () => {
    const { page, errors, close } = await open('&sigBound=1', { viewport: PHONE })
    try {
      assert.match(await page.locator('.sg-note').first().textContent(), /только просмотр состояния/)
      assert.match(await page.locator('.sg-conn').textContent(), /Подключение:\s*настроено/)
      assert.equal(await page.locator('.sg-roots tbody tr').count(), 3)
      assert.match(await rootRow(page, 'Гамма').textContent(), /нет объекта — корень закрыт для сотрудников/)
      assert.equal(await page.locator('.sg-runs tbody tr').count(), 4)
      assert.equal(await page.locator('.sg-aliases tbody tr').count(), 1)
      assert.equal(await section(page, 'Папки без объекта').locator('tbody tr').count(), 3)
      assert.equal(await section(page, 'Дерево папок').count(), 0, 'дерево с кнопками — только на компьютере')
      await section(page, 'Привязки папок').locator('tbody tr').first().waitFor()
      assert.equal(await section(page, 'Привязки папок').locator('tbody tr').count(), 2, 'привязки видны списком')
      assert.match(await page.locator('.sg-held .sg-code').textContent(), /deploy\.sh signal accept-held --run 12 --expected-generation 7/, 'команду видно и можно выделить')
      assert.equal(await page.locator('.sg-tab button').count(), 0, 'на телефоне в содержимом вкладки нет кнопок')
      for (const label of ['Добавить корень', 'Синхронизировать', 'Выключить', 'Включить', 'Объекты…', 'Удалить', 'Привязать к объекту…', 'Снять', 'Копировать']) {
        assert.equal(await page.locator('button', { hasText: label }).count(), 0, label)
      }
      assert.equal(await noScroll(page), true, 'нет прокрутки вбок')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('телефон: оповещения, сбой корня, зависший прогон и полоса свежести не раздвигают страницу', async () => {
    const { page, errors, close } = await open('&sigFailed=1&sigProblems=1&signalStale=1&sigStuck=1&sigBound=1', { viewport: PHONE })
    try {
      assert.equal(await page.locator('.sg-alerts li').count(), 3)
      assert.equal(await page.locator('.sg-stale').count(), 1)
      assert.match(await page.locator('.sg-stuck').textContent(), /^Прогон не отвечает с 23\.11\.2026 11:10; будет снят при следующем запуске$/)
      assert.equal(await page.locator('.sg-tab button').count(), 0)
      assert.equal(await noScroll(page), true, 'нет прокрутки вбок')
      const box = await page.locator('.sg-alerts').boundingBox()
      assert.ok(box.x >= 0 && box.x + box.width <= PHONE.width, 'баннер в пределах экрана')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('телефон: окна изменений не открываются, страница «Администрирование» с вкладкой и отметкой оповещений не раздвигается', async () => {
    const { page, errors, close } = await open('', { page: 'admin', viewport: PHONE })
    try {
      await tabButton(page).waitFor()
      assert.equal(await tabButton(page).locator('.admin-tab-count').textContent(), '1', 'отложенный прогон — одно оповещение')
      await tabButton(page).click()
      await tabLoaded(page)
      assert.equal(await page.locator('.sg-tab button').count(), 0)
      assert.equal(await page.getByRole('dialog').count(), 0)
      assert.equal(await noScroll(page), true)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  // ── В-5, В-7, В-8, С-48, С-50 ──────────────────────────────────────────────────────────────────────────────────────────────────
  it('отложенный прогон (С-50): номер, поколение и готовая команда с «Копировать»; нет отложенного — блока нет', async () => {
    const { page, errors, close } = await open()
    try {
      const held = page.locator('.sg-held')
      assert.match(await held.locator('.sg-note').textContent(), /Прогон № 12 отложен · поколение данных 7/)
      assert.equal(await held.locator('.sg-code').textContent(), 'deploy.sh signal accept-held --run 12 --expected-generation 7 --reason "…"')
      assert.match(await held.locator('.sg-hint').textContent(), /Вместо «…» впишите причину решения/)
      const copy = held.locator('button', { hasText: 'Копировать' })
      await copy.click()
      await held.locator('button', { hasText: 'Скопировано' }).waitFor()
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'deploy.sh signal accept-held --run 12 --expected-generation 7 --reason "…"', 'в буфере — вся команда')
      assert.deepEqual(errors, [])
    } finally { await close() }
    const none = await open('&sigHeld=0')
    try {
      assert.equal(await none.page.locator('.sg-held').count(), 0)
      assert.equal(await none.page.locator('.sg-alerts').count(), 0, 'нет отложенного — нет и оповещения')
      assert.doesNotMatch(await section(none.page, 'Журнал прогонов').textContent(), /accept-held/)
      assert.deepEqual(none.errors, [])
    } finally { await none.close() }
  })

  it('зависший прогон (С-48): «Прогон не отвечает с …; будет снят при следующем запуске», «Синхронизировать» доступна и не опрашивает журнал; запуск закрывает мёртвый и начинает новый', async () => {
    const { page, errors, close } = await open('&sigStuck=1')
    try {
      assert.equal(await page.locator('.sg-stuck').textContent(), 'Прогон не отвечает с 23.11.2026 11:10; будет снят при следующем запуске')
      const btn = section(page, 'Синхронизация').locator('button')
      assert.equal(await btn.textContent(), 'Синхронизировать', 'не «Обход идёт…»')
      assert.equal(await btn.isDisabled(), false)
      assert.equal(await section(page, 'Синхронизация').locator('[role=status]').count(), 0, 'про «идёт обход» не пишем')
      const dead = page.locator('.sg-runs tbody tr').first()
      assert.equal((await dead.locator('.sg-chip').textContent()).trim(), 'не отвечает')
      assert.match(await page.locator('.sg-alerts').textContent(), /Прогон не отвечает с 23\.11\.2026 11:10/, 'и в оповещениях')
      // Журнал сам не опрашивается: зависший прогон не закончится.
      const polls = (await calls(page, (c) => c.path === '/api/signal/runs')).length
      await page.waitForTimeout(5800)
      assert.equal((await calls(page, (c) => c.path === '/api/signal/runs')).length, polls, 'опроса нет')

      await btn.click()
      await page.locator('.sg-runs tbody tr').first().locator('.sg-chip', { hasText: 'идёт' }).waitFor()
      assert.equal((await calls(page, (c) => c.method === 'POST' && c.path === '/api/signal/sync')).length, 1)
      assert.equal(await page.locator('.sg-stuck').count(), 0, 'зависшего больше нет')
      assert.match(await page.locator('.sg-runs tbody tr', { hasText: /^\s*13/ }).first().textContent(), /сбой: завис и закрыт автоматически/)
      assert.match(await btn.textContent(), /Обход идёт/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('оповещения (В-5): баннер на вкладке, число на ярлыке; сбой корня с даты и причиной, проблемные подпапки; полоса свежести (В-7)', async () => {
    const { page, errors, close } = await open('&sigFailed=1&sigProblems=1&signalStale=1&sigStuck=1', { page: 'admin' })
    try {
      await tabButton(page).waitFor()
      assert.equal(await tabButton(page).locator('.admin-tab-count').textContent(), '4', 'сбой корня, отложен, не отвечает, данные устарели')
      assert.equal(await tabButton(page).getAttribute('aria-label'), 'Signal, оповещений: 4')
      await tabButton(page).click()
      await tabLoaded(page)
      // Тот же ответ сервера — число на ярлыке не расходится с вкладкой.
      const items = await page.locator('.sg-alerts li').allTextContents()
      assert.deepEqual(items, [
        'Корень «Бета → Корпуса» не обновляется с 22.11.2026 05:15',
        'Прогон отложен с 23.11.2026 11:09: снимок папок не заменён, пока данные не примут',
        'Прогон не отвечает с 23.11.2026 11:10; будет снят при следующем запуске',
      ])
      assert.equal(await page.locator('.sg-alerts li.is-bad').count(), 1, 'сбой корня — красным, остальные — жёлтым')
      assert.equal(await page.locator('.sg-stale').textContent(), 'Данные Signal обновлялись 21.11.2026 08:30 — сверка может быть устаревшей')
      // У корней.
      const beta = rootRow(page, 'Бета').locator('td').nth(6)
      assert.equal((await beta.textContent()).trim(), 'сбой с 22.11.2026: корень недоступен ключу')
      const alpha = rootRow(page, 'Альфа').locator('td').nth(6)
      assert.equal((await alpha.textContent()).trim(), 'проблемных подпапок: 3')
      assert.equal(await alpha.locator('.sg-chip').getAttribute('title'), 'нет доступа к папке: 2; папки нет в Signal: 1')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('оповещений нет и данные свежие — ни баннера, ни полосы, ни отметки на ярлыке; число — «проблемных подпапок» и в виде числа', async () => {
    const { page, errors, close } = await open('&sigHeld=0&sigProblems=n', { page: 'admin' })
    try {
      await tabButton(page).waitFor()
      await page.waitForTimeout(300)
      assert.equal((await tabButton(page).textContent()).trim(), 'Signal')
      assert.equal(await tabButton(page).locator('.admin-tab-count').count(), 0)
      assert.equal(await tabButton(page).getAttribute('aria-label'), null)
      await tabButton(page).click()
      await tabLoaded(page)
      assert.equal(await page.locator('.sg-alerts').count(), 0)
      assert.equal(await page.locator('.sg-stale').count(), 0)
      assert.equal((await rootRow(page, 'Альфа').locator('td').nth(6).textContent()).trim(), 'проблемных подпапок: 3')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('отметка на ярлыке обновляется после чтения состояния вкладкой (число оповещений не «залипает»)', async () => {
    const { page, errors, close } = await open('', { page: 'admin' })
    try {
      await tabButton(page).waitFor()
      assert.equal(await tabButton(page).locator('.admin-tab-count').textContent(), '1')
      await tabButton(page).click()
      await tabLoaded(page)
      await page.evaluate(() => { window.__signalAdmin.runs.find((r) => r.status === 'held').status = 'ok' }) // отложенное принято на сервере
      await page.locator('.sg-tab').getByRole('button', { name: 'Синхронизировать' }).click()
      await page.waitForFunction(() => !document.querySelector('.admin-tab .admin-tab-count'))
      assert.equal(await page.locator('.sg-alerts').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('сверка выключена по причине (В-8): вкладка показывает причину — только имена переменных, без остального содержимого', async () => {
    const cfg = await open('&signal=off&sigDisabled=config_invalid')
    try {
      const tab = cfg.page.locator('.sg-tab')
      assert.match(await tab.locator('.sg-disabled .sg-title').textContent(), /Сверка Signal выключена: ошибка настройки/)
      assert.equal(await tab.locator('[role=alert]').textContent(), 'Ошибка настройки: SIGNAL_URL_FORMATS, SIGNAL_UI_FOLDER_URL')
      assert.equal(await tab.locator('button').count(), 0)
      assert.equal(await tab.locator('.sg-block').count(), 1, 'ни корней, ни журнала, ни синонимов')
      assert.equal(await cfg.page.locator('.sg-roots, .sg-runs, .sg-aliases, .sg-alerts, .sg-stale').count(), 0)
      assert.deepEqual(await calls(cfg.page, (c) => /\/(runs|aliases|sources|unassigned|sync|bindings|tree)/.test(c.path)), [], 'админских маршрутов не вызываем')
      assert.doesNotMatch(await tab.textContent(), /https?:|=|секрет|token/i, 'значений нет')
      assert.deepEqual(cfg.errors, [])
    } finally { await cfg.close() }
    for (const [reason, text] of [
      ['no_schema', /нет схемы сверки Signal/], ['db_error', /Не удалось проверить базу для сверки Signal/],
    ]) {
      const r = await open(`&signal=off&sigDisabled=${reason}`)
      try {
        assert.match(await r.page.locator('.sg-disabled [role=alert]').textContent(), text, reason)
        assert.equal(await r.page.locator('.sg-tab .sg-block').count(), 1, reason)
        assert.deepEqual(r.errors, [], reason)
      } finally { await r.close() }
    }
    // Без причины (или не администратору) — прежняя подпись «не включена».
    const plain = await open('&signal=off')
    try {
      assert.match(await plain.page.locator('.sg-tab').textContent(), /Сверка Signal на этом сервере не включена/)
      assert.equal(await plain.page.locator('.sg-disabled').count(), 0)
    } finally { await plain.close() }
  })
})
