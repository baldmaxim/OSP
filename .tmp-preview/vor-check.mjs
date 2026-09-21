// Проверки шапки «ВОРов и РД» после правки: переключатель направления,
// фокус с клавиатуры, отсутствие подписи, одна строка при обоих направлениях.
//   node .tmp-preview/vor-check.mjs
import { openStand } from './lib.mjs'

let fails = 0
const ok = (cond, text) => { if (!cond) fails++; console.log(`${cond ? 'OK  ' : 'FAIL'} ${text}`) }

const headInfo = (page) => page.evaluate(() => {
  const px = (n) => Math.round(n * 10) / 10
  const head = document.querySelector('.page-header-vors')
  const r = (el) => el.getBoundingClientRect()
  const items = [head.querySelector('h2'), head.querySelector('.vor-scope-switch'), head.querySelector('.vor-duty-chip')]
  const centers = new Set(items.map((el) => Math.round((r(el).top + r(el).bottom) / 2)))
  return {
    height: px(r(head).height),
    lines: centers.size,
    hint: !!head.querySelector('.page-header-hint'),
    active: head.querySelector('.vor-scope-btn.is-active')?.textContent.trim(),
    rows: document.querySelectorAll('.vors-table tbody tr').length,
    // Ничего не вылезает за шапку по высоте.
    overflow: items.some((el) => r(el).top < r(head).top || r(el).bottom > r(head).bottom),
  }
})

const s = await openStand({ variant: 'new', page: 'vors', width: 1720, height: 900 })
const page = s.page

const before = await headInfo(page)
ok(!before.hint, `подписи под шапкой нет (высота шапки ${before.height}px, элементы в одну строку: ${before.lines === 1})`)
ok(before.lines === 1 && !before.overflow, `заголовок, переключатель и дежурный на одной линии, за шапку не выходят`)
ok(before.active === 'Основное строительство', `активное направление: ${before.active}, строк ${before.rows}`)

// Фокус с клавиатуры (Tab, до первого клика мышью — иначе :focus-visible не
// срабатывает и рамку фокуса не измерить).
const tabFocus = await (async () => {
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab')
    const r = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || !el.classList.contains('vor-scope-btn')) return null
      const cs = getComputedStyle(el)
      return { text: el.textContent.trim(), outline: `${cs.outlineStyle} ${cs.outlineWidth}`, height: Math.round(el.getBoundingClientRect().height) }
    })
    if (r) return r
  }
  return null
})()
ok(tabFocus && tabFocus.outline !== 'none 0px' && tabFocus.outline.startsWith('solid'),
  `фокус с клавиатуры на «${tabFocus?.text}» виден: ${tabFocus?.outline}, высота кнопки ${tabFocus?.height}px`)

await page.getByRole('tab', { name: 'Совместные тендеры' }).click()
await page.waitForTimeout(400)
const after = await headInfo(page)
ok(after.active === 'Совместные тендеры' && after.height === before.height,
  `переключение работает: ${after.active}, шапка ${after.height}px, строк ${after.rows}`)

// Вкладки и панель фильтров не сдвинулись относительно шапки.
const below = await page.evaluate(() => {
  const head = document.querySelector('.page-header-vors').getBoundingClientRect()
  const tabs = document.querySelector('.cost-plans-tabs').getBoundingClientRect()
  const bar = document.querySelector('.cost-plans-toolbar').getBoundingClientRect()
  return { gap1: Math.round(tabs.top - head.bottom), gap2: Math.round(bar.top - tabs.bottom) }
})
ok(below.gap1 === 0 && below.gap2 === 0, `шапка, вкладки и панель без зазоров: ${below.gap1}px / ${below.gap2}px`)

ok(s.errors.length === 0, `ошибок страницы: ${s.errors.length}${s.errors.length ? ' — ' + s.errors[0] : ''}`)
await s.close()
console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nВсе проверки пройдены')
process.exitCode = fails ? 1 : 0
