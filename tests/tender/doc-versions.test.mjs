// Версии файлов списка (src/utils/docVersions.js, s3_documents.version_group_id, миграция 20270307; решение пользователя 26.11.2026):
// группы, номера по дате загрузки (удаление — номера подряд, порядок прежний), текущая версия, подсказка «новая версия». Без базы
// и браузера. Окно — tests/tender/doc-versions-ui.test.mjs, база — tests/tender/doc-versions-db.test.mjs.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  currentVersions, currentWithVersionIds, hasVersionColumn, isMissingVersionColumn, suggestVersionGroup, versionGroups, versionlessName,
  withoutOlderVersions,
} from '../../src/utils/docVersions.js'
import { versionlessName as supplyVersionless } from '../../src/utils/supplyVorVersions.js'

const doc = (id, name, at, group = null) => ({ id, file_name: name, created_at: at, version_group_id: group })
const shape = (groups) => groups.map((g) => [g.current.id, g.versions.map((v) => `${v.doc.id}:${v.no}`)])

describe('Версии файлов: группы и номера', () => {
  it('номер — по времени загрузки в группе, текущая — последняя; файл без группы и группа из одного — обычный файл', () => {
    const docs = [
      doc('b', 'ВОР 2026-11-20.xlsx', '2026-11-20T10:00:00Z', 'G'),
      doc('x', 'ВОР корпус 2.xlsx', '2026-10-15T10:00:00Z'),
      doc('a', 'ВОР 2026-10-09.xlsx', '2026-10-09T10:00:00Z', 'G'),
      doc('s', 'Отделён.xlsx', '2026-11-01T10:00:00Z', 'LONE'),
    ]
    const groups = versionGroups(docs)
    // Сначала группы с самой свежей текущей версией — как прежний список «новые сверху».
    assert.deepEqual(shape(groups), [['b', ['a:1', 'b:2']], ['s', ['s:1']], ['x', ['x:1']]])
    assert.deepEqual(currentVersions(docs).map((d) => d.id), ['b', 's', 'x'])
    assert.deepEqual(currentWithVersionIds(docs).map((d) => [d.id, d.version_ids]), [['b', ['a', 'b']], ['s', ['s']], ['x', ['x']]])
  })

  it('удалили версию — следующие сдвигаются, номера подряд, порядок прежний', () => {
    const all = [
      doc('v1', 'ВОР.xlsx', '2026-10-01T10:00:00Z', 'G'),
      doc('v2', 'ВОР изм.1.xlsx', '2026-10-05T10:00:00Z', 'G'),
      doc('v3', 'ВОР изм.2.xlsx', '2026-10-09T10:00:00Z', 'G'),
    ]
    assert.deepEqual(shape(versionGroups(all)), [['v3', ['v1:1', 'v2:2', 'v3:3']]])
    assert.deepEqual(shape(versionGroups(all.filter((d) => d.id !== 'v2'))), [['v3', ['v1:1', 'v3:2']]])
    // Удалили текущую — текущей стала предыдущая.
    assert.deepEqual(shape(versionGroups(all.filter((d) => d.id !== 'v3'))), [['v2', ['v1:1', 'v2:2']]])
    // Удалили первую — группа держится без неё.
    assert.deepEqual(shape(versionGroups(all.filter((d) => d.id !== 'v1'))), [['v3', ['v2:1', 'v3:2']]])
  })

  it('одна миллисекунда — по микросекундам базы, затем по id (как bid_vor_superseded: created_at, id)', () => {
    const g = versionGroups([
      doc('b', 'b', '2026-10-01T10:00:00.123457+00:00', 'G'),
      doc('a', 'a', '2026-10-01T10:00:00.123456+00:00', 'G'),
    ])
    assert.deepEqual(shape(g), [['b', ['a:1', 'b:2']]])
    assert.deepEqual(shape(versionGroups([doc('d', 'd', '2026-10-01T10:00:00Z', 'G'), doc('c', 'c', '2026-10-01T10:00:00Z', 'G')])), [['d', ['c:1', 'd:2']]])
  })

  it('колонка версий: есть ключ в строке — есть; ответ базы без колонки узнаётся', () => {
    assert.equal(hasVersionColumn([doc('a', 'a', '2026-10-01T00:00:00Z')]), true)
    assert.equal(hasVersionColumn([{ id: 'a', file_name: 'a' }]), false)
    assert.equal(hasVersionColumn([]), false)
    assert.equal(isMissingVersionColumn({ code: '42703', message: 'column s3_documents.version_group_id does not exist' }), true)
    assert.equal(isMissingVersionColumn({ code: 'PGRST204', message: "Could not find the 'version_group_id' column of 's3_documents'" }), true)
    assert.equal(isMissingVersionColumn({ code: '42703', message: 'column s3_documents.folder_date does not exist' }), false)
  })
})

describe('Версии файлов: подсказка «новая версия»', () => {
  const groups = versionGroups([
    doc('ov', 'ВОР ОВ.xlsx', '2026-10-01T00:00:00Z'),
    doc('d1', 'ВОР 2026-10-09.xlsx', '2026-10-09T00:00:00Z'),
    doc('k2', 'ВОР корпус 2.xlsx', '2026-10-10T00:00:00Z'),
    doc('k3', 'ВОР корпус 3.xlsx', '2026-10-10T00:00:00Z'),
  ])
  const hit = (name) => suggestVersionGroup(name, groups)?.current.id || null

  it('то же имя без отметок редакции и тот же вид файла — подсказка; иначе — нет', () => {
    assert.equal(hit('ВОР ОВ изм.1.xlsx'), 'ov')
    assert.equal(hit('ВОР_ОВ v2.xlsm'), 'ov')
    assert.equal(hit('ВОР 2026-11-20.xlsx'), 'd1')
    assert.equal(hit('ВОР ОВ.xlsx'), 'ov', 'то же имя — тоже версия (загрузили исправленный файл)')
    assert.equal(hit('ВОР ОВ.pdf'), null, 'PDF рядом с Excel — не версия')
    assert.equal(hit('ВОР корпус 4.xlsx'), null, 'номер корпуса — не отметка редакции')
    assert.equal(hit('ВОР ВК.xlsx'), null)
  })

  it('похожих несколько — не угадываем', () => {
    const two = versionGroups([doc('a', 'ВОР ОВ.xlsx', '2026-10-01T00:00:00Z'), doc('b', 'ВОР ОВ (1).xlsx', '2026-10-02T00:00:00Z')])
    assert.equal(suggestVersionGroup('ВОР ОВ изм.2.xlsx', two), null)
  })

  it('имя без редакции — то же, что у снабжения (вопрос «новая версия?»)', () => {
    assert.equal(supplyVersionless, versionlessName)
    assert.equal(versionlessName('ЗИЛ лот 33 ВОР ЭН от 03.11.2026 версия 2'), versionlessName('ЗИЛ лот 33 ВОР ЭН'))
  })
})

describe('Версии файлов: список подрядчику', () => {
  it('без прежних версий: в группе — последняя книга Excel и последний прочий файл; без группы — все, порядок прежний', () => {
    const list = [
      doc('v3', 'ВОР изм.2.pdf', '2026-10-12T00:00:00Z', 'G'),
      doc('v2', 'ВОР изм.1.xlsx', '2026-10-10T00:00:00Z', 'G'),
      doc('k', 'ВОР кровля.xlsx', '2026-10-09T00:00:00Z'),
      doc('v1', 'ВОР.xlsx', '2026-10-01T00:00:00Z', 'G'),
      doc('p', 'Пакет.pdf', '2026-09-01T00:00:00Z'),
    ]
    assert.deepEqual(withoutOlderVersions(list).map((d) => d.id), ['v3', 'v2', 'k', 'p'])
    assert.deepEqual(withoutOlderVersions(list.map((d) => ({ ...d, version_group_id: undefined }))).map((d) => d.id), ['v3', 'v2', 'k', 'v1', 'p'])
  })
})
