// Тестовая база для сверки договоров с SIGNAL (миграция migration/yandex/20270228_signal_integration.sql) на настоящем PostgreSQL:
// временный кластер (tests/psdc/lib/pg.mjs: бинарники из PG_BIN или одноразовый контейнер Docker), минимальная заготовка схемы
// портала в базе Яндекса — одна учётка-владелец без прав суперпользователя (правила по строкам FORCE действуют и на неё),
// затем настоящий файл миграции. Заготовка берёт настоящие тексты функций из миграций, где это возможно: is_admin и osp_can
// (supabase/migrations/20261010_r2ab_employee_only.sql), osp_object_scope и osp_contract_in_scope (20270120), журнал базы и
// audit_log_stamp (20270121), ключи номера договора (20270110); auth — migration/target/compat/auth.sql.
//
//   const db = await startSignalDb()                 // кластер + заготовка + миграция
//   db.sql("select count(*) from osp_private.signal_queue")      // служебная операция (отметка osp:internal), текст → строки
//   db.as(uid, "select osp_private.signal_user_flags()")         // как db.write(who): jwt claims + application_name='osp-api'
//   db.asJson(uid, "select osp_private.signal_marks(null, 100)") // то же, ответ jsonb разобран
//   db.asError(uid, "select osp_private.signal_confirm(…)")      // → {code:'SG409', message:'stale_state'} (ошибка SQL как данные)
//   const sdb = await db.serverDb()                  // настоящая обёртка server/osp-api/src/lib/db.js (db.read / db.write)
//   const seed = db.seed
//   const obj = seed.object({ name: 'Тест: объект А', code: 'АЛИЯ' })
//   const user = seed.user({ role: 'sig_edit', contracts: 'edit', objectIds: [obj] })    // сотрудник с правом правки договоров
//   const admin = seed.admin()
//   const dp = seed.contract({ number: 'АЛИЯ-ДП-26-001', objectId: obj, counterparties: [seed.counterparty({ name: 'ООО Тест', inn: '7700000000' })] })
//   const src = seed.source({ objectIds: [obj] })
//   const snap = seed.snapshot(src.id, { name: 'Корень', children: [{ name: 'Корпус 1', numberKeys: ['АЛИЯ|2026|1'] }] })
//   // snapshot кладёт узлы напрямую (поколение — generation: по умолчанию 1: при нескольких снимках в одной базе передавайте текущее),
//   // граница и object_path считает signal_recompute_objects. seed.sync({roots:[{src, tree, ids}], stats}) — настоящий прогон:
//   // begin → stage_put → finish (статус ok | partial | held | failed — в result.status).
//   await db.stop()
//
// Данные — только синтетика (идентификаторы вида …-4000-8000-…). Нужны зависимости сервера (npm ci --prefix server/osp-api).
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { TestDatabase, pgAvailable } from '../../psdc/lib/pg.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const SERVER = path.join(ROOT, 'server', 'osp-api')
// SIGNAL_DB_MIGRATION — другая редакция миграции (проверка «тест падает без правки»: прежний файл из git show); по умолчанию — настоящая.
export const MIGRATION = process.env.SIGNAL_DB_MIGRATION || path.join(ROOT, 'migration', 'yandex', '20270228_signal_integration.sql')
export const CHECK = path.join(ROOT, 'migration', 'yandex', '20270228_signal_integration.check.sql')
export const ROLLBACK = path.join(ROOT, 'migration', 'rollback', '20270228_signal_integration_rollback.sql')
export const OWNER = 'osp_owner'

const depsOk = fs.existsSync(path.join(SERVER, 'node_modules', 'pg'))
export const signalDbSkip = !depsOk ? 'нет зависимостей: npm ci --prefix server/osp-api' : !pgAvailable() ? 'нет PostgreSQL (бинарники или Docker)' : false

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8')

// Текст функции из файла миграции: от «CREATE [OR REPLACE] FUNCTION <имя>(» до первой строки «$$;».
function fnText(file, name) {
  const text = read(...file)
  const start = text.search(new RegExp(`CREATE (OR REPLACE )?FUNCTION ${name.replace('.', '\\.')}\\(`))
  if (start < 0) throw new Error(`signal-db: в ${file.join('/')} нет функции ${name}`)
  const end = text.indexOf('\n$$;', start)
  if (end < 0) throw new Error(`signal-db: не найден конец функции ${name}`)
  return text.slice(start, end + 4)
}

// Журнал базы из 20270121: таблица, правила, data_audit_write, data_audit_row (без подключения к таблицам — оно в той миграции своё).
function auditTrailText() {
  const text = read('migration', 'yandex', '20270121_audit_trail.sql')
  const start = text.indexOf('CREATE TABLE IF NOT EXISTS osp_private.data_audit_log')
  const end = text.indexOf('DO $data_audit$')
  if (start < 0 || end < start) throw new Error('signal-db: не найден журнал базы в 20270121_audit_trail.sql')
  return text.slice(start, end)
}

const policy = (table) => `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY osp_internal ON ${table} FOR ALL TO PUBLIC USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));`

// Заготовка схемы: только то, чего требует миграция и её функции. Колонки — как в migration/schema/prod-schema.sql (подмножество).
export function prelude() {
  return `
${read('migration', 'target', 'compat', 'auth.sql')}
CREATE SCHEMA osp_private;
-- migration/target/sql/load-single-owner.sql: пропуск служебных операций и роль из токена.
CREATE FUNCTION osp_private.bypass() RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT coalesce(pg_catalog.current_setting('application_name', true), '') = 'osp:internal' OR coalesce(auth.role(), '') = 'service_role' $$;
CREATE FUNCTION osp_private.role_in(VARIADIC p_roles text[]) RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT coalesce(nullif(auth.role(), ''), 'anon') = ANY (p_roles) $$;

CREATE TABLE public.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(255) NOT NULL,
  address text NOT NULL DEFAULT '',
  contract_code text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now());
${policy('public.objects')}
CREATE TABLE public.counterparties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, inn text, deleted_at timestamptz);
${policy('public.counterparties')}
CREATE TABLE public.roles (key text PRIMARY KEY, label text NOT NULL, is_system boolean NOT NULL DEFAULT false, object_scoped boolean NOT NULL DEFAULT false);
${policy('public.roles')}
CREATE TABLE public.role_permissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), role text NOT NULL, section text NOT NULL,
  can_view boolean NOT NULL DEFAULT true, can_edit boolean NOT NULL DEFAULT false, UNIQUE (role, section));
${policy('public.role_permissions')}
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE, role text NOT NULL DEFAULT 'engineer',
  is_approved boolean NOT NULL DEFAULT false, email text, full_name text, work_phone text, object_id uuid,
  object_ids uuid[] NOT NULL DEFAULT '{}', counterparty_id uuid REFERENCES public.counterparties(id) ON DELETE SET NULL,
  is_blocked boolean NOT NULL DEFAULT false, CONSTRAINT user_roles_blocked_not_approved CHECK (NOT (is_blocked AND is_approved)));
${policy('public.user_roles')}
CREATE TABLE public.superadmins (user_id uuid PRIMARY KEY, added_at timestamptz NOT NULL DEFAULT now(), note text);
${policy('public.superadmins')}

-- Договоры: колонки, которые читает миграция, плюс служебные (display_id, статус).
CREATE TABLE public.contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_number varchar(100),
  contract_date date,
  object_id uuid REFERENCES public.objects(id),
  counterparty_id uuid,
  status varchar(20) NOT NULL DEFAULT 'new_request',
  display_id bigint GENERATED ALWAYS AS IDENTITY,
  record_type text NOT NULL DEFAULT 'dp' CHECK (record_type IN ('dp', 'ds_vor', 'ds_extra')),
  parent_contract_id uuid,
  root_contract_id uuid,
  signal_link text,
  notes text,
  doc_check_request_id uuid,
  deleted_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now());
CREATE INDEX idx_contracts_parent_contract_id ON public.contracts (parent_contract_id);
CREATE INDEX idx_contracts_root_contract_id ON public.contracts (root_contract_id);
${policy('public.contracts')}
-- Как contracts_hierarchy_guard (prod-schema.sql, 20270122): корень цепочки.
CREATE FUNCTION public.signal_test_hierarchy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_row public.contracts%ROWTYPE;
BEGIN
  IF NEW.record_type = 'dp' THEN
    NEW.root_contract_id := NEW.id;
  ELSE
    SELECT * INTO parent_row FROM public.contracts WHERE id = NEW.parent_contract_id;
    NEW.root_contract_id := COALESCE(parent_row.root_contract_id, parent_row.id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_contracts_hierarchy_guard BEFORE INSERT OR UPDATE ON public.contracts FOR EACH ROW EXECUTE FUNCTION public.signal_test_hierarchy();

CREATE TABLE public.contract_counterparties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
  counterparty_id uuid NOT NULL REFERENCES public.counterparties(id),
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  UNIQUE (contract_id, counterparty_id));
${policy('public.contract_counterparties')}
CREATE TABLE public.contract_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
  event_type text NOT NULL, field_name text, old_value jsonb, new_value jsonb, description text,
  changed_at timestamptz NOT NULL DEFAULT now(), changed_by_role text, changed_by_name text, changed_by uuid);
${policy('public.contract_audit_log')}

-- Настоящие тексты: права раздела и охват, ключи номера, журнал базы и штамп автора.
${fnText(['supabase', 'migrations', '20261010_r2ab_employee_only.sql'], 'public.is_admin')}
${fnText(['supabase', 'migrations', '20261010_r2ab_employee_only.sql'], 'public.osp_can')}
${fnText(['migration', 'yandex', '20270120_object_scope_files.sql'], 'public.osp_object_scope')}
${fnText(['migration', 'yandex', '20270120_object_scope_files.sql'], 'public.osp_contract_in_scope')}
${fnText(['migration', 'yandex', '20270110_contract_number_scheme.sql'], 'public.contract_code_norm')}
${fnText(['migration', 'yandex', '20270110_contract_number_scheme.sql'], 'public.contract_code_key')}
${fnText(['migration', 'yandex', '20270110_contract_number_scheme.sql'], 'public.contract_number_key')}
${fnText(['migration', 'schema', 'prod-schema.sql'], 'public.psdc_actor')}
${auditTrailText()}
${fnText(['migration', 'yandex', '20270121_audit_trail.sql'], 'public.audit_log_stamp')}
CREATE TRIGGER audit_log_stamp BEFORE INSERT ON public.contract_audit_log FOR EACH ROW EXECUTE FUNCTION public.audit_log_stamp();
CREATE TRIGGER osp_data_audit AFTER INSERT OR UPDATE OR DELETE ON public.contracts FOR EACH ROW EXECUTE FUNCTION osp_private.data_audit_row();
`
}

// Идентификаторы-синтетика: <префикс из 8 hex>-0000-4000-8000-<номер, 12 hex>.
export function uuid(prefix, n) {
  const p = (typeof prefix === 'number' ? prefix : [...String(prefix)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)).toString(16).padStart(8, '0').slice(-8)
  return `${p}-0000-4000-8000-${Number(n).toString(16).padStart(12, '0')}`
}

function errorOf(fn) {
  try { fn() } catch (e) {
    const m = String(e.message).match(/ERROR:\s+(?:([0-9A-Z]{5}):\s+)?(.*)/)
    return { code: m?.[1] || null, message: m ? m[2].trim() : String(e.message), raw: String(e.message) }
  }
  return null
}

const lit = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`)
const arr = (a, type) => `array[${(a || []).map(lit).join(',')}]::${type}[]`

// Сидеры синтетики. sql(text) — выполнение служебной операцией (первая строка вывода — значение RETURNING), nextId(kind) — новый uuid.
// Годятся и для заготовки хелпера, и для слепка схемы прода (tests/db/signal-migration.test.mjs): колонки — общие для обеих.
export function createSeeders({ sql, nextId }) {
  let counter = 0
  // ── Сидеры синтетики ────────────────────────────────────────────────────────────────────────────
  const seed = {
    object({ id = nextId('obj'), name = `Тест: объект ${id}`, code = null } = {}) {
      sql(`INSERT INTO public.objects (id, name, address, contract_code) VALUES (${lit(id)}, ${lit(name)}, 'Тест: адрес', ${lit(code)})`)
      return id
    },
    counterparty({ id = nextId('cp'), name = `ООО Тест ${++counter}`, inn = null } = {}) {
      sql(`INSERT INTO public.counterparties (id, name, inn) VALUES (${lit(id)}, ${lit(name)}, ${lit(inn)})`)
      return id
    },
    // Роль с правами раздела «contracts»: 'view' | 'edit' | null (нет строки прав). object_scoped — «по объектам».
    role(key, { contracts = null, objectScoped = false } = {}) {
      sql(`INSERT INTO public.roles (key, label, object_scoped) VALUES (${lit(key)}, ${lit(`Тест: ${key}`)}, ${objectScoped})
        ON CONFLICT (key) DO UPDATE SET object_scoped = EXCLUDED.object_scoped;
        DELETE FROM public.role_permissions WHERE role = ${lit(key)} AND section = 'contracts';
        ${contracts ? `INSERT INTO public.role_permissions (role, section, can_view, can_edit) VALUES (${lit(key)}, 'contracts', true, ${contracts === 'edit'});` : ''}`)
      return key
    },
    // Сотрудник: роль, одобрен, охват объектов (пусто — все), право «contracts», подрядчик — counterparty.
    user({ id = nextId('usr'), role = `sig_${++counter}`, contracts = 'view', approved = true, blocked = false, objectIds = [], objectScoped = false,
      counterparty = null, fullName = `Тестов Т. ${++counter}`, email = `user${++counter}@example.invalid` } = {}) {
      seed.role(role, { contracts, objectScoped })
      sql(`INSERT INTO public.user_roles (user_id, role, is_approved, is_blocked, full_name, email, counterparty_id, object_ids)
        VALUES (${lit(id)}, ${lit(role)}, ${approved && !blocked}, ${blocked}, ${lit(fullName)}, ${lit(email)}, ${lit(counterparty)}, ${arr(objectIds, 'uuid')})`)
      return id
    },
    admin({ id = nextId('adm'), fullName = 'Админов А. А.' } = {}) {
      sql(`INSERT INTO public.roles (key, label) VALUES ('admin', 'Администратор') ON CONFLICT (key) DO NOTHING`)
      sql(`INSERT INTO public.user_roles (user_id, role, is_approved, full_name, email)
        VALUES (${lit(id)}, 'admin', true, ${lit(fullName)}, ${lit(`admin${++counter}@example.invalid`)})`)
      return id
    },
    // Подрядчик: роль contractor, организация, право «contracts» выдано — osp_can всё равно откажет.
    contractor({ id = nextId('con'), objectIds = [] } = {}) {
      const cp = seed.counterparty()
      return seed.user({ id, role: 'contractor', contracts: 'edit', counterparty: cp, objectIds })
    },
    // Договор или ДС. counterparties — id контрагентов (первый — основной contracts.counterparty_id).
    contract({ id = nextId('ctr'), number = null, objectId = null, counterparties = [], recordType = 'dp', parent = null, signalLink = null,
      date = null, deleted = false, status = 'in_work' } = {}) {
      sql(`INSERT INTO public.contracts (id, contract_number, contract_date, object_id, counterparty_id, status, record_type, parent_contract_id, signal_link, deleted_at)
        VALUES (${lit(id)}, ${lit(number)}, ${lit(date)}, ${lit(objectId)}, ${lit(counterparties[0] ?? null)}, ${lit(status)}, ${lit(recordType)}, ${lit(parent)},
                ${lit(signalLink)}, ${deleted ? 'now()' : 'null'})`)
      for (const [i, cp] of counterparties.entries()) {
        sql(`INSERT INTO public.contract_counterparties (contract_id, counterparty_id, sort_order) VALUES (${lit(id)}, ${lit(cp)}, ${i})`)
      }
      return id
    },
    // Корень SIGNAL с объектами; ready/enabled — как задано (по умолчанию включён и готов).
    source({ projectId = nextId('prj'), folderId = nextId('fld'), name = 'Тест: проект', rootPath = 'Тест: проект / Корень', objectIds = [], enabled = true, ready = true, createdBy = null } = {}) {
      const id = Number(sql(`INSERT INTO osp_private.signal_sources (project_id, folder_id, project_name, root_path, enabled, ready, created_by)
        VALUES (${lit(projectId)}, ${lit(folderId)}, ${lit(name)}, ${lit(rootPath)}, ${enabled}, ${ready}, ${lit(createdBy)}) RETURNING id`).split('\n')[0])
      for (const o of objectIds) {
        sql(`INSERT INTO osp_private.signal_bindings (source_id, node_id, object_id) VALUES (${id}, null, ${lit(o)})`)
      }
      return { id, projectId, folderId, objectIds }
    },
    // Привязка поддерева (напрямую, мимо функции) — для подготовки сцен.
    bind(sourceId, nodeId, objectId) {
      sql(`INSERT INTO osp_private.signal_bindings (source_id, node_id, object_id) VALUES (${sourceId}, ${lit(nodeId)}, ${lit(objectId)})`)
    },
    // Опубликованный снимок: дерево {name, children?, items?, numberKeys?, nameNorm?, features?, id?} → строки signal_nodes
    // и поколение в signal_meta (напрямую). Корень получает node_id = folder_id корня. Объект узла считает signal_recompute_objects.
    // → {rootId, ids: {'Корень / Корпус 1': uuid, …}, nodes: [{id, name, path, kind, parentId}], generation}
    snapshot(sourceId, tree, { generation = 1, modifiedAt = '2026-11-20T10:00:00Z', recompute = true } = {}) {
      const src = sql(`SELECT project_id || ' ' || folder_id FROM osp_private.signal_sources WHERE id = ${sourceId}`).split(' ')
      const [projectId, folderId] = src
      const out = { rootId: folderId, ids: {}, nodes: [], generation }
      const rows = []
      const walk = (node, parent, pathNames, pathIds, isRoot) => {
        const id = node.id || (isRoot ? folderId : nextId('nod'))
        const names = [...pathNames, node.name]
        const nodePath = names.join(' / ')
        const kind = node.kind || 'folder'
        rows.push({ id, parent: parent ? parent.id : null, kind, name: node.name, path: nodePath, pathIds, depth: pathIds.length, node })
        out.ids[nodePath] = id
        out.nodes.push({ id, name: node.name, path: nodePath, kind, parentId: parent ? parent.id : null })
        for (const ch of node.children || []) walk(ch, { id }, names, [...pathIds, id], false)
        for (const it of node.items || []) walk({ ...it, kind: 'item' }, { id }, names, [...pathIds, id], false)
      }
      walk(tree, null, [], [], true)
      for (const r of rows) {
        const n = r.node
        sql(`INSERT INTO osp_private.signal_nodes (node_id, project_id, source_id, kind, parent_id, name, path, path_ids, depth, modified_at, item_type, version_number,
            deleted, number_keys, name_norm, features, first_gen, seen_gen, absent_nights)
          VALUES (${lit(r.id)}, ${lit(projectId)}, ${sourceId}, ${lit(r.kind)}, ${lit(r.parent)}, ${lit(r.name)}, ${lit(r.path)}, ${arr(r.pathIds, 'uuid')}, ${r.depth},
            ${lit(n.modifiedAt || modifiedAt)}, ${lit(r.kind === 'item' ? n.itemType || 'File' : null)}, ${r.kind === 'item' ? (n.version ?? 1) : 'null'},
            ${n.deleted ? 'true' : 'false'}, ${arr(n.numberKeys, 'text')}, ${lit(n.nameNorm ?? r.name.toLowerCase())}, ${lit(JSON.stringify(n.features || {}))}::jsonb,
            ${generation}, ${n.seenGen ?? generation}, ${n.absentNights ?? 0})`)
      }
      sql(`UPDATE osp_private.signal_meta SET generation = ${generation}, published_at = now() WHERE id = 1`)
      if (recompute) sql(`SELECT osp_private.signal_recompute_objects(${sourceId})`)
      return out
    },
    // Строки staging из дерева (как их шлёт обход): те же поля, что у signal_stage_put. ids — прежние id по путям (узел «возвращается»);
    // корень — node_id = folder_id корня. Узел дерева: {name, kind?, children?, items?, numberKeys?, nameNorm?, itemsListed?:false —
    // элементы папки не перечислялись (режим known), problem?:'forbidden'|'not_found'|'invalid'|'unstable' — элементы прочитать не удалось}.
    stageRows(sourceId, tree, { ids = {}, modifiedAt = '2026-11-20T10:00:00Z' } = {}) {
      const [projectId, folderId] = sql(`SELECT project_id || ' ' || folder_id FROM osp_private.signal_sources WHERE id = ${sourceId}`).split('\n')[0].split(' ')
      const out = { rows: [], ids: {}, rootId: folderId }
      const walk = (node, parentId, pathNames, pathIds, isRoot) => {
        const names = [...pathNames, node.name]
        const nodePath = names.join(' / ')
        const id = node.id || ids[nodePath] || (isRoot ? folderId : nextId('nod'))
        const kind = node.kind || 'folder'
        out.ids[nodePath] = id
        out.rows.push({ nodeId: id, projectId, sourceId, kind, parentId, name: node.name, path: nodePath, pathIds, depth: pathIds.length,
          modifiedAt, itemType: kind === 'item' ? node.itemType || 'File' : undefined, versionNumber: kind === 'item' ? node.version ?? 1 : undefined,
          deleted: !!node.deleted, numberKeys: node.numberKeys || [], nameNorm: node.nameNorm ?? node.name.toLowerCase(), features: node.features || {},
          itemsListed: kind === 'folder' ? node.itemsListed !== false && !node.problem : false, problem: node.problem || undefined })
        for (const ch of node.children || []) walk(ch, id, names, [...pathIds, id], false)
        for (const it of node.items || []) walk({ ...it, kind: 'item' }, id, names, [...pathIds, id], false)
      }
      walk(tree, null, [], [], true)
      return out
    },
    // Целый прогон одной командой: begin → stage_put порциями → finish (или остановиться перед finish: finish:false).
    // roots — [{src, tree, ids?}]; → {run:{runId, ownerToken}|null, result, ids:{<sourceId>:{путь:id}}}.
    sync({ kind = 'manual', mode = 'full', initiator = 'cli', roots = [], stats = undefined, force = false, finish = true } = {}) {
      const json = (text) => JSON.parse(sql(text).split('\n')[0])
      const run = json(`SELECT osp_private.signal_sync_begin(${lit(kind)}, ${lit(mode)}, ${lit(initiator)}, null)`)
      const ids = {}
      for (const r of roots) {
        const staged = seed.stageRows(r.src.id ?? r.src, r.tree, { ids: r.ids })
        ids[r.src.id ?? r.src] = staged.ids
        for (let i = 0; i < staged.rows.length; i += 500) {
          sql(`SELECT osp_private.signal_stage_put(${run.runId}, ${lit(run.ownerToken)}, ${lit(JSON.stringify(staged.rows.slice(i, i + 500)))}::jsonb)`)
        }
      }
      if (!finish) return { run, result: null, ids }
      const st = stats ?? { roots: roots.map((r) => ({ id: r.src.id ?? r.src, status: 'ok' })) }
      const result = json(`SELECT osp_private.signal_sync_finish(${run.runId}, ${lit(run.ownerToken)}, ${lit(JSON.stringify(st))}::jsonb, ${force})`)
      return { run, result, ids }
    },
    // Очередь: договорам — новая ревизия (как триггер), для сцен «в очереди».
    enqueue(contractId) {
      sql(`INSERT INTO osp_private.signal_queue (contract_id, dirty_revision) VALUES (${lit(contractId)}, nextval('osp_private.signal_revision_seq'))
        ON CONFLICT (contract_id) DO UPDATE SET dirty_revision = EXCLUDED.dirty_revision`)
    },
  }
  return seed
}

export async function startSignalDb({ migrate = true } = {}) {
  if (signalDbSkip) throw new Error(`signal-db: ${signalDbSkip}`)
  const pgdb = new TestDatabase()
  pgdb.start()
  let counter = 0x1000
  const dbs = []
  const clients = []
  const nextId = (kind) => uuid(kind, ++counter)

  pgdb.exec(`CREATE ROLE ${OWNER} LOGIN;
    GRANT CREATE, CONNECT ON DATABASE psdc_test TO ${OWNER};
    GRANT CREATE ON SCHEMA public TO ${OWNER};`)
  pgdb.exec(`SET ROLE ${OWNER};\n${prelude()}`)

  const wrap = (text) => `${String(text).trim().replace(/;?\s*$/, ';')}`
  const lastLines = (out) => String(out).trim()

  const api = {
    pgdb,
    port: pgdb.port,
    url: `postgres://${OWNER}@127.0.0.1:${pgdb.port}/psdc_test`,

    // Служебная операция (отметка osp:internal): правила по строкам пропускают, auth.uid() пуст.
    sql(text) {
      return lastLines(pgdb.exec(`\\set VERBOSITY verbose\nSET ROLE ${OWNER};\nSET application_name = 'osp:internal';\n${wrap(text)}`))
    },
    // От имени вошедшего, как db.write(who): отметка 'osp-api' и request.jwt.claims; одна транзакция.
    as(uid, text, { readOnly = false, role = 'authenticated' } = {}) {
      const claims = JSON.stringify({ sub: uid, role, email: '' })
      return lastLines(pgdb.exec(`\\set VERBOSITY verbose
SET ROLE ${OWNER};
BEGIN${readOnly ? ' READ ONLY' : ''};
SET LOCAL application_name = 'osp-api';
SET LOCAL "request.jwt.claims" = '${claims}';
${wrap(text)}
COMMIT;`))
    },
    asJson(uid, text, opts) { return JSON.parse(api.as(uid, text, opts).split('\n').filter(Boolean).at(-1)) },
    sqlJson(text) { return JSON.parse(api.sql(text).split('\n').filter(Boolean).at(-1)) },
    // Ошибка SQL как данные: {code:'SG409', message:'stale_state'}; без ошибки — null.
    asError(uid, text, opts) { return errorOf(() => api.as(uid, text, opts)) },
    sqlError(text) { return errorOf(() => api.sql(text)) },
    // Служебный вызов без вошедшего (db.write(null)): auth.uid() пуст.
    asService(text) { return api.sql(text) },

    // Настоящая обёртка osp-api: db.read(who, fn) / db.write(who, fn). who = {userId, email} | null.
    async serverDb(options = {}) {
      const { createDb } = await import(path.join(SERVER, 'src', 'lib', 'db.js'))
      const sdb = createDb({ url: api.url, max: 3, lockTimeoutMs: 2000, ...options })
      dbs.push(sdb)
      return sdb
    },
    // Отдельный сеанс pg.Client под владельцем — для проверок блокировок (LOCK, FOR UPDATE) в другой сессии.
    async connect() {
      const require = createRequire(path.join(SERVER, 'package.json'))
      const { Client } = require('pg')
      const client = new Client({ host: '127.0.0.1', port: pgdb.port, user: OWNER, database: 'psdc_test' })
      await client.connect()
      clients.push(client)
      return client
    },

    applyMigration() {
      return pgdb.exec(`SET ROLE ${OWNER};\nBEGIN;\nSET LOCAL lock_timeout = '10s';\nSET LOCAL application_name = 'osp:internal';\n${fs.readFileSync(MIGRATION, 'utf8')}\nCOMMIT;`)
    },
    applyFile(file) {
      return pgdb.exec(`SET ROLE ${OWNER};\nBEGIN;\nSET LOCAL application_name = 'osp:internal';\n${fs.readFileSync(file, 'utf8')}\nCOMMIT;`)
    },

    async stop() {
      for (const c of clients) { try { await c.end() } catch { /* закрыт */ } }
      for (const d of dbs) { try { await d.close() } catch { /* закрыт */ } }
      pgdb.stop()
    },
    uuid,
    id: nextId,
  }

  api.seed = createSeeders({ sql: api.sql, nextId })

  if (migrate) api.applyMigration()
  return api
}
