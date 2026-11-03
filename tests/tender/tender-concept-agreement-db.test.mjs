// Запрет завершения тендера основного строительства без победителя и подписанного понятийного соглашения (миграция
// 20261210), на слепке схемы прода и на копии прода как база Яндекса (одна учётка, настоящий migrate.sh с проверками прав).
// Проверка до миграции — FAIL, а не ошибка; другие направления, материалы, уже завершённые и служебные операции не задеты;
// откат оставляет файлы. Окно завершения — tender-concept-agreement.test.mjs. Нужны Docker и psql.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter, latestVerifiedCopy, startSingleOwner } from '../db/lib/stand.mjs'

const NAME = '20261210_tender_concept_agreement'
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', `${NAME}.sql`)
const YANDEX_CHECK = path.join(ROOT, 'migration', 'yandex', `${NAME}.check.sql`)
const CHECK = path.join(ROOT, 'migration', 'backup', 'checks', '20261210.sql')
const ROLLBACK = path.join(ROOT, 'migration', 'rollback', `${NAME}_rollback.sql`)

const ADMIN = '00000000-0000-4000-8000-0000000c1a01'
const CP = '00000000-0000-4000-8000-0000000c2a01'
const OBJ = '00000000-0000-4000-8000-0000000c3a01'
const T = {
  os: '00000000-0000-4000-8000-0000000c4a01',
  second: '00000000-0000-4000-8000-0000000c4a02',
  warranty: '00000000-0000-4000-8000-0000000c4a03',
  materials: '00000000-0000-4000-8000-0000000c4a04',
  done: '00000000-0000-4000-8000-0000000c4a05',
  service: '00000000-0000-4000-8000-0000000c4a06',
  created: '00000000-0000-4000-8000-0000000c4a07',
}
const CARD = '00000000-0000-4000-8000-0000000c5a01'
const FILE = '00000000-0000-4000-8000-0000000c6a01'

const SEED = `
  insert into public.counterparties (id, name) values ('${CP}', 'ООО Победитель');
  insert into public.user_roles (user_id, role, is_approved, is_blocked, full_name, email) values
    ('${ADMIN}', 'admin', true, false, 'Админов А. А.', 'a@example.invalid');
  insert into public.objects (id, name, address, status) values ('${OBJ}', 'ЖК Понятийный', 'Москва', 'main_construction');
  insert into public.tenders (id, work_description, object_id, status, public_tender_number, department, tender_type) values
    ('${T.os}', 'ОС', '${OBJ}', 'Подведение итогов', 9981, 'construction', 'main'),
    ('${T.second}', 'ОС, другой тендер', '${OBJ}', 'Подведение итогов', 9982, 'construction', 'main'),
    ('${T.warranty}', 'ГО', '${OBJ}', 'Подведение итогов', 9983, 'warranty', 'main'),
    ('${T.materials}', 'Материалы', '${OBJ}', 'В работе', 9984, 'construction', 'materials'),
    ('${T.done}', 'Старый завершённый', '${OBJ}', 'Завершен', 9985, 'construction', 'main'),
    ('${T.service}', 'Служебная правка', '${OBJ}', 'Подведение итогов', 9986, 'construction', 'main');
  insert into public.tender_docs (id, tender_id, title) values ('${CARD}', '${T.os}', 'Понятийное соглашение');`

const complete = (id, winner = CP) => `update public.tenders set status = 'Завершен', winner_counterparty_id = ${winner ? `'${winner}'` : 'null'} where id = '${id}' returning status`
const statusOf = (id) => `select status from public.tenders where id = '${id}'`
const putFile = (category) => `insert into public.s3_documents (id, owner_type, owner_id, s3_key, file_name, doc_category)
  values ('${FILE}', 'tender', '${CARD}', 'tenders/${CARD}/файл.pdf', 'файл.pdf', '${category}')`
const dropFile = `delete from public.s3_documents where id = '${FILE}'`

// Один и тот же набор проверок на обеих базах: as — запрос от имени вошедшего, service — служебная операция.
function behaves({ as, service }) {
  it('без победителя и без подписанного файла — отказ с причиной; файл другой категории не считается', () => {
    assert.throws(() => as(complete(T.os, null)), /нельзя завершить без победителя/)
    assert.throws(() => as(complete(T.os)), /без подписанного понятийного соглашения/)
    service(putFile('concept_agreement_template'))
    assert.throws(() => as(complete(T.os)), /без подписанного понятийного соглашения/, 'шаблон — не подписанное')
    service(dropFile)
    service(putFile('general'))
    assert.throws(() => as(complete(T.os)), /без подписанного понятийного соглашения/, 'обычный файл карточки — не подписанное')
    service(dropFile)
    assert.equal(service(statusOf(T.os)), 'Подведение итогов')
  })

  it('с победителем и подписанным файлом — завершён; другой тендер этим файлом не закрыть', () => {
    service(putFile('concept_agreement_signed'))
    assert.throws(() => as(complete(T.second)), /без подписанного понятийного соглашения/)
    assert.equal(as(complete(T.os)), 'Завершен')
    assert.equal(service(statusOf(T.os)), 'Завершен')
  })

  it('не проверяются: другие направления, материалы, правка уже завершённого, служебная операция', () => {
    assert.equal(as(complete(T.warranty, null)), 'Завершен')
    assert.equal(as(`update public.tenders set status = 'Завершен' where id = '${T.materials}' returning status`), 'Завершен')
    assert.equal(as(`update public.tenders set notes = 'правка' where id = '${T.done}' returning status`), 'Завершен')
    assert.equal(as(`update public.tenders set status = 'Завершен' where id = '${T.done}' returning status`), 'Завершен', 'тот же статус в полной записи формы')
    assert.equal(service(complete(T.service, null)), 'Завершен')
  })

  it('новый тендер ОС сразу завершённым не записать; вернуть из завершённого и закрыть снова — только с соглашением', () => {
    assert.throws(() => as(`insert into public.tenders (id, work_description, object_id, status, public_tender_number, department, tender_type)
      values ('${T.created}', 'Сразу завершённый', '${OBJ}', 'Завершен', 9987, 'construction', 'main')`), /нельзя завершить/)
    assert.equal(service(`select count(*) from public.tenders where id = '${T.created}'`), '0')
    as(`update public.tenders set status = 'Подведение итогов' where id = '${T.done}'`)
    assert.throws(() => as(complete(T.done)), /без подписанного понятийного соглашения/)
    assert.equal(service(statusOf(T.done)), 'Подведение итогов')
  })
}

describe('Запрет завершения тендера без соглашения — база', { skip: skipReason(), timeout: 600000 }, () => {
  let db
  let checkBefore = ''
  const sql = (text) => psqlAt(db.port, text)
  const as = (text) => psqlAt(db.port, `begin;
    set local "request.jwt.claims" = '${JSON.stringify({ sub: ADMIN, role: 'authenticated' })}';
    set local role authenticated;
    ${text};
    commit;`)

  before(() => {
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: path.join(ROOT, 'supabase', 'migrations', m) })
    checkBefore = psqlAt(db.port, null, { file: CHECK })
    sql(SEED)
    psqlAt(db.port, null, { file: MIGRATION })
  })
  after(() => db?.stop())

  it('проверка для прода до миграции — FAIL, а не ошибка; после — все OK; повтор миграции безопасен', () => {
    assert.match(checkBefore, /^FAIL /m)
    assert.equal(checkBefore.split('\n').filter((l) => /^(OK|FAIL) /.test(l)).length, 4)
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 4, out)
  })

  behaves({ as, service: sql })

  it('откат: запрета нет, файлы и карточка на месте; повтор отката безопасен', () => {
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql(`select count(*) from pg_trigger where tgname = 'tenders_concept_agreement_guard'`), '0')
    assert.equal(sql(`select count(*) from public.s3_documents where id = '${FILE}'`), '1')
    assert.equal(sql(`select count(*) from public.tender_docs where id = '${CARD}'`), '1')
    assert.equal(as(complete(T.done, null)), 'Завершен', 'без запрета — как раньше')
    psqlAt(db.port, null, { file: ROLLBACK })
  })
})

describe('Запрет завершения тендера без соглашения — база Яндекса (одна учётка)', { skip: skipReason({ needCopy: true }), timeout: 30 * 60 * 1000 }, () => {
  let db
  let tmp
  const internal = (text) => db.sql(text, { appName: 'osp:internal' })
  // Запрос от имени вошедшего, как его передаёт шлюз: роль и пользователь — в токене (osp_role, sub).
  const as = (text) => db.sql(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify({ osp_role: 'authenticated', sub: ADMIN })}', true);
    ${text};
    commit;`, { appName: 'osp-test' }).split('\n').filter((l) => l !== '' && !/^\{/.test(l)).join('\n')

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-concept-'))
    db = startSingleOwner(latestVerifiedCopy())
    const res = spawnSync('bash', [path.join(ROOT, 'migration', 'target', 'migrate.sh'), db.envFile, '--yes'], {
      encoding: 'utf8', cwd: ROOT, timeout: 20 * 60 * 1000,
      env: { ...process.env, PROBE_REPORT_DIR: path.join(tmp, 'reports'), BACKUP_OUT_DIR: path.join(tmp, 'exports'), PROBE_CONNECT_TIMEOUT: '5' } })
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.match(res.stdout, new RegExp(`OK ${NAME}: применена`))
    internal(SEED)
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('проверка миграции на копии: все OK', () => {
    const out = internal(fs.readFileSync(YANDEX_CHECK, 'utf8'))
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 5, out)
  })

  behaves({ as, service: internal })
})
