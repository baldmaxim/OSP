// «История» договоров и ДС: событие «Создание» у каждого документа.
// Импорт из Excel пишет «Создание» с файлом и строкой (до 19.11.2026 не писал — у 1652 документов «История» была без
// создания); существующим документам его восстанавливает миграция 20270222 (только база Яндекса). Здесь — без базы:
// текст события, сопоставление вставленных записей со строками файла, подключение в окне импорта, комплект файлов
// миграции. Сама миграция на копии прода — tests/tender/contract-created-history-db.test.mjs (Docker).
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(REPO, 'src')
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8')
const NAME = '20270222_contract_created_history'

// Модули src/ импортируют друг друга без расширений (так собирает Vite) — для Node собираем одним файлом.
let imp
before(async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osp-created-')), 'contractsImport.mjs')
  await esbuild.build({
    entryPoints: [path.join(SRC, 'utils', 'contractsImport.js')],
    bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
    external: ['xlsx'],
    absWorkingDir: REPO,
  })
  const code = fs.readFileSync(out, 'utf8').replaceAll('from "xlsx"', `from ${JSON.stringify(pathToFileURL(path.join(REPO, 'node_modules', 'xlsx', 'xlsx.mjs')).href)}`)
  fs.writeFileSync(out, code)
  imp = await import(pathToFileURL(out).href)
})

const row = (excelRow, payload) => ({ excelRow, result: { kind: 'ready', payload } })

describe('импорт: событие «Создание» в «Истории»', () => {
  it('договор — то же начало, что у формы «Добавить», плюс файл и строка', () => {
    const ev = imp.importCreatedEvent({
      contractId: 'c1', payload: { record_type: 'dp', contract_number: 'ТЕСТ-ДП-26-001' },
      fileName: 'Реестр.xlsx', excelRow: 7, author: { name: 'Иванов И. И.', role: 'lawyer' },
    })
    assert.deepEqual(ev, {
      contract_id: 'c1',
      event_type: 'created',
      description: 'Создан договор № ТЕСТ-ДП-26-001. Документ загружен импортом из Excel: «Реестр.xlsx», строка 7.',
      new_value: { source: 'import', file: 'Реестр.xlsx', row: 7 },
      changed_by_role: 'lawyer',
      changed_by_name: 'Иванов И. И.',
    })
  })

  it('ДС — вид ДС и ID изменяемого документа; без номера — «(без номера)»', () => {
    assert.equal(imp.importCreatedEvent({
      contractId: 'c2', payload: { record_type: 'ds_extra', contract_number: '5' }, parentDisplayId: 501, fileName: 'ДС.xlsx', excelRow: 3,
    }).description, 'Создано ДС на дополнительные работы № 5 к документу ID 501. Документ загружен импортом из Excel: «ДС.xlsx», строка 3.')
    assert.equal(imp.importCreatedEvent({ contractId: 'c3', payload: { record_type: 'ds_vor', contract_number: null }, parentDisplayId: 9 }).description,
      'Создано ДС на изменение ВОР (без номера) к документу ID 9. Документ загружен импортом из Excel.')
  })

  it('строка файла не найдена — событие всё равно пишется, без номера строки; автора нет — поля пустые', () => {
    const ev = imp.importCreatedEvent({ contractId: 'c4', payload: { record_type: 'dp', contract_number: '1' }, fileName: 'f.xlsx' })
    assert.equal(ev.description, 'Создан договор № 1. Документ загружен импортом из Excel: «f.xlsx».')
    assert.deepEqual(ev.new_value, { source: 'import', file: 'f.xlsx', row: null })
    assert.equal(ev.changed_by_name, null)
    assert.equal(ev.changed_by_role, null)
  })
})

describe('импорт: какая запись — из какой строки', () => {
  const p = (n, extra = {}) => ({ record_type: 'dp', contract_number: n, counterparty_id: 'k', object_id: 'o', ...extra })

  it('записи в порядке строк — по порядку', () => {
    const rows = [row(2, p('1')), row(3, p('2'))]
    const pairs = imp.pairInserted(rows, [{ id: 'a', ...p('1') }, { id: 'b', ...p('2') }])
    assert.deepEqual(pairs.map((x) => [x.rec.id, x.row?.excelRow]), [['a', 2], ['b', 3]])
  })

  it('порядок другой — находится по виду, номеру, стороне и объекту', () => {
    const rows = [row(2, p('1')), row(3, p('2')), row(4, p('3', { record_type: 'ds_extra' }))]
    const pairs = imp.pairInserted(rows, [{ id: 'c', ...p('3', { record_type: 'ds_extra' }) }, { id: 'a', ...p('1') }, { id: 'b', ...p('2') }])
    assert.deepEqual(pairs.map((x) => [x.rec.id, x.row?.excelRow]), [['c', 4], ['a', 2], ['b', 3]])
  })

  it('неоднозначно (одинаковые строки, порядок сбит) — строка не указывается, запись не теряется', () => {
    const rows = [row(2, p('7')), row(3, p('7')), row(4, p('8'))]
    const pairs = imp.pairInserted(rows, [{ id: 'z', ...p('8') }, { id: 'x', ...p('7') }, { id: 'y', ...p('7') }])
    assert.deepEqual(pairs.map((x) => [x.rec.id, x.row?.excelRow ?? null]), [['z', 4], ['x', null], ['y', null]])
  })

  it('одинаковые строки, порядок не сбит — по порядку', () => {
    const rows = [row(2, p('7')), row(3, p('7'))]
    const pairs = imp.pairInserted(rows, [{ id: 'x', ...p('7') }, { id: 'y', ...p('7') }])
    assert.deepEqual(pairs.map((x) => [x.rec.id, x.row?.excelRow]), [['x', 2], ['y', 3]])
  })
})

describe('окно импорта пишет «Историю»', () => {
  const src = read('src', 'components', 'ContractsImportModal.jsx')

  it('после пакетной и поштучной вставки — событие каждой записи, запись — в contract_audit_log', () => {
    assert.match(src, /pairInserted\(chunk, data\)\.forEach\(\(\{ rec, row \}\) => history\.push\(createdEvent\(rec, row\)\)\)/)
    assert.match(src, /history\.push\(createdEvent\(d, x\)\)/)
    assert.match(src, /db\.from\('contract_audit_log'\)\.insert\(hchunk\)/)
  })

  it('не записалось — окно говорит об этом', () => {
    assert.match(src, /setResultInfo\(\{ created, notLoaded, historyFailed \}\)/)
    assert.match(src, /resultInfo\.historyFailed > 0/)
  })
})

describe(`миграция ${NAME}: комплект файлов`, () => {
  it('только база Яндекса: файл, проверка, проверка для прода и откат; в supabase/migrations её нет', () => {
    const body = read('migration', 'yandex', `${NAME}.sql`)
    assert.doesNotMatch(body, /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/m, 'транзакцию задаёт migrate.sh')
    assert.doesNotMatch(body, /^\s*\\/m, 'без команд psql')
    assert.match(body, /osp_private\.data_audit_log/)
    assert.match(read('migration', 'yandex', `${NAME}.check.sql`), /'OK' else 'FAIL'/)
    assert.match(read('migration', 'backup', 'checks', '20270222.sql'), /'OK' else 'FAIL'/)
    assert.match(read('migration', 'rollback', `${NAME}_rollback.sql`), /new_value ->> 'restored' = '20270222'/)
    assert.equal(fs.existsSync(path.join(REPO, 'supabase', 'migrations', `${NAME}.sql`)), false)
  })

  it('автора не придумывает: имя, роль и id — только из журнала базы', () => {
    const body = read('migration', 'yandex', `${NAME}.sql`)
    assert.match(body, /CASE WHEN t\.basis = 'journal' THEN t\.actor END,\s*CASE WHEN t\.basis = 'journal' THEN t\.actor_name END,\s*CASE WHEN t\.basis = 'journal' THEN t\.actor_role END/)
    assert.match(body, /AT TIME ZONE 'Europe\/Moscow'/)
  })
})
