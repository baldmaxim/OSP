// Расценка подрядчика на сайте по ведомостям (просьба пользователя 24.11.2026, src/utils/bidSitePricing.js): позиции и суммы по
// каждой ведомости, «что изменилось в ВОР», новая версия без подтверждения отдела не расценивается, цены снабжения по ключу позиции,
// перенос цены убранной позиции. Без браузера и базы.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildBidView, vorChanges, vorTotals, heldBackFiles, supplyByPosition, carryTargets } from '../../src/utils/bidSitePricing.js'
import { bidItemKey, bidUnitKey } from '../../src/utils/bidPrice.js'

const pos = (kind, name, unit, volume) => {
  const itemKey = bidItemKey(name)
  const unitKey = bidUnitKey(unit)
  return { kind, key: `${kind}|${itemKey}|${unitKey}`, itemKey, unitKey, name, unit, volume }
}
const rate = (price, extra = {}) => ({ price, note: '', source: 'manual', ...extra })

describe('Расценка на сайте по ведомостям', () => {
  const k1 = { id: 'k1', title: 'ВОР корпус 1', positions: [pos('material', 'Бетон В25', 'м3', 100), pos('work', 'Бетонирование', 'м3', 100)] }
  const k2 = { id: 'k2', title: 'ВОР корпус 2', positions: [pos('material', 'Бетон В25', 'м3', 30), pos('material', 'Арматура А500', 'т', 2)] }

  it('одна позиция в двух ведомостях — одна цена, объём и сумма — по каждой; итог — сумма по ведомостям, неполный — отмечен', () => {
    const view = buildBidView([k1, k2])
    assert.equal(view.positions.length, 3)
    const concrete = view.byKey.get(pos('material', 'Бетон В25', 'м3').key)
    assert.equal(concrete.volume, 130)
    assert.deepEqual(concrete.vols, { k1: 100, k2: 30 })
    assert.deepEqual(concrete.files, ['k1', 'k2'])

    const rates = new Map([[concrete.key, rate(5000)], [pos('work', 'Бетонирование', 'м3').key, rate(1000)]])
    const t = vorTotals(view, rates)
    const [r1, r2] = t.rows
    assert.deepEqual([r1.material.total, r1.work.total, r1.total, r1.incomplete], [500000, 100000, 600000, false])
    assert.deepEqual([r2.material.total, r2.material.priced, r2.material.items, r2.incomplete], [150000, 1, 2, true], 'арматура без цены — корпус 2 неполный')
    assert.equal(t.total.total, 750000)
    assert.equal(t.total.incomplete, true)
    assert.deepEqual([t.total.material.items, t.total.material.priced], [2, 1], 'позиции тендера — уникальные')
  })

  it('что изменилось: новая, объём, ед. изм., убрана — по виду и наименованию', () => {
    const prior = [pos('material', 'Бетон В25', 'м3', 100), pos('material', 'Сетка', 'м2', 50), pos('work', 'Бетонирование', 'м3', 100), pos('work', 'Демонтаж', 'шт', 1)]
    const now = [pos('material', 'Бетон В25', 'м3', 120), pos('material', 'Сетка', 'шт', 10), pos('work', 'Бетонирование', 'м3', 100), pos('work', 'Гидроизоляция', 'м2', 40)]
    const c = vorChanges(now, prior)
    assert.deepEqual(c.counts, { added: 1, removed: 1, volume: 1, unit: 1 })
    assert.deepEqual(c.byKey.get(pos('material', 'Бетон В25', 'м3').key), { op: 'volume', oldVolume: 100 })
    assert.deepEqual(c.byKey.get(pos('material', 'Сетка', 'шт').key), { op: 'unit', oldUnit: 'м2', oldVolume: 50 })
    assert.equal(c.byKey.get(pos('work', 'Гидроизоляция', 'м2').key).op, 'added')
    assert.equal(c.byKey.has(pos('work', 'Бетонирование', 'м3').key), false, 'без изменений — без отметки')
    assert.deepEqual(c.removed.map((p) => p.name), ['Демонтаж'])
    assert.deepEqual(vorChanges(now, now).counts, { added: 0, removed: 0, volume: 0, unit: 0 })
  })

  it('новая версия без подтверждения отдела не расценивается: то же имя без отметки редакции, у прежней — цены снабжения', () => {
    const files = [
      { id: 'old', title: 'ВОР ОВ', created_at: '2026-11-01T00:00:00Z' },
      { id: 'new', title: 'ВОР ОВ изм.1', created_at: '2026-11-20T00:00:00Z' },
      { id: 'vk', title: 'ВОР ВК', created_at: '2026-11-21T00:00:00Z' },
    ]
    const meta = (m) => new Map(Object.entries(m))
    const base = { old: { tracked: true, valuable: true }, new: { tracked: true }, vk: { tracked: true } }
    assert.deepEqual([...heldBackFiles(files, meta(base))], [['new', 'ВОР ОВ']])
    assert.equal(heldBackFiles(files, meta({ ...base, new: { tracked: true, separate: true } })).size, 0, 'отдел ответил «отдельный ВОР»')
    assert.equal(heldBackFiles(files, meta({ ...base, old: { tracked: true, valuable: false } })).size, 0, 'у прежней нет цен — снабжение не спросят, ждать нечего')
    assert.equal(heldBackFiles(files, meta({ ...base, new: { tracked: false } })).size, 0, 'снабжение файла ещё не видело')
    assert.equal(heldBackFiles(files, new Map()).size, 0, 'нет функции — как раньше')

    const view = buildBidView([
      { id: 'old', title: 'ВОР ОВ', positions: [pos('work', 'Монтаж', 'м', 10)] },
      { id: 'new', title: 'ВОР ОВ изм.1', positions: [pos('work', 'Монтаж', 'м', 12), pos('work', 'Новая', 'шт', 1)] },
    ], new Set(['new']))
    assert.equal(view.positions.length, 1, 'позиции новой версии не входят')
    assert.equal(view.positions[0].volume, 10, 'объём не удваивается')
    assert.deepEqual(view.vors.map((v) => [v.id, v.held, v.items.work]), [['old', false, 1], ['new', true, 2]])
  })

  it('цены снабжения — по ключу позиции; перенос цены убранной позиции — на самую похожую без цены', () => {
    const view = buildBidView([k1, k2])
    const prices = new Map([[`${bidItemKey('Бетон В25')}|${bidUnitKey('м3')}`, 4800], [`${bidItemKey('Кран')}|${bidUnitKey('шт')}`, 1]])
    const sp = supplyByPosition(view.materials, prices)
    assert.deepEqual([...sp.values()], [4800])

    const orphan = pos('material', 'Арматура А500С d12', 'т', 2)
    const targets = carryTargets([[orphan.key, { price: 90000, name: orphan.name, kind: 'material' }]], view.positions, new Map())
    assert.equal(targets.get(orphan.key)?.name, 'Арматура А500')
    const none = carryTargets([['work|x|шт', { price: 1, name: 'Совсем другое', kind: 'work' }]], view.positions, new Map())
    assert.equal(none.size, 0)
  })
})
