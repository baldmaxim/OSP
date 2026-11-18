// Общий шаблон письма подрядчикам «Тендеров — Основное строительство» (18.11.2026, просьба пользователя: «возможность
// менять шаблон письма для администратора»). Раньше шаблон жил только в браузере — у каждого свой. Теперь администратор
// сохраняет один на всех в app_settings (ключ tender_letter_template:construction, миграции нет: незнакомый ключ в базе
// пишет только администратор). Общий задан — остальные видят его только для чтения, письмо формируется по нему и
// перечитывает его при каждом открытии. Общего нет и в других направлениях — как раньше, свой шаблон в браузере.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  SHARED_LETTER_TEMPLATE_KEY, LETTER_TEMPLATE_MAX, checkLetterTemplate, parseSharedLetterTemplate, letterTemplateView,
} from '../../src/utils/tenderLetterTemplate.js'

describe('Общий шаблон письма: правила без базы', () => {
  it('проверка текста: пустой и слишком длинный — отказ, хвостовые пробелы и \\r убираются', () => {
    assert.match(checkLetterTemplate('  \n ').error, /Шаблон пустой/)
    assert.match(checkLetterTemplate(null).error, /Шаблон пустой/)
    assert.match(checkLetterTemplate('я'.repeat(LETTER_TEMPLATE_MAX + 1)).error, /слишком длинный/)
    assert.deepEqual(checkLetterTemplate('  Тема\r\nТекст \n\n'), { value: '  Тема\nТекст' })
    assert.equal(checkLetterTemplate('я'.repeat(LETTER_TEMPLATE_MAX)).value.length, LETTER_TEMPLATE_MAX)
  })

  it('значение из базы: пустое — общего шаблона нет', () => {
    assert.equal(parseSharedLetterTemplate(null), null)
    assert.equal(parseSharedLetterTemplate(' \n'), null)
    assert.equal(parseSharedLetterTemplate('Текст\n'), 'Текст\n')
  })

  it('кто что видит: администратор ОС правит общий, остальные — чтение; общего нет и не ОС — свой из браузера', () => {
    const base = { sharedText: 'общий', localText: 'свой' }
    assert.deepEqual(letterTemplateView({ ...base, shared: true, isAdmin: true }), { mode: 'shared-admin', text: 'общий' })
    assert.deepEqual(letterTemplateView({ ...base, shared: true, isAdmin: false }), { mode: 'shared-view', text: 'общий' })
    assert.deepEqual(letterTemplateView({ ...base, sharedText: null, shared: true, isAdmin: true }), { mode: 'shared-admin', text: 'свой' })
    assert.deepEqual(letterTemplateView({ ...base, sharedText: null, shared: true, isAdmin: false }), { mode: 'local', text: 'свой' })
    assert.deepEqual(letterTemplateView({ ...base, shared: false, isAdmin: true }), { mode: 'local', text: 'свой' })
  })

  it('ключ пишет только администратор: в базе он не отнесён ни к одному разделу, в карте шлюза записан', () => {
    const sql = fs.readFileSync(path.join(REPO, 'migration/yandex/20270120_object_scope_files.sql'), 'utf8')
    const fn = sql.slice(sql.indexOf('FUNCTION public.app_settings_key_sections'), sql.indexOf('FUNCTION public.app_settings_write_guard'))
    assert.match(fn, /ELSE ARRAY\['admin'\]/)
    // Условия функции: точные имена и LIKE-шаблоны с началом строки — наш ключ не подходит ни под одно.
    const names = [...fn.matchAll(/p_key = '([^']+)'/g)].map((m) => m[1])
    const prefixes = [...fn.matchAll(/p_key LIKE '([^']+)'/g)].map((m) => m[1].replace(/\\_/g, '_').replace(/%$/, ''))
    assert.ok(names.length >= 4 && prefixes.length >= 2)
    assert.ok(!names.includes(SHARED_LETTER_TEMPLATE_KEY))
    for (const p of prefixes) assert.ok(!SHARED_LETTER_TEMPLATE_KEY.startsWith(p), `ключ подходит под «${p}%»`)
    const map = JSON.parse(fs.readFileSync(path.join(REPO, 'server/osp-api/src/data/db-sections.json'), 'utf8'))
    assert.ok(JSON.stringify(map).includes(SHARED_LETTER_TEMPLATE_KEY), 'ключ описан в db-sections.json')
  })
})

const launch = browserLaunchOptions()
const OS = 'route=/tenders/construction&tenders=10&items=20&cps=2&latency=0'
const SHARED_SEED = 'Общий шаблон. Тендер № {tender_number}, объект «{object_name}».\nВопросы — по телефону {employee_phone}.'

describe('Общий шаблон письма в реестре тендеров', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  // local — шаблон, сохранённый в браузере раньше; init — код до загрузки страницы (подделка отказов).
  const openPage = async (query, { local = null, init = null } = {}) => {
    const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })
    if (local) await context.addInitScript((text) => localStorage.setItem('letterTemplate:v4', text), local)
    if (init) await context.addInitScript(init)
    const page = await context.newPage()
    const errors = []
    const dialogs = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept() })
    await page.goto(`${stand.url}?${query}`)
    await page.locator('table.tenders-registry > tbody > tr').first().waitFor({ timeout: 120000 })
    return { page, errors, dialogs, close: () => context.close().catch(() => {}) }
  }
  const openTemplateTab = async (page) => {
    await page.locator('button.btn-view-toggle', { hasText: 'Документы' }).click()
    await page.locator('.tdm-tab', { hasText: 'Материалы' }).click()
    await page.locator('.tdm-card', { hasText: 'Шаблон письма' }).click()
    await page.locator('textarea.letter-template-text').waitFor({ timeout: 10000 })
  }
  const field = (page) => page.locator('textarea.letter-template-text')
  const lead = (page) => page.locator('.letter-template-lead')
  const settingRows = (page) => page.evaluate((key) => window.__fakeDb.app_settings.filter((r) => r.key === key), SHARED_LETTER_TEMPLATE_KEY)
  const registryRow = (page, num) => page.locator('table.tenders-registry > tbody > tr').filter({ has: page.locator('.tp-num-value', { hasText: new RegExp(`^${num}$`) }) })
  const letterModal = (page) => page.locator('.modal', { hasText: 'Шаблон письма для запроса КП' })
  const letterFor = async (page, num) => {
    await registryRow(page, num).locator('button[aria-label="Шаблон письма подрядчикам"]').click()
    await letterModal(page).waitFor({ timeout: 10000 })
    const text = await letterModal(page).locator('div[style*="pre-wrap"]').innerText()
    await letterModal(page).locator('.modal-close').click()
    return text
  }
  const backToRegistry = async (page) => {
    await page.locator('.tender-docs-back').click()
    await page.locator('table.tenders-registry > tbody > tr').first().waitFor({ timeout: 10000 })
  }

  it('администратор: свой прежний текст — в поле, «Сохранить для всех» пишет одну строку, письмо — по общему', async () => {
    const mine = 'Мой прежний шаблон. Тендер № {tender_number}.'
    const { page, errors, close } = await openPage(OS, { local: mine })
    try {
      await openTemplateTab(page)
      await page.locator('button', { hasText: 'Сохранить для всех' }).waitFor({ timeout: 10000 })
      await assert.doesNotReject(page.waitForFunction(() => !document.querySelector('textarea.letter-template-text').disabled))
      assert.match(await lead(page).textContent(), /общий для всех сотрудников/)
      assert.match(await lead(page).textContent(), /Общий шаблон ещё не сохранён/)
      assert.equal(await field(page).inputValue(), mine, 'пока общего нет — в поле текст из браузера администратора')
      assert.deepEqual(await settingRows(page), [])

      await field(page).fill('Новый общий. Тендер № {tender_number}, {object_name}.  \n\n')
      assert.equal(await page.locator('.letter-template-dirty').textContent(), 'Изменения не сохранены')
      assert.deepEqual(await settingRows(page), [], 'набор текста в базу не пишет')
      await page.locator('button', { hasText: 'Сохранить для всех' }).click()
      await page.locator('.letter-template-saved').waitFor({ timeout: 10000 })
      assert.match(await page.locator('.letter-template-saved').textContent(), /теперь он у всех сотрудников/)
      let rows = await settingRows(page)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].value, 'Новый общий. Тендер № {tender_number}, {object_name}.', 'хвостовые пробелы убраны')
      assert.equal(await page.locator('.letter-template-dirty').count(), 0)
      assert.doesNotMatch(await lead(page).textContent(), /ещё не сохранён/)
      assert.equal(await page.evaluate(() => localStorage.getItem('letterTemplate:v4')), mine, 'свой шаблон в браузере не тронут')

      // Вторая правка — та же строка (upsert по ключу), а не вторая.
      await field(page).fill('Общий, вторая редакция. Тендер № {tender_number}.')
      await page.locator('button', { hasText: 'Сохранить для всех' }).click()
      await page.waitForFunction((key) => window.__fakeDb.app_settings.some((r) => r.key === key && /вторая редакция/.test(r.value)), SHARED_LETTER_TEMPLATE_KEY)
      rows = await settingRows(page)
      assert.equal(rows.length, 1)

      await backToRegistry(page)
      assert.equal(await letterFor(page, 200), 'Общий, вторая редакция. Тендер № 200.')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('администратор: пустой шаблон не сохраняется; «По умолчанию» — вопрос «для всех» и запись текста по умолчанию', async () => {
    const { page, errors, dialogs, close } = await openPage(`${OS}&sharedLetter=1`)
    try {
      await openTemplateTab(page)
      await page.waitForFunction(() => !document.querySelector('textarea.letter-template-text').disabled)
      assert.equal(await field(page).inputValue(), SHARED_SEED, 'в поле — общий шаблон из базы')
      assert.match(await page.locator('.letter-template-stamp').textContent(), /Общий шаблон изменён 17\.11\.2026/)

      await field(page).fill('   ')
      await page.locator('button', { hasText: 'Сохранить для всех' }).click()
      assert.match(await page.locator('.letter-template-error').textContent(), /Шаблон пустой/)
      assert.equal((await settingRows(page))[0].value, SHARED_SEED, 'в базе прежний текст')
      assert.equal(await page.locator('.letter-template-saved').count(), 0)

      // «отменить» возвращает сохранённое.
      await page.locator('.letter-template-discard').click()
      assert.equal(await field(page).inputValue(), SHARED_SEED)
      assert.equal(await page.locator('.letter-template-error').count(), 0)

      await page.locator('button', { hasText: 'По умолчанию' }).click()
      await page.locator('.letter-template-saved').waitFor({ timeout: 10000 })
      assert.deepEqual(dialogs, ['Вернуть шаблон по умолчанию для всех сотрудников?'])
      const rows = await settingRows(page)
      assert.equal(rows.length, 1)
      assert.match(rows[0].value, /^Тема письма: Объект \{object_name\} \/ Тендер № \{tender_number\}/)
      assert.match(rows[0].value, /\{site_contact\}/)
      assert.equal(await field(page).inputValue(), rows[0].value)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('администратор: база отказала в записи — ошибка на экране, «Сохранено» нет, набранное остаётся', async () => {
    const { page, close } = await openPage(`${OS}&sharedLetter=1`)
    try {
      await openTemplateTab(page)
      await page.waitForFunction(() => !document.querySelector('textarea.letter-template-text').disabled)
      await page.evaluate(() => {
        window.__fakeHold = ({ table, op }) => (table === 'app_settings' && op === 'upsert'
          ? { error: { code: '42501', message: 'Эту настройку меняет сотрудник с правом правки её раздела' } } : null)
      })
      await field(page).fill('Не сохранится. Тендер № {tender_number}.')
      await page.locator('button', { hasText: 'Сохранить для всех' }).click()
      await page.locator('.letter-template-error').waitFor({ timeout: 10000 })
      assert.equal(await page.locator('.letter-template-error').textContent(), 'Общий шаблон письма меняет только администратор.')
      assert.equal(await page.locator('.letter-template-saved').count(), 0)
      assert.equal(await field(page).inputValue(), 'Не сохранится. Тендер № {tender_number}.')
      assert.equal((await settingRows(page))[0].value, SHARED_SEED)
    } finally {
      await close()
    }
  })

  it('администратор: общий шаблон не прочитался — править нельзя, «Повторить» читает', async () => {
    const init = () => {
      window.__letterReadFails = true
      window.__fakeHold = ({ table, op, filters }) => (window.__letterReadFails && table === 'app_settings' && op === 'select'
        && filters.some((f) => f.val === 'tender_letter_template:construction')
        ? { error: { code: '08006', message: 'нет связи' } } : null)
    }
    const { page, close } = await openPage(`${OS}&sharedLetter=1`, { init, local: 'Свой текст из браузера.' })
    try {
      await openTemplateTab(page)
      const alert = page.locator('.letter-template-error', { hasText: 'Не удалось прочитать общий шаблон' })
      await alert.waitFor({ timeout: 10000 })
      assert.equal(await field(page).isDisabled(), true, 'иначе текст из браузера лёг бы поверх общего')
      assert.equal(await page.locator('button', { hasText: 'Сохранить для всех' }).isDisabled(), true)
      assert.equal(await page.locator('button', { hasText: 'По умолчанию' }).isDisabled(), true)

      await page.evaluate(() => { window.__letterReadFails = false })
      await alert.getByRole('button', { name: 'Повторить' }).click()
      await page.waitForFunction(() => !document.querySelector('textarea.letter-template-text').disabled)
      assert.equal(await field(page).inputValue(), SHARED_SEED)
      assert.equal(await alert.count(), 0)
    } finally {
      await close()
    }
  })

  it('не администратор: общий шаблон — только чтение, свой из браузера не действует, письмо — по общему', async () => {
    const { page, errors, close } = await openPage(`${OS}&sharedLetter=1&asRole=engineer`, { local: 'Свой шаблон инженера № {tender_number}.' })
    try {
      await openTemplateTab(page)
      await page.waitForFunction((text) => document.querySelector('textarea.letter-template-text').value === text, SHARED_SEED)
      assert.equal(await field(page).isDisabled(), true)
      assert.match(await lead(page).textContent(), /общий для всех сотрудников, его меняет администратор/)
      assert.equal(await page.locator('button', { hasText: /Сохранить/ }).count(), 0)
      assert.equal(await page.locator('button', { hasText: 'По умолчанию' }).count(), 0)
      await backToRegistry(page)
      // tender-1 (№ 200) — объект obj-1, ответственный без телефона.
      assert.equal(await letterFor(page, 200),
        'Общий шаблон. Тендер № 200, объект «ЖК «Северный квартал»».\nВопросы — по телефону [Телефон не указан].')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('не администратор, общего нет: как раньше — свой шаблон в браузере; администратор сохранил — письмо уже по общему', async () => {
    const { page, errors, close } = await openPage(`${OS}&asRole=engineer`)
    try {
      await openTemplateTab(page)
      assert.equal(await field(page).isDisabled(), false)
      assert.match(await lead(page).textContent(), /^Редактируйте шаблон письма/)
      await field(page).fill('Свой шаблон. Тендер № {tender_number}.')
      await page.locator('button', { hasText: 'Сохранить шаблон' }).click()
      await page.locator('.letter-template-saved').waitFor({ timeout: 10000 })
      assert.equal(await page.evaluate(() => localStorage.getItem('letterTemplate:v4')), 'Свой шаблон. Тендер № {tender_number}.')
      assert.deepEqual(await settingRows(page), [], 'в базу не администратор не пишет')
      await backToRegistry(page)
      assert.equal(await letterFor(page, 200), 'Свой шаблон. Тендер № 200.')

      // Администратор сохранил общий в другом браузере: письмо перечитывает его без обновления страницы.
      await page.evaluate((key) => {
        window.__fakeDb.app_settings.push({ key, value: 'От администратора. Тендер № {tender_number}.', updated_at: new Date().toISOString() })
        window.__fakeTouch('app_settings')
      }, SHARED_LETTER_TEMPLATE_KEY)
      assert.equal(await letterFor(page, 199), 'От администратора. Тендер № 199.')
      await openTemplateTab(page)
      assert.equal(await field(page).inputValue(), 'От администратора. Тендер № {tender_number}.')
      assert.equal(await field(page).isDisabled(), true)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('другое направление («Прочее»): общий шаблон ОС не действует, администратор правит свой в браузере', async () => {
    const { page, errors, close } = await openPage('route=/tenders/other&tendersDept=other&tenders=10&items=20&cps=2&latency=0&sharedLetter=1')
    try {
      await openTemplateTab(page)
      assert.match(await field(page).inputValue(), /^Тема письма: Объект/)
      assert.equal(await field(page).isDisabled(), false)
      assert.match(await lead(page).textContent(), /^Редактируйте шаблон письма/)
      assert.equal(await page.locator('button', { hasText: 'Сохранить для всех' }).count(), 0)
      await field(page).fill('Прочее: свой текст № {tender_number}.')
      await page.locator('button', { hasText: 'Сохранить шаблон' }).click()
      await page.locator('.letter-template-saved').waitFor({ timeout: 10000 })
      assert.equal((await settingRows(page))[0].value, SHARED_SEED, 'общий шаблон ОС не тронут')
      await backToRegistry(page)
      assert.equal(await letterFor(page, 200), 'Прочее: свой текст № 200.')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
