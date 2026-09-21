import { openStand } from './lib.mjs'
for (const variant of (process.argv[2] || 'cur,new').split(',')) {
  const s = await openStand({ variant, width: 1720, height: 1000 })
  const r = await s.page.evaluate(() => {
    const row = document.querySelector('table.tenders-registry > tbody > tr')
    const cells = [...row.children].map(td => {
      const cs = getComputedStyle(td)
      return `${td.cellIndex}:${cs.display}/right=${cs.borderRightWidth}/bottom=${cs.borderBottomWidth}`
    })
    // реально ли нарисована линия справа у ячейки описания
    const desc = row.querySelector('td.tender-desc-cell')
    const dcs = getComputedStyle(desc)
    return { cells, desc: `display=${dcs.display} borderRight=${dcs.borderRightWidth} ${dcs.borderRightColor}` }
  })
  console.log(`\n${variant}:`)
  console.log('  ' + r.cells.join('\n  '))
  console.log('  описание →', r.desc)
  await s.close()
}
