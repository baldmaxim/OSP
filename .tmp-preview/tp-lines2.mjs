import { openStand } from './lib.mjs'
for (const variant of (process.argv[2] || 'cur,new').split(',')) {
  const s = await openStand({ variant, width: 1720, height: 1000 })
  const r = await s.page.evaluate(() => {
    const out = []
    for (const tr of [...document.querySelectorAll('table.tenders-registry > tbody > tr')].slice(0, 5)) {
      const rowH = Math.round(tr.getBoundingClientRect().height)
      const short = [...tr.children]
        .map(td => ({ i: td.cellIndex, h: Math.round(td.getBoundingClientRect().height), cls: td.className.split(' ')[0] }))
        .filter(c => c.h < rowH - 1)
      out.push(`строка ${tr.querySelector('td')?.textContent.trim().match(/\d+/)?.[0]} высотой ${rowH}px · ячейки ниже строки: ${short.length ? short.map(c => `${c.i}(${c.cls || 'td'})=${c.h}`).join(', ') : 'нет'}`)
    }
    return out
  })
  console.log(`\n${variant}:\n  ` + r.join('\n  '))
  await s.close()
}
