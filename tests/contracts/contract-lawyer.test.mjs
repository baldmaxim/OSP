// «Ответственный юрист» договора — действующий юрист ОСП (решение пользователя 23.11.2026, миграция 20270226_registry_osp_lawyers):
// правило показа и выбора (src/utils/contractLawyer.js) и импорт из Excel (src/utils/contractsImport.js) — по ФИО полностью или
// началом, только если юрист один; не юрист и заблокированный — ошибка строки; в запись идёт responsible_user_id, прежнего поля нет.
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'
import {
  LAWYER_FIELD, contractLawyerName, contractLawyerSaveError, lawyerOptions, matchLawyerByName, personKey, shownLawyerId,
} from '../../src/utils/contractLawyer.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// Справочник, как его отдаёт list_osp_lawyers (только юристы), плюс не юрист — правило не должно ему верить.
const people = new Map([
  ['law-1', { user_id: 'law-1', display_name: 'Юристова Юлия Юрьевна', full_name: 'Юристова Юлия Юрьевна', role: 'lawyer' }],
  ['law-2', { user_id: 'law-2', display_name: 'Правова Анна Сергеевна', full_name: 'Правова Анна Сергеевна', role: 'lawyer' }],
  ['law-3', { user_id: 'law-3', display_name: 'Правова Мария Ивановна', full_name: 'Правова Мария Ивановна', role: 'lawyer' }],
  ['law-4', { user_id: 'law-4', display_name: 'Ёлкина Ольга', full_name: 'Ёлкина Ольга', role: 'lawyer' }],
  ['eco-1', { user_id: 'eco-1', display_name: 'Экономистова Эльвира', full_name: 'Экономистова Эльвира', role: 'admin' }],
])

describe('юрист договора: показ и выбор', () => {
  it('показывается только действующий юрист ОСП; остальные — пусто', () => {
    assert.equal(shownLawyerId({ [LAWYER_FIELD]: 'law-1' }, people), 'law-1')
    assert.equal(shownLawyerId({ [LAWYER_FIELD]: 'eco-1' }, people), '', 'не юрист')
    assert.equal(shownLawyerId({ [LAWYER_FIELD]: 'law-blocked' }, people), '', 'заблокированного в списке нет')
    assert.equal(shownLawyerId({ responsible_contact_id: 'c-1' }, people), '', 'прежнее поле не читается')
    assert.equal(shownLawyerId(null, people), '')
    assert.equal(contractLawyerName({ [LAWYER_FIELD]: 'law-2' }, people), 'Правова Анна Сергеевна')
    assert.equal(contractLawyerName({ [LAWYER_FIELD]: 'eco-1' }, people), '')
  })

  it('выбор — только юристы ОСП, по алфавиту', () => {
    assert.deepEqual(lawyerOptions(people).map((o) => o.value), ['law-4', 'law-2', 'law-3', 'law-1'], '«Ё» — как «Е»')
    assert.deepEqual(lawyerOptions(new Map()), [])
  })

  it('отказ записи: колонки нет — называем миграцию; отказ базы — её текст', () => {
    assert.match(contractLawyerSaveError({ code: 'PGRST204', message: "Could not find the 'responsible_user_id' column of 'contracts'" }),
      /не применена миграция 20270226_registry_osp_lawyers/)
    assert.equal(contractLawyerSaveError({ code: '23514', message: 'Ответственным юристом можно назначить только действующего юриста ОСП' }),
      'Ошибка: Ответственным юристом можно назначить только действующего юриста ОСП')
  })
})

describe('юрист договора: сопоставление по ФИО', () => {
  it('полностью, началом в обе стороны, без регистра, «ё» = «е», лишние пробелы', () => {
    assert.equal(personKey('  Ёлкина   ОЛЬГА '), 'елкина ольга')
    assert.deepEqual(matchLawyerByName('Юристова Юлия Юрьевна', people), { id: 'law-1' })
    assert.deepEqual(matchLawyerByName('юристова  юлия', people), { id: 'law-1' }, '«Фамилия Имя» → полное ФИО')
    assert.deepEqual(matchLawyerByName('Елкина Ольга Петровна', people), { id: 'law-4' }, 'полное ФИО → учётка «Фамилия Имя»')
    assert.deepEqual(matchLawyerByName('', people), { id: null })
  })

  it('двое совпавших, не юрист, не найден, часть слова — ошибка, а не первый попавшийся', () => {
    assert.match(matchLawyerByName('Правова', people).error, /несколько/)
    assert.match(matchLawyerByName('Экономистова Эльвира', people).error, /не найден/i)
    assert.match(matchLawyerByName('Уволенов Борис', people).error, /не найден/i)
    assert.match(matchLawyerByName('Юрист', people).error, /не найден/i, '«Юрист» — не начало слова «Юристова»')
  })
})

describe('импорт договоров из Excel: «Ответственный юрист»', () => {
  let imp
  before(async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osp-contracts-lawyer-')), 'contractsImport.mjs')
    await esbuild.build({
      entryPoints: [path.join(REPO, 'src', 'utils', 'contractsImport.js')],
      bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent', external: ['xlsx'], absWorkingDir: REPO,
    })
    const code = fs.readFileSync(out, 'utf8').replaceAll('from "xlsx"', `from ${JSON.stringify(pathToFileURL(path.join(REPO, 'node_modules', 'xlsx', 'xlsx.mjs')).href)}`)
    fs.writeFileSync(out, code)
    imp = await import(pathToFileURL(out).href)
  })
  const ctx = () => ({
    docIndex: { byId: new Map(), byDisplayId: new Map(), childrenOf: new Map() },
    cpByInn: new Map([['123456789012', ['cp-1']]]), cpByName: new Map(), cpDeletedByInn: new Map(), cpDeletedByName: new Map(),
    objByName: new Map([['жк алия', ['obj-1']]]), lawyers: people, existingNumbers: new Set(), amendmentNumbers: new Set(),
  })
  const raw = (over) => ({
    record_type: 'Договор', contract_number: 'СУ-1', contract_date: '15.02.2026', status: 'В работе',
    counterparty_inn: '123456789012', object_name: 'ЖК Алия', ...over,
  })

  it('юрист ОСП по ФИО — в записи responsible_user_id, прежнего поля нет', () => {
    const res = imp.validateRow(raw({ lawyer: 'Юристова Юлия' }), ctx())
    assert.deepEqual(res.errors, [])
    assert.equal(res.payload.responsible_user_id, 'law-1')
    assert.equal('responsible_contact_id' in res.payload, false)
  })

  it('без юриста — поля нет вовсе (до миграции колонки нет); не юрист и неоднозначный — ошибка строки', () => {
    const empty = imp.validateRow(raw({ lawyer: '' }), ctx())
    assert.deepEqual(empty.errors, [])
    assert.equal(LAWYER_FIELD in empty.payload, false)
    assert.equal('responsible_contact_id' in empty.payload, false)
    const notLawyer = imp.validateRow(raw({ lawyer: 'Экономистова Эльвира' }), ctx())
    assert.deepEqual(notLawyer.errors.map((e) => e.key), ['lawyer'])
    assert.match(notLawyer.errors[0].message, /^Ответственный юрист: не найден среди действующих юристов ОСП$/)
    assert.match(imp.validateRow(raw({ lawyer: 'Правова' }), ctx()).errors[0].message, /несколько юристов ОСП/)
  })
})
