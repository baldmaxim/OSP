// Версии файлов в списке (S3DocumentList versions; ВОР в окне «ВОРы и РД», решение пользователя 26.11.2026): строка — текущая версия
// с отметкой «Версия N», прежние раскрываются под ней; новая версия — кнопкой у файла или из «Загрузить» (похожее имя — выбор);
// строку можно перетащить на другой файл (станет его версией) и вернуть в самостоятельные — перетаскиванием или кнопкой «Версии»
// (телефон); удалили версию — номера подряд, порядок прежний. База без колонки — список как прежде. Стенд /stand/file-list?versions=1
// (прежний портал: правки строк — через фейковую базу; путь osp-api — tests/osp-api/server.test.mjs «версии файлов»).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const launch = browserLaunchOptions()

describe('Версии файлов в списке ВОР', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open({ query = '', viewport = { width: 1400, height: 900 }, versions = '1' } = {}) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    const dialogs = []
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.goto(`${stand.url}?route=/stand/file-list&versions=${versions}&latency=10${query}`)
    await page.locator('.s3-doc-table').waitFor({ timeout: 120000 })
    return { context, page, errors, dialogs, close: () => context.close() }
  }
  // Строки таблицы сверху вниз: «имя · отметка версии».
  const rows = (page) => page.locator('.s3-doc-table tbody tr:not(.s3-ver-edit-row)').evaluateAll((trs) => trs.map((tr) => {
    const name = tr.querySelector('.s3-ver-file')?.textContent || tr.querySelector('.s3-doc-name')?.textContent || ''
    const chip = tr.querySelector('.s3-ver-chip')?.textContent || ''
    return chip ? `${name} · ${chip}` : name
  }))
  // Дождаться вида таблицы (после правки список перечитывается).
  const waitRows = async (page, expected, timeout = 10000) => {
    const until = Date.now() + timeout
    let got
    do {
      got = await rows(page)
      if (JSON.stringify(got) === JSON.stringify(expected)) return got
      await page.waitForTimeout(100)
    } while (Date.now() < until)
    return got
  }
  const docs = (page) => page.evaluate(() => window.__fakeDb.s3_documents.filter((d) => d.owner_id === 'tender-v')
    .map((d) => ({ id: d.id, name: d.file_name, group: d.version_group_id ?? null })))
  const rowOf = (page, name) => page.locator('.s3-doc-table tbody tr', { has: page.locator('.s3-ver-file', { hasText: name }) })
  const xlsx = (name) => ({ name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('PK test') })

  it('строка — текущая версия с отметкой; прежние — по кнопке, под ней; одиночный файл без отметки', async () => {
    const { page, errors, close } = await open()
    try {
      assert.deepEqual(await rows(page), ['ВОР фасад 2026-10-23.xlsx · Версия 2', 'ВОР кровля.xlsx', 'ВОР ОВ.xlsx'])
      const toggle = rowOf(page, 'ВОР фасад 2026-10-23.xlsx').getByRole('button', { name: 'Все 2 версии' })
      await toggle.click()
      assert.deepEqual(await rows(page), ['ВОР фасад 2026-10-23.xlsx · Версия 2', 'ВОР фасад 2026-10-09.xlsx · Версия 1', 'ВОР кровля.xlsx', 'ВОР ОВ.xlsx'])
      assert.equal(await page.locator('tr.s3-ver-old').count(), 1, 'прежняя версия — приглушённой строкой')
      // Кнопка новой версии — только у текущей; «Версии» — у каждой строки.
      assert.equal(await rowOf(page, 'ВОР фасад 2026-10-09.xlsx').getByRole('button', { name: /Загрузить новую версию/ }).count(), 0)
      assert.equal(await rowOf(page, 'ВОР фасад 2026-10-09.xlsx').getByRole('button', { name: /^Версии файла/ }).count(), 1)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('новая версия кнопкой у файла: в той же группе, стала текущей, группа раскрыта — видно 1, 2, 3', async () => {
    const { page, errors, close } = await open()
    try {
      const chooser = page.waitForEvent('filechooser')
      await rowOf(page, 'ВОР фасад 2026-10-23.xlsx').getByRole('button', { name: /Загрузить новую версию/ }).click()
      await (await chooser).setFiles(xlsx('ВОР фасад 2026-11-20.xlsx'))
      const three = ['ВОР фасад 2026-11-20.xlsx · Версия 3', 'ВОР фасад 2026-10-23.xlsx · Версия 2', 'ВОР фасад 2026-10-09.xlsx · Версия 1', 'ВОР кровля.xlsx', 'ВОР ОВ.xlsx']
      assert.deepEqual(await waitRows(page, three), three)
      const added = (await docs(page)).find((d) => d.name === 'ВОР фасад 2026-11-20.xlsx')
      assert.equal(added.group, 'grp-fasad')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('«Загрузить»: похожее имя — выбор «новая версия / отдельный файл»; непохожее — сразу отдельным', async () => {
    const { page, errors, close } = await open()
    try {
      let chooser = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: 'Загрузить', exact: true }).click()
      await (await chooser).setFiles([xlsx('ВОР ОВ изм.1.xlsx'), xlsx('ВОР ВК.xlsx')])
      const plan = page.locator('.s3-ver-plan')
      await plan.waitFor({ timeout: 5000 })
      assert.equal(await plan.getByLabel('Как загрузить «ВОР ОВ изм.1.xlsx»').inputValue(), 'vo-1', 'подсказка — версия «ВОР ОВ»')
      assert.equal(await plan.getByLabel('Как загрузить «ВОР ВК.xlsx»').inputValue(), '', 'другое имя — отдельный файл')
      assert.match(await plan.innerText(), /станет версией 2/)
      await plan.getByRole('button', { name: 'Загрузить' }).click()
      await page.locator('.s3-ver-chip', { hasText: 'Версия 2' }).nth(1).waitFor({ timeout: 10000 })
      const all = await docs(page)
      const ov = all.find((d) => d.id === 'vo-1')
      assert.ok(ov.group, 'у прежнего «ВОР ОВ» заведена группа')
      assert.equal(all.find((d) => d.name === 'ВОР ОВ изм.1.xlsx').group, ov.group)
      assert.equal(all.find((d) => d.name === 'ВОР ВК.xlsx').group, null, 'отдельный файл — без группы')

      // Совсем непохожий файл — без лишнего шага.
      chooser = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: 'Загрузить', exact: true }).click()
      await (await chooser).setFiles(xlsx('Пояснительная записка.xlsx'))
      await rowOf(page, 'Пояснительная записка.xlsx').waitFor({ timeout: 10000 })
      assert.equal(await page.locator('.s3-ver-plan').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('перетащили файл на другой — стал его версией (по дате загрузки), затем вытащили в самостоятельные', async () => {
    const { page, errors, dialogs, close } = await open()
    try {
      await rowOf(page, 'ВОР кровля.xlsx').dragTo(rowOf(page, 'ВОР фасад 2026-10-23.xlsx'))
      await page.locator('.s3-ver-chip', { hasText: 'Версия 3' }).waitFor({ timeout: 10000 })
      assert.match(dialogs.at(-1), /Сделать «ВОР кровля.xlsx» версией файла «ВОР фасад 2026-10-23.xlsx»\? Он станет версией 2 из 3/)
      assert.equal((await docs(page)).find((d) => d.id === 'vk-1').group, 'grp-fasad')
      // Загружен раньше текущей — встал вторым; текущая осталась текущей.
      const linked = ['ВОР фасад 2026-10-23.xlsx · Версия 3', 'ВОР кровля.xlsx · Версия 2', 'ВОР фасад 2026-10-09.xlsx · Версия 1', 'ВОР ОВ.xlsx']
      assert.deepEqual(await waitRows(page, linked), linked)

      // Тянем прежнюю версию — пока тянем, под таблицей полоса «самостоятельный файл»; бросаем на неё.
      const box = await rowOf(page, 'ВОР кровля.xlsx').boundingBox()
      await page.mouse.move(box.x + 30, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + 60, box.y + box.height / 2 + 6, { steps: 5 })
      const zone = page.locator('.s3-ver-standalone')
      await zone.waitFor({ timeout: 5000 })
      const zb = await zone.boundingBox()
      await page.mouse.move(zb.x + zb.width / 2, zb.y + zb.height / 2, { steps: 8 })
      await page.mouse.up()
      await page.waitForFunction(() => window.__fakeDb.s3_documents.find((d) => d.id === 'vk-1').version_group_id !== 'grp-fasad')
      assert.match(dialogs.at(-1), /самостоятельным файлом/)
      const after = ['ВОР фасад 2026-10-23.xlsx · Версия 2', 'ВОР фасад 2026-10-09.xlsx · Версия 1', 'ВОР кровля.xlsx', 'ВОР ОВ.xlsx']
      assert.deepEqual(await waitRows(page, after), after)
      assert.equal(await page.locator('.s3-doc-empty').count(), 0, 'перечитывание таблицу не прятало')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без мыши (телефон): кнопка «Версии» — выбор файла или «самостоятельный»', async () => {
    const { page, errors, close } = await open({ viewport: { width: 390, height: 844 } })
    try {
      await rowOf(page, 'ВОР ОВ.xlsx').getByRole('button', { name: /^Версии файла/ }).click()
      const editor = page.locator('.s3-ver-edit')
      await editor.getByLabel(/Версия файла «ВОР фасад 2026-10-23.xlsx» — станет версией 1 из 3/).check()
      await editor.getByRole('button', { name: 'Сохранить' }).click()
      await page.waitForFunction(() => window.__fakeDb.s3_documents.find((d) => d.id === 'vo-1').version_group_id === 'grp-fasad')
      await page.locator('.s3-ver-chip', { hasText: 'Версия 3' }).waitFor({ timeout: 10000 })

      await rowOf(page, 'ВОР ОВ.xlsx').getByRole('button', { name: /^Версии файла/ }).click()
      await page.locator('.s3-ver-edit').getByLabel('Самостоятельный файл').check()
      await page.locator('.s3-ver-edit').getByRole('button', { name: 'Сохранить' }).click()
      await page.waitForFunction(() => window.__fakeDb.s3_documents.find((d) => d.id === 'vo-1').version_group_id !== 'grp-fasad')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('удалили текущую версию — текущей стала предыдущая; номера подряд', async () => {
    const { page, errors, dialogs, close } = await open()
    try {
      await rowOf(page, 'ВОР фасад 2026-10-23.xlsx').getByRole('button', { name: 'Удалить' }).click()
      await page.waitForFunction(() => !window.__fakeDb.s3_documents.some((d) => d.id === 'vf-2'))
      assert.match(dialogs.at(-1), /Удалить версию 2 «ВОР фасад 2026-10-23.xlsx»\? Текущей станет версия 1 «ВОР фасад 2026-10-09.xlsx»/)
      const left = ['ВОР кровля.xlsx', 'ВОР фасад 2026-10-09.xlsx', 'ВОР ОВ.xlsx']
      assert.deepEqual(await waitRows(page, left), left, 'одна версия — обычный файл')
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('база без колонки версий: список как прежде — без отметок, кнопок версий и перетаскивания строк', async () => {
    const { page, errors, close } = await open({ versions: 'nocol' })
    try {
      assert.equal(await page.locator('.s3-ver-chip').count(), 0)
      assert.equal(await page.getByRole('button', { name: /^Версии файла|Загрузить новую версию/ }).count(), 0)
      assert.equal(await page.locator('.s3-doc-table tr[draggable="true"]').count(), 0)
      assert.equal(await page.locator('.s3-doc-table tbody tr').count(), 4)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })

  it('без права правки: версии видны, менять нельзя', async () => {
    const { page, errors, close } = await open({ query: '&canEdit=0' })
    try {
      assert.equal(await page.locator('.s3-ver-chip').count(), 1)
      assert.equal(await page.getByRole('button', { name: /^Версии файла|Загрузить новую версию|Удалить/ }).count(), 0)
      assert.equal(await page.locator('.s3-doc-table tr[draggable="true"]').count(), 0)
      assert.deepEqual(errors, [])
    } finally { await close() }
  })
})
