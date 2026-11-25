// Сопоставитель OSP ↔ SIGNAL: номера в названиях папок (пакет ПР-1 волны исправлений).
// Находки: Б-1 (номер старого вида и номер ДС не сравнивались), К-6 (чужой номер по схеме не виден), С-40 (слитая приставка
// становится частью кода), С-41 (ДП и папка ДС), В-1 («сверено» только при найденном номере), В-2 (временное правило для номеров
// старого вида), В-3 (противоречие по расположению убрано), В-4 (чужой ИНН).
// Данные — только синтетика. Чистые функции, без базы и сети. Пробы рецензентов (w3, w4, w5, judge) здесь перевёрнуты: каждый
// случай, где раньше было «сверено» на чужую папку или «противоречие» на свою, теперь ожидает верный итог.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import process from 'node:process'
import * as M from '../../server/osp-api/src/lib/signalMatch.js'
import { numberKey } from '../../server/osp-api/src/shared/contractNumbering.js'

const id = (p, n) => `${p.repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`
const PROJECT = id('a', 1)
const OBJ_A = id('b', 1)
const OBJ_B = id('b', 2)
const CP1 = id('e', 1)
const FOLDER_URL = 'https://signal.example.test/projects/{projectId}/folders/{folderId}'
const FORMATS = [FOLDER_URL]
const OBJECTS = [
  { id: OBJ_A, name: 'Примавера', code: 'ПРИМ', aliases: [] },
  { id: OBJ_B, name: 'ЖК Другой', code: 'ЗИЛ', aliases: [] },
]
const GEN = 7

let seq = 0
const node = (name, extra = {}) => {
  const parentPath = extra.parentPath ?? 'Проект'
  return {
    nodeId: extra.nodeId || id('c', ++seq), projectId: PROJECT, sourceId: 1, kind: 'folder', parentId: null, name,
    path: extra.path ?? `${parentPath} / ${name}`, pathIds: [], objectId: OBJ_A, numberKeys: [], features: {}, nameNorm: '',
    observed: true, absentNights: 0, deleted: false, sourceEnabled: true, sourceReady: true, ...extra, parentPath: undefined,
  }
}
const child = (parent, name, extra = {}) => node(name, { parentPath: parent.path, pathIds: [...parent.pathIds, parent.nodeId], parentId: parent.nodeId, ...extra })
const urlOf = (n) => M.buildSignalUrl(FOLDER_URL, { projectId: n.projectId, nodeId: n.nodeId })

const dp = (number, extra = {}) => ({
  id: id('d', 1), recordType: 'dp', number, numberKey: numberKey(number), objectId: OBJ_A, parentId: null, rootId: null, signalLink: null,
  deleted: false, counterparties: [{ id: CP1, name: 'ООО «Альфа»', inn: null }], family: { dp: null, cycle: false }, candidates: [],
  revision: 1, stateVersion: 0, state: null, ...extra,
})
const ds = (dpContract, number, extra = {}) => ({
  ...dp(number, { id: id('d', 2), recordType: 'ds_vor', numberKey: null, parentId: dpContract.id, rootId: dpContract.id }),
  family: { dp: { id: dpContract.id, number: dpContract.number, numberKey: dpContract.numberKey, objectId: dpContract.objectId, signalLink: dpContract.signalLink, nodeId: null, deleted: false }, cycle: false },
  ...extra,
})
const run = (contract, nodes, opts = {}) => M.matchContract({ ...contract, nodes, objects: OBJECTS }, { formats: FORMATS, generation: GEN, ...opts })
const evaluate = (contract, nodes, nodeId) => M.evaluateNode({ ...contract, nodes, objects: OBJECTS }, nodeId, { generation: GEN })
const label = (r) => `${r.state}:${r.reason}`
// Итог введённой ссылки на узел nd (остальные узлы nodes — те же, что в выборке договора).
const verdict = (contract, nd, others = []) => label(run({ ...contract, signalLink: urlOf(nd) }, [nd, ...others]))

const MINE = 'ПРИМ-ДП-26-001'
const OTHER = 'ПРИМ-ДП-26-002'
const LEGACY = 'СУ10-ВЭЙВ-СП-Э1-25'

describe('К-6: чужой номер по схеме виден в любой записи', () => {
  const forms = [
    ['хвост через дефис: слово контрагента', `${OTHER}-Альфа`],
    ['хвост через дефис: номер ДС', `${OTHER}-ДС1`],
    ['хвост через дефис: цифра', `${OTHER}-1`],
    ['буква сразу за номером', `${OTHER}А`],
    ['длинное тире', 'ПРИМ–ДП–26–002'],
    ['длинное тире «—»', 'ПРИМ—ДП—26—002'],
    ['неразрывный дефис U+2011', 'ПРИМ‑ДП‑26‑002'],
    ['минус U+2212', 'ПРИМ−ДП−26−002'],
    ['пробелы вместо дефисов', 'ПРИМ ДП 26 002'],
    ['пробелы вокруг дефисов', 'ПРИМ - ДП - 26 - 002'],
    ['четыре цифры года', 'ПРИМ-ДП-2026-002'],
    ['«№» перед порядковым номером', 'ПРИМ-ДП-26 №002'],
    ['косые черты', 'ПРИМ/ДП/26/002'],
    ['подчёркивания', 'ПРИМ_ДП_26_002'],
    ['точки', 'ПРИМ.ДП.26.002'],
    ['строчные буквы', 'прим-дп-26-002'],
    ['латинские двойники', 'ПPИM-ДП-26-002'],
  ]
  for (const [what, foreign] of forms) {
    it(`${what}: «${foreign}» — противоречие, подтвердить нельзя, своя папка предлагается`, () => {
      const wrong = node(`Договор № ${foreign} от 12.03.2026 ООО Альфа`)
      const right = node(MINE)
      const c = dp(MINE, { signalLink: urlOf(wrong) })
      const r = run(c, [wrong, right])
      assert.equal(label(r), 'conflict:number_mismatch')
      assert.equal(evaluate(c, [wrong, right], wrong.nodeId).confirmable, false)
      // рядом показывается верная папка для замены, а чужая — нет
      assert.deepEqual(r.candidates.map((x) => x.nodeId), [right.nodeId])
    })
  }

  it('ДС: подпапка ДС содержит чужой номер ДП с хвостом — противоречие foreign_dp', () => {
    const dpFolder = node(`${MINE} ООО Альфа`)
    const dpc = dp(MINE, { signalLink: urlOf(dpFolder) })
    const stray = child(dpFolder, `ДС №1 к ${OTHER}-Альфа`)
    assert.equal(label(run(ds(dpc, 'ДС №1', { signalLink: urlOf(stray) }), [dpFolder, stray])), 'conflict:foreign_dp')
  })

  it('«номер-Контрагент» через дефис: у каждого договора ровно своя папка, чужие не предлагаются', () => {
    const folders = ['ПРИМ-ДП-26-001-Альфа', 'ПРИМ-ДП-26-002-Альфа', 'ПРИМ-ДП-26-003-Альфа'].map((n) => node(n))
    for (const mine of ['ПРИМ-ДП-26-001', 'ПРИМ-ДП-26-002', 'ПРИМ-ДП-26-003']) {
      const r = run(dp(mine), folders)
      assert.equal(r.candidates.length, 1, mine)
      assert.equal(folders.find((f) => f.nodeId === r.candidates[0].nodeId).name, `${mine}-Альфа`)
      assert.ok(r.candidates[0].reasons.includes('number'))
      for (const f of folders) {
        const ok = f.name.startsWith(mine)
        assert.equal(evaluate(dp(mine), folders, f.nodeId).confirmable, ok, `${mine} ← ${f.name}`)
      }
    }
  })

  it('номер упоминается дважды одинаково — не неоднозначность; два разных — ambiguous', () => {
    assert.equal(verdict(dp(MINE), node(`${MINE} (см. ${MINE}-Альфа)`)), 'verified:existing_url')
    assert.equal(verdict(dp(MINE), node(`${MINE} (взамен ПРИМ-ДП-25-014)`)), 'conflict:ambiguous')
    assert.equal(verdict(dp(MINE), node(`${MINE} и ${OTHER} ООО Ромашка`)), 'conflict:ambiguous')
  })
})

describe('С-40: слитая приставка не становится частью кода', () => {
  const forms = [
    ['слово контрагента через дефис', `Альфа-${MINE}`],
    ['порядковый номер папки через дефис', `01-${MINE}`],
    ['год через дефис', `2026-${MINE}`],
    ['порядковый номер папки через точку', `01.${MINE}`],
    ['«ДП.» через точку', `ДП.${MINE}`],
    ['«Дог.» через точку', `Дог.${MINE}`],
    ['«Договор подряда-»', `Договор подряда-${MINE}`],
    ['приставка «ДП» без разделителя', `ДП${MINE}`],
    ['«N» без пробела', `Договор N${MINE}`],
    ['через пробел', `Альфа ${MINE}`],
    ['через «_»', `01_${MINE}`],
    ['«ДП-»', `ДП-${MINE}`],
  ]
  for (const [what, name] of forms) {
    it(`${what}: «${name}» — сверено, подтвердить можно`, () => {
      const right = node(name)
      const c = dp(MINE, { signalLink: urlOf(right) })
      assert.equal(label(run(c, [right])), 'verified:existing_url')
      assert.equal(evaluate(c, [right], right.nodeId).confirmable, true)
    })
  }

  it('кандидаты: папка с приставкой найдена по основному ключу (кроме «NКОД» — без выборки по ключу)', () => {
    for (const name of [`Альфа-${MINE}`, `01.${MINE}`, `Дог.${MINE}`, `Договор подряда-${MINE}`, `ДП${MINE}`, `2026-${MINE}`]) {
      const r = run(dp(MINE), [node(name)])
      assert.equal(r.candidates.length, 1, name)
      assert.ok(r.candidates[0].reasons.includes('number'), name)
    }
  })

  it('ДС: «ДС-1-ПРИМ-ДП-26-001» и «ДС1-ПРИМ-ДП-26-001» внутри папки своего ДП — сверено, а не foreign_dp', () => {
    const dpFolder = node(`${MINE} ООО Альфа`)
    const dpc = dp(MINE, { signalLink: urlOf(dpFolder) })
    for (const name of [`ДС-1-${MINE}`, `ДС1-${MINE}`, `ДС №1 к ${MINE}`]) {
      const sub = child(dpFolder, name)
      assert.equal(label(run(ds(dpc, 'ДС №1', { signalLink: urlOf(sub) }), [dpFolder, sub])), 'verified:existing_url', name)
    }
  })

  it('разбор: основной ключ — без приставки, остальные разборы кода лежат в alts', () => {
    const [r] = M.extractContractReferences('Альфа-ПРИМ-ДП-26-001')
    assert.equal(r.key, 'ПРИМ|2026|1')
    assert.deepEqual(r.alts, ['АЛЬФА-ПРИМ|2026|1'])
    // известный код объекта выбирает разбор явно
    const [k] = M.extractContractReferences('Альфа-ПРИМ-ДП-26-001', { codes: ['Альфа-ПРИМ'] })
    assert.equal(k.key, 'АЛЬФА-ПРИМ|2026|1')
  })
})

describe('К-6/С-40: ключ записи по схеме равен numberKey (SQL contract_number_key)', () => {
  it('каноническая запись: ключ совпадает, в том числе при коде с дефисом и точкой', () => {
    for (const n of ['ПРИМ-ДП-26-001', 'ЗИЛ18-19-27-ДП-26-001', 'СОБ6.1-ДП-26-014', 'ДОМ56Рен-ДП-27-1000', 'A-ДП-26-001', 'ЛЕНИНСКИЙ-ДП-26-005', 'ёж-дп-26-3']) {
      const refs = M.extractContractReferences(`${n} ООО Альфа`).filter((r) => r.kind === 'scheme')
      assert.equal(refs.length, 1, n)
      assert.equal(refs[0].key, numberKey(n), n)
      assert.deepEqual(M.prepareNode({ name: `${n} ООО Альфа`, path: `Проект / ${n} ООО Альфа` }).numberKeys, [numberKey(n)], n)
    }
  })

  it('генератор: 3000 записей разных видов — ключ всегда равен numberKey канонической записи', () => {
    let s = 20261124
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32
    const pick = (a) => a[Math.floor(rnd() * a.length)]
    const codes = ['ПРИМ', 'ЗИЛ', 'АЛИЯ', 'СОБ6.1', 'ЗИЛ18-19-27', 'ДОМ56Рен', 'X12', 'К14']
    const tails = ['', ' ООО Альфа', '-Альфа', '-ДС1', '/1', ' от 12.03.2026', '.pdf', ' (копия)']
    const heads = ['', 'ДП №', 'Договор № ', '№ ', '01 ', 'Альфа ']
    let checked = 0
    for (let i = 0; i < 3000; i++) {
      const code = pick(codes)
      const yy = pick(['26', '27', '25'])
      const n = String(1 + Math.floor(rnd() * 999)).padStart(3, '0')
      const canon = `${code}-ДП-${yy}-${n}`
      const text = `${pick(heads)}${canon}${pick(tails)}`
      const want = numberKey(canon)
      if (!want) continue
      const got = M.extractContractReferences(text).filter((r) => r.kind === 'scheme')
      assert.ok(got.length >= 1 && got.every((r) => r.key === want), `${text}: ${JSON.stringify(got.map((r) => r.key))} ≠ ${want}`)
      checked++
    }
    assert.ok(checked > 2500)
  })

  it('код, похожий на приставку («9.ПРИМ», «Альфа-ПРИМ»): без списка кодов основной ключ — без приставки; со списком кодов объектов — по известному коду', () => {
    const name = '9.ПРИМ-ДП-26-001 ООО Альфа'
    assert.deepEqual(M.prepareNode({ name, path: name }).numberKeys, ['ПРИМ|2026|1'])
    assert.deepEqual(M.prepareNode({ name, path: name, codes: ['9.ПРИМ'] }).numberKeys, ['9.ПРИМ|2026|1'])
    assert.deepEqual(M.prepareNode({ name, path: name, codes: ['ПРИМ'] }).numberKeys, ['ПРИМ|2026|1'])
    // сравнение «свой номер» принимает любой разбор кода, поэтому подтверждение не ломается и без списка
    const nd = node(name)
    assert.equal(verdict(dp('9.ПРИМ-ДП-26-001'), nd), 'verified:existing_url')
    assert.equal(verdict(dp('ПРИМ-ДП-26-001'), node(name)), 'verified:existing_url')
  })

  it('номер договора старого вида с приставкой («ДП №…») находится и в папке без приставки', () => {
    const c = dp('ДП №СУ10-ВЭЙВ-СП-Э1-25')
    assert.equal(verdict(c, node('СУ10-ВЭЙВ-СП-Э1-25 ООО Лютик')), 'verified:existing_url')
    assert.equal(verdict(c, node('ДП №СУ10-ВЭЙВ-СП-Э1-26 ООО Лютик')), 'conflict:number_mismatch')
    const r = run(c, [node('СУ10-ВЭЙВ-СП-Э1-25 ООО Лютик'), node('СУ10-ВЭЙВ-СП-Э1-26 ООО Лютик')])
    assert.equal(r.candidates.length, 1)
  })

  it('формы номера ДС находятся как кандидаты внутри папки своего ДП (не только распознаются)', () => {
    const dpF = node('ПРИМ-ДП-26-001 ООО Альфа')
    const dpc = dp(MINE, { signalLink: urlOf(dpF) })
    for (const name of ['ДС 1', 'ДС №01', 'ДС N1', 'ДС No1', 'ДС 001', 'Д/С 1', 'Доп. соглашение № 1']) {
      const r = run(ds(dpc, 'ДС №1'), [dpF, child(dpF, name)])
      assert.equal(r.candidates.length, 1, name)
    }
    assert.equal(run(ds(dpc, 'ДС №1'), [dpF, child(dpF, 'ДС 11'), child(dpF, 'ДС 10')]).candidates.length, 0)
  })

  it('год из четырёх цифр, «№» и разделители дают тот же ключ', () => {
    const want = numberKey(MINE)
    for (const t of ['ПРИМ-ДП-2026-001', 'ПРИМ ДП 26 001', 'ПРИМ_ДП_26_001', 'ПРИМ/ДП/26/001', 'ПРИМ.ДП.26.001', 'ПРИМ–ДП–26–001', 'ПРИМ-ДП-26 №001', 'ПРИМ-ДП-26-1', 'ПРИМ - ДП - 26 - 001']) {
      assert.deepEqual(M.extractContractReferences(t).filter((r) => r.kind === 'scheme').map((r) => r.key), [want], t)
    }
  })

  it('не номер: дата после «ДП», «ДП» без кода, слово-приставка вместо кода', () => {
    for (const t of ['Договор ДП 12.03.2026', 'ДП 12.03.2026', 'ДП-26-001', 'Договор-ДП-26-001', 'Альфа ДП 12.03.26']) {
      assert.deepEqual(M.extractContractReferences(t).filter((r) => r.kind === 'scheme'), [], t)
    }
  })

  it('контроль: год, «/1», «Договор №… от …» рядом со своим номером не дают ложных противоречий', () => {
    for (const name of ['АЛФ-ДП-26-001 2026 ООО Ромашка', 'АЛФ-ДП-26-001/1', 'Договор №АЛФ-ДП-26-001 от 01.02.2026', 'АЛФ-ДП-26-001 (копия)', 'АЛФ-ДП-26-001.v2']) {
      const nd = node(`Док / ${name}`, { path: `Док / ${name}` })
      assert.equal(verdict(dp('АЛФ-ДП-26-001'), nd), 'verified:existing_url', name)
    }
  })

  it('регистр, неразрывный пробел, латинские двойники, «ё/е» — тот же результат', () => {
    const lat = (x) => x.replace(/[АЕКМНОРСТХ]/g, (c) => ({ А: 'A', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X' })[c])
    const base = (name) => run(dp(MINE), [node(name)])
    for (const name of ['ДП №ПРИМ-ДП-26-001 Альфа', 'ПРИМ-ДП-26-001', 'Договор № ПРИМ-ДП-26-001 от 12.03.2026']) {
      const want = base(name)
      for (const v of [name.toLowerCase(), name.toUpperCase(), name.replace(/ /g, String.fromCharCode(160)), lat(name), name.replace(/е/g, 'ё')]) {
        const got = base(v)
        assert.equal(`${got.state}:${got.reason}:${got.candidates.length}`, `${want.state}:${want.reason}:${want.candidates.length}`, JSON.stringify(v))
      }
    }
  })

  it('hasAmbiguousNumbers: два разных ключа по схеме', () => {
    assert.equal(M.hasAmbiguousNumbers(M.extractContractReferences('ПРИМ-ДП-26-001 и ПРИМ-ДП-26-002')), true)
    assert.equal(M.hasAmbiguousNumbers(M.extractContractReferences('ПРИМ-ДП-26-001, ПРИМ-ДП-26-1')), false)
    assert.equal(M.hasAmbiguousNumbers(M.extractContractReferences('ПРИМ-ДП-26-001 ДС 3')), false)
  })
})

describe('Б-1 и В-2: номер старого вида и номер ДС сравниваются', () => {
  const legacy = dp(LEGACY)

  it('явная приставка «ДП №» с другим номером — противоречие (раньше «сверено»)', () => {
    assert.equal(verdict(legacy, node('Док / Корпус 14 / ДП №СУ10-ВЭЙВ-СП-Э1-26 ООО Лютик')), 'conflict:number_mismatch')
    assert.equal(verdict(legacy, node('Док / ДП СУ10-ВЭЙВ-СП-Э1-26 ООО Х')), 'conflict:number_mismatch')
    assert.equal(verdict(legacy, node('Док / Договор № СУ10-ВЭЙВ-СП-Э1-26 от 01.02.2026')), 'conflict:number_mismatch')
    assert.equal(verdict(legacy, node('Док / ДП №77-Б ООО Х')), 'conflict:number_mismatch')
  })

  it('номер другого договора по схеме в названии папки — противоречие', () => {
    assert.equal(verdict(legacy, node('Док / Корпус 14 / ПРИМ-ДП-26-001 ООО Ромашка')), 'conflict:number_mismatch')
    assert.equal(verdict(legacy, node('Док / ПРИМ-ДП-26-001 ООО Х')), 'conflict:number_mismatch')
  })

  it('договор по схеме и папка с явным номером старого вида — противоречие', () => {
    assert.equal(verdict(dp(MINE), node('Док / ДП СУ10-ВЭЙВ-СП-Э1-25 ООО Х')), 'conflict:number_mismatch')
  })

  it('свой номер: с приставкой и без, в любой записи — сверено', () => {
    for (const name of ['ДП №СУ10-ВЭЙВ-СП-Э1-25 ООО Лютик', 'СУ10-ВЭЙВ-СП-Э1-25 ООО Лютик', 'Договор № СУ10-ВЭЙВ-СП-Э1-25 от 01.02.2025',
      'су10-вэйв-сп-э1-25', 'СУ10_ВЭЙВ_СП_Э1_25', 'СУ10 ВЭЙВ СП Э1 25']) {
      assert.equal(verdict(legacy, node(`Док / ${name}`)), 'verified:existing_url', name)
    }
  })

  it('TODO(В-2): номер без приставки в названии — только положительный признак, противоречия не даёт', () => {
    const refs = M.extractContractReferences('СУ10-ВЭЙВ-СП-Э1-26 ООО Лютик')
    assert.deepEqual(refs.map((r) => [r.kind, r.key, r.explicit]), [['legacy', 'СУ10-ВЭЙВ-СП-Э1-26', false]])
    // чужой номер без приставки — не «сверено» и не «противоречие»: ссылка принята, номер не найден
    assert.equal(verdict(legacy, node('Док / СУ10-ВЭЙВ-СП-Э1-26 ООО Лютик')), 'accepted:number_not_found')
    assert.deepEqual(M.extractContractReferences('ДП №СУ10-ВЭЙВ-СП-Э1-26 ООО Лютик').map((r) => [r.kind, r.key, r.explicit]), [['legacy', 'СУ10-ВЭЙВ-СП-Э1-26', true]])
    assert.equal(M.extractContractReferences('ДП№12 ООО Альфа')[0].explicit, true)
    assert.equal(M.extractContractReferences('№12 ООО Альфа')[0].explicit, false)
  })

  it('ДС: папка другого ДС того же договора — ds_mismatch (раньше «сверено»)', () => {
    const dpF = node('Док / ДП ПРИМ-ДП-26-002 ООО Ромашка')
    const dpc = dp('ПРИМ-ДП-26-002', { signalLink: urlOf(dpF) })
    const one = (number, name) => { const sub = child(dpF, name); return label(run(ds(dpc, number, { signalLink: urlOf(sub) }), [dpF, sub])) }
    assert.equal(one('ДС-1', 'ДС-1'), 'verified:existing_url')
    assert.equal(one('ДС-1', 'ДС-2'), 'conflict:ds_mismatch')
    assert.equal(one('1', 'ДС-2 от 12.03.2026'), 'conflict:ds_mismatch')
    assert.equal(one('ДС №04', 'ДС 4'), 'verified:existing_url') // ведущий ноль не важен
    assert.equal(one('ДС 4.0', 'ДС 4'), 'verified:existing_url')
    assert.equal(one('ДС-1', 'ДС-1 к ПРИМ-ДП-26-003'), 'conflict:foreign_dp')
  })

  it('ДС: номер ДП в поле номера ДС номером ДС не считается; сверка идёт по номеру ДП в пути', () => {
    const dpF = node('Док / ДП ПРИМ-ДП-26-002 ООО Ромашка')
    const dpc = dp('ПРИМ-ДП-26-002', { signalLink: urlOf(dpF) })
    const sub = child(dpF, 'ДС-1')
    assert.equal(label(run(ds(dpc, 'ПРИМ-ДП-26-002', { signalLink: urlOf(sub) }), [dpF, sub])), 'verified:existing_url')
  })

  it('формы записи номера ДС распознаются', () => {
    const keys = (t) => M.extractContractReferences(t).filter((r) => r.kind === 'ds').map((r) => r.key)
    for (const t of ['ДС 1', 'ДС-1', 'ДС №1', 'ДС №01', 'ДС N1', 'ДС No1', 'ДС 001', 'ДС1', 'Д/С 1', 'Доп. соглашение № 1', 'доп.согл. 1', 'Дополнительное соглашение №1']) {
      assert.deepEqual(keys(t), ['ДС|1'], t)
    }
    assert.deepEqual(keys('ДС от 12.03.2026'), [])
    assert.deepEqual(keys('ДС 12.03.2026'), [])
  })
})

describe('С-41: ДП и папка ДС', () => {
  for (const mine of ['ПРИМ-ДП-26-001', 'СУ2-ПРИМ14-0215']) {
    describe(`номер ${mine}`, () => {
      const dpFolder = node(/-ДП-/.test(mine) ? mine : `ДП №${mine}`)
      const dsFolder = child(dpFolder, `ДС №2 к ${mine} ООО Альфа`)
      const nodes = [dpFolder, dsFolder]

      it('ссылка ДП на папку своего ДС — мягкое attention:kind_mismatch, подтвердить можно (warning)', () => {
        const c = dp(mine, { signalLink: urlOf(dsFolder) })
        const r = run(c, nodes)
        assert.deepEqual([label(r), r.nodeId], ['attention:kind_mismatch', dsFolder.nodeId])
        const e = evaluate(c, nodes, dsFolder.nodeId)
        assert.deepEqual([e.state, e.reason, e.confirmable, e.warning], ['attention', 'kind_mismatch', true, 'kind_mismatch'])
        // папка самого ДП рядом предлагается для замены
        assert.deepEqual(r.candidates.map((x) => x.nodeId), [dpFolder.nodeId])
      })

      it('без ссылки: папка ДС не исключается — флаг kind_mismatch и штраф 40, папка самого ДП выше', () => {
        const r = run(dp(mine), nodes)
        assert.deepEqual(r.candidates.map((c) => c.nodeId), [dpFolder.nodeId, dsFolder.nodeId])
        const [top, low] = r.candidates
        assert.deepEqual([top.flags, low.flags], [[], ['kind_mismatch']])
        assert.ok(top.score >= low.score)
        // при равных баллах (у папки ДС в названии ещё и контрагент) папка ДП всё равно первая — и при пути, который сортируется раньше
        const early = { ...dsFolder, path: `Архив / ${dsFolder.name}`, objectPath: `Архив / ${dsFolder.name}` }
        const tie = run(dp(mine, { counterparties: [{ id: CP1, name: 'ООО «Альфа»', inn: null }] }), [dpFolder, early])
        assert.equal(tie.candidates[0].nodeId, dpFolder.nodeId)
        // тот же ДС без штрафа набрал бы ровно на 40 больше
        const plain = run(dp(mine), [dpFolder, { ...dsFolder, name: dsFolder.name.replace(/ДС №2 к /, '') }])
        assert.equal(plain.candidates.find((c) => c.nodeId === dsFolder.nodeId).score - low.score, 40)
      })

      it('жёсткое противоречие главнее: папка ДС с чужим номером ДП — conflict:number_mismatch; решение человека по папке ДС сохраняется', () => {
        // у номера старого вида чужой номер противоречит только с явной приставкой (TODO(В-2))
        const alien = child(dpFolder, /-ДП-/.test(mine) ? 'ДС №2 к ПРИМ-ДП-26-002' : 'ДС №2 к ДП №СУ2-ПРИМ14-0300')
        assert.equal(label(run(dp(mine, { signalLink: urlOf(alien) }), [dpFolder, alien])), 'conflict:number_mismatch')
        const state = { state: 'verified', reason: 'confirmed', nodeId: dsFolder.nodeId, confirmedBy: id('f', 1) }
        assert.equal(label(run(dp(mine, { signalLink: urlOf(dsFolder), state }), nodes)), 'verified:confirmed')
      })

      it('приоритет мягких: вид главнее корпуса; корпус не мешает kind_mismatch подтверждаться', () => {
        const wrongBuilding = child(dpFolder, `ДС №2 к ${mine}`, { path: `Проект / корп.22 / ДС №2 к ${mine}` })
        const objects = [{ ...OBJECTS[0], name: 'Примавера, корпус 14' }, OBJECTS[1]]
        const r = M.matchContract({ ...dp(mine, { signalLink: urlOf(wrongBuilding) }), nodes: [wrongBuilding], objects }, { formats: FORMATS, generation: GEN })
        assert.equal(label(r), 'attention:kind_mismatch')
      })

      it('ссылка ДП на саму папку ДП — сверено', () => {
        assert.equal(label(run(dp(mine, { signalLink: urlOf(dpFolder) }), nodes)), 'verified:existing_url')
      })
    })
  }
})

describe('В-1, С-33: «сверено» — только при найденном номере', () => {
  it('ссылка на корень или контейнер без номера — «ссылка принята, номер не найден»', () => {
    for (const number of [MINE, LEGACY]) {
      assert.equal(verdict(dp(number), node('Договора подряда')), 'accepted:number_not_found')
      assert.equal(verdict(dp(number), node('Договора подряда / ООО Ромашка')), 'accepted:number_not_found')
      assert.equal(verdict(dp(number), node('Документы Альфа / Корпус 1 / Договор Ромашка')), 'accepted:number_not_found')
    }
  })

  it('номер найден в названии предка — сверено', () => {
    const top = node(`${MINE} ООО Альфа`)
    const sub = child(top, 'Акты')
    const deep = child(sub, '2026')
    assert.equal(verdict(dp(MINE), deep, [top, sub]), 'verified:existing_url')
  })

  it('accepted можно подтвердить; решение человека сохраняется при пересчёте (verified:confirmed)', () => {
    const nd = node('Договора подряда')
    const c = dp(MINE)
    assert.equal(evaluate(c, [nd], nd.nodeId).confirmable, true)
    const prev = { state: 'verified', reason: 'confirmed', nodeId: nd.nodeId, confirmedBy: id('f', 1) }
    assert.equal(label(run({ ...c, signalLink: urlOf(nd), state: prev }, [nd])), 'verified:confirmed')
    // другой узел или без confirmedBy — не сохраняется
    assert.equal(label(run({ ...c, signalLink: urlOf(nd), state: { ...prev, nodeId: id('c', 9999) } }, [nd])), 'accepted:number_not_found')
    assert.equal(label(run({ ...c, signalLink: urlOf(nd), state: { ...prev, confirmedBy: null } }, [nd])), 'accepted:number_not_found')
  })

  it('жёсткое противоречие снимает подтверждение человека', () => {
    const wrong = node(OTHER)
    const prev = { state: 'verified', reason: 'confirmed', nodeId: wrong.nodeId, confirmedBy: id('f', 1) }
    assert.equal(label(run({ ...dp(MINE), signalLink: urlOf(wrong), state: prev }, [wrong])), 'conflict:number_mismatch')
  })

  it('кандидаты рядом с accepted — только с номером, без слабых догадок', () => {
    const container = node('Договора подряда')
    const withNumber = node(`${MINE} ООО Альфа`)
    const byParty = node('Договор ООО Альфа')
    const r = run({ ...dp(MINE), signalLink: urlOf(container) }, [container, withNumber, byParty])
    assert.equal(label(r), 'accepted:number_not_found')
    assert.deepEqual(r.candidates.map((c) => c.nodeId), [withNumber.nodeId])
  })
})

describe('В-3: ДС — противоречие только по номерам, расположение не ошибка', () => {
  it('ДС вне папки своего ДП без номера в пути — не ошибка; в папке с номером чужого ДП — foreign_dp', () => {
    const own = node('ПРИМ-ДП-26-003 ООО Ромашка')
    const dpc = dp('ПРИМ-ДП-26-003', { signalLink: urlOf(own) })
    const aside = node('ДС 3', { parentPath: 'Проект / Прочее' })
    assert.equal(label(run(ds(dpc, 'ДС №3', { signalLink: urlOf(aside) }), [own, aside])), 'verified:existing_url')
    const f2 = node('ПРИМ-ДП-26-002 Ромашка')
    const d2 = child(f2, 'ДС 3')
    assert.equal(label(run(ds(dpc, 'ДС №3', { signalLink: urlOf(d2) }), [own, f2, d2])), 'conflict:foreign_dp')
  })

  it('ДП без ссылки: номер корневого ДП берётся из семьи — подпапка чужого ДП всё равно foreign_dp, а не family_unknown', () => {
    const f2 = node('ПРИМ-ДП-26-002 Ромашка')
    const d2 = child(f2, 'ДС 3')
    const parent = dp('ПРИМ-ДП-26-003') // ссылки у ДП нет
    assert.equal(label(run(ds(parent, 'ДС №3', { signalLink: urlOf(d2) }), [f2, d2])), 'conflict:foreign_dp')
    const f3 = node('ПРИМ-ДП-26-003 Ромашка')
    const d3 = child(f3, 'ДС 3')
    assert.equal(label(run(ds(parent, 'ДС №3', { signalLink: urlOf(d3) }), [f3, d3])), 'verified:existing_url')
  })

  it('ДП без ссылки: предложения — верная папка (под ДП-003) единственная, чужие отсеяны; флага family_unknown нет', () => {
    const f1 = node('ПРИМ-ДП-26-001 Ромашка')
    const f2 = node('ПРИМ-ДП-26-002 Ромашка')
    const f3 = node('ПРИМ-ДП-26-003 Ромашка')
    const d1 = child(f1, 'ДС 3')
    const d2 = child(f2, 'ДС 3')
    const d3 = child(f3, 'ДС 3')
    const res = run(ds(dp('ПРИМ-ДП-26-003'), 'ДС №3'), [f1, f2, f3, d1, d2, d3])
    assert.equal(label(res), 'suggested:candidates')
    assert.deepEqual(res.candidates.map((c) => c.nodeId), [d3.nodeId])
    assert.ok(res.candidates[0].reasons.includes('ds_number') && res.candidates[0].reasons.includes('number'))
    assert.ok(!('family_unknown' in M.MATCH_FLAGS))
    assert.ok(!('family_unknown' in M.REASONS))
  })

  it('внутри известной папки ДП предложения первыми (+20), вне её — тоже допустимы', () => {
    const dpFolder = node('ПРИМ-ДП-26-003 Ромашка')
    const inside = child(dpFolder, 'ДС 3')
    const outside = node('ДС 3', { parentPath: 'Проект / Прочее' })
    const dpc = dp('ПРИМ-ДП-26-003', { signalLink: urlOf(dpFolder) })
    const res = run(ds(dpc, 'ДС №3'), [dpFolder, inside, outside])
    assert.deepEqual(res.candidates.map((c) => c.nodeId), [inside.nodeId, outside.nodeId])
    assert.ok(res.candidates[0].score - res.candidates[1].score >= 20 + 100)
  })

  it('ДС: нет семьи — проверка номера ДП пропускается, номер ДС проверяется', () => {
    const f2 = node('ПРИМ-ДП-26-002 Ромашка')
    const d2 = child(f2, 'ДС 3')
    const c = { ...ds(dp('ПРИМ-ДП-26-003'), 'ДС №3'), family: { dp: null, cycle: false }, signalLink: urlOf(d2) }
    assert.equal(label(run(c, [f2, d2])), 'verified:existing_url')
    const d4 = child(f2, 'ДС 4')
    assert.equal(label(run({ ...c, signalLink: urlOf(d4) }, [f2, d4])), 'conflict:ds_mismatch')
  })
})

describe('В-4: чужая сторона — только корректный ИНН', () => {
  // синтетический ИНН из 9 знаков + контрольная цифра (юрлицо, 10 цифр)
  const innOf = (nine) => {
    const w = [2, 4, 10, 3, 5, 9, 4, 6, 8]
    const d = [...nine].map(Number)
    return `${nine}${(d.reduce((s, x, i) => s + x * w[i], 0) % 11) % 10}`
  }
  const INN_MINE = innOf('781000001')
  const INN_OTHER = innOf('782000002')
  const withInn = (number, inn = INN_MINE) => dp(number, { counterparties: [{ id: CP1, name: 'ООО «Альфа»', inn }] })

  it('контроль: синтетические ИНН проходят проверку суммы, а число с неверной суммой — нет', async () => {
    const { isValidInn } = await import('../../server/osp-api/src/shared/contractorSignupRules.js')
    assert.ok(isValidInn(INN_MINE) && isValidInn(INN_OTHER) && INN_MINE !== INN_OTHER)
    assert.equal(isValidInn(`${INN_OTHER.slice(0, 9)}${(Number(INN_OTHER[9]) + 1) % 10}`), false)
  })

  for (const number of [LEGACY, MINE]) {
    it(`договор ${number}: папка с ИНН другой организации — foreign_party (раньше «сверено»)`, () => {
      const foreign = node(`${number} ООО «Ромашка» ИНН ${INN_OTHER}`)
      const own = node(`${number} ООО «Альфа» ИНН ${INN_MINE}`)
      const c = withInn(number)
      assert.equal(verdict(c, foreign, [own]), 'conflict:foreign_party')
      assert.equal(evaluate(c, [foreign], foreign.nodeId).confirmable, false)
      assert.equal(verdict(c, own, [foreign]), 'verified:existing_url')
    })
  }

  it('папка без номера с чужим ИНН — противоречие; со своим ИНН — «номер не найден»; с неверной суммой — не ИНН', () => {
    const c = withInn(MINE)
    assert.equal(verdict(c, node(`ООО «Ромашка» ИНН ${INN_OTHER}`)), 'conflict:foreign_party')
    assert.equal(verdict(c, node(`ООО «Альфа» ИНН ${INN_MINE}`)), 'accepted:number_not_found')
    const broken = `${INN_OTHER.slice(0, 9)}${(Number(INN_OTHER[9]) + 1) % 10}`
    assert.equal(verdict(c, node(`ООО «Ромашка» ИНН ${broken}`)), 'accepted:number_not_found')
  })

  it('у договора нет ИНН — не проверяется; свой ИНН у договора с несколькими сторонами — достаточно любого', () => {
    assert.equal(verdict(dp(MINE), node(`${MINE} ИНН ${INN_OTHER}`)), 'verified:existing_url')
    const two = dp(MINE, { counterparties: [{ id: CP1, name: 'ООО «Альфа»', inn: INN_MINE }, { id: id('e', 2), name: 'ООО «Бета»', inn: INN_OTHER }] })
    assert.equal(verdict(two, node(`${MINE} ИНН ${INN_OTHER}`)), 'verified:existing_url')
  })

  it('кандидаты: папка с чужим ИНН не предлагается, своя — предлагается', () => {
    const foreign = node(`ООО «Ромашка» ИНН ${INN_OTHER}`)
    const own = node(`ООО «Альфа» ИНН ${INN_MINE}`)
    assert.deepEqual(run(withInn(LEGACY), [foreign, own]).candidates.map((x) => x.nodeId), [own.nodeId])
  })
})

describe('Перебор: сочетания записи номера (стиль × приставка × запись × хвост)', () => {
  const STYLES = {
    scheme: { own: 'ПРИМ-ДП-26-001', foreign: 'ПРИМ-ДП-26-002' },
    legacy: { own: 'СУ2-ПРИМ14-0215', foreign: 'СУ2-ПРИМ14-0300' },
  }
  const PREFIX = ['', 'ДП №', 'Договор № ', 'ДП_', 'ДП ', '01 ', '01_', '01. ', '01-', '01.', 'Альфа ', 'Альфа-', 'Договор подряда-', 'ДС1-']
  const LAT = { А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y' }
  const RENDER = {
    канон: (n) => n,
    нижний: (n) => n.toLowerCase(),
    латиница: (n) => n.replace(/[АВЕКМНОРСТХУ]/g, (c) => LAT[c]),
    пробелы: (n) => n.replace(/-/g, ' '),
    тире: (n) => n.replace(/-/g, '–'),
  }
  const SUFFIX = ['', ' ООО Альфа', '_Альфа', ', Альфа', ' - Альфа', '-Альфа', '-ДС1', '-1', '/1', ' от 12.03.2026']
  // Папка, в названии которой есть «ДС1», — папка допсоглашения: для ДП это мягкое attention:kind_mismatch (С-41), а не «сверено»
  // и не противоречие.
  const isDsFolder = (name) => /ДС1/.test(name)

  for (const [style, { own, foreign }] of Object.entries(STYLES)) {
    it(`${style}: чужая папка — ни одного «сверено»; своя — ни одного ложного противоречия; чужая не вытесняет свою`, () => {
      const total = { cases: 0, stale: 0, falseConflict: 0, ownNotVerified: 0, blind: 0, tie: 0 }
      const bad = []
      for (const p of PREFIX) for (const rf of Object.values(RENDER)) for (const s of SUFFIX) {
        const nameOf = (n) => `${p}${rf(n)}${s}`
        const mineF = node(nameOf(own))
        const otherF = node(nameOf(foreign))
        const c = dp(own)
        const rOwn = run({ ...c, signalLink: urlOf(mineF) }, [mineF, otherF])
        const rWrong = run({ ...c, signalLink: urlOf(otherF) }, [mineF, otherF])
        const rNone = run(c, [mineF, otherF])
        const score = (r, f) => r.candidates.find((x) => x.nodeId === f.nodeId)?.score ?? -1
        const dsMarked = isDsFolder(nameOf(own))
        total.cases++
        if (rWrong.state === 'verified') { total.stale++; bad.push(`чужая «${nameOf(foreign)}» → ${label(rWrong)}`) }
        if (rOwn.state === 'conflict') { total.falseConflict++; bad.push(`своя «${nameOf(own)}» → ${label(rOwn)}`) }
        if (!dsMarked && label(rOwn) !== 'verified:existing_url') { total.ownNotVerified++; bad.push(`своя «${nameOf(own)}» → ${label(rOwn)}`) }
        if (!dsMarked && score(rNone, mineF) < 0) { total.blind++; bad.push(`своя «${nameOf(own)}» не предложена`) }
        if (score(rNone, otherF) >= 0 && score(rNone, otherF) >= score(rNone, mineF)) { total.tie++; bad.push(`чужая «${nameOf(foreign)}» не ниже своей`) }
        if (dsMarked) assert.equal(label(rOwn), 'attention:kind_mismatch', nameOf(own))
      }
      assert.equal(total.cases, PREFIX.length * Object.keys(RENDER).length * SUFFIX.length)
      assert.deepEqual({ ...total, cases: 0 }, { cases: 0, stale: 0, falseConflict: 0, ownNotVerified: 0, blind: 0, tie: 0 }, bad.slice(0, 10).join('\n'))
    })
  }
})

describe('Устойчивость: порядок узлов, странные значения, время', () => {
  let s = 424242
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const shuffle = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }

  it('порядок узлов не влияет на ответ (2000 случаев)', () => {
    const nums = ['ПРИМ-ДП-26-001', 'ПРИМ-ДП-26-002', 'СУ2-ПРИМ14-0215', 'СУ10-ВЭЙВ-СП-Э1-25', '15/21-СМР']
    const wraps = ['{n}', 'ДП №{n}', 'Договор № {n} от 12.03.2026 ООО Альфа', '{n} Альфа', 'ДС 1 к {n}', 'ДС №3', 'Альфа', 'Ромашка корп.14']
    let diffs = 0
    for (let i = 0; i < 2000; i++) {
      const c = dp(pick(nums), { counterparties: [{ id: CP1, name: pick(['ООО «Альфа»', 'ООО Ромашка']), inn: null }] })
      const nodes = Array.from({ length: 3 + Math.floor(rnd() * 8) }, () => node(pick(wraps).replace('{n}', pick(nums))))
      if (JSON.stringify(run(c, nodes)) !== JSON.stringify(run(c, shuffle(nodes)))) diffs++
    }
    assert.equal(diffs, 0)
  })

  it('странные значения полей не бросают исключений', () => {
    const weird = [null, undefined, '', ' ', 0, 1, true, {}, [], 'x'.repeat(5000), '\ud800', '\udc00a', '№', '\u0000', '😀', 'ДС', 'доп', '.', '-', '/', 'а.', 'ДС.-', 'корп.', 'к№', 'очередь IIII', '9'.repeat(400),
      'ДП-26-', 'ДП 99 999999', 'ПРИМ-ДП-26-0', 'Д/С', 'ДС №', 'ДП ' + '-'.repeat(900), '1'.repeat(30) + '-ДП-26-001']
    const w = () => pick(weird)
    let thrown = 0
    for (let i = 0; i < 6000; i++) {
      const contract = { id: pick([null, 'x', CP1]), recordType: pick(['dp', 'ds_vor', undefined, null, 5]), number: w(), numberKey: pick([undefined, null, w()]), objectId: pick([OBJ_A, null, w()]),
        signalLink: w(), deleted: pick([false, 0, null]), counterparties: pick([[], [{ name: w(), inn: w() }], [null], [{}], null, 'x']),
        family: pick([undefined, null, {}, { dp: null }, { dp: { numberKey: w(), number: w(), objectId: w(), signalLink: w() }, cycle: false }, { dp: {}, cycle: true }]),
        candidates: pick([undefined, null, [], [null], [{ nodeId: w() }], 'x']), state: pick([undefined, null, {}, { state: w(), nodeId: w() }]), parentId: w(), rootId: w() }
      const nodes = Array.from({ length: Math.floor(rnd() * 4) }, () => pick([null, undefined, 5, {}, { nodeId: w() },
        { nodeId: OBJ_A, name: w(), path: w(), objectPath: w(), pathIds: pick([null, 'x', [w()], [1]]), kind: w(), objectId: pick([OBJ_A, null, w()]), sourceEnabled: true, sourceReady: true, observed: pick([true, false, undefined, w()]), absentNights: w(), deleted: w() }]))
      const objects = pick([undefined, null, [], [null], [{}], [{ id: OBJ_A, name: w(), code: w(), aliases: pick([null, [null], [{}], [{ text: w(), key: w() }], 'x']) }], 'x'])
      for (const f of [
        () => M.matchContract({ ...contract, nodes, objects }, { formats: pick([undefined, null, FORMATS, 'x', [null, 5, FOLDER_URL]]), generation: pick([undefined, 7, '7', null, NaN]) }),
        () => M.evaluateNode({ ...contract, nodes, objects }, w(), { generation: 7 }),
        () => M.nodeQueryFor(contract, { formats: FORMATS }), () => M.nodeKeyOf(pick(nodes) || w()),
        () => M.extractContractReferences(w()), () => M.prepareNode({ name: w(), path: w() }), () => M.contractContextKey(contract),
        () => M.parseSignalUrl(w(), FORMATS), () => M.resolveFamily(contract, pick([new Map(), {}, () => null, null])), () => M.pathFeatures(w()),
      ]) { try { f() } catch (e) { thrown++; if (thrown < 5) console.log('  throw:', e.message) } }
    }
    assert.equal(thrown, 0)
  })

  it('5000 узлов (старый вид, схема, 200 сторон) — каждый расчёт быстрее секунды', () => {
    const t = (f) => { const t0 = process.hrtime.bigint(); f(); return Number(process.hrtime.bigint() - t0) / 1e6 }
    const a = Array.from({ length: 5000 }, (_, i) => node(`ДП №СУ2-ПРИМ14-${String(i).padStart(4, '0')} ООО Альфа корп.14`))
    const b = Array.from({ length: 5000 }, (_, i) => node(`ПРИМ-ДП-26-${String(i + 1).padStart(3, '0')} ООО Ромашка`))
    const parties = Array.from({ length: 200 }, (_, i) => ({ id: `${'e'.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `ООО Контрагент Номер ${i} Строй`, inn: null }))
    const times = [t(() => run(dp('СУ2-ПРИМ14-0215'), a)), t(() => run(dp('ПРИМ-ДП-26-001'), b)), t(() => run(dp('СУ2-ПРИМ14-0215', { counterparties: parties }), a.slice(0, 2000)))]
    assert.ok(times.every((x) => x < 1000), times.join(' / '))
  })

  it('без квадратичного взрыва: длинные хвосты пробелов, дефисов и цифр в названии и пути', () => {
    const ms = (f) => { const t0 = process.hrtime.bigint(); f(); return Number(process.hrtime.bigint() - t0) / 1e6 }
    const toxic = [`корп${' '.repeat(4000)}x`, `ДП${' -'.repeat(450)}`, `ПРИМ${'-'.repeat(900)}ДП-26-001`, `ДС${' '.repeat(900)}`, `${'1,'.repeat(450)}`,
      `Корпус ${'14 и '.repeat(200)}`, `${'ПРИМ-'.repeat(190)}ДП-26-001`, 'К'.repeat(900) + ' 1']
    for (const text of toxic) {
      assert.ok(ms(() => { M.extractContractReferences(text); M.pathFeatures(text); M.prepareNode({ name: text, path: text }) }) < 200, text.slice(0, 20))
    }
    const parentPath = Array.from({ length: 7 }, () => `корп${' '.repeat(985)}-`).join(' / ')
    const nodes = Array.from({ length: 300 }, (_, i) => node(`ДП №СУ2-ПРИМ14-${String(i).padStart(4, '0')}`, { parentPath }))
    assert.ok(ms(() => { for (const n of nodes) M.prepareNode({ name: n.name, path: n.path }) }) < 500)
  })
})
