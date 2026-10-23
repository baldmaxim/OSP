// Публичная страница тендеров (/public/tenders, без входа) — представление public_open_tenders (миграции
// 20261016, 20261101):
//   • в строке тендера колонка «Контакты»: ФИО ответственного, под ним одним блоком его телефон и общий ящик
//     tender.osp@su10.ru (письмо — с темой «Объект … / Тендер № …»); нет ответственного — только почта;
//   • кнопка «Скачать» — одна надпись, без скрепки-эмодзи слева; контраст не ниже 4,5:1 в обеих темах;
//   • ссылками становятся только адреса http(s): javascript: и сетевой путь — не ссылка;
//   • страница читает только представление; колонок ответственного ещё нет (сайт раньше миграции) — список
//     без них, без ошибки;
//   • поиск — по номеру, объекту, адресу, работам и ответственному, без учёта «ё»;
//   • на телефоне — карточки без прокрутки вбок, кнопка во всю ширину.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'
import {
  TENDER_MAILBOX, formatShortDate, formatShortRange, safeHttpUrl, phoneHref, mailSubject, mailHref,
  normalizeSearch, searchText,
} from '../../src/utils/publicTenders.js'

describe('Публичные тендеры: правила без браузера', () => {
  it('даты — «15 июня» из строки базы, без сдвига часового пояса', () => {
    assert.equal(formatShortDate('2026-06-15'), '15 июня')
    assert.equal(formatShortDate('2026-01-01'), '1 января')
    assert.equal(formatShortDate(null), '')
    assert.equal(formatShortRange('2026-11-01', '2026-12-15'), '1 ноября — 15 декабря')
    assert.equal(formatShortRange(null, '2026-12-15'), '15 декабря')
    assert.equal(formatShortRange(null, null), '—')
  })

  it('ссылкой становится только http(s)', () => {
    assert.equal(safeHttpUrl(' https://drive.example.ru/a b'), null, 'пробел внутри — не адрес')
    assert.equal(safeHttpUrl(' https://drive.example.ru/folder?id=1 '), 'https://drive.example.ru/folder?id=1')
    assert.equal(safeHttpUrl('http://yandex.ru/maps/?pt=1,2'), 'http://yandex.ru/maps/?pt=1,2')
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>x</b>', '\\\\srv\\tenders',
      'ftp://srv/file', 'https://', '', null, undefined, `https://x.ru/${'a'.repeat(2000)}`]) {
      assert.equal(safeHttpUrl(bad), null, String(bad).slice(0, 40))
    }
  })

  it('телефон: звонок по первому номеру без добавочного; внутренний номер — не ссылка', () => {
    assert.equal(phoneHref('8 (916) 123-45-67'), 'tel:89161234567')
    assert.equal(phoneHref('+7 (495) 123-45-67 доб. 12'), 'tel:+74951234567')
    assert.equal(phoneHref('+7 701 000-00-00, +7 727 300-00-00'), 'tel:+77010000000')
    assert.equal(phoneHref('доб. 214'), null)
    assert.equal(phoneHref(null), null)
  })

  it('письмо — в общий ящик, тема: объект и номер тендера', () => {
    assert.equal(TENDER_MAILBOX, 'tender.osp@su10.ru')
    const t = { public_tender_number: 369, object_name: 'ЖК «Тёплый стан»' }
    assert.equal(mailSubject(t), 'Объект ЖК «Тёплый стан» / Тендер № 369')
    const href = mailHref(t)
    assert.ok(href.startsWith('mailto:tender.osp@su10.ru?subject='), href)
    assert.equal(decodeURIComponent(href.split('subject=')[1]), 'Объект ЖК «Тёплый стан» / Тендер № 369')
    assert.ok(!/[\s«»&?#]/.test(href.split('subject=')[1]), 'тема закодирована целиком')
    assert.equal(mailSubject({ public_tender_number: null, object_name: null }), 'Вопрос по тендеру')
  })

  it('поиск: без регистра и «ё», по номеру и ответственному', () => {
    const text = searchText({ public_tender_number: 369, object_name: 'ЖК «Тёплый стан»', object_address: 'Москва',
      work_description: 'Кровля', responsible_name: 'Крюкова Юлия' })
    for (const q of ['теплый', 'ТЁПЛЫЙ', '369', 'крюкова', '  кровля ']) assert.ok(text.includes(normalizeSearch(q)), q)
    assert.ok(!text.includes(normalizeSearch('фасад')))
  })
})

const launch = browserLaunchOptions()

// Контраст по WCAG: цвета из getComputedStyle (rgb/rgba), фон без прозрачности.
const CONTRAST = `(fg, bg) => {
  const parse = (c) => c.match(/[\\d.]+/g).slice(0, 3).map(Number)
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [a, b] = [lum(parse(fg)), lum(parse(bg))].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}`

describe('Публичные тендеры: страница', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function openPublic({ viewport = { width: 1400, height: 900 }, query = '' } = {}) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    // Предупреждения React (в том числе о ссылке javascript:) — тоже ошибка; 404 значка стенда — нет.
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
    await page.goto(`${stand.url}?route=/public/tenders&latency=0${query}`)
    await page.locator('.public-tenders-table tbody tr').first().waitFor({ timeout: 120000 })
    const row = (num) => page.locator('.public-tenders-table tbody tr', { has: page.locator('td.col-num', { hasText: String(num) }) })
    return { page, errors, row, close: () => context.close().catch(() => {}) }
  }

  it('контакты: ФИО, под ним одним блоком телефон и общая почта; без ответственного — только почта', async () => {
    const { page, errors, row, close } = await openPublic()
    try {
      assert.equal(await page.locator('.public-tenders-table tbody tr').count(), 3)
      assert.equal(await page.locator('.public-tenders-table th.col-contact').textContent(), 'Контакты')

      const c369 = row(369).locator('td.col-contact')
      assert.equal(await c369.locator('.public-contact-name').innerText(), 'Крюкова Юлия Денисовна')
      const block = c369.locator('.public-contact-block')
      assert.equal(await block.count(), 1, 'телефон и почта — в одном блоке')
      const links = await block.locator('a').evaluateAll((list) => list.map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') })))
      assert.deepEqual(links, [
        { text: '8 (916) 123-45-67', href: 'tel:89161234567' },
        { text: 'tender.osp@su10.ru', href: `mailto:tender.osp@su10.ru?subject=${encodeURIComponent('Объект ЖК «Тёплый стан» / Тендер № 369')}` },
      ])
      const order = await c369.evaluate((td) => {
        const name = td.querySelector('.public-contact-name').getBoundingClientRect()
        const blk = td.querySelector('.public-contact-block').getBoundingClientRect()
        return { nameAbove: name.bottom <= blk.top + 1 }
      })
      assert.ok(order.nameAbove, 'ФИО над блоком')

      const c370 = row(370).locator('td.col-contact')
      assert.equal(await c370.locator('.public-contact-name').count(), 0, 'без ответственного ФИО нет')
      assert.deepEqual(await c370.locator('.public-contact-block a').evaluateAll((l) => l.map((a) => a.textContent.trim())), ['tender.osp@su10.ru'])

      const c371 = row(371).locator('td.col-contact')
      assert.equal(await c371.locator('.public-contact-name').innerText(), 'Архипов Антон Михайлович')
      assert.equal(await c371.locator('.public-contact-phone').evaluate((el) => el.tagName), 'SPAN', 'внутренний номер — не ссылка')
      assert.equal(await c371.locator('.public-contact-phone').innerText(), 'доб. 214')

      // Гость читает только представление.
      const tables = await page.evaluate(() => [...new Set(window.__supabaseStats.requests.map((r) => r.table))])
      assert.deepEqual(tables, ['public_open_tenders'])
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('кнопка «Скачать» — без значка слева, читаемая в обеих темах, не прыгает при наведении', async () => {
    const { page, errors, row, close } = await openPublic()
    try {
      const btn = row(369).locator('.public-tender-package-btn')
      assert.equal(await btn.innerText(), 'Скачать')
      const info = await btn.evaluate((a) => ({
        text: a.textContent, children: a.children.length, href: a.getAttribute('href'), target: a.target, rel: a.rel,
        label: a.getAttribute('aria-label'),
      }))
      assert.equal(info.text, 'Скачать', 'ни эмодзи, ни пробела перед надписью')
      assert.equal(info.children, 0, 'ни значка, ни картинки внутри')
      assert.equal(info.href, 'https://drive.example.ru/package-369')
      assert.equal(info.target, '_blank')
      assert.match(info.rel, /noopener/)
      assert.match(info.rel, /noreferrer/)
      assert.equal(info.label, 'Скачать тендерный пакет тендера № 369')

      const contrast = new Function(`return ${CONTRAST}`)()
      for (const theme of ['light', 'dark']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
        await page.waitForTimeout(300) // фон кнопки меняется плавно (transition)
        const s = await btn.evaluate((a) => { const cs = getComputedStyle(a); return { fg: cs.color, bg: cs.backgroundColor } })
        const ratio = contrast(s.fg, s.bg)
        assert.ok(ratio >= 4.5, `${theme}: контраст кнопки ${ratio.toFixed(2)} (${s.fg} на ${s.bg})`)
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
      await btn.hover()
      await page.waitForTimeout(250)
      assert.equal(await btn.evaluate((a) => getComputedStyle(a).transform), 'none', 'без подпрыгивания')

      // На странице не осталось эмодзи (скрепка, булавка у адреса, лупа в поиске).
      const text = await page.locator('.public-tenders-page').innerText()
      const placeholder = await page.locator('.public-search').getAttribute('placeholder')
      for (const s of [text, placeholder]) assert.ok(!/\p{Emoji_Presentation}/u.test(s), `эмодзи: ${s.match(/\p{Emoji_Presentation}/u)}`)
      assert.equal(await row(369).locator('.public-tender-address-link svg').count(), 1, 'у адреса — SVG-значок')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('ссылки — только http(s): javascript: и сетевой путь ссылкой не становятся', async () => {
    const { page, errors, row, close } = await openPublic()
    try {
      const hrefs = await page.locator('.public-tenders-page a[href]').evaluateAll((l) => l.map((a) => a.getAttribute('href')))
      assert.ok(hrefs.length > 0)
      for (const h of hrefs) assert.match(h, /^(https?:\/\/|mailto:|tel:|\/partner$)/, h)
      assert.equal(await row(370).locator('.public-tender-package-btn').count(), 0)
      assert.equal(await row(370).locator('.public-tender-package-empty').innerText(), 'не приложен')
      assert.equal(await row(370).locator('.public-tender-address-link').count(), 0, 'адрес без ссылки на карту')
      assert.equal(await row(370).locator('.public-tender-address').innerText(), 'Москва, ул. Северная, 5')
      assert.equal(await row(371).locator('.public-tender-package-empty').innerText(), 'не приложен', 'сетевой путь гостю не открыть')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('поиск: номер, объект без «ё», ответственный; ничего не найдено — своя подсказка', async () => {
    const { page, errors, close } = await openPublic()
    try {
      const search = page.locator('.public-search')
      const nums = () => page.locator('.public-tenders-table tbody td.col-num').allInnerTexts()
      await search.fill('теплый')
      assert.deepEqual(await nums(), ['369'])
      await search.fill('архипов')
      assert.deepEqual(await nums(), ['371'])
      await search.fill('370')
      assert.deepEqual(await nums(), ['370'])
      await search.fill('несуществующий объект')
      assert.match(await page.locator('.public-state').innerText(), /ничего не найдено/)
      assert.match(await page.locator('.public-total-count').innerText(), /Всего: 3/)
      await search.fill('')
      assert.equal((await nums()).length, 3)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('колонок ответственного ещё нет (сайт раньше миграции) — список без них, в контактах общая почта', async () => {
    const { page, errors, close } = await openPublic({ query: '&publicNoContact=1' })
    try {
      assert.equal(await page.locator('.public-tenders-table tbody tr').count(), 3)
      assert.equal(await page.locator('.public-contact-name').count(), 0)
      assert.equal(await page.locator('.public-contact-mail').count(), 3)
      assert.equal(await page.locator('.public-state-error').count(), 0)
      const reqs = await page.evaluate(() => window.__supabaseStats.requests.map((r) => r.table))
      assert.deepEqual(reqs, ['public_open_tenders', 'public_open_tenders'], 'вторая попытка — без колонок ответственного')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('телефон: карточки без прокрутки вбок, кнопка во всю ширину, контакты на месте', async () => {
    const { page, errors, row, close } = await openPublic({ viewport: { width: 360, height: 800 } })
    try {
      const side = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      assert.ok(side <= 0, `прокрутка вбок: ${side}px`)
      const sizes = await row(369).evaluate((tr) => ({
        card: tr.querySelector('td.col-package').getBoundingClientRect().width,
        btn: tr.querySelector('.public-tender-package-btn').getBoundingClientRect().width,
      }))
      assert.ok(sizes.btn >= sizes.card - 1, `кнопка ${sizes.btn} из ${sizes.card}`)
      assert.ok(await row(369).locator('.public-contact-block').isVisible())
      assert.match(await row(369).locator('td.col-contact').innerText(), /Крюкова Юлия Денисовна[\s\S]*8 \(916\) 123-45-67[\s\S]*tender\.osp@su10\.ru/)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
