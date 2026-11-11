// «Реестр по договорам»: пути документа значками (11.11.2026, решение пользователя: «Signal — просто зелёной маленькой иконкой,
// если есть ссылка, красной, если нет; у Larix — либо „нет“, либо код с конца ссылки; путь к шаре — либо указан, либо нет»).
//   • заполненный путь — зелёный значок-переход (Signal и Larix — ссылкой в новой вкладке, папка — проводник или копирование),
//     пустой — красный; Larix — номер карточки из …/contract/<номер>, иначе хвост адреса; полный путь — в подсказке;
//   • правка всех трёх путей — одним окном: пустой значок (сразу в своё поле) или карандаш; нажатие мимо с набранным текстом
//     окно не закрывает, Escape закрывает без записи;
//   • без права правки «Договоров» — только отметки: ни карандаша, ни окна, ни «+ ПС»;
//   • понятийное соглашение — отметкой «ПС», список файлов — во всплывающем окне.
// Стенд: contractsPaths=1 — у 1/26 все три пути (Larix — карточка 4521), у 2/26 — только папка, у 4/26 — Signal и Larix
// не карточкой; у каждого седьмого договора — понятийное соглашение.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const BASE = 'route=/contracts/registry&contracts=30&contractsPaths=1&latency=0&shell=1'
const GREEN = 'rgb(21, 128, 61)'
const RED = 'rgb(185, 28, 28)'

describe('Договоры и ДС: пути значками', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  const open = async (extra = '') => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: stand.url.replace(/\/[^/]*$/, '') }).catch(() => {})
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    await page.goto(`${stand.url}?${BASE}${extra}`)
    await page.locator('.contracts-table tbody tr.contract-row').first().waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  // Строка договора по номеру: «1/26» не должно находить «11/26».
  const rowOf = (page, number) => page.locator('.contracts-table tbody tr.contract-row', { hasText: new RegExp(`№ ${number.replace('/', '\\/')}(?![0-9])`) }).first()
  const marksOf = (row) => row.evaluate((tr) => {
    const m = (k) => tr.querySelector(`.cmarks .dlm-${k}`)
    return Object.fromEntries(['folder', 'signal', 'larix'].map((k) => [k, {
      tag: m(k).tagName.toLowerCase(),
      on: m(k).classList.contains('is-on'),
      color: getComputedStyle(m(k)).color,
      href: m(k).getAttribute('href'),
      text: m(k).textContent.trim(),
      title: m(k).getAttribute('title'),
    }]))
  })

  it('указан — зелёный значок-переход, нет — красный; Larix — код карточки или хвост адреса, иначе «нет»', async () => {
    const { page, errors, close } = await open()
    try {
      const full = await marksOf(rowOf(page, '1/26'))
      assert.deepEqual([full.folder.on, full.signal.on, full.larix.on], [true, true, true])
      assert.deepEqual([full.folder.color, full.signal.color, full.larix.color], [GREEN, GREEN, GREEN])
      assert.equal(full.signal.tag, 'a')
      assert.equal(full.signal.href, 'https://signal.su10.ru/folder/1-26')
      assert.equal(full.larix.href, 'https://cpm.su10.larix.ru/contract/4521')
      assert.equal(full.larix.text, 'Larix4521', 'код с конца ссылки, полной ссылки нет')
      assert.match(full.folder.title, /su10-fs\\Договоры\\ЖК Северный\\1-26/, 'полный путь — в подсказке')
      assert.equal(await rowOf(page, '1/26').locator('.cmarks a.dlm[target="_blank"]').count(), 2)

      const other = await marksOf(rowOf(page, '4/26'))
      assert.deepEqual([other.folder.on, other.folder.color], [false, RED])
      assert.equal(other.larix.text, 'LarixДП-4', 'не карточка — последний кусок адреса')

      const none = await marksOf(rowOf(page, '5/26'))
      assert.deepEqual([none.folder.on, none.signal.on, none.larix.on], [false, false, false])
      assert.deepEqual([none.folder.color, none.signal.color, none.larix.color], [RED, RED, RED])
      assert.equal(none.larix.text, 'Larixнет')
      assert.equal(await rowOf(page, '5/26').locator('.dlm-edit').count(), 0, 'путей нет — карандаш не нужен, вход — пустые значки')
      assert.equal(await rowOf(page, '2/26').locator('.dlm-edit').count(), 1)

      // Папка: проводник открыть нельзя (не Windows) — путь копируется, строка не раскрывается.
      await rowOf(page, '2/26').locator('.dlm-folder').click()
      const toast = page.locator('#osp-copy-toast .copy-toast')
      await toast.waitFor()
      assert.equal(await toast.innerText(), 'Путь к папке скопирован')
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '\\\\su10-fs\\Договоры\\ЖК Северный\\2-26')
      assert.equal(await page.locator('.contracts-table tr.contract-expanded-row').count(), 0, 'значок строку не раскрывает')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('правка — одним окном: пустой значок ведёт в своё поле, карандаш — во все три; мимо с текстом не закрывается', async () => {
    const { page, errors, close } = await open()
    try {
      const row = rowOf(page, '5/26')
      await row.locator('.dlm-signal').click()
      const pop = page.locator('.apop.dlm-pop')
      await pop.waitFor()
      assert.match(await pop.locator('.dlm-pop-title').innerText(), /Пути договора № 5\/26/)
      assert.match(await page.evaluate(() => document.activeElement?.placeholder || ''), /Signal/, 'фокус — в поле Signal')
      assert.equal(await pop.locator('.dlm-pop-save').isDisabled(), true, 'ничего не изменено — сохранять нечего')
      await page.keyboard.type('https://signal.su10.ru/folder/5-26')
      // Нажатие мимо окна набранное не теряет.
      await page.locator('.registry-header h2').click()
      assert.equal(await pop.count(), 1, 'с набранным текстом окно мимо не закрывается')
      await pop.locator('.dlm-pop-save').click()
      await pop.waitFor({ state: 'detached' })
      const after = await marksOf(row)
      assert.deepEqual([after.signal.on, after.signal.tag, after.signal.href], [true, 'a', 'https://signal.su10.ru/folder/5-26'])
      assert.equal(await page.evaluate(() => window.__fakeDb.contracts.find((c) => c.id === 'ctr-5').signal_link), 'https://signal.su10.ru/folder/5-26')
      assert.equal(await row.locator('.dlm-edit').count(), 1, 'путь появился — появился и карандаш')

      // Карандаш: все три поля с текущими значениями; стёртый путь — снова красный.
      await rowOf(page, '2/26').locator('.dlm-edit').click()
      await pop.waitFor()
      assert.deepEqual(await pop.locator('.dlm-pop-input').evaluateAll((els) => els.map((e) => e.value)),
        ['\\\\su10-fs\\Договоры\\ЖК Северный\\2-26', '', ''])
      await pop.locator('.dlm-pop-input').first().fill('')
      await pop.locator('.dlm-pop-save').click()
      await pop.waitFor({ state: 'detached' })
      assert.equal((await marksOf(rowOf(page, '2/26'))).folder.on, false)

      // Escape закрывает без записи.
      await rowOf(page, '1/26').locator('.dlm-edit').click()
      await pop.waitFor()
      await pop.locator('.dlm-pop-input').nth(2).fill('https://cpm.su10.larix.ru/contract/9999')
      await page.keyboard.press('Escape')
      await pop.waitFor({ state: 'detached' })
      assert.equal((await marksOf(rowOf(page, '1/26'))).larix.text, 'Larix4521')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без права правки — только отметки: ни карандаша, ни окна, ни «+ ПС»; «ПС» с файлом — список во всплывающем окне', async () => {
    const { page, errors, close } = await open('&noEdit=contracts')
    try {
      const none = rowOf(page, '5/26')
      assert.equal(await none.locator('.cmarks .dlm.is-off').evaluateAll((els) => els.map((e) => e.tagName.toLowerCase()).join(',')), 'span,span,span')
      assert.equal(await page.locator('.contracts-table .dlm-edit').count(), 0)
      assert.equal(await page.locator('.contracts-table .ca-mark.is-add').count(), 0)
      // Заполненный путь — переход и без права правки.
      assert.equal(await rowOf(page, '1/26').locator('a.dlm-signal.is-on').count(), 1)

      // Понятийное соглашение (у 1/26 — каждый седьмой договор): «ПС», список — окном, удалить нельзя.
      const ps = rowOf(page, '1/26').locator('.ca-mark.is-on')
      assert.match(await ps.innerText(), /ПС/)
      await ps.click()
      const list = page.locator('.apop.ca-pop')
      await list.waitFor()
      assert.match(await list.locator('.ca-chip-label').first().innerText(), /ПС 1\/26\.pdf/)
      assert.equal(await list.locator('.ca-danger, .ca-add').count(), 0)
      await page.keyboard.press('Escape')
      await list.waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
