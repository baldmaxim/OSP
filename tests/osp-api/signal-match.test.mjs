// Сопоставитель договоров ОСП с папками Signal (server/osp-api/src/lib/signalMatch.js): чистые функции, без базы и сети.
// Проверяем: разбор и сборку ссылок по форматам; номера в названиях файлов и папок; признаки корпуса/очереди; границу объекта
// (узел чужого или неназначенного объекта — никогда не кандидат, а при введённой ссылке — без чужих id); семью ДС;
// отказы и отвязку; ночные пропуски; детерминизм. Данные — только синтетика (вымышленные объекты, договоры, uuid …-4000-8000-…).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  STATES, REASONS, STATE_REASONS, MATCH_REASONS, MATCH_FLAGS,
  parseSignalUrl, parseUrlFormats, buildSignalUrl, validateUrlTemplate,
  extractContractReferences, hasAmbiguousNumbers, legacyKey, pathFeatures, objectFeatures, prepareNode, objectTerms,
  contractContextKey, contractFingerprint, resolveFamily, matchContract, evaluateNode, nodeQueryFor,
} from '../../server/osp-api/src/lib/signalMatch.js'
import { numberKey } from '../../server/osp-api/src/shared/contractNumbering.js'
import { normMatchName } from '../../server/osp-api/src/shared/matchName.js'
import { normMatchName as normMatchNameSite } from '../../src/utils/matchName.js'
import fs from 'node:fs'

const id = (prefix, n) => `${prefix.repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`
const PROJECT = id('a', 1)
const OBJ_A = id('b', 1)
const OBJ_B = id('b', 2)
const OBJ_C = id('b', 3)
const CP1 = id('e', 1)
const CP2 = id('e', 2)

const FOLDER_URL = 'https://signal.example.test/projects/{projectId}/folders/{folderId}'
const FILE_URL = 'https://signal.example.test/projects/{projectId}/files/{itemId}'
const FORMATS = [FOLDER_URL, FILE_URL]

const OBJECTS = [
  { id: OBJ_A, name: 'ЖК Тестовый, корп. 14', code: 'АЛИЯ', aliases: [] },
  { id: OBJ_B, name: 'ЖК Другой', code: 'ЗИЛ', aliases: [] },
  { id: OBJ_C, name: 'Омега', code: null, aliases: [] },
]

let seq = 0
const node = (name, extra = {}) => {
  const nodeId = extra.nodeId || id('c', ++seq)
  const parentPath = extra.parentPath ?? 'Проект / Тестовый'
  return {
    nodeId, projectId: PROJECT, sourceId: 1, kind: 'folder', parentId: null, name,
    path: extra.path ?? `${parentPath} / ${name}`, pathIds: [], objectId: OBJ_A, numberKeys: [], features: {}, nameNorm: '',
    observed: true, absentNights: 0, deleted: false, sourceEnabled: true, sourceReady: true,
    itemType: null, versionNumber: null, modifiedAt: null, ...extra, parentPath: undefined,
  }
}
const child = (parent, name, extra = {}) => node(name, {
  parentPath: parent.path, pathIds: [...parent.pathIds, parent.nodeId], parentId: parent.nodeId, ...extra,
})
const urlOf = (n) => buildSignalUrl(FOLDER_URL, { projectId: n.projectId, nodeId: n.nodeId })
const fileUrlOf = (n) => buildSignalUrl(FILE_URL, { projectId: n.projectId, nodeId: n.nodeId })

const dpContract = (extra = {}) => ({
  id: id('d', 1), recordType: 'dp', number: 'АЛИЯ-ДП-26-001', numberKey: 'АЛИЯ|2026|1', date: '2026-02-01', objectId: OBJ_A,
  parentId: null, rootId: null, signalLink: null, deleted: false,
  counterparties: [{ id: CP1, name: 'ООО «Ромашка»', inn: null }],
  family: { dp: null, cycle: false }, candidates: [], revision: 1, stateVersion: 0, state: null, ...extra,
})
const dsContract = (dp, extra = {}) => ({
  ...dpContract({ id: id('d', 2), recordType: 'ds_vor', number: 'ДС №3', numberKey: null, parentId: dp.id, rootId: dp.id }),
  family: { dp: { id: dp.id, number: dp.number, numberKey: dp.numberKey, objectId: dp.objectId, signalLink: dp.signalLink, nodeId: null }, cycle: false },
  ...extra,
})

const GEN = 7
const run = (contract, nodes, extra = {}, opts = {}) => {
  const res = matchContract({ ...contract, nodes, objects: OBJECTS, ...extra }, { formats: FORMATS, generation: GEN, ...opts })
  assertInvariants(contract, nodes, res)
  return res
}

// Инварианты каждого ответа: пара state:reason из таблицы; скрытые причины не выдают узел; кандидат всегда из границы объекта.
function assertInvariants(contract, nodes, res) {
  assert.ok(STATE_REASONS[res.state]?.includes(res.reason), `${res.state}:${res.reason} вне таблицы`)
  assert.ok(STATES[res.state] && REASONS[res.reason])
  if (['unsupported_url', 'outside_roots', 'root_disabled', 'not_in_snapshot', 'no_snapshot', 'object_unassigned'].includes(res.reason)) {
    assert.equal(res.nodeId, null, `${res.reason}: узел не выдаётся`)
  }
  for (const c of res.candidates) {
    const n = nodes.find((x) => x.nodeId === c.nodeId)
    assert.ok(n, 'кандидат не из переданных узлов')
    assert.equal(n.objectId, contract.objectId, 'кандидат вне объекта договора')
    assert.equal(n.kind, 'folder')
    assert.ok(n.observed && n.sourceEnabled && n.sourceReady)
    for (const r of c.reasons) assert.ok(MATCH_REASONS[r], r)
    for (const f of c.flags) assert.ok(MATCH_FLAGS[f], f)
  }
  assert.match(res.fingerprint, /^[0-9a-f]{32}$/)
  assert.match(res.ctxKey, /^[0-9a-f]{32}$/)
}

describe('signalMatch: разбор ссылок', () => {
  const N = id('c', 900)
  const goodUrl = `https://signal.example.test/projects/${PROJECT}/folders/${N}`

  it('папка и файл по шаблонам; query, fragment и косая черта в конце не мешают; uuid приводятся к нижнему регистру', () => {
    assert.deepEqual(parseSignalUrl(goodUrl, FORMATS), { ok: true, projectId: PROJECT, nodeId: N, kind: 'folder' })
    assert.deepEqual(parseSignalUrl(`  ${goodUrl}/?tab=files&x=1#top  `, FORMATS), { ok: true, projectId: PROJECT, nodeId: N, kind: 'folder' })
    assert.deepEqual(parseSignalUrl(`https://SIGNAL.example.test/projects/${PROJECT.toUpperCase()}/files/${N.toUpperCase()}`, FORMATS),
      { ok: true, projectId: PROJECT, nodeId: N, kind: 'item' })
    // стандартный порт 443 браузер молча отбрасывает — это не «нестандартный порт»
    assert.equal(parseSignalUrl(`https://signal.example.test:443/projects/${PROJECT}/folders/${N}`, FORMATS).ok, true)
  })

  it('пусто → empty; всё остальное неподходящее → unsupported_url (без сети)', () => {
    for (const v of [null, undefined, '', '   ']) assert.deepEqual(parseSignalUrl(v, FORMATS), { ok: false, reason: 'empty' })
    const bad = [
      goodUrl.replace('https:', 'http:'),
      `https://user@signal.example.test/projects/${PROJECT}/folders/${N}`,
      `https://user:pw@signal.example.test/projects/${PROJECT}/folders/${N}`,
      `https://@signal.example.test/projects/${PROJECT}/folders/${N}`,
      `https://signal.example.test:8443/projects/${PROJECT}/folders/${N}`,
      `https://signal.example.test.evil.test/projects/${PROJECT}/folders/${N}`,
      `https://evil-signal.example.test/projects/${PROJECT}/folders/${N}`,
      `https://www.signal.example.test/projects/${PROJECT}/folders/${N}`,
      `https://signal.example.test./projects/${PROJECT}/folders/${N}`,
      `https://signal.example.test/projects/${PROJECT}/folders/not-a-uuid`,
      `https://signal.example.test/projects/${PROJECT}/folders/${N}/extra`,
      `https://signal.example.test/projects/${PROJECT}/other/${N}`,
      `https://signal.example.test//projects/${PROJECT}/folders/${N}`,
      `https://signal.example.test/projects/${PROJECT}/folders/${N} x`,
      `https://signal.example.test/projects\\${PROJECT}/folders/${N}`,
      `https://signal.example.test/projects/${PROJECT}/folders/${N.slice(0, -1)}`,
      'javascript:alert(1)', 'ftp://signal.example.test/', 'не ссылка', 42, {},
    ]
    for (const v of bad) assert.deepEqual(parseSignalUrl(v, FORMATS), { ok: false, reason: 'unsupported_url' }, String(v))
    assert.deepEqual(parseSignalUrl(goodUrl, []), { ok: false, reason: 'unsupported_url' })
    assert.deepEqual(parseSignalUrl(goodUrl, null), { ok: false, reason: 'unsupported_url' })
    assert.deepEqual(parseSignalUrl(goodUrl, ['https://signal.example.test/{projectId}']), { ok: false, reason: 'unsupported_url' })
    assert.deepEqual(parseSignalUrl(`${goodUrl}${'a'.repeat(2100)}`, FORMATS), { ok: false, reason: 'unsupported_url' })
  })

  it('формат с параметрами запроса и фрагментом: именованные части обязательны, лишние игнорируются', () => {
    const q = 'https://signal.example.test/view?project={projectId}&folder={folderId}&mode=docs'
    const f = 'https://signal.example.test/app#/p/{projectId}/f/{folderId}'
    assert.deepEqual(parseSignalUrl(`https://signal.example.test/view?mode=docs&folder=${N}&project=${PROJECT}&z=1`, [q]),
      { ok: true, projectId: PROJECT, nodeId: N, kind: 'folder' })
    assert.equal(parseSignalUrl(`https://signal.example.test/view?project=${PROJECT}&folder=${N}`, [q]).ok, false, 'нет mode=docs')
    assert.equal(parseSignalUrl(`https://signal.example.test/view?project=${PROJECT}&folder=${N}&folder=${id('c', 901)}&mode=docs`, [q]).ok, false, 'два значения')
    assert.equal(parseSignalUrl(`https://signal.example.test/view?project=${PROJECT}&mode=docs`, [q]).ok, false)
    assert.deepEqual(parseSignalUrl(`https://signal.example.test/app#/p/${PROJECT}/f/${N}`, [f]), { ok: true, projectId: PROJECT, nodeId: N, kind: 'folder' })
    assert.equal(parseSignalUrl(`https://signal.example.test/app`, [f]).ok, false)
    assert.equal(parseSignalUrl(`https://signal.example.test/app#/p/${PROJECT}/g/${N}`, [f]).ok, false)
  })

  it('два формата, давшие разные узлы, — неоднозначность, а не выбор первого', () => {
    const a = 'https://signal.example.test/x/{projectId}/{folderId}'
    const b = 'https://signal.example.test/x/{folderId}/{projectId}'
    const r = parseSignalUrl(`https://signal.example.test/x/${PROJECT}/${N}`, [a, b])
    assert.deepEqual(r, { ok: false, reason: 'unsupported_url' })
    assert.equal(parseSignalUrl(`https://signal.example.test/x/${PROJECT}/${N}`, [a]).ok, true)
    // один и тот же узел двумя форматами — не конфликт
    assert.equal(parseSignalUrl(`https://signal.example.test/x/${PROJECT}/${N}`, [a, 'https://signal.example.test/x/{projectId}/{folderId}/']).ok, true)
  })

  it('parseUrlFormats: «;»-список; негодные шаблоны отбрасываются с кодом причины', () => {
    const text = ` ${FOLDER_URL} ; ;${FILE_URL};${FOLDER_URL};http://signal.example.test/{projectId}/{folderId};`
      + 'https://u@signal.example.test/{projectId}/{folderId};https://signal.example.test:81/{projectId}/{folderId};'
      + 'https://*.example.test/{projectId}/{folderId};https://signal.example.test/{projectId}/a-{folderId};'
      + 'https://signal.example.test/{projectId}/{projectId}/{folderId};https://signal.example.test/{projectId};'
      + 'https://signal.example.test/{folderId};https://signal.example.test/{projectId}/{folderId}/{itemId}'
    const { formats, errors } = parseUrlFormats(text)
    assert.deepEqual(formats, [FOLDER_URL, FILE_URL])
    assert.deepEqual(errors.map((e) => e.reason), ['not_https', 'userinfo', 'port', 'bad_host', 'bad_placeholder', 'duplicate_placeholder', 'no_node', 'no_project', 'duplicate_placeholder'])
    assert.deepEqual(parseUrlFormats('').formats, [])
    assert.deepEqual(parseUrlFormats(undefined), { formats: [], errors: [] })
    const many = Array.from({ length: 12 }, (_, i) => `https://h${i}.example.test/{projectId}/{folderId}`).join(';')
    const r = parseUrlFormats(many)
    assert.equal(r.formats.length, 10)
    assert.deepEqual(r.errors.map((e) => e.reason), ['too_many'])
    assert.deepEqual(validateUrlTemplate(FILE_URL), { ok: true, kind: 'item' })
    assert.deepEqual(validateUrlTemplate(''), { ok: false, reason: 'empty' })
  })

  it('buildSignalUrl — обратная операция: результат разбирается тем же шаблоном', () => {
    const templates = [FOLDER_URL, FILE_URL, 'https://signal.example.test/view?project={projectId}&folder={folderId}&mode=docs',
      'https://signal.example.test/app#/p/{projectId}/f/{folderId}', 'https://signal.example.test/app#p/{projectId}/f/{itemId}',
      'https://signal.example.test/{folderId}/{projectId}/']
    for (const t of templates) {
      const url = buildSignalUrl(t, { projectId: PROJECT, nodeId: N })
      assert.ok(url, t)
      const kind = t.includes('{itemId}') ? 'item' : 'folder'
      assert.deepEqual(parseSignalUrl(url, [t]), { ok: true, projectId: PROJECT, nodeId: N, kind }, t)
    }
    assert.equal(buildSignalUrl(FOLDER_URL, { projectId: PROJECT.toUpperCase(), nodeId: N }), goodUrl)
    assert.equal(buildSignalUrl(FOLDER_URL, { projectId: 'x', nodeId: N }), null)
    assert.equal(buildSignalUrl(FOLDER_URL, { projectId: PROJECT }), null)
    assert.equal(buildSignalUrl('http://signal.example.test/{projectId}/{folderId}', { projectId: PROJECT, nodeId: N }), null)
    assert.equal(buildSignalUrl(FOLDER_URL, { projectId: PROJECT, nodeId: N, kind: 'item' }), null)
    assert.equal(buildSignalUrl(FILE_URL, { projectId: PROJECT, nodeId: N, kind: 'item' })?.includes('/files/'), true)
    assert.equal(buildSignalUrl(null, { projectId: PROJECT, nodeId: N }), null)
  })
})

describe('signalMatch: номера в названиях файлов и папок', () => {
  const keys = (name) => extractContractReferences(name).map((r) => r.key)

  it('ключ по схеме равен numberKey (SQL contract_number_key) и берётся с токена, а не с целого имени файла', () => {
    assert.equal(numberKey('АЛИЯ-ДП-26-001'), 'АЛИЯ|2026|1')
    for (const name of ['АЛИЯ-ДП-26-001', ' алия-дп-26-1 ', 'ДП №АЛИЯ-ДП-26-001', 'ДП № АЛИЯ-ДП-26-001', 'ДП_АЛИЯ-ДП-26-001.pdf',
      'ДП_АЛИЯ-ДП-26-001_скан.PDF', 'Договор подряда АЛИЯ-ДП-26-001 от 01.02.2026.docx', '(АЛИЯ-ДП-26-001)', 'ДП-АЛИЯ-ДП-26-001.v2.pdf',
      'ДП N АЛИЯ-ДП-26-001', 'AЛИЯ-ДП-26-001', 'ДП АЛИЯ-ДП-26-001, подрядчик Ромашка']) {
      assert.deepEqual(keys(name), ['АЛИЯ|2026|1'], name)
    }
    assert.deepEqual(extractContractReferences('ДП_АЛИЯ-ДП-26-001.pdf'), [{ raw: 'АЛИЯ-ДП-26-001', key: 'АЛИЯ|2026|1', scheme: true, ds: false }])
    assert.deepEqual(keys('ЗИЛ18-19-27-ДП-27-012'), ['ЗИЛ18-19-27|2027|12'])
    // целое имя файла якорной функции не подходит — токен берётся из середины
    assert.equal(numberKey('ДП_АЛИЯ-ДП-26-001.pdf'), null)
  })

  it('два разных номера в названии — неоднозначность, ни один не выбирается первым', () => {
    for (const name of ['АЛИЯ-ДП-26-001 и АЛИЯ-ДП-26-002', 'ДП_АЛИЯ-ДП-26-001_ДП_АЛИЯ-ДП-26-002.pdf', 'АЛИЯ-ДП-26-001/АЛИЯ-ДП-26-002']) {
      const refs = extractContractReferences(name)
      assert.equal(refs.filter((r) => r.scheme).length, 2, name)
      assert.equal(hasAmbiguousNumbers(refs), true, name)
    }
    // тот же номер дважды — один ключ, неоднозначности нет
    assert.equal(hasAmbiguousNumbers(extractContractReferences('АЛИЯ-ДП-26-001 (копия АЛИЯ-ДП-26-001).pdf')), false)
    assert.equal(hasAmbiguousNumbers(extractContractReferences('Договор.pdf')), false)
  })

  it('номер не по схеме — безопасная нормализация только после явной приставки или как единственный токен; не по схеме не равно номеру ДП', () => {
    assert.equal(numberKey('СУ10-ВЭЙВ-СП-Э1-25'), null)
    assert.deepEqual(extractContractReferences('ДП №СУ10-ВЭЙВ-СП-Э1-25'), [{ raw: 'СУ10-ВЭЙВ-СП-Э1-25', key: 'СУ10-ВЭЙВ-СП-Э1-25', scheme: false, ds: false }])
    assert.deepEqual(keys('СУ10-ВЭЙВ-СП-Э1-25.pdf'), ['СУ10-ВЭЙВ-СП-Э1-25'])
    assert.deepEqual(keys('Договор № 15 от 01.02.2026.pdf'), ['15'])
    // латинский двойник и разделители — в один ключ
    assert.equal(legacyKey('Cу10-вэйв сп_э1/25'), 'СУ10-ВЭЙВ-СП-Э1-25')
    assert.equal(legacyKey('СУ10-ВЭЙВ-СП-Э1-25'), legacyKey('су10 вэйв сп э1 25'))
    assert.equal(legacyKey('  '), null)
    // обычный текст, даты и признаки — не номера
    assert.deepEqual(keys('Исполнительная документация корп14 v2 01.02.2026'), [])
    assert.deepEqual(keys('Приложение 22 к договору'), [])
    assert.deepEqual(keys(''), [])
    assert.deepEqual(keys(null), [])
  })

  it('номер ДС — отдельный вид ссылки: «ДС 3», «ДС-3», «ДС №3», «Доп. соглашение № 3»; номер ДП рядом не теряется', () => {
    for (const name of ['ДС 3', 'ДС-3', 'ДС №3', 'ДС_3.pdf', 'ДС3', 'Доп. соглашение № 3', 'Доп.соглашение 3', 'дс №3']) {
      assert.deepEqual(extractContractReferences(name), [{ raw: '3', key: 'ДС|3', scheme: false, ds: true }], name)
    }
    assert.deepEqual(keys('ДС 3 к ДП АЛИЯ-ДП-26-001.docx'), ['ДС|3', 'АЛИЯ|2026|1'])
    assert.deepEqual(extractContractReferences('ДС 2-1').map((r) => r.key), ['ДС|2-1'])
  })
})

describe('signalMatch: признаки корпуса, очереди, секции', () => {
  it('корп.14, к.14, корпус 14, bldg 14, building 14 — один признак; очередь и секция — свои типы', () => {
    for (const t of ['корп.14', 'Корп. 14', 'к.14', 'К.14', 'к14', 'корпус 14', 'Корпус №14', 'bldg 14', 'BLDG.14', 'building 14', 'Дом / корп.14 / Договор']) {
      assert.deepEqual(pathFeatures(t).building, ['14'], t)
    }
    assert.deepEqual(pathFeatures('очередь 2 / оч.2'), { building: [], queue: ['2'], section: [] })
    assert.deepEqual(pathFeatures('очередь II').queue, ['2'])
    assert.deepEqual(pathFeatures('секция 3 / секц.4').section, ['3', '4'])
    assert.deepEqual(pathFeatures('корп. 14а')?.building, ['14а'])
    assert.deepEqual(pathFeatures('корп. 14a').building, pathFeatures('корп. 14а').building, 'латиница-двойник')
    assert.deepEqual(pathFeatures('корп.14-1').building, ['14.1'])
  })

  it('годы, версии, номера приложений, номера договоров не признаки; «к» без точки — предлог', () => {
    for (const t of ['Приложение 22', 'прил.14', 'v14', 'v2.0', 'ред. 14', '2026', 'ДП 14', 'ДС 22', 'АЛИЯ-ДП-26-001', 'к договору 14', 'к 14', 'версия 3.0',
      'корпорация 14', 'ск.14', 'к.2026', '01.02.2026', 'листов 14']) {
      assert.deepEqual(pathFeatures(t), { building: [], queue: [], section: [] }, t)
    }
  })

  it('признаки объекта — по названию и коду; prepareNode хранит только непустые типы', () => {
    assert.deepEqual(objectFeatures('ЖК Тестовый, корп. 14', 'АЛИЯ'), { building: ['14'], queue: [], section: [] })
    assert.deepEqual(objectFeatures('Дом', null), { building: [], queue: [], section: [] })
    const p = prepareNode({ name: 'ДП АЛИЯ-ДП-26-001', path: 'Проект / Корпус 14 / ДП АЛИЯ-ДП-26-001', kind: 'folder' })
    assert.deepEqual(p, { nameNorm: 'дп алия-дп-26-001', numberKeys: ['АЛИЯ|2026|1'], features: { building: ['14'] } })
    assert.deepEqual(prepareNode({ name: 'Прочее', path: '', kind: 'item' }), { nameNorm: 'прочее', numberKeys: [], features: {} })
  })

  it('normMatchName на сервере (копия) и на сайте — одна функция', () => {
    for (const s of ['ООО «Ромашка»', ' Ёлка  "тест" ', null, undefined, 'a`b']) assert.equal(normMatchName(s), normMatchNameSite(s))
    assert.equal(normMatchName('ООО «Ёлка»'), 'ооо елка')
    // импорт договоров берёт ту же функцию из matchName.js и по-прежнему её экспортирует (проверка поведения — tests/contracts)
    const imp = fs.readFileSync(new URL('../../src/utils/contractsImport.js', import.meta.url), 'utf8')
    assert.match(imp, /import \{ normMatchName \} from '\.\/matchName'/)
    assert.match(imp, /export \{ normMatchName \}/)
    assert.doesNotMatch(imp, /function normMatchName/)
  })
})

describe('signalMatch: контекст и отпечаток', () => {
  const base = dpContract({ counterparties: [{ id: CP1, name: 'А' }, { id: CP2, name: 'Б' }] })

  it('контекст устойчив к порядку сторон, имён, дат и ссылке; меняется от деловых признаков', () => {
    const k = contractContextKey(base)
    assert.match(k, /^[0-9a-f]{32}$/)
    assert.equal(contractContextKey({ ...base, counterparties: [{ id: CP2, name: 'другое имя' }, { id: CP1 }] }), k)
    assert.equal(contractContextKey({ ...base, date: '2030-01-01', signalLink: 'https://x.test/', stateVersion: 9, revision: 5 }), k)
    assert.equal(contractContextKey({ ...base, number: ' алия-дп-26-1 ', numberKey: 'АЛИЯ|2026|1' }), k, 'ключ номера, а не его написание')
    for (const change of [{ numberKey: 'АЛИЯ|2026|2', number: 'АЛИЯ-ДП-26-002' }, { objectId: OBJ_B }, { recordType: 'ds_vor' }, { rootId: id('d', 9) },
      { counterparties: [{ id: CP1 }] }, { counterparties: [{ id: CP1 }, { id: CP2 }, { id: id('e', 3) }] }]) {
      assert.notEqual(contractContextKey({ ...base, ...change }), k, JSON.stringify(change))
    }
  })

  it('номер не по схеме входит в контекст нормализованным', () => {
    const a = contractContextKey({ ...base, number: 'П-15/26', numberKey: null })
    assert.equal(contractContextKey({ ...base, number: 'п 15 26', numberKey: null }), a)
    assert.notEqual(contractContextKey({ ...base, number: 'П-16/26', numberKey: null }), a)
  })

  it('отпечаток = контекст + ссылка: ссылка меняет отпечаток, но не контекст', () => {
    const f0 = contractFingerprint(base)
    const f1 = contractFingerprint({ ...base, signalLink: 'https://signal.example.test/p' })
    assert.notEqual(f0, f1)
    assert.equal(contractFingerprint({ ...base, signalLink: ' ' }), f0, 'пустая ссылка = нет ссылки')
    assert.equal(contractFingerprint({ ...base, signalLink: null }), f0)
    assert.notEqual(contractFingerprint({ ...base, objectId: OBJ_B }), f0)
    assert.equal(contractContextKey({ ...base, signalLink: 'https://signal.example.test/p' }), contractContextKey(base))
  })
})

describe('signalMatch: семья ДС', () => {
  const dp = { id: id('d', 1), recordType: 'dp', number: 'АЛИЯ-ДП-26-001', objectId: OBJ_A, signalLink: null, nodeId: null }
  const ds1 = { id: id('d', 2), recordType: 'ds_vor', parentId: dp.id, rootId: dp.id, objectId: OBJ_A }
  const ds2 = { id: id('d', 3), recordType: 'ds_extra', parentId: ds1.id, rootId: dp.id, objectId: OBJ_A }

  it('корневой ДП — по root_contract_id; резерв — цепочка parent_contract_id', () => {
    const all = new Map([dp, ds1, ds2].map((c) => [c.id, c]))
    assert.equal(resolveFamily(ds2, all).dp.id, dp.id)
    assert.equal(resolveFamily(ds2, all).dp.numberKey, 'АЛИЯ|2026|1')
    // без root: ДС → ДС → ДП
    assert.equal(resolveFamily({ ...ds2, rootId: null }, all).dp.id, dp.id)
    // корень указан, но не загружен — цепочка
    assert.equal(resolveFamily({ ...ds2, rootId: id('d', 77) }, all).dp.id, dp.id)
    // сам ДП
    assert.equal(resolveFamily(dp, all).dp.id, dp.id)
    // объект и функция вместо Map
    assert.equal(resolveFamily(ds1, { [dp.id]: dp }).dp.id, dp.id)
    assert.equal(resolveFamily(ds1, (x) => (x === dp.id ? dp : undefined)).dp.id, dp.id)
    assert.deepEqual(resolveFamily(ds1, undefined), { dp: null, cycle: false })
  })

  it('цикл parent_contract_id не зацикливает и помечается; обрыв и длинная цепочка — «неизвестно»', () => {
    const a = { id: id('d', 11), recordType: 'ds_vor', parentId: id('d', 12) }
    const b = { id: id('d', 12), recordType: 'ds_vor', parentId: id('d', 13) }
    const c = { id: id('d', 13), recordType: 'ds_vor', parentId: id('d', 11) }
    const all = new Map([a, b, c].map((x) => [x.id, x]))
    assert.deepEqual(resolveFamily(a, all), { dp: null, cycle: true })
    assert.deepEqual(resolveFamily({ id: id('d', 20), recordType: 'ds_vor', parentId: id('d', 99) }, all), { dp: null, cycle: false })
    assert.deepEqual(resolveFamily({ id: id('d', 21), recordType: 'ds_vor', parentId: id('d', 21) }, all), { dp: null, cycle: true })
    const long = new Map()
    let prev = dp
    long.set(dp.id, dp)
    for (let i = 0; i < 12; i++) {
      const cur = { id: id('f', i + 1), recordType: 'ds_vor', parentId: prev.id }
      long.set(cur.id, cur)
      prev = cur
    }
    assert.equal(resolveFamily(prev, long).dp, null, 'цепочка длиннее 10 шагов')
  })

  it('matchContract без family берёт семью из contractsById и не зацикливается на циклах', () => {
    const a = { id: id('d', 11), recordType: 'ds_vor', parentId: id('d', 12), objectId: OBJ_A, number: 'ДС 1', counterparties: [] }
    const b = { id: id('d', 12), recordType: 'ds_vor', parentId: id('d', 11), objectId: OBJ_A }
    const r = matchContract({ ...a, contractsById: new Map([[a.id, a], [b.id, b]]), nodes: [], objects: OBJECTS }, { formats: FORMATS, generation: GEN })
    assert.deepEqual([r.state, r.reason], ['none', 'none'])
  })
})

describe('signalMatch: пустая ссылка — none / suggested', () => {
  it('нет узлов или ничего подходящего → none:none; без объекта и удалённый договор — тоже', () => {
    assert.deepEqual(run(dpContract(), []).candidates, [])
    const r = run(dpContract(), [node('Другая папка'), node('Прочее')])
    assert.deepEqual([r.state, r.reason, r.nodeId], ['none', 'none', null])
    assert.equal(run(dpContract({ objectId: null }), [node('ДП АЛИЯ-ДП-26-001')]).state, 'none')
    const del = run(dpContract({ deleted: true }), [node('ДП АЛИЯ-ДП-26-001')])
    assert.deepEqual([del.state, del.reason, del.candidates.length], ['none', 'none', 0])
  })

  it('номер ДП в названии папки — сильный кандидат; регистр, «ДП №», подчёркивания, расширения не важны', () => {
    for (const name of ['ДП АЛИЯ-ДП-26-001', 'алия-дп-26-1', 'ДП_АЛИЯ-ДП-26-001', 'ДП №АЛИЯ-ДП-26-001 (подписан)', 'Договор АЛИЯ-ДП-26-001.pdf']) {
      const n = node(name)
      const r = run(dpContract(), [n, node('Прочее')])
      assert.equal(r.state, 'suggested', name)
      assert.equal(r.reason, 'candidates')
      assert.equal(r.nodeId, null, 'предложение не выбирает узел')
      assert.equal(r.candidates.length, 1)
      assert.equal(r.candidates[0].nodeId, n.nodeId)
      assert.ok(r.candidates[0].reasons.includes('number'))
      assert.ok(r.candidates[0].score >= 100)
    }
  })

  it('номер другого ДП того же объекта не предлагается; два разных номера в имени — не кандидат; один номер дважды — кандидат', () => {
    assert.equal(run(dpContract(), [node('ДП АЛИЯ-ДП-26-002')]).state, 'none')
    assert.equal(run(dpContract(), [node('АЛИЯ-ДП-26-001 и АЛИЯ-ДП-26-002')]).state, 'none')
    assert.equal(run(dpContract(), [node('АЛИЯ-ДП-26-001 (копия АЛИЯ-ДП-26-001)')]).state, 'suggested')
  })

  it('номер ДП → ровно один живой ДП: у удалённого договора кандидатов нет; ДС по номеру ДП не ищется', () => {
    const folder = node('ДП АЛИЯ-ДП-26-001')
    assert.equal(run(dpContract({ deleted: true }), [folder]).candidates.length, 0)
    const ds = dsContract(dpContract(), { number: 'АЛИЯ-ДП-26-001', numberKey: 'АЛИЯ|2026|1' })
    assert.equal(run(ds, [folder]).candidates.length, 0, 'ключ ДП не относится к ДС')
  })

  it('две папки с одним номером — «предложена папка» с выбором из двух; порядок устойчив', () => {
    const a = node('ДП АЛИЯ-ДП-26-001', { parentPath: 'Проект / Б' })
    const b = node('ДП АЛИЯ-ДП-26-001', { parentPath: 'Проект / А' })
    const r1 = run(dpContract(), [a, b])
    const r2 = run(dpContract(), [b, a])
    assert.equal(r1.state, 'suggested')
    assert.equal(r1.candidates.length, 2)
    assert.deepEqual(r1.candidates.map((c) => c.nodeId), [b.nodeId, a.nodeId], 'при равных очках — по пути')
    assert.deepEqual(r1, r2)
  })

  it('слабые признаки: сторона договора, ИНН, транслитерация («похоже») — только предложение; рядом с точным номером не показываются', () => {
    const byName = node('Ромашка')
    const r = run(dpContract(), [byName, node('Сирень')])
    assert.equal(r.state, 'suggested')
    assert.deepEqual(r.candidates.map((c) => [c.nodeId, c.reasons]), [[byName.nodeId, ['counterparty']]])
    assert.ok(r.candidates[0].score < 100)

    const inn = '9901234561'
    const byInn = node(`Подрядчик ИНН ${inn}`)
    const r2 = run(dpContract({ counterparties: [{ id: CP1, name: 'ООО «Сирень»', inn }] }), [byInn, node('Прочее')])
    assert.deepEqual(r2.candidates.map((c) => c.reasons), [['inn']])
    // ИНН с неверной контрольной суммой и ИНН внутри длинного числа не считаются
    assert.equal(run(dpContract({ counterparties: [{ id: CP1, name: 'ООО «Сирень»', inn: '7707083894' }] }), [node('ИНН 7707083894')]).state, 'none')
    assert.equal(run(dpContract({ counterparties: [{ id: CP1, name: 'ООО «Сирень»', inn }] }), [node(`№ 1${inn}9`)]).state, 'none')

    const translit = node('Romashka')
    const r3 = run(dpContract(), [translit])
    assert.deepEqual(r3.candidates.map((c) => [c.reasons, c.flags]), [[['name_similar'], ['similar']]])

    const exact = node('ДП АЛИЯ-ДП-26-001')
    const r4 = run(dpContract(), [byName, exact, translit])
    assert.deepEqual(r4.candidates.map((c) => c.nodeId), [exact.nodeId], 'шум рядом с точным номером не предлагается')
  })

  it('короткое название стороны и форма собственности сами по себе не повод: «ООО» и «ИП» не ищутся', () => {
    assert.equal(run(dpContract({ counterparties: [{ id: CP1, name: 'ООО «АБ»' }] }), [node('АБ'), node('ООО')]).state, 'none')
    assert.equal(run(dpContract({ counterparties: [{ id: CP1, name: 'ИП Ромашка' }] }), [node('ИП')]).state, 'none')
  })

  it('номер старого вида: папка с этим номером — кандидат (не короткие и не «б/н»)', () => {
    const c = dpContract({ number: 'СУ10-ВЭЙВ-СП-Э1-25', numberKey: null })
    const n = node('Договор СУ10 ВЭЙВ СП Э1 25 от 01.02.2025')
    const r = run(c, [n, node('Договор СУ10 ВЭЙВ СП Э1')])
    assert.deepEqual(r.candidates.map((x) => [x.nodeId, x.reasons]), [[n.nodeId, ['number_legacy']]])
    const short = dpContract({ number: 'Т-7', numberKey: null, counterparties: [] })
    assert.equal(run(short, [node('Т-7'), node('Папка Т 7')]).state, 'none', 'слишком короткий номер для поиска по названию')
    assert.equal(run(dpContract({ number: 'Б/Н-1', numberKey: null, counterparties: [] }), [node('Б Н 1')]).state, 'none')
  })

  it('синоним объекта и название объекта усиливают кандидата, но сами кандидата не создают', () => {
    const objects = OBJECTS.map((o) => (o.id === OBJ_A ? { ...o, aliases: [{ text: 'Алия-Парк', key: 'алия-парк' }] } : o))
    const n = node('Алия-Парк / Ромашка')
    const only = node('Алия-Парк / Прочее')
    const res = matchContract({ ...dpContract(), nodes: [n, only], objects }, { formats: FORMATS, generation: GEN })
    assert.deepEqual(res.candidates.map((c) => [c.nodeId, c.reasons]), [[n.nodeId, ['counterparty', 'object_name']]])
  })

  it('синоним, совпавший с именем или кодом другого объекта, игнорируется', () => {
    const own = { id: OBJ_A, name: 'ЖК Тестовый', code: 'АЛИЯ', aliases: [{ text: 'Омега', key: 'омега' }, { text: 'Зилант', key: 'зилант' }, { text: 'ЗИЛ', key: 'зил' }] }
    assert.deepEqual(objectTerms(own, [own, ...OBJECTS.slice(1)]), ['алия', 'жк тестовый', 'зилант'])
    assert.deepEqual(objectTerms({ ...own, aliases: [] }, [{ ...own, aliases: [] }]), ['алия', 'жк тестовый'])
    const n = node('Омега / Ромашка')
    const objects = [own, ...OBJECTS.slice(1)]
    const res = matchContract({ ...dpContract(), nodes: [n], objects }, { formats: FORMATS, generation: GEN })
    assert.deepEqual(res.candidates[0].reasons, ['counterparty'], 'чужое название не стало признаком объекта')
    assert.deepEqual(objectTerms(null, objects), [])
  })

  it('соответствие корпусу объекта — подтверждающий признак', () => {
    const n = node('Ромашка', { parentPath: 'Проект / Корпус 14' })
    assert.deepEqual(run(dpContract(), [n]).candidates[0].reasons, ['counterparty', 'features'])
  })
})

describe('signalMatch: граница объекта и корни', () => {
  const folder = (extra = {}) => node('ДП АЛИЯ-ДП-26-001', extra)

  it('узел другого или неназначенного объекта, не наблюдаемый, из выключенного корня, элемент — не кандидат', () => {
    const nodes = [
      folder({ objectId: OBJ_B }), folder({ objectId: null }), folder({ observed: false }), folder({ sourceEnabled: false }),
      folder({ sourceReady: false }), folder({ kind: 'item' }), folder({ deleted: true }),
    ]
    assert.deepEqual(run(dpContract(), nodes).candidates, [])
    assert.equal(run(dpContract(), [...nodes, folder()]).candidates.length, 1)
  })

  it('ссылка на узел другого объекта → outside_roots, неназначенного → object_unassigned; чужой id и путь не выдаются', () => {
    for (const [objectId, reason] of [[OBJ_B, 'outside_roots'], [null, 'object_unassigned']]) {
      const n = folder({ objectId })
      const r = run(dpContract({ signalLink: urlOf(n) }), [n])
      assert.deepEqual([r.state, r.reason, r.nodeId], ['unverified', reason, null])
      assert.ok(!JSON.stringify(r).includes(n.nodeId), 'id чужого узла в ответе')
      assert.ok(!JSON.stringify(r).includes('Проект'), 'путь чужого узла в ответе')
    }
    // у договора без объекта границы нет
    const n = folder()
    assert.equal(run(dpContract({ objectId: null, signalLink: urlOf(n) }), [n]).reason, 'outside_roots')
  })

  it('корень выключен или не готов → root_disabled; ссылка чужого проекта и корня вне списка → outside_roots', () => {
    for (const extra of [{ sourceEnabled: false }, { sourceReady: false }]) {
      const n = folder(extra)
      assert.deepEqual(run(dpContract({ signalLink: urlOf(n) }), [n]).reason, 'root_disabled')
    }
    const n = folder()
    const wrongProject = buildSignalUrl(FOLDER_URL, { projectId: id('a', 2), nodeId: n.nodeId })
    assert.equal(run(dpContract({ signalLink: wrongProject }), [n]).reason, 'outside_roots')
    assert.equal(run(dpContract({ signalLink: urlOf(n) }), [n], { rootProjectIds: [id('a', 2)] }).reason, 'outside_roots')
    assert.equal(run(dpContract({ signalLink: urlOf(n) }), [n], { rootProjectIds: [PROJECT.toUpperCase()] }).state, 'verified')
  })

  it('формат не поддержан, узла нет в снимке, снимка нет', () => {
    assert.deepEqual(run(dpContract({ signalLink: 'https://elsewhere.example.test/x' }), [folder()]).reason, 'unsupported_url')
    assert.deepEqual(run(dpContract({ signalLink: 'просто текст' }), []).reason, 'unsupported_url')
    const n = folder()
    assert.equal(run(dpContract({ signalLink: urlOf(n) }), []).reason, 'not_in_snapshot')
    assert.equal(run(dpContract({ signalLink: urlOf(n) }), [], {}, { generation: 0 }).reason, 'no_snapshot')
    // формат не настроен (пусто) — любая ссылка unsupported_url
    assert.equal(run(dpContract({ signalLink: urlOf(n) }), [n], {}, { formats: [] }).reason, 'unsupported_url')
    // ссылка на файл, а в снимке папка с тем же id
    assert.equal(run(dpContract({ signalLink: fileUrlOf(n) }), [n]).reason, 'not_in_snapshot')
  })
})

describe('signalMatch: введённая ссылка — verified, not_observed, not_visible, deleted', () => {
  it('ссылка разобрана, узел наблюдается, граница и признаки сходятся → verified:existing_url, кандидатов нет', () => {
    const n = node('ДП АЛИЯ-ДП-26-001')
    const other = node('ДП АЛИЯ-ДП-26-001 копия')
    const r = run(dpContract({ signalLink: urlOf(n) }), [n, other])
    assert.deepEqual([r.state, r.reason, r.nodeId, r.candidates], ['verified', 'existing_url', n.nodeId, []])
    // папка без номера в названии тоже сходится: противоречия нет
    const plain = node('Договор')
    assert.equal(run(dpContract({ signalLink: urlOf(plain) }), [plain]).state, 'verified')
  })

  it('не виден в последнем обходе: < 2 ночных — not_observed, ≥ 2 — attention:not_visible; вернулся — verified', () => {
    const base = { observed: false }
    for (const [absentNights, state, reason] of [[0, 'unverified', 'not_observed'], [1, 'unverified', 'not_observed'], [2, 'attention', 'not_visible'], [5, 'attention', 'not_visible']]) {
      const n = node('ДП АЛИЯ-ДП-26-001', { ...base, absentNights })
      const r = run(dpContract({ signalLink: urlOf(n) }), [n])
      assert.deepEqual([r.state, r.reason, r.nodeId], [state, reason, n.nodeId])
    }
    const back = node('ДП АЛИЯ-ДП-26-001', { observed: true, absentNights: 0 })
    assert.equal(run(dpContract({ signalLink: urlOf(back) }), [back]).state, 'verified')
    // «наблюдается» можно вывести из seen_gen и поколения
    const bySeen = node('ДП АЛИЯ-ДП-26-001', { observed: undefined, seenGen: GEN })
    assert.equal(run(dpContract({ signalLink: urlOf(bySeen) }), [bySeen]).state, 'verified')
    const stale = node('ДП АЛИЯ-ДП-26-001', { observed: undefined, seenGen: GEN - 1 })
    assert.equal(run(dpContract({ signalLink: urlOf(stale) }), [stale]).reason, 'not_observed')
  })

  it('элемент виден с deleted=true → missing:deleted; удалённый элемент чужого объекта — без утечки', () => {
    const file = node('ДП_АЛИЯ-ДП-26-001.pdf', { kind: 'item', deleted: true })
    const r = run(dpContract({ signalLink: fileUrlOf(file) }), [file])
    assert.deepEqual([r.state, r.reason, r.nodeId], ['missing', 'deleted', file.nodeId])
    const alive = node('ДП_АЛИЯ-ДП-26-001.pdf', { kind: 'item' })
    assert.equal(run(dpContract({ signalLink: fileUrlOf(alive) }), [alive]).state, 'verified')
    const foreign = node('ДП_АЛИЯ-ДП-26-001.pdf', { kind: 'item', deleted: true, objectId: OBJ_B })
    const r2 = run(dpContract({ signalLink: fileUrlOf(foreign) }), [foreign])
    assert.deepEqual([r2.state, r2.reason, r2.nodeId], ['unverified', 'outside_roots', null])
    // у папок deleted не бывает: флаг игнорируется (G2)
    const folderWithFlag = node('Договор', { deleted: true })
    assert.equal(run(dpContract({ signalLink: urlOf(folderWithFlag) }), [folderWithFlag]).state, 'verified')
  })

  it('файл с чужим номером ДП в названии → conflict', () => {
    const file = node('ДП_АЛИЯ-ДП-26-002.pdf', { kind: 'item' })
    assert.equal(run(dpContract({ signalLink: fileUrlOf(file) }), [file]).reason, 'number_mismatch')
  })
})

describe('signalMatch: жёсткие расхождения (conflict)', () => {
  it('number_mismatch: в названии номер другого ДП; ambiguous: несколько номеров; сохраняется узел для окна сверки', () => {
    const wrong = node('ДП АЛИЯ-ДП-26-002')
    const r = run(dpContract({ signalLink: urlOf(wrong) }), [wrong])
    assert.deepEqual([r.state, r.reason, r.nodeId], ['conflict', 'number_mismatch', wrong.nodeId])
    const two = node('АЛИЯ-ДП-26-001 и АЛИЯ-ДП-26-002')
    assert.deepEqual(run(dpContract({ signalLink: urlOf(two) }), [two]).reason, 'ambiguous')
    // номер ДП в имени есть, но ещё и чужой: даже «наш» среди двух — неоднозначность, не выбор первого
    const twoWithOurs = node('АЛИЯ-ДП-26-001, АЛИЯ-ДП-26-005')
    assert.equal(run(dpContract({ signalLink: urlOf(twoWithOurs) }), [twoWithOurs]).reason, 'ambiguous')
  })

  it('object_mismatch: номер в названии папки по коду чужого объекта', () => {
    const foreignCode = node('ДП ЗИЛ-ДП-26-001')
    const r = run(dpContract({ signalLink: urlOf(foreignCode) }), [foreignCode])
    assert.deepEqual([r.state, r.reason], ['conflict', 'object_mismatch'])
    // код, который не числится ни за одним объектом, — просто другой номер
    const unknownCode = node('ДП ХЗХ-ДП-26-001')
    assert.equal(run(dpContract({ signalLink: urlOf(unknownCode) }), [unknownCode]).reason, 'number_mismatch')
  })

  it('номер наследуется от ближайшей папки с номером: подпапка своего ДП сходится, подпапка чужого — number_mismatch', () => {
    const own = node('ДП АЛИЯ-ДП-26-001')
    const sub = child(own, 'Приложения')
    const deep = child(sub, 'Сметы')
    assert.equal(run(dpContract({ signalLink: urlOf(deep) }), [own, sub, deep]).state, 'verified')
    const foreign = node('ДП АЛИЯ-ДП-26-002')
    const fsub = child(foreign, 'Приложения')
    assert.equal(run(dpContract({ signalLink: urlOf(fsub) }), [foreign, fsub]).reason, 'number_mismatch')
    // подпапка не становится кандидатом (кандидат — папка с самим номером)
    assert.deepEqual(run(dpContract(), [own, sub, deep]).candidates.map((c) => c.nodeId), [own.nodeId])
  })

  it('building_mismatch: к.14 ≠ к.22 (объект «корп. 14», путь «к.22»); очередь — так же; совпадение и отсутствие признаков — нет конфликта', () => {
    const wrong = node('ДП АЛИЯ-ДП-26-001', { parentPath: 'Проект / к.22' })
    const r = run(dpContract({ signalLink: urlOf(wrong) }), [wrong])
    assert.deepEqual([r.state, r.reason, r.nodeId], ['conflict', 'building_mismatch', wrong.nodeId])
    for (const parentPath of ['Проект / корп.22', 'Проект / Корпус 22', 'Проект / bldg 22']) {
      const n = node('Договор', { parentPath })
      assert.equal(run(dpContract({ signalLink: urlOf(n) }), [n]).reason, 'building_mismatch', parentPath)
    }
    for (const parentPath of ['Проект / к.14', 'Проект / корп.14 / к.22 (ссылка)', 'Проект', 'Проект / Приложение 22 / v14 / 2026 / ДП 22']) {
      const n = node('Договор', { parentPath })
      assert.equal(run(dpContract({ signalLink: urlOf(n) }), [n]).state, 'verified', parentPath)
    }
    // очередь: объект «очередь 2» против «очередь 3»
    const objects = [{ id: OBJ_A, name: 'ЖК Тестовый, очередь 2', code: 'АЛИЯ', aliases: [] }]
    const q = node('Договор', { parentPath: 'Проект / оч.3' })
    const rq = matchContract({ ...dpContract({ signalLink: urlOf(q) }), nodes: [q], objects }, { formats: FORMATS, generation: GEN })
    assert.deepEqual([rq.state, rq.reason], ['conflict', 'building_mismatch'])
    // разнотипные признаки не сравниваются: корпус объекта против очереди в пути
    const other = node('Договор', { parentPath: 'Проект / очередь 5' })
    assert.equal(run(dpContract({ signalLink: urlOf(other) }), [other]).state, 'verified')
  })

  it('кандидат с расхождением признаков не предлагается; при conflict рядом показываются другие кандидаты для замены', () => {
    const wrongBuilding = node('ДП АЛИЯ-ДП-26-001', { parentPath: 'Проект / к.22' })
    assert.equal(run(dpContract(), [wrongBuilding]).state, 'none')
    const right = node('ДП АЛИЯ-ДП-26-001')
    const wrongLink = node('ДП АЛИЯ-ДП-26-002')
    const r = run(dpContract({ signalLink: urlOf(wrongLink) }), [wrongLink, right])
    assert.deepEqual([r.state, r.reason, r.nodeId], ['conflict', 'number_mismatch', wrongLink.nodeId])
    assert.deepEqual(r.candidates.map((c) => c.nodeId), [right.nodeId])
    // выбранный узел сам себе кандидатом не становится
    assert.ok(!run(dpContract({ signalLink: urlOf(right) }), [right]).candidates.length)
  })

  it('неподдержанная ссылка и недоступный узел не мешают предложить найденную папку (заменить решает человек)', () => {
    const right = node('ДП АЛИЯ-ДП-26-001')
    const r = run(dpContract({ signalLink: 'https://elsewhere.example.test/x' }), [right])
    assert.deepEqual([r.state, r.reason], ['unverified', 'unsupported_url'])
    assert.deepEqual(r.candidates.map((c) => c.nodeId), [right.nodeId])
  })
})

describe('signalMatch: отказ и отвязка', () => {
  const folder = node('ДП АЛИЯ-ДП-26-001')
  const ctxOf = (c) => contractContextKey(c)

  it('отклонённая пара с тем же контекстом не предлагается; после смены контекста — снова, с флагом', () => {
    const c = dpContract()
    const same = dpContract({ candidates: [{ nodeId: folder.nodeId, status: 'rejected', ctxKey: ctxOf(c) }] })
    const r = run(same, [folder])
    assert.deepEqual([r.state, r.reason, r.candidates], ['none', 'none', []])
    // сменились стороны → другой контекст
    const changed = dpContract({ counterparties: [{ id: CP2, name: 'ООО «Сирень»' }], candidates: [{ nodeId: folder.nodeId, status: 'rejected', ctxKey: ctxOf(c) }] })
    const r2 = run(changed, [folder])
    assert.equal(r2.state, 'suggested')
    assert.deepEqual(r2.candidates[0].flags, ['previously_rejected'])
    // номер изменился → другой контекст, но папка с новым номером — другая; со старым номером она отпала
    const renumbered = dpContract({ number: 'АЛИЯ-ДП-26-002', numberKey: 'АЛИЯ|2026|2', candidates: [{ nodeId: folder.nodeId, status: 'rejected', ctxKey: ctxOf(c) }] })
    assert.equal(run(renumbered, [folder, node('ДП АЛИЯ-ДП-26-002')]).candidates.length, 1)
  })

  it('отказ подавляет только свою пару: остальные кандидаты остаются; открытая запись заново пересчитывается', () => {
    const other = node('ДП АЛИЯ-ДП-26-001', { parentPath: 'Проект / Архив' })
    const c = dpContract({ candidates: [{ nodeId: folder.nodeId, status: 'rejected', ctxKey: ctxOf(dpContract()) }, { nodeId: other.nodeId, status: 'open', ctxKey: 'старый' }] })
    const r = run(c, [folder, other])
    assert.equal(r.state, 'suggested')
    assert.deepEqual(r.candidates.map((x) => x.nodeId), [other.nodeId])
    assert.deepEqual(r.candidates[0].flags, [])
  })

  it('после отвязки: пара подавлена, ссылка пуста → none:unlinked; смена контекста возвращает предложение с флагом', () => {
    const c = dpContract({ candidates: [{ nodeId: folder.nodeId, status: 'unlinked', ctxKey: ctxOf(dpContract()) }] })
    const r = run(c, [folder])
    assert.deepEqual([r.state, r.reason, r.candidates], ['none', 'unlinked', []])
    const changed = dpContract({ objectId: OBJ_A, counterparties: [{ id: CP2, name: 'Другая' }], candidates: c.candidates })
    const r2 = run(changed, [folder])
    assert.equal(r2.state, 'suggested')
    assert.deepEqual(r2.candidates[0].flags, ['previously_unlinked'])
    // отклонённая пара причиной unlinked не считается
    const rej = dpContract({ candidates: [{ nodeId: folder.nodeId, status: 'rejected', ctxKey: ctxOf(dpContract()) }] })
    assert.equal(run(rej, [folder]).reason, 'none')
  })
})

describe('signalMatch: ДС — только в папке своего корневого ДП', () => {
  const dp = dpContract()
  const dpFolder = node('ДП АЛИЯ-ДП-26-001')
  const dsFolder = child(dpFolder, 'ДС 3')
  const dsDeep = child(child(dpFolder, 'Приложения'), 'Допсоглашение ДС-3')
  // Папка ДП известна только по ТЕКУЩЕЙ ссылке ДП; узел прежнего состояния (family.dp.nodeId) сопоставитель не использует.
  const withDp = (ds, node0 = dpFolder) => ({ ...ds, family: { ...ds.family, dp: { ...ds.family.dp, signalLink: urlOf(node0) } } })
  const ds = withDp(dsContract(dp))
  const family = [dpFolder, dsFolder, dsDeep]

  it('ДС ищется в папке ДП и подпапках по своему номеру; номер другого ДС и чужая папка не подходят', () => {
    const r = run(ds, family)
    assert.equal(r.state, 'suggested')
    assert.deepEqual(r.candidates.map((c) => [c.reasons.includes('ds_number'), c.flags]), [[true, []], [true, []]])
    assert.deepEqual(new Set(r.candidates.map((c) => c.nodeId)), new Set([dsFolder.nodeId, dsDeep.nodeId]))
    // тот же ДС в папке с другим номером ДС
    assert.equal(run(ds, [dpFolder, child(dpFolder, 'ДС 4')]).state, 'none')
    // такая же папка «ДС 3» вне папки своего ДП (у другого ДП того же объекта)
    const otherDp = node('ДП АЛИЯ-ДП-26-002')
    const foreignDs = child(otherDp, 'ДС 3')
    const r2 = run(ds, [dpFolder, otherDp, foreignDs])
    assert.equal(r2.state, 'none', 'ДС чужого ДП не предлагается')
    // и не в корне объекта
    assert.equal(run(ds, [dpFolder, node('ДС 3')]).state, 'none')
  })

  it('явный номер чужого ДП в подпапке: кандидат не предлагается; введённая ссылка → conflict:foreign_dp', () => {
    const foreignSub = child(dpFolder, 'ДП АЛИЯ-ДП-26-002')
    const foreignDs = child(foreignSub, 'ДС 3')
    assert.equal(run(ds, [dpFolder, foreignSub, foreignDs]).state, 'none')
    const r = run({ ...ds, signalLink: urlOf(foreignDs) }, [dpFolder, foreignSub, foreignDs])
    assert.deepEqual([r.state, r.reason, r.nodeId], ['conflict', 'foreign_dp', foreignDs.nodeId])
    // ссылка на подпапку своего ДП — проверена
    const ok = run({ ...ds, signalLink: urlOf(dsDeep) }, family)
    assert.deepEqual([ok.state, ok.reason, ok.nodeId], ['verified', 'existing_url', dsDeep.nodeId])
    // сама папка ДП допустима («в папке своего ДП или её подпапках»)
    assert.equal(run({ ...ds, signalLink: urlOf(dpFolder) }, family).state, 'verified')
  })

  it('правило «только в папке своего ДП» действует и само по себе, без ограничения выборки', () => {
    const otherDp = node('ДП АЛИЯ-ДП-26-002')
    const foreignDs = child(otherDp, 'ДС 3')
    const outside = node('ДС 3')
    const r = run(ds, [dpFolder, dsFolder, otherDp, foreignDs, outside], {}, { scoped: false })
    assert.deepEqual(r.candidates.map((c) => c.nodeId), [dsFolder.nodeId])
  })

  it('ссылка ДС вне папки своего ДП → conflict:foreign_dp (даже без номера в названии)', () => {
    const otherDp = node('ДП АЛИЯ-ДП-26-002')
    const outside = child(otherDp, 'ДС 3')
    const r = run({ ...ds, signalLink: urlOf(outside) }, [dpFolder, otherDp, outside])
    assert.deepEqual([r.state, r.reason], ['conflict', 'foreign_dp'])
    const bare = node('Прочее')
    assert.equal(run({ ...ds, signalLink: urlOf(bare) }, [dpFolder, bare]).reason, 'foreign_dp')
  })

  it('папка ДП — по текущей ссылке ДП, а не по узлу прежнего состояния: после смены ссылки ДП ДС оценивается по новой папке, порядок договоров не важен', () => {
    const oldFolder = node('ДП АЛИЯ-ДП-26-001', { parentPath: 'Проект / Архив' })
    const oldSub = child(oldFolder, 'ДС 3')
    const newSub = child(dpFolder, 'ДС 3')
    // ссылка ДП сменена на dpFolder, а узел состояния ДП в signal_contracts ещё старый (oldFolder)
    const stale = (extra = {}) => ({ ...ds, family: { ...ds.family, dp: { ...ds.family.dp, signalLink: urlOf(dpFolder), nodeId: oldFolder.nodeId } }, ...extra })
    const nodes = [dpFolder, newSub, oldFolder, oldSub]
    const r = run(stale(), nodes)
    assert.equal(r.state, 'suggested')
    assert.deepEqual(r.candidates.map((c) => [c.nodeId, c.flags]), [[newSub.nodeId, []]], 'только подпапка новой папки ДП, без флага семьи')
    // введённая ссылка ДС: в новой папке — verified, в старой — foreign_dp
    const inNew = run(stale({ signalLink: urlOf(newSub) }), nodes)
    assert.deepEqual([inNew.state, inNew.reason, inNew.nodeId], ['verified', 'existing_url', newSub.nodeId])
    const inOld = run(stale({ signalLink: urlOf(oldSub) }), nodes)
    assert.deepEqual([inOld.state, inOld.reason, inOld.nodeId], ['conflict', 'foreign_dp', oldSub.nodeId])
    // узел прежнего состояния не запрашивается, запрашивается узел из текущей ссылки ДП
    const q = nodeQueryFor(stale(), { formats: FORMATS })
    assert.deepEqual(q.nodeIds, [dpFolder.nodeId])
    assert.deepEqual(q.under, [dpFolder.nodeId])
    // результат не зависит от порядка узлов и от того, в какой очерёдности считаются договоры порции (ДП → ДС и ДС → ДП)
    const dpFresh = { ...dp, signalLink: urlOf(dpFolder) }
    const batch = [dpFresh, stale({ signalLink: urlOf(newSub) })]
    const once = (list) => list.map((c) => run(c, nodes))
    const forward = once(batch)
    const backward = once([...batch].reverse()).reverse()
    assert.deepEqual(forward, backward)
    assert.deepEqual(run(stale(), [...nodes].reverse()), r)
    // без ссылки ДП (узел состояния есть, ссылка пуста) или с неподдержанным форматом папки ДП нет
    for (const signalLink of [null, '', 'https://elsewhere.example.test/x']) {
      const noLink = { ...ds, family: { ...ds.family, dp: { ...ds.family.dp, signalLink, nodeId: dpFolder.nodeId } }, signalLink: urlOf(newSub) }
      const rn = run(noLink, nodes)
      assert.deepEqual([rn.state, rn.reason], ['unverified', 'family_unknown'], String(signalLink))
      assert.deepEqual(nodeQueryFor(noLink, { formats: FORMATS }).under, [])
    }
  })

  it('папка ДП известна из его ссылки, если узла состояния ещё нет (ДП → ДС в одном снимке)', () => {
    const dpWithLink = { ...dp, signalLink: urlOf(dpFolder) }
    const viaLink = { ...dsContract(dpWithLink), signalLink: null }
    const r = run(viaLink, family)
    assert.equal(r.state, 'suggested')
    assert.equal(r.candidates.length, 2)
    // ссылка ДП ведёт в папку с чужим номером → семья неизвестна
    const badDpFolder = node('ДП АЛИЯ-ДП-26-002')
    const badDs = child(badDpFolder, 'ДС 3')
    const badLink = { ...dsContract({ ...dp, signalLink: urlOf(badDpFolder) }), signalLink: urlOf(badDs) }
    const r2 = run(badLink, [badDpFolder, badDs])
    assert.deepEqual([r2.state, r2.reason], ['unverified', 'family_unknown'])
  })

  it('папка ДП неизвестна: введённая ссылка ДС — unverified:family_unknown; предложение слабое, с флагом, не для подтверждения', () => {
    const unknown = dsContract(dp)
    const nodes = [dpFolder, dsFolder]
    const r = run(unknown, nodes)
    assert.equal(r.state, 'suggested')
    assert.deepEqual(r.candidates.map((c) => c.nodeId), [dsFolder.nodeId])
    assert.deepEqual(r.candidates[0].flags, ['family_unknown'])
    assert.ok(r.candidates[0].score < 60, 'слабее подтверждённой семьи')
    const linked = run({ ...unknown, signalLink: urlOf(dsFolder) }, nodes)
    assert.deepEqual([linked.state, linked.reason, linked.nodeId], ['unverified', 'family_unknown', dsFolder.nodeId])
    // жёсткие расхождения видны и без семьи
    const wrongBuilding = node('ДС 3', { parentPath: 'Проект / к.22' })
    assert.equal(run({ ...unknown, signalLink: urlOf(wrongBuilding) }, [wrongBuilding]).reason, 'building_mismatch')
    // цикл и удалённый ДП — тоже «неизвестно»
    assert.equal(run({ ...withDp(unknown), family: { dp: { ...withDp(unknown).family.dp }, cycle: true } }, nodes).candidates[0].flags[0], 'family_unknown')
    const deletedDp = withDp(unknown)
    deletedDp.family.dp.deleted = true
    assert.equal(run(deletedDp, nodes).candidates[0].flags[0], 'family_unknown')
    // ДП другого объекта — семья неизвестна
    const otherObj = withDp(unknown)
    otherObj.family.dp.objectId = OBJ_B
    assert.equal(run(otherObj, nodes).candidates[0].flags[0], 'family_unknown')
  })

  it('папка ДП по ссылке не принимается на веру: чужой объект, выключенный корень, чужой номер → семья неизвестна', () => {
    for (const bad of [{ objectId: OBJ_B }, { sourceEnabled: false }, { observed: false }, { kind: 'item' }]) {
      const f = { ...dpFolder, ...bad }
      const sub = child(f, 'ДС 3')
      const r = run(withDp(dsContract(dp), f), [f, sub])
      assert.equal(r.candidates[0]?.flags[0], 'family_unknown', JSON.stringify(bad))
    }
    const wrong = node('ДП АЛИЯ-ДП-26-002')
    const wsub = child(wrong, 'ДС 3')
    assert.equal(run(withDp(dsContract(dp), wrong), [wrong, wsub]).candidates[0].flags[0], 'family_unknown')
  })

  it('ДС: объект папки — граница тоже; не наблюдаемая папка ДС → not_observed', () => {
    const foreignObj = { ...dsFolder, nodeId: id('c', 800), objectId: OBJ_B }
    assert.equal(run(ds, [dpFolder, foreignObj]).state, 'none')
    const gone = { ...dsFolder, observed: false, absentNights: 1 }
    assert.deepEqual(run({ ...ds, signalLink: urlOf(gone) }, [dpFolder, gone]).reason, 'not_observed')
  })

  it('номер ДС — «ДС №3», «3», «ДС-3»; папка «ДС 3» подходит каждому; «ДС 33» и «13» — нет', () => {
    for (const number of ['ДС №3', '3', 'ДС-3', '№ 3', 'Доп. соглашение 3']) {
      const r = run(withDp(dsContract(dp, { number })), family)
      assert.equal(r.candidates.length, 2, number)
    }
    assert.equal(run(withDp(dsContract(dp, { number: 'ДС №3' })), [dpFolder, child(dpFolder, 'ДС 33'), child(dpFolder, 'ДС 13')]).state, 'none')
  })
})

describe('signalMatch: проверка узла перед confirm (evaluateNode)', () => {
  it('conflict → не подтверждается; verified → подтверждается; без семьи и не наблюдаемый — нет', () => {
    const good = node('ДП АЛИЯ-ДП-26-001')
    const bad = node('ДП АЛИЯ-ДП-26-002')
    const input = { ...dpContract(), nodes: [good, bad], objects: OBJECTS }
    const a = evaluateNode(input, good.nodeId, { generation: GEN })
    assert.deepEqual([a.state, a.reason, a.nodeId, a.confirmable], ['verified', 'existing_url', good.nodeId, true])
    const b = evaluateNode(input, bad.nodeId, { generation: GEN })
    assert.deepEqual([b.state, b.reason, b.confirmable], ['conflict', 'number_mismatch', false])
    assert.deepEqual(evaluateNode(input, id('c', 999), { generation: GEN }), { state: 'unverified', reason: 'not_in_snapshot', nodeId: null, confirmable: false })
    assert.equal(evaluateNode(input, id('c', 999), { generation: 0 }).reason, 'no_snapshot')
    const foreign = { ...input, nodes: [{ ...good, objectId: OBJ_B }] }
    assert.deepEqual(evaluateNode(foreign, good.nodeId, { generation: GEN }), { state: 'unverified', reason: 'outside_roots', nodeId: null, confirmable: false })
    const dsInput = { ...dsContract(dpContract()), nodes: [good], objects: OBJECTS }
    assert.equal(evaluateNode(dsInput, good.nodeId, { generation: GEN }).reason, 'family_unknown')
    assert.equal(evaluateNode({ ...input, deleted: true }, good.nodeId, { generation: GEN }).confirmable, false)
  })

  it('результат совпадает с тем, что даёт matchContract для той же ссылки (тот же код, что у очереди)', () => {
    const wrong = node('ДП АЛИЯ-ДП-26-002')
    const viaLink = run(dpContract({ signalLink: urlOf(wrong) }), [wrong])
    const viaNode = evaluateNode({ ...dpContract(), nodes: [wrong], objects: OBJECTS }, wrong.nodeId, { generation: GEN })
    assert.deepEqual([viaLink.state, viaLink.reason, viaLink.nodeId], [viaNode.state, viaNode.reason, viaNode.nodeId])
  })
})

describe('signalMatch: запрос узлов для договора', () => {
  const dpFolderId = id('c', 700)

  it('ДП: id из ссылки, ключ номера, объект и термины (сторона, транслит, ИНН); списки отсортированы', () => {
    const inn = '9901234561'
    const n = id('c', 701)
    const q = nodeQueryFor(dpContract({ signalLink: buildSignalUrl(FOLDER_URL, { projectId: PROJECT, nodeId: n }), counterparties: [{ id: CP1, name: 'ООО «Ромашка»', inn }, { id: CP2, name: 'ИП Сирень' }] }), { formats: FORMATS })
    assert.deepEqual(q, { nodeIds: [n], numberKeys: ['АЛИЯ|2026|1'], objectIds: [OBJ_A], terms: [inn, 'romashka', 'ромашка', 'сирень', 'siren'].sort(), under: [] })
  })

  it('без ссылки и без сторон — только ключ номера; удалённый договор — ничего; без объекта объектов нет', () => {
    assert.deepEqual(nodeQueryFor(dpContract({ counterparties: [] }), { formats: FORMATS }), { nodeIds: [], numberKeys: ['АЛИЯ|2026|1'], objectIds: [], terms: [], under: [] })
    assert.deepEqual(nodeQueryFor(dpContract({ deleted: true }), { formats: FORMATS }), { nodeIds: [], numberKeys: [], objectIds: [], terms: [], under: [] })
    assert.deepEqual(nodeQueryFor(dpContract({ objectId: null }), { formats: FORMATS }).objectIds, [])
    // ссылка в неподдержанном формате в запрос не попадает
    assert.deepEqual(nodeQueryFor(dpContract({ signalLink: 'https://elsewhere.example.test/x' }), { formats: FORMATS }).nodeIds, [])
    assert.deepEqual(nodeQueryFor(dpContract({ signalLink: 'x' })).nodeIds, [])
  })

  it('номер старого вида идёт термином; термины не содержат символов шаблона LIKE', () => {
    const q = nodeQueryFor(dpContract({ number: 'СУ10-ВЭЙВ-СП-Э1-25', numberKey: null, counterparties: [{ id: CP1, name: '100%_Ромашка\\' }] }), { formats: FORMATS })
    assert.deepEqual(q.numberKeys, [])
    assert.ok(q.terms.includes('су10-вэйв-сп-э1-25'))
    for (const t of q.terms) assert.doesNotMatch(t, /[%_\\]/)
    const weak = nodeQueryFor(dpContract({ number: 'Т-7', numberKey: null, counterparties: [] }), { formats: FORMATS })
    assert.deepEqual(weak.terms, [])
  })

  it('ДС: папка из текущей ссылки ДП → nodeIds и under; без папки — варианты «ДС N» и объект', () => {
    const dp = dpContract()
    const withNode = { ...dsContract(dp), family: { dp: { ...dsContract(dp).family.dp, signalLink: buildSignalUrl(FOLDER_URL, { projectId: PROJECT, nodeId: dpFolderId }) }, cycle: false } }
    assert.deepEqual(nodeQueryFor(withNode, { formats: FORMATS }), { nodeIds: [dpFolderId], numberKeys: [], objectIds: [], terms: [], under: [dpFolderId] })
    // узел прежнего состояния ДП (family.dp.nodeId) в запрос не попадает
    const onlyState = { ...dsContract(dp), family: { dp: { ...dsContract(dp).family.dp, nodeId: dpFolderId }, cycle: false } }
    assert.deepEqual(nodeQueryFor(onlyState, { formats: FORMATS }).nodeIds, [])
    const viaLink = dsContract({ ...dp, signalLink: buildSignalUrl(FOLDER_URL, { projectId: PROJECT, nodeId: dpFolderId }) })
    assert.deepEqual(nodeQueryFor(viaLink, { formats: FORMATS }).under, [dpFolderId])
    const unknown = nodeQueryFor(dsContract(dp), { formats: FORMATS })
    assert.deepEqual(unknown.under, [])
    assert.deepEqual(unknown.objectIds, [OBJ_A])
    assert.deepEqual(unknown.terms, ['дс 3', 'дс3', 'дс №3', 'дс-3'].sort())
    // цикл — семья неизвестна, папка ДП не запрашивается
    assert.deepEqual(nodeQueryFor({ ...withNode, family: { ...withNode.family, cycle: true } }, { formats: FORMATS }).under, [])
  })

  it('все узлы запроса достаточны для matchContract: результат с узлами по запросу = результату со всеми узлами', () => {
    const own = node('ДП АЛИЯ-ДП-26-001')
    const noise = node('Прочее')
    const c = dpContract({ signalLink: urlOf(own) })
    const q = nodeQueryFor(c, { formats: FORMATS })
    const requested = [own, noise].filter((n) => q.nodeIds.includes(n.nodeId))
    assert.deepEqual(run(c, requested), run(c, [own, noise]))
  })
})

describe('signalMatch: детерминизм', () => {
  it('одинаковый вход → одинаковый результат; порядок узлов, кандидатов и сторон не влияет', () => {
    const nodes = [
      node('ДП АЛИЯ-ДП-26-001', { parentPath: 'Проект / В' }), node('ДП АЛИЯ-ДП-26-001', { parentPath: 'Проект / А' }),
      node('Ромашка'), node('Romashka'), node('Прочее'), node('ДП АЛИЯ-ДП-26-002'),
    ]
    const c = dpContract({ counterparties: [{ id: CP1, name: 'ООО «Ромашка»' }, { id: CP2, name: 'ИП Сирень' }] })
    const first = run(c, nodes)
    assert.deepEqual(run(c, nodes), first)
    assert.deepEqual(run(c, [...nodes].reverse()), first)
    assert.deepEqual(run({ ...c, counterparties: [...c.counterparties].reverse() }, nodes), first)
    assert.deepEqual(JSON.parse(JSON.stringify(first)), first)
    const link = run({ ...c, signalLink: urlOf(nodes[0]) }, nodes)
    assert.deepEqual(run({ ...c, signalLink: urlOf(nodes[0]) }, [...nodes].reverse()), link)
    // вход не изменяется
    const frozen = structuredClone(nodes)
    run(c, nodes)
    assert.deepEqual(nodes, frozen)
  })

  it('результат не зависит от узлов, пришедших по запросам других договоров той же порции', () => {
    const c = dpContract({ signalLink: null })
    const own = node('ДП АЛИЯ-ДП-26-001')
    // узлы «чужих» запросов: подходили бы договору по правилам сопоставления, но его собственный запрос их не вернул бы
    const strangers = [node('Договор_СУ10_ВЭЙВ_СП_Э1_25'), node('ДС 3'), node('ДП АЛИЯ-ДП-26-002'), node('Папка', { objectId: OBJ_B })]
    const legacy = dpContract({ number: 'СУ10-ВЭЙВ-СП-Э1-25', numberKey: null, counterparties: [] })
    assert.deepEqual(run(c, [own, ...strangers]), run(c, [own]))
    assert.deepEqual(run(legacy, strangers), run(legacy, []))
    assert.equal(run(legacy, strangers).state, 'none')
    // без ограничения выборкой (scoped:false) правила нашли бы и такую папку — граница выборки нужна именно для равенства результатов
    assert.equal(run(legacy, strangers, {}, { scoped: false }).state, 'suggested')
    // а запрошенные узлы — по ссылке, ключу номера, папке ДП и его подпапкам — учитываются
    const dpFolder = node('ДП АЛИЯ-ДП-26-001')
    const sub = child(dpFolder, 'ДС 3')
    const ds = { ...dsContract(dpContract()), family: { dp: { ...dsContract(dpContract()).family.dp, signalLink: urlOf(dpFolder) }, cycle: false } }
    assert.deepEqual(run(ds, [dpFolder, sub, ...strangers]).candidates.map((x) => x.nodeId), [sub.nodeId])
  })

  it('кандидатов не больше десяти; сортировка: очки, путь, id', () => {
    const many = Array.from({ length: 14 }, (_, i) => node('ДП АЛИЯ-ДП-26-001', { parentPath: `Проект / ${String.fromCharCode(1040 + i)}` }))
    const r = run(dpContract(), many)
    assert.equal(r.candidates.length, 10)
    const paths = r.candidates.map((c) => many.find((n) => n.nodeId === c.nodeId).path)
    assert.deepEqual(paths, [...paths].sort())
  })
})

describe('signalMatch: константы', () => {
  it('таблица состояний согласована с текстами; каждая причина кандидата и флаг описаны', () => {
    for (const [state, reasons] of Object.entries(STATE_REASONS)) {
      assert.ok(STATES[state], state)
      for (const r of reasons) assert.ok(REASONS[r], r)
    }
    assert.deepEqual(Object.keys(STATES).sort(), ['attention', 'conflict', 'missing', 'none', 'suggested', 'unverified', 'verified'])
    assert.deepEqual(STATE_REASONS.conflict, ['object_mismatch', 'number_mismatch', 'building_mismatch', 'foreign_dp', 'ambiguous'])
    assert.deepEqual(STATE_REASONS.unverified.slice(0, 6), ['unsupported_url', 'outside_roots', 'root_disabled', 'not_in_snapshot', 'no_snapshot', 'object_unassigned'])
    assert.ok(Object.isFrozen(STATES) && Object.isFrozen(REASONS) && Object.isFrozen(MATCH_REASONS) && Object.isFrozen(MATCH_FLAGS))
    for (const text of [...Object.values(REASONS), ...Object.values(STATES), ...Object.values(MATCH_REASONS), ...Object.values(MATCH_FLAGS)]) {
      assert.ok(text && !/удалена/.test(text), text)
    }
  })
})
