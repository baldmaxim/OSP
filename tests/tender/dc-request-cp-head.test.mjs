// «Заявки на ДС»: в выборе контрагента рядом с ИНН — руководитель (06.11.2026, решение пользователя: одноимённые
// «ООО Мастер» с разными ИНН различать ещё и по гендиректору). Руководитель — контакт карточки контрагента с должностью
// руководителя ([counterpartyHead.js](src/utils/counterpartyHead.js)). Стенд tests/tender/ui: route=/dc-requests&dcStats=1&dcHeads=1.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { counterpartyHeads, headKind } from '../../src/utils/counterpartyHead.js'
import { startStand, browserLaunchOptions, REPO as ROOT } from './lib/stand.mjs'

const launch = browserLaunchOptions()

describe('руководитель контрагента: должность', () => {
  it('гендиректор — в любом написании (как на копии 02.11)', () => {
    for (const p of ['Генеральный Директор', 'Генеральный директор ', ' Генеральный директор', 'ГЕНЕРАЛЬНЫЙ ДИРЕКТОР',
      'Ген. директор', 'ген.директор', 'Гендиректор', 'Актуальный генеральный директор', 'Генеральный Директор АО «Ромашка»']) {
      assert.equal(headKind(p), 'gen', p)
    }
  })

  it('директор, руководитель, ИП', () => {
    assert.equal(headKind('Директор'), 'dir')
    assert.equal(headKind('директор'), 'dir')
    assert.equal(headKind('Директор?'), 'dir')
    assert.equal(headKind('Руководитель'), 'head')
    assert.equal(headKind('Индивидуальный предприниматель'), 'ip')
    assert.equal(headKind('ИП'), 'ip')
  })

  it('не руководитель: заместитель, коммерческий, «по развитию», временно исполняющий, пусто', () => {
    for (const p of ['Заместитель ген. директора', 'Зам. генерального директора', 'Коммерческий директор', 'Ком.директор',
      'Исполнительный директор ООО "ПрофБетон"', 'Директор по развитию', 'Директор проекта',
      'Временно Исполняющий Обязанности Директора', 'Руководитель проектов', 'Управляющий — Индивидуальный Предприниматель',
      'Сметчик', '', null, undefined]) {
      assert.equal(headKind(p), null, String(p))
    }
  })
})

describe('руководитель контрагента: выбор из контактов', () => {
  it('гендиректор важнее директора; из двух гендиректоров — изменённый позже; «Нет контакта» и «-» — не ФИО', () => {
    const heads = counterpartyHeads([
      { counterparty_id: 'a', full_name: 'Петров Пётр', position: 'Директор', updated_at: '2026-10-01' },
      { counterparty_id: 'a', full_name: 'Иванов  Иван ', position: 'Генеральный директор', updated_at: '2026-09-01' },
      { counterparty_id: 'b', full_name: 'Старый Гендир', position: 'Генеральный директор', updated_at: '2026-01-01' },
      { counterparty_id: 'b', full_name: 'Новый Гендир', position: 'Актуальный генеральный директор', updated_at: '2026-05-01' },
      { counterparty_id: 'c', full_name: 'Нет контакта', position: 'Генеральный директор', updated_at: '2026-05-01' },
      { counterparty_id: 'c', full_name: '-', position: 'Директор', updated_at: '2026-05-01' },
      { counterparty_id: 'd', full_name: 'Кирик Денис', position: 'Коммерческий директор', updated_at: '2026-05-01' },
      { counterparty_id: null, full_name: 'Без контрагента', position: 'Директор' },
    ])
    assert.deepEqual(heads.get('a'), { name: 'Иванов Иван', label: 'Ген. директор' })
    assert.deepEqual(heads.get('b'), { name: 'Новый Гендир', label: 'Ген. директор' })
    assert.equal(heads.has('c'), false)
    assert.equal(heads.has('d'), false)
    assert.equal(heads.size, 2)
    assert.equal(counterpartyHeads(null).size, 0)
  })
})

describe('Заявки на ДС: руководитель в выборе контрагента', { skip: launch ? false : 'нет Chromium', timeout: 300000 }, () => {
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

  it('одноимённые «ООО «Мастер»»: ИНН слева, гендиректор справа тем же серым', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 900 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    try {
      await page.goto(`${stand.url}?route=/dc-requests&dcStats=1&dcHeads=1&latency=10&shell=1`)
      await page.locator('.dcr-table td.ui-rownum').first().waitFor({ timeout: 120000 })
      await page.getByRole('button', { name: '+ Добавить заявку' }).click()
      const input = page.locator('.modal .cp-search-input')
      await input.fill('мастер')
      const items = page.locator('.cp-search-dropdown .cp-search-item')
      await items.first().waitFor()
      const rows = await items.evaluateAll((els) => els.map((el) => ({
        name: el.querySelector('.cp-search-name')?.textContent,
        meta: [...(el.querySelector('.cp-search-meta')?.children || [])].map((c) => c.textContent),
      })))
      const byInn = (inn) => rows.find((r) => r.meta[0] === `ИНН: ${inn}`)
      assert.deepEqual(byInn('5042017037')?.meta, ['ИНН: 5042017037', 'Ген. директор: Иванов Иван Иванович'])
      assert.deepEqual(byInn('7708203762')?.meta, ['ИНН: 7708203762', 'Ген. директор: Русев Иван Сергеевич'])
      assert.deepEqual(byInn('7701000000')?.meta, ['ИНН: 7701000000'], 'коммерческий директор и «Нет контакта» — не руководитель')
      assert.deepEqual(rows.find((r) => r.name === 'ООО «МАСТЕР»')?.meta, ['Директор: Сидоров Сергей'], 'без ИНН — только руководитель')

      // Одна строка: руководитель правее ИНН, на той же высоте, тем же цветом и размером.
      const item = items.filter({ hasText: '5042017037' })
      const look = await item.evaluate((el) => {
        const [inn, head] = el.querySelector('.cp-search-meta').children
        const a = inn.getBoundingClientRect()
        const b = head.getBoundingClientRect()
        const sa = getComputedStyle(inn)
        const sb = getComputedStyle(head)
        return { sameLine: Math.abs(a.top - b.top) < 2, right: b.left > a.right, color: sa.color === sb.color, size: sa.fontSize === sb.fontSize }
      })
      assert.deepEqual(look, { sameLine: true, right: true, color: true, size: true })

      // Выбор пункта по-прежнему ставит контрагента.
      await item.dispatchEvent('mousedown')
      assert.equal(await input.inputValue(), 'ООО «Мастер»')
      assert.deepEqual(errors, [])
    } finally {
      await context.close().catch(() => {})
    }
  })
})
