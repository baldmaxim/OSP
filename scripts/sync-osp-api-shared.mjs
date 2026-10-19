// Общий код страницы расценки и службы osp-api: разбор файла ВОР и план автозагрузки позиций.
//
// Образ osp-api собирается только из server/osp-api (deploy/docker/api.Dockerfile), поэтому служба держит копии
// модулей src/utils в server/osp-api/src/shared. Правят оригиналы, затем:
//   node scripts/sync-osp-api-shared.mjs          — переписать копии;
//   node scripts/sync-osp-api-shared.mjs --check  — только сравнить (код 1, если копия отстала).
// То же сравнение — тест tests/osp-api/shared-sync.test.mjs: разбор на сайте и в службе не разойдётся молча.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SHARED_FILES = ['vorMaterialsSheet.js', 'vorMaterials.js', 'supplyAutoImport.js', 'supplyRateHelpers.js', 'vorFiles.js']
export const SRC_DIR = path.join(ROOT, 'src', 'utils')
export const DEST_DIR = path.join(ROOT, 'server', 'osp-api', 'src', 'shared')

export const header = (name) => `// КОПИЯ src/utils/${name} — не править здесь: правка в оригинале, затем node scripts/sync-osp-api-shared.mjs\n`
export const expected = (name) => header(name) + fs.readFileSync(path.join(SRC_DIR, name), 'utf8')

// Копии, которые отличаются от оригинала (или которых нет).
export function staleCopies() {
  return SHARED_FILES.filter((name) => {
    const dest = path.join(DEST_DIR, name)
    return !fs.existsSync(dest) || fs.readFileSync(dest, 'utf8') !== expected(name)
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stale = staleCopies()
  if (process.argv.includes('--check')) {
    if (stale.length) {
      console.error(`Копии в server/osp-api/src/shared отстали: ${stale.join(', ')}. Запустите node scripts/sync-osp-api-shared.mjs`)
      process.exit(1)
    }
    console.log('Копии общего кода osp-api совпадают с src/utils.')
  } else {
    fs.mkdirSync(DEST_DIR, { recursive: true })
    for (const name of stale) fs.writeFileSync(path.join(DEST_DIR, name), expected(name))
    console.log(stale.length ? `Обновлено: ${stale.join(', ')}` : 'Копии уже совпадают.')
  }
}
