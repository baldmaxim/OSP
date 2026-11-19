// Уведомления руководителя строительства и экономиста объекта (11.11.2026, решение пользователя: «в уведах должны видеть
// только статус по своим тендерам, что там идёт; проверка КП им не нужна, а что с их заявкой на проверку ДП/ДС и ДП —
// должно падать»). Правила — src/utils/siteNotifications.js, запросы — NotificationsContext, вид — NotificationsPage.
//   • правила отбора — без браузера;
//   • стенд (tests/tender/ui, route=/notifications, данные — notifications-stand.jsx), Chromium:
//     вкладки «Тендеры», «Проверка ДП/ДС» — без «Договоров» и «Проверки КП», к их таблицам запросов нет; заявки на заключение ДП
//     с 19.11.2026 — карточки «Заключение ДП» той же доски, во вкладке «Проверка ДП/ДС» (отдельной нет);
//     тендеры только своих объектов, без тендеров на материалы и давно закрытых; заявки своих объектов, кто бы их ни подал
//     («их заявка — это все заявки объекта и статус по ним», 11.11.2026); без архива и чужих объектов;
//     сменился статус — уведомление снова непрочитанное; из уведомления заявка на проверку ДП/ДС открывается сама;
//     у остальных сотрудников — прежние вкладки.
// Люди и объекты вымышленные.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  docCheckNotifications, isSiteStaffRole, tenderStatusNotifications,
} from '../../src/utils/siteNotifications.js'

const ago = (days) => new Date(Date.now() - days * 86400000).toISOString()
const since = new Date(Date.now() - 14 * 86400000)

describe('уведомления рукстроя и экономиста объекта: правила', () => {
  it('роли: рукстрой и экономист объекта — да; экономист ОСП, инженер, администратор — нет', () => {
    assert.equal(isSiteStaffRole('construction_manager'), true)
    assert.equal(isSiteStaffRole('economist_object'), true)
    for (const role of ['economist', 'engineer', 'admin', 'lawyer', null]) assert.equal(isSiteStaffRole(role), false, role)
  })

  it('тендеры: статус в ключе, «Заявка на тендер» у ОС — «Подготовка ВОР», материалы и давно закрытые не показываются', () => {
    const list = tenderStatusNotifications([
      { id: 'a', status: 'Идет тендерная процедура', updated_at: ago(1), objects: { name: 'ЖК' }, public_tender_number: 1 },
      { id: 'b', status: 'Заявка на тендер', department: 'construction', updated_at: ago(2) },
      { id: 'c', status: 'Завершен', updated_at: ago(3) },
      { id: 'd', status: 'Завершен', updated_at: ago(30) },
      { id: 'e', status: 'Перезапуск', updated_at: ago(40) },
      { id: 'f', status: 'В работе', tender_type: 'materials', updated_at: ago(1) },
      { id: 'g', status: 'Приостановка тендера', updated_at: ago(50) },
    ], { since })
    assert.deepEqual(list.map((n) => [n.id, n.statusLabel, n.statusTone]), [
      ['a', 'Идет тендерная процедура', 'active'],
      ['b', 'Подготовка ВОР', 'active'],
      ['c', 'Завершен', 'closed'],
      ['g', 'Приостановка тендера', 'paused'],
    ])
    assert.equal(list[0].key, 'tender_status:a:Идет тендерная процедура')
    assert.equal(list[0].badge, '№1')
  })

  it('заявки: ключ меняется со статусом; удалённые, архив и давно завершённые не показываются; «Заключение ДП» — словами', () => {
    const checks = docCheckNotifications([
      { id: 'x', status: 'in_progress', doc_type: 'ds', doc_number: '7', updated_at: ago(1), counterparties: { name: 'ООО «Монолит»' } },
      { id: 'y', status: 'awaiting_scan', doc_type: 'dp', updated_at: ago(60) },
      { id: 'z', status: 'done', updated_at: ago(60) },
      { id: 'w', status: 'new', updated_at: ago(1), deleted_at: ago(1) },
      { id: 'v', status: 'done', updated_at: ago(1), archived_at: ago(1) },
      { id: 'u', status: 'new', doc_type: 'dp_conclusion', updated_at: ago(2) },
    ], { since })
    assert.deepEqual(checks.map((n) => [n.key, n.subtitle]), [
      ['doc_check:x:in_progress', 'ДС № 7 — ООО «Монолит»'],
      ['doc_check:u:new', 'Заключение ДП'],
      ['doc_check:y:awaiting_scan', 'ДП'],
    ])
    assert.equal(checks[0].to, '/doc-check-requests?request=x')
    assert.equal(checks[1].objectName, 'Объект не указан')
  })
})

const launch = browserLaunchOptions()
const BOSS = '&asRole=construction_manager&asUser=boss-1&scope=obj-1&noEdit=doc_check_requests,admin'

describe('уведомления рукстроя и экономиста объекта: страница', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  const watch = (page) => {
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    return errors
  }
  const go = async (page, extra) => {
    await page.goto(`${stand.url}?route=/notifications&latency=0${extra}`)
    await page.locator('.notif-toggle').waitFor({ timeout: 120000 })
    await page.locator('.notif-list, .notif-empty:not(:has-text("Загрузка"))').first().waitFor()
  }
  const tabs = (page) => page.locator('.notif-toggle-btn > span:first-child').allInnerTexts()
  const items = (page) => page.locator('.notif-item').evaluateAll((els) => els.map((el) => [
    el.querySelector('.notif-num')?.textContent || '',
    el.querySelector('.notif-status-chip')?.textContent || '',
    el.querySelector('.notif-object')?.textContent || '',
    el.querySelector('.notif-subtitle')?.textContent || '',
  ]))
  const tab = (page, name) => page.getByRole('tab', { name: new RegExp(`^${name}`) }).click()

  it('рукстрой: статус тендеров и заявок своих объектов; без договоров и проверки КП', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const errors = watch(page)
    try {
      await go(page, BOSS)
      assert.deepEqual(await tabs(page), ['Тендеры', 'Проверка ДП/ДС'])
      const asked = await page.evaluate(() => [...new Set(window.__supabaseStats.requests.map((r) => r.table))])
      for (const table of ['contracts', 'tender_proposal_files']) assert.ok(!asked.includes(table), `запрос к ${table}: ${asked.join(', ')}`)

      assert.deepEqual(await items(page), [
        ['№101', 'Идет тендерная процедура', 'ЖК «Северный квартал»', 'Монолитные работы'],
        ['№102', 'Завершен', 'ЖК «Северный квартал»', 'Работы по тендеру № 102'],
        ['№106', 'Подготовка ВОР', 'ЖК «Северный квартал»', 'Работы по тендеру № 106'],
      ])

      await tab(page, 'Проверка ДП/ДС')
      const checks = await items(page)
      assert.deepEqual(checks.map(([, status, , sub]) => [status, sub.split(' — ')[0]]), [
        ['В работе', 'ДС № 7'],
        ['Новые заявки', 'Заключение ДП'],
        ['Новые заявки', 'ДС № 4'],
        ['Завершено', 'ДП № СУ-12'],
      ])
      assert.equal(await page.locator('.notif-item', { hasText: 'ДС № 4' }).locator('.notif-author').innerText(), 'Подал(а): Экономов А. П.')
      const asked2 = await page.evaluate(() => [...new Set(window.__supabaseStats.requests.map((r) => r.table))])
      assert.ok(!asked2.includes('dp_requests'), 'прежней таблицы заявок на ДП не читает')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('сменился статус заявки — уведомление снова непрочитанное, остальные прочитаны', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const errors = watch(page)
    try {
      await go(page, BOSS)
      assert.equal(await page.locator('.notif-mark-all-count').innerText(), '7')
      await page.getByRole('button', { name: /Прочитать все/ }).click()
      await page.locator('.notif-mark-all').waitFor({ state: 'detached' })

      await go(page, `${BOSS}&notifEdo=1`)
      assert.equal(await page.locator('.notif-mark-all-count').innerText(), '1')
      assert.equal(await page.getByRole('tab', { name: /^Проверка ДП\/ДС/ }).locator('.notif-toggle-dot').count(), 1)
      await tab(page, 'Проверка ДП/ДС')
      const unread = page.locator('.notif-item:not(.is-read)')
      assert.equal(await unread.count(), 1)
      assert.equal(await unread.locator('.notif-status-chip').innerText(), 'Выгрузка по ЭДО')
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('из уведомления заявка на проверку ДП/ДС открывается сама', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 950 } })
    const page = await context.newPage()
    const errors = watch(page)
    try {
      await go(page, `${BOSS}&docCheck=1`)
      await tab(page, 'Проверка ДП/ДС')
      await page.locator('.notif-item', { hasText: 'ДС № 7' }).click()
      const modal = page.locator('.dc-detail-modal')
      await modal.waitFor({ timeout: 60000 })
      assert.match(await modal.innerText(), /В работе/)
      assert.match(await modal.innerText(), /\b7\b/)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })

  it('остальные сотрудники: вкладки прежние — тендеры, договоры, задачи, проверка КП', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const errors = watch(page)
    try {
      await go(page, '&asRole=engineer')
      assert.deepEqual(await tabs(page), ['Тендеры', 'Договоры', 'Задачи', 'Проверка КП'])
      assert.equal(await page.locator('.notif-status-chip').count(), 0)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  })
})
