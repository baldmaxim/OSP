// Две миграции 18.11.2026 на слепке схемы прода и копии прода как базе Яндекса.
//  • 20270217_tenders_restart_link — у тендера «Перезапуск» ссылка на тендер, который его заменил: колонка, ссылка на себя
//    запрещена, безвозвратно удалили новый — ссылка пустеет; выборки страниц (реестр и карточка) через настоящий PostgREST
//    остаются однозначными со второй связью tenders → tenders (PGRST201 был бы только на проде).
//  • 20270218_doc_check_marks_reset — цвет и приоритет заявок на проверку ДП/ДС сброшены у всех (удалённых и архива тоже),
//    updated_at не сдвинулся, прежние значения сохранены, триггер updated_at снова работает; откат возвращает их.
// Проверки для прода до миграции — FAIL, а не ошибка; повтор безопасен. Третий блок — копия прода, настоящий migrate.sh с
// проверкой прав и .check.sql. Нужны Docker и psql; образ PostgREST — для выборок страниц. Страницы —
// tenders-restart-blacklist.test.mjs и doc-check-board.test.mjs.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'

const RESTART = '20270217_tenders_restart_link'
const MARKS = '20270218_doc_check_marks_reset'
const file = (...p) => path.join(ROOT, ...p)
const SB = (name) => file('supabase', 'migrations', `${name}.sql`)
const YA = (name) => file('migration', 'yandex', `${name}.sql`)
const YA_CHECK = (name) => file('migration', 'yandex', `${name}.check.sql`)
const CHECK = (date) => file('migration', 'backup', 'checks', `${date}.sql`)
const ROLLBACK = (name) => file('migration', 'rollback', `${name}_rollback.sql`)
const read = (p) => fs.readFileSync(p, 'utf8')

const T = {
  old: '00000000-0000-4000-8000-00000000e001',
  next: '00000000-0000-4000-8000-00000000e002',
  other: '00000000-0000-4000-8000-00000000e003',
  gone: '00000000-0000-4000-8000-00000000e004',
}
const R = {
  red: '00000000-0000-4000-8000-00000000e101',
  high: '00000000-0000-4000-8000-00000000e102',
  gone: '00000000-0000-4000-8000-00000000e103',
  archived: '00000000-0000-4000-8000-00000000e104',
  plain: '00000000-0000-4000-8000-00000000e105',
}
const SEED = `
  insert into public.tenders (id, work_description, status, public_tender_number) values
    ('${T.old}', 'Фасад', 'Перезапуск', 9040), ('${T.next}', 'Фасад (перезапуск тендера № 9040)', 'Идет тендерная процедура', 9984),
    ('${T.other}', 'Кровля', 'Завершен', 9985);
  insert into public.doc_check_requests (id, doc_type, created_by_name, updated_at, priority, color, deleted_at, archived_at) values
    ('${R.red}', 'ds', 'Импорт', '2026-05-01T10:00:00Z', null, 'red', null, null),
    ('${R.high}', 'dp', 'Импорт', '2026-05-02T10:00:00Z', 'high', 'yellow', null, null),
    ('${R.gone}', 'ds', 'Импорт', '2026-05-03T10:00:00Z', 'low', null, '2026-05-04T10:00:00Z', null),
    ('${R.archived}', 'ds', 'Импорт', '2026-05-05T10:00:00Z', 'normal', 'blue', null, '2026-05-06T10:00:00Z'),
    ('${R.plain}', 'ds', 'Импорт', '2026-05-07T10:00:00Z', null, null, null, null);`
const IDS = Object.values(R).map((id) => `'${id}'`).join(',')
const MARKS_NOW = `select string_agg(right(id::text, 4) || '=' || coalesce(priority, '-') || '/' || coalesce(color, '-'), ' ' order by id)
  from public.doc_check_requests where id in (${IDS})`
const STAMPS = `select string_agg(right(id::text, 4) || '=' || to_char(updated_at at time zone 'UTC', 'MM-DD HH24'), ' ' order by id)
  from public.doc_check_requests where id in (${IDS})`
const MARKS_BEFORE = 'e101=-/red e102=high/yellow e103=low/- e104=normal/blue e105=-/-'
const STAMPS_BEFORE = 'e101=05-01 10 e102=05-02 10 e103=05-03 10 e104=05-05 10 e105=05-07 10'
const okLines = (out) => out.split('\n').filter((l) => l.startsWith('OK ')).length

// Выборки страниц — ровно те, что в коде: реестр (TENDER_LIST_SELECT) и карточка тендера.
const LIST_SELECT = /const TENDER_LIST_SELECT = '([^']+)'/.exec(read(file('src', 'pages', 'TendersPage.jsx')))[1]
const CARD_SELECT = /\.from\('tenders'\)\s*\.select\('(\*, objects\(name, status, address, map_link\)[^']+)'\)/
  .exec(read(file('src', 'pages', 'TenderDetailPage.jsx')))[1]

const PGRST_VERSION = /^VERSION=(\S+)$/m.exec(read(file('deploy', 'postgrest', 'install.sh')))[1]
const PGRST_IMAGE = `postgrest/postgrest:v${PGRST_VERSION}`
const hasPostgrest = () => spawnSync('docker', ['image', 'inspect', PGRST_IMAGE], { stdio: 'ignore' }).status === 0

async function startPostgrest(dbPort) {
  const port = 31000 + Math.floor(Math.random() * 1000)
  const name = `osp-test-pgrst-restart-${process.pid}-${port}`
  const started = spawnSync('docker', ['run', '-d', '--rm', '--name', name, '--network', 'host',
    '-e', `PGRST_DB_URI=postgres://postgres@127.0.0.1:${dbPort}/postgres`, '-e', 'PGRST_DB_SCHEMAS=public',
    '-e', 'PGRST_DB_ANON_ROLE=postgres', '-e', `PGRST_SERVER_PORT=${port}`, PGRST_IMAGE], { encoding: 'utf8' })
  assert.equal(started.status, 0, started.stderr)
  const url = `http://127.0.0.1:${port}`
  const get = async (query) => {
    const res = await fetch(`${url}/tenders?${new URLSearchParams(query)}`)
    return { status: res.status, body: await res.json() }
  }
  const deadline = Date.now() + 120000
  for (;;) {
    const status = await fetch(`${url}/tenders?select=id&limit=1`).then((r) => r.status, () => 0)
    if (status === 200) break
    if (Date.now() > deadline) throw new Error(`PostgREST не поднялся (последний ответ ${status})`)
    await new Promise((r) => setTimeout(r, 300))
  }
  return {
    get,
    // Перечитать структуру базы — как scripts/deploy-server.sh migrate; готово, когда новая колонка видна в фильтре.
    reload: async () => {
      spawnSync('docker', ['kill', '-s', 'SIGUSR1', name], { stdio: 'ignore' })
      const until = Date.now() + 30000
      for (;;) {
        const { status } = await get({ select: 'id', restarted_by_tender_id: `eq.${T.next}` })
        if (status === 200) return
        if (Date.now() > until) throw new Error(`структура не перечитана: ответ ${status}`)
        await new Promise((r) => setTimeout(r, 200))
      }
    },
    stop: () => spawnSync('docker', ['rm', '-fv', name], { stdio: 'ignore' }),
  }
}

describe('Перезапуск тендера, цвета заявок ДП/ДС: файлы', () => {
  const body = (text) => text
    .split('\n').filter((l) => !/^\s*--/.test(l) && !/^\s*(BEGIN|COMMIT|SET LOCAL lock_timeout|NOTIFY pgrst)\b/.test(l)).join('\n').trim()

  it('20270217: тело одно в обеих базах; в базе Яндекса транзакцию задаёт migrate.sh', () => {
    assert.equal(body(read(YA(RESTART))), body(read(SB(RESTART))))
    assert.doesNotMatch(read(YA(RESTART)), /^\s*(BEGIN|COMMIT)\s*;/m)
  })

  it('20270218: сброс один и тот же; прежние значения в обеих базах — в закрытой схеме osp_private, не в public', () => {
    const block = (text) => text.slice(text.indexOf('DO $$'), text.indexOf('$$;') + 3)
    assert.equal(block(read(YA(MARKS))), block(read(SB(MARKS))))
    for (const f of [YA(MARKS), SB(MARKS)]) {
      assert.match(read(f), /CREATE TABLE IF NOT EXISTS osp_private\.doc_check_marks_backup_20270218/)
      assert.doesNotMatch(read(f), /public\.doc_check_marks_backup/, 'в public её видел бы PostgREST (отпечаток прав)')
    }
    assert.match(read(SB(MARKS)), /REVOKE ALL ON osp_private\.doc_check_marks_backup_20270218 FROM PUBLIC, anon, authenticated/)
    assert.doesNotMatch(read(YA(MARKS)), /^\s*(BEGIN|COMMIT)\s*;/m)
    assert.doesNotMatch(read(YA(MARKS)), /DROP COLUMN/, 'колонки остаются: их читает прежняя страница')
  })

  it('обе миграции — в списке кандидатов проверки прав', () => {
    const list = read(file('tests', 'db', 'baseline', 'candidate-migrations.txt'))
    for (const name of [RESTART, MARKS]) assert.match(list, new RegExp(`^${name}\\.sql$`, 'm'))
  })
})

describe('Перезапуск тендера, цвета заявок ДП/ДС: база', { skip: skipReason(), timeout: 600000 }, () => {
  let db
  let pgrst
  let restartCheckBefore = ''
  let marksCheckBefore = ''
  let listBefore = null
  const sql = (text) => psqlAt(db.port, text)

  before(async () => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: SB(m.replace(/\.sql$/, '')) })
    // Колонки доски заявок (priority, color, archived_at) — 20261113, в слепке их нет.
    psqlAt(db.port, null, { file: SB('20261113_doc_check_board') })
    sql(SEED)
    restartCheckBefore = psqlAt(db.port, null, { file: CHECK('20270217') })
    marksCheckBefore = psqlAt(db.port, null, { file: CHECK('20270218') })
    if (hasPostgrest()) {
      pgrst = await startPostgrest(db.port)
      listBefore = await pgrst.get({ select: LIST_SELECT.replaceAll(' ', ''), id: `eq.${T.next}` })
    }
    psqlAt(db.port, null, { file: SB(RESTART) })
    psqlAt(db.port, null, { file: SB(MARKS) })
    await pgrst?.reload()
  })
  after(() => {
    pgrst?.stop()
    db?.stop()
  })

  it('проверки для прода: до миграций — FAIL, а не ошибка; после — все OK', () => {
    assert.match(restartCheckBefore, /^FAIL /m)
    assert.match(marksCheckBefore, /^FAIL /m)
    const restart = psqlAt(db.port, null, { file: CHECK('20270217') })
    assert.doesNotMatch(restart, /^FAIL/m, restart)
    assert.equal(okLines(restart), 5, restart)
    const marks = psqlAt(db.port, null, { file: CHECK('20270218') })
    assert.doesNotMatch(marks, /^FAIL/m, marks)
    assert.equal(okLines(marks), 5, marks)
  })

  it('ссылка «перезапущен тендером»: ставится, на себя — нельзя; удалили новый безвозвратно — ссылка пустеет', () => {
    assert.equal(sql(`update public.tenders set restarted_by_tender_id = '${T.next}' where id = '${T.old}' returning status`), 'Перезапуск')
    assert.throws(() => sql(`update public.tenders set restarted_by_tender_id = id where id = '${T.other}'`), /tenders_restarted_by_not_self/)
    assert.throws(() => sql(`update public.tenders set restarted_by_tender_id = gen_random_uuid() where id = '${T.other}'`),
      /tenders_restarted_by_tender_id_fkey/)
    sql(`update public.tenders set restarted_by_tender_id = '${T.next}' where id = '${T.other}'`)
    assert.equal(sql(`select count(*) from public.tenders where restarted_by_tender_id = '${T.next}'`), '2', 'один новый — несколько прежних')
    // Новый тендер удалили безвозвратно (администратор, «Корзина») — прежний остаётся, ссылка пустеет.
    sql(`insert into public.tenders (id, work_description, public_tender_number) values ('${T.gone}', 'Удалим', 9986)`)
    sql(`update public.tenders set restarted_by_tender_id = '${T.gone}' where id = '${T.other}'`)
    sql(`delete from public.tenders where id = '${T.gone}'`)
    assert.equal(sql(`select coalesce(restarted_by_tender_id::text, 'нет') || ' ' || status from public.tenders where id = '${T.other}'`), 'нет Завершен')
  })

  it('выборки страниц через PostgREST однозначны и со второй связью tenders → tenders', { skip: !hasPostgrest() && `нет образа ${PGRST_IMAGE}` }, async () => {
    assert.equal(listBefore.status, 200, JSON.stringify(listBefore.body))
    const list = await pgrst.get({ select: LIST_SELECT.replaceAll(' ', ''), id: `eq.${T.old}` })
    assert.equal(list.status, 200, JSON.stringify(list.body))
    assert.equal(list.body[0].restarted_by_tender_id, T.next, 'реестр читает ссылку через «*»')
    assert.deepEqual(list.body[0].materials_tender, [])
    const card = await pgrst.get({ select: CARD_SELECT.replaceAll(' ', ''), id: `eq.${T.next}` })
    assert.equal(card.status, 200, JSON.stringify(card.body))
    // Карточка нового: какие прежние он заменил (src/services/tenderRestart.js).
    const from = await pgrst.get({ select: 'id,public_tender_number', restarted_by_tender_id: `eq.${T.next}`, status: 'eq.Перезапуск', deleted_at: 'is.null' })
    assert.equal(from.status, 200, JSON.stringify(from.body))
    assert.deepEqual(from.body.map((t) => t.public_tender_number), [9040])
  })

  it('цвет и приоритет заявок сброшены у всех (удалённых и архива тоже), updated_at не сдвинулся, прежние значения сохранены', () => {
    assert.equal(sql(MARKS_NOW), 'e101=-/- e102=-/- e103=-/- e104=-/- e105=-/-')
    assert.equal(sql(STAMPS), STAMPS_BEFORE)
    assert.equal(sql(`select string_agg(right(request_id::text, 4) || '=' || coalesce(priority, '-') || '/' || coalesce(color, '-'), ' ' order by request_id)
      from osp_private.doc_check_marks_backup_20270218`), 'e101=-/red e102=high/yellow e103=low/- e104=normal/blue')
    assert.equal(sql(`select count(*) from public.doc_check_request_audit_log where request_id in (${IDS})`), '0', 'история заявок не засорена')
  })

  it('триггер updated_at снова работает; повтор обеих миграций безопасен', () => {
    assert.equal(sql(`update public.doc_check_requests set notes = 'x' where id = '${R.plain}' returning updated_at > '2026-06-01'`), 't')
    psqlAt(db.port, null, { file: SB(RESTART) })
    psqlAt(db.port, null, { file: SB(MARKS) })
    assert.equal(sql(`select restarted_by_tender_id from public.tenders where id = '${T.old}'`), T.next)
    assert.equal(sql(`select count(*) from osp_private.doc_check_marks_backup_20270218`), '4')
    assert.equal(sql(`select has_schema_privilege('authenticated', 'osp_private', 'USAGE')::text
      || ' ' || has_schema_privilege('anon', 'osp_private', 'USAGE')::text`), 'false false', 'закрытая схема')
  })

  it('откаты: цвет и приоритет возвращаются (updated_at прежний), ссылки перезапуска нет; повтор безопасен', () => {
    psqlAt(db.port, null, { file: ROLLBACK(MARKS) })
    assert.equal(sql(MARKS_NOW), MARKS_BEFORE)
    assert.equal(sql(`select to_char(updated_at at time zone 'UTC', 'MM-DD HH24') from public.doc_check_requests where id = '${R.red}'`), '05-01 10')
    psqlAt(db.port, null, { file: ROLLBACK(MARKS) })
    psqlAt(db.port, null, { file: ROLLBACK(RESTART) })
    assert.equal(sql(`select count(*) from information_schema.columns where table_name = 'tenders' and column_name = 'restarted_by_tender_id'`), '0')
    assert.equal(sql(`select status from public.tenders where id = '${T.old}'`), 'Перезапуск', 'статус не тронут')
    psqlAt(db.port, null, { file: ROLLBACK(RESTART) })
  })
})

describe('Перезапуск тендера, цвета заявок ДП/ДС — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  let applied = ''
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-restart-marks-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [file('migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 20 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    applied = res.stdout
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('обе миграции применены с проверкой прав; их проверки на копии — все OK', () => {
    assert.match(applied, new RegExp(`OK ${RESTART}: применена`))
    assert.match(applied, new RegExp(`OK ${MARKS}: применена`))
    for (const name of [RESTART, MARKS]) {
      const out = internal(read(YA_CHECK(name)))
      assert.doesNotMatch(out, /^FAIL/m, out)
    }
    assert.equal(internal(`select count(*) from public.doc_check_requests where priority is not null or color is not null`), '0')
  })

  // В копии прода (до колонок доски 20261113) отметок не было — сброс выше прошёл вхолостую. Здесь — по-настоящему: заявки с
  // цветом и приоритетом (удалённая и в архиве тоже) и то же тело миграции под учёткой-владельцем, со всеми триггерами базы
  // Яндекса (FORCE RLS, запрет записи, история, журнал данных).
  it('сброс на базе Яндекса: отметки сняты у всех, updated_at прежний, прежние значения сохранены, история не тронута', () => {
    internal(SEED.slice(SEED.indexOf('insert into public.doc_check_requests')))
    assert.equal(internal(MARKS_NOW), MARKS_BEFORE)
    const history = `select count(*) from public.doc_check_request_audit_log where request_id in (${IDS})`
    const historyBefore = internal(history)
    db.sql(null, { file: YA(MARKS), appName: 'osp:internal' })
    assert.equal(internal(MARKS_NOW), 'e101=-/- e102=-/- e103=-/- e104=-/- e105=-/-')
    assert.equal(internal(STAMPS), STAMPS_BEFORE)
    assert.equal(internal(`select string_agg(right(request_id::text, 4) || '=' || coalesce(priority, '-') || '/' || coalesce(color, '-'), ' ' order by request_id)
      from osp_private.doc_check_marks_backup_20270218 where request_id in (${IDS})`), 'e101=-/red e102=high/yellow e103=low/- e104=normal/blue')
    assert.equal(internal(history), historyBefore, 'вкладка «История» заявок не засорена')
    assert.equal(internal(`select tgenabled from pg_trigger where tgrelid = 'public.doc_check_requests'::regclass
      and tgname = 'trg_doc_check_requests_updated_at'`), 'O')
    const out = internal(read(YA_CHECK(MARKS)))
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(okLines(out), 5, out)
  })
})
