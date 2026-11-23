// Карточка объекта → «Документы» (/general/objects/:id): приложение к ДС удаляется отдельно от ДС (просьба пользователя 23.11.2026:
// «добавь возможность удалять в general/objects Приложения к ДС, сейчас можно только удалить весь ДС полностью»). Кнопки у приложения
// (＋ ✏️ 🗑️) не помещались в столбец «Действия» шириной 80 px (table-layout: fixed): корзина уходила за край таблицы под прокрутку
// рамки. Проверяется: все кнопки действий видны и нажимаются на обычном и узком экране, у договора генподряда и у ДС; удаление
// приложения убирает только его (с вложенными), ДС остаётся; окно подтверждения называет, что удаляется. Chromium — стенд.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const docRow = (id, extra) => ({
  id, object_id: 'o-1', parent_document_id: null, document_type: 'attachment', name: id, document_number: null, document_date: null,
  notes: null, order_number: 0, created_at: '2026-10-01T09:00:00Z', signed: null, editable: null, ...extra,
})
const DOCS = [
  docRow('gc', { document_type: 'general_contract', name: 'Договор генподряда', document_number: 'ГП-7' }),
  docRow('gc-att', { parent_document_id: 'gc', name: 'Приложение к договору', document_number: 'Прил. 1' }),
  docRow('ds', { document_type: 'additional_agreement', name: 'ДС № 1', notes: 'Перенос сроков' }),
  docRow('ds-att', { parent_document_id: 'ds', name: 'График работ', document_number: 'Прил. 2' }),
  docRow('ds-att-att', { parent_document_id: 'ds-att', name: 'Ведомость', document_number: 'Прил. 2.1' }),
  docRow('ds-att2', { parent_document_id: 'ds', name: 'Смета', document_number: 'Прил. 3' }),
]

const launch = browserLaunchOptions()

describe('приложение к ДС удаляется отдельно от ДС', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open(viewport) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.goto(`${stand.url}?route=/cost-plans&latency=0`)
    await page.locator('.cost-plans-page .cp-table').first().waitFor({ timeout: 120000 })
    await page.evaluate((docs) => {
      const db = window.__fakeDb
      db.objects = [...db.objects, { id: 'o-1', name: 'ЖК Южный', status: 'main_construction' }]
      db.object_documents = docs
      for (const t of ['objects', 'object_documents']) window.__fakeTouch(t)
      window.__navigate('/general/objects/o-1?tab=documents')
    }, DOCS)
    await page.locator('[data-doc-id="gc"]').first().waitFor({ timeout: 60000 })
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }

  // Кнопка видна целиком внутри рамки таблицы и сверху ничто её не закрывает. На узком экране таблица шире места и по задумке
  // прокручивается в своей рамке — тогда рамка сначала прокручена до конца вправо.
  const reachable = (button, scroll) => button.evaluate((el, scroll) => {
    if (scroll) { const w = el.closest('.doc-table-wrap'); w.scrollLeft = w.scrollWidth }
    const r = el.getBoundingClientRect()
    const wrap = el.closest('.doc-table-wrap').getBoundingClientRect()
    const inside = r.width > 0 && r.left >= wrap.left - 0.5 && r.right <= wrap.right + 0.5
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return inside && !!hit && (hit === el || el.contains(hit))
  }, scroll)

  for (const [viewport, scroll] of [[{ width: 1400, height: 900 }, false], [{ width: 900, height: 900 }, true]]) {
    it(`все кнопки действий видны и нажимаются — ${viewport.width} px`, async () => {
      const { page, errors, close } = await open(viewport)
      try {
        // Широкий экран: таблицы помещаются, вбок ничего не торчит (раньше корзина приложений вылезала за край под прокрутку).
        if (!scroll) {
          for (const w of await page.locator('.doc-table-wrap').all()) {
            assert.ok(await w.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'у таблицы нет прокрутки вбок')
          }
        }
        // Документы с приложениями раскрыты сразу при открытии вкладки.
        const attRows = page.locator('tr.doc-row-tr-attachment')
        await attRows.filter({ hasText: 'Ведомость' }).waitFor()
        for (const text of ['Приложение к договору', 'График работ', 'Ведомость', 'Смета']) {
          const buttons = attRows.filter({ hasText: text }).locator('.doc-cell-actions button')
          assert.equal(await buttons.count(), 3, text)
          for (let i = 0; i < 3; i++) assert.ok(await reachable(buttons.nth(i), scroll), `${text}: кнопка ${i + 1} видна целиком`)
          assert.ok(await reachable(attRows.filter({ hasText: text }).locator('.doc-action-delete'), scroll), `${text}: «Удалить»`)
        }
        for (const id of ['gc', 'ds']) {
          const buttons = page.locator(`tr[data-doc-id="${id}"] .doc-cell-actions button`)
          for (let i = 0; i < await buttons.count(); i++) assert.ok(await reachable(buttons.nth(i), scroll), `${id}: кнопка ${i + 1}`)
        }
        assert.deepEqual(errors, [])
      } finally {
        await close()
      }
    })
  }

  it('удаление приложения ДС убирает только его и вложенные; ДС и соседнее приложение остаются; окно называет приложение', async () => {
    const { page, dialogs, errors, close } = await open({ width: 1400, height: 900 })
    try {
      const row = page.locator('tr.doc-row-tr-attachment').filter({ hasText: 'График работ' })
      await row.locator('.doc-action-delete').click()
      await page.waitForFunction(() => !window.__fakeDb.object_documents.some((d) => d.id === 'ds-att'))
      assert.equal(dialogs.length, 1)
      assert.match(dialogs[0], /приложение «Прил\. 2 — График работ»/i)
      assert.match(dialogs[0], /вложенные приложения \(1\)/)
      assert.doesNotMatch(dialogs[0], /ДС № 1/)
      const left = await page.evaluate(() => window.__fakeDb.object_documents.map((d) => d.id).sort())
      // Вложенное приложение в базе удаляется каскадом (ON DELETE CASCADE); стенд его не каскадит — проверяем только своё.
      assert.ok(left.includes('ds') && left.includes('ds-att2') && left.includes('gc-att'), left.join(','))
      // Список перечитывается после удаления: строки нет, соседнее приложение на месте.
      await page.locator('tr.doc-row-tr-attachment').filter({ hasText: 'Смета' }).waitFor({ timeout: 10000 })
      assert.equal(await page.locator('tr.doc-row-tr-attachment').filter({ hasText: 'График работ' }).count(), 0)

      // Удаление самой ДС предупреждает, что уйдут и её приложения.
      await page.locator('tr[data-doc-id="ds"] .doc-action-delete').click()
      await page.waitForFunction(() => !window.__fakeDb.object_documents.some((d) => d.id === 'ds'))
      assert.match(dialogs[1], /ДС «ДС № 1» вместе с приложениями \(1\)/)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
