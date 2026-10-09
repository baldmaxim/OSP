// Места загрузки файлов в интерфейсе против таблицы tests/osp-api/lib/upload-sites.mjs (рецензия 2).
// Сканер исходников: каждый вызов uploadFile( и каждый <S3DocumentList> есть в таблице, с тем же типом
// владельца. Новое место загрузки без записи роняет тест: его владельца и право надо добавить и на
// сервер (OWNER_TABLES, WRITE_RULES). Загрузка по каждой паре «тип → таблица» — в server.test.mjs.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GENERIC_UPLOADERS, LIST_SITES, UPLOAD_PAIRS, UPLOAD_SITES } from './lib/upload-sites.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = path.join(ROOT, 'server', 'osp-api')
const noDeps = fs.existsSync(path.join(SERVER, 'node_modules', '@aws-sdk', 'client-s3')) ? false : 'нет зависимостей: npm ci --prefix server/osp-api'

function sources(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (/\.(js|jsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')
// Без строк-комментариев: примеры использования в шапке файла — не места загрузки.
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^\s*\/\/.*$/gm, '')

describe('места загрузки файлов в интерфейсе (рецензия 2)', () => {
  const files = sources(path.join(ROOT, 'src')).map(rel).filter((f) => f !== 'src/services/s3.js') // там определение

  it('каждый вызов uploadFile( — в таблице, тип владельца тот же', () => {
    const found = {}
    for (const f of files) {
      const text = read(f)
      const types = []
      for (const m of text.matchAll(/\buploadFile\(\s*\{/g)) {
        const call = text.slice(m.index, m.index + 400)
        types.push(call.match(/ownerType:\s*'([a-z_]+)'/)?.[1] ?? '(props)')
      }
      if (types.length) found[f] = types
    }
    const expected = Object.fromEntries([
      ...UPLOAD_SITES.map((s) => [s.file, Array(s.calls).fill(s.owner)]),
      ...GENERIC_UPLOADERS.map((f) => [f, ['(props)']]),
    ])
    assert.deepEqual(found, expected)
  })

  it('каждый <S3DocumentList> — в таблице, тип владельца тот же', () => {
    const requestOwnerType = read('src/services/vorRequests.js').match(/export const REQUEST_OWNER_TYPE = '([a-z_]+)'/)?.[1]
    assert.equal(requestOwnerType, 'general')
    const constants = { REQUEST_OWNER_TYPE: requestOwnerType }
    const found = {}
    for (const f of files) {
      const types = []
      for (const m of read(f).matchAll(/<S3DocumentList\b([\s\S]*?)\/>/g)) {
        const attr = m[1].match(/ownerType=(?:"([a-z_]+)"|\{([A-Za-z_]+)\})/)
        types.push(attr?.[1] ?? constants[attr?.[2]] ?? `(не определён: ${attr?.[2] ?? 'нет ownerType'})`)
      }
      if (types.length) found[f] = types
    }
    assert.deepEqual(found, Object.fromEntries(LIST_SITES.map((s) => [s.file, Array(s.count).fill(s.owner)])))
  })

  it('сервер знает каждую пару: каталог, таблицу владельца и правило права', { skip: noDeps }, async () => {
    const { FOLDER_BY_OWNER, OWNER_TABLES, WRITE_RULES } = await import(path.join(SERVER, 'src', 'routes', 's3Presign.js'))
    assert.ok(UPLOAD_PAIRS.length >= 10)
    for (const { owner, table } of UPLOAD_PAIRS) {
      assert.ok(FOLDER_BY_OWNER[owner], `каталог для ${owner}`)
      assert.ok(OWNER_TABLES[owner]?.includes(table), `${owner} ищется в ${table}`)
      assert.ok(Array.isArray(WRITE_RULES[table]), `правило для ${table}`)
    }
  })
})
