// Отметка «Загружено в Estimat» у договора и ДС: правила состояний (src/utils/contractEstimat.js). Плашка в реестре —
// tests/tender/contracts-estimat.test.mjs, база — tests/tender/contracts-estimat-db.test.mjs.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ESTIMAT_NONE, ESTIMAT_SKIP, ESTIMAT_UPLOADED, estimatEvent, estimatPatch, estimatState, estimatSupported,
  estimatTitle, nextEstimatState,
} from '../../src/utils/contractEstimat.js'

const AT = '2026-11-03T09:00:00Z'

describe('Отметка Estimat', () => {
  it('три состояния по кругу, как «ТГ»: не загружено → загружено → не загружать → не загружено', () => {
    assert.equal(nextEstimatState(ESTIMAT_NONE), ESTIMAT_UPLOADED)
    assert.equal(nextEstimatState(ESTIMAT_UPLOADED), ESTIMAT_SKIP)
    assert.equal(nextEstimatState(ESTIMAT_SKIP), ESTIMAT_NONE)
  })

  it('состояние строки: неизвестное значение считается «не загружено»', () => {
    assert.equal(estimatState({ estimat_status: 'uploaded' }), ESTIMAT_UPLOADED)
    assert.equal(estimatState({ estimat_status: 'skip' }), ESTIMAT_SKIP)
    assert.equal(estimatState({ estimat_status: 'none' }), ESTIMAT_NONE)
    assert.equal(estimatState({ estimat_status: 'другое' }), ESTIMAT_NONE)
    assert.equal(estimatState({}), ESTIMAT_NONE)
    assert.equal(estimatState(null), ESTIMAT_NONE)
  })

  it('колонки в строке нет (миграция не применена) — плашки нет', () => {
    assert.equal(estimatSupported({ id: 'd1' }), false)
    assert.equal(estimatSupported(null), false)
    assert.equal(estimatSupported({ id: 'd1', estimat_status: 'none' }), true)
  })

  it('запись: кто и когда — только у выставленного состояния', () => {
    assert.deepEqual(estimatPatch(ESTIMAT_UPLOADED, 'Иванов', AT),
      { estimat_status: 'uploaded', estimat_status_at: AT, estimat_status_by: 'Иванов' })
    assert.deepEqual(estimatPatch(ESTIMAT_SKIP, 'Иванов', AT),
      { estimat_status: 'skip', estimat_status_at: AT, estimat_status_by: 'Иванов' })
    assert.deepEqual(estimatPatch(ESTIMAT_NONE, 'Иванов', AT),
      { estimat_status: 'none', estimat_status_at: null, estimat_status_by: null })
  })

  it('подсказка называет состояние, кого и когда; пустых разделителей нет', () => {
    const title = estimatTitle({ estimat_status: 'uploaded', estimat_status_by: 'Иванов', estimat_status_at: '2026-11-03T12:00:00Z' })
    assert.equal(title, 'Загружено в Estimat · Иванов · 03.11.2026')
    assert.equal(estimatTitle({ estimat_status: 'skip' }), 'Не загружать в Estimat')
    assert.equal(estimatTitle({ estimat_status: 'none' }, true), 'Отметить загрузку документа в Estimat')
    assert.equal(estimatTitle({ estimat_status: 'none' }, false), 'Не загружено в Estimat')
  })

  it('журнал документа — подписями, а не кодами', () => {
    assert.deepEqual(estimatEvent(ESTIMAT_NONE, ESTIMAT_UPLOADED), {
      fieldName: 'estimat_status',
      oldValue: 'Не загружено в Estimat',
      newValue: 'Загружено в Estimat',
      description: 'Отметка Estimat: Загружено в Estimat',
    })
  })
})
