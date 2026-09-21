// Прогон всех вариантов стенда: снимок рабочей области + ошибки страницы.
//
//   node .tmp-preview/smoke.mjs                       # old, cur, new → .tmp-preview/shots
//   node .tmp-preview/smoke.mjs --out C:/tmp/shots
//   node .tmp-preview/smoke.mjs --variants cur,new --view materials --width 1720
//   node .tmp-preview/smoke.mjs --metrics             # ещё и замеры таблицы
//
// Файлы: tp-{variant}-{width}.png. Код возврата ≠ 0, если где-то упала страница.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer, openStand, elementShot, tableMetrics } from './lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const flag = (name) => process.argv.includes(`--${name}`)

const outDir = path.resolve(arg('out', path.join(HERE, 'shots')))
const variants = arg('variants', 'old,cur,new').split(',').map((s) => s.trim()).filter(Boolean)
const view = arg('view', 'construction')
const width = Number(arg('width', 1720))
const height = Number(arg('height', 1000))
const theme = arg('theme', 'light')
const selector = arg('selector', '.main-content')
const withMetrics = flag('metrics')

fs.mkdirSync(outDir, { recursive: true })
const server = await startServer()
let failed = 0

for (const variant of variants) {
  const stand = await openStand({ variant, view, width, height, theme, server })
  const suffix = view === 'construction' ? '' : `-${view}`
  const file = path.join(outDir, `tp-${variant}${suffix}-${width}.png`)
  await elementShot(stand.page, selector, file)

  const metrics = withMetrics ? await tableMetrics(stand.page) : null
  const errors = stand.errors
  if (errors.length) failed += 1

  console.log(`\n── ${variant} ${view} ${width}×${height} ──`)
  console.log(`   снимок: ${file}`)
  if (metrics) {
    console.log(`   строк: ${metrics.rowCount}, средняя высота: ${metrics.rowHeightAvg}px, шапка: ${metrics.headerHeight}px`)
    console.log(`   таблица: ${metrics.tableWidth}px в ${metrics.containerWidth}px, гор. прокрутка: ${metrics.horizontalScroll}`)
    console.log(`   шрифт: ${metrics.tableFontSize} ${metrics.font.split(',')[0]}`)
    console.log(`   классы: ${metrics.pageClasses}`)
    for (const r of metrics.rows) {
      console.log(`     № ${r.number.padEnd(6)} ${String(r.height).padStart(6)}px` +
        `${r.clampToggle ? ' · «Показать полностью»' : ''}` +
        `${r.addressToggle ? ' · адрес под кнопкой' : ''}` +
        `${r.addressVisible ? ' · адрес виден' : ''}`)
    }
  }
  if (errors.length) {
    console.log(`   ОШИБКИ СТРАНИЦЫ (${errors.length}):`)
    errors.forEach((e) => console.log(`     ! ${e}`))
  } else {
    console.log('   ошибок страницы нет')
  }

  await stand.page.close()
  await stand.context.close()
  await stand.browser.close()
}

await server.close()
console.log(`\nГотово: ${variants.length} вариант(ов), ошибок в ${failed}.`)
process.exit(failed ? 1 : 0)
