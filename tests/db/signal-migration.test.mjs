// 20270228_signal_integration (пакет P1, только база Яндекса) на слепке схемы прода (Docker): сверка договоров с папками SIGNAL.
// Слепок — Supabase-вариант, поэтому до миграции на него накатывается мини-заготовка базы Яндекса: закрытая схема osp_private
// (bypass, role_in), osp_meta.schema_migrations, охват по объектам (первая часть 20270120: osp_object_scope / osp_contract_in_scope),
// журнал базы 20270121, 20270222; «Заключение ДП» (20270225) — вариант из кандидатов (тот же текст, права Supabase).
// Проверяем:
//   • файлы: без BEGIN/COMMIT и ролей Supabase, в шлюз (allow.json, db-sections.json) ничего не публикуется;
//   • проверка для прода до миграции — FAIL, а не ошибка; .check.sql и проверка для прода после — все OK; повтор безопасен;
//   • правила по строкам у всех десяти таблиц; живое чтение без пропуска пусто, запись отказывает;
//   • служебные функции с непустым auth.uid() — отказ; пользовательские: охват объектов, право раздела (просмотр / правка),
//     подрядчик, заблокированный, неодобренный, без роли — отказ;
//   • граница Ф1: корень без объекта закрыт, неразмеченное поддерево многообъектного корня закрыто, синоним доступа не даёт;
//   • CAS, идемпотентность подтверждения / отказа / снятия, откат всего при занятом синониме;
//   • Ф4 / J1: правка договора, вставка договора и ДС, правка сторон и создание договора из заявки «Заключение ДП» проходят при
//     пустых таблицах SIGNAL, переименованной или удалённой очереди и при ACCESS EXCLUSIVE на очереди в другой сессии (ожидание
//     не дольше одного lock_timeout триггера); ревизии очереди: значимые правки — новая ревизия, несущественные — нет;
//   • откат убирает всё и не трогает contracts.signal_link, после него миграция применяется снова.
// Нужны Docker и psql. Поведение на нативной базе с настоящими правами владельца — tests/osp-api/signal-db-functions.test.mjs.
// Люди, объекты и ссылки вымышлены.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { ROOT, skipReason, startSnapshot, psqlAt, appliedAfter } from './lib/stand.mjs'
import { candidateMigrations } from './lib/rights.mjs'
import { createSeeders, uuid } from '../osp-api/lib/signal-db.mjs'

const NAME = '20270228_signal_integration'
const file = (...p) => path.join(ROOT, ...p)
const MIGRATION = file('migration', 'yandex', `${NAME}.sql`)
const CHECK = file('migration', 'yandex', `${NAME}.check.sql`)
const BACKUP_CHECK = file('migration', 'backup', 'checks', '20270228.sql')
const ROLLBACK = file('migration', 'rollback', `${NAME}_rollback.sql`)
const read = (p) => fs.readFileSync(p, 'utf8')
const stripComments = (text) => text.replace(/--.*$/gm, '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SERVICE = {
  signal_sync_due: 'signal_sync_due()',
  signal_sync_begin: "signal_sync_begin('manual', 'full', 'admin', null)",
  signal_sync_heartbeat: 'signal_sync_heartbeat(1, gen_random_uuid())',
  signal_stage_put: "signal_stage_put(1, gen_random_uuid(), '[]'::jsonb)",
  signal_sync_fail: "signal_sync_fail(1, gen_random_uuid(), 'failed', 'http', '{}'::jsonb)",
  signal_sync_finish: "signal_sync_finish(1, gen_random_uuid(), '{}'::jsonb)",
  signal_accept_held: "signal_accept_held(1, 0, 'cli', 'проверка')",
  signal_sources_for_sync: 'signal_sources_for_sync()',
  signal_enqueue_all: 'signal_enqueue_all()',
  signal_enqueue_missed: 'signal_enqueue_missed()',
  signal_queue_claim: 'signal_queue_claim(10)',
  signal_queue_release: "signal_queue_release(gen_random_uuid(), '{}'::uuid[], 1)",
  signal_match_load: "signal_match_load('{}'::uuid[])",
  signal_match_nodes: 'signal_match_nodes(null, null, null, null, null)',
  signal_state_write: "signal_state_write(null, '[]'::jsonb)",
}

// ── Файлы миграции, проверок, отката и шлюз (Docker не нужен) ─────────────────────────────────────────
describe('Сверка с SIGNAL: файлы миграции, проверок, отката и шлюз', () => {
  it('миграция: без BEGIN/COMMIT, команд psql, CONCURRENTLY и ролей Supabase; строк «osp:allow» нет — в шлюз ничего не публикуется', () => {
    const code = stripComments(read(MIGRATION))
    assert.doesNotMatch(code, /^\s*(begin|commit|rollback|start\s+transaction|savepoint)\s*(transaction|work)?\s*;/im)
    assert.doesNotMatch(code, /^\s*\\/m)
    assert.doesNotMatch(code, /concurrently/i)
    assert.doesNotMatch(code, /\b(to|from)\s+(public\s*,\s*)?(anon|authenticated|service_role)\b/i)
    assert.doesNotMatch(read(MIGRATION), /^\s*--\s*osp:allow\b/m)
    // Каждая служебная функция signal_* — SECURITY DEFINER с отметкой пропуска и фиксированным search_path.
    const defs = [...read(MIGRATION).matchAll(/CREATE OR REPLACE FUNCTION osp_private\.(signal_\w+)\([\s\S]*?\n\$\$;/g)]
    assert.equal([...read(MIGRATION).matchAll(/^CREATE OR REPLACE FUNCTION osp_private\.signal_/gm)].length, 54, 'функций в файле')
    assert.ok(defs.length >= 53, `разобрано определений: ${defs.length}`)
    for (const [text, fn] of defs) {
      const definer = /\bSECURITY DEFINER\b/.test(text)
      assert.equal(/SET application_name = 'osp:internal'/.test(text), definer, `${fn}: отметка пропуска у SECURITY DEFINER и только у него`)
      if (definer) assert.match(text, /SET search_path = osp_private, public, pg_temp/, `${fn}: фиксированный search_path`)
    }
    // Повтор безопасен: ни одного голого CREATE TABLE / CREATE INDEX / CREATE FUNCTION без IF NOT EXISTS / OR REPLACE.
    assert.doesNotMatch(code, /CREATE TABLE (?!IF NOT EXISTS)/)
    assert.doesNotMatch(code, /CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/)
    assert.doesNotMatch(code, /CREATE FUNCTION/)
  })

  it('проверка для прода только читает каталог; откат не трогает contracts.signal_link', () => {
    const code = stripComments(read(BACKUP_CHECK)).replace(/'(?:[^']|'')*'/g, "''").toLowerCase()
    assert.doesNotMatch(code, /\b(insert|update|delete|create|alter|drop|truncate|grant|revoke)\b/)
    assert.doesNotMatch(code, /from\s+osp_private\.signal_/, 'таблицы сверки закрыты правилами — проверка их не читает')
    const rb = stripComments(read(ROLLBACK))
    assert.doesNotMatch(rb, /signal_link/)
    assert.doesNotMatch(rb, /DROP TABLE IF EXISTS public\./)
    assert.doesNotMatch(rb, /DROP COLUMN/)
  })

  it('шлюз: ни таблиц, ни функций signal_* в allow.json и db-sections.json; осталась ровно колонка договора', () => {
    const allow = JSON.parse(read(file('server', 'osp-api', 'src', 'data', 'allow.json')))
    const sections = JSON.parse(read(file('server', 'osp-api', 'src', 'data', 'db-sections.json')))
    const keys = [...Object.keys(allow.tables || {}), ...Object.keys(allow.rpc || {}), ...Object.keys(sections.tables || {}), ...Object.keys(sections.rpc || {})]
    assert.deepEqual(keys.filter((k) => /signal/i.test(k)), [], 'osp_private.signal_* в шлюз не публикуются')
    assert.equal(Object.keys(allow.tables).includes('osp_private'), false)
    assert.doesNotMatch(read(file('server', 'osp-api', 'src', 'data', 'allow.json')), /osp_private/)
  })
})

// ── База ────────────────────────────────────────────────────────────────────────────────────────────
describe('Сверка с SIGNAL: миграция на слепке схемы прода', { skip: skipReason(), timeout: 900000 }, () => {
  let db
  let tmp
  let checkBefore = ''
  const env = () => ({ ...process.env, PGPASSWORD: '', PGSSLMODE: 'disable' })
  const psqlArgs = () => ['-h', '127.0.0.1', '-p', String(db.port), '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1']
  const TAGS = /^(BEGIN|COMMIT|ROLLBACK|SET|DO|LOCK TABLE|TRUNCATE TABLE|INSERT \d+ \d+|UPDATE \d+|DELETE \d+|SELECT \d+|ALTER TABLE|CREATE (ROLE|TABLE|INDEX|FUNCTION|TRIGGER|SEQUENCE)|DROP (TABLE|TRIGGER|FUNCTION|SEQUENCE|ROLE)|GRANT|RESET)$/
  // Сценарий — одним скриптом psql (метакоманды допустимы): {ok, out, err}; ошибка — не исключение.
  const run = (script) => {
    const res = spawnSync('psql', [...psqlArgs(), '-f', '-'], {
      input: `\\set VERBOSITY verbose\nSET client_min_messages = warning;\n${script}\n`, encoding: 'utf8', env: env(), maxBuffer: 64 * 1024 * 1024 })
    return { ok: res.status === 0, out: res.stdout.split('\n').filter((l) => l !== '' && !TAGS.test(l)), err: res.stderr || '' }
  }
  const must = (script) => {
    const r = run(script)
    assert.ok(r.ok, r.err.split('\n').find((l) => /ERROR/.test(l)) || r.err)
    return r.out
  }
  const errOf = (r) => {
    assert.equal(r.ok, false, `ожидалась ошибка, получено: ${r.out.join(' | ')}`)
    const m = r.err.match(/ERROR:\s+(?:([0-9A-Z]{5}):\s+)?(.*)/)
    return { code: m?.[1] || null, message: (m?.[2] || r.err).trim() }
  }
  const txn = (app, claims, text) => `BEGIN;\nSET LOCAL application_name = '${app}';\n${claims ? `SET LOCAL "request.jwt.claims" = '${JSON.stringify(claims)}';\n` : ''}${text.trim().replace(/;?$/, ';')}\nCOMMIT;`
  // Служебная операция (мимо правил по строкам) / вошедший (как db.write(who)).
  const internal = (text) => must(txn('osp:internal', null, text)).join('\n')
  const as = (uid, text) => must(txn('osp-api', { sub: uid, role: 'authenticated' }, text)).join('\n')
  const asJson = (uid, text) => JSON.parse(as(uid, text).split('\n').filter(Boolean).at(-1))
  const asErr = (uid, text) => errOf(run(txn('osp-api', { sub: uid, role: 'authenticated' }, text)))
  const internalJson = (text) => JSON.parse(internal(text).split('\n').filter(Boolean).at(-1))
  const sql = (text) => must(text).join('\n')
  const fn = (call) => `select osp_private.${call}`
  // Сколько мс идёт сценарий (последний вывод — мс).
  const timedMs = (script) => Number(must(`select clock_timestamp() as t0 \\gset\n${script}\nselect round(extract(epoch from clock_timestamp() - :'t0'::timestamptz) * 1000);`).at(-1))

  // Держатель блокировки в другой сессии: killed → освобождает.
  async function hold(script) {
    const child = spawn('psql', [...psqlArgs(), '-f', '-'], { env: env() })
    child.stdin.end(`${script}\nselect pg_sleep(120);\n`)
    for (let i = 0; i < 150; i++) {
      if (sql(`select count(*) from pg_stat_activity where query like '%pg_sleep(120)%' and pid <> pg_backend_pid() and state = 'active'`) === '1') break
      await sleep(100)
    }
    // pg_sleep сам не заметит ушедшего клиента: сеанс-держатель завершаем явно, иначе блокировка висит до конца сна.
    return async () => {
      sql(`select pg_terminate_backend(pid) from pg_stat_activity where query like '%pg_sleep(120)%' and pid <> pg_backend_pid()`)
      child.kill()
      for (let i = 0; i < 100; i++) {
        if (sql(`select count(*) from pg_stat_activity where query like '%pg_sleep(120)%' and pid <> pg_backend_pid()`) === '0') return
        await sleep(100)
      }
    }
  }

  // Синтетика: люди, объекты, договоры.
  const nextId = (() => { let n = 0x500; return (kind) => uuid(kind, ++n) })()
  let seed
  const P = {}
  const O = {}
  const C = {}
  const S = {}
  let T = {}
  const confirmCall = (c, node, { url, replace = false, alias = null, aliasKey = null, link = null, ver = 0, key = `k-${nextId('k')}`, fp = 'fp' } = {}) =>
    fn(`signal_confirm('${c}', '${node}', '${url || `https://signal.example.invalid/folder/${node}`}', ${replace}, ${alias ? `'${alias}'` : 'null'}, ` +
      `${aliasKey ? `'${aliasKey}'` : 'null'}, '${fp}', ${link ? `'${link}'` : 'null'}, ${ver}, '${key}')`)

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osp-signal-db-'))
    db = startSnapshot()
    for (const m of appliedAfter()) psqlAt(db.port, null, { file: file('supabase', 'migrations', m) })
    for (const m of candidateMigrations()) {
      psqlAt(db.port, null, { file: path.join(ROOT, m.includes('/') ? m : path.join('supabase', 'migrations', m)) })
    }
    // Заготовка базы Яндекса на слепке: закрытая схема и пропуск служебных операций (migration/target/sql/load-single-owner.sql).
    psqlAt(db.port, `
      CREATE SCHEMA IF NOT EXISTS osp_private;
      CREATE SCHEMA IF NOT EXISTS osp_meta;
      CREATE TABLE IF NOT EXISTS osp_meta.schema_migrations (name text PRIMARY KEY, sha256 text, applied_at timestamptz NOT NULL DEFAULT now(), tool_commit text);
      CREATE OR REPLACE FUNCTION osp_private.bypass() RETURNS boolean LANGUAGE sql STABLE
        AS $$ SELECT coalesce(pg_catalog.current_setting('application_name', true), '') = 'osp:internal' OR coalesce(auth.role(), '') = 'service_role' $$;
      CREATE OR REPLACE FUNCTION osp_private.role_in(VARIADIC p_roles text[]) RETURNS boolean LANGUAGE sql STABLE
        AS $$ SELECT coalesce(nullif(auth.role(), ''), 'anon') = ANY (p_roles) $$;`)
    // 20270120: только первая часть (охват по объектам); политики таблиц в слепке — Supabase-вида, их переписывает не эта миграция.
    const scope = read(file('migration', 'yandex', '20270120_object_scope_files.sql'))
    const part = path.join(tmp, 'scope-part.sql')
    fs.writeFileSync(part, scope.slice(0, scope.indexOf('-- ── 2. Договоры и привязанное к ним')))
    psqlAt(db.port, null, { file: part })
    psqlAt(db.port, null, { file: file('migration', 'yandex', '20270121_audit_trail.sql') })
    psqlAt(db.port, null, { file: file('migration', 'yandex', '20270222_contract_created_history.sql') })
    checkBefore = psqlAt(db.port, null, { file: BACKUP_CHECK })
    psqlAt(db.port, null, { file: MIGRATION })

    seed = createSeeders({ sql: internal, nextId })
    O.a = seed.object({ name: 'Тест: ЖК Альфа' })
    O.b = seed.object({ name: 'Тест: ЖК Бета' })
    P.admin = seed.admin()
    P.editA = seed.user({ role: 'sg_edit', contracts: 'edit', objectIds: [O.a] })
    P.viewA = seed.user({ role: 'sg_view', contracts: 'view', objectIds: [O.a] })
    P.editB = seed.user({ role: 'sg_edit', contracts: 'edit', objectIds: [O.b] })
    P.none = seed.user({ role: 'sg_none', contracts: null, objectIds: [O.a] })
    P.contractor = seed.contractor({ objectIds: [O.a] })
    P.blocked = seed.user({ role: 'sg_edit', contracts: 'edit', blocked: true, objectIds: [O.a] })
    P.pending = seed.user({ role: 'sg_edit', contracts: 'edit', approved: false, objectIds: [O.a] })
    P.unknown = nextId('usr')
    const cp1 = seed.counterparty({ name: 'ООО Тест Монолит', inn: '7700000001' })
    const cp2 = seed.counterparty({ name: 'ООО Тест Кровля', inn: '7700000002' })
    C.cp1 = cp1
    C.cp2 = cp2
    C.dpA = seed.contract({ number: 'АЛИЯ-ДП-26-001', objectId: O.a, counterparties: [cp1] })
    C.dsA = seed.contract({ number: 'ДС-1', objectId: O.a, recordType: 'ds_vor', parent: C.dpA, counterparties: [cp1] })
    C.dpA2 = seed.contract({ number: 'АЛИЯ-ДП-26-002', objectId: O.a, counterparties: [cp2] })
    C.dpA3 = seed.contract({ number: 'АЛИЯ-ДП-26-003', objectId: O.a, counterparties: [cp2] })
    C.dpB = seed.contract({ number: 'БЕТА-ДП-26-001', objectId: O.b, counterparties: [cp1] })
    // Корни: один объект А; два объекта (А, Б); без объектов; выключенный; не готовый.
    S.a = seed.source({ objectIds: [O.a] })
    S.multi = seed.source({ objectIds: [O.a, O.b] })
    S.none = seed.source({ objectIds: [] })
    S.off = seed.source({ objectIds: [O.a], enabled: false, ready: false })
    S.cold = seed.source({ objectIds: [O.a], enabled: true, ready: false })
    T.a = seed.snapshot(S.a.id, { name: 'Корень А', children: [
      { name: 'Корпус 1', numberKeys: ['АЛИЯ|2026|1'], items: [{ name: 'договор.pdf' }], children: [{ name: 'Приложения' }] },
      { name: 'Корпус 2', numberKeys: ['АЛИЯ|2026|2'] }, { name: 'Корпус 3' }] })
    T.multi = seed.snapshot(S.multi.id, { name: 'Общий', children: [{ name: 'Секция А', children: [{ name: 'Альфа-архив' }] }, { name: 'Секция Б' }] })
    T.none = seed.snapshot(S.none.id, { name: 'Без объекта', children: [{ name: 'Папка Н' }] })
    T.off = seed.snapshot(S.off.id, { name: 'Выключен', children: [{ name: 'Папка В' }] })
    T.cold = seed.snapshot(S.cold.id, { name: 'Не готов', children: [{ name: 'Папка Г' }] })
    for (const k of ['a', 'multi', 'none', 'off', 'cold']) T[k].id = (p) => T[k].ids[p]
  })
  after(() => {
    db?.stop()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('проверка для прода: до миграции — FAIL, а не ошибка; после — все OK (и .check.sql миграции — все OK)', () => {
    assert.match(checkBefore, /^FAIL /m)
    assert.ok(checkBefore.split('\n').every((l) => /^(OK|FAIL) /.test(l)), checkBefore)
    const after = psqlAt(db.port, null, { file: BACKUP_CHECK })
    assert.doesNotMatch(after, /^FAIL/m, after)
    assert.equal(after.split('\n').filter((l) => l.startsWith('OK ')).length, 25, after)
    for (const searchPath of ['public', '"$user", public']) {
      const out = must(`SET search_path = ${searchPath};\nSET application_name = 'osp:internal';\n${read(CHECK)}`).join('\n')
      assert.doesNotMatch(out, /^FAIL/m, out)
      assert.equal(out.split('\n').filter((l) => l.startsWith('OK ')).length, 25, out)
    }
  })

  it('повторное применение безопасно: данные, единственная строка signal_meta, триггеры и права на месте', () => {
    const snap = () => sql(`select (select count(*) from osp_private.signal_nodes) || '|' || (select count(*) from osp_private.signal_sources) || '|' ||
      (select count(*) from osp_private.signal_bindings) || '|' || (select count(*) from osp_private.signal_queue) || '|' || (select count(*) from osp_private.signal_meta) || '|' ||
      (select generation from osp_private.signal_meta) || '|' ||
      (select count(*) from pg_trigger where tgname like 'osp\\_signal\\_enqueue\\_%' and not tgisinternal)`)
    const before = snap()
    assert.match(before, /^\d+\|5\|5\|\d+\|1\|1\|7$/)
    psqlAt(db.port, null, { file: MIGRATION })
    psqlAt(db.port, null, { file: MIGRATION })
    assert.equal(snap(), before)
    const out = psqlAt(db.port, null, { file: BACKUP_CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
  })

  it('правила по строкам: у всех десяти таблиц включены и действуют на владельца; без пропуска строк не видно и писать нельзя', () => {
    const tables = ['signal_meta', 'signal_sources', 'signal_bindings', 'signal_nodes', 'signal_stage_nodes', 'signal_runs', 'signal_contracts',
      'signal_candidates', 'signal_aliases', 'signal_queue']
    for (const t of tables) {
      assert.equal(sql(`select relrowsecurity::text || relforcerowsecurity::text || (select count(*) from pg_policy where polrelid = c.oid)
        from pg_class c where oid = 'osp_private.${t}'::regclass`), 'truetrue1', t)
    }
    // Живое чтение: учётка без прав владельца, но с выдачей на таблицы, без отметки пропуска видит 0 строк; с отметкой — строки.
    sql(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'signal_probe') THEN CREATE ROLE signal_probe NOLOGIN; END IF; END $$;
      GRANT USAGE ON SCHEMA osp_private, auth TO signal_probe;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA osp_private TO signal_probe;`)
    internal(`insert into osp_private.signal_runs (kind, mode, initiator, owner_token) values ('manual', 'full', 'cli', gen_random_uuid())`)
    const seen = (app) => must(`SET ROLE signal_probe;\nSET application_name = '${app}';\n${tables.map((t) => `select '${t}=' || count(*) from osp_private.${t};`).join('\n')}`)
    for (const line of seen('osp-api')) assert.match(line, /=0$/, `без пропуска: ${line}`)
    for (const line of seen('osp-postgrest')) assert.match(line, /=0$/, line)
    const withMark = Object.fromEntries(seen('osp:internal').map((l) => l.split('=')))
    assert.ok(Number(withMark.signal_nodes) > 0 && Number(withMark.signal_sources) === 5 && Number(withMark.signal_runs) >= 1)
    const w = run(`SET ROLE signal_probe;\nSET application_name = 'osp-api';\ninsert into osp_private.signal_aliases (object_id, alias_text, alias_key) values ('${O.a}', 'x', 'x');`)
    assert.match(errOf(w).message, /row-level security/)
    const u = must(`SET ROLE signal_probe;\nSET application_name = 'osp-api';\nupdate osp_private.signal_meta set generation = 99 returning 1;`)
    assert.deepEqual(u, [], 'правка без пропуска не затрагивает ни строки')
    assert.equal(sql('select generation from osp_private.signal_meta'), '1')
    internal('delete from osp_private.signal_runs')
  })

  it('служебные функции: с непустым auth.uid() — отказ SG403 (даже администратору и даже с отметкой пропуска); без вошедшего работают', () => {
    for (const [name, call] of Object.entries(SERVICE)) {
      for (const uid of [P.admin, P.editA, P.unknown]) {
        const e = asErr(uid, `select osp_private.${call}`)
        assert.deepEqual(e, { code: 'SG403', message: 'forbidden' }, `${name} от ${uid}`)
      }
      const viaInternal = errOf(run(txn('osp:internal', { sub: P.admin, role: 'authenticated' }, `select osp_private.${call}`)))
      assert.equal(viaInternal.code, 'SG403', `${name}: с отметкой osp:internal, но с вошедшим`)
    }
    // Те же функции без вошедшего (служебная операция): не отказывают по uid.
    assert.equal(internalJson(fn('signal_sync_due()')).due !== undefined, true)
    assert.equal(internalJson(fn("signal_match_nodes(null, array['АЛИЯ|2026|1'], null, null, null)")).nodes.length, 1)
    assert.equal(internalJson(fn('signal_sources_for_sync()')).sources.length, 4, 'включённые корни: выключенный не отдаётся')
    assert.equal(internalJson(fn("signal_match_load(array['" + C.dpA + "']::uuid[])")).contracts.length, 1)
  })

  it('пользовательские функции: подрядчик, заблокированный, неодобренный, без права раздела, без строки ролей — отказ; флаги — все false', () => {
    const node = T.a.id('Корень А / Корпус 1')
    const calls = {
      marks: 'signal_marks(null, 10)',
      view: `signal_contract_view('${C.dpA}')`,
      folders: `signal_folders_search('${C.dpA}', '', null, 5)`,
      confirm: confirmCall(C.dpA, node, { ver: 99 }).replace('select osp_private.', ''),
      reject: `signal_reject('${C.dpA}', '${node}', null, 'c', 0, 'rk1')`,
      unlink: `signal_unlink('${C.dpA}', 'c', 'https://x.example.invalid/f', 0, 'uk1')`,
      alias_create: `signal_alias_create('${O.a}', 'Тест алиас', 'тест алиас')`,
      alias_delete: 'signal_alias_delete(999999)',
      alias_list: 'signal_alias_list()',
      admin_state: 'signal_admin_state()',
      runs: 'signal_runs(5)',
      source_add: `signal_source_add('${nextId('prj')}', '${nextId('fld')}', 'Проект', 'Проект / Корень', array['${O.a}']::uuid[])`,
      source_update: `signal_source_update(${S.multi.id}, null, null)`,
      binding_set: `signal_binding_set(${S.multi.id}, '${T.multi.id('Общий / Секция А')}', null)`,
      unassigned: `signal_unassigned(${S.multi.id}, null, 10)`,
      tree: `signal_tree(${S.multi.id})`,
      bindings_list: `signal_bindings_list(${S.multi.id})`,
      binding_preview: `signal_binding_preview(${S.multi.id}, '${T.multi.id('Общий / Секция А')}', '${O.a}')`,
    }
    for (const [who, uid] of [['подрядчик', P.contractor], ['заблокированный', P.blocked], ['неодобренный', P.pending], ['без права раздела', P.none], ['нет строки ролей', P.unknown]]) {
      assert.deepEqual(asJson(uid, fn('signal_user_flags()')), { canView: false, canEdit: false, isAdmin: false }, `${who}: флаги`)
      for (const [name, call] of Object.entries(calls)) {
        assert.deepEqual(asErr(uid, `select osp_private.${call}`), { code: 'SG403', message: 'forbidden' }, `${who}: ${name}`)
      }
    }
    // Только просмотр: значки и окно — да; правка, синонимы и всё админское — нет.
    assert.deepEqual(asJson(P.viewA, fn('signal_user_flags()')), { canView: true, canEdit: false, isAdmin: false })
    assert.ok(asJson(P.viewA, fn('signal_marks(null, 10)')).items)
    assert.equal(asJson(P.viewA, fn(`signal_contract_view('${C.dpA}')`)).canEdit, false)
    assert.equal(asJson(P.viewA, fn(`signal_contract_view('${C.dpA}')`)).candidates, undefined, 'кандидаты — только при праве правки')
    for (const name of ['folders', 'confirm', 'reject', 'unlink', 'alias_create', 'alias_delete', 'alias_list', 'admin_state', 'runs', 'source_add', 'source_update', 'binding_set', 'unassigned',
      'tree', 'bindings_list', 'binding_preview']) {
      assert.equal(asErr(P.viewA, `select osp_private.${calls[name]}`).code, 'SG403', `просмотр: ${name}`)
    }
    // Правка: договорное — да (отказ не по праву), админское — нет.
    assert.deepEqual(asJson(P.editA, fn('signal_user_flags()')), { canView: true, canEdit: true, isAdmin: false })
    for (const name of ['admin_state', 'runs', 'source_add', 'source_update', 'binding_set', 'unassigned', 'tree', 'bindings_list', 'binding_preview']) {
      assert.equal(asErr(P.editA, `select osp_private.${calls[name]}`).code, 'SG403', `правка: ${name}`)
    }
    // С-2: список синонимов сотруднику с правкой — только его собственные (здесь их ещё нет).
    assert.deepEqual(asJson(P.editA, `select osp_private.${calls.alias_list}`), { items: [] })
    assert.notEqual(asErr(P.editA, `select osp_private.${calls.confirm}`).code, 'SG403', 'правка: подтверждение — отказ не по праву (устаревшая версия)')
    assert.equal(asErr(P.editA, `select osp_private.${calls.alias_delete}`).code, 'SG404')
    // Администратор: всё, включая админское.
    assert.deepEqual(asJson(P.admin, fn('signal_user_flags()')), { canView: true, canEdit: true, isAdmin: true })
    for (const name of ['alias_list', 'admin_state', 'runs', 'unassigned', 'tree', 'bindings_list', 'binding_preview']) assert.ok(asJson(P.admin, `select osp_private.${calls[name]}`), name)
    assert.equal(asJson(P.admin, fn(calls.source_update.replace(/^/, ''))).ok, true)
  })

  it('охват объектов: чужой договор — «нет такого» (404) и ни следа в значках; корень и синоним чужого объекта — отказ; удалённый — не виден', () => {
    for (const q of [fn(`signal_contract_view('${C.dpA}')`), fn(`signal_folders_search('${C.dpA}', '', null, 5)`),
      fn(`signal_reject('${C.dpA}', '${T.a.id('Корень А / Корпус 1')}', null, 'c', 0, 'r-scope')`),
      fn(`signal_unlink('${C.dpA}', 'c', 'https://x.example.invalid/f', 0, 'u-scope')`),
      confirmCall(C.dpA, T.a.id('Корень А / Корпус 1'), { ver: 0 })]) {
      assert.deepEqual(asErr(P.editB, q), { code: 'SG404', message: 'not_found' }, q.slice(0, 60))
    }
    assert.equal(asErr(P.editB, fn(`signal_alias_create('${O.a}', 'Чужой синоним', 'чужой синоним')`)).code, 'SG403')
    const idsOf = (uid) => asJson(uid, fn('signal_marks(null, 100)')).items.map((i) => i.id).sort()
    assert.deepEqual(idsOf(P.editA), [C.dpA, C.dsA, C.dpA2, C.dpA3].sort())
    assert.deepEqual(idsOf(P.editB), [C.dpB])
    assert.deepEqual(idsOf(P.admin), [C.dpA, C.dsA, C.dpA2, C.dpA3, C.dpB].sort())
    // Договор снят в корзину — из значков и окна исчезает (в том числе у администратора).
    internal(`update public.contracts set deleted_at = now() where id = '${C.dpA3}'`)
    assert.ok(!idsOf(P.admin).includes(C.dpA3))
    assert.equal(asErr(P.admin, fn(`signal_contract_view('${C.dpA3}')`)).code, 'SG404')
    internal(`update public.contracts set deleted_at = null where id = '${C.dpA3}'`)
    // Пагинация значков: страницы по возрастанию id, курсор — последний id.
    const p1 = asJson(P.admin, fn('signal_marks(null, 2)'))
    const p2 = asJson(P.admin, fn(`signal_marks('${p1.next}', 2)`))
    assert.equal(p1.items.length, 2)
    assert.equal(p2.items.length, 2)
    assert.ok(p1.items.at(-1).id < p2.items[0].id)
  })

  it('граница Ф1: корень без объекта закрыт; неразмеченное поддерево многообъектного корня закрыто; привязка открывает его одному объекту', () => {
    // Корень без объектов: у всех узлов объект не назначен.
    assert.equal(sql(`select count(*) from osp_private.signal_nodes where source_id = ${S.none.id} and object_id is not null`), '0')
    const noneNode = T.none.id('Без объекта / Папка Н')
    assert.equal(asErr(P.editA, confirmCall(C.dpA2, noneNode, { ver: 0 })).message, 'node_unavailable')
    assert.equal(asErr(P.admin, confirmCall(C.dpA2, noneNode, { ver: 0 })).message, 'node_unavailable')
    // Даже если состояние ссылается на узел закрытого корня, окно и значки пути не показывают.
    internal(`insert into osp_private.signal_contracts (contract_id, state, reason, node_id) values ('${C.dpA2}', 'verified', 'existing_url', '${noneNode}')
      on conflict (contract_id) do update set state = 'verified', reason = 'existing_url', node_id = '${noneNode}'`)
    assert.equal(asJson(P.editA, fn(`signal_contract_view('${C.dpA2}')`)).node, null)
    const mark = asJson(P.editA, fn('signal_marks(null, 100)')).items.find((i) => i.id === C.dpA2)
    assert.equal(mark.path, undefined)
    assert.deepEqual([mark.state, mark.reason, mark.pending], ['unverified', 'pending', true], 'С-36: узел закрытого корня «сверено» не удерживает')
    // Многообъектный корень (А и Б), поддеревья не размечены: объект узла не назначен.
    const secA = T.multi.id('Общий / Секция А')
    const secB = T.multi.id('Общий / Секция Б')
    const archive = T.multi.id('Общий / Секция А / Альфа-архив')
    assert.equal(sql(`select count(*) from osp_private.signal_nodes where source_id = ${S.multi.id} and object_id is not null`), '0')
    assert.equal(asErr(P.editA, confirmCall(C.dpA2, secA, { ver: 0 })).message, 'object_unassigned', 'объект договора ∈ объектов корня, граница не размечена')
    assert.equal(asErr(P.editB, confirmCall(C.dpB, secA, { ver: 0 })).message, 'object_unassigned')
    assert.deepEqual(asJson(P.editA, fn(`signal_folders_search('${C.dpA2}', 'секция', null, 20)`)).items, [], 'в поиске папок неразмеченных нет')
    // Администратор размечает поддерево: «Секция А» → А. Сначала объект вне корня — отказ.
    assert.equal(asErr(P.admin, fn(`signal_binding_set(${S.multi.id}, '${secA}', '${nextId('obj')}')`)).code, 'SG422')
    assert.equal(asErr(P.admin, fn(`signal_binding_set(${S.a.id}, '${T.a.id('Корень А / Корпус 2')}', '${O.b}')`)).message, 'invalid', 'объект не входит в объекты корня')
    assert.deepEqual(asJson(P.admin, fn(`signal_binding_set(${S.multi.id}, '${secA}', '${O.a}')`)), { ok: true })
    assert.deepEqual(must(`select path || '=' || coalesce((select name from public.objects o where o.id = object_id), '-')
      from osp_private.signal_nodes where source_id = ${S.multi.id}`).sort(),
    ['Общий / Секция А / Альфа-архив=Тест: ЖК Альфа', 'Общий / Секция А=Тест: ЖК Альфа', 'Общий / Секция Б=-', 'Общий=-'].sort())
    assert.equal(asErr(P.editB, confirmCall(C.dpB, archive, { ver: 0 })).message, 'node_unavailable', 'размеченное под А закрыто для Б')
    assert.equal(asErr(P.editB, confirmCall(C.dpB, secB, { ver: 0 })).message, 'object_unassigned')
    assert.deepEqual(asJson(P.editA, fn(`signal_folders_search('${C.dpA2}', 'секция', null, 20)`)).items.map((i) => i.path).sort(),
      ['Секция А', 'Секция А / Альфа-архив'].sort(), 'только размеченные под объект договора; путь — от границы объекта (без имени корня «Общий»)')
    const top = asJson(P.admin, fn(`signal_unassigned(${S.multi.id}, null, 10)`)).items.map((i) => i.path)
    assert.deepEqual(top, ['Общий / Секция Б'])
    // Синоним доступа не даёт: имя «Альфа-архив» — синоним объекта Б, но узел размечен под А (и не виден Б); неразмеченное — никому.
    internal(`insert into osp_private.signal_aliases (object_id, alias_text, alias_key) values ('${O.b}', 'Альфа-архив', 'альфа-архив')`)
    const byTerms = (obj, terms) => internalJson(fn(`signal_match_nodes(null, null, array['${obj}']::uuid[], array[${terms.map((t) => `'${t}'`).join(',')}], null)`)).nodes.map((n) => n.path)
    assert.deepEqual(byTerms(O.b, ['альфа-архив', 'секция']), [], 'объект Б: ни размеченного под А, ни неразмеченного')
    assert.deepEqual(byTerms(O.a, ['альфа-архив', 'секция б']), ['Общий / Секция А / Альфа-архив'])
    // Выключенный и не готовый корни закрыты целиком.
    assert.equal(asErr(P.editA, confirmCall(C.dpA2, T.off.id('Выключен / Папка В'), { ver: 0 })).message, 'node_unavailable')
    assert.equal(asErr(P.editA, confirmCall(C.dpA2, T.cold.id('Не готов / Папка Г'), { ver: 0 })).message, 'node_unavailable')
    // Убрали объект Б из корня: привязки поддеревьев на него и граница пересчитаны, объект А — единственный.
    assert.deepEqual(asJson(P.admin, fn(`signal_source_update(${S.multi.id}, null, array['${O.a}']::uuid[])`)), { ok: true, changed: true })
    assert.equal(sql(`select count(*) from osp_private.signal_nodes where source_id = ${S.multi.id} and object_id = '${O.a}'`), '4')
    assert.deepEqual(asJson(P.admin, fn(`signal_binding_set(${S.multi.id}, '${secA}', null)`)), { ok: true })
    assert.equal(sql(`select count(*) from osp_private.signal_nodes where source_id = ${S.multi.id} and object_id = '${O.a}'`), '4')
    // Выключили корень — всё снова закрыто; включили — готовность вернёт только публикация.
    asJson(P.admin, fn(`signal_source_update(${S.multi.id}, false, null)`))
    assert.equal(asErr(P.editA, confirmCall(C.dpA2, secB, { ver: 0 })).message, 'node_unavailable')
    asJson(P.admin, fn(`signal_source_update(${S.multi.id}, true, null)`))
    assert.equal(sql(`select ready::text from osp_private.signal_sources where id = ${S.multi.id}`), 'false')
    internal(`delete from osp_private.signal_aliases where alias_key = 'альфа-архив'; update osp_private.signal_sources set ready = true where id = ${S.multi.id};
      delete from osp_private.signal_contracts where contract_id = '${C.dpA2}'`)
  })

  it('CAS и идемпотентность подтверждения: устаревшие версия и ссылка — 409; повтор ключа — тот же ответ без второго события; замена — только с «Заменить»', () => {
    const node = T.a.id('Корень А / Корпус 1')
    const other = T.a.id('Корень А / Корпус 3')
    const events = (c) => sql(`select count(*) from public.contract_audit_log where contract_id = '${c}' and event_type = 'signal_link'`)
    const v0 = asJson(P.editA, fn(`signal_contract_view('${C.dpA}')`))
    assert.equal(v0.stateVersion, 0)
    assert.equal(asErr(P.editA, confirmCall(C.dpA, node, { ver: 5 })).message, 'stale_state')
    assert.equal(asErr(P.editA, confirmCall(C.dpA, node, { ver: 0, link: 'https://old.example.invalid/x' })).message, 'stale_state', 'ссылка в окне не та, что в базе')
    assert.equal(sql(`select coalesce(signal_link, '-') from public.contracts where id = '${C.dpA}'`), '-')
    assert.equal(events(C.dpA), '0')
    const key = 'confirm-key-1'
    const first = asJson(P.editA, confirmCall(C.dpA, node, { ver: 0, key, alias: 'Альфа корпус', aliasKey: 'альфа корпус' }))
    assert.deepEqual({ ...first, signalLink: undefined }, { state: 'verified', reason: 'confirmed', stateVersion: 1, signalLink: undefined })
    assert.equal(first.signalLink, `https://signal.example.invalid/folder/${node}`)
    assert.equal(events(C.dpA), '1')
    assert.equal(sql(`select changed_by_role || '|' || field_name || '|' || (new_value ->> 'url') || '|' || coalesce((old_value ->> 'url'), '-')
      from public.contract_audit_log where contract_id = '${C.dpA}' and event_type = 'signal_link'`), `sg_edit|signal_link|${first.signalLink}|-`)
    assert.equal(sql(`select description from public.contract_audit_log where contract_id = '${C.dpA}' and event_type = 'signal_link'`), 'Signal: связь подтверждена')
    assert.equal(sql(`select alias_text from osp_private.signal_aliases where alias_key = 'альфа корпус'`), 'Альфа корпус')
    // Повтор того же ключа тем же человеком — тот же ответ, второго события и второго синонима нет.
    assert.deepEqual(asJson(P.editA, confirmCall(C.dpA, node, { ver: 0, key, alias: 'Альфа корпус', aliasKey: 'альфа корпус' })), first)
    assert.equal(events(C.dpA), '1')
    assert.equal(sql(`select count(*) from osp_private.signal_aliases where alias_key = 'альфа корпус'`), '1')
    // Тот же ключ у другого человека не считается повтором; устаревшая версия — 409.
    const admin2 = seed.user({ role: 'sg_edit2', contracts: 'edit' })
    assert.equal(asErr(admin2, confirmCall(C.dpA, node, { ver: 0, key })).message, 'stale_state')
    // Другая ссылка без «Заменить» — 409 replace_required; с ним — замена, событие «ссылка заменена».
    const v1 = asJson(P.editA, fn(`signal_contract_view('${C.dpA}')`))
    assert.equal(v1.stateVersion, 1)
    assert.equal(v1.node.path, 'Корень А / Корпус 1')
    const url2 = `https://signal.example.invalid/folder/${other}`
    assert.equal(asErr(P.editA, confirmCall(C.dpA, other, { ver: 1, link: first.signalLink, url: url2 })).message, 'replace_required')
    assert.equal(sql(`select signal_link from public.contracts where id = '${C.dpA}'`), first.signalLink)
    const replaced = asJson(P.editA, confirmCall(C.dpA, other, { ver: 1, link: first.signalLink, url: url2, replace: true }))
    assert.equal(replaced.stateVersion, 2)
    assert.equal(sql(`select string_agg(description, ' / ' order by changed_at, description) from public.contract_audit_log where contract_id = '${C.dpA}' and event_type = 'signal_link'`),
      'Signal: связь подтверждена / Signal: ссылка заменена')
    // Очередь договора подтверждением снята; в состоянии — решение человека.
    assert.equal(sql(`select count(*) from osp_private.signal_queue where contract_id = '${C.dpA}'`), '0')
    assert.equal(sql(`select state || ':' || reason || '|' || (confirmed_by is not null) from osp_private.signal_contracts where contract_id = '${C.dpA}'`), `verified:confirmed|true`)
    // Узел из чужого поддерева / несуществующий / не папка — «узел недоступен».
    assert.equal(asErr(P.editA, confirmCall(C.dpA, T.a.id('Корень А / Корпус 1 / договор.pdf'), { ver: 2, link: url2, url: url2 })).message, 'node_unavailable', 'файл — не папка')
    assert.equal(asErr(P.editA, confirmCall(C.dpA, nextId('nod'), { ver: 2, link: url2 })).message, 'node_unavailable')
  })

  it('откат всего при занятом синониме: ссылка, состояние, кандидаты, история и очередь — как до вызова', () => {
    const node = T.a.id('Корень А / Корпус 2')
    // Договор с предложенными кандидатами (результат сопоставления).
    const rev = sql(`select dirty_revision from osp_private.signal_queue where contract_id = '${C.dpA2}'`)
    const gen = sql('select generation from osp_private.signal_meta')
    internal(`delete from osp_private.signal_contracts where contract_id = '${C.dpA2}'`)
    const item = { contractId: C.dpA2, revision: Number(rev), generation: Number(gen), state: 'suggested', reason: null, nodeId: null, fingerprint: 'f1', ctxKey: 'ctx-a2',
      candidates: [{ nodeId: node, score: 80, reasons: ['number'], flags: [] }, { nodeId: T.a.id('Корень А / Корпус 1'), score: 40, reasons: [], flags: [] }] }
    const w = internalJson(fn(`signal_state_write(null, '${JSON.stringify([item])}'::jsonb)`))
    assert.deepEqual(w, { written: 1, acked: 1, stale: 0 })
    internal(`insert into osp_private.signal_aliases (object_id, alias_text, alias_key) values ('${O.b}', 'Занят Бетой', 'занят бетой')`)
    const snapshot = () => sql(`select coalesce(c.signal_link, '-') || '|' || sc.state_version || '|' || sc.state || '|' ||
      (select count(*) from osp_private.signal_candidates k where k.contract_id = c.id and k.status = 'open') || '|' ||
      (select count(*) from public.contract_audit_log l where l.contract_id = c.id and l.event_type = 'signal_link') || '|' ||
      (select count(*) from osp_private.signal_aliases) || '|' || coalesce(sc.last_action_key, '-')
      from public.contracts c join osp_private.signal_contracts sc on sc.contract_id = c.id where c.id = '${C.dpA2}'`)
    const before = snapshot()
    assert.match(before, /^-\|1\|suggested\|2\|0\|\d+\|-$/)
    internal(`insert into osp_private.signal_queue (contract_id, dirty_revision) values ('${C.dpA2}', nextval('osp_private.signal_revision_seq')) on conflict do nothing`)
    const qBefore = sql(`select dirty_revision from osp_private.signal_queue where contract_id = '${C.dpA2}'`)
    const e = asErr(P.editA, confirmCall(C.dpA2, node, { ver: 1, alias: 'Занят Бетой', aliasKey: 'занят бетой', key: 'alias-fail-1' }))
    assert.deepEqual(e, { code: 'SG409', message: 'alias_taken' })
    assert.equal(snapshot(), before)
    assert.equal(sql(`select dirty_revision from osp_private.signal_queue where contract_id = '${C.dpA2}'`), qBefore, 'очередь не подтверждена')
    // Повтор того же вызова без синонима проходит: следа от неудачной попытки нет (ключ не запомнен).
    const ok = asJson(P.editA, confirmCall(C.dpA2, node, { ver: 1, key: 'alias-fail-1' }))
    assert.equal(ok.stateVersion, 2)
    assert.equal(sql(`select count(*) from osp_private.signal_candidates where contract_id = '${C.dpA2}' and status = 'open'`), '0', 'открытые кандидаты сняты подтверждением')
    // Синоним, уже стоящий за тем же объектом, — не ошибка (ничего не удваивается).
    assert.equal(sql("select count(*) from osp_private.signal_aliases where alias_key = 'занят бетой'"), '1')
  })

  it('отказ и снятие связи: версия и ссылка в CAS, повтор ключа не создаёт второго события, пара подавляется до смены ctx_key', () => {
    const node = T.a.id('Корень А / Корпус 1')
    const events = (c) => sql(`select count(*) from public.contract_audit_log where contract_id = '${c}' and event_type = 'signal_link'`)
    const gen = Number(sql('select generation from osp_private.signal_meta'))
    // dpA3: два кандидата → отказ первому → suggested, второму → none.
    const rev = Number(sql(`select dirty_revision from osp_private.signal_queue where contract_id = '${C.dpA3}'`))
    const item = { contractId: C.dpA3, revision: rev, generation: gen, state: 'suggested', reason: null, nodeId: null, fingerprint: 'f', ctxKey: 'ctx-a3',
      candidates: [{ nodeId: node, score: 90, reasons: [], flags: [] }, { nodeId: T.a.id('Корень А / Корпус 2'), score: 30, reasons: [], flags: [] }] }
    assert.equal(internalJson(fn(`signal_state_write(null, '${JSON.stringify([item])}'::jsonb)`)).written, 1)
    const v = asJson(P.editA, fn(`signal_contract_view('${C.dpA3}')`))
    assert.equal(v.state, 'suggested')
    assert.equal(v.candidates.length, 2)
    const rej = (n, ver, key) => `select osp_private.signal_reject('${C.dpA3}', '${n}', 'не наша папка', 'ctx-a3', ${ver}, '${key}')`
    assert.equal(asErr(P.editA, rej(node, v.stateVersion + 3, 'rk-1')).message, 'stale_state')
    assert.equal(asErr(P.editA, rej(nextId('nod'), v.stateVersion, 'rk-1')).message, 'stale_state', 'пары нет среди открытых')
    const r1 = asJson(P.editA, rej(node, v.stateVersion, 'rk-1'))
    assert.deepEqual(r1, { state: 'suggested', reason: null, stateVersion: v.stateVersion + 1 })
    assert.deepEqual(asJson(P.editA, rej(node, v.stateVersion, 'rk-1')), r1)
    assert.equal(events(C.dpA3), '1')
    assert.equal(sql(`select description from public.contract_audit_log where contract_id = '${C.dpA3}' and event_type = 'signal_link'`), 'Signal: предложенная папка отклонена')
    assert.equal(sql(`select status || '|' || ctx_key || '|' || note from osp_private.signal_candidates where contract_id = '${C.dpA3}' and node_id = '${node}'`), 'rejected|ctx-a3|не наша папка')
    const r2 = asJson(P.editA, rej(T.a.id('Корень А / Корпус 2'), r1.stateVersion, 'rk-2'))
    assert.deepEqual(r2, { state: 'none', reason: 'none', stateVersion: r1.stateVersion + 1 })
    assert.equal(events(C.dpA3), '2')
    // Матчер получает решённые пары вместе с ctx_key: подавление — его работа; при смене ctx_key пара снова может стать открытой.
    const loaded = internalJson(fn(`signal_match_load(array['${C.dpA3}']::uuid[])`)).contracts[0]
    assert.deepEqual(loaded.candidates.map((c) => `${c.status}:${c.ctxKey}`).sort(), ['rejected:ctx-a3', 'rejected:ctx-a3'])
    const rev2 = Number(sql(`select coalesce((select dirty_revision from osp_private.signal_queue where contract_id = '${C.dpA3}'), 0)`)) || null
    const again = { contractId: C.dpA3, revision: rev2, generation: gen, state: 'suggested', reason: null, nodeId: null, fingerprint: 'f2', ctxKey: 'ctx-a3-new',
      candidates: [{ nodeId: node, score: 90, reasons: [], flags: [] }] }
    assert.equal(internalJson(fn(`signal_state_write(null, '${JSON.stringify([again])}'::jsonb)`)).written, 1)
    assert.equal(sql(`select status || '|' || ctx_key from osp_private.signal_candidates where contract_id = '${C.dpA3}' and node_id = '${node}'`), 'open|ctx-a3-new', 'ctx_key сменился — пара снова открыта')
    assert.equal(sql(`select status from osp_private.signal_candidates where contract_id = '${C.dpA3}' and node_id = '${T.a.id('Корень А / Корпус 2')}'`), 'rejected', 'другая пара осталась отклонённой')

    // Снятие связи: dpA (связь на «Корпус 2», версия 2).
    const link = sql(`select signal_link from public.contracts where id = '${C.dpA}'`)
    const vA = asJson(P.editA, fn(`signal_contract_view('${C.dpA}')`)).stateVersion
    const unl = (l, ver, key) => `select osp_private.signal_unlink('${C.dpA}', 'ctx-a', '${l}', ${ver}, '${key}')`
    assert.equal(asErr(P.editA, unl(link, vA + 1, 'uk-1')).message, 'stale_state')
    assert.equal(asErr(P.editA, unl('https://signal.example.invalid/folder/other', vA, 'uk-1')).message, 'stale_state')
    assert.equal(sql(`select signal_link from public.contracts where id = '${C.dpA}'`), link)
    const u1 = asJson(P.editA, unl(link, vA, 'uk-1'))
    assert.deepEqual(u1, { state: 'none', reason: 'unlinked', stateVersion: vA + 1 })
    assert.deepEqual(asJson(P.editA, unl(link, vA, 'uk-1')), u1)
    assert.equal(sql(`select count(*) from public.contract_audit_log where contract_id = '${C.dpA}' and description = 'Signal: связь снята'`), '1')
    assert.equal(sql(`select coalesce(signal_link, '-') from public.contracts where id = '${C.dpA}'`), '-')
    assert.equal(sql(`select status || '|' || ctx_key from osp_private.signal_candidates where contract_id = '${C.dpA}' and node_id = '${T.a.id('Корень А / Корпус 3')}'`), 'unlinked|ctx-a')
    // Связи уже нет — снять нечего (окно устарело).
    assert.equal(asErr(P.editA, unl(link, vA + 1, 'uk-2')).message, 'stale_state')
  })

  it('синонимы: создание — только с правом правки и объектом в охвате; занятый ключ — 409; удаление — админ или автор', () => {
    const created = asJson(P.editA, fn(`signal_alias_create('${O.a}', 'Альфа-квартал', 'альфа-квартал')`))
    assert.ok(created.id > 0)
    assert.deepEqual(asErr(P.editA, fn(`signal_alias_create('${O.a}', 'АЛЬФА-КВАРТАЛ', 'альфа-квартал')`)), { code: 'SG409', message: 'alias_taken' })
    assert.equal(asErr(P.editA, fn(`signal_alias_create('${O.a}', 'x', 'x')`)).code, 'SG422', 'название короче двух знаков')
    assert.equal(sql('select count(*) from osp_private.signal_queue q join public.contracts c on c.id = q.contract_id where c.deleted_at is null'),
      sql('select count(*) from public.contracts where deleted_at is null'), 'синоним ставит в очередь все договоры')
    assert.equal(asErr(P.viewA, fn(`signal_alias_delete(${created.id})`)).code, 'SG403')
    assert.equal(asErr(P.editB, fn(`signal_alias_delete(${created.id})`)).code, 'SG403', 'не автор')
    const mine = seed.user({ role: 'sg_edit', contracts: 'edit', objectIds: [O.a] })
    assert.equal(asErr(mine, fn(`signal_alias_delete(${created.id})`)).code, 'SG403', 'другой сотрудник того же объекта — не автор')
    const list = asJson(P.admin, fn('signal_alias_list()')).items
    assert.ok(list.some((a) => a.id === created.id && a.text === 'Альфа-квартал' && a.objectName === 'Тест: ЖК Альфа' && a.author))
    assert.deepEqual(asJson(P.editA, fn(`signal_alias_delete(${created.id})`)), { ok: true })
    const second = asJson(P.editA, fn(`signal_alias_create('${O.a}', 'Альфа-квартал 2', 'альфа-квартал 2')`))
    // Автор потерял охват объекта — удалить уже не может (W1-09); администратор — может.
    internal(`update public.user_roles set object_ids = array['${O.b}']::uuid[] where user_id = '${P.editA}'`)
    assert.equal(asErr(P.editA, fn(`signal_alias_delete(${second.id})`)).code, 'SG403')
    internal(`update public.user_roles set object_ids = array['${O.a}']::uuid[] where user_id = '${P.editA}'`)
    assert.deepEqual(asJson(P.admin, fn(`signal_alias_delete(${second.id})`)), { ok: true })
    assert.equal(asErr(P.admin, fn(`signal_alias_delete(${second.id})`)).code, 'SG404')
    // Журнал базы пишет создание и удаление синонимов (row_id — число-id как uuid).
    assert.ok(Number(sql(`select count(*) from osp_private.data_audit_log where table_name = 'signal_aliases' and op = 'DELETE' and row_id = lpad(to_hex(${created.id}), 32, '0')::uuid`)) === 1)
  })

  describe('Ф4 / J1: правки договоров не зависят от сверки', () => {
    const dpFromRequest = () => `with r as (
        insert into public.doc_check_requests (object_id, counterparty_id, doc_type, status, sort_order, notes)
        values ('${O.a}', '${C.cp1}', 'dp_conclusion', 'in_progress', 1, 'Тест: заявка') returning id)
      select id as req_id from r \\gset
      select count(*) from public.contracts where doc_check_request_id = :'req_id';`
    // Один набор операций, которые портал делает с договорами: правка, вставка ДП и ДС, правка сторон, создание из заявки.
    const OPS = (n) => `
      update public.contracts set contract_number = 'ФОУ-ДП-26-${String(n).padStart(3, '0')}' where id = '${C.dpB}';
      insert into public.contracts (object_id, record_type, contract_number, counterparty_id) values ('${O.a}', 'dp', 'ФОУ-ДП-27-${String(n).padStart(3, '0')}', '${C.cp1}');
      insert into public.contract_counterparties (contract_id, counterparty_id) values ('${C.dpB}', '${C.cp2}');
      delete from public.contract_counterparties where contract_id = '${C.dpB}' and counterparty_id = '${C.cp2}';
      update public.objects set name = 'Тест: ЖК Бета ${n}' where id = '${O.b}';`
    const ds = (parent) => `insert into public.contracts (object_id, record_type, parent_contract_id, contract_number) values ('${O.b}', 'ds_extra', '${parent}', 'ДС-${nextId('x')}');`

    it('пустые таблицы SIGNAL (очередь пуста): правка, вставка, стороны, ДС и создание из заявки «Заключение ДП» проходят; очередь получает строки', () => {
      internal('delete from osp_private.signal_queue');
      const out = must(`BEGIN;\n${OPS(1)}\n${ds(C.dpB)}\n${dpFromRequest()}\nselect 'queued=' || count(*) from osp_private.signal_queue;\nROLLBACK;`)
      assert.equal(out.at(-2), '1', 'создан один договор из заявки')
      assert.match(out.at(-1), /^queued=\d+$/)
      assert.ok(Number(out.at(-1).split('=')[1]) >= 4)
    })

    it('очередь переименована или удалена, последовательность ревизий удалена: те же операции проходят, предупреждение signal_enqueue_skipped', () => {
      for (const [what, ddl] of [['переименована', 'alter table osp_private.signal_queue rename to signal_queue_moved'],
        ['удалена', 'drop table osp_private.signal_queue cascade'], ['нет последовательности', 'drop sequence osp_private.signal_revision_seq cascade'],
        ['нет первичного ключа', 'alter table osp_private.signal_queue drop constraint signal_queue_pkey']]) {
        const r = run(`BEGIN;\n${ddl};\n${OPS(2)}\n${ds(C.dpB)}\n${dpFromRequest()}\nselect 'done';\nROLLBACK;`)
        assert.ok(r.ok, `${what}: ${r.err.split('\n').find((l) => /ERROR/.test(l))}`)
        assert.equal(r.out.at(-1), 'done', what)
        assert.match(r.err, /signal_enqueue_skipped/, `${what}: предупреждение в ответе`)
      }
    })

    it('очередь заблокирована в другой сессии (ACCESS EXCLUSIVE): операции проходят, каждая ждёт не дольше lock_timeout триггера', async () => {
      const release = await hold("begin; lock table osp_private.signal_queue in access exclusive mode;")
      try {
        const t1 = timedMs(`update public.contracts set contract_number = 'ЛОК-ДП-26-001' where id = '${C.dpB}';`)
        assert.ok(t1 >= 200 && t1 < 1000, `правка договора: ${t1} мс (триггер ждёт 250 мс и пропускает)`)
        const t2 = timedMs(`insert into public.contracts (object_id, record_type, contract_number) values ('${O.a}', 'dp', 'ЛОК-ДП-26-002');`)
        assert.ok(t2 >= 200 && t2 < 1000, `вставка договора: ${t2} мс`)
        const t3 = timedMs(`insert into public.contracts (object_id, record_type, parent_contract_id, contract_number) values ('${O.b}', 'ds_extra', '${C.dpB}', 'ЛОК-ДС-1');`)
        assert.ok(t3 >= 200 && t3 < 1000, `вставка ДС: ${t3} мс`)
        const t4 = timedMs(`insert into public.contract_counterparties (contract_id, counterparty_id) values ('${C.dpB}', '${C.cp2}');`)
        assert.ok(t4 >= 200 && t4 < 1000, `правка сторон: ${t4} мс`)
        const t5 = timedMs(`update public.contract_counterparties set sort_order = 3 where contract_id = '${C.dpB}';`)
        assert.ok(t5 < 150, `несущественная правка сторон не ждёт очередь: ${t5} мс`)
        const t6 = timedMs(`update public.objects set name = 'Тест: ЖК Бета лок' where id = '${O.b}';`)
        assert.ok(t6 >= 200 && t6 < 1000, `смена имени объекта: ${t6} мс`)
        const t7 = timedMs(dpFromRequest())
        assert.ok(t7 >= 200 && t7 < 2000, `создание договора из заявки «Заключение ДП»: ${t7} мс (договор + стороны — два срабатывания)`)
        assert.equal(sql(`select count(*) from public.contracts where contract_number = 'ЛОК-ДП-26-001'`), '1')
        assert.ok(Number(sql(`select count(*) from public.contracts where doc_check_request_id is not null and notes like '%Тест: заявка%'`)) >= 1)
      } finally {
        await release()
      }
      // Блокировка строки очереди (читающий захват) — тот же результат: триггер не ждёт дольше lock_timeout.
      const q = sql(`select contract_id from osp_private.signal_queue limit 1`)
      if (q) {
        const rel = await hold(`begin; select * from osp_private.signal_queue where contract_id = '${q}' for update;`)
        try {
          const t = timedMs(`update public.contracts set contract_number = contract_number || 'x' where id = '${q}';`)
          assert.ok(t >= 200 && t < 1000, `строка очереди занята: ${t} мс`)
        } finally { await rel() }
      }
    })

    it('ревизии очереди: номер, объект, стороны, ссылка, удаление, смена ДП → ДС — новая ревизия; несущественная правка — нет', () => {
      const dp = seed.contract({ number: 'РЕВ-ДП-26-001', objectId: O.a, counterparties: [C.cp1] })
      const dsx = seed.contract({ number: 'РЕВ-ДС-1', objectId: O.a, recordType: 'ds_vor', parent: dp, counterparties: [C.cp1] })
      const dp2 = seed.contract({ number: 'РЕВ-ДП-26-002', objectId: O.a, counterparties: [C.cp1] })
      const rev = (c) => Number(sql(`select coalesce((select dirty_revision from osp_private.signal_queue where contract_id = '${c}'), 0)`))
      const bumped = (c, before) => rev(c) > before
      const snapshot = () => ({ dp: rev(dp), ds: rev(dsx), dp2: rev(dp2) })
      const ack = () => internal(`delete from osp_private.signal_queue where contract_id in ('${dp}', '${dsx}', '${dp2}')`)

      ack()
      let b = snapshot()
      assert.deepEqual(b, { dp: 0, ds: 0, dp2: 0 })
      internal(`update public.contracts set notes = 'правка заметки', updated_at = now() where id = '${dp}'`)
      assert.deepEqual(snapshot(), b, 'заметка и updated_at — несущественная правка')
      internal(`update public.contracts set contract_number = contract_number, object_id = object_id where id = '${dp}'`)
      assert.deepEqual(snapshot(), b, 'присваивание тех же значений — пропуск')
      internal(`update public.contract_counterparties set sort_order = 9 where contract_id = '${dp}'`)
      assert.deepEqual(snapshot(), b, 'порядок сторон — несущественно')
      internal(`update public.counterparties set name = name || ' ' where id = '${C.cp2}'`)
      assert.deepEqual(snapshot(), b, 'имя контрагента очередь не трогает')

      internal(`update public.contracts set contract_number = 'РЕВ-ДП-26-011' where id = '${dp}'`)
      let a = snapshot()
      assert.ok(a.dp > b.dp && a.ds > b.ds && a.dp2 === 0, 'смена номера ДП — ревизии ДП и его ДС')
      ack()
      internal(`update public.contracts set contract_number = 'РЕВ-ДС-2' where id = '${dsx}'`)
      a = snapshot()
      assert.ok(a.ds > 0 && a.dp === 0, 'смена номера ДС — только его ревизия')
      ack()
      internal(`update public.contracts set object_id = '${O.b}' where id = '${dp2}'`)
      assert.ok(rev(dp2) > 0)
      internal(`update public.contracts set object_id = '${O.a}' where id = '${dp2}'`)
      ack()
      b = snapshot()
      internal(`insert into public.contract_counterparties (contract_id, counterparty_id) values ('${dp}', '${C.cp2}')`)
      assert.ok(bumped(dp, b.dp) && rev(dsx) === 0, 'новая сторона — ревизия договора')
      ack()
      internal(`delete from public.contract_counterparties where contract_id = '${dp}' and counterparty_id = '${C.cp2}'`)
      assert.ok(rev(dp) > 0, 'снятая сторона')
      ack()
      internal(`update public.contract_counterparties set counterparty_id = '${C.cp2}' where contract_id = '${dp}' and counterparty_id = '${C.cp1}'`)
      assert.ok(rev(dp) > 0, 'замена стороны')
      ack()
      internal(`update public.contracts set signal_link = 'https://signal.example.invalid/folder/x' where id = '${dp}'`)
      assert.ok(rev(dp) > 0 && rev(dsx) > 0, 'ссылка ДП — ревизии ДП и ДС')
      ack()
      internal(`update public.contracts set contract_date = '2026-05-01' where id = '${dsx}'`)
      assert.ok(rev(dsx) > 0, 'дата договора')
      ack()
      internal(`update public.contracts set deleted_at = now() where id = '${dp2}'`)
      assert.ok(rev(dp2) > 0, 'договор снят в корзину — ревизия (состояние очистит сопоставитель)')
      internal(`update public.contracts set deleted_at = null where id = '${dp2}'`)
      ack()
      internal(`update public.contracts set parent_contract_id = '${dp2}' where id = '${dsx}'`)
      assert.ok(rev(dsx) > 0 && rev(dp) === 0, 'ДС перешёл к другому ДП: ревизия ДС (договоры-родители состояние ДС не меняют)')
      ack()
      // Переименование объекта и его кода — договоры объекта; адрес объекта — нет.
      internal(`update public.objects set address = 'другой адрес' where id = '${O.a}'`)
      assert.equal(rev(dp), 0)
      internal(`update public.objects set name = 'Тест: ЖК Альфа 2' where id = '${O.a}'`)
      assert.ok(rev(dp) > 0 && rev(dsx) > 0 && rev(dp2) > 0, 'имя объекта — все его договоры')
      // Новый договор и новый ДС — сразу в очереди; удаление договора убирает его строку (внешний ключ) без ошибки.
      const dsNew = seed.contract({ number: 'РЕВ-ДС-3', objectId: O.a, recordType: 'ds_extra', parent: dp2, counterparties: [C.cp1] })
      assert.ok(rev(dsNew) > 0)
      internal(`delete from public.contracts where id = '${dsNew}'`)
      assert.equal(rev(dsNew), 0)
    })

    it('создание договора из заявки «Заключение ДП» (20270225): договор и сторона в очереди, история «Создание» записана', () => {
      internal('delete from osp_private.signal_queue')
      const out = must(`${dpFromRequest()}\nselect c.id from public.contracts c where c.doc_check_request_id = :'req_id';`)
      const id = out.at(-1)
      assert.match(id, /^[0-9a-f-]{36}$/)
      assert.equal(sql(`select count(*) from osp_private.signal_queue where contract_id = '${id}'`), '1')
      assert.equal(sql(`select count(*) from public.contract_audit_log where contract_id = '${id}' and event_type = 'created'`), '1')
      assert.equal(sql(`select dirty_revision > 0 from osp_private.signal_queue where contract_id = '${id}'`), 't')
    })
  })

  it('откат убирает триггеры, функции, таблицы и последовательность, не трогает ссылки договоров; повтор отката безопасен; миграция применяется снова', () => {
    const counts = () => sql(`select
      (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'osp_private' and p.proname like 'signal\\_%') || '|' ||
      (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'osp_private' and c.relname like 'signal\\_%') || '|' ||
      (select count(*) from pg_trigger where tgname like 'osp\\_signal\\_enqueue\\_%' and not tgisinternal) || '|' ||
      (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname like 'signal\\_%' and not t.tgisinternal)`)
    const links = sql(`select count(*) from public.contracts where signal_link is not null`)
    const events = sql(`select count(*) from public.contract_audit_log where event_type = 'signal_link'`)
    assert.notEqual(counts(), '0|0|0|0')
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(counts(), '0|0|0|0')
    psqlAt(db.port, null, { file: ROLLBACK })
    assert.equal(sql(`select count(*) from public.contracts where signal_link is not null`), links, 'ссылки на месте')
    assert.equal(sql(`select count(*) from public.contract_audit_log where event_type = 'signal_link'`), events, 'история на месте')
    assert.ok(Number(sql(`select count(*) from pg_proc where proname = 'contracts_hierarchy_guard'`)) >= 1, 'чужие функции не тронуты')
    // Проверка для прода отвечает FAIL, не падает; правки договоров идут как до миграции.
    const after = psqlAt(db.port, null, { file: BACKUP_CHECK })
    assert.match(after, /^FAIL /m)
    must(`update public.contracts set contract_number = 'ПОСЛЕ-ДП-26-001' where id = '${C.dpB}';
      insert into public.contracts (object_id, record_type, contract_number) values ('${O.a}', 'dp', 'ПОСЛЕ-ДП-26-002');
      insert into public.contract_counterparties (contract_id, counterparty_id) values ('${C.dpB}', '${C.cp2}') on conflict do nothing;
      update public.objects set name = 'Тест: ЖК Бета после' where id = '${O.b}';`)
    psqlAt(db.port, null, { file: MIGRATION })
    const out = psqlAt(db.port, null, { file: BACKUP_CHECK })
    assert.doesNotMatch(out, /^FAIL/m, out)
    assert.equal(sql(`select generation || '|' || schema_version from osp_private.signal_meta`), '0|1')
    assert.equal(sql(`select count(*) from osp_private.signal_queue`), '0', 'очередь после повторной выкладки пуста: поставит публикация')
    internal(`update public.contracts set contract_number = 'ПОСЛЕ-ДП-26-003' where id = '${C.dpB}'`)
    assert.equal(sql(`select count(*) from osp_private.signal_queue where contract_id = '${C.dpB}'`), '1', 'триггеры работают снова')
    // Служебные функции после повторной выкладки снова отказывают вошедшему.
    assert.equal(asErr(P.admin, fn('signal_sync_due()')).code, 'SG403')
  })
})
