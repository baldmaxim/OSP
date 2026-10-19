// Суммы «Заявки на ДС» (было подано / утверждено, с НДС 22%) бывают отрицательными — ДС на
// уменьшение стоимости. Ввод, показ и разница со знаком; цены снабжения минус по-прежнему не берут.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseAmount, formatAmount, formatAmountLive, amountChange } from '../../src/utils/money.js'

const MINUS = '−'
const NBSP = ' '

describe('parseAmount: минус первым символом', () => {
  it('дефис, «−» и «–» — одно и то же', () => {
    assert.equal(parseAmount('-1 000,50'), -1000.5)
    assert.equal(parseAmount(`${MINUS}1 000,50`), -1000.5)
    assert.equal(parseAmount('–1000'), -1000)
    assert.equal(parseAmount(`${MINUS}1${NBSP}000${NBSP}000,00 ₽`), -1000000)
  })

  it('положительные — как раньше', () => {
    assert.equal(parseAmount('1 000 000,25'), 1000000.25)
    assert.equal(parseAmount(1500), 1500)
    assert.equal(parseAmount(-1500), -1500)
  })

  it('один минус, пусто и -0 — не сумма или ноль', () => {
    assert.equal(parseAmount('-'), null)
    assert.equal(parseAmount(MINUS), null)
    assert.equal(parseAmount(''), null)
    assert.ok(Object.is(parseAmount('-0'), 0))
  })

  it('минус не первым символом знаком не считается', () => {
    assert.equal(parseAmount('1000-'), 1000)
  })
})

describe('formatAmount: знак минуса «−», а не дефис', () => {
  it('отрицательная сумма', () => {
    assert.equal(formatAmount(-1234.5), `${MINUS}1${NBSP}234,50`)
    assert.equal(formatAmount(1234.5), `1${NBSP}234,50`)
  })

  it('−0,00 не показывается', () => {
    assert.equal(formatAmount(-0), '0,00')
    assert.equal(formatAmount(-0.001), '0,00')
  })

  it('показанное читается обратно тем же числом', () => {
    for (const n of [-1000000.99, -0.01, 0, 0.01, 999999999999.99, -999999999999.99]) {
      assert.equal(parseAmount(formatAmount(n)), n)
    }
  })
})

describe('formatAmountLive', () => {
  const live = (s) => formatAmountLive(s, { allowNegative: true })

  it('с allowNegative — минус остаётся первым символом', () => {
    assert.equal(live('-1000000'), `${MINUS}1 000 000`)
    assert.equal(live('-1000.5'), `${MINUS}1 000,5`)
    assert.equal(live(`${MINUS}1 000,567`), `${MINUS}1 000,56`)
    assert.equal(live('-'), MINUS)
    assert.equal(live('-,5'), `${MINUS}0,5`)
    assert.equal(live(String(-1000.5)), `${MINUS}1 000,5`)
  })

  it('с allowNegative — минус в середине и в конце отбрасывается', () => {
    assert.equal(live('10-00'), '1 000')
    assert.equal(live('1000-'), '1 000')
  })

  it('по умолчанию (цены снабжения) минус отбрасывается', () => {
    assert.equal(formatAmountLive('-1000'), '1 000')
    assert.equal(formatAmountLive(`${MINUS}1000,5`), '1 000,5')
  })

  it('набранное разбирается в то же число', () => {
    assert.equal(parseAmount(live('-1234567,89')), -1234567.89)
  })
})

describe('amountChange: разница и процент «подано → утверждено»', () => {
  it('положительные суммы — как раньше', () => {
    assert.deepEqual(amountChange(1000, 800), { diff: 200, pct: -20 })
    assert.deepEqual(amountChange(1000, 1100), { diff: -100, pct: 10 })
    assert.deepEqual(amountChange(1000, 1000), { diff: 0, pct: 0 })
  })

  it('обе отрицательные: утвердили большее уменьшение — удешевление, процент со знаком «−»', () => {
    assert.deepEqual(amountChange(-1000000, -1200000), { diff: 200000, pct: -20 })
  })

  it('обе отрицательные: утвердили меньшее уменьшение — удорожание, процент со знаком «+»', () => {
    assert.deepEqual(amountChange(-1000000, -800000), { diff: -200000, pct: 20 })
  })

  it('знак сменился', () => {
    assert.deepEqual(amountChange(500, -100), { diff: 600, pct: -120 })
    assert.deepEqual(amountChange(-100, 500), { diff: -600, pct: 600 })
  })

  it('подано 0 — без процента; нет одной из сумм — ничего', () => {
    assert.deepEqual(amountChange(0, -500), { diff: 500, pct: null })
    assert.deepEqual(amountChange(null, -500), { diff: null, pct: null })
    assert.deepEqual(amountChange(-500, null), { diff: null, pct: null })
  })

  it('разница — до копеек, без хвостов плавающей точки и без -0', () => {
    assert.equal(amountChange(-0.3, -0.1).diff, -0.2)
    assert.equal(amountChange(0.1 + 0.2, 0.3).diff, 0)
    assert.ok(Object.is(amountChange(-5, -5).diff, 0))
  })
})
