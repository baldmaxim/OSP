// «Заявки на ДС»: файлы не пропадают после обновления страницы, вид реестра переживает обновление.
// 27.10.2026 приложенный итоговый документ пропадал после обновления: файлы всех заявок читались одним запросом без
// страниц, а PostgREST отдаёт не больше 1000 строк — файлов стало больше, и отрезались самые новые (в базе они были).
// Вкладка, поиск, фильтры, раскрытые списки файлов — в sessionStorage вкладки браузера, прокрутка возвращается, когда
// данные на месте. С 28.10 шапка закреплена: прокручивается не .main-content, а блок таблицы под шапкой.
// Стенд tests/tender/ui (route=/dc-requests&dcStats=1; maxRows=1000 — потолок строк PostgREST, dcOldFiles=N — старые
// файлы перед файлами реестра, dcMany=N — длинный реестр).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import {
  DC_VIEW_KEY, EMPTY_DC_VIEW, groupDocsByRequest, readDcView, writeDcView,
} from '../../src/utils/dcRequestView.js'
import { startStand, browserLaunchOptions, REPO as ROOT } from './lib/stand.mjs'

const launch = browserLaunchOptions()

const memoryStorage = (init = {}) => {
  const data = new Map(Object.entries(init))
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), data }
}

describe('Вид реестра заявок на ДС в хранилище вкладки', () => {
  const TABS = ['all', 'in_work', 'completed', 'deleted']

  it('записанное читается обратно', () => {
    const storage = memoryStorage()
    const view = {
      tab: 'in_work', search: 'ДС-12', statuses: [], objects: ['obj-1'], counterparties: ['cp-1', 'cp-2'],
      responsibles: ['c-1'], divisions: ['monolith', 'none'], expanded: ['d2'],
    }
    writeDcView(view, storage)
    assert.deepEqual(readDcView(storage, TABS), view)
  })

  it('пусто, испорчено, недоступно — вид по умолчанию; вкладки, которой нет, — «Все»; мусор в списках отброшен', () => {
    assert.deepEqual(readDcView(memoryStorage(), TABS), EMPTY_DC_VIEW)
    assert.deepEqual(readDcView(memoryStorage({ [DC_VIEW_KEY]: '{не json' }), TABS), EMPTY_DC_VIEW)
    assert.deepEqual(readDcView(null, TABS), EMPTY_DC_VIEW)
    const throwing = { getItem() { throw new Error('SecurityError') }, setItem() { throw new Error('QuotaExceededError') } }
    assert.deepEqual(readDcView(throwing, TABS), EMPTY_DC_VIEW)
    assert.doesNotThrow(() => writeDcView(EMPTY_DC_VIEW, throwing))

    const odd = memoryStorage({ [DC_VIEW_KEY]: JSON.stringify({ tab: 'archive', search: 5, objects: ['obj-1', 7, null, ''], expanded: 'd2' }) })
    assert.deepEqual(readDcView(odd, TABS), { ...EMPTY_DC_VIEW, objects: ['obj-1'] })
  })

  it('файлы раскладываются по заявкам в порядке выборки', () => {
    const map = groupDocsByRequest([
      { id: 'f1', owner_id: 'r1' }, { id: 'f2', owner_id: 'r2' }, { id: 'f3', owner_id: 'r1' },
    ])
    assert.deepEqual([...map.entries()].map(([k, v]) => [k, v.map(d => d.id)]), [['r1', ['f1', 'f3']], ['r2', ['f2']]])
  })
})

describe('Реестр заявок на ДС: файлы и вид после обновления страницы', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  // init — скрипт до загрузки страницы (например, window.__fakeHold).
  async function open(extra = '', { init = null, height = 1000 } = {}) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height } })
    const page = await context.newPage()
    if (init) await page.addInitScript(init)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('dialog', (d) => {
      if (d.type() === 'confirm') d.accept().catch(() => {})
      else { errors.push(`окно: ${d.message()}`); d.dismiss().catch(() => {}) }
    })
    await page.goto(`${stand.url}?route=/dc-requests&dcStats=1&latency=10&shell=1${extra}`)
    await page.locator('.dcr-table td.ui-rownum').first().waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const rowOf = (page, ds) => page.locator('.dcr-table tbody tr', { hasText: `ДС-${ds}` })
  const chip = (row, name) => row.locator('.dcr-doc-chip-desc', { hasText: name })
  // Прокручивается блок таблицы под закреплённой шапкой.
  const scrollTop = (page) => page.evaluate(() => document.querySelector('.dc-requests-page .table-container').scrollTop)

  it('файлы за тысячной строкой видны: список файлов читается постранично', async () => {
    const { page, errors, close } = await open('&maxRows=1000&dcOldFiles=1200')
    try {
      // 1200 старых файлов + 5 файлов реестра: файлы реестра — самые новые, с 1201-й строки.
      await chip(rowOf(page, 'd4').locator('.dcr-final-docs'), 'ДС подписанное.pdf').waitFor({ timeout: 30000 })
      await chip(rowOf(page, 'd2').locator('.dcr-report-docs'), 'Отчёт.pdf').waitFor()
      assert.equal(await rowOf(page, 'd2').locator('.dcr-docs-summary').textContent(), 'Файлы: 2')
      const reads = await page.evaluate(() => window.__supabaseStats.requests
        .filter(r => r.table === 's3_documents' && r.op === 'select').map(r => r.range))
      assert.deepEqual(reads, [[0, 999], [1000, 1999]], 'две страницы по 1000 строк')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('итоговый документ виден сразу и не пропадает, когда приходит прочитанный раньше список файлов', async () => {
    // Первое чтение файлов отвечает через 2,5 с строками на момент запроса — без файла, загруженного за это время.
    const { page, errors, close } = await open('', {
      init: () => {
        window.__fakeHold = (q) => {
          if (q.table !== 's3_documents' || q.op !== 'select' || window.__docsHeld) return null
          window.__docsHeld = true
          return { delay: 2500, stale: true }
        }
      },
    })
    try {
      const d1 = rowOf(page, 'd1')
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), d1.getByRole('button', { name: '+ Итоговый документ' }).click()])
      await chooser.setFiles({ name: 'ДС №7 подписанное.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') })
      await page.locator('.dcr-doc-modal').getByRole('button', { name: 'Загрузить' }).click()
      await chip(d1.locator('.dcr-final-docs.has-final'), 'ДС №7 подписанное.pdf').waitFor({ timeout: 2000 })
      assert.equal(await page.evaluate(() => window.__supabaseStats.requests
        .filter(r => r.table === 's3_documents' && r.op === 'select').length), 1, 'первое чтение файлов ещё не пришло')

      // Устаревший ответ не применяется — файлы перечитываются; приложенный файл на месте, прежние файлы тоже.
      await page.waitForFunction(() => window.__supabaseStats.requests
        .filter(r => r.table === 's3_documents' && r.op === 'select').length >= 2, null, { timeout: 15000 })
      await chip(rowOf(page, 'd4').locator('.dcr-final-docs'), 'ДС подписанное.pdf').waitFor({ timeout: 15000 })
      await page.waitForTimeout(300)
      assert.equal(await chip(d1.locator('.dcr-final-docs'), 'ДС №7 подписанное.pdf').count(), 1)
      const saved = await page.evaluate(() => window.__fakeDb.s3_documents.find(d => d.file_name === 'ДС №7 подписанное.pdf'))
      assert.deepEqual([saved.owner_type, saved.owner_id, saved.doc_category], ['dc_request', 'd1', 'final'])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('вкладка, поиск, фильтр, раскрытые файлы и прокрутка — после обновления страницы те же', async () => {
    const { page, errors, close } = await open('&dcMany=60', { height: 900 })
    try {
      // Раскрыть файлы d2 («Все заявки»), затем — вкладка «В работе», поиск и фильтр по подрядчику.
      await rowOf(page, 'd2').locator('.dcr-docs-toggle').click()
      await page.locator('.status-tab', { hasText: 'В работе' }).click()
      await page.locator('input.dcr-search').fill('ДС-m')
      const cpFilter = page.locator('.dcr-filter-drop .fdrop', { hasText: 'Все контрагенты' })
      await cpFilter.locator('.fdrop-trigger').click()
      await page.locator('.fdrop-option-multi', { hasText: 'Подрядчик 01' }).click()
      await page.keyboard.press('Escape')
      await page.mouse.click(5, 5)
      const rows = page.locator('.dcr-table tbody tr')
      assert.equal(await rows.count(), 45, 'm1…m60 без каждой четвёртой («Подрядчик 02»)')

      await page.mouse.move(800, 600)
      await page.mouse.wheel(0, 1800)
      await page.waitForFunction(() => document.querySelector('.dc-requests-page .table-container').scrollTop > 1000)
      await page.waitForTimeout(400)
      const top = await scrollTop(page)
      assert.equal(await page.evaluate(() => document.querySelector('.main-content').scrollTop), 0, 'страница на месте')

      await page.reload()
      await page.locator('.dcr-table td.ui-rownum').first().waitFor({ timeout: 120000 })
      await page.waitForFunction((t) => Math.abs(document.querySelector('.dc-requests-page .table-container').scrollTop - t) <= 2, top, { timeout: 15000 })
      assert.equal(await page.locator('input.dcr-search').inputValue(), 'ДС-m')
      assert.equal((await page.locator('.status-tab.active').textContent()).replace(/\d+$/, '').trim(), 'В работе')
      assert.equal(await page.locator('.dcr-filter-drop.is-active .fdrop', { hasText: 'Подрядчик 01' }).count(), 1)
      assert.equal(await rows.count(), 45)

      // Перечитывание после правки (удаление заявки) не убирает таблицу и не сбрасывает прокрутку.
      await page.evaluate(() => {
        window.__sawLoader = false
        new MutationObserver(() => { if (document.querySelector('.dc-requests-page .loading')) window.__sawLoader = true })
          .observe(document.body, { childList: true, subtree: true })
      })
      // Кнопку — в видимую часть заранее: клик Playwright сам прокрутил бы к ней.
      const victim = rows.nth(30)
      const victimDs = (await victim.textContent()).match(/ДС-m\d+/)[0]
      await victim.getByRole('button', { name: 'Удалить заявку', exact: true }).scrollIntoViewIfNeeded()
      await page.waitForTimeout(200)
      const before = await scrollTop(page)
      await victim.getByRole('button', { name: 'Удалить заявку', exact: true }).click()
      await page.waitForFunction(() => window.__fakeDb.dc_requests.filter(r => r.id.startsWith('m') && r.deleted_at).length === 1)
      await page.locator('.dcr-table tbody tr', { hasText: new RegExp(`${victimDs}(?!\\d)`) }).waitFor({ state: 'detached', timeout: 10000 })
      assert.equal(await rows.count(), 44)
      assert.equal(await page.evaluate(() => window.__sawLoader), false, 'таблица не сменилась на «Загрузка...»')
      assert.ok(Math.abs((await scrollTop(page)) - before) <= 2, `прокрутка на месте: было ${before}, стало ${await scrollTop(page)}`)

      // Раскрытые файлы d2 тоже запомнились.
      await page.locator('input.dcr-search').fill('')
      await page.locator('.status-tab', { hasText: 'Все заявки' }).click()
      await rowOf(page, 'd2').locator('.dcr-docs .dcr-doc-chips').waitFor({ timeout: 5000 })

      // Новая вкладка браузера — реестр как обычно.
      const fresh = await page.context().browser().newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 900 } })
      try {
        const other = await fresh.newPage()
        await other.goto(`${stand.url}?route=/dc-requests&dcStats=1&latency=10&shell=1&dcMany=60`)
        await other.locator('.dcr-table td.ui-rownum').first().waitFor({ timeout: 120000 })
        assert.equal(await other.locator('input.dcr-search').inputValue(), '')
        assert.match(await other.locator('.status-tab.active').textContent(), /^Все заявки/)
        assert.equal(await other.evaluate(() => document.querySelector('.dc-requests-page .table-container').scrollTop), 0)
      } finally { await fresh.close() }
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  // 28.10.2026: при прокрутке уезжало всё — корень страницы (.contract-registry, overflow: hidden) гасил sticky у
  // заголовков столбцов. Теперь шапка раздела, вкладки, фильтры и заголовки стоят, таблица прокручивается под ними;
  // меню статуса внизу блока открывается вверх.
  it('шапка закреплена: при прокрутке таблицы название, вкладки, фильтры и заголовки столбцов на месте', async () => {
    for (const width of [1500, 1920]) {
      const context = await browser.newContext({ locale: 'ru-RU', viewport: { width, height: 900 } })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      try {
        await page.goto(`${stand.url}?route=/dc-requests&dcStats=1&latency=0&shell=1&dcMany=40`)
        await page.locator('.dcr-table td.ui-rownum').first().waitFor({ timeout: 120000 })
        const tops = () => page.evaluate(() => {
          const top = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().top)
          return { title: top('.registry-header'), tabs: top('.status-tabs'), toolbar: top('.dcr-toolbar'), th: top('.dcr-table thead th') }
        })
        const before = await tops()
        await page.mouse.move(width / 2, 700)
        await page.mouse.wheel(0, 2500)
        await page.waitForFunction(() => document.querySelector('.dc-requests-page .table-container').scrollTop > 1500)
        assert.deepEqual(await tops(), before, `${width}: шапка на месте`)
        const m = await page.evaluate(() => {
          const c = document.querySelector('.dc-requests-page .table-container')
          const th = document.querySelector('.dcr-table thead th').getBoundingClientRect()
          const box = c.getBoundingClientRect()
          // Под заголовками — строка таблицы, а не пустота: заголовок непрозрачен и поверх строк.
          const under = document.elementFromPoint(th.left + 20, th.top + th.height / 2)
          return { main: document.querySelector('.main-content').scrollTop, bottom: Math.round(box.bottom), vh: innerHeight,
            thTop: Math.round(th.top), boxTop: Math.round(box.top), underIsTh: !!under?.closest('thead') }
        })
        assert.equal(m.main, 0, 'страница не прокручивается — только таблица')
        assert.ok(Math.abs(m.thTop - m.boxTop) <= 1, `заголовки — вверху блока таблицы: ${m.thTop} / ${m.boxTop}`)
        assert.ok(m.underIsTh, 'заголовки поверх строк')
        assert.ok(m.bottom <= m.vh, `блок таблицы — в пределах окна: ${m.bottom} из ${m.vh}`)

        // Меню статуса у нижнего края — вверх, в пределах блока.
        const chips = page.locator('.dcr-table tbody .dcr-status-chip:not(:disabled)')
        const last = await page.evaluate((b) => {
          const list = [...document.querySelectorAll('.dcr-table tbody .dcr-status-chip:not(:disabled)')]
          return list.findLastIndex((el) => el.getBoundingClientRect().bottom < b - 4)
        }, m.bottom)
        await chips.nth(last).click()
        const pop = page.locator('.dcr-status-popover')
        await pop.waitFor({ timeout: 5000 })
        const box = await pop.boundingBox()
        const chip = await chips.nth(last).boundingBox()
        // Тот же порог, что на странице (STATUS_POPOVER_SPACE): под чипом меньше 180px — вверх.
        const up = m.bottom - (chip.y + chip.height) < 180
        assert.equal(/\bis-up\b/.test(await pop.getAttribute('class')), up)
        assert.ok(box.y + box.height <= m.bottom, `меню целиком видно: ${box.y + box.height} из ${m.bottom}`)
        await page.keyboard.press('Escape')
        await page.mouse.click(5, 5)
        assert.deepEqual(errors, [])
      } finally { await context.close() }
    }
  })

  it('ссылка из карточки контрагента снимает прочие фильтры, оставшиеся с прошлого раза', async () => {
    const { page, errors, close } = await open('&dcMany=12')
    try {
      await page.locator('input.dcr-search').fill('ДС-d1')
      await page.locator('.status-tab', { hasText: 'Завершено' }).click()
      await page.goto(`${stand.url}?route=${encodeURIComponent('/dc-requests?counterparty=cp-2')}&dcStats=1&latency=10&shell=1&dcMany=12`)
      await page.locator('.dcr-table td.ui-rownum').first().waitFor({ timeout: 120000 })
      assert.equal(await page.locator('input.dcr-search').inputValue(), '')
      assert.match(await page.locator('.status-tab.active').textContent(), /^Все заявки/)
      assert.equal(await page.locator('.dcr-table tbody tr').count(), 3, 'm4, m8, m12 — заявки «Подрядчика 02»')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
