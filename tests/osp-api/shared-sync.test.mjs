// Разбор файла ВОР и план автозагрузки позиций у страницы расценки (src/utils) и у службы osp-api
// (server/osp-api/src/shared, supplyImport) — один код: копии службы совпадают с оригиналами. Отстали — правка
// разбора дошла бы до сайта, но не до службы, и позиции у тендеров разошлись бы.
// Обновить копии: node scripts/sync-osp-api-shared.mjs
import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SHARED_FILES, DEST_DIR, staleCopies } from '../../scripts/sync-osp-api-shared.mjs'

it('копии общего кода в server/osp-api/src/shared совпадают с src/utils', () => {
  assert.deepEqual(staleCopies(), [], 'запустите node scripts/sync-osp-api-shared.mjs')
})

it('служба импортирует общий код только из своих копий (образ собирается из server/osp-api)', () => {
  const lib = path.join(DEST_DIR, '..', 'lib')
  for (const f of ['supplyImport.js', 'supplyParseChild.js']) {
    const text = fs.readFileSync(path.join(lib, f), 'utf8')
    assert.doesNotMatch(text, /from ['"](\.\.\/){3,}/, `${f}: импорт за пределы server/osp-api`)
    assert.match(text, /from '\.\.\/shared\//, f)
  }
  // У копий — только относительные импорты между собой и библиотека Excel из зависимостей службы.
  for (const name of SHARED_FILES) {
    for (const m of fs.readFileSync(path.join(DEST_DIR, name), 'utf8').matchAll(/^import .* from '([^']+)'/gm)) {
      assert.ok(m[1] === 'xlsx' || (m[1].startsWith('./') && SHARED_FILES.includes(m[1].slice(2))), `${name}: ${m[1]}`)
    }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(DEST_DIR, '..', '..', 'package.json'), 'utf8'))
  const root = JSON.parse(fs.readFileSync(path.join(DEST_DIR, '..', '..', '..', '..', 'node_modules', 'xlsx', 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies.xlsx, root.version, 'та же версия библиотеки Excel, что у сайта')
})
