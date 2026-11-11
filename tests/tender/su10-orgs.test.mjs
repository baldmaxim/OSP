// «Организации СУ-10» (вход через СУ-10: организация учётки → контрагент ОСП): правила показа и адаптер (без браузера), вкладка,
// окно «Сопоставить…», строка организации в «Заявках на доступ», блок в карточке контрагента и поле контрагента в карточке
// пользователя — в Chromium (стенд tests/tender/ui, route=/stand/su10-orgs, «сервер» в памяти). Сервер и база —
// tests/osp-api/su10-orgs.test.mjs. Проверяем:
//   • «Без связи» при входе через СУ-10 — только подрядчики с учётками или заявками (остальные — в «Все», с подсказкой);
//     до переключения — все подрядчики без связи; «Не действует» — выбывшие связи и сотрудники без исключения;
//   • «Сопоставить…»: подсказки с причинами, контрагент из ЧС не связывается, связь уходит на сервер, строка уходит из «Без связи»;
//     «Создать контрагента»: ИНН уже есть — «Связать с ним»; без ИНН — новый контрагент и связь;
//   • «Отвязать» — подтверждение с числом подрядчиков, чьи сессии закроются;
//   • СУ-10 не ответил — тихая строка, список из прежней сверки; вкладка выключена на сервере — понятная причина;
//   • исключение сотруднику — только суперадминистратору, с причиной;
//   • заявка подрядчика: контрагент — из связи организации, без связи создать нельзя («Сопоставить…»);
//   • карточка контрагента: «Связать…» с похожей по ИНН организацией первой; карточка пользователя при входе через СУ-10 —
//     контрагент только показом; телефон — без прокрутки страницы вбок.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { filterOrgs, orgStatus, hiddenUnlinked, employeesWithoutException, counterpartyLabel } from '../../src/utils/su10Orgs.js'
import { createSu10OrgsClient } from '../../src/api/su10OrgsClient.js'

const org = (over) => ({ kind: 'contractor', state: 'active', counterparty: null, usable: false, accounts: 0, requests: 0, employees: [], name: 'Орг', ...over })

describe('Организации СУ-10: правила показа и адаптер', () => {
  it('состояние организации: связана, не действует, без связи, своя, ошибка', () => {
    assert.equal(orgStatus(org({ counterparty: { id: 'x' }, usable: true })), 'linked')
    assert.equal(orgStatus(org({ counterparty: { id: 'x' }, usable: false })), 'broken')
    assert.equal(orgStatus(org({})), 'unlinked')
    assert.equal(orgStatus(org({ kind: 'own' })), 'own')
    assert.equal(orgStatus(org({ state: 'missing' })), 'invalid')
  })
  it('«Без связи»: при входе через СУ-10 — только с учётками или заявками; до переключения — все', () => {
    const list = [org({ id: 1, accounts: 1 }), org({ id: 2, requests: 2 }), org({ id: 3 }), org({ id: 4, counterparty: { id: 'c' }, usable: true })]
    assert.deepEqual(filterOrgs(list, { filter: 'unlinked', keycloak: true }).map((o) => o.id), [1, 2])
    assert.equal(hiddenUnlinked(list, true), 1)
    assert.deepEqual(filterOrgs(list, { filter: 'unlinked', keycloak: false }).map((o) => o.id), [1, 2, 3])
    assert.equal(hiddenUnlinked(list, false), 0)
    assert.deepEqual(filterOrgs(list, { filter: 'linked' }).map((o) => o.id), [4])
  })
  it('«Не действует»: связь не действует или сотрудник без исключения; поиск — по организации, контрагенту, ИНН и №', () => {
    const list = [
      org({ id: 1, counterparty: { id: 'c', name: 'ООО «Ромашка»', number: 12 }, usable: false }),
      org({ id: 2, employees: [{ subject: 's', exception: false }] }),
      org({ id: 3, employees: [{ subject: 's', exception: true }] }),
    ]
    assert.deepEqual(filterOrgs(list, { filter: 'attention' }).map((o) => o.id), [1, 2])
    assert.equal(employeesWithoutException(list[1]).length, 1)
    assert.deepEqual(filterOrgs(list, { filter: 'all', query: '№ 12' }).map((o) => o.id), [1])
    assert.deepEqual(filterOrgs(list, { filter: 'all', query: 'ромашка' }).map((o) => o.id), [1])
    assert.equal(counterpartyLabel({ number: 12, name: 'ООО «Ромашка»' }), '№ 12 ООО «Ромашка»')
  })
  it('адаптер: ответ — данные; отказ — текст, код и подробности; 404 без кода — вкладка не включена', async () => {
    const calls = []
    const fetchImpl = async (path, init) => {
      calls.push({ path, init })
      if (path.endsWith('/create-counterparty')) return new Response(JSON.stringify({ error: 'ИНН есть', code: 'inn_taken', counterpartyId: 'c1', number: 7 }), { status: 409 })
      if (path === '/api/admin/su10-orgs') return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
      return new Response(JSON.stringify({ ok: true, revoked: 2 }), { status: 200 })
    }
    const client = createSu10OrgsClient({ fetchImpl })
    assert.deepEqual(await client.link('o 1', 'c1'), { ok: true, revoked: 2 })
    assert.equal(calls[0].path, '/api/admin/su10-orgs/o%201/link')
    assert.deepEqual(JSON.parse(calls[0].init.body), { counterpartyId: 'c1' })
    await assert.rejects(client.createCounterparty('o1', { inn: '1' }), (e) => e.code === 'inn_taken' && e.counterpartyId === 'c1' && e.number === 7 && e.status === 409)
    await assert.rejects(client.list(), (e) => e.unavailable === true)
    const offline = createSu10OrgsClient({ fetchImpl: async () => { throw new TypeError('fetch failed') } })
    await assert.rejects(offline.refresh(), (e) => e.status === 0)
  })
})

const launch = browserLaunchOptions()

describe('Организации СУ-10: вкладка, окно, заявки, карточки', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open(query = '', viewport = { width: 1400, height: 900 }) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    await page.goto(`${stand.url}?route=/stand/su10-orgs&latency=0${query}`)
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const rows = (page) => page.locator('.so-table tbody tr')
  const rowOf = (page, name) => page.locator('.so-table tbody tr', { hasText: name })
  const filter = (page, label) => page.locator('.so-switch button', { hasText: label })
  const requests = (page) => page.evaluate(() => window.__su10.requests)

  it('фильтры: «Без связи» — только с учётками и заявками, «Все», «Не действует», «Связанные»', async () => {
    const { page, errors, close } = await open()
    try {
      await rows(page).first().waitFor({ timeout: 120000 })
      assert.deepEqual(await page.locator('.so-table tbody tr .so-name').first().textContent(), 'Бета ООО')
      assert.equal(await rows(page).count(), 1)
      assert.match(await page.locator('.so-tab').textContent(), /Ещё 1 — в «Все»/)
      await filter(page, 'Все').click()
      assert.equal(await rows(page).count(), 5)
      await filter(page, 'Не действует').click()
      assert.equal(await rows(page).count(), 2, 'выбывшая связь и сотрудник без исключения')
      assert.match(await rowOf(page, 'Каппа ООО').textContent(), /связь не действует/)
      assert.match(await rowOf(page, 'Бета ООО').textContent(), /сотрудник ОСП — не войдёт/)
      await filter(page, 'Связанные').click()
      assert.equal(await rows(page).count(), 1)
      assert.match(await rowOf(page, 'Альфа ООО').textContent(), /№ 12 ООО «Альфа»/)
      const reqs = await requests(page)
      assert.ok(reqs.some((r) => r.method === 'POST' && r.path === '/api/admin/su10-orgs/refresh'), 'при открытии реестр сверяется')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Сопоставить…»: причины подсказок, ЧС не связывается, связь уходит на сервер', async () => {
    const { page, errors, close } = await open()
    try {
      await rowOf(page, 'Бета ООО').locator('button', { hasText: 'Сопоставить' }).click()
      const dialog = page.locator('.so-dialog')
      await dialog.locator('.so-cand').first().waitFor()
      assert.equal(await dialog.locator('.so-cand').count(), 2)
      const black = dialog.locator('.so-cand', { hasText: 'Бета-Чёрный' })
      assert.match(await black.textContent(), /в чёрном списке/)
      assert.equal(await black.locator('button', { hasText: 'Связать' }).isDisabled(), true)
      const good = dialog.locator('.so-cand', { hasText: '№ 13 ООО «Бета»' })
      assert.match(await good.textContent(), /то же название/)
      await good.locator('button', { hasText: 'Связать' }).click()
      await dialog.waitFor({ state: 'detached' })
      await page.locator('.admin-toast', { hasText: 'Организация связана' }).waitFor()
      const link = (await requests(page)).find((r) => r.method === 'POST' && r.path === '/api/admin/su10-orgs/o-b/link')
      assert.deepEqual(link.body, { counterpartyId: 'cp-b' })
      assert.equal(await rows(page).count(), 0, 'из «Без связи» ушла')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Создать контрагента»: ИНН уже есть — «Связать с ним»; без ИНН — новый контрагент и связь', async () => {
    const { page, errors, close } = await open()
    try {
      await rows(page).first().waitFor({ timeout: 120000 })
      await filter(page, 'Все').click()
      await rowOf(page, 'Гамма ООО').locator('button', { hasText: 'Сопоставить' }).click()
      const dialog = page.locator('.so-dialog')
      const first = dialog.locator('.so-cand').first()
      await first.waitFor()
      assert.match(await first.textContent(), /ИНН совпал/)
      await dialog.getByLabel('ИНН').fill('7707083893')
      await dialog.locator('button', { hasText: 'Создать контрагента' }).click()
      await dialog.locator('.so-warn', { hasText: 'уже есть (№ 12)' }).waitFor()
      assert.equal(await dialog.locator('button', { hasText: 'Связать с ним' }).count(), 1)
      await dialog.getByLabel('ИНН').fill('')
      await dialog.getByLabel('Название контрагента').fill('ООО «Гамма-2»')
      await dialog.locator('button', { hasText: 'Создать контрагента' }).click()
      await dialog.waitFor({ state: 'detached' })
      await page.locator('.admin-toast', { hasText: 'Создан контрагент № 99 ООО «Гамма-2»' }).waitFor()
      const created = (await requests(page)).filter((r) => r.path === '/api/admin/su10-orgs/o-c/create-counterparty')
      assert.deepEqual(created.map((r) => r.body), [{ name: 'Гамма ООО', inn: '7707083893' }, { name: 'ООО «Гамма-2»', inn: '' }])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Отвязать»: подтверждение называет, скольких подрядчиков заденет; отмена — ничего не уходит', async () => {
    const { page, errors, close } = await open()
    try {
      await rows(page).first().waitFor({ timeout: 120000 })
      await filter(page, 'Связанные').click()
      const texts = []
      let accept = false
      page.on('dialog', (d) => { texts.push(d.message()); return accept ? d.accept() : d.dismiss() })
      await rowOf(page, 'Альфа ООО').locator('button', { hasText: 'Отвязать' }).click()
      assert.match(texts[0], /сразу потеряют доступ/)
      assert.match(texts[0], /учёток портала с этим контрагентом — 2/)
      assert.equal((await requests(page)).filter((r) => r.method === 'DELETE').length, 0)
      accept = true
      await rowOf(page, 'Альфа ООО').locator('button', { hasText: 'Отвязать' }).click()
      await page.locator('.admin-toast', { hasText: 'закрыто сессий: 2' }).waitFor()
      assert.equal((await requests(page)).filter((r) => r.method === 'DELETE' && r.path === '/api/admin/su10-orgs/o-a/link').length, 1)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('СУ-10 не ответил — тихая строка, список прежний; вкладка выключена на сервере — причина', async () => {
    const down = await open('&su10Down=1')
    try {
      await rows(down.page).first().waitFor({ timeout: 120000 })
      assert.match(await down.page.locator('.so-note').textContent(), /СУ-10 сейчас не ответил — список из прежней сверки/)
      assert.match(await down.page.locator('.so-hint').first().textContent(), /Последняя попытка не удалась/)
      assert.deepEqual(down.errors, [])
    } finally { await down.close() }
    const off = await open('&su10Off=1')
    try {
      await off.page.locator('.so-error').waitFor({ timeout: 120000 })
      assert.match(await off.page.locator('.so-error').textContent(), /не включена/)
    } finally { await off.close() }
  })

  it('исключение сотруднику — только суперадминистратору и с причиной; до переключения — подсказка и все без связи', async () => {
    const plain = await open()
    try {
      await rows(plain.page).first().waitFor({ timeout: 120000 })
      assert.equal(await plain.page.locator('button', { hasText: 'Допустить…' }).count(), 0)
      assert.match(await rowOf(plain.page, 'Бета ООО').textContent(), /только суперадминистратор/)
    } finally { await plain.close() }
    const sup = await open('&su10Super=1')
    try {
      await rows(sup.page).first().waitFor({ timeout: 120000 })
      await sup.page.locator('button', { hasText: 'Допустить…' }).click()
      const submit = sup.page.locator('.so-exc-form button', { hasText: 'Допустить' })
      assert.equal(await submit.isDisabled(), true, 'без причины нельзя')
      await sup.page.locator('.so-exc-form input').fill('Совместитель, приказ № 5')
      await submit.click()
      await sup.page.locator('.admin-toast', { hasText: 'Исключение внесено' }).waitFor()
      const req = (await requests(sup.page)).find((r) => r.path === '/api/admin/su10-org-exceptions')
      assert.deepEqual(req.body, { subject: 's-e', reason: 'Совместитель, приказ № 5' })
      await sup.page.locator('.so-section-title', { hasText: 'Исключения' }).waitFor()
      assert.deepEqual(sup.errors, [])
    } finally { await sup.close() }
    const own = await open('&su10Mode=own')
    try {
      await rows(own.page).first().waitFor({ timeout: 120000 })
      assert.match(await own.page.locator('.so-hint').first().textContent(), /Вход через СУ-10 ещё не включён/)
      assert.equal(await rows(own.page).count(), 2, 'до переключения — все подрядчики без связи')
    } finally { await own.close() }
  })

  it('заявка подрядчика: контрагент — из связи организации; без связи создать нельзя, «Сопоставить…» прямо из заявки', async () => {
    const { page, errors, close } = await open('&su10View=requests')
    try {
      const card1 = page.locator('.ir-card', { hasText: 'Петров Пётр' })
      await card1.waitFor({ timeout: 120000 })
      assert.match(await card1.locator('.so-org-line').textContent(), /Бета ООО.*не сопоставлена с контрагентом/)
      await card1.locator('button', { hasText: 'Создать пользователя' }).click()
      await card1.locator('select').first().selectOption('contractor')
      assert.match(await card1.locator('.so-warn').textContent(), /подрядчика не создать/)
      assert.equal(await card1.locator('button[type=submit]').isDisabled(), true)
      await card1.locator('.so-warn button', { hasText: 'Сопоставить' }).click()
      await page.locator('.so-dialog .so-cand', { hasText: '№ 13 ООО «Бета»' }).locator('button', { hasText: 'Связать' }).click()
      await page.locator('.so-dialog').waitFor({ state: 'detached' })
      await page.locator('.ir-card', { hasText: 'Петров Пётр' }).locator('.so-org-line', { hasText: '№ 13 ООО «Бета»' }).waitFor()

      const card2 = page.locator('.ir-card', { hasText: 'Сидоров Сидор' })
      await card2.locator('button', { hasText: 'Создать пользователя' }).click()
      await card2.locator('select').first().selectOption('contractor')
      assert.match(await card2.locator('.ir-form').textContent(), /№ 12 ООО «Альфа» — по связи организации СУ-10/)
      await card2.locator('button[type=submit]').click()
      await page.locator('.admin-toast', { hasText: 'Пользователь создан' }).waitFor()
      const body = await page.evaluate(() => window.__su10.createUserBodies.find((b) => b.id === 'r-2').body)
      assert.equal(body.role, 'contractor')
      assert.equal(body.counterpartyId, null, 'контрагента ставит сервер из связи')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('карточка контрагента: «Связать…» — похожая по ИНН организация первой; связанная — с «Отвязать»', async () => {
    const { page, errors, close } = await open('&su10View=card&su10Cp=cp-c')
    try {
      const block = page.locator('.so-cp-block')
      await block.locator('button', { hasText: 'Связать…' }).waitFor({ timeout: 120000 })
      await block.locator('button', { hasText: 'Связать…' }).click()
      const first = block.locator('.so-cand').first()
      assert.match(await first.textContent(), /Гамма ООО.*ИНН совпал/)
      page.on('dialog', (d) => d.accept())
      await first.locator('button', { hasText: 'Связать' }).click()
      await block.locator('.so-org-line', { hasText: 'Гамма ООО' }).waitFor()
      assert.equal(await block.locator('button', { hasText: 'Отвязать' }).count(), 1)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('карточка пользователя при входе через СУ-10: контрагент только показом; без него — прежний выбор', async () => {
    const locked = await open('&su10View=drawer')
    try {
      const drawer = locked.page.locator('.adm-drawer')
      await drawer.waitFor({ timeout: 120000 })
      assert.match(await drawer.textContent(), /ООО «Альфа».*организация его учётки СУ-10/s)
      assert.equal(await drawer.locator('input[placeholder="Поиск контрагента…"]').count(), 0)
    } finally { await locked.close() }
    const free = await open('&su10View=drawer&su10Locked=0')
    try {
      const drawer = free.page.locator('.adm-drawer')
      await drawer.waitFor({ timeout: 120000 })
      assert.doesNotMatch(await drawer.textContent(), /организация его учётки СУ-10/)
    } finally { await free.close() }
  })

  it('телефон: вкладка без прокрутки страницы вбок, таблица — карточками', async () => {
    const { page, errors, close } = await open('', { width: 390, height: 800 })
    try {
      await rows(page).first().waitFor({ timeout: 120000 })
      await filter(page, 'Все').click()
      const wide = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth)
      assert.ok(wide <= 1, `страница шире окна на ${wide}px`)
      assert.equal(await page.locator('.so-table thead').isVisible(), false)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
