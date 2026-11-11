// Подсказки «организация СУ-10 → контрагент» (server/osp-api/src/lib/orgMatch.js). Подсказка — не связь: связывает
// администратор. Проверяем, что «уверенный» кандидат бывает только при ИНН реестра СУ-10 с верной контрольной суммой и
// единственном живом контрагенте не из чёрного списка, а всё мягкое (подсказка BillHub, ведущий ноль, КПП в ячейке, название,
// домен, дубли) — только кандидат с причиной. И что выгрузка разбирается безопасно, а отчёт защищён от формул Excel.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCsv, parseOrgsCsv, unguard, csvCell, cleanInn, exactInn, softInn, nameKey, nameSortedKey, namesAgree, innsInName,
  buildIndex, candidatesFor, confidentCandidate, planReport, pickMain, searchCounterparties,
} from '../../server/osp-api/src/lib/orgMatch.js'

// ИНН с верной контрольной суммой (10 и 12 цифр) и с неверной.
const INN = '7707083893'
const INN2 = '9909123454'
const INN12 = '500100732259'
const BAD_INN = '7707083894'
const ORG = 'a0000000-0000-4000-8000-000000000001'
const ORG2 = 'a0000000-0000-4000-8000-000000000002'

const cp = (id, name, inn = null, extra = {}) => ({ id, number: Number(id.replace(/\D/g, '')) || 1, name, inn, status: 'active',
  contracts: 0, tenders: 0, relations: 0, domains: [], ...extra })
const org = (extra = {}) => ({ su10OrgId: ORG, kind: 'contractor', name: 'Ромашка ООО', inn: '', users: 1, emailDomains: [], innHints: [], ...extra })
const reasonsOf = (cands, id) => cands.find((c) => c.counterparty.id === id)?.reasons || []
const flagsOf = (cands, id) => cands.find((c) => c.counterparty.id === id)?.flags || []

describe('выгрузка auth: CSV', () => {
  it('BOM, кавычки, удвоенные кавычки, запятая и перевод строки внутри кавычек', () => {
    const rows = parseCsv('\uFEFFa,b,c\r\n1,"x, ""y""","z\nw"\n')
    assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, "y"', 'z\nw']])
  })
  it('апостроф защиты от формул снимается только для сравнения', () => {
    assert.equal(unguard("'=SUM(A1)"), '=SUM(A1)')
    assert.equal(unguard("'-12"), '-12')
    assert.equal(unguard("O'Neil"), "O'Neil")
  })
  it('разбор строк: подрядчики и свои, подсказки BillHub, домены; негодные строки — в замечания с номером', () => {
    const csv = [
      'su10_org_id,kind,name,inn,fot_org_ids,users,email_domains,inn_hint,inn_hint_names,inn_hint_source',
      `${ORG},contractor,3Д ООО,,x,1,3d.example:1,${INN2}:1,"ООО ""3Д""",billhub`,
      `${ORG2},own,(СУ-10) Своя организация,,x,10,own.example:5|own2.example:3,,,`,
      'не-uuid,contractor,X,,x,1,,,,',
      `${ORG},contractor,Повтор,,x,1,,,,`,
      '11111111-1111-4111-8111-111111111111,partner,Y,,x,1,,,,',
    ].join('\n')
    const { orgs, problems } = parseOrgsCsv(csv)
    assert.equal(orgs.length, 2)
    assert.deepEqual(orgs[0].innHints, [{ inn: INN2, name: 'ООО "3Д"' }])
    assert.deepEqual(orgs[1].emailDomains, ['own.example', 'own2.example'])
    assert.deepEqual(problems.map((p) => p.line), [4, 5, 6])
  })
  it('нет нужных колонок — отказ целиком', () => {
    const r = parseOrgsCsv('su10_org_id,kind\nx,y')
    assert.equal(r.orgs.length, 0)
    assert.match(r.problems[0].problem, /нет колонок/)
  })
  it('отчёт: значения с = + - @ \\t \\r в начале — с апострофом, кавычки по правилам CSV', () => {
    assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`)
    assert.equal(csvCell('+7 916'), "'+7 916")
    assert.equal(csvCell('-1'), "'-1")
    assert.equal(csvCell('@cmd'), "'@cmd")
    assert.equal(csvCell('\tx'), "'\tx")
    assert.equal(csvCell('ООО «Ромашка», филиал'), '"ООО «Ромашка», филиал"')
    assert.equal(csvCell('просто'), 'просто')
  })
})

describe('ИНН и название', () => {
  it('ИНН — только 10 или 12 цифр, апостроф снимается', () => {
    assert.equal(cleanInn(` ${INN} `), INN)
    assert.equal(cleanInn(`'=${INN}`), null)
    assert.equal(cleanInn('770708389'), null)
    assert.equal(cleanInn(`${INN}/770701001`), null)
  })
  it('точное совпадение — вся ячейка; мягкое — КПП через «/», два ИНН, потерянный ноль, пробелы', () => {
    assert.ok(exactInn(` ${INN} `, INN))
    assert.ok(!exactInn(`${INN}/770701001`, INN))
    assert.ok(softInn(`${INN}/770701001`, INN))
    assert.ok(softInn(`${INN2}, ${INN}`, INN))
    assert.ok(softInn('123456789', '0123456789'))
    assert.ok(softInn('7707 083 893', INN))
    assert.ok(!softInn('17707083893', INN))
  })
  it('форма организации, кавычки, ё и порядок слов не мешают', () => {
    assert.equal(nameKey('3Д ООО'), nameKey('ООО «3Д»'))
    assert.equal(nameKey('ООО "Зелёный"'), nameKey('зеленый'))
    assert.equal(nameSortedKey('СТРОЙМИР ООО ИК'), nameSortedKey('ООО ИК «Строймир»'))
    assert.equal(nameKey('НКО Фонд Добро'), nameKey('Фонд Добро'))
  })
  it('ИНН в названии — только с верной контрольной суммой, из сравнения названий он убран', () => {
    assert.deepEqual(innsInName(`ЭКС ООО (${INN})`), [INN])
    assert.deepEqual(innsInName(`ЭКС ООО (${BAD_INN})`), [])
    assert.equal(nameKey(`ЭКС ООО (${INN})`), nameKey('ЭКС'))
  })
  it('сходство названий для проверки подсказки BillHub', () => {
    assert.ok(namesAgree('Альфа ПСК ООО', 'ООО «ПСК АЛЬФА»'))
    assert.ok(namesAgree('ОМЕГА ГРУПП ООО', 'ООО "ОмегаГрупп"'))
    assert.ok(namesAgree('Петров Иван Сергеевич', 'ИП Петров И.С.'))
    assert.ok(!namesAgree('ПРОБНАЯ УЧЁТКА', 'ООО «РАДУГА»'))
  })
})

describe('кандидаты: уверенный — только строгий', () => {
  it('ИНН реестра с верной суммой и единственный живой контрагент → уверенный', () => {
    const list = [cp('c1', 'ООО Ромашка', INN), cp('c2', 'ООО Лютик', INN2)]
    const o = org({ inn: INN })
    const cands = candidatesFor(o, buildIndex(list))
    assert.deepEqual(reasonsOf(cands, 'c1').slice(0, 1), ['inn'])
    assert.equal(confidentCandidate(o, cands)?.counterparty.id, 'c1')
  })
  it('подсказка BillHub, даже при верной сумме и одном контрагенте, — не уверенный', () => {
    const list = [cp('c1', 'ООО Ромашка', INN)]
    const o = org({ innHints: [{ inn: INN, name: 'ООО «Ромашка»' }] })
    const cands = candidatesFor(o, buildIndex(list))
    assert.ok(reasonsOf(cands, 'c1').includes('inn_hint'))
    assert.equal(confidentCandidate(o, cands), null)
  })
  it('потерянный ведущий ноль или КПП в ячейке — только «похож», не уверенный', () => {
    for (const cell of [`${INN}/770701001`, `${INN2}; ${INN}`]) {
      const o = org({ inn: INN })
      const cands = candidatesFor(o, buildIndex([cp('c1', 'ООО Ромашка', cell)]))
      assert.deepEqual(reasonsOf(cands, 'c1').slice(0, 1), ['inn_soft'], cell)
      assert.equal(confidentCandidate(o, cands), null, cell)
    }
  })
  it('контрольная сумма не сошлась — не уверенный, пометка', () => {
    const o = org({ inn: BAD_INN })
    const cands = candidatesFor(o, buildIndex([cp('c1', 'ООО Ромашка', BAD_INN)]))
    assert.ok(flagsOf(cands, 'c1').includes('checksum'))
    assert.equal(confidentCandidate(o, cands), null)
  })
  it('контрагент в чёрном списке — не уверенный, пометка', () => {
    const o = org({ inn: INN })
    const cands = candidatesFor(o, buildIndex([cp('c1', 'ООО Ромашка', INN, { status: 'blacklist' })]))
    assert.ok(flagsOf(cands, 'c1').includes('blacklist'))
    assert.equal(confidentCandidate(o, cands), null)
  })
  it('два контрагента с этим ИНН (точный и мягкий) — не уверенный; основная запись помечена', () => {
    const list = [cp('c1', 'ООО Ромашка', INN, { contracts: 2 }), cp('c2', 'Ромашка', `${INN}/770701001`)]
    const o = org({ inn: INN })
    const cands = candidatesFor(o, buildIndex(list))
    assert.equal(confidentCandidate(o, cands), null)
    assert.ok(flagsOf(cands, 'c1').includes('main_record'))
    assert.ok(flagsOf(cands, 'c2').includes('duplicate'))
  })
  it('своя организация никогда не уверенный', () => {
    const o = org({ kind: 'own', inn: INN })
    assert.equal(confidentCandidate(o, candidatesFor(o, buildIndex([cp('c1', 'ООО Ромашка', INN)]))), null)
  })
  it('название и домен — только кандидаты; домен из публичных почт не считается', () => {
    const list = [cp('c1', 'ООО «Ромашка»', null, { domains: ['romashka.ru'] }), cp('c2', 'ООО Другое', null, { domains: ['gmail.com'] })]
    const o = org({ emailDomains: ['romashka.ru', 'gmail.com'] })
    const cands = candidatesFor(o, buildIndex(list))
    assert.deepEqual(reasonsOf(cands, 'c1'), ['name', 'domain'])
    assert.deepEqual(reasonsOf(cands, 'c2'), [])
    assert.equal(confidentCandidate(o, cands), null)
  })
  it('подсказка BillHub, не сходящаяся с названием, — «проверьте» и ниже в списке', () => {
    const list = [cp('c1', 'ООО «РАДУГА»', INN)]
    const o = org({ name: 'ПРОБНАЯ УЧЁТКА', innHints: [{ inn: INN, name: 'ООО «РАДУГА»' }] })
    const cands = candidatesFor(o, buildIndex(list))
    assert.ok(flagsOf(cands, 'c1').includes('hint_name'))
  })
})

describe('отчёт по всем организациям', () => {
  it('контрагент — сильный кандидат у двух организаций: пометка у обеих, уверенным не станет', () => {
    const list = [cp('c1', 'ООО Радуга', INN)]
    const orgs = [org({ su10OrgId: ORG, name: 'РАДУГА ООО', inn: INN }), org({ su10OrgId: ORG2, name: 'Радуга ООО' })]
    const { rows, stats } = planReport(orgs, list)
    assert.ok(rows.every((r) => flagsOf(r.candidates, 'c1').includes('claimed')))
    assert.ok(rows.every((r) => !r.confident))
    assert.equal(stats.claimed, 1)
  })
  it('нынешний вид выгрузки (ИНН реестра пуст, только подсказки BillHub) → ни одного уверенного', () => {
    const list = [cp('c1', 'ООО «3Д»', INN2), cp('c2', 'ООО Ромашка', INN)]
    const orgs = [
      org({ su10OrgId: ORG, name: '3Д ООО', innHints: [{ inn: INN2, name: 'ООО "3Д"' }] }),
      org({ su10OrgId: ORG2, name: 'Ромашка ООО' }),
      org({ su10OrgId: '11111111-1111-4111-8111-111111111111', kind: 'own', name: 'СУ-10' }),
    ]
    const { rows, stats } = planReport(orgs, list)
    assert.equal(rows.length, 2)
    assert.equal(stats.confident, 0)
    assert.equal(stats.registryInn, 0)
    assert.equal(stats.withStrong, 2)
  })
  it('основная запись: не ЧС → с договорами → больше связей; ничья — нет основной', () => {
    assert.equal(pickMain([cp('a', 'x', null, { status: 'blacklist' }), cp('b', 'x')]), 'b')
    assert.equal(pickMain([cp('a', 'x'), cp('b', 'x', null, { tenders: 1 })]), 'b')
    assert.equal(pickMain([cp('a', 'x', null, { relations: 2 }), cp('b', 'x', null, { relations: 1 })]), 'a')
    assert.equal(pickMain([cp('a', 'x'), cp('b', 'x')]), null)
  })
})

describe('поиск контрагента администратором', () => {
  const list = [cp('c12', 'ООО «Ромашка»', INN, { number: 12 }), cp('c13', 'ООО Ромашка Плюс', INN2, { number: 13 }), cp('c14', 'ИП Лютиков', INN12, { number: 14 })]
  it('«№ 12» и «12» — номер; цифры от 5 — ИНН; слова — начала слов в любом порядке', () => {
    assert.deepEqual(searchCounterparties(list, '№ 12').map((c) => c.id), ['c12'])
    assert.deepEqual(searchCounterparties(list, '12').map((c) => c.id), ['c12'])
    assert.deepEqual(searchCounterparties(list, INN.slice(0, 6)).map((c) => c.id), ['c12'])
    assert.deepEqual(searchCounterparties(list, 'плюс ром').map((c) => c.id), ['c13'])
    assert.deepEqual(searchCounterparties(list, 'ромашка').map((c) => c.id), ['c12', 'c13'])
    assert.deepEqual(searchCounterparties(list, ''), [])
  })
})
