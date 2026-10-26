// «Общая информация» (/general): блок «Наши порталы» под карточками разделов.
//   • десять порталов — название и описание, название — ссылка в новой вкладке без доступа к окну портала;
//   • адрес на странице не показывается (ни текстом, ни подсказкой title);
//   • название — по центру, крупнее описания, на своей подложке, без значка-стрелки;
//     при наведении выделяется — цвет и подложка меняются;
//   • на телефоне — один столбец, без прокрутки страницы вбок.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startStand, browserLaunchOptions, REPO } from './lib/stand.mjs'

const PORTALS = [
  ['FOT', 'https://fot.su10.ru/'],
  ['Signal', 'https://docs.sgnl.pro/'],
  ['Larix', 'https://cpm.su10.larix.ru/'],
  ['Обработка РД (web)', 'https://vibe.cloud-ip.cc/'],
  ['BillHub', 'https://www.ravek.link/'],
  ['Estimat', 'https://estimat.su10.ru/'],
  ['Payhub', 'https://payhub.su10.ru/'],
  ['Финансовый портал', 'https://fin.su10.ru/'],
  ['АВТО', 'https://auto.su10.ru/'],
  ['Garanthub', 'https://garant.su10.ru/'],
]

const launch = browserLaunchOptions()

describe('Общая информация: наши порталы', { skip: !launch && 'Нет Chromium/Chrome/Edge', timeout: 300000 }, () => {
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

  async function openGeneral(viewport) {
    const context = await browser.newContext({ locale: 'ru-RU', viewport })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${stand.url}?route=/general&latency=0&shell=1`)
    await page.locator('.portal-name').first().waitFor({ timeout: 120000 })
    return { page, errors, close: () => context.close().catch(() => {}) }
  }

  it('названия — ссылки в новой вкладке, адресов на странице нет, при наведении выделяются', async () => {
    const { page, errors, close } = await openGeneral({ width: 1400, height: 900 })
    try {
      const links = await page.locator('.portal-name').evaluateAll((list) => list.map((a) => ({
        text: a.textContent.trim(), href: a.href, target: a.target, rel: a.rel, title: a.title,
      })))
      assert.deepEqual(links.map((l) => [l.text, l.href]), PORTALS)
      for (const l of links) {
        assert.equal(l.target, '_blank', l.text)
        assert.match(l.rel, /noopener/, l.text)
        assert.equal(l.title, '', `${l.text}: адрес не показывается и подсказкой`)
      }
      assert.equal(await page.locator('.portal-description').count(), PORTALS.length)
      const text = await page.locator('.portals').innerText()
      for (const [, url] of PORTALS) {
        assert.ok(!text.includes(new URL(url).host), `адрес ${url} не виден на странице`)
      }

      assert.equal(await page.locator('.portal-name svg').count(), 0, 'без стрелки у названия')
      const view = await page.locator('.portal-item').first().evaluate((li) => {
        const name = getComputedStyle(li.querySelector('.portal-name'))
        const desc = getComputedStyle(li.querySelector('.portal-description'))
        return {
          align: name.textAlign, nameSize: parseFloat(name.fontSize), descSize: parseFloat(desc.fontSize),
          nameBg: name.backgroundColor, cardBg: getComputedStyle(li).backgroundColor,
        }
      })
      assert.equal(view.align, 'center', 'название по центру')
      assert.ok(view.nameSize > view.descSize, `название крупнее описания: ${view.nameSize} / ${view.descSize}`)
      assert.notEqual(view.nameBg, view.cardBg, 'у названия своя подложка')

      const larix = page.locator('.portal-name', { hasText: 'Larix' })
      const look = () => larix.evaluate((a) => {
        const s = getComputedStyle(a)
        return { color: s.color, background: s.backgroundColor }
      })
      const before = await look()
      await larix.hover()
      await page.waitForTimeout(250)
      const hovered = await look()
      assert.notEqual(hovered.color, before.color, 'цвет названия меняется')
      assert.notEqual(hovered.background, before.background, 'появляется подложка')
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })

  it('телефон: порталы в один столбец, страница не прокручивается вбок', async () => {
    const { page, errors, close } = await openGeneral({ width: 360, height: 800 })
    try {
      const lefts = await page.locator('.portal-item').evaluateAll((list) => list.map((li) => Math.round(li.getBoundingClientRect().left)))
      assert.equal(new Set(lefts).size, 1, `один столбец: ${lefts}`)
      const side = await page.evaluate(() => {
        const main = document.querySelector('.main-content')
        return Math.max(document.documentElement.scrollWidth - window.innerWidth, main.scrollWidth - main.clientWidth)
      })
      assert.ok(side <= 0, `прокрутка вбок: ${side}px`)
      assert.deepEqual(errors, [])
    } finally {
      await close()
    }
  })
})
