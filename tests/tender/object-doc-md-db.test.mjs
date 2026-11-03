// Файл .md документа объекта (миграция 20261202), на слепке схемы прода: проверка до миграции — FAIL, а не ошибка; выборка
// страницы через настоящий PostgREST — до миграции PGRST200 (страница показывает карточку без столбца), после — файл в
// строке документа; правит сотрудник, подрядчику строка не видна; удалили файл — связь обнулилась, документ на месте; откат
// оставляет файлы. Второй блок — то же на копии прода как база Яндекса (одна учётка, настоящий migrate.sh с проверками
// прав). Страница — object-doc-md.test.mjs. Нужны Docker и psql; образ PostgREST — для запроса страницы.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'

const NAME = '20261202_object_documents_md'
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', `${NAME}.sql`)
const YANDEX_CHECK = path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20261202.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)

const U = {
  engineer: '00000000-0000-4000-8000-0000000f1a01',
  contractor: '00000000-0000-4000-8000-0000000f1a02',
}
const CP = '00000000-0000-4000-8000-0000000f2a01'
const OBJ = '00000000-0000-4000-8000-0000000f3a01'
const DOC = '00000000-0000-4000-8000-0000000f4a01'
const FILE = '00000000-0000-4000-8000-0000000f5a01'

const SEED_OBJECT = `
  insert into public.counterparties (id, name) values ('${CP}', 'ООО Файлы');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id) values
    ('${U.engineer}', 'engineer', true, false, 'Инженеров И. И.', 'i@example.invalid', null),
    ('${U.contractor}', 'contractor', true, false, 'Подрядов П. П.', 'c@example.invalid', '${CP}');
  insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Файловый', 'Москва', 'main_construction');
  insert into public.object_documents (id, object_id, document_type, name) values ('${DOC}', '${OBJ}', 'general_contract', 'Договор');`
const INSERT_FILE = `insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category)
  values ('${FILE}', 'object', '${OBJ}', 'objects/${OBJ}/договор.md', 'Договор.md', 'object_doc_md')`
const LINK = `update public.object_documents set md_s3_document_id = '${FILE}' where id = '${DOC}' returning id`
const LINKED = `select coalesce(md_s3_document_id::text, 'нет') from public.object_documents where id = '${DOC}'`

// Те же столбцы, что запрашивает страница (src/services/objectDocMd.js), — ровно как PostgREST получает их в адресе.
const service = fs.readFileSync(path.join(ROOT, 'src', 'services', 'objectDocMd.js'), 'utf8')
const PLAIN = /const DOC_COLUMNS = '([^']+)'/.exec(service)[1]
assert.match(service, /const DOC_COLUMNS_MD = `\$\{DOC_COLUMNS\}, md:s3_documents!md_s3_document_id\(\*\)`/)
const WITH_MD = `${PLAIN}, md:s3_documents!md_s3_document_id(*)`

const PGRST_VERSION = /^VERSION=(\S+)$/m.exec(fs.readFileSync(path.join(ROOT, 'deploy', 'postgrest', 'install.sh'), 'utf8'))[1]
const PGRST_IMAGE = `postgrest/postgrest:v${PGRST_VERSION}`
const hasPostgrest = () => spawnSync('docker', ['image', 'inspect', PGRST_IMAGE], { stdio: 'ignore' }).status === 0

async function startPostgrest(dbPort) {
  const port = 30000 + Math.floor(Math.random() * 1000)
  const name = `osp-test-pgrst-md-${process.pid}-${port}`
  // Без токена — от имени владельца: здесь проверяется, как шлюз разбирает встраивание; правила по строкам — отдельно, ниже.
  const started = spawnSync('docker', ['run', '-d', '--rm', '--name', name, '--network', 'host',
    '-e', `PGRST_DB_URI=postgres://postgres@127.0.0.1:${dbPort}/postgres`, '-e', 'PGRST_DB_SCHEMAS=public',
    '-e', 'PGRST_DB_ANON_ROLE=postgres', '-e', `PGRST_SERVER_PORT=${port}`, PGRST_IMAGE], { encoding: 'utf8' })
  assert.equal(started.status, 0, started.stderr)
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 120000
  for (;;) {
    const status = await fetch(`${url}/objects?select=id&limit=1`).then((r) => r.status, () => 0)
    if (status === 200) break
    if (Date.now() > deadline) throw new Error(`PostgREST не поднялся (последний ответ ${status})`)
    await new Promise((r) => setTimeout(r, 300))
  }
  const docs = async (columns) => {
    const res = await fetch(`${url}/object_documents?${new URLSearchParams({ select: columns.replaceAll(' ', ''), id: `eq.${DOC}` })}`)
    return { status: res.status, body: await res.json() }
  }
  return {
    docs,
    // Перечитать структуру базы — как scripts/deploy-server.sh migrate. Готово, когда выборка с новой связью ответила.
    reload: async (columns, want) => {
      spawnSync('docker', ['kill', '-s', 'SIGUSR1', name], { stdio: 'ignore' })
      const until = Date.now() + 30000
      for (;;) {
        const { status } = await docs(columns)
        if (status === want) return
        if (Date.now() > until) throw new Error(`структура не перечитана: ответ ${status}, ждали ${want}`)
        await new Promise((r) => setTimeout(r, 200))
      }
    },
    stop: () => spawnSync('docker', ['rm', '-fv', name], { stdio: 'ignore' }),
  }
}

describe('Файл .md документа объекта — база', { skip: skipReason(), timeout: 600000 }, () => {
  let db
  let pgrst
  let checkBefore = ''
  let noMigration = null
  const sql = (text) => psqlAt(db.port, text)
  const as = (uid, text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)

  before(async () => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    sql(SEED_OBJECT)
    if (hasPostgrest()) {
      pgrst = await startPostgrest(db.port)
      noMigration = await pgrst.docs(WITH_MD)
    }
    psqlAt(db.port, null, { file: MIGRATION })
    await pgrst?.reload(WITH_MD, 200)
  })
  after(() => {
    pgrst?.stop()
    db?.stop()
  })

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK; повтор миграции безопасен', () => {
    assert.match(checkBefore, /^FAIL /m)
    assert.equal(checkBefore.split('\n').filter((l) => /^(OK|FAIL) /.test(l)).length, 4)
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 4, out)
  })

  it('выборка страницы: до миграции — PGRST200 (страница читает без столбца), после — файл в строке документа', { skip: !hasPostgrest() && `нет образа ${PGRST_IMAGE}` }, async () => {
    assert.equal(noMigration.status, 400)
    assert.equal(noMigration.body.code, 'PGRST200', 'этот код страница считает «миграции нет»')

    const empty = await pgrst.docs(WITH_MD)
    assert.equal(empty.status, 200)
    assert.equal(empty.body[0].md, null)

    sql(INSERT_FILE)
    sql(LINK)
    const linked = await pgrst.docs(WITH_MD)
    assert.equal(linked.status, 200, JSON.stringify(linked.body))
    assert.equal(linked.body[0].md.file_name, 'Договор.md')
    assert.equal(linked.body[0].md.doc_category, 'object_doc_md')
    assert.equal(linked.body[0].signed, null, 'две другие связи с той же таблицей — по прежним колонкам')
    sql(`update public.object_documents set md_s3_document_id = null where id = '${DOC}'; delete from public.s3_documents where id = '${FILE}'`)
  })

  it('привязывает сотрудник; подрядчику строка документа недоступна', () => {
    sql(INSERT_FILE)
    assert.equal(as(U.contractor, LINK), '', 'запись не задела строку')
    assert.equal(sql(LINKED), 'нет')
    assert.equal(as(U.engineer, LINK), DOC)
    assert.equal(sql(LINKED), FILE)
  })

  it('удалили файл — связь обнуляется сама, документ на месте', () => {
    as(U.engineer, `delete from public.s3_documents where id = '${FILE}'`)
    assert.equal(sql(LINKED), 'нет')
    assert.equal(sql(`select count(*) from public.s3_documents where id = '${FILE}'`), '0')
  })

  it('откат: колонки нет, загруженные файлы остаются', async () => {
    sql(INSERT_FILE)
    sql(LINK)
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql(`select count(*) from information_schema.columns where table_name = 'object_documents' and column_name = 'md_s3_document_id'`), '0')
    assert.equal(sql(`select count(*) from public.s3_documents where id = '${FILE}'`), '1')
    assert.equal(sql(`select count(*) from public.object_documents where id = '${DOC}'`), '1')
    await pgrst?.reload(WITH_MD, 400)
    if (pgrst) assert.equal((await pgrst.docs(PLAIN)).status, 200, 'страница читает без столбца')
    // Повтор отката безопасен.
    psqlAt(db.port, null, { file: ROLLBACK })
  })
})

describe('Файл .md документа объекта — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  // Запрос от имени вошедшего, как его передаёт шлюз: роль и пользователь — в токене (osp_role, sub).
  const as = (sub, text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify({ osp_role: 'authenticated', sub })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-doc-md-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 20 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, new RegExp(`OK ${NAME}: применена`))
    internal(SEED_OBJECT)
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('проверка миграции на копии: все OK', () => {
    const out = internal(fs.readFileSync(YANDEX_CHECK, 'utf8'))
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 4, out)
  })

  it('привязывает сотрудник, подрядчику строка недоступна; удалили файл — связь обнуляется и при правилах на владельца', () => {
    internal(INSERT_FILE)
    assert.equal(as(U.contractor, LINK), '', 'запись не задела строку')
    assert.equal(internal(LINKED), 'нет')
    assert.equal(as(U.engineer, LINK), DOC)
    assert.equal(internal(LINKED), FILE)
    as(U.engineer, `delete from public.s3_documents where id = '${FILE}'`)
    assert.equal(internal(LINKED), 'нет')
    assert.equal(internal(`select count(*) from public.object_documents where id = '${DOC}'`), '1')
  })
})
