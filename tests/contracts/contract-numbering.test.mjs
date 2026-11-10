// Нумерация договоров по объектам: правила номера КОД-ДП-ГГ-NNN (src/utils/contractNumbering.js). Совпадение ключей с базой —
// tests/tender/contract-numbering-db.test.mjs, форма и окно «Нумерация договоров» — tests/tender/contract-numbering.test.mjs.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  codeKey, codeProblem, cleanCode, formatContractNumber, isSchemeNumberTaken, lastIssued, manualNumberWarnings, moscowYear,
  nextContractNumber, numberKey, parseContractNumber,
} from '../../src/utils/contractNumbering.js'

const ALIA = { id: 'o1', name: 'ЖК Алия', contract_code: 'АЛИЯ' }
const COUNTERS = [
  { code_key: 'АЛИЯ', year: 2026, last_number: 4 },
  { code_key: 'АЛИЯ', year: 2025, last_number: 31 },
  { code_key: 'СБ2', year: 2026, last_number: 1 },
]

describe('Нумерация договоров: формат', () => {
  it('формат файла: КОД-ДП-ГГ-NNN, три цифры, больше — как есть', () => {
    assert.equal(formatContractNumber('АЛИЯ', 2026, 1), 'АЛИЯ-ДП-26-001')
    assert.equal(formatContractNumber('ЗИЛ18-19-27', 2027, 12), 'ЗИЛ18-19-27-ДП-27-012')
    assert.equal(formatContractNumber('СОБ6.1', 2026, 1000), 'СОБ6.1-ДП-26-1000')
    assert.equal(formatContractNumber('', 2026, 1), null)
    assert.equal(formatContractNumber('АЛИЯ', 2026, 0), null)
  })

  it('разбор: регистр, латиница-двойник, ведущие нули и пробелы по краям не важны; код с дефисами и точкой', () => {
    assert.deepEqual(parseContractNumber('АЛИЯ-ДП-26-001'), { codeKey: 'АЛИЯ', year: 2026, seq: 1 })
    assert.deepEqual(parseContractNumber(' алия-дп-26-1 '), { codeKey: 'АЛИЯ', year: 2026, seq: 1 })
    assert.deepEqual(parseContractNumber('CБ2-ДП-26-007'), { codeKey: 'СБ2', year: 2026, seq: 7 }) // C — латинская
    assert.deepEqual(parseContractNumber('ЗИЛ18-19-27-ДП-26-012'), { codeKey: 'ЗИЛ18-19-27', year: 2026, seq: 12 })
    assert.deepEqual(parseContractNumber('ДОМ56Рен-ДП-26-003'), { codeKey: 'ДОМ56РЕН', year: 2026, seq: 3 })
    assert.equal(numberKey('АЛИЯ-ДП-26-001'), numberKey('алия-дп-26-0001'))
    assert.notEqual(numberKey('ДОМ56-ДП-26-001'), numberKey('ДОМ56Рен-ДП-26-001'))
  })

  it('не по схеме: старый вид, ДС, номер 000, год четырьмя цифрами, пробелы и знак номера внутри', () => {
    for (const s of ['СУ10-ВЭЙВ-СП-Э1-25', '5', '', null, 'АЛИЯ-ДП-26-000', 'АЛИЯ-ДП-2026-001', 'АЛИЯ ДП 26 001',
      '№ АЛИЯ-ДП-26-001', 'АЛИЯ-DP-26-001', '-АЛИЯ-ДП-26-001', 'ДС № 1 к договору № АЛИЯ-ДП-26-001']) {
      assert.equal(parseContractNumber(s), null, String(s))
    }
  })

  it('код объекта: буквы, цифры, точка, дефис, до 20 знаков; пустой — «кода нет»', () => {
    assert.equal(codeProblem('ЗИЛ18-19-27'), null)
    assert.equal(codeProblem('СОБ6.1'), null)
    assert.equal(codeProblem(''), null)
    assert.equal(cleanCode('  '), null)
    assert.equal(cleanCode(' АЛИЯ '), 'АЛИЯ')
    assert.match(codeProblem('ЗИЛ 33'), /без пробелов/)
    assert.match(codeProblem('-АЛИЯ'), /начинается и заканчивается/)
    assert.match(codeProblem('А'.repeat(21)), /длиннее 20/)
    assert.equal(codeKey('сб2'), codeKey('CБ2'))
  })

  it('год регистрации — по Москве', () => {
    assert.equal(moscowYear(new Date('2026-12-31T20:59:00Z')), 2026)
    assert.equal(moscowYear(new Date('2026-12-31T21:00:00Z')), 2027)
  })
})

describe('Нумерация договоров: следующий номер и проверка ручного', () => {
  it('следующий — по счётчику кода и года; в новом году — с 001; без кода — нет номера', () => {
    assert.equal(lastIssued(COUNTERS, 'АЛИЯ', 2026), 4)
    assert.equal(nextContractNumber(ALIA, COUNTERS, 2026).number, 'АЛИЯ-ДП-26-005')
    assert.equal(nextContractNumber(ALIA, COUNTERS, 2027).number, 'АЛИЯ-ДП-27-001')
    assert.equal(nextContractNumber({ name: 'ЖК Инджой', contract_code: 'ИНДЖОЙ' }, COUNTERS, 2026).number, 'ИНДЖОЙ-ДП-26-001')
    // Код записан латиницей-двойником — счётчик тот же.
    assert.equal(nextContractNumber({ name: 'CITY BAY', contract_code: 'CБ2' }, COUNTERS, 2026).number, 'CБ2-ДП-26-002')
    assert.equal(nextContractNumber({ name: 'ГО', contract_code: null }, COUNTERS, 2026), null)
    assert.equal(nextContractNumber(null, COUNTERS, 2026), null)
  })

  it('ручной номер: свой вид — без вопросов; следующий — без вопросов; чужой код, пропуск и повтор — предупреждения', () => {
    const check = (number, extra = {}) => manualNumberWarnings({ number, object: ALIA, counters: COUNTERS, ...extra })
    assert.deepEqual(check('ДП-45/2026'), [])
    assert.deepEqual(check('АЛИЯ-ДП-26-005'), [])
    assert.match(check('СБ2-ДП-26-002').join(), /не совпадает с кодом объекта «ЖК Алия» — АЛИЯ/)
    const ahead = check('АЛИЯ-ДП-26-009').join()
    assert.match(ahead, /следующий по счётчику — 005/)
    assert.match(ahead, /005–008 останутся невыданными/)
    assert.match(ahead, /продолжится с 010/)
    assert.match(check('АЛИЯ-ДП-26-006').join(), /номер 005 останется невыданным/)
    assert.match(check('АЛИЯ-ДП-26-003').join(), /уже выдавался/)
    // Свой прежний номер при правке договора не переспрашиваем.
    assert.deepEqual(check('АЛИЯ-ДП-26-003', { ownNumber: 'алия-дп-26-3' }), [])
  })

  it('отказ «номер занят» отличается от прочих отказов уникальности договоров', () => {
    assert.ok(isSchemeNumberTaken({ code: '23505', message: 'duplicate key value violates unique constraint "contracts_scheme_number_uniq"' }))
    assert.ok(isSchemeNumberTaken({ code: '23505', message: 'duplicate key' }))
    assert.ok(!isSchemeNumberTaken({ code: '23505', message: 'duplicate key value violates unique constraint "uq_contracts_amendment_number"' }))
    assert.ok(!isSchemeNumberTaken({ code: '23505', message: 'duplicate key value violates unique constraint "contracts_display_id_key"' }))
    assert.ok(!isSchemeNumberTaken({ code: '23514', message: 'check' }))
  })
})
