// Обложки на странице «Объекты»: карточка и окно правки показывают миниатюру (сервер — tests/osp-api/covers.test.mjs),
// оригинал не скачивается; миниатюра не отдалась — виден оригинал, как раньше; адрес бакета Supabase не меняется;
// карточки не ждут запросы по очереди.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()
const NAME = '0f0e0d0c-0b0a-4908-8706-050403020100.jpg'
const OWN = `/api/covers/${NAME}`
const SUPABASE = 'https://covers.test/storage/v1/object/public/object-photos/a.jpg'
// Картинка 1×1: браузеру важно получить настоящее изображение, чтобы отличить показ от ошибки.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

describe('обложки на странице «Объекты»', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open({ thumbStatus = 200, viewport = { width: 1400, height: 900 }, recordStarts = false } = {}) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    const covers = []
    page.on('pageerror', (e) => errors.push(e.message))
    await context.route(/\/api\/covers\/|covers\.test/, (route) => {
      const url = new URL(route.request().url())
      covers.push(url.pathname)
      const failed = url.pathname.endsWith('/thumb') && thumbStatus !== 200
      return route.fulfill(failed ? { status: thumbStatus, body: '{}' } : { status: 200, contentType: 'image/png', body: PNG })
    })
    // Сначала сама страница: первая загрузка ленивого модуля может перезагрузить стенд (Vite нашёл новую зависимость)
    // и потерять данные, заведённые ниже. Потом — уйти и вернуться, чтобы страница прочитала их заново.
    await page.goto(`${stand.url}?route=/general/objects&latency=0`)
    await page.locator('.objects-grid').waitFor({ timeout: 120000 })
    await page.evaluate(() => window.__navigate('/general'))
    await page.locator('.objects-grid').waitFor({ state: 'detached', timeout: 30000 })
    await page.evaluate(([own, supabase, record]) => {
      window.__fakeDb.objects = [
        { id: 'o-1', name: 'ЖК Южный', address: 'Адрес 1', status: 'main_construction', cover_image_url: own },
        { id: 'o-2', name: 'ЖК Северный', address: 'Адрес 2', status: 'main_construction', cover_image_url: supabase },
        { id: 'o-3', name: 'ЖК Без фото', address: 'Адрес 3', status: 'main_construction', cover_image_url: null },
      ]
      window.__fakeTouch('objects')
      // Когда начался каждый запрос; задержка — чтобы запросы «по очереди» было видно.
      if (record) {
        window.__started = {}
        window.__fakeHold = (q) => {
          if (q.op === 'select' && !window.__started[q.table]) window.__started[q.table] = performance.now()
          return q.table === 'objects' || q.table === 'object_staff' ? { delay: 700 } : {}
        }
      }
      window.__navigate('/general/objects')
    }, [OWN, SUPABASE, recordStarts])
    await page.locator('.objects-grid .object-card').first().waitFor({ timeout: 60000 })
    return { page, errors, covers, close: () => context.close().catch(() => {}) }
  }
  const coverOf = (page, name) => page.locator('.object-card', { hasText: name }).locator('.object-card-cover img')
  const shown = (locator) => locator.evaluate((img) => img.complete && img.naturalWidth > 0)
  async function waitShown(page, locator) {
    await locator.waitFor({ timeout: 10000 })
    const handle = await locator.elementHandle()
    await page.waitForFunction((img) => img.complete && img.naturalWidth > 0, handle, { timeout: 10000 })
  }

  it('карточка показывает миниатюру, оригинал не скачивается; адрес бакета Supabase — как есть', async () => {
    const { page, errors, covers, close } = await open()
    const own = coverOf(page, 'ЖК Южный')
    assert.equal(await own.getAttribute('src'), `${OWN}/thumb`)
    await waitShown(page, own)
    const supabase = coverOf(page, 'ЖК Северный')
    assert.equal(await supabase.getAttribute('src'), SUPABASE)
    await waitShown(page, supabase)
    assert.equal(await own.getAttribute('loading'), 'lazy')
    assert.equal(await page.locator('.object-card', { hasText: 'ЖК Без фото' }).locator('.object-card-cover-placeholder').count(), 1)
    assert.ok(covers.includes(`${OWN}/thumb`))
    assert.ok(!covers.includes(OWN), 'оригинал не запрашивался')
    assert.deepEqual(errors, [])
    await close()
  })

  it('миниатюра не отдалась — виден оригинал, без повторов по кругу', async () => {
    const { page, covers, close } = await open({ thumbStatus: 404 })
    const own = coverOf(page, 'ЖК Южный')
    await waitShown(page, own)
    assert.equal(await own.getAttribute('src'), OWN)
    assert.equal(await shown(own), true)
    assert.equal(covers.filter((c) => c === `${OWN}/thumb`).length, 1, 'миниатюра запрошена один раз')
    assert.equal(covers.filter((c) => c === OWN).length, 1, 'оригинал запрошен один раз')
    await close()
  })

  it('окно правки: превью обложки — тоже миниатюрой', async () => {
    const { page, covers, close } = await open()
    const card = page.locator('.object-card', { hasText: 'ЖК Южный' })
    await card.hover()
    await card.locator('.object-card-action-btn').first().click()
    const preview = page.locator('.object-photo-preview img')
    await waitShown(page, preview)
    assert.equal(await preview.getAttribute('src'), `${OWN}/thumb`)
    assert.ok(!covers.includes(OWN))
    await close()
  })

  it('объекты и ответственные запрашиваются одновременно: карточки не ждут запросы по очереди', async () => {
    const { page, close } = await open({ recordStarts: true })
    const started = await page.evaluate(() => window.__started)
    assert.ok(started.objects && started.object_staff, JSON.stringify(started))
    assert.ok(Math.abs(started.object_staff - started.objects) < 350, `разница ${started.object_staff - started.objects} мс при задержке запроса 700 мс`)
    await close()
  })
})
