import { openStand } from './lib.mjs'
const out = {}
for (const variant of ['cur', 'new']) {
  const s = await openStand({ variant, view: 'materials', width: 1720, height: 1000 })
  out[variant] = await s.page.evaluate(() => {
    const t = document.querySelector('table.tenders-registry')
    const td = getComputedStyle(t.querySelector('tbody td'))
    return {
      cls: document.querySelector('.tenders-page').className,
      font: `${td.fontSize}/${td.lineHeight} padding ${td.padding}`,
      cols: [...t.querySelectorAll('thead th')].map(th => Math.round(th.getBoundingClientRect().width)).join('/'),
      rowsH: [...t.querySelectorAll('tbody tr')].map(tr => Math.round(tr.getBoundingClientRect().height)).join(','),
    }
  })
  await s.close()
}
const same = JSON.stringify(out.cur) === JSON.stringify(out.new)
console.log('материалы — класс:', out.new.cls)
console.log('cur:', out.cur.font, '|', out.cur.cols)
console.log('new:', out.new.font, '|', out.new.cols)
console.log(same ? 'OK   реестр материалов не изменился' : 'FAIL реестр материалов изменился')
