// «Дерево договоров» (/contracts/tree) — эксперимент 12.11.2026: только администратору; пример со всеми случаями и
// действиями на экране; реальные данные — только чтение (в базу ничего не пишется). Логика дерева —
// tests/contracts/contract-tree.test.mjs. Стенд tests/tender/ui, Chromium.
// CONTRACT_TREE_SHOTS=<папка> — снимки экрана для просмотра глазами.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO as ROOT } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const SHOTS = process.env.CONTRACT_TREE_SHOTS || ''
const DATA = 'contracts=12&contractsMixed=1&dcStats=1&dcContracts=1&docCheck=1&latency=0'

describe('Дерево договоров (эксперимент)', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
  let stand
  let browser

  before(async () => {
    stand = await startStand(ROOT)
    browser = await chromium.launch({ ...launch, headless: true })
  })
  after(async () => {
    await browser?.close()
    await stand?.server.close()
  })

  async function open(query, viewport = { width: 1600, height: 1000 }, { mode } = {}) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    if (mode) await context.addInitScript((m) => localStorage.setItem('contractTree:mode', JSON.stringify(m)), mode)
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${stand.url}?${query}`)
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const root = (page, number) => page.locator('.ctree-root', { has: page.locator('.ctree-cell-doc strong', { hasText: number }) })
  const writes = (page) => page.evaluate(() => window.__supabaseStats.requests.filter((r) => r.op && r.op !== 'select').map((r) => `${r.op} ${r.table}`))

  it('ссылка на эксперимент — на странице «Договоры и ДС» только у администратора', async () => {
    let { page, errors, close } = await open(`route=/contracts&${DATA}`)
    try {
      await page.locator('.contracts-hub').waitFor({ timeout: 120000 })
      assert.equal(await page.locator('.thub-exp').getAttribute('href'), '/contracts/tree')
      assert.deepEqual(errors, [])
    } finally { await close() }
    ({ page, errors, close } = await open(`route=/contracts&${DATA}&asRole=lawyer`))
    try {
      await page.locator('.contracts-hub').waitFor({ timeout: 120000 })
      assert.equal(await page.locator('.thub-exp').count(), 0)
    } finally { await close() }
  })

  it('не администратору страница закрыта', async () => {
    const { page, close } = await open(`route=/contracts/tree&${DATA}&asRole=lawyer`)
    try {
      await page.getByText('Нет прав для просмотра раздела').waitFor({ timeout: 120000 })
      assert.equal(await page.locator('.ctree-page').count(), 0)
    } finally { await close() }
  })

  it('пример: все случаи в ветке, отметки в строках, карточка справа', async () => {
    const { page, errors, close } = await open(`route=/contracts/tree&${DATA}&shell=1`)
    try {
      await page.locator('.ctree-page').waitFor({ timeout: 120000 })
      assert.equal(await page.locator('.ctree-mode-btn.is-active').innerText(), 'Пример')

      // Полная ветка открыта сразу: основание, договор, 3 ДС, 7 заявок.
      const full = root(page, 'ПРП-ДП-26-001')
      assert.equal(await full.getAttribute('class').then((c) => c.includes('is-open')), true)
      assert.equal(await full.locator('.ctree-tree > .is-basis').count(), 1)
      assert.match(await full.locator('.is-basis .ctree-prefix').innerText(), /основание/)
      assert.equal(await full.locator('.ctree-line.is-doc').count(), 4, 'договор и три ДС')
      assert.equal(await full.locator('.ctree-line.is-request').count(), 7)
      assert.match(await full.locator('.ctree-line.is-doc', { hasText: '№ 3' }).innerText(), /к ДС № 2/)
      assert.equal(await full.locator('.ctree-due.is-overdue').count(), 1, 'просроченная проверка')
      assert.match(await full.locator('.ctree-row .ctree-active').innerText(), /в работе/)
      assert.equal(await full.locator('.ctree-row .ctree-active.is-overdue').count(), 1)
      assert.equal(await full.getByRole('button', { name: 'Создать ДС' }).count(), 1, 'заявка на ДС без ДС')

      // Всё завершено — без «в работе»; договор без веток.
      assert.equal(await root(page, 'ПРС-ДП-25-014').locator('.ctree-active').count(), 0)
      assert.match(await root(page, 'ПРС-ДП-26-003').locator('.ctree-cell-branches').innerText(), /веток нет/)

      // Карточка проверки: этапы и место в дереве.
      await full.locator('.ctree-line.is-request', { hasText: 'ID 341' }).locator('.ctree-line-main').click()
      const card = page.locator('.ctree-card')
      await card.waitFor()
      assert.match(await card.locator('h3').innerText(), /Проверка ДП\/ДС ID 341/)
      assert.equal(await card.locator('.ctree-steplist li').count(), 6)
      assert.match(await card.locator('.ctree-steplist .is-current').innerText(), /Signal/)
      assert.match(await card.locator('.ctree-card-box').innerText(), /ПРП-ДП-26-001[\s\S]*Связь указана в заявке/)
      assert.match(await card.innerText(), /Петрова Е\. А\./)
      assert.match(await card.innerText(), /Документ\s+ДП № ПРП-ДП-26-001/)
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/tree-demo.png`, fullPage: true })
      await page.keyboard.press('Escape')
      await card.waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('пример: «Создать ДС», «Привязать», «Оформить договор», «+ На проверку»', async () => {
    const { page, errors, close } = await open(`route=/contracts/tree&${DATA}`)
    try {
      await page.locator('.ctree-page').waitFor({ timeout: 120000 })
      const full = root(page, 'ПРП-ДП-26-001')

      // Заявка № 60 → новое ДС № 4, заявка — под ним.
      await full.getByRole('button', { name: 'Создать ДС' }).click()
      await full.locator('.ctree-line.is-doc', { hasText: '№ 4' }).waitFor()
      assert.equal(await full.locator('.ctree-line.is-doc').count(), 5)
      assert.equal(await full.getByRole('button', { name: 'Создать ДС' }).count(), 0)
      const ds4 = full.locator('.ctree-node', { has: page.locator(':scope > .ctree-line.is-doc', { hasText: '№ 4' }) })
      assert.equal(await ds4.locator('.ctree-line.is-request', { hasText: '№ 60' }).count(), 1)

      // Без договора: заявка на ДС № 58 — к единственному договору контрагента на объекте.
      await page.locator('.ctree-loose-head').click()
      const dc58 = page.locator('.ctree-loose-item', { hasText: '№ 58' })
      await dc58.getByRole('button', { name: /Привязать к договору № ПРП-ДП-26-001/ }).click()
      await full.locator('.ctree-line.is-request', { hasText: '№ 58' }).waitFor()
      assert.equal(await page.locator('.ctree-loose-item', { hasText: '№ 58' }).count(), 0)

      // Заявка на ДП № 11 → новый договор с основанием.
      await page.locator('.ctree-loose-item', { hasText: '№ 11' }).getByRole('button', { name: 'Оформить договор' }).click()
      const yy = String(new Date().getFullYear()).slice(-2)
      const created = root(page, `ПРС-ДП-${yy}-`).filter({ has: page.locator('.is-basis', { hasText: '№ 11' }) })
      await created.waitFor()
      assert.match(await page.locator('.ctree-card h3').innerText(), /Договор № ПРС-ДП-/)

      // «+ На проверку» у договора без веток.
      const bare = root(page, 'ПРС-ДП-26-003')
      await bare.locator('.ctree-row').click()
      await bare.getByRole('button', { name: '+ На проверку' }).first().click()
      await bare.locator('.ctree-line.is-request', { hasText: 'ID 396' }).waitFor()
      assert.match(await page.locator('.ctree-card h3').innerText(), /ID 396/)

      // «Вернуть пример как был».
      await page.getByRole('button', { name: 'Вернуть пример как был' }).click()
      assert.equal(await root(page, 'ПРП-ДП-26-001').locator('.ctree-line.is-doc').count(), 4)
      assert.deepEqual(await writes(page), [], 'пример ничего не пишет в базу')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('реальные данные: чтение договоров и заявок, действия — только пояснение, записи нет', async () => {
    const { page, errors, close } = await open(`route=/contracts/tree&${DATA}&shell=1`, undefined, { mode: 'real' })
    try {
      await page.locator('.ctree-page').waitFor({ timeout: 120000 })
      assert.equal(await page.locator('.ctree-mode-btn.is-active').innerText(), 'Реальные данные')
      await page.locator('.ctree-toolbar').waitFor({ timeout: 60000 })
      const tables = await page.evaluate(() => [...new Set(window.__supabaseStats.requests.map((r) => r.table))])
      for (const t of ['contracts', 'dc_requests', 'doc_check_requests']) assert.ok(tables.includes(t), t)

      // По умолчанию — договоры с заявками; без фильтра — все.
      const withReq = await page.locator('.ctree-root').count()
      assert.ok(withReq > 0, 'есть договоры с заявками')
      await page.getByRole('button', { name: 'Только с заявками' }).click()
      assert.ok(await page.locator('.ctree-root').count() >= withReq)

      // Действие на настоящих данных — окно с пояснением, без записи.
      await page.locator('.ctree-root .ctree-row').first().click()
      await page.locator('.ctree-root.is-open .ctree-branch-actions button', { hasText: '+ На проверку' }).click()
      await page.locator('.ctree-info').waitFor()
      assert.match(await page.locator('.ctree-info').innerText(), /настоящие данные не меняются/)
      await page.getByRole('button', { name: 'Понятно' }).click()
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/tree-real.png`, fullPage: true })
      assert.deepEqual(await writes(page), [])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('телефон: без горизонтальной прокрутки, карточка на весь экран', async () => {
    const { page, errors, close } = await open(`route=/contracts/tree&${DATA}&shell=1`, { width: 390, height: 844 })
    try {
      await page.locator('.ctree-page').waitFor({ timeout: 120000 })
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      assert.ok(overflow <= 1, `горизонтальная прокрутка ${overflow}px`)
      await root(page, 'ПРП-ДП-26-001').locator('.ctree-line.is-request', { hasText: '№ 52' }).locator('.ctree-line-main').click()
      const box = await page.locator('.ctree-card').boundingBox()
      assert.ok(box.width >= 389, `ширина карточки ${box.width}`)
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/tree-phone.png` })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
