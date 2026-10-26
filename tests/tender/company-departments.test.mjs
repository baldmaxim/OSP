// «Общая информация» → «Отделы»: помощники (без браузера) и страница в Chromium (стенд tests/tender/ui).
//   • отделы по блокам со сквозным номером, руководители и телефоны (ссылка для звонка);
//   • поиск по отделу, функциям, ФИО и цифрам телефона — номер отдела при поиске не меняется;
//   • администратор: карточка отдела (контакты), порядок стрелками, «Руководители списком»;
//   • без права правки — только просмотр; таблицы ещё нет — подсказка про миграцию;
//   • карточка «Отделы» на /general.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  cleanContacts, formatPhone, groupDepartments, matchesDepartment, moveDepartment, numberDepartments,
  parseContactsList, phoneHref,
} from '../../src/utils/companyDepartments.js'

const DEPTS = [
  { id: 'a', sort_order: 10, block: 'Обеспечение', name: 'Юридический отдел', duties: 'Судебная защита', contacts: [{ name: 'Иванов И. И.', position: '', phone: '+7 900 111-22-33' }] },
  { id: 'b', sort_order: 20, block: 'Обеспечение', name: 'Секретариат', duties: 'Регистрация писем', contacts: [] },
  { id: 'c', sort_order: 30, block: 'Финансы', name: 'Бухгалтерия', duties: 'Налоги', contacts: [] },
]

describe('Отделы: помощники', () => {
  it('блоки по порядку, номер сквозной и сохраняется при поиске', () => {
    const groups = groupDepartments(numberDepartments(DEPTS).filter(d => matchesDepartment(d, 'налоги')))
    assert.deepEqual(groups.map(g => [g.block, g.items.map(i => [i.name, i.number])]), [['Финансы', [['Бухгалтерия', 3]]]])
    assert.deepEqual(groupDepartments(DEPTS).map(g => g.items.length), [2, 1])
  })

  it('поиск: слова в любом порядке, ё = е, цифры телефона', () => {
    assert.ok(matchesDepartment(DEPTS[0], 'защита судебная'))
    assert.ok(matchesDepartment(DEPTS[0], 'иванов'))
    assert.ok(matchesDepartment(DEPTS[0], '111-22'))
    assert.ok(matchesDepartment(DEPTS[0], '1112233'))
    assert.ok(!matchesDepartment(DEPTS[1], 'иванов'))
    assert.ok(matchesDepartment(DEPTS[1], ''))
  })

  it('телефон: российский номер — в одном виде, ссылка для звонка', () => {
    assert.equal(formatPhone('+7900445-20-15'), '+7 900 445-20-15')
    assert.equal(formatPhone('8 (916) 123-45-67'), '+7 916 123-45-67')
    assert.equal(formatPhone('9161234567'), '+7 916 123-45-67')
    assert.equal(formatPhone('доб. 214'), 'доб. 214')
    assert.equal(formatPhone('+7 900 151-23-31 доб. 5'), '+7 900 151-23-31 доб. 5')
    assert.equal(phoneHref('+7 900 712-25-46'), 'tel:+79007122546')
    assert.equal(phoneHref('8 900 712 25 46'), 'tel:+79007122546')
    assert.equal(phoneHref('—'), null)
  })

  it('контакты: три поля, без пустых', () => {
    assert.deepEqual(cleanContacts([{ name: ' Иванов ', position: '', phone: '89001112233', extra: 1 }, { name: '', phone: '' }]),
      [{ name: 'Иванов', position: '', phone: '+7 900 111-22-33' }])
  })

  it('порядок: правки только у сдвинутых, края — null', () => {
    assert.deepEqual(moveDepartment(DEPTS, 'b', -1), [{ id: 'b', sort_order: 10 }, { id: 'a', sort_order: 20 }])
    assert.equal(moveDepartment(DEPTS, 'a', -1), null)
    assert.equal(moveDepartment(DEPTS, 'c', 1), null)
  })

  it('руководители списком: номер или название, «|» или табуляция, ошибки построчно', () => {
    const text = [
      '# комментарий',
      '1 | Петров Пётр Петрович | Руководитель | +7900 151-23-31',
      '1\tСидоров С. С.\t\t+7900 566-12-61',
      'Секретариат | Ковалёва К. К. | +7 900 151-20-12',
      '',
      '9 | Никто | | +7 900 000-00-00',
      '3 |  |  | ',
    ].join('\n')
    const { updates, lines, errors } = parseContactsList(text, DEPTS)
    assert.equal(lines.length, 3)
    assert.deepEqual(updates.get('a'), [
      { name: 'Петров Пётр Петрович', position: 'Руководитель', phone: '+7 900 151-23-31' },
      { name: 'Сидоров С. С.', position: '', phone: '+7 900 566-12-61' },
    ])
    // Три поля: третье похоже на номер — это телефон.
    assert.deepEqual(updates.get('b'), [{ name: 'Ковалёва К. К.', position: '', phone: '+7 900 151-20-12' }])
    assert.deepEqual(errors.map(e => [e.line, e.reason]), [[6, 'нет отдела № 9'], [7, 'нет ни ФИО, ни телефона']])
  })
})

const launch = browserLaunchOptions()

describe('Отделы: страница', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function open(query = '', viewport = { width: 1400, height: 900 }) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()) })
    page.on('dialog', (d) => d.accept())
    await page.goto(`${stand.url}?route=/general/departments&latency=0&shell=1${query}`)
    await page.locator('.departments-page h2').waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }

  const names = (page) => page.locator('.dp-row:not(.dp-row-head) .dp-name').allInnerTexts()
  const fakeRow = (page, id) => page.evaluate((rid) => window.__fakeDb.company_departments.find(d => d.id === rid), id)

  it('блоки, номера, руководители и звонок; поиск', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('.dp-block').first().waitFor()
      assert.deepEqual(await page.locator('.dp-block-title').allInnerTexts(), ['Обеспечение деятельности компании', 'Тендеры', 'Финансы'])
      assert.deepEqual(await page.locator('.dp-row:not(.dp-row-head) .dp-num').allInnerTexts(), ['1', '2', '3', '4'])
      const phone = page.locator('.dp-row', { hasText: 'Юридический отдел' }).locator('a.dp-contact-phone')
      assert.equal(await phone.getAttribute('href'), 'tel:+79001112233')
      assert.equal((await phone.innerText()).trim(), '+7 900 111-22-33')
      const aho = page.locator('.dp-row', { hasText: 'Административно-хозяйственный' })
      assert.match(await aho.locator('.dp-note-line').innerText(), /Руководитель отсутствует/)
      assert.match(await aho.locator('.dp-contact-pos').innerText(), /по сим-картам/)
      assert.match(await page.locator('.dp-row', { hasText: 'Финансовый отдел' }).locator('.dp-contacts').innerText(), /Руководитель не указан/)

      await page.locator('.dp-search').fill('сим-картам')
      assert.deepEqual(await names(page), ['Административно-хозяйственный отдел'])
      assert.deepEqual(await page.locator('.dp-row:not(.dp-row-head) .dp-num').allInnerTexts(), ['2'], 'номер не меняется')
      await page.locator('.dp-search').fill('0011122')
      assert.deepEqual(await names(page), ['Юридический отдел'])
      await page.locator('.dp-search').fill('нет такого')
      await page.locator('.dp-empty', { hasText: 'Ничего не найдено' }).waitFor()
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('администратор: карточка отдела, порядок, руководители списком', async () => {
    const { page, errors, close } = await open()
    try {
      await page.locator('.dp-block').first().waitFor()
      // Карточка: второй контакт у отдела сопровождения подрядчиков.
      const osp = page.locator('.dp-row', { hasText: 'Отдел по сопровождению подрядчиков' })
      await osp.getByRole('button', { name: /Изменить/ }).click()
      const modal = page.locator('.dp-modal')
      await modal.getByLabel('ФИО, контакт 1').fill('Тестовая Т. Т.')
      await modal.getByLabel('Должность, контакт 1').fill('Руководитель отдела')
      await modal.getByLabel('Телефон, контакт 1').fill('89051234567')
      await modal.getByRole('button', { name: 'Сохранить' }).click()
      await modal.waitFor({ state: 'detached' })
      assert.deepEqual((await fakeRow(page, 'dep-3')).contacts, [{ name: 'Тестовая Т. Т.', position: 'Руководитель отдела', phone: '+7 905 123-45-67' }])
      assert.equal(await osp.locator('a.dp-contact-phone').getAttribute('href'), 'tel:+79051234567')

      // Порядок: «Финансовый отдел» выше «Отдела по сопровождению» — в базе переставлены только они.
      await page.locator('.dp-row', { hasText: 'Финансовый отдел' }).getByRole('button', { name: /Выше/ }).click()
      await page.waitForFunction(() => window.__fakeDb.company_departments.find(d => d.id === 'dep-4').sort_order === 30)
      assert.equal((await fakeRow(page, 'dep-3')).sort_order, 40)
      assert.equal((await fakeRow(page, 'dep-1')).sort_order, 10)

      // Руководители списком: ошибка не даёт сохранить, исправленный список — сохраняется.
      await page.getByRole('button', { name: 'Руководители списком' }).click()
      const list = page.locator('.dp-modal-wide')
      await list.getByLabel('Список руководителей').fill('1 | Новиков Н. Н. | Начальник | +7 901 000-00-01\n77 | Никто | |')
      await list.locator('.dp-list-errors', { hasText: 'нет отдела № 77' }).waitFor()
      assert.equal(await list.getByRole('button', { name: 'Сохранить' }).isDisabled(), true)
      await list.getByLabel('Список руководителей').fill('1 | Новиков Н. Н. | Начальник | +7 901 000-00-01\nЮридический отдел | Орлов О. О. | | 8 901 000 00 02')
      await list.locator('.dp-list-summary', { hasText: 'Контактов: 2, отделов: 1' }).waitFor()
      await list.getByRole('button', { name: 'Сохранить' }).click()
      await list.waitFor({ state: 'detached' })
      assert.deepEqual((await fakeRow(page, 'dep-1')).contacts, [
        { name: 'Новиков Н. Н.', position: 'Начальник', phone: '+7 901 000-00-01' },
        { name: 'Орлов О. О.', position: '', phone: '+7 901 000-00-02' },
      ])
      // Остальные отделы список не тронул.
      assert.equal((await fakeRow(page, 'dep-2')).contacts.length, 1)

      // Новый отдел — в конец.
      await page.getByRole('button', { name: '+ Добавить отдел' }).click()
      await page.locator('#dp-name').fill('Геодезическая служба')
      await page.locator('#dp-block').fill('Работы при строительстве')
      await page.locator('.dp-modal').getByRole('button', { name: 'Сохранить' }).click()
      await page.locator('.dp-block-title', { hasText: 'Работы при строительстве' }).waitFor()
      assert.equal(await page.locator('.dp-row', { hasText: 'Геодезическая служба' }).locator('.dp-num').innerText(), '5')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('без права правки — только просмотр; таблицы нет — подсказка', async () => {
    const view = await open('&canEdit=0')
    try {
      await view.page.locator('.dp-block').first().waitFor()
      assert.equal(await view.page.locator('.dp-actions').count(), 0)
      assert.equal(await view.page.getByRole('button', { name: 'Руководители списком' }).count(), 0)
      assert.deepEqual(view.errors, [])
    } finally {
      await view.close()
    }
    const missing = await open('&departments=missing')
    try {
      await missing.page.locator('.dp-empty', { hasText: 'миграция 20261104_company_departments' }).waitFor()
      assert.equal(await missing.page.getByRole('button', { name: '+ Добавить отдел' }).count(), 0)
    } finally {
      await missing.close()
    }
  })

  it('телефон: строки в столбец, без прокрутки вбок; карточка «Отделы» на /general', async () => {
    const { page, errors, close } = await open('', { width: 360, height: 800 })
    try {
      await page.locator('.dp-block').first().waitFor()
      const side = await page.evaluate(() => {
        const main = document.querySelector('.main-content')
        return Math.max(document.documentElement.scrollWidth - window.innerWidth, main.scrollWidth - main.clientWidth)
      })
      assert.ok(side <= 0, `прокрутка вбок: ${side}px`)
      await page.evaluate(() => window.__navigate('/general'))
      const card = page.locator('.section-card', { hasText: 'Отделы' })
      await card.waitFor()
      await card.click()
      await page.locator('.departments-page h2').waitFor()
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
