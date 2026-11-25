// «Путь к Signal» в карточке договора (интеграция с SIGNAL, 23.11.2026; пакет P5b; волна исправлений 24.11.2026: С-21, В-10, С-2).
// Стенд — tests/tender/ui/signal-stand.html (page=card, данные seed.js ?contracts=30, «сервер сверки» — signal-fake.js и надстройки
// signal-card-fake.js и signal-admin-fake.js, всё из памяти). Правила состояний и текстов — src/utils/signalPathRow.js, сервер и
// база — tests/osp-api, tests/db. Проверяем:
//   • состояния текстом: «сверено 23.11.2026», «ссылка принята, номер в папке не найден» (accepted), «ссылка не сверялась — данные
//     на …», «противоречие: …», «папка не видна в Signal», «файл не виден в Signal», «файл удалён в Signal», «корпус, очередь или
//     секция не совпали — проверьте», «предложена папка …» (только при праве правки); без интеграции — прежний SignalLinkCell;
//   • путь папки — ровно тот, что отдал сервер (он от границы объекта, С-21): ни имени корня или проекта, ни предков выше границы;
//   • с правом правки — «Сверить…» (окно сверки по договору) и «Отвязать» (подтверждение, ключ идемпотентности, версия и
//     ссылка окна; устаревшая версия — «Данные изменились — обновите»); без права правки — ни кнопок, ни предложения;
//   • запомненные названия объекта договора (С-2): сотрудник с правкой видит и удаляет СВОИ (чужих и других объектов нет),
//     администратор видит все с отметкой «конфликт»; без права правки — запроса и блока нет;
//   • «В папке: N файлов · данные на …» свёрнут по умолчанию; раскрыт — имя, версия, дата, «↗» в SIGNAL (<a target=_blank>,
//     только если сервер прислал url); подпапка — отдельным запросом; файл не скачивается через портал;
//   • сбой сервиса — строка как без сверки; телефон 390 px — без прокрутки вбок, список на всю ширину.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import * as signalText from '../../src/utils/signalPathRow.js'

// Через пространство имён: чего в модуле нет (старый код), то падает в своём тесте, а не рушит весь файл.
const { rowState, filesSummary, fileMeta, hasReviewWork, ruDate, ruDateTime, aliasesForObject } = signalText

const DATA_AT = '2026-11-23T11:00:00.000Z' // 14:00 по Москве

describe('Путь к Signal: правила подписей', () => {
  const data = (over) => ({ signalLink: 'https://signal.su10.ru/folder/x', state: 'verified', reason: 'confirmed', pending: false, dataAt: DATA_AT, ...over })
  it('даты — по Москве', () => {
    assert.equal(ruDate(DATA_AT), '23.11.2026')
    assert.equal(ruDateTime(DATA_AT), '23.11.2026 14:00')
    assert.equal(ruDate(null), '')
  })
  it('состояния текстом; «предложена папка» — только при праве правки', () => {
    assert.deepEqual(rowState(data()), { tone: 'ok', text: 'сверено 23.11.2026', why: '' })
    assert.match(rowState(data({ state: 'unverified', reason: 'unsupported_url' })).text, /^ссылка не сверялась — данные на 23\.11\.2026 14:00$/)
    assert.equal(rowState(data({ state: 'unverified', reason: 'unsupported_url' })).why, 'формат ссылки не поддерживается')
    assert.equal(rowState(data({ pending: true, state: 'verified' })).tone, 'neutral', 'ждёт обработки — как не сверенная')
    assert.equal(rowState(data({ state: 'conflict', reason: 'number_mismatch' })).text, 'противоречие: номер в папке не совпадает с номером договора')
    assert.equal(rowState(data({ state: 'attention', reason: 'not_visible' })).text, 'папка не видна в Signal')
    assert.equal(rowState(data({ state: 'missing', reason: 'deleted' })).text, 'файл удалён в Signal')
    const suggested = { signalLink: null, state: 'suggested', reason: 'none', dataAt: DATA_AT, candidates: [{ nodeId: 'n', path: 'Альфа / корп.1', status: 'open' }] }
    assert.equal(rowState(suggested, { canEdit: true }).text, 'предложена папка Альфа / корп.1')
    assert.equal(rowState(suggested, { canEdit: false }), null)
    assert.equal(rowState({ ...suggested, candidates: [{ nodeId: 'n', path: 'x', status: 'rejected' }] }, { canEdit: true }), null)
    assert.equal(rowState({ signalLink: null, state: 'none', reason: 'none' }, { canEdit: true }), null)
  })
  it('состояния волны исправлений: принята (зелёная), корпус не совпал, файл не виден, папка допсоглашения, недоступна, нет объекта; противоречия ДС и стороны', () => {
    const accepted = rowState(data({ state: 'accepted', reason: 'number_not_found' }))
    assert.deepEqual(accepted, { tone: 'ok', text: 'ссылка принята, номер в папке не найден', why: 'данные на 23.11.2026 14:00' })
    assert.equal(rowState(data({ state: 'attention', reason: 'building_mismatch' })).text, 'корпус, очередь или секция не совпали — проверьте')
    assert.equal(rowState(data({ state: 'attention', reason: 'building_mismatch' })).tone, 'warn')
    assert.equal(rowState(data({ state: 'attention', reason: 'kind_mismatch' })).text, 'папка относится к допсоглашению — проверьте')
    assert.equal(rowState(data({ state: 'attention', reason: 'file_not_visible' })).text, 'файл не виден в Signal', 'ссылка на файл (В-10)')
    assert.equal(rowState(data({ state: 'attention', reason: 'not_visible' })).text, 'папка не видна в Signal', 'ссылка на папку')
    assert.match(rowState(data({ state: 'attention', reason: 'что-то новое' })).text, /^требует внимания$/, 'неизвестная причина — без показа кода')
    assert.equal(rowState(data({ state: 'conflict', reason: 'ds_mismatch' })).text, 'противоречие: номер ДС не совпал с номером в названии папки')
    assert.equal(rowState(data({ state: 'conflict', reason: 'foreign_party' })).text, 'противоречие: в названии папки ИНН другой организации')
    const unavailable = rowState(data({ state: 'unverified', reason: 'unavailable' }))
    assert.deepEqual([unavailable.tone, unavailable.why], ['neutral', 'папка недоступна для сверки'])
    assert.equal(rowState(data({ state: 'unverified', reason: 'no_object' })).why, 'у договора не указан объект')
  })
  it('слова «удалена» про папку нет; файл — «удалён в Signal»', () => {
    const texts = ['attention', 'conflict', 'unverified', 'missing', 'verified'].map((state) => rowState(data({ state, reason: 'not_visible' }))?.text || '')
    assert.ok(!texts.some((t) => /папка удалена/i.test(t)))
  })
  it('сводка списка файлов и версия с датой', () => {
    const files = [{ kind: 'folder', name: 'П' }, { kind: 'item', name: 'a', version: 3, modifiedAt: '2026-11-12T09:00:00.000Z' }, { kind: 'item', name: 'b', deleted: true }]
    assert.equal(filesSummary(files, { dataAt: DATA_AT }), 'В папке: 1 файл, подпапок: 1 · данные на 23.11.2026 14:00')
    assert.equal(filesSummary([], { dataAt: null }), 'В папке файлов нет')
    assert.equal(filesSummary([{ kind: 'item' }, { kind: 'item' }, { kind: 'item' }], { more: true }), 'В папке: 3+ файла')
    assert.equal(fileMeta(files[1]), 'v3 · 12.11.2026')
    assert.equal(fileMeta({ name: 'x' }), '')
  })
  it('синонимы объекта договора (С-2): только свой объект', () => {
    const items = [{ id: 'a', text: 'СК-1', objectId: 'o1' }, { id: 'b', text: 'Нурлы', objectId: 'o2' }]
    assert.deepEqual(aliasesForObject(items, 'o1').map((a) => a.id), ['a'])
    assert.deepEqual(aliasesForObject(items, null), [])
  })
  it('«Сверить…» нужна, когда есть ссылка или открытое предложение', () => {
    assert.equal(hasReviewWork({ signalLink: 'https://x' }), true)
    assert.equal(hasReviewWork({ signalLink: null, candidates: [{ status: 'open' }] }), true)
    assert.equal(hasReviewWork({ signalLink: null, candidates: [{ status: 'rejected' }] }), false)
    assert.equal(hasReviewWork({ signalLink: '' }), false)
  })
})

const launch = browserLaunchOptions()
const BASE = 'page=card&contracts=30&latency=0&signal=1'
const PHONE = { width: 390, height: 800 }

describe('Путь к Signal в карточке договора', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  // Карточка договора contract в стенде signal-stand.html; extra — дополнительные параметры стенда.
  async function open(contract, extra = '', { viewport = { width: 1280, height: 900 }, wait = true } = {}) {
    const context = await browser.newContext({ locale: 'ru-RU', timezoneId: 'Europe/Moscow', viewport })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    const query = new URLSearchParams(`${BASE}&contract=${contract}`)
    for (const [k, v] of new URLSearchParams(extra)) query.set(k, v) // extra переопределяет основу (например, signal=down)
    await page.goto(`${stand.url.replace('index.html', 'signal-stand.html')}?${query}`)
    await page.locator('.info-row', { hasText: 'Путь к Signal' }).waitFor({ timeout: 120000 })
    if (wait) await page.waitForFunction(() => !document.querySelector('.info-row .info-value')?.textContent?.includes('Загрузка'))
    return { page, errors, close: () => context.close().catch(() => {}) }
  }
  const rowOf = (page) => page.locator('.info-row', { hasText: 'Путь к Signal' })
  const spr = (page) => rowOf(page).locator('.spr')
  const calls = (page, filter = () => true) => page.evaluate(() => window.__signal.calls).then((all) => all.filter(filter))
  const noScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

  it('сверено: путь папки ссылкой в новой вкладке, состояние текстом, «Сверить…» и «Отвязать» при праве правки', async () => {
    const { page, errors, close } = await open('ctr-16')
    try {
      await spr(page).locator('.spr-badge').waitFor()
      assert.equal(await spr(page).locator('.spr-badge').textContent(), 'сверено 23.11.2026')
      const path = spr(page).locator('a.spr-path')
      assert.equal(await path.textContent(), 'корп.1 / ДП 16-26', 'путь папки — как отдал сервер (от границы объекта), вместо исходной ссылки')
      assert.equal(await path.getAttribute('target'), '_blank')
      assert.match(await path.getAttribute('rel'), /noopener/)
      assert.match(await path.getAttribute('href'), /^https:\/\/signal\.su10\.ru\/folder\//)
      assert.equal(await spr(page).locator('button', { hasText: 'Сверить…' }).count(), 1)
      assert.equal(await spr(page).locator('button', { hasText: 'Отвязать' }).count(), 1)
      assert.equal(await page.locator('.fpath').count(), 0, 'прежней ячейки ссылки нет')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('состояния текстом: не сверялась, противоречие, не видна, файл удалён, ждёт сверки', async () => {
    const cases = [
      ['ctr-17', /^ссылка не сверялась — данные на 23\.11\.2026 14:00$/, 'папка не видна в последнем обходе'],
      ['ctr-19', /^противоречие: номер в папке не совпадает с номером договора$/, ''],
      ['ctr-20', /^папка не видна в Signal$/, ''],
      ['ctr-22', /^файл удалён в Signal$/, ''],
      ['ctr-28', /^ссылка не сверялась — данные на 23\.11\.2026 14:00$/, 'сверка ждёт обработки'],
    ]
    for (const [id, text, why] of cases) {
      const { page, errors, close } = await open(id)
      try {
        const badge = spr(page).locator('.spr-badge')
        await badge.waitFor()
        assert.match((await badge.textContent()).trim(), text, id)
        if (why) assert.equal(await spr(page).locator('.spr-why').textContent(), why, id)
        assert.ok(!/удалена/i.test(await rowOf(page).textContent()), `${id}: слова «удалена» нет`)
        assert.deepEqual(errors, [], id)
      } finally { await close() }
    }
  })

  it('предложенная папка — только при праве правки: «предложена папка …» и «Сверить…»; без права — как без Signal', async () => {
    const edit = await open('ctr-23')
    try {
      await spr(edit.page).locator('.spr-badge').waitFor()
      assert.match(await spr(edit.page).locator('.spr-badge').textContent(), /^предложена папка корп\.6 \/ ДП 23-26$/)
      assert.equal(await spr(edit.page).locator('button', { hasText: 'Сверить…' }).count(), 1)
      assert.equal(await spr(edit.page).locator('button', { hasText: 'Отвязать' }).count(), 0, 'ссылки нет — отвязывать нечего')
      assert.deepEqual(edit.errors, [])
    } finally { await edit.close() }
    for (const extra of ['&signalEdit=0', '&canEdit=0']) {
      const view = await open('ctr-23', extra)
      try {
        assert.equal((await rowOf(view.page).locator('.info-value').textContent()).trim(), '—', extra)
        assert.equal(await rowOf(view.page).locator('.spr-badge').count(), 0, extra)
        assert.deepEqual(view.errors, [], extra)
      } finally { await view.close() }
    }
  })

  it('нет ссылки и нет предложений — «—», как без Signal', async () => {
    const { page, errors, close } = await open('ctr-25')
    try {
      assert.equal((await rowOf(page).locator('.info-value').textContent()).trim(), '—')
      assert.equal(await rowOf(page).locator('button').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без права правки: состояние и файлы видны, «Сверить…» и «Отвязать» нет (и при canEdit сервера, и при роли)', async () => {
    for (const extra of ['&signalEdit=0', '&canEdit=0']) {
      const { page, errors, close } = await open('ctr-16', extra)
      try {
        await spr(page).locator('.spr-badge').waitFor()
        assert.equal(await spr(page).locator('.spr-badge').textContent(), 'сверено 23.11.2026', extra)
        assert.equal(await spr(page).locator('button', { hasText: 'Сверить…' }).count(), 0, extra)
        assert.equal(await spr(page).locator('button', { hasText: 'Отвязать' }).count(), 0, extra)
        assert.equal(await spr(page).locator('.spr-files-toggle').count(), 1, `${extra}: список файлов виден`)
        assert.deepEqual(errors, [], extra)
      } finally { await close() }
    }
  })

  it('«Отвязать»: подтверждение с версией и ссылкой окна и ключом; отмена ничего не шлёт; после — ссылки нет', async () => {
    const { page, errors, close } = await open('ctr-26')
    try {
      await spr(page).locator('.spr-badge').waitFor()
      await spr(page).locator('button', { hasText: 'Отвязать' }).click()
      const confirm = spr(page).locator('.spr-confirm')
      await confirm.waitFor()
      await confirm.locator('button', { hasText: 'Отмена' }).click()
      assert.equal(await spr(page).locator('.spr-confirm').count(), 0)
      assert.equal((await calls(page, (c) => c.path.endsWith('/unlink'))).length, 0, 'отмена: запроса нет')

      await spr(page).locator('button', { hasText: 'Отвязать' }).click()
      await spr(page).locator('.spr-confirm button', { hasText: 'Да, отвязать' }).click()
      await page.waitForFunction(() => !document.querySelector('.spr .spr-badge'))
      const [req] = await calls(page, (c) => c.path.endsWith('/unlink'))
      assert.equal(req.method, 'POST')
      assert.equal(req.path, '/api/signal/contracts/ctr-26/unlink')
      assert.equal(req.body.expectedSignalLink, 'https://signal.su10.ru/folder/00000000-0000-4000-8000-000000003026')
      assert.equal(req.body.expectedStateVersion, 1)
      assert.match(req.body.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      assert.equal((await rowOf(page).locator('.info-value').textContent()).trim(), '—', 'ссылка очищена')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Отвязать» на устаревшем состоянии (409): «Данные изменились — обновите», «Обновить» перечитывает', async () => {
    const { page, errors, close } = await open('ctr-26')
    try {
      await spr(page).locator('.spr-badge').waitFor()
      await page.evaluate(() => window.__signal.bump('ctr-26')) // другой человек изменил состояние
      await spr(page).locator('button', { hasText: 'Отвязать' }).click()
      await spr(page).locator('.spr-confirm button', { hasText: 'Да, отвязать' }).click()
      const msg = spr(page).locator('.spr-msg')
      await msg.waitFor()
      assert.match(await msg.textContent(), /^Данные изменились — обновите/)
      assert.equal(await spr(page).locator('.spr-confirm').count(), 0)
      assert.equal(await spr(page).locator('.spr-badge').count(), 1, 'ссылка осталась')
      await msg.locator('button', { hasText: 'Обновить' }).click()
      await page.waitForFunction(() => !document.querySelector('.spr .spr-msg'))
      // С новой версией отвязка проходит.
      await spr(page).locator('button', { hasText: 'Отвязать' }).click()
      await spr(page).locator('.spr-confirm button', { hasText: 'Да, отвязать' }).click()
      await page.waitForFunction(() => !document.querySelector('.spr .spr-badge'))
      const reqs = await calls(page, (c) => c.path.endsWith('/unlink'))
      assert.deepEqual(reqs.map((r) => r.body.expectedStateVersion), [1, 2])
      assert.notEqual(reqs[0].body.idempotencyKey, reqs[1].body.idempotencyKey, 'новая отвязка — новый ключ')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Сверить…» открывает окно сверки по договору без строки в таблице', async () => {
    const { page, errors, close } = await open('ctr-23')
    try {
      await spr(page).locator('button', { hasText: 'Сверить…' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      assert.ok((await calls(page, (c) => c.method === 'GET' && c.path === '/api/signal/contracts/ctr-23')).length >= 1)
      await dialog.locator('button', { hasText: 'Подтвердить' }).click()
      await dialog.waitFor({ state: 'detached' })
      // Ссылка сохранена, строка карточки показывает сверенную папку.
      await page.waitForFunction(() => document.querySelector('.spr .spr-badge')?.textContent === 'сверено 23.11.2026')
      assert.equal(await spr(page).locator('a.spr-path').textContent(), 'корп.6 / ДП 23-26')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('файлы: свёрнуты по умолчанию; раскрыты — имя, версия, дата, «↗» в Signal ссылкой в новой вкладке', async () => {
    const { page, errors, close } = await open('ctr-16')
    try {
      const toggle = spr(page).locator('.spr-files-toggle')
      await toggle.waitFor()
      assert.equal(await toggle.textContent(), 'В папке: 4 файла, подпапок: 1 · данные на 23.11.2026 14:00')
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
      assert.equal(await spr(page).locator('.spr-list').count(), 0, 'список свёрнут')

      await toggle.click()
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
      const files = spr(page).locator('.spr-list > li.spr-file')
      assert.equal(await files.count(), 5, 'четыре файла и один удалённый')
      const first = files.nth(0)
      assert.equal(await first.locator('.spr-file-name').textContent(), 'ДП_16-26.pdf')
      assert.equal(await first.locator('.spr-file-meta').textContent(), 'v3 · 12.11.2026')
      const out = first.locator('a.spr-out')
      assert.equal(await out.getAttribute('target'), '_blank')
      assert.match(await out.getAttribute('rel'), /noopener/)
      assert.match(await out.getAttribute('rel'), /noreferrer/)
      assert.equal(await out.getAttribute('href'), 'https://signal.su10.ru/file/00000000-0000-4000-8000-000000003102')
      assert.match(await out.getAttribute('aria-label'), /^Открыть в Signal: ДП_16-26\.pdf$/)
      const deleted = spr(page).locator('li.spr-file.is-deleted')
      assert.equal(await deleted.locator('.spr-file-meta').textContent(), 'удалён в Signal')
      assert.equal(await deleted.locator('a').count(), 0, 'у удалённого файла ссылки нет')

      await toggle.click()
      assert.equal(await spr(page).locator('.spr-list').count(), 0, 'свернули обратно')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«↗» только от сервера: адрес файла не настроен — ссылок нет; через портал ничего не скачивается', async () => {
    const { page, errors, close } = await open('ctr-16', '&sigFileLinks=0')
    try {
      await spr(page).locator('.spr-files-toggle').click()
      await spr(page).locator('li.spr-file').first().waitFor()
      assert.equal(await spr(page).locator('.spr-list a').count(), 0, 'url не пришёл — ссылок «↗» нет')
      assert.ok(await spr(page).locator('li.spr-file').count() >= 3)
      assert.deepEqual(errors, [])
    } finally { await close() }
    const withLinks = await open('ctr-16')
    try {
      const requests = []
      withLinks.page.on('request', (r) => requests.push(r.url()))
      let popups = 0
      withLinks.page.context().on('page', () => { popups++ })
      await spr(withLinks.page).locator('.spr-files-toggle').click()
      await spr(withLinks.page).locator('li.spr-folder button').click()
      await spr(withLinks.page).locator('li.spr-folder li.spr-file').first().waitFor()
      // Все «↗» — обычные ссылки в новой вкладке; нет ни S3-запросов, ни обработчиков скачивания.
      const hrefs = await spr(withLinks.page).locator('a[href]').evaluateAll((list) => list.map((a) => ({ href: a.href, target: a.target, rel: a.rel, download: a.hasAttribute('download') })))
      assert.ok(hrefs.length >= 4)
      for (const h of hrefs) {
        assert.equal(h.target, '_blank')
        assert.match(h.rel, /noopener/)
        assert.equal(h.download, false)
        assert.match(h.href, /^https:\/\/signal\.su10\.ru\//)
      }
      assert.deepEqual(requests.filter((u) => /s3|presign|download|blob:/i.test(u)), [], 'через портал файл не запрашивается')
      assert.equal(popups, 0, 'новых вкладок сам портал не открывал')
      assert.deepEqual(withLinks.errors, [])
    } finally { await withLinks.close() }
  })

  it('подпапка раскрывается отдельным запросом по nodeId, вложенная — следующим; повторное раскрытие запроса не шлёт', async () => {
    const { page, errors, close } = await open('ctr-16')
    try {
      await spr(page).locator('.spr-files-toggle').click()
      const folder = spr(page).locator('li.spr-folder').first()
      const btn = folder.locator('.spr-folder-btn').first()
      assert.equal(await btn.getAttribute('aria-expanded'), 'false')
      await btn.click()
      await folder.locator('li.spr-file').first().waitFor()
      assert.equal(await btn.getAttribute('aria-expanded'), 'true')
      assert.equal(await folder.locator('li.spr-file .spr-file-name').first().textContent(), 'Приложение 1 Календарный план.pdf')
      let sub = await calls(page, (c) => c.path === '/api/signal/contracts/ctr-16' && c.query.includes('nodeId='))
      assert.equal(sub.length, 1)
      assert.match(decodeURIComponent(sub[0].query), /nodeId=00000000-0000-4000-8000-000000003101/)

      await folder.locator('li.spr-folder .spr-folder-btn').click() // вложенная «Архив»
      await folder.locator('li.spr-folder li.spr-file .spr-file-name', { hasText: 'Архивная версия плана.pdf' }).waitFor()
      assert.equal((await calls(page, (c) => c.path === '/api/signal/contracts/ctr-16' && c.query.includes('nodeId='))).length, 2)

      await btn.click() // свернули
      assert.equal(await folder.locator('.spr-kids').count(), 0)
      await btn.click() // снова — из памяти
      await folder.locator('li.spr-file').first().waitFor()
      assert.equal((await calls(page, (c) => c.path === '/api/signal/contracts/ctr-16' && c.query.includes('nodeId='))).length, 2, 'повторно не запрашивали')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('сбой при раскрытии подпапки — строка с «Повторить», остальная карточка и список целы', async () => {
    const { page, errors, close } = await open('ctr-16', '&sigSubFail=1')
    try {
      await spr(page).locator('.spr-files-toggle').click()
      await spr(page).locator('.spr-folder-btn').first().click()
      const err = spr(page).locator('.spr-kids .spr-msg')
      await err.waitFor()
      assert.match(await err.textContent(), /временно недоступна/)
      assert.equal(await err.locator('button', { hasText: 'Повторить' }).count(), 1)
      assert.equal(await spr(page).locator('li.spr-file').count(), 5, 'файлы папки на месте')
      assert.equal(await spr(page).locator('.spr-badge').textContent(), 'сверено 23.11.2026')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Показаны не все» — когда сервер усёк список; сумма файлов с плюсом', async () => {
    const { page, errors, close } = await open('ctr-16', '&sigMore=1')
    try {
      const toggle = spr(page).locator('.spr-files-toggle')
      assert.match(await toggle.textContent(), /^В папке: 4\+ файла/)
      await toggle.click()
      assert.match(await spr(page).locator('.spr-more').textContent(), /остальное в Signal/)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('сбой сервиса: строка как без Signal — исходная ссылка, ни ошибки на страницу, ни пропавшей карточки', async () => {
    const { page, errors, close } = await open('ctr-16', '&signal=down')
    try {
      await page.waitForFunction(() => window.__signal.calls.some((c) => c.path === '/api/signal/contracts/ctr-16'))
      await page.waitForFunction(() => !!document.querySelector('.info-row .fpath'))
      assert.equal(await rowOf(page).locator('.spr-badge').count(), 0)
      assert.equal(await rowOf(page).locator('.fpath').count(), 1, 'прежний SignalLinkCell')
      assert.match(await rowOf(page).locator('.fpath').textContent(), /signal\.su10\.ru/)
      assert.equal(await page.locator('.info-row', { hasText: 'Путь к папке' }).count(), 1, 'остальная карточка на месте')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без интеграции — как раньше: выключена, нет маршрутов, нет доступа', async () => {
    for (const extra of ['&signal=off', '&signal=missing']) {
      const { page, errors, close } = await open('ctr-16', extra)
      try {
        await page.waitForFunction(() => !!document.querySelector('.info-row .fpath'))
        assert.equal(await rowOf(page).locator('.spr').count(), 0, extra)
        assert.equal(await rowOf(page).locator('.fpath').count(), 1, extra)
        assert.equal(await rowOf(page).locator('a').first().getAttribute('target'), '_blank', extra)
        assert.equal((await calls(page, (c) => c.path.startsWith('/api/signal/contracts'))).length, 0, `${extra}: данных договора не запрашивали`)
        assert.equal((await calls(page, (c) => c.path === '/api/signal/aliases')).length, 0, `${extra}: синонимов не запрашивали, блока нет`)
        assert.equal(await page.locator('.spr-aliases').count(), 0, extra)
        assert.deepEqual(errors, [], extra)
      } finally { await close() }
    }
    // Без ссылки и без интеграции — «—».
    const none = await open('ctr-25', '&signal=off')
    try {
      assert.equal((await rowOf(none.page).locator('.info-value').textContent()).trim(), '—')
      assert.deepEqual(none.errors, [])
    } finally { await none.close() }
  })

  it('телефон 390 px: на всю ширину, имя переносится, версия и дата — второй строкой, без прокрутки вбок', async () => {
    const { page, errors, close } = await open('ctr-16', '', { viewport: PHONE })
    try {
      await spr(page).locator('.spr-badge').waitFor()
      await spr(page).locator('.spr-files-toggle').click()
      await spr(page).locator('li.spr-file').first().waitFor()
      assert.equal(await noScroll(page), true, 'нет прокрутки вбок')
      const long = spr(page).locator('li.spr-file', { hasText: 'Ведомость_объёмов_работ' })
      const name = await long.locator('.spr-file-name').boundingBox()
      const meta = await long.locator('.spr-file-meta').boundingBox()
      const list = await spr(page).locator('.spr-list').first().boundingBox()
      const cell = await rowOf(page).locator('.info-value').boundingBox()
      assert.ok(name.height > 40, `длинное имя перенесено на несколько строк: ${name.height}px`)
      assert.ok(meta.y >= name.y + name.height - 1, 'версия и дата — под именем')
      assert.ok(Math.abs(list.width - cell.width) <= 2 && list.width >= PHONE.width - 100, `список на всю ширину значения: ${list.width}px из ${cell.width}px`)
      assert.ok(list.x + list.width <= PHONE.width, 'справа не выходит за экран')
      const arrow = await long.locator('a.spr-out').boundingBox()
      assert.ok(arrow.width >= 32 && arrow.height >= 32, 'до «↗» достаёт палец')
      const btn = await spr(page).locator('button', { hasText: 'Сверить…' }).boundingBox()
      assert.ok(btn.x + btn.width <= PHONE.width)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('телефон: длинный путь и подтверждение отвязки не раздвигают страницу', async () => {
    const { page, errors, close } = await open('ctr-29', '', { viewport: PHONE })
    try {
      await spr(page).locator('.spr-badge').waitFor()
      assert.equal(await spr(page).locator('a.spr-path').count(), 0, 'ссылка — не адрес сайта, а путь: ссылкой не делаем')
      await spr(page).locator('button', { hasText: 'Отвязать' }).click()
      await spr(page).locator('.spr-confirm').waitFor()
      assert.equal(await noScroll(page), true)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  // ── Волна исправлений: В-10, §1, С-21, С-2 ────────────────────────────────────────────────────────────────────────────────────
  it('ссылка на файл и на папку (В-10): «файл удалён в Signal», «файл не виден в Signal», «папка не видна в Signal» — каждое своими словами', async () => {
    const cases = [
      ['ctr-22', 'файл удалён в Signal'],
      ['ctr-18', 'файл не виден в Signal'], // ДС: ссылка на файл, который перестал быть виден
      ['ctr-20', 'папка не видна в Signal'],
    ]
    for (const [id, text] of cases) {
      const { page, errors, close } = await open(id)
      try {
        const badge = spr(page).locator('.spr-badge')
        await badge.waitFor()
        assert.equal((await badge.textContent()).trim(), text, id)
        assert.equal(await badge.evaluate((b) => b.classList.contains('is-warn')), true, `${id}: жёлтая подпись`)
        assert.equal(await spr(page).locator('button', { hasText: 'Сверить…' }).count(), 1, `${id}: перепроверить можно`)
        assert.deepEqual(errors, [], id)
      } finally { await close() }
    }
  })

  it('состояния волны: принята (зелёная, с датой данных), корпус не совпал, папка допсоглашения, противоречие ДС, недоступна, нет объекта', async () => {
    const cases = [
      ['ctr-13', 'ok', /^ссылка принята, номер в папке не найден$/, 'данные на 23.11.2026 14:00'],
      ['ctr-14', 'warn', /^корпус, очередь или секция не совпали — проверьте$/, ''],
      ['ctr-21', 'warn', /^папка относится к допсоглашению — проверьте$/, ''],
      ['ctr-30', 'warn', /^противоречие: номер ДС не совпал с номером в названии папки$/, ''],
      ['ctr-24', 'neutral', /^ссылка не сверялась — данные на 23\.11\.2026 14:00$/, 'папка недоступна для сверки'],
      ['ctr-27', 'neutral', /^ссылка не сверялась — данные на 23\.11\.2026 14:00$/, 'у договора не указан объект'],
    ]
    for (const [id, tone, text, why] of cases) {
      const { page, errors, close } = await open(id)
      try {
        const badge = spr(page).locator('.spr-badge')
        await badge.waitFor()
        assert.match((await badge.textContent()).trim(), text, id)
        assert.equal(await badge.evaluate((b, t) => b.classList.contains(`is-${t}`), tone), true, `${id}: тон ${tone}`)
        if (why) assert.equal(await spr(page).locator('.spr-why').textContent(), why, id)
        assert.deepEqual(errors, [], id)
      } finally { await close() }
    }
    // Без права правки состояния те же, кнопок нет.
    const view = await open('ctr-14', '&signalEdit=0')
    try {
      assert.equal((await spr(view.page).locator('.spr-badge').textContent()).trim(), 'корпус, очередь или секция не совпали — проверьте')
      assert.equal(await spr(view.page).locator('button', { hasText: 'Сверить…' }).count(), 0)
    } finally { await view.close() }
  })

  it('путь от границы объекта (С-21): карточка показывает путь ровно так, как отдал сервер — имя корня, проекта и папок выше границы не дописывается', async () => {
    const { page, errors, close } = await open('ctr-16')
    try {
      await spr(page).locator('a.spr-path').waitFor()
      const shown = (await spr(page).locator('a.spr-path').textContent()).trim()
      assert.equal(shown, 'корп.1 / ДП 16-26')
      // То, что пришло с сервера (stand отдаёт путь от границы), не продолжено ничем слева: ни проекта, ни корня.
      const text = await spr(page).textContent()
      assert.doesNotMatch(text, /Альфа|Северный квартал|Договора подряда|Бета/, 'чужих и верхних имён в строке нет')
      assert.equal(await spr(page).locator('a.spr-path').getAttribute('title'), 'https://signal.su10.ru/folder/00000000-0000-4000-8000-000000003016', 'подсказка — ссылка договора, а не склеенный путь')
      // Подпапки: имена как есть, без пути предков.
      await spr(page).locator('.spr-files-toggle').click()
      await spr(page).locator('li.spr-folder .spr-folder-btn').first().click()
      await spr(page).locator('li.spr-folder li.spr-file').first().waitFor()
      assert.doesNotMatch(await spr(page).locator('.spr-files').textContent(), /корп\.1 \/|ДП 16-26 \//, 'в списке файлов пути предков не склеиваются')
      assert.deepEqual(errors, [])
    } finally { await close() }
    // Путь, который сервер отдал глубже границы, тоже не усекается и не продолжается: что пришло — то и видно.
    const deep = await open('ctr-26')
    try {
      await spr(deep.page).locator('a.spr-path').waitFor()
      assert.equal((await spr(deep.page).locator('a.spr-path').textContent()).trim(), 'корп.2 / ДП 26-26')
    } finally { await deep.close() }
  })

  const aliasBlock = (page) => spr(page).locator('.spr-aliases')
  const aliasCalls = (page) => calls(page, (c) => c.path.startsWith('/api/signal/aliases'))

  it('запомненные названия объекта (С-2): сотрудник с правкой видит только свои для объекта договора, удаляет с подтверждением; после — состояние перечитывается', async () => {
    // ctr-17 — объект 1; у сотрудника свои названия: объект 1 (СК-1) и объект 2 (Нурлы-2); чужое сервер ему не отдаёт.
    const { page, errors, close } = await open('ctr-17', '&sigAdmin=0&sigAliasMore=1')
    try {
      const block = aliasBlock(page)
      await block.waitFor()
      assert.equal((await block.locator('.spr-files-toggle').textContent()).trim(), 'Запомненные названия объекта: 1', 'только свои и только для объекта договора')
      assert.equal(await block.locator('.spr-files-toggle').getAttribute('aria-expanded'), 'false', 'свёрнуто')
      assert.equal(await block.locator('.spr-alias').count(), 0)
      await block.locator('.spr-files-toggle').click()
      assert.deepEqual(await block.locator('.spr-alias-text').allTextContents(), ['СК-1'])
      assert.equal((await aliasCalls(page)).length, 1, 'один запрос — GET /aliases')
      assert.equal((await aliasCalls(page))[0].method, 'GET')

      const loadsBefore = (await calls(page, (c) => c.method === 'GET' && c.path === '/api/signal/contracts/ctr-17')).length
      await block.locator('.spr-alias', { hasText: 'СК-1' }).locator('button', { hasText: 'Удалить' }).click()
      const confirm = block.locator('.spr-confirm')
      assert.match(await confirm.textContent(), /Удалить название «СК-1»\? Сверка договоров этого объекта пересчитается без него\./)
      await confirm.locator('button', { hasText: 'Отмена' }).click()
      assert.equal(await block.locator('.spr-confirm').count(), 0)
      assert.equal((await aliasCalls(page)).filter((c) => c.method === 'DELETE').length, 0, 'отмена — ничего не ушло')

      await block.locator('.spr-alias', { hasText: 'СК-1' }).locator('button', { hasText: 'Удалить' }).click()
      await block.locator('.spr-confirm button', { hasText: 'Да, удалить' }).click()
      await page.waitForFunction(() => !document.querySelector('.spr .spr-aliases'))
      const [del] = (await aliasCalls(page)).filter((c) => c.method === 'DELETE')
      assert.equal(del.path, '/api/signal/aliases/al-2')
      assert.ok((await calls(page, (c) => c.method === 'GET' && c.path === '/api/signal/contracts/ctr-17')).length > loadsBefore, 'состояние договора перечитано')
      assert.equal(await spr(page).locator('.spr-badge').count(), 1, 'остальная строка на месте')
      assert.deepEqual(errors, [])
    } finally { await close() }
    // Другой объект (ctr-16 — объект 2): его своё название.
    const other = await open('ctr-16', '&sigAdmin=0&sigAliasMore=1')
    try {
      await aliasBlock(other.page).waitFor()
      await aliasBlock(other.page).locator('.spr-files-toggle').click()
      assert.deepEqual(await aliasBlock(other.page).locator('.spr-alias-text').allTextContents(), ['Нурлы-2'])
    } finally { await other.close() }
  })

  it('запомненные названия: отказ сервера при удалении — сообщение в строке, название на месте; нет своих названий у объекта — блока нет', async () => {
    const { page, errors, close } = await open('ctr-17', '&sigAdmin=0&sigAliasMore=1')
    try {
      await aliasBlock(page).waitFor()
      await aliasBlock(page).locator('.spr-files-toggle').click()
      // Название успели удалить в другом окне: сервер отвечает 404.
      await page.evaluate(() => { const a = window.__signalAdmin.aliases; a.splice(a.findIndex((x) => x.id === 'al-2'), 1) })
      await aliasBlock(page).locator('button', { hasText: 'Удалить' }).click()
      await aliasBlock(page).locator('.spr-confirm button', { hasText: 'Да, удалить' }).click()
      const msg = spr(page).locator('.spr-msg.is-error')
      await msg.waitFor()
      assert.match(await msg.textContent(), /Название не найдено/)
      assert.equal(await aliasBlock(page).locator('.spr-alias-text').count(), 1, 'название осталось в списке')
      assert.deepEqual(errors, [])
    } finally { await close() }
    // ctr-10 из сценария signal-fake.js здесь не нужен: у договора без своих названий (sigAliasMore=0 → у сотрудника их нет) блока нет.
    const none = await open('ctr-17', '&sigAdmin=0')
    try {
      await none.page.waitForFunction(() => window.__signal.calls.some((c) => c.path === '/api/signal/aliases'))
      assert.equal(await aliasBlock(none.page).count(), 0)
      assert.equal(await spr(none.page).locator('.spr-badge').count(), 1)
      assert.deepEqual(none.errors, [])
    } finally { await none.close() }
  })

  it('запомненные названия: администратор видит все названия объекта с отметкой «конфликт»; без права правки — запроса и блока нет', async () => {
    const { page, errors, close } = await open('ctr-17', '&sigAliasMore=1&sigAliasConflict=1')
    try {
      await aliasBlock(page).waitFor()
      assert.equal((await aliasBlock(page).locator('.spr-files-toggle').textContent()).trim(), 'Запомненные названия объекта: 3', 'все названия объекта 1, чужие и свои')
      await aliasBlock(page).locator('.spr-files-toggle').click()
      assert.deepEqual(await aliasBlock(page).locator('.spr-alias-text').allTextContents(), ['Северный кв. 1', 'СК-1', 'Нурлы корп. А'])
      const marked = aliasBlock(page).locator('.spr-alias.is-conflict')
      assert.equal(await marked.count(), 1)
      assert.match(await marked.textContent(), /Нурлы корп\. А.*конфликт/)
      assert.deepEqual(errors, [])
    } finally { await close() }
    for (const extra of ['&signalEdit=0&sigAliasMore=1', '&canEdit=0&sigAliasMore=1']) {
      const view = await open('ctr-17', extra)
      try {
        await spr(view.page).locator('.spr-badge').waitFor()
        await view.page.waitForTimeout(300)
        assert.equal((await aliasCalls(view.page)).length, 0, `${extra}: без права правки синонимы не запрашиваются`)
        assert.equal(await aliasBlock(view.page).count(), 0, extra)
        assert.deepEqual(view.errors, [], extra)
      } finally { await view.close() }
    }
  })

  it('телефон 390 px: запомненные названия и подтверждение удаления не раздвигают страницу, кнопки в пределах экрана', async () => {
    const { page, errors, close } = await open('ctr-17', '&sigAdmin=0&sigAliasMore=1', { viewport: PHONE })
    try {
      await aliasBlock(page).waitFor()
      await aliasBlock(page).locator('.spr-files-toggle').click()
      await aliasBlock(page).locator('button', { hasText: 'Удалить' }).click()
      await aliasBlock(page).locator('.spr-confirm').waitFor()
      assert.equal(await noScroll(page), true, 'нет прокрутки вбок')
      for (const b of await aliasBlock(page).locator('button').all()) {
        const box = await b.boundingBox()
        assert.ok(box.x + box.width <= PHONE.width, 'справа кнопка не выходит за экран')
      }
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
