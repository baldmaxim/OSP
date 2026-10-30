// «Скачать ДП» в окне письма подрядчикам (30.10.2026, просьба пользователя): в «Тендерах — Основное строительство»
// вместо «Закрыть» — кнопка, которая сразу скачивает шаблон договора подряда по ссылке «Шаблон ДП» из «Документов
// раздела» (app_settings contracts_dp_template_link), без перехода по ссылке и без новой вкладки. Ссылка Google Docs
// превращается в адрес выгрузки …/export?format=docx (у файла Word, открытого в Google, — тот же файл), имя файла —
// из ответа (filename* важнее filename: в нём Google заменяет кириллицу подчёркиваниями).
// Стенд: «Google» подменён page.route — отвечает с теми же заголовками CORS, что настоящий.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import { directDownloadUrl, fileNameFromDisposition } from '../../src/utils/linkDownload.js'

const DOC_ID = '1Te5tDpTemplateId_0123456789abcdef'
const DP_LINK = `https://docs.google.com/document/d/${DOC_ID}/edit?usp=sharing&ouid=100&rtpof=true&sd=true`
const EXPORT_URL = `https://docs.google.com/document/d/${DOC_ID}/export?format=docx`
const DP_NAME = 'Шаблон_ДП_с_правками_28-10-2026.docx'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

describe('Ссылка на документ → адрес файла', () => {
  it('Google Docs / Таблицы — выгрузка, Диск — drive.usercontent, прочее — как есть, сетевой путь — нет', () => {
    assert.equal(directDownloadUrl(DP_LINK), EXPORT_URL)
    assert.equal(directDownloadUrl(`https://docs.google.com/document/u/0/d/${DOC_ID}/edit`), EXPORT_URL)
    assert.equal(directDownloadUrl(`https://docs.google.com/spreadsheets/d/${DOC_ID}/edit#gid=0`),
      `https://docs.google.com/spreadsheets/d/${DOC_ID}/export?format=xlsx`)
    assert.equal(directDownloadUrl(`https://drive.google.com/file/d/${DOC_ID}/view?usp=sharing&resourcekey=0-k`),
      `https://drive.usercontent.google.com/download?id=${DOC_ID}&export=download&resourcekey=0-k`)
    assert.equal(directDownloadUrl(`https://drive.google.com/open?id=${DOC_ID}`),
      `https://drive.usercontent.google.com/download?id=${DOC_ID}&export=download`)
    assert.equal(directDownloadUrl('https://files.example.invalid/dp.docx'), 'https://files.example.invalid/dp.docx')
    assert.equal(directDownloadUrl('\\\\192.168.5.55\\SharA_Tender\\ДП.docx'), null)
    assert.equal(directDownloadUrl('javascript:alert(1)'), null)
    assert.equal(directDownloadUrl(''), null)
  })

  it('имя файла: filename* важнее filename, без пути и запрещённых знаков', () => {
    assert.equal(fileNameFromDisposition(`attachment; filename="______28-10-2026.docx"; filename*=UTF-8''${encodeURIComponent(DP_NAME)}`), DP_NAME)
    assert.equal(fileNameFromDisposition('attachment; filename="Шаблон ДП.docx"'), 'Шаблон ДП.docx')
    assert.equal(fileNameFromDisposition('attachment; filename=dp.docx'), 'dp.docx')
    assert.equal(fileNameFromDisposition('attachment; filename="..\\\\папка\\\\д|п?.docx"'), 'дп.docx')
    assert.equal(fileNameFromDisposition('inline'), '')
    assert.equal(fileNameFromDisposition(null), '')
  })
})

const launch = browserLaunchOptions()

describe('Окно письма подрядчикам: «Скачать ДП»', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  // google — как отвечает «Google»: 'ok' | 'html' (закрытый документ: страница входа) | 'blocked' (fetch падает, как при
  // ответе без CORS или уводе на вход другого домена; ответ без CORS-заголовков Playwright дополняет ими сам).
  async function open(query, { link = DP_LINK, google = 'ok' } = {}) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 }, acceptDownloads: true })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    const popups = []
    const downloads = []
    const requests = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept().catch(() => {}) })
    page.on('download', (d) => downloads.push(d))
    context.on('page', (p) => popups.push(p.url()))
    await context.route('https://docs.google.com/**', async (route) => {
      const req = route.request()
      requests.push({ url: req.url(), headers: await req.allHeaders() })
      const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Content-Disposition,Content-Length,Content-Type' }
      if (google === 'html') return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/html; charset=utf-8' }, body: '<html>Вход</html>' })
      if (google === 'blocked') return route.abort('failed')
      return route.fulfill({
        status: 200,
        headers: {
          ...cors,
          'content-type': DOCX,
          'content-disposition': `attachment; filename="______28-10-2026.docx"; filename*=UTF-8''${encodeURIComponent(DP_NAME)}`,
        },
        body: 'PK\u0003\u0004 docx',
      })
    })
    await page.addInitScript(() => {
      window.__leaving = 0
      window.addEventListener('beforeunload', () => { window.__leaving += 1 })
    })
    await page.goto(`${stand.url}?${query}`)
    await page.locator('table.tenders-registry > tbody > tr').first().waitFor({ timeout: 120000 })
    if (link != null) await page.evaluate((v) => window.__fakeDb.app_settings.push({ key: 'contracts_dp_template_link', value: v }), link)
    const url = page.url()
    const stayed = async () => {
      assert.deepEqual(popups, [], 'новых вкладок нет')
      assert.equal(page.url(), url)
      assert.equal(await page.evaluate(() => window.__leaving), 0, 'страница не начинала уходить')
    }
    return { page, errors, dialogs, downloads, requests, stayed, close: () => context.close().catch(() => {}) }
  }

  const letterModal = (page) => page.locator('.modal', { hasText: 'Шаблон письма для запроса КП' })
  const openLetter = async (page) => {
    await page.locator('table.tenders-registry > tbody > tr button[aria-label="Шаблон письма подрядчикам"]').first().click()
    await letterModal(page).waitFor({ timeout: 10000 })
  }
  const dpButton = (page) => letterModal(page).locator('button.letter-dp-btn')
  const OS = 'route=/tenders/construction&tenders=10&items=20&cps=2&latency=0'

  it('ОС: «Закрыть» нет, «Скачать ДП» качает файл под его именем — без перехода и вкладки, без куки и адреса страницы', async () => {
    const { page, errors, dialogs, downloads, requests, stayed, close } = await open(OS)
    try {
      await openLetter(page)
      const modal = letterModal(page)
      assert.equal(await modal.getByRole('button', { name: 'Закрыть', exact: true }).count(), 0, '«Закрыть» нет')
      await page.waitForFunction(() => !document.querySelector('button.letter-dp-btn[disabled]'))
      assert.equal(await dpButton(page).innerText(), 'Скачать ДП')
      // Кнопка — на месте «Закрыть»: слева от «Копировать письмо».
      const [dpBox, copyBox] = await Promise.all([dpButton(page).boundingBox(), modal.locator('button.btn-primary').boundingBox()])
      assert.ok(dpBox.x + dpBox.width <= copyBox.x, 'слева от «Копировать письмо»')
      assert.ok(Math.abs(dpBox.y - copyBox.y) < 4, 'в одной строке')

      const [download] = await Promise.all([page.waitForEvent('download'), dpButton(page).click()])
      assert.equal(download.suggestedFilename(), DP_NAME)
      assert.equal(requests.length, 1)
      assert.equal(requests[0].url, EXPORT_URL, 'адрес выгрузки, а не страница редактора')
      assert.equal(requests[0].headers.cookie, undefined, 'без куки')
      assert.equal(requests[0].headers.referer, undefined, 'без адреса страницы')
      await stayed()
      assert.equal(await letterModal(page).count(), 1, 'окно письма не закрылось')
      assert.equal(await letterModal(page).locator('.letter-dp-error').count(), 0)
      // Окно закрывается крестиком, как раньше.
      await letterModal(page).locator('.modal-close').click()
      await letterModal(page).waitFor({ state: 'detached' })
      assert.equal(downloads.length, 1)
      assert.deepEqual(dialogs, [])
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('документ закрыт (страница входа) или сервер не разрешает чтение — причина и «Открыть документ», страница на месте', async () => {
    for (const google of ['html', 'blocked']) {
      const { page, downloads, stayed, close } = await open(OS, { google })
      try {
        await openLetter(page)
        await page.waitForFunction(() => !document.querySelector('button.letter-dp-btn[disabled]'))
        await dpButton(page).click()
        const err = letterModal(page).locator('.letter-dp-error')
        await err.waitFor({ timeout: 10000 })
        const text = await err.innerText()
        assert.match(text, /^Не удалось скачать ДП: /, google)
        assert.match(text, google === 'html' ? /открывается страница, а не файл/ : /доступ открыт всем, у кого есть ссылка/)
        const a = err.locator('a', { hasText: 'Открыть документ' })
        assert.equal(await a.getAttribute('href'), DP_LINK)
        assert.equal(await a.getAttribute('target'), '_blank')
        assert.equal(await dpButton(page).isDisabled(), false, 'можно повторить')
        assert.equal(downloads.length, 0)
        await stayed()
      } finally { await close() }
    }
  })

  it('ссылки нет или это сетевой путь — кнопка неактивна, в подсказке — где её указать', async () => {
    for (const [link, hint] of [[null, /ещё не указан/], ['\\\\192.168.5.55\\SharA_Tender\\Шаблоны\\ДП.docx', /сетевым путём/]]) {
      const { page, errors, close } = await open(OS, { link })
      try {
        await openLetter(page)
        await page.waitForFunction(() => !/Загружаем/.test(document.querySelector('button.letter-dp-btn')?.title || 'Загружаем'))
        assert.equal(await dpButton(page).isDisabled(), true)
        assert.match(await dpButton(page).getAttribute('title'), hint)
        assert.deepEqual(errors, [])
      } finally { await close() }
    }
  })

  it('«Прочее» — как раньше: «Закрыть» на месте, «Скачать ДП» нет', async () => {
    const { page, errors, close } = await open('route=/tenders/other&tendersDept=other&tenders=9&items=20&cps=2&latency=0')
    try {
      await openLetter(page)
      const modal = letterModal(page)
      assert.equal(await dpButton(page).count(), 0)
      await modal.getByRole('button', { name: 'Закрыть', exact: true }).click()
      await modal.waitFor({ state: 'detached' })
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
