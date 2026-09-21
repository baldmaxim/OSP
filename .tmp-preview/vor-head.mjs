// Шапка «ВОРов и РД»: замеры и снимки до/после.
//   node .tmp-preview/vor-head.mjs
// Снимки — в каталог из SHOTS (по умолчанию scratchpad сессии).
import path from 'node:path'
import { openStand, elementShot, startServer } from './lib.mjs'

const SHOTS = process.env.SHOTS || 'C:/Users/Usrr/AppData/Local/Temp/claude/c--Users-Usrr-VSCode-Sadovnikov-OSP/403f0b54-2c90-44be-ab20-2503592fcba2/scratchpad'

const measure = (page) => page.evaluate(() => {
  const px = (n) => Math.round(n * 10) / 10
  const head = document.querySelector('.page-header-vors')
  if (!head) return { error: 'шапка не найдена' }
  const box = head.getBoundingClientRect()
  const h2 = head.querySelector('h2')
  const sw = head.querySelector('.vor-scope-switch')
  const chip = head.querySelector('.vor-duty-chip')
  const hint = head.querySelector('.page-header-hint')
  const r = (el) => (el ? el.getBoundingClientRect() : null)
  // Строк в шапке: считаем по центрам (высоты элементов разные, top у них
  // не совпадает даже когда они стоят рядом).
  const rows = new Set([h2, sw, chip, hint].filter(Boolean)
    .map((el) => Math.round((r(el).top + r(el).bottom) / 2 / 8)))
  const tabs = document.querySelector('.cost-plans-tabs')
  return {
    headerHeight: px(box.height),
    lines: rows.size,
    hint: hint ? hint.innerText.replace(/\s+/g, ' ').trim().slice(0, 40) + '…' : 'нет',
    title: { left: px(r(h2).left), width: px(r(h2).width) },
    switch: sw ? { left: px(r(sw).left), right: px(r(sw).right), height: px(r(sw).height) } : null,
    chip: chip ? { left: px(r(chip).left), right: px(r(chip).right), height: px(r(chip).height) } : null,
    headRight: px(box.right),
    gapTitleSwitch: sw ? px(r(sw).left - r(h2).right) : null,
    tabsTop: tabs ? px(tabs.getBoundingClientRect().top) : null,
    rowsCount: document.querySelectorAll('.vors-table tbody tr').length,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }
})

const server = await startServer()
for (const variant of ['cur', 'new']) {
  for (const width of [1920, 1720, 1366, 1100]) {
    const s = await openStand({ variant, page: 'vors', width, height: 900, server })
    const m = await measure(s.page)
    console.log(`${variant} @${width}: шапка ${m.headerHeight}px, строк ${m.lines}, подпись ${m.hint}, `
      + `переключатель ${m.switch ? m.switch.left + '→' + m.switch.right + ' (h ' + m.switch.height + ')' : '—'}, `
      + `дежурный ${m.chip ? m.chip.left + '→' + m.chip.right + ' (h ' + m.chip.height + ')' : '—'}, `
      + `правый край ${m.headRight}, вкладки с ${m.tabsTop}px, строк в таблице ${m.rowsCount}`
      + `${m.overflowX ? ', СТРАНИЦА ЕДЕТ ПО ГОРИЗОНТАЛИ' : ''}`)
    if (s.errors.length) console.log(`   ошибки: ${s.errors.slice(0, 3).join(' | ')}`)
    if (width === 1720 || width === 1100) {
      await elementShot(s.page, '.main-content', path.join(SHOTS, `vor-${variant}-${width}.png`))
    }
    await s.close()
  }
}
// Тёмная тема — только новый вариант.
const dark = await openStand({ variant: 'new', page: 'vors', width: 1720, height: 900, theme: 'dark', server })
console.log('new @1720 тёмная:', JSON.stringify(await measure(dark.page)))
await elementShot(dark.page, '.main-content', path.join(SHOTS, 'vor-new-dark.png'))
await dark.close()
await server.close()
console.log(`Снимки: ${SHOTS}`)
