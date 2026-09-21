// Что задаёт высоту строк реестра тендеров: по каждой строке — самая высокая
// ячейка и разбор ячейки описания. node .tmp-preview/tp-measure.mjs [variants] [width]
import { openStand } from './lib.mjs'

const variants = (process.argv[2] || 'old,cur,new').split(',')
const width = Number(process.argv[3] || 1720)
const ROWS = ['782', '780', '778', '776', '772', '769', '766']

for (const variant of variants) {
  const s = await openStand({ variant, width, height: 1000 })
  const r = await s.page.evaluate((wanted) => {
    const px = (n) => Math.round(n * 10) / 10
    const table = document.querySelector('table.tenders-registry')
    const heads = [...table.querySelectorAll(':scope > thead > tr > th')].map(th => th.textContent.trim().replace(/\s+/g, ' ').slice(0, 18) || '—')
    const cols = [...table.querySelectorAll(':scope > thead > tr > th')].map(th => px(th.getBoundingClientRect().width))
    const out = []
    for (const tr of table.querySelectorAll(':scope > tbody > tr')) {
      const num = tr.querySelector('td')?.textContent.trim().match(/\d+/)?.[0]
      if (!wanted.includes(num)) continue
      const tds = [...tr.children]
      // высота содержимого ячейки = от верха первого до низа последнего потомка
      const contentH = (td) => {
        // только то, что лежит внутри ячейки: у обрезанного описания берём
        // высоту самого блока (а не полного текста), всплывающие меню отбрасываем
        const box = td.getBoundingClientRect()
        const rects = []
        for (const k of td.children) rects.push(k.getBoundingClientRect())
        for (const n of td.childNodes) {
          if (n.nodeType === 3 && n.textContent.trim()) {
            const rg = document.createRange(); rg.selectNode(n); rects.push(...rg.getClientRects())
          }
        }
        const inside = rects.filter(r => r.height > 0 && r.top >= box.top - 2 && r.bottom <= box.bottom + 2)
        if (!inside.length) return 0
        return px(Math.max(...inside.map(r => r.bottom)) - Math.min(...inside.map(r => r.top)))
      }
      const cells = tds.map((td, i) => ({ col: heads[i] || `#${i}`, h: contentH(td) }))
      const max = cells.reduce((a, b) => (b.h > a.h ? b : a))
      const desc = tr.querySelector('td.tender-desc-cell')
      const parts = desc ? [...desc.children].map(k => `${(k.className || k.tagName).toString().split(' ')[0]}=${px(k.getBoundingClientRect().height)}`) : []
      const objCell = tds[1]
      out.push({
        num,
        rowH: px(tr.getBoundingClientRect().height),
        driver: `${max.col} ${max.h}px`,
        top3: cells.sort((a, b) => b.h - a.h).slice(0, 3).map(c => `${c.col}:${c.h}`).join(' | '),
        desc: parts.join(' + '),
        objH: objCell ? contentH(objCell) : null,
      })
    }
    const cs = getComputedStyle(table.querySelector(':scope > tbody > tr > td'))
    const th = getComputedStyle(table.querySelector(':scope > thead > tr > th'))
    return {
      table: px(table.getBoundingClientRect().width),
      cont: px(table.closest('.table-container').clientWidth),
      cols: heads.map((h, i) => `${h}=${cols[i]}`).join(' | '),
      td: `${cs.fontSize}/${cs.lineHeight} padding ${cs.padding}`,
      th: `${th.fontSize}/${th.lineHeight} ${th.fontWeight} ${th.textTransform}`,
      rows: out,
      totalH: px([...table.querySelectorAll(':scope > tbody > tr')].reduce((a, tr) => a + tr.getBoundingClientRect().height, 0)),
      rowCount: table.querySelectorAll(':scope > tbody > tr').length,
    }
  }, ROWS)
  console.log(`\n=== ${variant} @${width}: таблица ${r.table} / контейнер ${r.cont}; строк ${r.rowCount}, сумма высот ${r.totalH}`)
  console.log(`  td: ${r.td}\n  th: ${r.th}`)
  console.log(`  колонки: ${r.cols}`)
  for (const row of r.rows) {
    console.log(`  № ${row.num}: строка ${row.rowH}px · задаёт: ${row.driver} · топ-3: ${row.top3}`)
    if (row.desc) console.log(`      описание: ${row.desc} · объект ${row.objH}px`)
  }
  console.log(`  ошибки: ${s.errors.length}`)
  await s.close()
}
