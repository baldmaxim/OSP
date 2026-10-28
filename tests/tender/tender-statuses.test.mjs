// Тендеры основного строительства без статуса «Заявка на тендер» (решение 28.10.2026): новый тендер ОС — сразу
// «Подготовка ВОР»; прежние тендеры ОС с «Заявкой на тендер» база хранит как есть, реестр и карточка показывают и
// считают их «Подготовкой ВОР». ГО, совместные и прочие статус сохраняют. Помощники — без браузера, реестр — стенд
// tests/tender/ui (route=/tenders/construction; у каждого пятого тендера стенда — «Заявка на тендер»).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  TENDER_REQUEST_STATUS, VOR_PREP_STATUS, initialMainTenderStatus, mainTenderStatuses, shownMainTenderStatus,
} from '../../src/utils/tenderStatuses.js'

const launch = browserLaunchOptions()

describe('Статусы основного тендера по направлениям', () => {
  it('у ОС «Заявки на тендер» нет, новый тендер — «Подготовка ВОР»; у остальных — как было', () => {
    assert.deepEqual(mainTenderStatuses('construction'),
      ['Подготовка ВОР', 'Идет тендерная процедура', 'Подведение итогов', 'Завершен', 'Приостановка тендера'])
    assert.equal(initialMainTenderStatus('construction'), VOR_PREP_STATUS)
    for (const dept of ['warranty', 'joint', 'other']) {
      assert.equal(mainTenderStatuses(dept)[0], TENDER_REQUEST_STATUS, dept)
      assert.equal(mainTenderStatuses(dept).length, 6, dept)
      assert.equal(initialMainTenderStatus(dept), TENDER_REQUEST_STATUS, dept)
    }
  })

  it('прежняя «Заявка на тендер» у ОС (и без направления — старые записи) — «Подготовка ВОР»', () => {
    assert.equal(shownMainTenderStatus(TENDER_REQUEST_STATUS, 'construction'), VOR_PREP_STATUS)
    assert.equal(shownMainTenderStatus(TENDER_REQUEST_STATUS, null), VOR_PREP_STATUS)
    assert.equal(shownMainTenderStatus(TENDER_REQUEST_STATUS, 'warranty'), TENDER_REQUEST_STATUS)
    assert.equal(shownMainTenderStatus('Завершен', 'construction'), 'Завершен')
  })
})

describe('Реестр тендеров ОС без «Заявки на тендер»', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  it('статусы и счётчики — без неё; прежняя показана «Подготовкой ВОР»; новый тендер записан с «Подготовкой ВОР»', async () => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('dialog', (d) => d.accept())
    try {
      await page.goto(`${stand.url}?route=/tenders/construction&tenders=10&items=20&cps=2&latency=0`)
      await page.locator('table.tenders-registry > tbody > tr').first().waitFor({ timeout: 120000 })

      await page.getByRole('button', { name: /Статусы тендеров/ }).click()
      const tabs = await page.locator('.tender-tab-status').allInnerTexts()
      assert.ok(!tabs.some(t => t.startsWith(TENDER_REQUEST_STATUS)), tabs.join(' | '))
      // Из 10 тендеров стенда по кругу 5 статусов: «Заявка на тендер» (2) и «Подготовка ВОР» (2) — вместе.
      assert.equal((await page.locator('.tender-tab-status', { hasText: VOR_PREP_STATUS }).innerText()).replace(/\s+/g, ' '),
        `${VOR_PREP_STATUS} 4`)

      // № 200 — первый тендер стенда, в базе «Заявка на тендер».
      assert.equal(await page.evaluate(() => window.__fakeDb.tenders.find(t => t.id === 'tender-1').status), TENDER_REQUEST_STATUS)
      // В ячейке номера — ещё стрелка участников и «N/M КП».
      const row = page.locator('table.tenders-registry > tbody > tr', { has: page.locator('td.tp-num', { hasText: /^200(?!\d)/ }) })
      const trigger = row.getByRole('button', { name: 'Статус тендера' })
      assert.equal((await trigger.innerText()).replace('▾', '').trim(), VOR_PREP_STATUS)
      await trigger.click()
      const options = await page.locator('.status-dropdown-menu-portal .status-dropdown-option-label').allInnerTexts()
      assert.deepEqual(options, mainTenderStatuses('construction'))
      await page.keyboard.press('Escape')

      await page.getByRole('button', { name: '+ Добавить тендер' }).click()
      const form = page.locator('.modal form')
      await form.locator('select[name="object_id"]').selectOption('obj-1')
      await form.locator('textarea[name="work_description"]').fill('Проверка статуса нового тендера')
      await form.getByRole('button', { name: 'Добавить' }).click()
      await page.waitForFunction(() => window.__fakeDb.tenders.some(t => t.work_description === 'Проверка статуса нового тендера'))
      const created = await page.evaluate(() => window.__fakeDb.tenders
        .find(t => t.work_description === 'Проверка статуса нового тендера' && t.tender_type === 'main').status)
      assert.equal(created, VOR_PREP_STATUS)
      assert.deepEqual(errors, [])
    } finally {
      await context.close().catch(() => {})
    }
  })
})
