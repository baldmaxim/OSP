// Параллельная постраничная загрузка (src/utils/fetchPagesParallel.js).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fetchAllRowsParallel } from '../../src/utils/fetchPagesParallel.js'

function fakeTable(total, { countAvailable = true, delay = 5, growAfterCount = 0 } = {}) {
  let rows = Array.from({ length: total }, (_, i) => ({ id: i }))
  const calls = []
  let active = 0
  let maxActive = 0
  const makeQuery = async (from, to, withCount) => {
    calls.push({ from, to, withCount })
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise((r) => setTimeout(r, delay))
    const res = { data: rows.slice(from, to + 1), error: null, count: withCount && countAvailable ? rows.length : null }
    if (withCount && growAfterCount) rows = rows.concat(Array.from({ length: growAfterCount }, (_, i) => ({ id: total + i })))
    active--
    return res
  }
  return { makeQuery, calls, stats: () => ({ maxActive }) }
}

describe('fetchAllRowsParallel', () => {
  it('склеивает страницы по порядку и грузит их параллельно', async () => {
    const t = fakeTable(4321)
    const rows = await fetchAllRowsParallel(t.makeQuery, { page: 1000, concurrency: 4 })
    assert.equal(rows.length, 4321)
    assert.deepEqual(rows.map((r) => r.id), Array.from({ length: 4321 }, (_, i) => i))
    assert.ok(t.stats().maxActive > 1, 'страницы идут одновременно')
    assert.equal(t.calls.filter((c) => c.withCount).length, 1, 'count запрашивается один раз')
  })

  it('меньше одной страницы — один запрос', async () => {
    const t = fakeTable(10)
    assert.equal((await fetchAllRowsParallel(t.makeQuery)).length, 10)
    assert.equal(t.calls.length, 1)
  })

  it('ровно кратное странице число строк и пустая таблица', async () => {
    assert.equal((await fetchAllRowsParallel(fakeTable(2000).makeQuery, { page: 1000 })).length, 2000)
    assert.equal((await fetchAllRowsParallel(fakeTable(0).makeQuery)).length, 0)
  })

  it('без count дочитывает последовательно', async () => {
    const t = fakeTable(2500, { countAvailable: false })
    const rows = await fetchAllRowsParallel(t.makeQuery, { page: 1000 })
    assert.equal(rows.length, 2500)
  })

  it('строки, добавленные после подсчёта, не теряются', async () => {
    const t = fakeTable(3000, { growAfterCount: 1500 })
    const rows = await fetchAllRowsParallel(t.makeQuery, { page: 1000 })
    assert.equal(rows.length, 4500)
  })

  it('ошибка страницы пробрасывается', async () => {
    const makeQuery = async (from) => (from >= 1000 ? { data: null, error: new Error('сбой') } : { data: Array(1000).fill({}), count: 3000, error: null })
    await assert.rejects(fetchAllRowsParallel(makeQuery), /сбой/)
  })
})
