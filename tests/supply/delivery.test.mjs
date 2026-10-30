// Доставка позиции в расценке снабжением (src/utils/supplyDelivery.js): тот же расчёт, что у триггера базы
// tender_vor_supply_rates_compute (миграция 20261120, tests/supply/delivery-db.test.mjs — те же числа), и разложение
// сохранённой цены обратно на цену материала и доставку.
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { baseTotalFromFull, composePrice, rateBasePrice, rateDelivery, ratePriceInput, sameDelivery } from '../../src/utils/supplyDelivery.js'

const near = (a, b) => Math.abs(a - b) < 1e-9

it('без доставки — как раньше: за единицу и суммой', () => {
  assert.deepEqual(composePrice({ mode: 'unit', value: 1163.12, volume: 59 }), { base: 1163.12, full: 1163.12, total: 68624.08, deliveryUnit: null, deliveryTotal: null })
  const t = composePrice({ mode: 'total', value: 76846.32, volume: 118 })
  assert.ok(near(t.base, 651.24) && near(t.full, 651.24))
  assert.equal(t.total, 76846.32)
  assert.deepEqual(composePrice({ mode: 'unit', value: 35 }), { base: 35, full: 35, total: null, deliveryUnit: null, deliveryTotal: null })
})

it('доставка за единицу — до копейки, к цене за единицу; итог — цена с доставкой × объём', () => {
  const c = composePrice({ mode: 'unit', value: 3733.79, volume: 229.586, delivery: { mode: 'unit', value: 120.456 } })
  assert.deepEqual([c.base, c.full, c.total, c.deliveryUnit], [3733.79, 3854.25, 884881.84, 120.46])
  assert.equal(composePrice({ mode: 'unit', value: 35, delivery: { mode: 'unit', value: 5 } }).full, 40, 'без объёма — за единицу')
})

it('доставка суммой — на объём: итог = цена × объём + доставка, цена — итог ÷ объём; без объёма — не посчитать', () => {
  const c = composePrice({ mode: 'unit', value: 1163.12, volume: 59, delivery: { mode: 'total', value: 1000 } })
  assert.equal(c.total, 69624.08)
  assert.ok(near(c.full, 69624.08 / 59))
  assert.equal(Math.round(c.full * 100) / 100, 1180.07)
  const t = composePrice({ mode: 'total', value: 76846.32, volume: 118, delivery: { mode: 'unit', value: 10 } })
  assert.deepEqual([t.total, t.deliveryTotal], [78026.32, 1180])
  assert.ok(near(t.full, 661.24))
  assert.deepEqual(composePrice({ mode: 'unit', value: 35, delivery: { mode: 'total', value: 100 } }), { base: 35, full: null, total: null, deliveryUnit: null, deliveryTotal: 100 })
})

it('сохранённая цена с доставкой → цена материала, как её ввели, и доставка; без доставки — вся цена', () => {
  const unit = { price_input: 'unit', input_value: 96, volume_at_input: 1100, supply_price: 97, supply_price_exact: 106700 / 1100, supply_total: 106700, delivery_input: 'total', delivery_value: 1100 }
  assert.equal(rateBasePrice(unit), 96)
  assert.deepEqual(rateDelivery(unit), { mode: 'total', value: 1100 })
  assert.deepEqual(ratePriceInput(unit), { mode: 'unit', value: 96 })
  const total = { price_input: 'total', input_value: 108900, volume_at_input: 1100, supply_price: 100, supply_price_exact: 100, supply_total: 110000, delivery_input: 'total', delivery_value: 1100 }
  assert.equal(rateBasePrice(total), 99)
  assert.deepEqual(ratePriceInput(total), { mode: 'total', value: 108900 })
  const excel = { price_input: 'import', input_value: 5.76, supply_price: 5.76, supply_price_exact: null, delivery_input: null, delivery_value: null }
  assert.equal(rateBasePrice(excel), 5.76)
  assert.equal(rateDelivery(excel), null)
  assert.deepEqual(ratePriceInput(excel), { mode: 'unit', value: 5.76 }, 'цена из Excel — за единицу')
  assert.equal(rateBasePrice({ price_input: 'total', input_value: 709517.84, volume_at_input: 2489.711, supply_price: 284.98, supply_price_exact: 709517.84 / 2489.711 }), 709517.84 / 2489.711)
})

it('итог с доставкой → сумма материала; итог не больше доставки — нельзя; одинаковая доставка', () => {
  assert.equal(baseTotalFromFull(110000, { mode: 'total', value: 1100 }, 1100), 108900)
  assert.equal(baseTotalFromFull(110000, { mode: 'unit', value: 4 }, 1100), 105600)
  assert.equal(baseTotalFromFull(1000, { mode: 'total', value: 1000 }, 10), null)
  assert.equal(baseTotalFromFull(5000, null, 10), 5000)
  assert.ok(sameDelivery(null, null) && sameDelivery({ mode: 'unit', value: 4 }, { mode: 'unit', value: 4.001 }))
  assert.ok(!sameDelivery({ mode: 'unit', value: 4 }, { mode: 'total', value: 4 }) && !sameDelivery(null, { mode: 'unit', value: 1 }))
})
