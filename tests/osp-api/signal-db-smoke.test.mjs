// Смоук базы сверки с SIGNAL (миграция 20270228_signal_integration, пакет P1) на настоящем PostgreSQL: миграция применяется к заготовке
// схемы портала, повторное применение безопасно, сидеры синтетики работают, настоящая обёртка osp-api (db.read / db.write)
// доходит до функций и получает их ошибки кодом. Подробные проверки — signal-db-functions.test.mjs и tests/db/signal-migration.test.mjs.
// Хелпер для остальных пакетов — tests/osp-api/lib/signal-db.mjs. Нужны зависимости сервера и PostgreSQL (бинарники или Docker).
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startSignalDb, signalDbSkip } from './lib/signal-db.mjs'

const TABLES = ['signal_meta', 'signal_sources', 'signal_bindings', 'signal_nodes', 'signal_stage_nodes', 'signal_runs',
  'signal_contracts', 'signal_candidates', 'signal_aliases', 'signal_queue']

describe('База сверки с SIGNAL: миграция, повтор, сидеры, обёртка osp-api', { skip: signalDbSkip, timeout: 300000 }, () => {
  let db
  let sdb

  before(async () => {
    db = await startSignalDb()
    sdb = await db.serverDb()
  })
  after(async () => { await db?.stop() })

  it('десять таблиц закрытой схемы: правила по строкам включены и действуют на владельца, политика одна — пропуск', () => {
    const rows = db.sql(`select c.relname || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity || '|' ||
        (select string_agg(p.polname, ',') from pg_policy p where p.polrelid = c.oid)
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'osp_private' and c.relname like 'signal\\_%' and c.relkind = 'r' order by 1`).split('\n')
    assert.deepEqual(rows, TABLES.slice().sort().map((t) => `${t}|true|true|osp_internal`))
    assert.equal(db.sql(`select schema_version || '|' || generation from osp_private.signal_meta where id = 1`), '1|0')
  })

  it('повторное применение безопасно: данные и единственная строка signal_meta на месте', () => {
    const obj = db.seed.object({ name: 'Тест: смоук-объект' })
    db.sql(`update osp_private.signal_meta set generation = 7 where id = 1`)
    db.applyMigration()
    db.applyMigration()
    assert.equal(db.sql(`select count(*) || '|' || max(generation) from osp_private.signal_meta`), '1|7')
    assert.equal(db.sql(`select count(*) from public.objects where id = '${obj}'`), '1')
    assert.equal(db.sql(`select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where t.tgname like 'osp\\_signal\\_enqueue\\_%' and not t.tgisinternal`), '7')
    db.sql(`update osp_private.signal_meta set generation = 0 where id = 1`)
  })

  it('повторное применение на базе с первой редакцией очереди (без recheck_only): колонка добавляется, строки очереди остаются', () => {
    const col = `select data_type || '|' || is_nullable || '|' || column_default from information_schema.columns
      where table_schema = 'osp_private' and table_name = 'signal_queue' and column_name = 'recheck_only'`
    assert.equal(db.sql(col), 'boolean|NO|false')
    const c = db.seed.contract({ number: 'СМОУК-ДП-26-077' })
    assert.equal(db.sql(`select count(*) from osp_private.signal_queue where contract_id = '${c}'`), '1')
    db.sql('alter table osp_private.signal_queue drop column recheck_only')
    assert.equal(db.sql(col), '')
    db.applyMigration()
    assert.equal(db.sql(col), 'boolean|NO|false')
    assert.equal(db.sql(`select recheck_only from osp_private.signal_queue where contract_id = '${c}'`), 'f', 'прежние строки очереди — правки реквизитов')
  })

  it('сидеры: объект, сотрудник с правом, администратор, подрядчик, договор с ДС, корень и снимок с границей объекта', () => {
    const { seed } = db
    const obj = seed.object({ name: 'Тест: ЖК Смоук', code: 'СМОУК' })
    const other = seed.object({ name: 'Тест: ЖК Чужой' })
    const editor = seed.user({ contracts: 'edit', objectIds: [obj] })
    const admin = seed.admin()
    const contractor = seed.contractor()
    const cp = seed.counterparty({ name: 'ООО Тест Смоук', inn: '7700000000' })
    const dp = seed.contract({ number: 'СМОУК-ДП-26-001', objectId: obj, counterparties: [cp] })
    const ds = seed.contract({ number: 'ДС-1', objectId: obj, recordType: 'ds_vor', parent: dp, counterparties: [cp] })
    assert.equal(db.sql(`select root_contract_id = '${dp}' from public.contracts where id = '${ds}'`), 't')
    assert.deepEqual(db.asJson(editor, 'select osp_private.signal_user_flags()'), { canView: true, canEdit: true, isAdmin: false })
    assert.deepEqual(db.asJson(admin, 'select osp_private.signal_user_flags()'), { canView: true, canEdit: true, isAdmin: true })
    assert.deepEqual(db.asJson(contractor, 'select osp_private.signal_user_flags()'), { canView: false, canEdit: false, isAdmin: false })

    const src = seed.source({ objectIds: [obj] })
    const snap = seed.snapshot(src.id, { name: 'Корень', children: [{ name: 'Корпус 1', numberKeys: ['СМОУК|2026|1'], items: [{ name: 'договор.pdf' }] }] })
    assert.equal(Object.keys(snap.ids).length, 3)
    assert.equal(db.sql(`select count(*) from osp_private.signal_nodes where object_id = '${obj}'`), '3', 'единственный объект корня — граница всех узлов')
    assert.equal(db.sql(`select count(*) from osp_private.signal_nodes where object_id = '${other}'`), '0')
    assert.equal(db.sql(`select generation from osp_private.signal_meta`), '1')
    // Триггеры очереди: договор и ДС поставлены в очередь при вставке.
    assert.equal(db.sql(`select count(*) from osp_private.signal_queue where contract_id in ('${dp}', '${ds}')`), '2')
    // Журнал базы пишет корень и привязку (id bigint → row_id-uuid).
    assert.equal(db.sql(`select count(*) from osp_private.data_audit_log where table_name in ('signal_sources', 'signal_bindings')`), '2')
  })

  it('обёртка osp-api: служебное чтение без вошедшего, пользовательское — с ним, отказ служебной функции вошедшему — кодом SG403', async () => {
    const due = await sdb.read(null, async (tx) => (await tx.query(`select osp_private.signal_sync_due('2026-11-23T03:00:00Z') as r`)).rows[0].r)
    assert.deepEqual(due, { due: true, kind: 'night', slot: '2026-11-23T02:00:00+00:00' })
    const admin = db.seed.admin()
    const state = await sdb.read({ userId: admin, email: '' }, async (tx) => (await tx.query('select osp_private.signal_admin_state() as r')).rows[0].r)
    assert.equal(state.meta.schemaVersion, 1)
    await assert.rejects(
      sdb.write({ userId: admin, email: '' }, (tx) => tx.query('select osp_private.signal_sync_due()')),
      (err) => err.code === 'SG403' && err.message === 'forbidden')
    const editor = db.seed.user({ contracts: 'view' })
    await assert.rejects(
      sdb.read({ userId: editor, email: '' }, (tx) => tx.query('select osp_private.signal_admin_state()')),
      (err) => err.code === 'SG403')
    // Служебная запись без вошедшего проходит правила по строкам (отметка osp:internal ставит обёртка).
    const begun = await sdb.write(null, async (tx) => (await tx.query(`select osp_private.signal_sync_begin('manual', 'full', 'cli', null) as r`)).rows[0].r)
    assert.ok(begun.runId > 0 && /^[0-9a-f-]{36}$/.test(begun.ownerToken))
    const again = await sdb.write(null, async (tx) => (await tx.query(`select osp_private.signal_sync_begin('manual', 'full', 'cli', null) as r`)).rows[0].r)
    assert.equal(again, null, 'идёт другой прогон — NULL')
    await sdb.write(null, (tx) => tx.query(`select osp_private.signal_sync_fail($1, $2, 'cancelled', 'readonly', '{}'::jsonb)`, [begun.runId, begun.ownerToken]))
  })

  it('повторное применение поверх первой редакции: прежние сигнатуры confirm / reject / unlink / publish заменяются, а не плодятся; ограничения состояния и прогона расширяются; граница и путь пересчитываются', () => {
    const o = db.seed.object({ name: 'Тест: объект апгрейда', code: 'АПГР' })
    const src = db.seed.source({ objectIds: [o] })
    const snap = db.seed.snapshot(src.id, { name: 'Корень', children: [{ name: 'Папка', children: [{ name: 'Вложенная' }] }] })
    const nested = snap.ids['Корень / Папка / Вложенная']
    // Прежняя редакция: четыре старые сигнатуры, семь состояний, прогон без partial, пути от границы нет.
    db.sql(`CREATE FUNCTION osp_private.signal_confirm(p_contract uuid, p_node uuid, p_url text, p_replace boolean, p_alias_text text, p_alias_key text, p_fingerprint text, p_expected_link text, p_expected_version bigint, p_key text) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
      CREATE FUNCTION osp_private.signal_reject(p_contract uuid, p_node uuid, p_note text, p_ctx_key text, p_expected_version bigint, p_key text) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
      CREATE FUNCTION osp_private.signal_unlink(p_contract uuid, p_ctx_key text, p_expected_link text, p_expected_version bigint, p_key text) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
      CREATE FUNCTION osp_private.signal_publish(p_run bigint, p_stats jsonb, p_actor text, p_reason text) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
      ALTER TABLE osp_private.signal_contracts DROP CONSTRAINT signal_contracts_state_check;
      ALTER TABLE osp_private.signal_contracts ADD CONSTRAINT signal_contracts_state_check CHECK (state IN ('none', 'suggested', 'verified', 'unverified', 'attention', 'missing', 'conflict'));
      ALTER TABLE osp_private.signal_runs DROP CONSTRAINT signal_runs_status_check;
      ALTER TABLE osp_private.signal_runs ADD CONSTRAINT signal_runs_status_check CHECK (status IN ('running', 'ok', 'held', 'failed', 'cancelled'));
      UPDATE osp_private.signal_nodes SET object_path = NULL`)
    assert.equal(db.sql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'osp_private' and p.proname in ('signal_confirm', 'signal_reject', 'signal_unlink', 'signal_publish')`), '8')
    assert.match(db.sqlError(`insert into osp_private.signal_contracts (contract_id, state) values ('${db.seed.contract({ number: 'АПГР-ДП-26-001', objectId: o })}', 'accepted')`).message, /check constraint|signal_contracts_state_check/)
    db.applyMigration()
    assert.equal(db.sql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'osp_private' and p.proname in ('signal_confirm', 'signal_reject', 'signal_unlink', 'signal_publish')`), '4', 'прежние сигнатуры убраны')
    assert.equal(db.sql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'osp_private' and p.proname like 'signal\\_%'`), '54')
    assert.equal(db.sql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'osp_private' and p.proname like 'signal\\_%' and has_function_privilege('public', p.oid, 'EXECUTE')`), '0')
    const c = db.seed.contract({ number: 'АПГР-ДП-26-002', objectId: o })
    db.sql(`insert into osp_private.signal_contracts (contract_id, state, reason) values ('${c}', 'accepted', 'number_not_found')`)
    db.sql(`insert into osp_private.signal_runs (kind, mode, status, initiator, owner_token) values ('manual', 'full', 'partial', 'cli', gen_random_uuid())`)
    assert.equal(db.sql(`select object_path from osp_private.signal_nodes where node_id = '${nested}'`), 'Корень / Папка / Вложенная', 'путь от границы пересчитан для уже опубликованных узлов')
    db.sql('delete from osp_private.signal_runs')
  })
})
