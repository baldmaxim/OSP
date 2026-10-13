// «Соседи по кластеру не пострадали» (migration/target/neighbors.sh, lib/neighbors.mjs): сравнение
// снимков кластера до и после работ. Здесь — правила сравнения; сам снимок снимается только чтением.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSnapshot, compareSnapshots } from '../../migration/target/lib/neighbors.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MB = 1024 * 1024
const snap = (dbs, { roles = ['7', 'rolehash'], conn = ['30', '6', '1'] } = {}) => parseSnapshot([
  ...dbs.map(([oid, size, ours = 0, owner = 'own', name = `n${oid}`]) => ['db', name, oid, owner, size ?? '', ours].join('\t')),
  ['roles', ...roles, '', '', ''].join('\t'), ['conn', ...conn, '', ''].join('\t'),
].join('\n'))
const BASE = [[100, 500 * MB], [101, 2000 * MB], [102, 40 * MB], [200, 190 * MB, 1]]

describe('Соседи по кластеру: сравнение снимков', () => {
  it('ничего не изменилось — замечаний нет; имён в выводе нет', () => {
    const r = compareSnapshots(snap(BASE), snap(BASE))
    assert.deepEqual([r.failed, r.warned], [false, false])
    assert.match(r.lines[0], /соседних баз в снимке: 3; пропавших — 0/)
    assert.ok(!r.lines.join('\n').includes('n100'))
  })

  it('соседняя база пропала, сменила владельца или переименована — FAIL', () => {
    assert.equal(compareSnapshots(snap(BASE), snap(BASE.filter(([oid]) => oid !== 101))).failed, true)
    assert.equal(compareSnapshots(snap(BASE), snap(BASE.map((d) => (d[0] === 100 ? [100, d[1], 0, 'other'] : d)))).failed, true)
    assert.equal(compareSnapshots(snap(BASE), snap(BASE.map((d) => (d[0] === 100 ? [100, d[1], 0, 'own', 'renamed'] : d)))).failed, true)
  })

  it('соседняя база заметно уменьшилась — ВНИМАНИЕ; обычные колебания и рост — нет', () => {
    const shrunk = compareSnapshots(snap(BASE), snap(BASE.map((d) => (d[0] === 101 ? [101, 1000 * MB] : d))))
    assert.deepEqual([shrunk.failed, shrunk.warned], [false, true])
    for (const size of [1990 * MB, 1850 * MB, 2600 * MB]) {
      assert.equal(compareSnapshots(snap(BASE), snap(BASE.map((d) => (d[0] === 101 ? [101, size] : d)))).warned, false, String(size))
    }
    // Маленькая база уменьшилась на треть, но это мегабайты — не сигнал.
    assert.equal(compareSnapshots(snap(BASE), snap(BASE.map((d) => (d[0] === 102 ? [102, 27 * MB] : d)))).warned, false)
    // Размер чужой базы прочитать нельзя — сравнивать нечего, это не ошибка.
    assert.equal(compareSnapshots(snap(BASE.map((d) => (d[0] === 100 ? [100, null] : d))), snap(BASE)).warned, false)
  })

  it('база портала может расти и пустеть (загрузка, очистка репетиции) — это наша работа', () => {
    assert.deepEqual(compareSnapshots(snap(BASE), snap(BASE.map((d) => (d[0] === 200 ? [200, 8 * MB, 1] : d)))).warned, false)
    assert.equal(compareSnapshots(snap(BASE), snap(BASE.filter(([oid]) => oid !== 200))).failed, true, 'но исчезнуть она не должна')
  })

  it('учётки кластера и запас подключений общей учётки', () => {
    assert.equal(compareSnapshots(snap(BASE), snap(BASE, { roles: ['8', 'otherhash'] })).warned, true)
    assert.equal(compareSnapshots(snap(BASE), snap(BASE, { conn: ['30', '22', '12'] })).warned, true, 'занято больше 70 % лимита')
    assert.equal(compareSnapshots(snap(BASE), snap(BASE, { conn: ['30', '18', '12'] })).warned, false)
    assert.match(compareSnapshots(snap(BASE), snap(BASE, { conn: ['-1', '18', '12'] })).lines.at(-1), /лимит не задан/)
    assert.match(compareSnapshots(snap(BASE), snap([...BASE, [300, 5 * MB]])).lines.join('\n'), /новых баз в кластере — 1/)
  })

  it('снимок снимается только чтением и в чужие базы не ходит', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'migration', 'target', 'sql', 'neighbors.sql'), 'utf8')
    const body = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    assert.match(body, /BEGIN TRANSACTION READ ONLY;/)
    assert.match(body, /ROLLBACK;\s*$/)
    assert.ok(!/\b(insert|update|delete|create|alter|drop|truncate|grant|revoke|\\c|\\connect|dblink)\b/i.test(body.replace(/pg_read_all_stats/g, '')), 'в снимке есть что-то кроме чтения')
    assert.throws(() => parseSnapshot('db\tx\t1\ty\t5\t1'), /неполный/)
  })
})
