// Доставка позиции в расценке снабжением (миграция 20261120, решение пользователя 30.10.2026): необязательная, за
// единицу (mode 'unit') или суммой на объём позиции ('total'). В базе цена позиции (supply_price, supply_total) уже
// с доставкой — считает триггер; здесь тот же расчёт для показа черновика и разложение обратно: цена материала, как
// её ввели, и доставка. Модуль чистый — tests/supply/delivery.test.mjs.
import { roundMoney } from './money.js'
import { rateUnitPrice } from './supplyRateHelpers.js'

// Доставка строки расценки, как её ввели, — или null.
export const rateDelivery = (r) => (r?.delivery_input && Number(r.delivery_value) > 0
  ? { mode: r.delivery_input === 'total' ? 'total' : 'unit', value: Number(r.delivery_value) } : null)

export const sameDelivery = (a, b) => (!a && !b) || (!!a && !!b && a.mode === b.mode && roundMoney(a.value) === roundMoney(b.value))

// Цена материала за единицу без доставки, как её ввели: за единицу — она сама, суммой — сумма ÷ объём при вводе;
// цена из Excel — вся цена позиции.
export function rateBasePrice(r) {
  if (!r) return null
  if (!rateDelivery(r)) return rateUnitPrice(r)
  if (r.price_input === 'unit') return roundMoney(Number(r.input_value))
  if (r.price_input === 'total' && Number(r.volume_at_input) > 0) return roundMoney(Number(r.input_value)) / Number(r.volume_at_input)
  return rateUnitPrice(r)
}

// Цена материала (mode 'unit' — за единицу, 'total' — суммой) и доставка при объёме volume → { base, full, total,
// deliveryUnit, deliveryTotal }: base — цена без доставки за единицу, full — с доставкой (как запишет база), total —
// итог с доставкой. Как триггер tender_vor_supply_rates_compute: за единицу — до копейки, сумма — до копейки суммы.
// Нет объёма — суммы нет (и суммой ни цену, ни доставку не посчитать).
export function composePrice({ mode, value, delivery = null, volume = null }) {
  const vol = volume > 0 ? volume : null
  const d = delivery && delivery.value > 0 ? delivery : null
  const dUnit = d ? (d.mode === 'total' ? (vol ? roundMoney(d.value) / vol : null) : roundMoney(d.value)) : 0
  const dTotal = d ? (d.mode === 'total' ? roundMoney(d.value) : vol ? roundMoney(roundMoney(d.value) * vol) : null) : 0
  const parts = { deliveryUnit: d ? dUnit : null, deliveryTotal: d ? dTotal : null }
  if (mode === 'total') {
    if (!vol || dTotal == null) return { base: null, full: null, total: null, ...parts }
    const baseTotal = roundMoney(value)
    const total = roundMoney(baseTotal + dTotal)
    return { base: baseTotal / vol, full: total / vol, total, ...parts }
  }
  const base = roundMoney(value)
  if (d?.mode === 'total') {
    if (!vol) return { base, full: null, total: null, ...parts }
    const total = roundMoney(roundMoney(base * vol) + dTotal)
    return { base, full: total / vol, total, ...parts }
  }
  const full = roundMoney(base + dUnit)
  return { base, full, total: vol ? roundMoney(full * vol) : null, ...parts }
}

// Как записать цену строки вместе с новой доставкой: цена — как её ввели (из Excel — за единицу, вся цена позиции).
export function ratePriceInput(r) {
  if (r?.price_input === 'unit' || r?.price_input === 'total') return { mode: r.price_input, value: Number(r.input_value) }
  return { mode: 'unit', value: roundMoney(rateUnitPrice(r)) }
}

// Ввели итог позиции (с доставкой) — цена материала суммой: итог минус доставка на позицию. Не больше доставки —
// null (итог не может быть меньше доставки).
export function baseTotalFromFull(total, delivery, volume) {
  const { deliveryTotal } = composePrice({ mode: 'unit', value: 0, delivery, volume })
  if (!delivery) return total
  if (deliveryTotal == null) return null
  const base = roundMoney(total - deliveryTotal)
  return base > 0 ? base : null
}
