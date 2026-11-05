// Заранее сжатые копии файлов сборки (dist/assets/*.gz): nginx отдаёт их готовыми (gzip_static), не тратя процессор на
// каждый ответ. Файлы сборки неизменяемы и лежат по адресам с хэшем, поэтому сжать их один раз при сборке выгоднее всего,
// и степень можно взять наибольшую. Трафик: pdf.worker 1,3 МБ → 0,4 МБ, xlsx 0,9 МБ → 0,3 МБ.
//
//   node scripts/precompress-dist.mjs <каталог сборки>
//
// Копия не создаётся, если сжатие почти ничего не даёт (шрифт woff2, картинка) или файл меньше MIN_BYTES: ради них nginx
// лишний раз искал бы файл. Исходный файл остаётся — браузеру без поддержки gzip nginx отдаёт его.
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { constants, gzip } from 'node:zlib'

const gzipAsync = promisify(gzip)
const COMPRESSIBLE = /\.(?:js|css|svg|json|html|txt|map|ttf|otf|ico)$/i
export const MIN_BYTES = 1024
const WORTH_RATIO = 0.9

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

export async function precompress(root) {
  let files = 0
  let before = 0
  let after = 0
  for await (const file of walk(root)) {
    if (!COMPRESSIBLE.test(file)) continue
    // Служебные файлы корня (index.html, version.json, sw.js) nginx отдаёт с запретом кэша и проверяет часто: они малы.
    if (path.dirname(path.resolve(file)) === path.resolve(root)) continue
    const raw = await fs.readFile(file)
    if (raw.length < MIN_BYTES) continue
    const packed = await gzipAsync(raw, { level: constants.Z_BEST_COMPRESSION })
    if (packed.length > raw.length * WORTH_RATIO) continue
    await fs.writeFile(`${file}.gz`, packed)
    files += 1
    before += raw.length
    after += packed.length
  }
  return { files, before, after }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const root = process.argv[2]
  if (!root) {
    console.error('Укажите каталог сборки: node scripts/precompress-dist.mjs dist')
    process.exit(1)
  }
  const { files, before, after } = await precompress(root)
  const mb = (n) => (n / 1048576).toFixed(1)
  console.log(`Сжато файлов: ${files}, ${mb(before)} МБ → ${mb(after)} МБ`)
}
