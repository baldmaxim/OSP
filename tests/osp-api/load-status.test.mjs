// Две страховки переноса данных на стороне сервера (server/osp-api/src/lib):
//   • loadStatus — какая копия лежит в базе: репетиция или рабочая. У репетиции хранилище файлов и вход
//     общие с рабочим порталом, поэтому, пока копия не рабочая, сервер их не меняет. Главное свойство —
//     любое сомнение (нет подключения, нет отметки, сбой, незавершённая загрузка) читается как «не рабочая»;
//   • writeBarrier — файл-переключатель «только чтение», общий для шлюза данных и маршрута файлов.
// Как этим пользуются маршруты — tests/osp-api/db-gateway.test.mjs; тот же запрос на настоящей базе —
// tests/backup/target-single-owner.test.mjs.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLoadStatus, createdAfterLoad, isFinalLoad, LOAD_STATUS_SQL, LOAD_STATUS_TTL_MS } from '../../server/osp-api/src/lib/loadStatus.js'
import { createWriteBarrier, READONLY_CODE } from '../../server/osp-api/src/lib/writeBarrier.js'

// «База»: запоминает, как её спросили, и отвечает заданными строками либо бросает.
function fakeDb(answer) {
  const calls = []
  return {
    calls,
    read: async (who, fn) => {
      const call = { who, sql: [] }
      calls.push(call)
      return fn({ query: async (text, values) => {
        call.sql.push([text, values])
        const rows = typeof answer.rows === 'function' ? answer.rows() : answer.rows
        if (rows instanceof Error) throw rows
        return { rows }
      } })
    },
  }
}

describe('osp-api: какая копия данных за шлюзом (loadStatus)', () => {
  it('читает последнюю отметку загрузки служебной читающей операцией', async () => {
    const db = fakeDb({ rows: [{ status: 'rehearsal', finished_at: new Date('2026-10-13T09:45:00Z') }] })
    const state = await createLoadStatus({ db }).current()
    assert.equal(state.status, 'rehearsal')
    assert.equal(state.loadedAt.toISOString(), '2026-10-13T09:45:00.000Z')
    assert.deepEqual(db.calls, [{ who: null, sql: [[LOAD_STATUS_SQL, undefined]] }], 'одна команда, без пользователя, через db.read')
    assert.match(LOAD_STATUS_SQL, /^select status, finished_at from osp_meta\.load_log order by id desc limit 1$/)
  })

  it('рабочая копия — только явная отметка final с завершённой загрузкой', async () => {
    const at = '2026-10-13T20:00:00+00:00'
    const state = await createLoadStatus({ db: fakeDb({ rows: [{ status: 'final', finished_at: at }] }) }).current()
    assert.deepEqual([state.status, isFinalLoad(state)], ['final', true])
    assert.equal(state.loadedAt.getTime(), Date.parse(at))
  })

  it('любое сомнение — «не рабочая»: защита файлов и учёток включена', async () => {
    const doubtful = [
      null, // подключения к базе нет
      fakeDb({ rows: [] }), // отметки нет
      fakeDb({ rows: [{ status: 'final', finished_at: null }] }), // загрузка не завершена
      fakeDb({ rows: [{ status: 'final', finished_at: 'не дата' }] }),
      fakeDb({ rows: [{ status: 'FINAL', finished_at: new Date() }] }), // не то значение
      fakeDb({ rows: [{ status: 'done', finished_at: new Date() }] }),
      fakeDb({ rows: Object.assign(new Error('relation "osp_meta.load_log" does not exist'), { code: '42P01' }) }),
      fakeDb({ rows: new Error('connection terminated') }),
    ]
    for (const db of doubtful) {
      const state = await createLoadStatus({ db }).current()
      assert.deepEqual([state.status, state.loadedAt, isFinalLoad(state)], ['unknown', null, false])
    }
    for (const bad of [null, undefined, {}, { status: 'rehearsal' }, { status: 'unknown' }, 'final']) assert.equal(isFinalLoad(bad), false)
  })

  it('память короткая; сбой не запоминается; одновременные запросы — одно чтение', async () => {
    let clock = 1_000_000
    let rows = [{ status: 'rehearsal', finished_at: new Date('2026-10-13T09:45:00Z') }]
    const db = fakeDb({ rows: () => rows })
    const status = createLoadStatus({ db, now: () => clock })
    const together = await Promise.all([status.current(), status.current(), status.current()])
    assert.deepEqual([together.map((s) => s.status), db.calls.length], [['rehearsal', 'rehearsal', 'rehearsal'], 1])
    // Настоящая загрузка: в пределах памяти сервер ещё считает копию репетицией (безопасная сторона).
    rows = [{ status: 'final', finished_at: new Date('2026-10-13T20:00:00Z') }]
    clock += LOAD_STATUS_TTL_MS - 1
    assert.equal((await status.current()).status, 'rehearsal')
    clock += 2
    assert.equal((await status.current()).status, 'final')
    assert.equal(db.calls.length, 2)
    // База перестала отвечать: «рабочая» из памяти не продлевается дольше её срока.
    rows = new Error('timeout')
    clock += LOAD_STATUS_TTL_MS + 1
    assert.equal((await status.current()).status, 'unknown')
    assert.equal((await status.current()).status, 'unknown')
    assert.equal(db.calls.length, 4, 'сбой не запоминается — следующий запрос спрашивает снова')
    rows = [{ status: 'final', finished_at: new Date('2026-10-13T20:00:00Z') }]
    assert.equal((await status.current()).status, 'final')
  })

  it('сбой чтения попадает в журнал без текста запроса и адресов', async () => {
    const warnings = []
    const db = fakeDb({ rows: Object.assign(new Error('x'.repeat(500)), { code: '57014' }) })
    await createLoadStatus({ db, logger: { warn: (fields, msg) => warnings.push([fields, msg]) } }).current()
    assert.equal(warnings.length, 1)
    assert.deepEqual([warnings[0][0].code, warnings[0][0].msg.length, warnings[0][1]], ['57014', 120, 'load status'])
  })
})

describe('osp-api: документ создан в репетиции или пришёл с рабочими данными', () => {
  it('«после загрузки» — только при двух понятных датах и строго позже', () => {
    const loaded = new Date('2026-10-13T09:45:00Z')
    assert.equal(createdAfterLoad('2026-10-13T12:00:00.123456+00:00', loaded), true)
    assert.equal(createdAfterLoad('2026-10-13T14:45:00.5+05:00', loaded), true, 'другой пояс — тот же момент времени')
    assert.equal(createdAfterLoad('2026-10-13T09:45:00+00:00', loaded), false, 'тот же момент — не «после»')
    assert.equal(createdAfterLoad('2026-09-01T08:00:00+00:00', loaded), false)
    for (const [created, at] of [[undefined, loaded], [null, loaded], ['', loaded], ['не дата', loaded], ['2026-10-13T12:00:00Z', null], ['2026-10-13T12:00:00Z', undefined], ['2026-10-13T12:00:00Z', 'не дата']]) {
      assert.equal(createdAfterLoad(created, at), false, `${created} / ${at}`)
    }
  })
})

describe('osp-api: барьер записи (writeBarrier)', () => {
  it('файл-переключатель: есть — только чтение; перечитывается не чаще заданного', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-barrier-'))
    try {
      const file = path.join(dir, 'db-readonly')
      let clock = 0
      const isReadOnly = createWriteBarrier({ file, intervalMs: 1000, now: () => clock })
      assert.equal(isReadOnly(), false)
      fs.writeFileSync(file, '')
      assert.equal(isReadOnly(), false, 'в пределах секунды — прежний ответ')
      clock += 1001
      assert.equal(isReadOnly(), true)
      fs.rmSync(file)
      clock += 1001
      assert.equal(isReadOnly(), false)
      assert.equal(READONLY_CODE, 'OSP_READONLY')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('не задан или шлюз выключен — барьера нет; каталог недоступен — служба не запускается', () => {
    assert.equal(createWriteBarrier({ file: '' })(), false)
    assert.equal(createWriteBarrier({ file: '/nonexistent-dir/db-readonly', enabled: false })(), false)
    assert.equal(createWriteBarrier()(), false)
    assert.throws(() => createWriteBarrier({ file: '/nonexistent-dir-osp/db-readonly' }), /каталог файла-переключателя барьера записи/)
  })
})
