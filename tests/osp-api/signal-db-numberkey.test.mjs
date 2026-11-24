// Паритет ключей номера договора: numberKey из server/osp-api/src/shared/contractNumbering.js (его зовёт сопоставитель сверки с SIGNAL)
// и из src/utils/contractNumbering.js (форма договора) против SQL contract_number_key / contract_code_key из 20270110 — настоящий
// текст функций на настоящем PostgreSQL. От ключа зависят число в имени папки (number_keys узлов), поиск папок ДП и ДС, ключ
// «ДП ↔ папка». Расхождение даёт молчаливо несопоставленные договоры. Номера и коды вымышлены.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { startSignalDb, signalDbSkip, ROOT } from './lib/signal-db.mjs'

const NUMBERS = [
  // по схеме КОД-ДП-ГГ-N
  'АЛИЯ-ДП-26-001', 'АЛИЯ-ДП-26-1', 'АЛИЯ-ДП-26-0001', 'АЛИЯ-ДП-26-000001', 'АЛИЯ-ДП-26-000', 'АЛИЯ-ДП-26-0000001', 'АЛИЯ-ДП-26-12',
  'АЛИЯ-ДП-26-999999', 'АЛИЯ-ДП-99-007', 'АЛИЯ-ДП-00-007', 'АЛИЯ-ДП-26-1000000',
  // регистр
  'алия-дп-26-001', 'Алия-Дп-26-001', 'АЛИЯ-дп-26-001', 'алия-ДП-26-1',
  // латиница-двойник (A B C E H K M O P T X Y → кириллица)
  'AЛИЯ-ДП-26-001', 'ALIYA-ДП-26-001', 'СУ10-ДП-26-001', 'CУ10-ДП-26-001', 'КОД-ДП-26-001', 'KOД-ДП-26-001', 'ХТМ-ДП-26-005', 'XTM-ДП-26-005',
  'ЕНК-ДП-27-010', 'EHK-ДП-27-010', 'ABCEHKMOPTXY-ДП-26-001', 'АВСЕНКМОРТХУ-ДП-26-001', 'АЛИЯ-ДП-26-001Y',
  // «ДП» латиницей (D нет в двойниках) — не по схеме
  'АЛИЯ-DП-26-001', 'АЛИЯ-DP-26-001', 'АЛИЯ-ДР-26-001',
  // пробелы и невидимое по краям
  ' АЛИЯ-ДП-26-001', 'АЛИЯ-ДП-26-001 ', '\tАЛИЯ-ДП-26-001\n', ' АЛИЯ-ДП-26-001 ', ' АЛИЯ-ДП-26-001', '\r\nАЛИЯ-ДП-26-001\r\n',
  // пробелы внутри — не по схеме
  'АЛИЯ -ДП-26-001', 'АЛИЯ- ДП-26-001', 'АЛИЯ-ДП -26-001', 'АЛИЯ-ДП- 26-001', 'АЛИЯ-ДП-26 -001', 'АЛИЯ-ДП-26- 001', 'АЛИЯ ДП 26 001', 'АЛИЯ - ДП - 26 - 001',
  // коды с цифрами, точками и дефисами
  'ЗИЛ18-19-27-ДП-27-012', 'ДОМ56Рен-ДП-26-003', 'СУ2-ДОМ56-ДП-26-003', 'Н.А-ДП-26-001', '1АБ-ДП-26-001', '-АЛИЯ-ДП-26-001', 'АЛИЯ--ДП-26-001', 'АЛИЯ.-ДП-26-001',
  'А-ДП-26-001', 'Я-ДП-26-001', 'А1-ДП-26-001', 'АЛИЯ_ДП-26-001', 'АЛИЯ+-ДП-26-001', 'ООООООООООООООООООО1-ДП-26-001', 'ООООООООООООООООООООО-ДП-26-001', 'ООООООООООООООООООО-ДП-26-001',
  // не по схеме: старый вид, ДС, номер с №, пустое
  'СУ10-ВЭЙВ-СП-Э1-25', '№ 5', '5', 'ДС-1', 'ДС-1 к АЛИЯ-ДП-26-001', 'АЛИЯ-ДП-26-001/1', 'АЛИЯ-ДП-26-001-1', 'АЛИЯ-ДП-26', 'АЛИЯ-ДП-26-', 'АЛИЯ-ДП--001', 'АЛИЯ-ДП-2026-001',
  'АЛИЯ-ДП-2-001', 'АЛИЯ-ДП-26-00a', 'АЛИЯ-ДП-26-1.5', 'АЛИЯ–ДП–26–001', 'АЛИЯ—ДП—26—001', 'АЛИЯ‑ДП‑26‑001', 'ДП-26-001', 'АЛИЯ-ДП-26-001-ДП-26-002', '', ' ', ' ',
  // ё и регистр особых букв
  'ЁЛКА-ДП-26-001', 'ёлка-дп-26-001', 'ЕЛКА-ДП-26-001',
]
const CODES = ['АЛИЯ', 'алия', 'AЛИЯ', ' АЛИЯ ', 'ЗИЛ18-19-27', 'ДОМ56Рен', 'ЗИЛ 33', '', ' ', 'А', '1', '-А', 'А-', 'А.Б', 'А..Б', 'ООООООООООООООООООО1', 'ООООООООООООООООООООО', 'ёлка', 'ЁЛКА']

describe('Ключи номера договора: JS (сверка с SIGNAL, форма договора) = SQL contract_number_key / contract_code_key', { skip: signalDbSkip, timeout: 300000 }, () => {
  let db
  let server
  let page
  const lit = (v) => (v === null ? 'null' : `'${String(v).replace(/'/g, "''")}'`)

  before(async () => {
    db = await startSignalDb()
    server = await import(path.join(ROOT, 'server', 'osp-api', 'src', 'shared', 'contractNumbering.js'))
    page = await import(path.join(ROOT, 'src', 'utils', 'contractNumbering.js'))
  })
  after(async () => { await db?.stop() })

  it('numberKey: один и тот же ключ в базе, в серверной копии и на странице — на наборе номеров (схема, регистр, двойники, пробелы, не по схеме)', () => {
    // Одним запросом: список значений → ключи базы.
    const values = NUMBERS.map((n, i) => `(${i}, ${lit(n)})`).join(', ')
    const rows = db.sql(`select i || '=' || coalesce(public.contract_number_key(n), '<null>') from (values ${values}) v(i, n) order by i`).split('\n')
    assert.equal(rows.length, NUMBERS.length)
    const keys = rows.map((r) => r.slice(r.indexOf('=') + 1))
    const diffs = []
    for (const [i, n] of NUMBERS.entries()) {
      const want = keys[i]
      const gotServer = server.numberKey(n) ?? '<null>'
      const gotPage = page.numberKey(n) ?? '<null>'
      if (gotServer !== want || gotPage !== want) diffs.push(`«${JSON.stringify(n)}»: база ${want}, сервер ${gotServer}, страница ${gotPage}`)
    }
    assert.deepEqual(diffs, [])
    // Набор осмысленный: и ключи, и «не по схеме» есть.
    assert.ok(keys.filter((k) => k !== '<null>').length >= 25)
    assert.ok(keys.filter((k) => k === '<null>').length >= 25)
    // Явные ожидания (регистр, двойник, ведущие нули).
    const byNumber = Object.fromEntries(NUMBERS.map((n, i) => [n, keys[i]]))
    assert.equal(byNumber['АЛИЯ-ДП-26-001'], 'АЛИЯ|2026|1')
    assert.equal(byNumber['алия-дп-26-001'], 'АЛИЯ|2026|1')
    assert.equal(byNumber['AЛИЯ-ДП-26-001'], 'АЛИЯ|2026|1')
    assert.equal(byNumber['АЛИЯ-ДП-26-000'], '<null>')
    assert.equal(byNumber['ЗИЛ18-19-27-ДП-27-012'], 'ЗИЛ18-19-27|2027|12')
    assert.equal(byNumber['СУ10-ВЭЙВ-СП-Э1-25'], '<null>')
  })

  it('numberKey не зависит от способа записи: пара «номер → ключ» одинакова и для строки из SQL, и для вызова с null / не-строкой', () => {
    assert.equal(db.sql('select coalesce(public.contract_number_key(null), \'<null>\')'), '<null>')
    assert.equal(server.numberKey(null) ?? '<null>', '<null>')
    assert.equal(server.numberKey(undefined) ?? '<null>', '<null>')
    assert.equal(page.numberKey(null) ?? '<null>', '<null>')
  })

  it('codeKey: ключ кода объекта — база, сервер и страница совпадают', () => {
    const values = CODES.map((n, i) => `(${i}, ${lit(n)})`).join(', ')
    const keys = db.sql(`select i || '=' || coalesce(public.contract_code_key(n), '<null>') from (values ${values}) v(i, n) order by i`).split('\n')
      .map((r) => r.slice(r.indexOf('=') + 1))
    const diffs = []
    for (const [i, c] of CODES.entries()) {
      const gotServer = server.codeKey(c) ?? '<null>'
      const gotPage = page.codeKey(c) ?? '<null>'
      if (gotServer !== keys[i] || gotPage !== keys[i]) diffs.push(`«${JSON.stringify(c)}»: база ${keys[i]}, сервер ${gotServer}, страница ${gotPage}`)
    }
    assert.deepEqual(diffs, [])
  })

  it('серверная копия контрактной нумерации совпадает со страницей (тело, кроме строки-пометки)', async () => {
    const fs = await import('node:fs')
    const body = (f) => fs.readFileSync(f, 'utf8').replace(/^\/\/ КОПИЯ[^\n]*\n/, '')
    assert.equal(body(path.join(ROOT, 'server', 'osp-api', 'src', 'shared', 'contractNumbering.js')), body(path.join(ROOT, 'src', 'utils', 'contractNumbering.js')))
  })
})
