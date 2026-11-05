// Фильтр «Контрагент» реестра «Договоры и ДС»: правила, без браузера. На странице — tests/tender/contracts-counterparty-filter.test.mjs.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { contractParties, counterpartyFilterOptions, hasCounterparty, matchCounterpartyOption } from '../../src/utils/contractCounterpartyFilter.js'

const cp = (id, name, inn = '') => ({ id, name, inn })
const doc = (id, ...parties) => ({ id, contract_counterparties: parties.map((p, i) => ({ sort_order: i, counterparties: p })) })
const romashka = cp('r', 'ООО «Ромашка»', '111')
const atom = cp('a', 'ООО Пром Атом Строй (ПАС)', '222')
const beta = cp('b', 'АО Бета', '333')

describe('Фильтр контрагента в «Договорах и ДС»', () => {
  it('сторона документа: любая из нескольких, старый договор без строк сторон — основной контрагент', () => {
    assert.equal(hasCounterparty(doc('d1', romashka, atom), new Set(['a'])), true, 'вторая сторона договора')
    assert.equal(hasCounterparty(doc('d1', romashka), new Set(['a'])), false)
    assert.equal(hasCounterparty({ id: 'old', counterparties: atom }, new Set(['a'])), true)
    assert.equal(hasCounterparty({ id: 'none' }, new Set(['a'])), false)
    assert.deepEqual(contractParties(doc('d1', romashka, atom)).map((p) => p.id), ['r', 'a'], 'порядок сторон')
  })

  it('варианты — без повторов и по алфавиту', () => {
    const options = counterpartyFilterOptions([doc('d1', romashka), doc('d2', romashka, beta)], [], [])
    assert.deepEqual(options.map((o) => o.label), ['АО Бета', 'ООО «Ромашка»'])
  })

  it('выбранный остаётся в списке и с названием, когда строк с ним нет: фильтр не действует невидимо', () => {
    const all = [doc('d1', romashka), doc('d2', atom)]
    const options = counterpartyFilterOptions([doc('d1', romashka)], ['a'], all)
    assert.deepEqual(options.map((o) => o.value).sort(), ['a', 'r'])
    assert.equal(options.find((o) => o.value === 'a').label, atom.name)
    // Прочие контрагенты allDocs в список не попадают: он сужен остальными фильтрами.
    assert.deepEqual(counterpartyFilterOptions([], ['r'], all).map((o) => o.value), ['r'])
  })

  it('одинаковые названия различает ИНН', () => {
    const options = counterpartyFilterOptions([doc('d1', cp('x', 'ООО Альфа', '1')), doc('d2', cp('y', 'ООО Альфа', '2'))], [], [])
    assert.deepEqual(options.map((o) => o.label), ['ООО Альфа · ИНН 1', 'ООО Альфа · ИНН 2'])
  })

  it('поиск — как в реестре контрагентов: написание неважно, слова в любом порядке, ИНН', () => {
    const [option] = counterpartyFilterOptions([doc('d1', atom)], [], [])
    for (const query of ['проматомстрой', 'пром-атом', 'атом пром', 'ПАС', 'OOO пром', '222']) {
      assert.equal(matchCounterpartyOption(option, query), true, query)
    }
    for (const query of ['ромашка', 'атом ромашка', '333']) {
      assert.equal(matchCounterpartyOption(option, query), false, query)
    }
  })
})
