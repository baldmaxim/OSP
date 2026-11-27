// Карточка объекта → «Документы» (/general/objects/:id), просьба пользователя 26.11.2026:
//   «Не работает возможность перетаскивать расположение блоков в Документы» — отпущенная над приложением соседней ДС (или
//   над вложенным приложением соседа) строка молча оставалась на месте, хотя линия-подсказка рисовалась; ручка — две
//   бледные точки 18×22 px;
//   «Убери возможность добавлять приложение к приложению к приложению» — третьего уровня нет ни в таблице, ни на телефоне;
//   «Приложение должно немного визуально быть смещено вправо», «более видным разграничение между смысловыми блоками»;
//   «проверь что загрузка всегда проходит… чтобы всё загружалось по порядку» — новое приложение вставало в начало или
//   в середину (order_number = число документов + 1 при соседях 10/20/30), окно документа крутило бесконечный цикл
//   перерисовок (onUploadingChange), двойной щелчок «Сохранить» создавал две строки, после сохранения карточка целиком
//   заменялась «Загрузкой…».
// Чистые функции (src/utils/objectDocTree.js) — без браузера; остальное — стенд в Chromium.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  nextOrderNumber, resolveDropTarget, reorderUpdates, docLevel, canAddAttachmentAtLevel, neighbourOf, byDocOrder,
} from '../../src/utils/objectDocTree.js'

let minute = 0
const docRow = (id, extra) => ({
  id, object_id: 'o-1', parent_document_id: null, document_type: 'attachment', name: id, document_number: null, document_date: null,
  notes: null, order_number: 0, created_at: `2026-10-01T09:${String(minute++).padStart(2, '0')}:00Z`, signed: null, editable: null, ...extra,
})
// Приложения договора уже переставлялись (10/20/30) — как на рабочем объекте после первого перетаскивания.
const DOCS = [
  docRow('gc', { document_type: 'general_contract', name: 'Договор генподряда', document_number: 'ГП-7' }),
  docRow('gc-a1', { parent_document_id: 'gc', name: 'График работ', document_number: 'Прил. 1', order_number: 10 }),
  docRow('gc-a1-1', { parent_document_id: 'gc-a1', name: 'Ведомость к графику', document_number: 'Прил. 1.1', order_number: 10 }),
  docRow('gc-a2', { parent_document_id: 'gc', name: 'Смета', document_number: 'Прил. 2', order_number: 20 }),
  docRow('gc-a3', { parent_document_id: 'gc', name: 'Протокол', document_number: 'Прил. 3', order_number: 30 }),
  docRow('ds1', { document_type: 'additional_agreement', name: 'ДС № 1', notes: 'Перенос сроков', order_number: 10 }),
  docRow('ds1-a1', { parent_document_id: 'ds1', name: 'График', document_number: 'Прил. 1', order_number: 10 }),
  docRow('ds2', { document_type: 'additional_agreement', name: 'ДС № 2', notes: 'Доп. работы', order_number: 20 }),
  docRow('ds3', { document_type: 'additional_agreement', name: 'ДС № 3', notes: 'Цена', order_number: 30 }),
]
const groupOrder = (docs, pred) => docs.filter(pred).sort(byDocOrder).map((d) => d.id)

describe('порядок и вложенность документов объекта — чистые функции', () => {
  it('новая строка — в конец своей группы (максимум соседей + 10), группы ДС и приложений раздельны', () => {
    assert.equal(nextOrderNumber(DOCS, 'gc', 'attachment'), 40)
    assert.equal(nextOrderNumber(DOCS, 'gc-a1', 'attachment'), 20)
    assert.equal(nextOrderNumber(DOCS, null, 'additional_agreement'), 40)
    assert.equal(nextOrderNumber(DOCS, 'ds2', 'attachment'), 10, 'первое приложение')
    assert.equal(nextOrderNumber([], null, 'general_contract'), 10)
  })

  it('куда встаёт отпущенная строка: сосед или блок соседа; свой блок и чужой документ — нельзя', () => {
    assert.deepEqual(resolveDropTarget(DOCS, 'ds3', 'ds1'), { id: 'ds1', inside: false })
    assert.deepEqual(resolveDropTarget(DOCS, 'ds3', 'ds1-a1'), { id: 'ds1', inside: true }, 'над приложением соседней ДС')
    assert.deepEqual(resolveDropTarget(DOCS, 'gc-a3', 'gc-a1-1'), { id: 'gc-a1', inside: true }, 'над вложенным приложением соседа')
    assert.equal(resolveDropTarget(DOCS, 'gc-a1', 'gc-a1-1'), null, 'над своим приложением')
    assert.equal(resolveDropTarget(DOCS, 'gc-a1', 'gc-a1'), null, 'над собой')
    assert.equal(resolveDropTarget(DOCS, 'ds1-a1', 'gc-a2'), null, 'к другому документу — только через форму')
    assert.equal(resolveDropTarget(DOCS, 'ds1', 'gc'), null, 'ДС к договору генподряда')
    assert.equal(resolveDropTarget(DOCS, 'missing', 'ds1'), null)
  })

  it('перестановка пишет только изменившиеся строки; на прежнее место — ничего', () => {
    assert.deepEqual(reorderUpdates(DOCS, 'ds3', 'ds1', 'after'), [{ id: 'ds3', order_number: 20 }, { id: 'ds2', order_number: 30 }])
    assert.equal(reorderUpdates(DOCS, 'gc-a2', 'gc-a1', 'after'), null)
    assert.equal(reorderUpdates(DOCS, 'gc-a2', 'gc-a3', 'before'), null)
    assert.equal(reorderUpdates(DOCS, 'ds1-a1', 'gc-a2', 'before'), null, 'разные группы')
    assert.deepEqual(neighbourOf(DOCS, 'gc-a2', -1)?.id, 'gc-a1')
    assert.equal(neighbourOf(DOCS, 'gc-a1', -1), null)
  })

  it('уровни: приложение к приложению — последнее, к которому ничего не добавить; петля в данных не зацикливает', () => {
    assert.deepEqual(['gc', 'gc-a1', 'gc-a1-1'].map((id) => docLevel(DOCS, id)), [0, 1, 2])
    assert.deepEqual([0, 1, 2, 3].map(canAddAttachmentAtLevel), [true, true, false, false])
    const loop = [docRow('x', { parent_document_id: 'y' }), docRow('y', { parent_document_id: 'x' })]
    assert.ok(docLevel(loop, 'x') <= 2)
    assert.equal(resolveDropTarget(loop, 'x', 'y'), null)
  })
})

const launch = browserLaunchOptions()

describe('«Документы» карточки объекта: перетаскивание, уровни, добавление', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open({ query = '&latency=0', viewport = { width: 1400, height: 1000 } } = {}) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.goto(`${stand.url}?route=/cost-plans${query}`)
    await page.locator('.cost-plans-page .cp-table').first().waitFor({ timeout: 120000 })
    await page.evaluate((docs) => {
      const db = window.__fakeDb
      db.objects = [...db.objects, { id: 'o-1', name: 'ЖК Южный', status: 'main_construction' }]
      db.object_documents = docs
      // Как в базе: выборка встраивает файлы по колонкам связи.
      window.__fakeTriggers = {
        ...window.__fakeTriggers,
        object_documents: (row) => {
          row.signed = window.__fakeDb.s3_documents.find((f) => f.id === row.signed_s3_document_id) || null
          row.editable = window.__fakeDb.s3_documents.find((f) => f.id === row.editable_s3_document_id) || null
        },
      }
      for (const t of ['objects', 'object_documents']) window.__fakeTouch(t)
      window.__navigate('/general/objects/o-1?tab=documents')
    }, DOCS)
    await page.locator('[data-doc-id="gc"]').first().waitFor({ timeout: 60000 })
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }

  const fakeDocs = (page) => page.evaluate(() => window.__fakeDb.object_documents.map((d) => ({ ...d })))
  const shownIds = (page, table) => page.locator('.doc-table').nth(table).locator('tr[data-doc-id]')
    .evaluateAll((rows) => rows.map((r) => r.dataset.docId))
  const handle = (page, id) => page.locator(`tr[data-doc-id="${id}"] .doc-drag-handle`)
  const nameCell = (page, id) => page.locator(`tr[data-doc-id="${id}"] td.doc-cell-name`)

  it('ДС над приложением соседней ДС — после неё; приложение над вложенным приложением соседа — после соседа; '
    + 'на свой блок — нельзя; на «+ Приложение» — в конец; порядок записан в базу', async () => {
    const { page, errors, close } = await open()
    try {
      // Ручка — вся левая ячейка строки, не две точки.
      const box = await handle(page, 'ds1').boundingBox()
      assert.ok(box.width >= 24 && box.height >= 30, JSON.stringify(box))

      // Посреди перетаскивания: линия «встанет после ДС № 1» — под её строкой «+ Приложение», между блоками.
      await handle(page, 'ds3').hover()
      await page.mouse.down()
      const over = await nameCell(page, 'ds1-a1').boundingBox()
      await page.mouse.move(over.x + 30, over.y + 8, { steps: 5 })
      await page.mouse.move(over.x + 40, over.y + 12, { steps: 5 })
      assert.equal(await page.locator('.doc-row-dragging').count(), 2, 'перетаскиваемая ДС и её «+ Приложение» бледнее')
      const lineAt = await page.locator('.doc-row-drop-after, .doc-row-drop-before').evaluateAll((rows) => rows.map((r) => [
        r.className.includes('drop-after') ? 'after' : 'before',
        r.dataset.docId || r.previousElementSibling?.dataset.docId,
      ]))
      assert.deepEqual(lineAt, [['after', 'ds1-a1']], 'линия под последней строкой блока ДС № 1')
      await page.mouse.up()
      await page.waitForFunction(() => window.__fakeDb.object_documents.find((d) => d.id === 'ds3').order_number === 20)
      assert.deepEqual(groupOrder(await fakeDocs(page), (d) => d.document_type === 'additional_agreement' && !d.parent_document_id), ['ds1', 'ds3', 'ds2'])
      assert.deepEqual(await shownIds(page, 1), ['ds1', 'ds1-a1', 'ds3', 'ds2'])

      await handle(page, 'gc-a3').dragTo(nameCell(page, 'gc-a1-1'))
      await page.waitForFunction(() => window.__fakeDb.object_documents.find((d) => d.id === 'gc-a3').order_number === 20)
      assert.deepEqual(groupOrder(await fakeDocs(page), (d) => d.parent_document_id === 'gc'), ['gc-a1', 'gc-a3', 'gc-a2'])
      assert.deepEqual(await shownIds(page, 0), ['gc', 'gc-a1', 'gc-a1-1', 'gc-a3', 'gc-a2'])

      const before = JSON.stringify(await fakeDocs(page))
      await handle(page, 'gc-a1').dragTo(nameCell(page, 'gc-a1-1'))
      await page.waitForTimeout(400)
      assert.equal(JSON.stringify(await fakeDocs(page)), before, 'на своё приложение — без изменений')

      await handle(page, 'ds1').dragTo(page.locator('tbody.doc-block', { has: page.locator('tr[data-doc-id="ds2"]') }).locator('.doc-row-tr-add-attachment'))
      await page.waitForFunction(() => window.__fakeDb.object_documents.find((d) => d.id === 'ds1').order_number === 30)
      assert.deepEqual(await shownIds(page, 1), ['ds3', 'ds2', 'ds1', 'ds1-a1'])

      // С клавиатуры: ↑ на ручке — на место выше, фокус остаётся на ручке.
      await handle(page, 'gc-a2').focus()
      await page.keyboard.press('ArrowUp')
      await page.waitForFunction(() => window.__fakeDb.object_documents.find((d) => d.id === 'gc-a2').order_number === 20)
      assert.deepEqual(await shownIds(page, 0), ['gc', 'gc-a1', 'gc-a1-1', 'gc-a2', 'gc-a3'])
      assert.equal(await page.evaluate(() => document.activeElement?.closest('tr')?.dataset.docId), 'gc-a2')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('уровни видны: приложение сдвинуто вправо, приложение к приложению — ещё правее; между ДС линия толще; '
    + 'у приложения к приложению нет «＋»', async () => {
    const { page, errors, close } = await open()
    try {
      const x = async (id) => (await page.locator(`tr[data-doc-id="${id}"] .doc-name-text`).boundingBox()).x
      const [x0, x1, x2] = [await x('gc'), await x('gc-a1'), await x('gc-a1-1')]
      assert.ok(x1 - x0 >= 16 && x2 - x1 >= 16, `сдвиг по уровням: ${x0} → ${x1} → ${x2}`)
      assert.ok(await x('ds1-a1') - await x('ds1') >= 16, 'приложение ДС тоже сдвинуто')
      const cls = (id) => page.locator(`tr[data-doc-id="${id}"]`).getAttribute('class')
      assert.match(await cls('gc'), /doc-row-l0/)
      assert.match(await cls('gc-a1'), /doc-row-l1/)
      assert.match(await cls('gc-a1-1'), /doc-row-l2/)
      const topBorder = (id) => page.locator(`tr[data-doc-id="${id}"] td`).nth(1).evaluate((td) => getComputedStyle(td).borderTopWidth)
      assert.equal(await topBorder('ds2'), '2px', 'блок следующей ДС отделён линией толще')
      assert.equal(await topBorder('ds1-a1'), '1px')

      assert.equal(await page.locator('tr[data-doc-id="gc-a1"] .doc-action-add').count(), 1)
      assert.equal(await page.locator('tr[data-doc-id="ds1-a1"] .doc-action-add').count(), 1)
      assert.equal(await page.locator('tr[data-doc-id="gc-a1-1"] .doc-action-add').count(), 0, 'третьего уровня нет')
      assert.equal(await page.locator('tr[data-doc-id="gc-a1-1"] .doc-cell-actions button').count(), 2, 'правка и удаление остаются')
      // Иконки, а не эмодзи: у каждой кнопки есть подпись.
      for (const b of await page.locator('.doc-cell-actions button').all()) assert.ok(await b.getAttribute('aria-label'))
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('телефон: у приложения к приложению нет «+ Приложение», у приложения — есть', async () => {
    const { page, errors, close } = await open({ viewport: { width: 390, height: 800 } })
    try {
      await page.locator('.odc-card[data-doc-id="gc-a1-1"]').waitFor()
      assert.equal(await page.locator('.odc-card[data-doc-id="gc-a1"] > .odc-foot .odc-add').count(), 1)
      assert.equal(await page.locator('.odc-card[data-doc-id="gc-a1-1"] .odc-add').count(), 0)
      assert.match(await page.locator('.odc-card[data-doc-id="gc-a1-1"]').getAttribute('class'), /odc-card-att2/)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('новое приложение с файлом — последним в своём документе, родитель раскрыт; окно не крутит перерисовки, '
    + 'карточка не заменяется «Загрузкой…»', async () => {
    const { page, errors, close } = await open()
    try {
      await page.evaluate(() => {
        window.__pageGone = false
        new MutationObserver(() => { if (!document.querySelector('.object-detail-page')) window.__pageGone = true })
          .observe(document.body, { subtree: true, childList: true })
      })
      // Договор свёрнут — после сохранения он раскрывается сам, новая строка видна.
      await page.locator('tr[data-doc-id="gc"] .doc-expand-btn').click()
      await page.locator('tbody.doc-block', { has: page.locator('tr[data-doc-id="gc"]') }).locator('.doc-add-attachment-btn').click()
      const modal = page.locator('.modal')
      await modal.waitFor()
      await page.waitForTimeout(800)
      assert.deepEqual(errors, [], 'без «Maximum update depth exceeded»')
      await modal.locator('input[type="text"]').nth(0).fill('Прил. 4')
      await modal.locator('input[type="text"]').nth(1).fill('Исполнительная схема')
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), modal.locator('.doc-slot-signed .doc-slot-upload-btn').click()])
      await chooser.setFiles({ name: 'Скан.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') })
      await modal.locator('.doc-slot-signed .doc-slot-file-name').waitFor({ timeout: 15000 })
      await modal.locator('.btn-save').click()
      await modal.waitFor({ state: 'detached' })
      const added = (await fakeDocs(page)).find((d) => d.document_number === 'Прил. 4')
      assert.ok(added, 'строка создана')
      assert.equal(added.parent_document_id, 'gc')
      assert.equal(added.order_number, 40, 'после 10/20/30 — 40, а не «число документов + 1»')
      assert.ok(added.signed_s3_document_id, 'файл привязан')
      await page.locator(`tr[data-doc-id="${added.id}"]`).waitFor()
      assert.deepEqual(await shownIds(page, 0), ['gc', 'gc-a1', 'gc-a1-1', 'gc-a2', 'gc-a3', added.id])
      assert.equal(await page.evaluate(() => window.__pageGone), false)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('двойной щелчок «Сохранить» создаёт одну ДС; окно закрыли во время загрузки — файл не остаётся в хранилище', async () => {
    const { page, errors, close } = await open({ query: '&latency=400' })
    try {
      await page.locator('.doc-section', { hasText: 'Дополнительные соглашения' }).locator('.btn-add').click()
      const modal = page.locator('.modal')
      await modal.locator('input[type="text"]').first().fill('ДС № 4')
      await modal.locator('.btn-save').dblclick()
      await modal.waitFor({ state: 'detached', timeout: 15000 })
      await page.waitForTimeout(1200)
      assert.equal((await fakeDocs(page)).filter((d) => d.name === 'ДС № 4').length, 1)

      // Запись строки файла видна в журнале: проверка не пройдёт «даром», если загрузка не дошла до конца.
      await page.evaluate(() => {
        window.__fakeAfter = {
          ...window.__fakeAfter,
          s3_documents: (op, row) => { if (op === 'insert') window.__s3Inserted = [...(window.__s3Inserted || []), row.file_name] },
        }
      })
      await page.locator('tbody.doc-block', { has: page.locator('tr[data-doc-id="ds2"]') }).locator('.doc-add-attachment-btn').click()
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), modal.locator('.doc-slot-editable .doc-slot-upload-btn').click()])
      await chooser.setFiles({ name: 'Брошен.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('draft') })
      await modal.locator('.doc-slot-editable .doc-slot-status').waitFor()
      await modal.locator('.btn-cancel').click()
      await modal.waitFor({ state: 'detached' })
      await page.waitForFunction(() => (window.__s3Inserted || []).includes('Брошен.docx'), null, { timeout: 15000 })
      await page.waitForFunction(() => !window.__fakeDb.s3_documents.some((f) => f.file_name === 'Брошен.docx'), null, { timeout: 15000 })
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('только просмотр: ни ручек, ни «＋», ни строк «+ Приложение»', async () => {
    const { page, errors, close } = await open({ query: '&latency=0&canEdit=0' })
    try {
      await page.locator('tr[data-doc-id="gc-a1-1"]').waitFor()
      assert.equal(await page.locator('.doc-drag-handle').count(), 0)
      assert.equal(await page.locator('.doc-action-add').count(), 0)
      assert.equal(await page.locator('.doc-row-tr-add-attachment').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
