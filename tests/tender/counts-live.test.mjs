// Онлайн-обновление счётчиков участников в реестре тендеров (src/utils/tenderCountsLive.js):
// какие события вообще меняют счётчики и как серия событий сводится к одному запросу.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { participantChangeAffectsCounts, createIdBatcher } from '../../src/utils/tenderCountsLive.js'

describe('Реестр тендеров: счётчики участников онлайн', () => {
  it('счётчики меняет только статус участника (или перенос к другому тендеру)', () => {
    const row = { id: 'p1', tender_id: 't1', status: 'request_sent', notes: 'а', sort_order: 1, proposal_link: null }
    assert.equal(participantChangeAffectsCounts({ ...row, notes: 'б' }, row), false, 'примечание')
    assert.equal(participantChangeAffectsCounts({ ...row, sort_order: 5 }, row), false, 'порядок')
    assert.equal(participantChangeAffectsCounts({ ...row, proposal_link: 'https://example.ru/kp' }, row), false, 'ссылка на КП')
    assert.equal(participantChangeAffectsCounts({ ...row, status: 'proposal_provided' }, row), true, 'статус')
    assert.equal(participantChangeAffectsCounts({ ...row, tender_id: 't2' }, row), true, 'другой тендер')
  })

  it('прежней строки в событии нет или в ней только ключ — считаем, что счётчики изменились', () => {
    const row = { id: 'p1', tender_id: 't1', status: 'request_sent' }
    assert.equal(participantChangeAffectsCounts(row, null), true)
    assert.equal(participantChangeAffectsCounts(row, undefined), true)
    assert.equal(participantChangeAffectsCounts(row, { id: 'p1' }), true)
    assert.equal(participantChangeAffectsCounts(row, { id: 'p1', status: 'request_sent' }), true, 'нет тендера в прежней строке')
    assert.equal(participantChangeAffectsCounts(null, row), false, 'нет новой строки — нечего пересчитывать')
  })

  it('серия событий — один запрос: id копятся, повторы схлопываются', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const flushed = []
    const batcher = createIdBatcher((ids) => flushed.push(ids), 1500)
    for (const id of ['t1', 't2', 't1', 't3', 't2', 't1']) batcher.add(id)
    batcher.add(null)
    batcher.add('')
    t.mock.timers.tick(1499)
    assert.deepEqual(flushed, [], 'до срока запросов нет')
    t.mock.timers.tick(1)
    assert.deepEqual(flushed, [['t1', 't2', 't3']])
    // Следующая серия — следующий запрос; пустая серия запроса не даёт.
    t.mock.timers.tick(5000)
    assert.equal(flushed.length, 1)
    batcher.add('t4')
    t.mock.timers.tick(1500)
    assert.deepEqual(flushed[1], ['t4'])
  })

  it('поток событий не откладывает запрос бесконечно и не учащает его', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const flushed = []
    const batcher = createIdBatcher((ids) => flushed.push(ids), 1500)
    // Событие каждые 100 мс в течение 6 секунд — как при перетаскивании или массовой правке.
    for (let ms = 0; ms < 6000; ms += 100) {
      batcher.add(`t${ms % 300}`)
      t.mock.timers.tick(100)
    }
    assert.equal(flushed.length, 4, 'раз в полторы секунды, а не 60 раз и не ноль')
    assert.ok(flushed.every((ids) => ids.length <= 3))
  })

  it('уход со страницы отменяет ожидание', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const flushed = []
    const batcher = createIdBatcher((ids) => flushed.push(ids), 1500)
    batcher.add('t1')
    batcher.cancel()
    t.mock.timers.tick(10000)
    assert.deepEqual(flushed, [])
  })
})
