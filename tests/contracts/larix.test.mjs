// Путь к Larix.CPM у договора: одно значение (contracts.document_link), состояние «внесён в Larix»
// выводится из него и нигде отдельно не хранится.
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'
import { LARIX_LINK_FIELD, LARIX_LINK_LABEL, isInLarix, larixLink } from '../../src/utils/contractLarix.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(REPO, 'src')

// Модули src/ импортируют друг друга без расширений (так собирает Vite) — для Node собираем
// импорт договоров одним файлом.
let imp
before(async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osp-contracts-')), 'contractsImport.mjs')
  await esbuild.build({
    entryPoints: [path.join(SRC, 'utils', 'contractsImport.js')],
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
    external: ['xlsx'],
    absWorkingDir: REPO,
  })
  // Собранный файл лежит вне репозитория: xlsx берём из node_modules проекта.
  const code = fs.readFileSync(out, 'utf8').replaceAll('from "xlsx"', `from ${JSON.stringify(pathToFileURL(path.join(REPO, 'node_modules', 'xlsx', 'xlsx.mjs')).href)}`)
  fs.writeFileSync(out, code)
  imp = await import(pathToFileURL(out).href)
})

describe('состояние «внесён в Larix»', () => {
  it('выводится из заполненности пути и не зависит от прежней отметки', () => {
    assert.equal(isInLarix({ document_link: 'https://cpm.su10.larix.ru/contract/4521' }), true)
    assert.equal(isInLarix({ document_link: '' }), false)
    assert.equal(isInLarix({ document_link: '   ' }), false)
    assert.equal(isInLarix({ document_link: null }), false)
    assert.equal(isInLarix({}), false)
    assert.equal(isInLarix(null), false)
    // Старая отметка без ссылки — «не в Larix»; ссылка без отметки — «внесён».
    assert.equal(isInLarix({ larix_entered: true, larix_number: '777', document_link: null }), false)
    assert.equal(isInLarix({ larix_entered: false, document_link: 'https://cpm.su10.larix.ru/contract/1' }), true)
    assert.equal(larixLink({ document_link: '  https://x.example/1  ' }), 'https://x.example/1')
  })

  it('в коде интерфейса прежняя отметка не читается и не пишется', () => {
    const offenders = []
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(js|jsx)$/.test(e.name) && /larix_(entered|number)/.test(fs.readFileSync(p, 'utf8'))) {
          offenders.push(path.relative(REPO, p))
        }
      }
    }
    walk(SRC)
    // Единственное упоминание — пояснение в самом модуле состояния.
    assert.deepEqual(offenders, [path.join('src', 'utils', 'contractLarix.js')])
  })
})

describe('импорт договоров из Excel: колонка пути к Larix.CPM', () => {
  const headerIndex = (header) => {
    const row = ['Тип', '№ документа', 'Дата документа', 'Статус', 'Наименование контрагента', 'ИНН контрагента',
      'Объект работ', 'Наименование работ', 'Ответственный юрист', 'Сумма по документу', 'Валюта', 'Ставка НДС',
      'Хранение суммы', 'БСМ', 'Начало работ', 'Окончание работ', 'Дата подписания', 'Срок гарантии на работы',
      'Путь к папке', 'Путь к Signal', 'Примечание', 'Комментарии', header]
    return { row, map: imp.mapHeaderRow(row) }
  }

  it('шаблон называет колонку «Путь к Larix.CPM», колонок отметки и номера нет', () => {
    assert.ok(imp.TEMPLATE_HEADERS.includes(LARIX_LINK_LABEL))
    for (const h of ['Ссылка на документ', 'Внесён в Larix', '№ в Larix']) assert.ok(!imp.TEMPLATE_HEADERS.includes(h), h)
    assert.ok(!imp.IMPORT_COLUMNS.some((c) => /^larix_/.test(c.key)))
  })

  it('узнаёт новый заголовок, прежний и «CPM», набранное кириллицей', () => {
    for (const header of [LARIX_LINK_LABEL, 'путь к larix.cpm', 'Путь к Larix.СРМ', 'Ссылка на документ']) {
      const { row, map } = headerIndex(header)
      assert.equal(map.positional, false, header)
      assert.equal(map.colIndexByKey[LARIX_LINK_FIELD], row.length - 1, header)
    }
  })

  it('старые колонки «Внесён в Larix» и «№ в Larix» в файле не мешают и не читаются', () => {
    const { row } = headerIndex(LARIX_LINK_LABEL)
    const map = imp.mapHeaderRow([...row, 'Внесён в Larix', '№ в Larix'])
    assert.equal(map.positional, false)
    assert.ok(!('larix_entered' in map.colIndexByKey) && !('larix_number' in map.colIndexByKey))
  })

  const ctx = () => ({
    docIndex: { byId: new Map(), byDisplayId: new Map(), childrenOf: new Map() },
    cpByInn: new Map([['123456789012', ['cp-1']]]),
    cpByName: new Map(),
    cpDeletedByInn: new Map(),
    cpDeletedByName: new Map(),
    objByName: new Map([['жк алия', ['obj-1']]]),
    contactByName: new Map(),
    existingNumbers: new Set(),
    amendmentNumbers: new Set(),
  })
  const raw = (over) => ({
    record_type: 'Договор', contract_number: 'СУ-1', contract_date: '15.02.2026', status: 'В работе',
    counterparty_inn: '123456789012', object_name: 'ЖК Алия', ...over,
  })

  it('ссылка попадает в document_link, отметка в запись не пишется', () => {
    const res = imp.validateRow(raw({ document_link: ' https://cpm.su10.larix.ru/contract/4521 ' }), ctx())
    assert.deepEqual(res.errors, [])
    assert.equal(res.payload.document_link, 'https://cpm.su10.larix.ru/contract/4521')
    assert.deepEqual(Object.keys(res.payload).filter((k) => /^larix_/.test(k)), [])
    assert.equal(isInLarix(res.payload), true)
  })

  it('пустая колонка — договор не внесён в Larix', () => {
    const res = imp.validateRow(raw({}), ctx())
    assert.deepEqual(res.errors, [])
    assert.equal(res.payload.document_link, null)
    assert.equal(isInLarix(res.payload), false)
  })

  it('путь к папке вместо ссылки — ошибка строки, а не ложное «внесён»', () => {
    const res = imp.validateRow(raw({ document_link: '\\\\192.168.2.55\\Share\\Договоры\\1' }), ctx())
    assert.equal(res.kind, 'error')
    assert.deepEqual(res.errors.map((e) => e.key), [LARIX_LINK_FIELD])
    assert.match(res.errors[0].message, /нужна ссылка/)
  })
})
