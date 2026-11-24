-- Сверка договоров ОСП с папками SIGNAL (только база Яндекса, «только Яндекс» — в supabase/migrations ничего нет).
-- Спецификация интеграции OSP ↔ SIGNAL (MVP), раздел 1: миграция.
--
--  • 1. Десять таблиц закрытой схемы osp_private: signal_meta, signal_sources (корни), signal_bindings (объекты корня и
--    поддеревьев), signal_nodes (опубликованный снимок папок и файлов), signal_stage_nodes (порции текущего прогона),
--    signal_runs (журнал прогонов), signal_contracts (состояние сверки договора), signal_candidates (предложенные и
--    отклонённые папки), signal_aliases (синонимы объектов), signal_queue (очередь пересчёта; ревизии — signal_revision_seq).
--    У каждой таблицы правила по строкам включены и действуют на владельца, единственная политика — osp_internal (пропуск
--    служебных функций). В шлюз ничего не публикуется (строк osp:allow нет): пользователь и служба работают ТОЛЬКО функциями.
--  • 2. Триггеры очереди на contracts / contract_counterparties / objects. Они никогда не отказывают: lock_timeout 250 мс,
--    любая ошибка (нет таблицы, очередь заблокирована, нет последовательности) — предупреждение signal_enqueue_skipped, а
--    правка договора проходит. Не читают настройки интеграции и не обращаются к SIGNAL. Очередь пустая или удалена — норма.
--  • 3. Журнал базы (osp_private.data_audit_log) подключён к signal_sources, signal_bindings, signal_aliases. Образец
--    data_audit_row у них не подходит: id этих таблиц — bigint, а row_id журнала — uuid; поэтому свой триггер
--    signal_audit_row (те же правила записи) кладёт в row_id число-id как uuid '00000000-0000-0000-0000-<12 знаков hex>'.
--    Узлы, staging, очередь, состояния и кандидаты не аудируются (происхождение — прогон и поколение снимка).
--  • 4. Функции signal_* — все SECURITY DEFINER с пропуском. Служебные (прогон, публикация, очередь, сопоставление) первой
--    строкой отказывают при непустом auth.uid() (SG403): их зовёт только osp-api служебной операцией. Пользовательские сами
--    проверяют вошедшего, право раздела «contracts» (osp_can), охват по объектам (osp_contract_in_scope / osp_object_scope),
--    видимость узла (корень включён и готов, object_id узла назначен и равен объекту договора). Подрядчик — отказ.
--    Ошибки: RAISE EXCEPTION USING ERRCODE = 'SG4xx', MESSAGE = '<машинный код>' (без имён и путей).
--  • 5. Действия окна сверки (подтвердить / отклонить / снять) — одной транзакцией со ссылкой, состоянием, кандидатами,
--    синонимом и событием contract_audit_log. Порядок блокировок: contracts → signal_contracts → signal_candidates →
--    signal_queue; публикация: signal_meta → signal_nodes → signal_queue.
-- Нужны 20270110 (ключи номера, objects.contract_code), 20270120 (охват по объектам), 20270121 (журнал базы); закрыть вход
-- на «Заключение ДП» (20270225) не требуется — оно просто срабатывает вместе с триггерами очереди.
-- Повтор безопасен. Проверка — 20270228_signal_integration.check.sql, для прода — migration/backup/checks/20270228.sql;
-- откат — migration/rollback/20270228_signal_integration_rollback.sql (удаляет настройки корней и решения людей).

DO $dep$
BEGIN
  IF to_regprocedure('public.osp_can(text, text)') IS NULL OR to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'Нет права раздела на сервере (osp_can, is_admin): нужна база с 20261010_r2ab_employee_only';
  END IF;
  IF to_regprocedure('public.osp_object_scope()') IS NULL OR to_regprocedure('public.osp_contract_in_scope(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Нет охвата по объектам: сначала 20270120_object_scope_files';
  END IF;
  IF to_regprocedure('osp_private.data_audit_write(text, uuid, text, uuid, text, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Нет журнала базы: сначала 20270121_audit_trail';
  END IF;
  IF to_regprocedure('public.contract_number_key(text)') IS NULL OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'objects' AND column_name = 'contract_code') THEN
    RAISE EXCEPTION 'Нет ключей номера договора: сначала 20270110_contract_number_scheme';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contracts'
        AND column_name IN ('contract_number', 'contract_date', 'object_id', 'counterparty_id', 'record_type', 'parent_contract_id',
                            'root_contract_id', 'signal_link', 'deleted_at')) <> 9 THEN
    RAISE EXCEPTION 'В contracts нет нужных колонок (signal_link, root_contract_id, …)';
  END IF;
  IF to_regclass('public.contract_audit_log') IS NULL OR to_regclass('public.contract_counterparties') IS NULL
     OR to_regclass('public.counterparties') IS NULL OR to_regclass('public.user_roles') IS NULL THEN
    RAISE EXCEPTION 'Нет таблиц договоров, сторон, истории или ролей';
  END IF;
END
$dep$;

-- ── 1. Таблицы ───────────────────────────────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS osp_private.signal_revision_seq;

-- Одна строка: поколение опубликованного снимка (растёт при каждой публикации) и версия схемы (server/osp-api сверяет её = 1).
CREATE TABLE IF NOT EXISTS osp_private.signal_meta (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  generation bigint NOT NULL DEFAULT 0,
  published_at timestamptz,
  published_run_id bigint,
  schema_version int NOT NULL DEFAULT 1
);
INSERT INTO osp_private.signal_meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Корни обхода: папка проекта SIGNAL, назначенная одному или нескольким объектам. enabled — включён админом; ready —
-- после первой успешной публикации (выключение сбрасывает).
CREATE TABLE IF NOT EXISTS osp_private.signal_sources (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL,
  folder_id uuid NOT NULL,
  project_name text CHECK (char_length(project_name) <= 500),
  root_path text CHECK (char_length(root_path) <= 2000),
  enabled boolean NOT NULL DEFAULT true,
  ready boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_run_id bigint,
  last_ok_at timestamptz,
  last_full_ok_at timestamptz,
  last_night_ok_at timestamptz,
  last_error text CHECK (last_error ~ '^[a-z_]{1,40}$'),
  folders_count int,
  items_count int,
  UNIQUE (project_id, folder_id)
);

-- Журнал прогонов обхода. Один идущий прогон (частичный уникальный индекс, как у Larix); owner_token — «кто владеет».
CREATE TABLE IF NOT EXISTS osp_private.signal_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('day', 'night', 'manual')),
  mode text NOT NULL CHECK (mode IN ('full', 'known')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'held', 'failed', 'cancelled')),
  reason text CHECK (reason ~ '^[a-z_]{1,40}$'),
  initiator text NOT NULL CHECK (initiator IN ('schedule', 'cli', 'admin')),
  started_by uuid,
  owner_token uuid NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  slot timestamptz,
  generation bigint,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(stats) = 'object'),
  accepted_by text CHECK (char_length(accepted_by) <= 200),
  accept_reason text CHECK (char_length(accept_reason) <= 500),
  CHECK (kind = 'day' OR mode = 'full')
);
CREATE UNIQUE INDEX IF NOT EXISTS signal_runs_one_running ON osp_private.signal_runs ((true)) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS signal_runs_slot_idx ON osp_private.signal_runs (slot);
CREATE INDEX IF NOT EXISTS signal_runs_started_idx ON osp_private.signal_runs (started_at DESC);

-- node_id IS NULL — объекты корня (множество R); иначе — объект поддерева узла (должен входить в R).
CREATE TABLE IF NOT EXISTS osp_private.signal_bindings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id bigint NOT NULL REFERENCES osp_private.signal_sources (id) ON DELETE CASCADE,
  node_id uuid,
  object_id uuid NOT NULL REFERENCES public.objects (id) ON DELETE CASCADE,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT signal_bindings_uniq UNIQUE NULLS NOT DISTINCT (source_id, node_id, object_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS signal_bindings_subtree_uniq ON osp_private.signal_bindings (source_id, node_id) WHERE node_id IS NOT NULL;

-- Опубликованный снимок. object_id — вычисленная граница (Ф1), её ведёт только signal_recompute_objects.
-- seen_gen — поколение, в котором узел видели в последний раз; absent_nights — ночных полных обходов подряд без узла.
CREATE TABLE IF NOT EXISTS osp_private.signal_nodes (
  node_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  source_id bigint NOT NULL REFERENCES osp_private.signal_sources (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('folder', 'item')),
  parent_id uuid,
  name text NOT NULL CHECK (char_length(name) <= 1000),
  path text NOT NULL CHECK (char_length(path) <= 8000),
  path_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(path_ids) <= 40),
  depth int NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 40),
  object_id uuid,
  modified_at timestamptz,
  item_type text CHECK (char_length(item_type) <= 100),
  version_number int,
  deleted boolean NOT NULL DEFAULT false,
  number_keys text[] NOT NULL DEFAULT '{}' CHECK (cardinality(number_keys) <= 64),
  name_norm text NOT NULL DEFAULT '' CHECK (char_length(name_norm) <= 1000),
  features jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(features) = 'object'),
  first_gen bigint NOT NULL,
  seen_gen bigint NOT NULL,
  absent_nights int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS signal_nodes_number_keys_idx ON osp_private.signal_nodes USING gin (number_keys) WHERE kind = 'folder';
CREATE INDEX IF NOT EXISTS signal_nodes_path_ids_idx ON osp_private.signal_nodes USING gin (path_ids);
CREATE INDEX IF NOT EXISTS signal_nodes_object_kind_idx ON osp_private.signal_nodes (object_id, kind);
CREATE INDEX IF NOT EXISTS signal_nodes_parent_idx ON osp_private.signal_nodes (parent_id, name, node_id);
CREATE INDEX IF NOT EXISTS signal_nodes_source_idx ON osp_private.signal_nodes (source_id);

-- Порции текущего прогона; после публикации (или сбоя) удаляются. items_listed — у папки перечислены её элементы.
CREATE TABLE IF NOT EXISTS osp_private.signal_stage_nodes (
  run_id bigint NOT NULL REFERENCES osp_private.signal_runs (id) ON DELETE CASCADE,
  node_id uuid NOT NULL,
  project_id uuid NOT NULL,
  source_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('folder', 'item')),
  parent_id uuid,
  name text NOT NULL CHECK (char_length(name) <= 1000),
  path text NOT NULL CHECK (char_length(path) <= 8000),
  path_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(path_ids) <= 40),
  depth int NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 40),
  modified_at timestamptz,
  item_type text CHECK (char_length(item_type) <= 100),
  version_number int,
  deleted boolean NOT NULL DEFAULT false,
  number_keys text[] NOT NULL DEFAULT '{}' CHECK (cardinality(number_keys) <= 64),
  name_norm text NOT NULL DEFAULT '' CHECK (char_length(name_norm) <= 1000),
  features jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(features) = 'object'),
  items_listed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (run_id, node_id)
);

-- Состояние сверки договора (state:reason из раздела 3). state_version растёт при смене state/reason/узла/набора кандидатов:
-- на нём держится CAS окна сверки. processed_revision — до какой ревизии очереди состояние актуально.
CREATE TABLE IF NOT EXISTS osp_private.signal_contracts (
  contract_id uuid PRIMARY KEY REFERENCES public.contracts (id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('none', 'suggested', 'verified', 'unverified', 'attention', 'missing', 'conflict')),
  reason text CHECK (reason ~ '^[a-z_]{1,40}$'),
  node_id uuid,
  state_version bigint NOT NULL DEFAULT 0,
  processed_revision bigint NOT NULL DEFAULT 0,
  checked_gen bigint,
  fingerprint text CHECK (char_length(fingerprint) <= 200),
  confirmed_by uuid,
  confirmed_at timestamptz,
  last_action_key text CHECK (char_length(last_action_key) <= 100),
  last_action_user uuid,
  last_action_result jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signal_contracts_node_idx ON osp_private.signal_contracts (node_id) WHERE node_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS osp_private.signal_candidates (
  contract_id uuid NOT NULL REFERENCES public.contracts (id) ON DELETE CASCADE,
  node_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'rejected', 'unlinked')),
  score int NOT NULL DEFAULT 0,
  reasons text[] NOT NULL DEFAULT '{}',
  flags text[] NOT NULL DEFAULT '{}',
  ctx_key text CHECK (char_length(ctx_key) <= 200),
  decided_by uuid,
  decided_at timestamptz,
  note text CHECK (char_length(note) <= 300),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, node_id)
);
CREATE INDEX IF NOT EXISTS signal_candidates_status_idx ON osp_private.signal_candidates (contract_id, status);
CREATE INDEX IF NOT EXISTS signal_candidates_node_idx ON osp_private.signal_candidates (node_id);

CREATE TABLE IF NOT EXISTS osp_private.signal_aliases (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  object_id uuid NOT NULL REFERENCES public.objects (id) ON DELETE CASCADE,
  alias_text text NOT NULL CHECK (char_length(alias_text) BETWEEN 1 AND 120),
  alias_key text NOT NULL CHECK (char_length(alias_key) BETWEEN 1 AND 200),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (alias_key)
);
CREATE INDEX IF NOT EXISTS signal_aliases_object_idx ON osp_private.signal_aliases (object_id);

-- Очередь пересчёта: строка есть, пока у договора есть непросчитанная ревизия. lease_* — «захвачено, не трогать до …».
-- recheck_only — ревизию поставила плановая пересверка (публикация снимка, синонимы, привязки), реквизиты договора не менялись:
-- значки и окно сверки показывают прежнее состояние без «ожидает». Триггеры правки договора ставят false (настоящее «ожидает»);
-- плановая постановка при конфликте значение не меняет — ожидающая правка реквизитов не прячется.
CREATE TABLE IF NOT EXISTS osp_private.signal_queue (
  contract_id uuid PRIMARY KEY REFERENCES public.contracts (id) ON DELETE CASCADE,
  dirty_revision bigint NOT NULL,
  dirty_since timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  next_at timestamptz,
  recheck_only boolean NOT NULL DEFAULT false
);
-- База, где первая редакция уже применена: колонка добавляется повтором миграции.
ALTER TABLE osp_private.signal_queue ADD COLUMN IF NOT EXISTS recheck_only boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS signal_queue_due_idx ON osp_private.signal_queue (next_at, dirty_since);

COMMENT ON TABLE osp_private.signal_nodes IS 'Опубликованный снимок папок и файлов SIGNAL (только метаданные); ведёт публикация signal_sync_finish';
COMMENT ON TABLE osp_private.signal_queue IS 'Очередь пересчёта сверки договоров; триггеры на contracts/contract_counterparties/objects никогда не отказывают';
COMMENT ON TABLE osp_private.signal_contracts IS 'Состояние сверки договора с папкой SIGNAL; ссылку contracts.signal_link меняют только подтверждение/замена/снятие человеком';

-- Правила по строкам: у каждой таблицы — только пропуск служебных функций. Пользователи и шлюз к таблицам не ходят.
DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['signal_meta', 'signal_sources', 'signal_bindings', 'signal_nodes', 'signal_stage_nodes', 'signal_runs',
                           'signal_contracts', 'signal_candidates', 'signal_aliases', 'signal_queue'] LOOP
    EXECUTE format('ALTER TABLE osp_private.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE osp_private.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS osp_internal ON osp_private.%I', t);
    EXECUTE format('CREATE POLICY osp_internal ON osp_private.%I FOR ALL TO PUBLIC
      USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()))', t);
  END LOOP;
END
$rls$;

-- ── 2. Журнал базы ───────────────────────────────────────────────────────────────────────────────────
-- Как osp_private.data_audit_row (20270121), но id таблиц — bigint: row_id журнала — uuid, прямое присваивание не проходит.
CREATE OR REPLACE FUNCTION osp_private.signal_audit_row() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_changes jsonb;
  v_id bigint;
  -- Служебные колонки: updated_at / row_version — как у образца; отметки обходов корня меняются при каждой публикации и в журнал не идут.
  v_skip text[] := ARRAY['updated_at', 'row_version', 'last_run_id', 'last_ok_at', 'last_full_ok_at', 'last_night_ok_at', 'last_error',
                         'folders_count', 'items_count'];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT jsonb_object_agg(n.key, jsonb_build_array(o.value, n.value)) INTO v_changes
      FROM jsonb_each(to_jsonb(NEW)) n
      JOIN jsonb_each(to_jsonb(OLD)) o ON o.key = n.key
     WHERE n.value IS DISTINCT FROM o.value AND NOT (n.key = ANY (v_skip));
    IF v_changes IS NULL THEN RETURN NULL; END IF;
    v_id := NEW.id;
  ELSIF TG_OP = 'INSERT' THEN
    v_changes := to_jsonb(NEW);
    v_id := NEW.id;
  ELSE
    v_changes := to_jsonb(OLD);
    v_id := OLD.id;
  END IF;
  PERFORM osp_private.data_audit_write(TG_TABLE_NAME, lpad(to_hex(v_id), 32, '0')::uuid, TG_OP, auth.uid(),
                                       current_setting('application_name', true), v_changes);
  RETURN NULL;
END
$$;

DO $audit$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['signal_sources', 'signal_bindings', 'signal_aliases'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS osp_data_audit ON osp_private.%I', t);
    EXECUTE format('CREATE TRIGGER osp_data_audit AFTER INSERT OR UPDATE OR DELETE ON osp_private.%I
      FOR EACH ROW EXECUTE FUNCTION osp_private.signal_audit_row()', t);
  END LOOP;
END
$audit$;

-- ── 3. Внутренние помощники ──────────────────────────────────────────────────────────────────────────
-- Вошедший и его право. p_kind: view (просмотр или правка раздела «Договоры»), edit, admin. Подрядчик, неодобренный и
-- заблокированный osp_can не проходят. Без вошедшего (служебная операция) — отказ.
CREATE OR REPLACE FUNCTION osp_private.signal_require(p_kind text) RETURNS uuid
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ok boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
  END IF;
  v_ok := CASE p_kind
    WHEN 'view' THEN public.osp_can('contracts', 'view') OR public.osp_can('contracts', 'edit')
    WHEN 'edit' THEN public.osp_can('contracts', 'edit')
    WHEN 'admin' THEN public.is_admin()
    ELSE false END;
  IF NOT coalesce(v_ok, false) THEN
    RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
  END IF;
  RETURN v_uid;
END
$$;

-- Договор есть, не удалён и в охвате вошедшего. Для охвата «все объекты» osp_contract_in_scope не проверяет существование.
CREATE OR REPLACE FUNCTION osp_private.signal_contract_ok(p_contract uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT p_contract IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.contracts c WHERE c.id = p_contract AND c.deleted_at IS NULL)
         AND public.osp_contract_in_scope(p_contract)
$$;

-- Узел виден по договору (инвариант 4): корень включён и готов, у узла назначен объект и он равен объекту договора.
-- p_observed — ещё и «виден в последнем обходе» (для подтверждения и поиска папок).
CREATE OR REPLACE FUNCTION osp_private.signal_node_visible(p_node uuid, p_contract uuid, p_observed boolean DEFAULT false) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM osp_private.signal_nodes n
    JOIN osp_private.signal_sources s ON s.id = n.source_id
    JOIN public.contracts c ON c.id = p_contract
    CROSS JOIN osp_private.signal_meta m
    WHERE n.node_id = p_node AND s.enabled AND s.ready AND n.object_id IS NOT NULL AND n.object_id = c.object_id
      AND (NOT p_observed OR n.seen_gen = m.generation))
$$;

-- Автор события «Истории»: ФИО (или почта) и роль вошедшего — как в 20270225.
CREATE OR REPLACE FUNCTION osp_private.signal_actor(OUT o_name text, OUT o_role text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT coalesce(nullif(btrim(ur.full_name), ''), nullif(btrim(ur.email), '')), ur.role
  FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1
$$;

CREATE OR REPLACE FUNCTION osp_private.signal_jsonb_texts(p_json jsonb) RETURNS text[]
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN jsonb_typeof(p_json) = 'array'
              THEN coalesce((SELECT array_agg(e.v ORDER BY e.o) FROM jsonb_array_elements_text(p_json) WITH ORDINALITY e(v, o)), '{}'::text[])
              ELSE '{}'::text[] END
$$;

CREATE OR REPLACE FUNCTION osp_private.signal_jsonb_uuids(p_json jsonb) RETURNS uuid[]
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN jsonb_typeof(p_json) = 'array'
              THEN coalesce((SELECT array_agg(e.v::uuid ORDER BY e.o) FROM jsonb_array_elements_text(p_json) WITH ORDINALITY e(v, o)), '{}'::uuid[])
              ELSE '{}'::uuid[] END
$$;

-- Экранирование для LIKE: % _ \ → \% \_ \\ .
CREATE OR REPLACE FUNCTION osp_private.signal_like_escape(p_text text) RETURNS text
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, pg_temp
AS $$ SELECT replace(replace(replace(p_text, '\', '\\'), '%', '\%'), '_', '\_') $$;

-- Узел для сопоставителя (раздел 5.2).
CREATE OR REPLACE FUNCTION osp_private.signal_node_json(p_node uuid) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT jsonb_build_object(
    'nodeId', n.node_id, 'projectId', n.project_id, 'sourceId', n.source_id, 'kind', n.kind, 'parentId', n.parent_id,
    'name', n.name, 'path', n.path, 'pathIds', to_jsonb(n.path_ids), 'depth', n.depth, 'objectId', n.object_id,
    'numberKeys', to_jsonb(n.number_keys), 'features', n.features, 'nameNorm', n.name_norm,
    'observed', n.seen_gen = m.generation, 'absentNights', n.absent_nights, 'deleted', n.deleted,
    'sourceEnabled', s.enabled, 'sourceReady', s.ready, 'itemType', n.item_type, 'versionNumber', n.version_number,
    'modifiedAt', n.modified_at)
  FROM osp_private.signal_nodes n
  JOIN osp_private.signal_sources s ON s.id = n.source_id
  CROSS JOIN osp_private.signal_meta m
  WHERE n.node_id = p_node
$$;

-- ── 4. Триггеры очереди (Ф4: никогда не отказывают) ─────────────────────────────────────────────────
-- Любая ошибка внутри — предупреждение, правка проходит. Очередь без строки — норма (следующая публикация поставит всех).
-- Вставка идёт через SELECT из contracts: договор, которого уже нет (каскадное удаление), в очередь не попадает.
CREATE OR REPLACE FUNCTION osp_private.signal_enqueue_trg() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
  SET lock_timeout = '250ms'
AS $$
DECLARE
  v_a uuid;
  v_b uuid;
BEGIN
  BEGIN
    IF TG_TABLE_NAME = 'contracts' THEN
      IF TG_OP = 'DELETE' THEN
        INSERT INTO osp_private.signal_queue AS q (contract_id, dirty_revision, dirty_since)
        SELECT c.id, nextval('osp_private.signal_revision_seq'), now()
        FROM public.contracts c
        WHERE c.id <> OLD.id AND (c.root_contract_id = OLD.id OR c.parent_contract_id = OLD.id)
        ORDER BY c.id
        ON CONFLICT (contract_id) DO UPDATE
          SET dirty_revision = EXCLUDED.dirty_revision, dirty_since = EXCLUDED.dirty_since, attempts = 0, next_at = NULL,
              recheck_only = false;
      ELSE
        INSERT INTO osp_private.signal_queue AS q (contract_id, dirty_revision, dirty_since)
        SELECT t.id, nextval('osp_private.signal_revision_seq'), now()
        FROM (SELECT c.id FROM public.contracts c
              WHERE c.id = NEW.id OR c.root_contract_id = NEW.id OR c.parent_contract_id = NEW.id) t
        ORDER BY t.id
        ON CONFLICT (contract_id) DO UPDATE
          SET dirty_revision = EXCLUDED.dirty_revision, dirty_since = EXCLUDED.dirty_since, attempts = 0, next_at = NULL,
              recheck_only = false;
      END IF;
    ELSIF TG_TABLE_NAME = 'contract_counterparties' THEN
      IF TG_OP = 'DELETE' THEN
        v_a := OLD.contract_id;
      ELSE
        v_a := NEW.contract_id;
      END IF;
      IF TG_OP = 'UPDATE' THEN
        v_b := OLD.contract_id;
      END IF;
      INSERT INTO osp_private.signal_queue AS q (contract_id, dirty_revision, dirty_since)
      SELECT c.id, nextval('osp_private.signal_revision_seq'), now()
      FROM public.contracts c
      WHERE c.id = v_a OR c.id = v_b
      ORDER BY c.id
      ON CONFLICT (contract_id) DO UPDATE
        SET dirty_revision = EXCLUDED.dirty_revision, dirty_since = EXCLUDED.dirty_since, attempts = 0, next_at = NULL,
            recheck_only = false;
    ELSIF TG_TABLE_NAME = 'objects' THEN
      INSERT INTO osp_private.signal_queue AS q (contract_id, dirty_revision, dirty_since)
      SELECT c.id, nextval('osp_private.signal_revision_seq'), now()
      FROM public.contracts c
      WHERE c.object_id = NEW.id
      ORDER BY c.id
      ON CONFLICT (contract_id) DO UPDATE
        SET dirty_revision = EXCLUDED.dirty_revision, dirty_since = EXCLUDED.dirty_since, attempts = 0, next_at = NULL,
            recheck_only = false;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signal_enqueue_skipped %', SQLSTATE;
  END;
  RETURN NULL;
END
$$;

-- UPDATE срабатывает только при фактическом изменении значимых колонок (UPDATE OF сам по себе реагирует на любое присваивание).
DROP TRIGGER IF EXISTS osp_signal_enqueue_ins ON public.contracts;
CREATE TRIGGER osp_signal_enqueue_ins AFTER INSERT ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION osp_private.signal_enqueue_trg();
DROP TRIGGER IF EXISTS osp_signal_enqueue_upd ON public.contracts;
CREATE TRIGGER osp_signal_enqueue_upd
  AFTER UPDATE OF contract_number, contract_date, object_id, counterparty_id, record_type, parent_contract_id, root_contract_id,
                  signal_link, deleted_at ON public.contracts
  FOR EACH ROW WHEN (OLD.contract_number IS DISTINCT FROM NEW.contract_number OR OLD.contract_date IS DISTINCT FROM NEW.contract_date
                     OR OLD.object_id IS DISTINCT FROM NEW.object_id OR OLD.counterparty_id IS DISTINCT FROM NEW.counterparty_id
                     OR OLD.record_type IS DISTINCT FROM NEW.record_type OR OLD.parent_contract_id IS DISTINCT FROM NEW.parent_contract_id
                     OR OLD.root_contract_id IS DISTINCT FROM NEW.root_contract_id OR OLD.signal_link IS DISTINCT FROM NEW.signal_link
                     OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION osp_private.signal_enqueue_trg();
DROP TRIGGER IF EXISTS osp_signal_enqueue_del ON public.contracts;
CREATE TRIGGER osp_signal_enqueue_del AFTER DELETE ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION osp_private.signal_enqueue_trg();

DROP TRIGGER IF EXISTS osp_signal_enqueue_ins ON public.contract_counterparties;
CREATE TRIGGER osp_signal_enqueue_ins AFTER INSERT ON public.contract_counterparties
  FOR EACH ROW EXECUTE FUNCTION osp_private.signal_enqueue_trg();
DROP TRIGGER IF EXISTS osp_signal_enqueue_upd ON public.contract_counterparties;
CREATE TRIGGER osp_signal_enqueue_upd AFTER UPDATE OF contract_id, counterparty_id ON public.contract_counterparties
  FOR EACH ROW WHEN (OLD.contract_id IS DISTINCT FROM NEW.contract_id OR OLD.counterparty_id IS DISTINCT FROM NEW.counterparty_id)
  EXECUTE FUNCTION osp_private.signal_enqueue_trg();
DROP TRIGGER IF EXISTS osp_signal_enqueue_del ON public.contract_counterparties;
CREATE TRIGGER osp_signal_enqueue_del AFTER DELETE ON public.contract_counterparties
  FOR EACH ROW EXECUTE FUNCTION osp_private.signal_enqueue_trg();

DROP TRIGGER IF EXISTS osp_signal_enqueue_upd ON public.objects;
CREATE TRIGGER osp_signal_enqueue_upd AFTER UPDATE OF name, contract_code ON public.objects
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.contract_code IS DISTINCT FROM NEW.contract_code)
  EXECUTE FUNCTION osp_private.signal_enqueue_trg();

-- ── 5. Служебные функции: прогон и публикация (зовёт osp-api без вошедшего) ──────────────────────────
-- Пора ли запускать обход (Р7, по Москве). Ночной слот — сегодня 05:00: повтор после сбоя через 30 минут, не больше трёх
-- попыток и только до 08:00; дневные — пн–пт с 08:00 до 20:00 каждый час, одна попытка на слот. Ночь приоритетнее.
-- → {due:false} | {due:true, kind:'night'|'day', slot:<timestamptz>}
CREATE OR REPLACE FUNCTION osp_private.signal_sync_due(p_now timestamptz DEFAULT now()) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_loc timestamp;
  v_day timestamp;
  v_night timestamptz;
  v_night_end timestamptz;
  v_hour int;
  v_dow int;
  v_slot timestamptz;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
  END IF;
  v_loc := p_now AT TIME ZONE 'Europe/Moscow';
  v_day := date_trunc('day', v_loc);
  v_night := (v_day + interval '5 hours') AT TIME ZONE 'Europe/Moscow';
  v_night_end := (v_day + interval '8 hours') AT TIME ZONE 'Europe/Moscow';
  v_hour := extract(hour FROM v_loc)::int;
  v_dow := extract(isodow FROM v_loc)::int;

  IF p_now >= v_night AND p_now < v_night_end
     AND NOT EXISTS (SELECT 1 FROM osp_private.signal_runs r
                     WHERE r.kind = 'night' AND r.slot = v_night AND r.status IN ('running', 'ok', 'held'))
     AND (SELECT count(*) FROM osp_private.signal_runs r WHERE r.kind = 'night' AND r.slot = v_night) < 3
     AND NOT EXISTS (SELECT 1 FROM osp_private.signal_runs r
                     WHERE r.kind = 'night' AND r.slot = v_night AND coalesce(r.finished_at, r.started_at) > p_now - interval '30 minutes') THEN
    RETURN jsonb_build_object('due', true, 'kind', 'night', 'slot', v_night);
  END IF;
  IF v_dow BETWEEN 1 AND 5 AND v_hour BETWEEN 8 AND 20 THEN
    v_slot := (v_day + make_interval(hours => v_hour)) AT TIME ZONE 'Europe/Moscow';
    IF NOT EXISTS (SELECT 1 FROM osp_private.signal_runs r WHERE r.kind = 'day' AND r.slot = v_slot) THEN
      RETURN jsonb_build_object('due', true, 'kind', 'day', 'slot', v_slot);
    END IF;
  END IF;
  RETURN jsonb_build_object('due', false);
END
$$;

-- Начать прогон. Сначала — зависшие (heartbeat старше p_stale_seconds) → failed/stale; staging завершённых прогонов
-- (кроме последнего held — его можно принять вручную) удаляется. Идёт другой прогон — NULL. Иначе {runId, ownerToken}.
CREATE OR REPLACE FUNCTION osp_private.signal_sync_begin(p_kind text, p_mode text, p_initiator text, p_slot timestamptz,
    p_started_by uuid DEFAULT NULL, p_stale_seconds int DEFAULT 600) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_id bigint;
  v_keep bigint;
  v_owner uuid := gen_random_uuid();
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('day', 'night', 'manual') OR p_mode IS NULL OR p_mode NOT IN ('full', 'known')
     OR p_initiator IS NULL OR p_initiator NOT IN ('schedule', 'cli', 'admin') OR (p_kind <> 'day' AND p_mode <> 'full') THEN
    RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'invalid';
  END IF;
  UPDATE osp_private.signal_runs
     SET status = 'failed', reason = 'stale', finished_at = now()
   WHERE status = 'running'
     AND heartbeat_at < now() - make_interval(secs => greatest(60, least(coalesce(p_stale_seconds, 600), 86400)));
  SELECT max(r.id) INTO v_keep FROM osp_private.signal_runs r WHERE r.status = 'held';
  DELETE FROM osp_private.signal_stage_nodes st
   USING osp_private.signal_runs r
   WHERE r.id = st.run_id AND r.status <> 'running' AND r.id IS DISTINCT FROM v_keep;
  DELETE FROM osp_private.signal_runs r
   WHERE r.status <> 'running' AND coalesce(r.finished_at, r.started_at) < now() - interval '120 days' AND r.id IS DISTINCT FROM v_keep;
  BEGIN
    INSERT INTO osp_private.signal_runs (kind, mode, initiator, started_by, owner_token, slot)
    VALUES (p_kind, p_mode, p_initiator, p_started_by, v_owner, p_slot)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN NULL;
  END;
  RETURN jsonb_build_object('runId', v_id, 'ownerToken', v_owner);
END
$$;

CREATE OR REPLACE FUNCTION osp_private.signal_sync_heartbeat(p_run bigint, p_owner uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
  END IF;
  UPDATE osp_private.signal_runs SET heartbeat_at = now()
   WHERE id = p_run AND owner_token = p_owner AND status = 'running';
  RETURN FOUND;
END
$$;

-- Порция узлов прогона (≤ 1000). Элемент: {nodeId, projectId, sourceId, kind, parentId, name, path, pathIds, depth, modifiedAt,
-- itemType, versionNumber, deleted, numberKeys, nameNorm, features, itemsListed}. Повтор того же nodeId в прогоне заменяет
-- строку; два одинаковых nodeId в одной порции — invalid. Не владелец / не running — SG409 busy. → число принятых строк.
CREATE OR REPLACE FUNCTION osp_private.signal_stage_put(p_run bigint, p_owner uuid, p_rows jsonb) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_n int;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM osp_private.signal_runs r WHERE r.id = p_run AND r.owner_token = p_owner AND r.status = 'running') THEN
    RAISE EXCEPTION USING ERRCODE = 'SG409', MESSAGE = 'busy';
  END IF;
  BEGIN
    INSERT INTO osp_private.signal_stage_nodes AS st
      (run_id, node_id, project_id, source_id, kind, parent_id, name, path, path_ids, depth, modified_at, item_type, version_number,
       deleted, number_keys, name_norm, features, items_listed)
    SELECT p_run, (e ->> 'nodeId')::uuid, (e ->> 'projectId')::uuid, (e ->> 'sourceId')::bigint, e ->> 'kind',
           nullif(e ->> 'parentId', '')::uuid, e ->> 'name', e ->> 'path', osp_private.signal_jsonb_uuids(e -> 'pathIds'),
           coalesce((e ->> 'depth')::int, 0), nullif(e ->> 'modifiedAt', '')::timestamptz, e ->> 'itemType',
           nullif(e ->> 'versionNumber', '')::int, coalesce((e ->> 'deleted')::boolean, false),
           osp_private.signal_jsonb_texts(e -> 'numberKeys'), coalesce(e ->> 'nameNorm', ''),
           CASE WHEN jsonb_typeof(e -> 'features') = 'object' THEN e -> 'features' ELSE '{}'::jsonb END,
           coalesce((e ->> 'itemsListed')::boolean, false)
    FROM jsonb_array_elements(p_rows) e
    ON CONFLICT (run_id, node_id) DO UPDATE
      SET project_id = EXCLUDED.project_id, source_id = EXCLUDED.source_id, kind = EXCLUDED.kind, parent_id = EXCLUDED.parent_id,
          name = EXCLUDED.name, path = EXCLUDED.path, path_ids = EXCLUDED.path_ids, depth = EXCLUDED.depth,
          modified_at = EXCLUDED.modified_at, item_type = EXCLUDED.item_type, version_number = EXCLUDED.version_number,
          deleted = EXCLUDED.deleted, number_keys = EXCLUDED.number_keys, name_norm = EXCLUDED.name_norm,
          features = EXCLUDED.features, items_listed = EXCLUDED.items_listed;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range
            OR check_violation OR not_null_violation OR cardinality_violation OR string_data_right_truncation
            OR invalid_parameter_value OR data_exception THEN
    RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'invalid';
  END;
  UPDATE osp_private.signal_runs SET heartbeat_at = now() WHERE id = p_run;
  RETURN v_n;
END
$$;

-- Корни, которые прогон не смог обойти (p_stats.roots[] = {id, status:'failed', reason?}): код причины — в last_error корня.
CREATE OR REPLACE FUNCTION osp_private.signal_mark_root_errors(p_stats jsonb, p_default text) RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  UPDATE osp_private.signal_sources s
     SET last_error = x.code, updated_at = now()
    FROM (SELECT (r ->> 'id')::bigint AS id,
                 CASE WHEN r ->> 'reason' ~ '^[a-z_]{1,40}$' THEN r ->> 'reason'
                      WHEN p_default ~ '^[a-z_]{1,40}$' THEN p_default ELSE 'unknown' END AS code
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_stats -> 'roots') = 'array' THEN p_stats -> 'roots' ELSE '[]'::jsonb END) r
          WHERE (r ->> 'id') ~ '^[0-9]{1,18}$' AND coalesce(r ->> 'status', '') = 'failed') x
   WHERE s.id = x.id AND s.enabled
$$;

-- Прогон не удался или отменён (барьер записи, остановка службы): staging удаляется, снимок и решения не меняются.
-- Чужому или уже завершённому прогону — тихо ничего.
CREATE OR REPLACE FUNCTION osp_private.signal_sync_fail(p_run bigint, p_owner uuid, p_status text, p_reason text, p_stats jsonb) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_stats jsonb := CASE WHEN jsonb_typeof(p_stats) = 'object' AND length(p_stats::text) <= 20000 THEN p_stats ELSE '{}'::jsonb END;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('failed', 'cancelled') THEN
    RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'invalid';
  END IF;
  UPDATE osp_private.signal_runs
     SET status = p_status, reason = CASE WHEN p_reason ~ '^[a-z_]{1,40}$' THEN p_reason ELSE 'unknown' END,
         finished_at = now(), stats = v_stats
   WHERE id = p_run AND owner_token = p_owner AND status = 'running';
  IF FOUND THEN
    DELETE FROM osp_private.signal_stage_nodes WHERE run_id = p_run;
    PERFORM osp_private.signal_mark_root_errors(v_stats, p_reason);
  END IF;
END
$$;

-- Граница Ф1. R — объекты корня (привязки без узла). R пуст → у всех узлов корня object_id = NULL. Иначе объект узла — ближайшая
-- привязка поддерева среди {сам узел} ∪ предки (обратный порядок path_ids); нет — единственный объект R при |R| = 1, иначе NULL.
-- Привязки поддеревьев на объекты вне R игнорируются. Синоним границу не задаёт. → число изменённых узлов.
CREATE OR REPLACE FUNCTION osp_private.signal_recompute_objects(p_source bigint) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_r uuid[];
  v_n int := 0;
  v_has_sub boolean;
BEGIN
  SELECT coalesce(array_agg(b.object_id ORDER BY b.object_id), '{}'::uuid[]) INTO v_r
    FROM osp_private.signal_bindings b WHERE b.source_id = p_source AND b.node_id IS NULL;
  IF cardinality(v_r) = 0 THEN
    UPDATE osp_private.signal_nodes n SET object_id = NULL WHERE n.source_id = p_source AND n.object_id IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
  END IF;
  SELECT EXISTS (SELECT 1 FROM osp_private.signal_bindings b
                 WHERE b.source_id = p_source AND b.node_id IS NOT NULL AND b.object_id = ANY (v_r)) INTO v_has_sub;
  IF NOT v_has_sub THEN
    UPDATE osp_private.signal_nodes n
       SET object_id = CASE WHEN cardinality(v_r) = 1 THEN v_r[1] END
     WHERE n.source_id = p_source AND n.object_id IS DISTINCT FROM CASE WHEN cardinality(v_r) = 1 THEN v_r[1] END;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
  END IF;
  WITH sub AS (
    SELECT b.node_id, b.object_id FROM osp_private.signal_bindings b
    WHERE b.source_id = p_source AND b.node_id IS NOT NULL AND b.object_id = ANY (v_r)
  ), calc AS (
    SELECT n.node_id,
           coalesce(
             (SELECT s.object_id FROM sub s WHERE s.node_id = n.node_id),
             (SELECT s.object_id FROM sub s JOIN unnest(n.path_ids) WITH ORDINALITY u(id, ord) ON u.id = s.node_id
              ORDER BY u.ord DESC LIMIT 1),
             CASE WHEN cardinality(v_r) = 1 THEN v_r[1] END) AS obj
    FROM osp_private.signal_nodes n WHERE n.source_id = p_source
  )
  UPDATE osp_private.signal_nodes n SET object_id = calc.obj
    FROM calc WHERE n.node_id = calc.node_id AND n.object_id IS DISTINCT FROM calc.obj;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

-- Всем неудалённым договорам — новая ревизия плановой пересверки (recheck_only = true: реквизиты не менялись, «ожидает» не
-- показывается). Строка, уже стоящая в очереди из-за правки реквизитов, остаётся с recheck_only = false.
-- Внутренняя (зовут и пользовательские функции); служебная обёртка — ниже.
-- Строки вставляются по возрастанию contract_id: тот же порядок блокировок, что у signal_state_write (нет взаимных ожиданий).
CREATE OR REPLACE FUNCTION osp_private.signal_enqueue_impl(p_object uuid DEFAULT NULL) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_n int;
BEGIN
  INSERT INTO osp_private.signal_queue AS q (contract_id, dirty_revision, dirty_since, recheck_only)
  SELECT c.id, nextval('osp_private.signal_revision_seq'), now(), true
  FROM public.contracts c
  WHERE c.deleted_at IS NULL AND (p_object IS NULL OR c.object_id = p_object)
  ORDER BY c.id
  ON CONFLICT (contract_id) DO UPDATE
    SET dirty_revision = EXCLUDED.dirty_revision, dirty_since = EXCLUDED.dirty_since, attempts = 0, next_at = NULL,
        recheck_only = q.recheck_only;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

CREATE OR REPLACE FUNCTION osp_private.signal_enqueue_all() RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
  END IF;
  RETURN osp_private.signal_enqueue_impl(NULL);
END
$$;

-- Публикация staging одной транзакцией (раздел 4.3, шаги 3–6). Вызывают signal_sync_finish и signal_accept_held после своих
-- проверок и блокировки signal_meta. Обработанные корни — те, у кого в staging есть строки и кто включён.
CREATE OR REPLACE FUNCTION osp_private.signal_publish(p_run bigint, p_stats jsonb, p_actor text, p_reason text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_run osp_private.signal_runs%ROWTYPE;
  v_gen bigint;
  v_new bigint;
  v_sources bigint[];
  v_src bigint;
BEGIN
  SELECT * INTO v_run FROM osp_private.signal_runs r WHERE r.id = p_run;
  SELECT m.generation INTO v_gen FROM osp_private.signal_meta m WHERE m.id = 1;
  v_new := v_gen + 1;
  SELECT coalesce(array_agg(DISTINCT st.source_id), '{}'::bigint[]) INTO v_sources
    FROM osp_private.signal_stage_nodes st
    JOIN osp_private.signal_sources s ON s.id = st.source_id AND s.enabled
   WHERE st.run_id = p_run;

  -- Замена: пришедшие узлы — upsert (видны в новом поколении, пропаж нет). Объект узла пересчитает signal_recompute_objects.
  INSERT INTO osp_private.signal_nodes AS n
    (node_id, project_id, source_id, kind, parent_id, name, path, path_ids, depth, modified_at, item_type, version_number, deleted,
     number_keys, name_norm, features, first_gen, seen_gen, absent_nights)
  SELECT st.node_id, s.project_id, st.source_id, st.kind, st.parent_id, st.name, st.path, st.path_ids, st.depth, st.modified_at,
         st.item_type, st.version_number, st.deleted, st.number_keys, st.name_norm, st.features, v_new, v_new, 0
  FROM osp_private.signal_stage_nodes st
  JOIN osp_private.signal_sources s ON s.id = st.source_id AND s.enabled
  WHERE st.run_id = p_run
  ORDER BY st.node_id
  ON CONFLICT (node_id) DO UPDATE
    SET project_id = EXCLUDED.project_id, source_id = EXCLUDED.source_id, kind = EXCLUDED.kind, parent_id = EXCLUDED.parent_id,
        name = EXCLUDED.name, path = EXCLUDED.path, path_ids = EXCLUDED.path_ids, depth = EXCLUDED.depth,
        modified_at = EXCLUDED.modified_at, item_type = EXCLUDED.item_type, version_number = EXCLUDED.version_number,
        deleted = EXCLUDED.deleted, number_keys = EXCLUDED.number_keys, name_norm = EXCLUDED.name_norm,
        features = EXCLUDED.features, seen_gen = EXCLUDED.seen_gen, absent_nights = 0;

  -- Режим known: элементы папок, которых в этом прогоне не перечисляли, переносятся, если их папка видна.
  UPDATE osp_private.signal_nodes n SET seen_gen = v_new
   WHERE n.source_id = ANY (v_sources) AND n.kind = 'item' AND n.seen_gen <> v_new
     AND EXISTS (SELECT 1 FROM osp_private.signal_stage_nodes f
                 WHERE f.run_id = p_run AND f.node_id = n.parent_id AND f.kind = 'folder' AND NOT f.items_listed);

  -- Остальное в обработанных корнях в этом прогоне не видели: seen_gen прежний; ночной полный обход считает ночь без узла.
  IF v_run.kind = 'night' THEN
    UPDATE osp_private.signal_nodes n SET absent_nights = n.absent_nights + 1
     WHERE n.source_id = ANY (v_sources) AND n.seen_gen <> v_new;
  END IF;

  FOREACH v_src IN ARRAY v_sources LOOP
    PERFORM osp_private.signal_recompute_objects(v_src);
  END LOOP;

  UPDATE osp_private.signal_sources s
     SET ready = true, last_run_id = p_run, last_ok_at = now(),
         last_full_ok_at = CASE WHEN v_run.mode = 'full' THEN now() ELSE s.last_full_ok_at END,
         last_night_ok_at = CASE WHEN v_run.kind = 'night' THEN now() ELSE s.last_night_ok_at END,
         last_error = NULL, updated_at = now(),
         folders_count = (SELECT count(*) FROM osp_private.signal_nodes n WHERE n.source_id = s.id AND n.kind = 'folder' AND n.seen_gen = v_new),
         items_count = (SELECT count(*) FROM osp_private.signal_nodes n
                        WHERE n.source_id = s.id AND n.kind = 'item' AND NOT n.deleted AND n.seen_gen = v_new)
   WHERE s.id = ANY (v_sources);

  UPDATE osp_private.signal_meta SET generation = v_new, published_at = now(), published_run_id = p_run WHERE id = 1;
  PERFORM osp_private.signal_enqueue_impl(NULL);
  DELETE FROM osp_private.signal_stage_nodes WHERE run_id = p_run;
  UPDATE osp_private.signal_runs
     SET status = 'ok', reason = NULL, finished_at = now(), generation = v_new, stats = p_stats,
         accepted_by = left(p_actor, 200), accept_reason = left(p_reason, 500)
   WHERE id = p_run;
  -- Опубликованное поколение вытесняет прочие отложенные прогоны: их staging старше снимка, применять его нельзя (accept_held вернёт
  -- stale_state). Статус held остаётся — видно, что прогон откладывали; reason = superseded. Идущий прогон не трогаем.
  DELETE FROM osp_private.signal_stage_nodes st
   USING osp_private.signal_runs r
   WHERE r.id = st.run_id AND r.status <> 'running' AND r.id <> p_run;
  UPDATE osp_private.signal_runs SET reason = 'superseded' WHERE status = 'held' AND id <> p_run;

  -- Уборка: узлы, которых не видят очень давно и на которые никто не ссылается.
  DELETE FROM osp_private.signal_nodes n
   WHERE n.seen_gen < v_new - 400
     AND NOT EXISTS (SELECT 1 FROM osp_private.signal_contracts c WHERE c.node_id = n.node_id)
     AND NOT EXISTS (SELECT 1 FROM osp_private.signal_candidates k WHERE k.node_id = n.node_id)
     AND NOT EXISTS (SELECT 1 FROM osp_private.signal_bindings b WHERE b.node_id = n.node_id);

  RETURN jsonb_build_object('status', 'ok', 'generation', v_new, 'reason', NULL, 'runId', p_run);
END
$$;

-- Завершить прогон: проверить владельца, порог и опубликовать. Одна транзакция; пока идёт публикация, signal_meta заблокирована.
-- Порог (W1-07): по каждому корню папки (всегда) и элементы (только режим full): было ≥ 20 и стало < 70 % либо пусто при
-- непустом прошлом → held, staging сохраняется (p_force — опубликовать). Корень с status = 'failed' в p_stats.roots → held
-- (root_failed). → {status:'ok'|'held', generation, reason, runId}. Не владелец / не running / heartbeat старше 10 минут —
-- SG409 busy.
CREATE OR REPLACE FUNCTION osp_private.signal_sync_finish(p_run bigint, p_owner uuid, p_stats jsonb, p_force boolean DEFAULT false) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
  SET statement_timeout = '120s'
AS $$
DECLARE
  v_run osp_private.signal_runs%ROWTYPE;
  v_stats jsonb := CASE WHEN jsonb_typeof(p_stats) = 'object' AND length(p_stats::text) <= 20000 THEN p_stats ELSE '{}'::jsonb END;
  v_gen bigint;
  v_held text;
  v_hold jsonb := '[]'::jsonb;
  r record;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
  END IF;
  SELECT m.generation INTO v_gen FROM osp_private.signal_meta m WHERE m.id = 1 FOR UPDATE;
  SELECT * INTO v_run FROM osp_private.signal_runs x WHERE x.id = p_run FOR UPDATE;
  IF NOT FOUND OR v_run.status <> 'running' OR v_run.owner_token IS DISTINCT FROM p_owner
     OR v_run.heartbeat_at < now() - interval '10 minutes' THEN
    RAISE EXCEPTION USING ERRCODE = 'SG409', MESSAGE = 'busy';
  END IF;

  IF NOT coalesce(p_force, false) THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_stats -> 'roots') = 'array' THEN v_stats -> 'roots' ELSE '[]'::jsonb END) x
               WHERE coalesce(x ->> 'status', '') = 'failed') THEN
      v_held := 'root_failed';
    END IF;
    IF v_held IS NULL AND NOT EXISTS (SELECT 1 FROM osp_private.signal_stage_nodes st
                                      JOIN osp_private.signal_sources s ON s.id = st.source_id AND s.enabled WHERE st.run_id = p_run)
       AND EXISTS (SELECT 1 FROM osp_private.signal_nodes n JOIN osp_private.signal_sources s ON s.id = n.source_id AND s.enabled) THEN
      v_held := 'empty';
    END IF;
    IF v_held IS NULL THEN
      FOR r IN
        SELECT s.id AS source_id,
               (SELECT count(*) FROM osp_private.signal_stage_nodes st WHERE st.run_id = p_run AND st.source_id = s.id AND st.kind = 'folder') AS new_folders,
               (SELECT count(*) FROM osp_private.signal_stage_nodes st WHERE st.run_id = p_run AND st.source_id = s.id AND st.kind = 'item') AS new_items,
               (SELECT count(*) FROM osp_private.signal_nodes n WHERE n.source_id = s.id AND n.kind = 'folder'
                  AND n.seen_gen = (SELECT max(n2.seen_gen) FROM osp_private.signal_nodes n2 WHERE n2.source_id = s.id)) AS old_folders,
               (SELECT count(*) FROM osp_private.signal_nodes n WHERE n.source_id = s.id AND n.kind = 'item'
                  AND n.seen_gen = (SELECT max(n2.seen_gen) FROM osp_private.signal_nodes n2 WHERE n2.source_id = s.id)) AS old_items
        FROM osp_private.signal_sources s
        WHERE s.enabled AND s.id IN (SELECT DISTINCT st.source_id FROM osp_private.signal_stage_nodes st WHERE st.run_id = p_run)
        ORDER BY s.id
      LOOP
        IF (r.old_folders > 0 AND r.new_folders = 0) OR (r.old_folders >= 20 AND r.new_folders < r.old_folders * 0.7) THEN
          v_held := CASE WHEN r.new_folders = 0 THEN 'empty' ELSE coalesce(v_held, 'shrink') END;
          v_hold := v_hold || jsonb_build_array(jsonb_build_object('id', r.source_id, 'kind', 'folders', 'was', r.old_folders, 'now', r.new_folders));
        END IF;
        IF v_run.mode = 'full' AND ((r.old_items > 0 AND r.new_items = 0) OR (r.old_items >= 20 AND r.new_items < r.old_items * 0.7)) THEN
          v_held := CASE WHEN r.new_items = 0 THEN 'empty' ELSE coalesce(v_held, 'shrink') END;
          v_hold := v_hold || jsonb_build_array(jsonb_build_object('id', r.source_id, 'kind', 'items', 'was', r.old_items, 'now', r.new_items));
        END IF;
      END LOOP;
    END IF;
    IF v_held IS NOT NULL THEN
      UPDATE osp_private.signal_runs
         SET status = 'held', reason = v_held, finished_at = now(), generation = v_gen,
             stats = CASE WHEN jsonb_array_length(v_hold) > 0 THEN v_stats || jsonb_build_object('held', v_hold) ELSE v_stats END
       WHERE id = p_run;
      PERFORM osp_private.signal_mark_root_errors(v_stats, v_held);
      RETURN jsonb_build_object('status', 'held', 'generation', v_gen, 'reason', v_held, 'runId', p_run);
    END IF;
  END IF;
  RETURN osp_private.signal_publish(p_run, v_stats, NULL, NULL);
END
$$;

-- Принять отложенный прогон вручную (CLI): только последний held, только пока поколение снимка прежнее и после него не было
-- опубликованного прогона (signal_meta.published_run_id не новее него), и только пока цел его staging (любая публикация
-- вытесняет прочие held: staging удаляется, reason = superseded). Публикует staging с force и записывает, кто и почему принял.
CREATE OR REPLACE FUNCTION osp_private.signal_accept_held(p_run bigint, p_expected_generation bigint, p_actor text, p_reason text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
  SET statement_timeout = '120s'
AS $$
DECLARE
  v_run osp_private.signal_runs%ROWTYPE;
  v_gen bigint;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
  END IF;
  IF coalesce(btrim(p_actor), '') = '' OR coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'invalid';
  END IF;
  SELECT m.generation INTO v_gen FROM osp_private.signal_meta m WHERE m.id = 1 FOR UPDATE;
  SELECT * INTO v_run FROM osp_private.signal_runs x WHERE x.id = p_run FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'SG404', MESSAGE = 'not_found';
  END IF;
  IF v_run.status <> 'held' OR v_run.id <> (SELECT max(x.id) FROM osp_private.signal_runs x WHERE x.status = 'held')
     OR v_gen IS DISTINCT FROM p_expected_generation
     OR coalesce((SELECT m.published_run_id FROM osp_private.signal_meta m WHERE m.id = 1), 0) >= p_run
     OR NOT EXISTS (SELECT 1 FROM osp_private.signal_stage_nodes st WHERE st.run_id = p_run) THEN
    RAISE EXCEPTION USING ERRCODE = 'SG409', MESSAGE = 'stale_state';
  END IF;
  RETURN osp_private.signal_publish(p_run, v_run.stats, p_actor, p_reason);
END
$$;

-- Включённые корни для обхода. Для режима known (идущий прогон — known, либо p_mode = 'known') у каждого корня ещё:
-- knownFolderIds — папки со связью или кандидатом, folderIds — папки опубликованного снимка.
-- → {mode, sources:[{id, projectId, folderId, knownFolderIds?, folderIds?}]}
CREATE OR REPLACE FUNCTION osp_private.signal_sources_for_sync(p_mode text DEFAULT NULL) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_mode text := p_mode;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
  END IF;
  IF v_mode IS NULL THEN
    SELECT r.mode INTO v_mode FROM osp_private.signal_runs r WHERE r.status = 'running';
  END IF;
  v_mode := coalesce(v_mode, 'full');
  RETURN jsonb_build_object('mode', v_mode, 'sources', coalesce((
    SELECT jsonb_agg(
             jsonb_build_object('id', s.id, 'projectId', s.project_id, 'folderId', s.folder_id)
             || CASE WHEN v_mode = 'known' THEN jsonb_build_object(
                  'knownFolderIds', coalesce((SELECT jsonb_agg(f.node_id ORDER BY f.node_id) FROM (
                      SELECT n.node_id FROM osp_private.signal_nodes n
                       WHERE n.source_id = s.id AND n.kind = 'folder' AND (
                         EXISTS (SELECT 1 FROM osp_private.signal_contracts c WHERE c.node_id = n.node_id)
                         OR EXISTS (SELECT 1 FROM osp_private.signal_candidates k WHERE k.node_id = n.node_id AND k.status = 'open'))) f), '[]'::jsonb),
                  'folderIds', coalesce((SELECT jsonb_agg(n.node_id ORDER BY n.node_id) FROM osp_private.signal_nodes n
                                          WHERE n.source_id = s.id AND n.kind = 'folder'), '[]'::jsonb))
                ELSE '{}'::jsonb END
             ORDER BY s.id)
    FROM osp_private.signal_sources s WHERE s.enabled), '[]'::jsonb));
END
$$;

-- ── 6. Служебные функции: очередь и сопоставление ───────────────────────────────────────────────────
-- Захватить до p_limit договоров (свободные, срок next_at наступил, по dirty_since). FOR UPDATE SKIP LOCKED: параллельные
-- работники не пересекаются. → {leaseToken, items:[{contractId, revision}]}; нечего брать — {leaseToken:null, items:[]}.
CREATE OR REPLACE FUNCTION osp_private.signal_queue_claim(p_limit int, p_lease_seconds int DEFAULT 120) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_token uuid := gen_random_uuid();
  v_items jsonb;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
  END IF;
  WITH picked AS (
    SELECT q.contract_id FROM osp_private.signal_queue q
    WHERE (q.lease_until IS NULL OR q.lease_until <= now()) AND (q.next_at IS NULL OR q.next_at <= now())
    ORDER BY q.dirty_since, q.contract_id
    LIMIT greatest(1, least(coalesce(p_limit, 200), 500))
    FOR UPDATE SKIP LOCKED
  ), upd AS (
    UPDATE osp_private.signal_queue q
       SET lease_token = v_token, lease_until = now() + make_interval(secs => greatest(10, least(coalesce(p_lease_seconds, 120), 3600)))
      FROM picked WHERE q.contract_id = picked.contract_id
    RETURNING q.contract_id, q.dirty_revision, q.dirty_since
  )
  SELECT jsonb_agg(jsonb_build_object('contractId', u.contract_id, 'revision', u.dirty_revision) ORDER BY u.dirty_since, u.contract_id)
    INTO v_items FROM upd u;
  IF v_items IS NULL THEN
    RETURN jsonb_build_object('leaseToken', NULL, 'items', '[]'::jsonb);
  END IF;
  RETURN jsonb_build_object('leaseToken', v_token, 'items', v_items);
END
$$;

-- Вернуть захваченные договоры (ошибка обработки): снять захват, попытка +1, следующая — через p_backoff_seconds.
-- → число освобождённых строк.
CREATE OR REPLACE FUNCTION osp_private.signal_queue_release(p_lease uuid, p_contract_ids uuid[], p_backoff_seconds int) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_n int;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
  END IF;
  UPDATE osp_private.signal_queue q
     SET lease_token = NULL, lease_until = NULL, attempts = q.attempts + 1,
         next_at = now() + make_interval(secs => greatest(0, least(coalesce(p_backoff_seconds, 60), 86400)))
   WHERE q.lease_token = p_lease AND q.contract_id = ANY (coalesce(p_contract_ids, '{}'::uuid[]));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

-- Вход сопоставителя по одному договору (раздел 5.1). Для сторон — contract_counterparties плюс contracts.counterparty_id.
CREATE OR REPLACE FUNCTION osp_private.signal_contract_input(p_contract uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  c public.contracts%ROWTYPE;
  d public.contracts%ROWTYPE;
  v_cycle boolean := false;
  v_cur uuid;
  v_seen uuid[];
  v_steps int := 0;
  v_dp jsonb := NULL;
  v_dp_node uuid;
  v_cp jsonb;
  v_cand jsonb;
  v_state jsonb;
  v_rev bigint;
  v_ver bigint;
BEGIN
  SELECT * INTO c FROM public.contracts x WHERE x.id = p_contract;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF c.record_type <> 'dp' THEN
    IF c.root_contract_id IS NOT NULL AND c.root_contract_id <> c.id THEN
      SELECT * INTO d FROM public.contracts x WHERE x.id = c.root_contract_id;
    END IF;
    IF d.id IS NULL THEN
      v_cur := c.parent_contract_id;
      v_seen := ARRAY[c.id];
      WHILE v_cur IS NOT NULL AND v_steps < 10 LOOP
        IF v_cur = ANY (v_seen) THEN v_cycle := true; EXIT; END IF;
        SELECT * INTO d FROM public.contracts x WHERE x.id = v_cur;
        IF NOT FOUND THEN d := NULL; EXIT; END IF;
        v_seen := v_seen || v_cur;
        v_steps := v_steps + 1;
        EXIT WHEN d.record_type = 'dp';
        v_cur := d.parent_contract_id;
      END LOOP;
      IF v_cycle OR d.id IS NULL OR d.record_type <> 'dp' THEN d := NULL; END IF;
    END IF;
    IF d.id IS NOT NULL THEN
      SELECT sc.node_id INTO v_dp_node FROM osp_private.signal_contracts sc WHERE sc.contract_id = d.id;
      v_dp := jsonb_build_object('id', d.id, 'number', d.contract_number, 'numberKey', public.contract_number_key(d.contract_number),
                                 'objectId', d.object_id, 'signalLink', d.signal_link, 'nodeId', v_dp_node,
                                 'deleted', d.deleted_at IS NOT NULL);
    END IF;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'inn', p.inn) ORDER BY p.name, p.id), '[]'::jsonb) INTO v_cp
    FROM public.counterparties p
   WHERE p.id IN (SELECT cc.counterparty_id FROM public.contract_counterparties cc WHERE cc.contract_id = c.id
                  UNION SELECT c.counterparty_id WHERE c.counterparty_id IS NOT NULL);
  SELECT coalesce(jsonb_agg(jsonb_build_object('nodeId', k.node_id, 'status', k.status, 'ctxKey', k.ctx_key) ORDER BY k.node_id), '[]'::jsonb)
    INTO v_cand FROM osp_private.signal_candidates k WHERE k.contract_id = c.id;
  SELECT jsonb_build_object('state', sc.state, 'reason', sc.reason, 'nodeId', sc.node_id, 'confirmedBy', sc.confirmed_by), sc.state_version
    INTO v_state, v_ver FROM osp_private.signal_contracts sc WHERE sc.contract_id = c.id;
  SELECT q.dirty_revision INTO v_rev FROM osp_private.signal_queue q WHERE q.contract_id = c.id;

  RETURN jsonb_build_object(
    'id', c.id, 'recordType', c.record_type, 'number', c.contract_number, 'numberKey', public.contract_number_key(c.contract_number),
    'date', c.contract_date, 'objectId', c.object_id, 'parentId', c.parent_contract_id, 'rootId', c.root_contract_id,
    'signalLink', c.signal_link, 'deleted', c.deleted_at IS NOT NULL, 'counterparties', v_cp,
    'family', jsonb_build_object('dp', v_dp, 'cycle', v_cycle), 'candidates', v_cand, 'revision', v_rev,
    'stateVersion', coalesce(v_ver, 0), 'state', v_state);
END
$$;

-- Вход сопоставления по списку договоров (≤ 500): {generation, objects:[{id, name, code, aliases:[{text,key}]}],
-- contracts:[…раздел 5.1…]}. Договоров, которых нет, в ответе нет. revision — ревизия очереди на момент загрузки (NULL — строки нет).
CREATE OR REPLACE FUNCTION osp_private.signal_match_load(p_contract_ids uuid[]) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_gen bigint;
  v_objects jsonb;
  v_contracts jsonb;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
  END IF;
  IF p_contract_ids IS NULL OR cardinality(p_contract_ids) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'invalid';
  END IF;
  SELECT m.generation INTO v_gen FROM osp_private.signal_meta m WHERE m.id = 1;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'code', o.contract_code, 'aliases', coalesce((
           SELECT jsonb_agg(jsonb_build_object('text', a.alias_text, 'key', a.alias_key) ORDER BY a.id)
             FROM osp_private.signal_aliases a WHERE a.object_id = o.id), '[]'::jsonb)) ORDER BY o.id), '[]'::jsonb)
    INTO v_objects FROM public.objects o;
  SELECT coalesce(jsonb_agg(osp_private.signal_contract_input(i.id) ORDER BY i.id), '[]'::jsonb)
    INTO v_contracts FROM (SELECT DISTINCT x.id FROM public.contracts x WHERE x.id = ANY (p_contract_ids)) i;
  RETURN jsonb_build_object('generation', v_gen, 'objects', v_objects, 'contracts', v_contracts);
END
$$;

-- Узлы опубликованного снимка для сопоставителя. Выбираются по любому из условий: по id (любые), папки по пересечению
-- number_keys, папки объектов p_object_ids с name_norm, содержащим один из p_terms, папки внутри p_under (по path_ids).
-- → {generation, truncated, nodes:[…раздел 5.2…]} в порядке (path, node_id), не больше p_limit.
CREATE OR REPLACE FUNCTION osp_private.signal_match_nodes(p_node_ids uuid[], p_number_keys text[], p_object_ids uuid[], p_terms text[],
    p_under uuid[], p_limit int DEFAULT 500) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_gen bigint;
  v_limit int := greatest(1, least(coalesce(p_limit, 500), 2000));
  v_patterns text[];
  v_ids uuid[];
  v_truncated boolean;
  v_nodes jsonb;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
  END IF;
  IF cardinality(coalesce(p_node_ids, '{}')) > 5000 OR cardinality(coalesce(p_number_keys, '{}')) > 1000
     OR cardinality(coalesce(p_object_ids, '{}')) > 1000 OR cardinality(coalesce(p_terms, '{}')) > 200
     OR cardinality(coalesce(p_under, '{}')) > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'invalid';
  END IF;
  SELECT m.generation INTO v_gen FROM osp_private.signal_meta m WHERE m.id = 1;
  SELECT coalesce(array_agg('%' || osp_private.signal_like_escape(t) || '%'), '{}'::text[]) INTO v_patterns
    FROM unnest(coalesce(p_terms, '{}'::text[])) t WHERE t IS NOT NULL AND btrim(t) <> '';
  SELECT array_agg(x.node_id ORDER BY x.path, x.node_id) INTO v_ids FROM (
    SELECT n.node_id, n.path FROM osp_private.signal_nodes n
    WHERE n.node_id = ANY (coalesce(p_node_ids, '{}'::uuid[]))
       OR (n.kind = 'folder' AND n.number_keys && coalesce(p_number_keys, '{}'::text[]))
       OR (n.kind = 'folder' AND n.object_id = ANY (coalesce(p_object_ids, '{}'::uuid[])) AND n.name_norm LIKE ANY (v_patterns))
       OR (n.kind = 'folder' AND n.path_ids && coalesce(p_under, '{}'::uuid[]))
    ORDER BY n.path, n.node_id
    LIMIT v_limit + 1) x;
  v_truncated := cardinality(coalesce(v_ids, '{}')) > v_limit;
  IF v_truncated THEN v_ids := v_ids[1:v_limit]; END IF;
  SELECT coalesce(jsonb_agg(osp_private.signal_node_json(i.id) ORDER BY i.ord), '[]'::jsonb) INTO v_nodes
    FROM unnest(coalesce(v_ids, '{}'::uuid[])) WITH ORDINALITY i(id, ord);
  RETURN jsonb_build_object('generation', v_gen, 'truncated', v_truncated, 'nodes', v_nodes);
END
$$;

-- Запись результата сопоставления (раздел 4.4). Элемент: {contractId, revision, generation, state, reason, nodeId, fingerprint,
-- ctxKey, candidates:[{nodeId, score, reasons, flags, ctxKey?}]}. По порядку contract_id: пропуск (stale), если поколение
-- снимка не то, на котором считали, или ревизия в очереди не та, что захвачена; иначе upsert состояния и замена open-кандидатов,
-- затем ack: DELETE очереди по (contract_id, ревизия, lease). → {written, acked, stale}.
CREATE OR REPLACE FUNCTION osp_private.signal_state_write(p_lease uuid, p_items jsonb) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_meta_gen bigint;
  v_written int := 0;
  v_acked int := 0;
  v_stale int := 0;
  v_n int;
  it jsonb;
  v_cid uuid;
  v_rev bigint;
  v_item_gen bigint;
  v_state text;
  v_reason text;
  v_node uuid;
  v_fp text;
  v_ctx text;
  v_queue_rev bigint;
  sc osp_private.signal_contracts%ROWTYPE;
  v_old_set uuid[];
  v_new_set uuid[];
  v_changed boolean;
  cand jsonb;
  v_cands jsonb;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'invalid';
  END IF;
  SELECT m.generation INTO v_meta_gen FROM osp_private.signal_meta m WHERE m.id = 1;
  FOR it IN SELECT e.value FROM jsonb_array_elements(p_items) e ORDER BY (e.value ->> 'contractId')::uuid LOOP
    v_cid := (it ->> 'contractId')::uuid;
    v_rev := nullif(it ->> 'revision', '')::bigint;
    v_item_gen := (it ->> 'generation')::bigint;
    v_state := it ->> 'state';
    v_reason := nullif(it ->> 'reason', '');
    v_node := nullif(it ->> 'nodeId', '')::uuid;
    v_fp := it ->> 'fingerprint';
    v_ctx := it ->> 'ctxKey';
    IF v_state IS NULL OR v_state NOT IN ('none', 'suggested', 'verified', 'unverified', 'attention', 'missing', 'conflict')
       OR (v_reason IS NOT NULL AND v_reason !~ '^[a-z_]{1,40}$') THEN
      RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'invalid';
    END IF;
    -- Снимок сменился или договор правили после захвата — результат устарел, строка очереди остаётся.
    SELECT q.dirty_revision INTO v_queue_rev FROM osp_private.signal_queue q WHERE q.contract_id = v_cid;
    IF v_item_gen IS DISTINCT FROM v_meta_gen OR v_queue_rev IS DISTINCT FROM v_rev THEN
      v_stale := v_stale + 1;
      CONTINUE;
    END IF;
    INSERT INTO osp_private.signal_contracts (contract_id, state)
    SELECT c.id, 'none' FROM public.contracts c WHERE c.id = v_cid
    ON CONFLICT (contract_id) DO NOTHING;
    SELECT * INTO sc FROM osp_private.signal_contracts x WHERE x.contract_id = v_cid FOR UPDATE;
    IF NOT FOUND THEN
      v_stale := v_stale + 1;
      CONTINUE;
    END IF;

    SELECT coalesce(array_agg(k.node_id ORDER BY k.node_id), '{}'::uuid[]) INTO v_old_set
      FROM osp_private.signal_candidates k WHERE k.contract_id = v_cid AND k.status = 'open';
    -- Не больше 20 кандидатов на договор: лучшие по баллам.
    SELECT coalesce(jsonb_agg(t.value ORDER BY coalesce((t.value ->> 'score')::int, 0) DESC, t.value ->> 'nodeId'), '[]'::jsonb) INTO v_cands
      FROM (SELECT e.value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(it -> 'candidates') = 'array' THEN it -> 'candidates' ELSE '[]'::jsonb END) e
            ORDER BY coalesce((e.value ->> 'score')::int, 0) DESC, e.value ->> 'nodeId' LIMIT 20) t;
    SELECT coalesce(array_agg(DISTINCT (x.value ->> 'nodeId')::uuid ORDER BY (x.value ->> 'nodeId')::uuid), '{}'::uuid[]) INTO v_new_set
      FROM jsonb_array_elements(v_cands) x;
    v_changed := sc.state IS DISTINCT FROM v_state OR sc.reason IS DISTINCT FROM v_reason OR sc.node_id IS DISTINCT FROM v_node
                 OR v_old_set IS DISTINCT FROM v_new_set;

    -- Кандидаты: open, которых больше нет, уходят; новые и прежние open обновляются; решённые (rejected/unlinked) не трогаем,
    -- пока не сменился ctx_key (контекст договора изменился — пара снова может быть предложена).
    DELETE FROM osp_private.signal_candidates k
     WHERE k.contract_id = v_cid AND k.status = 'open' AND NOT (k.node_id = ANY (v_new_set));
    FOR cand IN SELECT x.value FROM jsonb_array_elements(v_cands) x ORDER BY (x.value ->> 'nodeId')::uuid LOOP
      INSERT INTO osp_private.signal_candidates AS k (contract_id, node_id, status, score, reasons, flags, ctx_key)
      VALUES (v_cid, (cand ->> 'nodeId')::uuid, 'open', coalesce((cand ->> 'score')::int, 0),
              osp_private.signal_jsonb_texts(cand -> 'reasons'), osp_private.signal_jsonb_texts(cand -> 'flags'),
              coalesce(cand ->> 'ctxKey', v_ctx))
      ON CONFLICT (contract_id, node_id) DO UPDATE
        SET status = 'open', score = EXCLUDED.score, reasons = EXCLUDED.reasons, flags = EXCLUDED.flags, ctx_key = EXCLUDED.ctx_key,
            decided_by = NULL, decided_at = NULL, note = NULL, updated_at = now()
        WHERE k.status = 'open' OR k.ctx_key IS DISTINCT FROM EXCLUDED.ctx_key;
    END LOOP;

    UPDATE osp_private.signal_contracts x
       SET state = v_state, reason = v_reason, node_id = v_node, fingerprint = v_fp, checked_gen = v_item_gen,
           state_version = x.state_version + CASE WHEN v_changed THEN 1 ELSE 0 END,
           confirmed_by = CASE WHEN x.node_id IS DISTINCT FROM v_node THEN NULL ELSE x.confirmed_by END,
           confirmed_at = CASE WHEN x.node_id IS DISTINCT FROM v_node THEN NULL ELSE x.confirmed_at END,
           processed_revision = coalesce(v_rev, x.processed_revision), updated_at = now()
     WHERE x.contract_id = v_cid;
    v_written := v_written + 1;

    DELETE FROM osp_private.signal_queue q
     WHERE q.contract_id = v_cid AND q.dirty_revision IS NOT DISTINCT FROM v_rev AND v_rev IS NOT NULL
       AND (p_lease IS NULL OR q.lease_token = p_lease);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_acked := v_acked + v_n;
  END LOOP;
  RETURN jsonb_build_object('written', v_written, 'acked', v_acked, 'stale', v_stale);
END
$$;

-- ── 7. Пользовательские функции (db.read / db.write от имени вошедшего) ──────────────────────────────
-- {canView, canEdit, isAdmin}; подрядчик и без прав — всё false. Без вошедшего — SG403.
CREATE OR REPLACE FUNCTION osp_private.signal_user_flags() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_edit boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
  END IF;
  v_edit := coalesce(public.osp_can('contracts', 'edit'), false);
  RETURN jsonb_build_object('canView', v_edit OR coalesce(public.osp_can('contracts', 'view'), false), 'canEdit', v_edit,
                            'isAdmin', coalesce(public.is_admin(), false));
END
$$;

-- Значки реестра: договоры охвата, у которых есть строка состояния или очереди; страницы по id (p_after — последний id).
-- pending — правка реквизитов ещё не просчитана (или договор ни разу не обрабатывали); плановая пересверка (recheck_only)
-- у договора с состоянием «ожидает» не даёт: показывается последнее обработанное состояние.
-- Элемент: {id, state, reason, pending, hasLink, checkedAt, path?, candidatePath?, candidates?}. path — только видимого узла;
-- candidatePath и candidates (число открытых видимых кандидатов) — только при праве правки. → {items, next, dataAt}.
CREATE OR REPLACE FUNCTION osp_private.signal_marks(p_after uuid, p_limit int DEFAULT 500) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_edit boolean;
  v_scope uuid[];
  v_limit int := greatest(1, least(coalesce(p_limit, 500), 1000));
  v_items jsonb;
  v_next uuid;
  v_at timestamptz;
BEGIN
  PERFORM osp_private.signal_require('view');
  v_edit := coalesce(public.osp_can('contracts', 'edit'), false);
  v_scope := public.osp_object_scope();
  SELECT m.published_at INTO v_at FROM osp_private.signal_meta m WHERE m.id = 1;
  WITH base AS (
    SELECT c.id, c.object_id, (btrim(coalesce(c.signal_link, '')) <> '') AS has_link, sc.state, sc.reason, sc.node_id, sc.updated_at,
           (q.contract_id IS NOT NULL AND (sc.contract_id IS NULL OR (NOT q.recheck_only AND q.dirty_revision > sc.processed_revision))) AS pending
    FROM public.contracts c
    LEFT JOIN osp_private.signal_contracts sc ON sc.contract_id = c.id
    LEFT JOIN osp_private.signal_queue q ON q.contract_id = c.id
    WHERE c.deleted_at IS NULL AND (v_scope IS NULL OR c.object_id = ANY (v_scope))
      AND (sc.contract_id IS NOT NULL OR q.contract_id IS NOT NULL)
      AND (p_after IS NULL OR c.id > p_after)
    ORDER BY c.id
    LIMIT v_limit + 1
  ), page AS (SELECT * FROM base ORDER BY id LIMIT v_limit)
  SELECT (SELECT coalesce(jsonb_agg(
             jsonb_build_object('id', p.id, 'state', p.state, 'reason', p.reason, 'pending', p.pending, 'hasLink', p.has_link,
                                'checkedAt', p.updated_at)
             || coalesce((SELECT jsonb_build_object('path', n.path) FROM osp_private.signal_nodes n
                            JOIN osp_private.signal_sources s ON s.id = n.source_id AND s.enabled AND s.ready
                           WHERE n.node_id = p.node_id AND n.object_id IS NOT NULL AND n.object_id = p.object_id), '{}'::jsonb)
             || CASE WHEN v_edit THEN jsonb_build_object(
                  'candidates', (SELECT count(*) FROM osp_private.signal_candidates k
                                   JOIN osp_private.signal_nodes n ON n.node_id = k.node_id
                                   JOIN osp_private.signal_sources s ON s.id = n.source_id AND s.enabled AND s.ready
                                  WHERE k.contract_id = p.id AND k.status = 'open' AND n.object_id IS NOT NULL AND n.object_id = p.object_id))
                  || coalesce((SELECT jsonb_build_object('candidatePath', n.path) FROM osp_private.signal_candidates k
                                 JOIN osp_private.signal_nodes n ON n.node_id = k.node_id
                                 JOIN osp_private.signal_sources s ON s.id = n.source_id AND s.enabled AND s.ready
                                WHERE k.contract_id = p.id AND k.status = 'open' AND n.object_id IS NOT NULL AND n.object_id = p.object_id
                                ORDER BY k.score DESC, n.path, n.node_id LIMIT 1), '{}'::jsonb)
                  ELSE '{}'::jsonb END
             ORDER BY p.id), '[]'::jsonb) FROM page p),
         CASE WHEN (SELECT count(*) FROM base) > v_limit THEN (SELECT x.id FROM page x ORDER BY x.id DESC LIMIT 1) END
    INTO v_items, v_next;
  RETURN jsonb_build_object('items', v_items, 'next', v_next, 'dataAt', v_at);
END
$$;

-- Окно сверки договора (маршрут 3). p_node — связанный узел или его потомок (раскрытие подпапки); чужой — SG403.
-- → {state, reason, pending, stateVersion, signalLink, dataAt, node:{nodeId, projectId, kind, path, observed, absentNights, modifiedAt}|null,
--    files:[{nodeId, kind, name, version, modifiedAt, itemType, deleted}], more, canEdit, candidates?:[…] (только при правке)}.
-- files — дети узла, виденные в последнем обходе (seen_gen = поколение снимка): пропавшие файлы и папки не показываются,
-- more считается по видимым.
CREATE OR REPLACE FUNCTION osp_private.signal_contract_view(p_contract uuid, p_node uuid DEFAULT NULL, p_limit int DEFAULT 200) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_edit boolean;
  v_limit int := greatest(1, least(coalesce(p_limit, 200), 500));
  v_c public.contracts%ROWTYPE;
  sc osp_private.signal_contracts%ROWTYPE;
  v_rev bigint;
  v_recheck boolean;
  v_linked uuid;
  v_node uuid;
  v_node_json jsonb;
  v_files jsonb;
  v_more boolean := false;
  v_cands jsonb;
  v_gen bigint;
  v_at timestamptz;
BEGIN
  PERFORM osp_private.signal_require('view');
  v_edit := coalesce(public.osp_can('contracts', 'edit'), false);
  IF NOT osp_private.signal_contract_ok(p_contract) THEN
    RAISE EXCEPTION USING ERRCODE = 'SG404', MESSAGE = 'not_found';
  END IF;
  SELECT * INTO v_c FROM public.contracts x WHERE x.id = p_contract;
  SELECT * INTO sc FROM osp_private.signal_contracts x WHERE x.contract_id = p_contract;
  SELECT q.dirty_revision, q.recheck_only INTO v_rev, v_recheck FROM osp_private.signal_queue q WHERE q.contract_id = p_contract;
  SELECT m.generation, m.published_at INTO v_gen, v_at FROM osp_private.signal_meta m WHERE m.id = 1;
  v_linked := sc.node_id;

  IF p_node IS NULL THEN
    v_node := CASE WHEN v_linked IS NOT NULL AND osp_private.signal_node_visible(v_linked, p_contract) THEN v_linked END;
  ELSE
    IF NOT osp_private.signal_node_visible(p_node, p_contract) OR v_linked IS NULL
       OR NOT (p_node = v_linked OR EXISTS (SELECT 1 FROM osp_private.signal_nodes n WHERE n.node_id = p_node AND v_linked = ANY (n.path_ids))) THEN
      RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
    END IF;
    v_node := p_node;
  END IF;

  IF v_node IS NOT NULL THEN
    SELECT jsonb_build_object('nodeId', n.node_id, 'projectId', n.project_id, 'kind', n.kind, 'path', n.path,
                              'observed', n.seen_gen = v_gen, 'absentNights', n.absent_nights, 'modifiedAt', n.modified_at)
      INTO v_node_json FROM osp_private.signal_nodes n WHERE n.node_id = v_node;
    WITH ch AS (
      SELECT n.node_id, n.kind, n.name, n.version_number, n.modified_at, n.item_type, n.deleted
      FROM osp_private.signal_nodes n WHERE n.parent_id = v_node AND n.seen_gen = v_gen
      ORDER BY (n.kind = 'folder') DESC, n.name, n.node_id LIMIT v_limit + 1
    ), shown AS (SELECT * FROM ch ORDER BY (kind = 'folder') DESC, name, node_id LIMIT v_limit)
    SELECT (SELECT coalesce(jsonb_agg(jsonb_build_object('nodeId', x.node_id, 'kind', x.kind, 'name', x.name, 'version', x.version_number,
                                                         'modifiedAt', x.modified_at, 'itemType', x.item_type, 'deleted', x.deleted)
                                      ORDER BY (x.kind = 'folder') DESC, x.name, x.node_id), '[]'::jsonb) FROM shown x),
           (SELECT count(*) FROM ch) > v_limit
      INTO v_files, v_more;
  ELSE
    v_files := '[]'::jsonb;
  END IF;

  IF v_edit THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('nodeId', k.node_id, 'path', n.path, 'score', k.score, 'reasons', to_jsonb(k.reasons),
                                                 'flags', to_jsonb(k.flags), 'status', k.status) ORDER BY k.score DESC, n.path, n.node_id), '[]'::jsonb)
      INTO v_cands
      FROM osp_private.signal_candidates k
      JOIN osp_private.signal_nodes n ON n.node_id = k.node_id
      JOIN osp_private.signal_sources s ON s.id = n.source_id AND s.enabled AND s.ready
     WHERE k.contract_id = p_contract AND k.status = 'open' AND n.object_id IS NOT NULL AND n.object_id = v_c.object_id;
  END IF;

  RETURN jsonb_build_object(
    'state', sc.state, 'reason', sc.reason, 'stateVersion', coalesce(sc.state_version, 0), 'signalLink', v_c.signal_link,
    'pending', v_rev IS NOT NULL AND (sc.contract_id IS NULL OR (NOT v_recheck AND v_rev > sc.processed_revision)),
    'dataAt', v_at, 'node', v_node_json, 'files', v_files, 'more', v_more, 'canEdit', v_edit)
    || CASE WHEN v_edit THEN jsonb_build_object('candidates', v_cands) ELSE '{}'::jsonb END;
END
$$;

-- Поиск папки для ручной привязки (только правка): папки объекта договора, виденные в последнем обходе, корень включён и
-- готов; p_q (≤ 100 знаков) — по name_norm и пути. Страницы по (path, node_id): p_after — «next» прежней страницы.
-- → {items:[{nodeId, path, files}], next}; files — неудалённые файлы папки, виденные в последнем обходе.
CREATE OR REPLACE FUNCTION osp_private.signal_folders_search(p_contract uuid, p_q text, p_after text, p_limit int DEFAULT 50) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_limit int := greatest(1, least(coalesce(p_limit, 50), 100));
  v_q text := btrim(coalesce(p_q, ''));
  v_pat text;
  v_obj uuid;
  v_after_path text;
  v_after_id uuid;
  v_pos int;
  v_items jsonb;
  v_next text;
BEGIN
  PERFORM osp_private.signal_require('edit');
  IF char_length(v_q) > 100 OR char_length(coalesce(p_after, '')) > 8100 THEN
    RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'invalid';
  END IF;
  IF NOT osp_private.signal_contract_ok(p_contract) THEN
    RAISE EXCEPTION USING ERRCODE = 'SG404', MESSAGE = 'not_found';
  END IF;
  SELECT c.object_id INTO v_obj FROM public.contracts c WHERE c.id = p_contract;
  IF v_obj IS NULL THEN
    RETURN jsonb_build_object('items', '[]'::jsonb, 'next', NULL);
  END IF;
  v_pat := '%' || osp_private.signal_like_escape(lower(v_q)) || '%';
  IF coalesce(p_after, '') <> '' THEN
    v_pos := length(p_after) - 36;
    IF v_pos < 1 OR substr(p_after, v_pos, 1) <> chr(31) OR substr(p_after, v_pos + 1) !~ '^[0-9a-f-]{36}$' THEN
      RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'invalid';
    END IF;
    v_after_path := substr(p_after, 1, v_pos - 1);
    v_after_id := substr(p_after, v_pos + 1)::uuid;
  END IF;
  WITH page AS (
    SELECT n.path, n.node_id,
           (SELECT count(*) FROM osp_private.signal_nodes i
             WHERE i.parent_id = n.node_id AND i.kind = 'item' AND NOT i.deleted AND i.seen_gen = m.generation) AS files
    FROM osp_private.signal_nodes n
    JOIN osp_private.signal_sources s ON s.id = n.source_id AND s.enabled AND s.ready
    CROSS JOIN osp_private.signal_meta m
    WHERE n.kind = 'folder' AND n.object_id = v_obj AND n.seen_gen = m.generation
      AND (v_q = '' OR n.name_norm LIKE v_pat ESCAPE '\' OR lower(n.path) LIKE v_pat ESCAPE '\')
      AND (v_after_path IS NULL OR (n.path, n.node_id) > (v_after_path, v_after_id))
    ORDER BY n.path, n.node_id
    LIMIT v_limit + 1
  ), shown AS (SELECT * FROM page ORDER BY path, node_id LIMIT v_limit)
  SELECT (SELECT coalesce(jsonb_agg(jsonb_build_object('nodeId', x.node_id, 'path', x.path, 'files', x.files) ORDER BY x.path, x.node_id), '[]'::jsonb)
            FROM shown x),
         CASE WHEN (SELECT count(*) FROM page) > v_limit
              THEN (SELECT x.path || chr(31) || x.node_id::text FROM shown x ORDER BY x.path DESC, x.node_id DESC LIMIT 1) END
    INTO v_items, v_next;
  RETURN jsonb_build_object('items', v_items, 'next', v_next);
END
$$;

-- ── 8. Решения человека по договору (раздел 4.5) ────────────────────────────────────────────────────
-- Общий порядок: права → вход → идемпотентность (тот же ключ, тот же вошедший, то же действие и тот же узел — прежний ответ,
-- второго события нет; в last_action_result хранятся ещё action и nodeId, наружу они не отдаются; тот же ключ у другого
-- действия или узла повтором не считается — обычный путь, CAS ответит stale_state) →
-- блокировки (contracts → signal_contracts → signal_candidates → signal_queue) → CAS по ссылке и state_version → действие.
-- Любой отказ после начала откатывает всё: частичных записей нет (вызов — одна транзакция db.write).

-- Подтвердить или заменить связь. p_url — адрес папки, собранный сервером из шаблона; p_expected_link / p_expected_version —
-- то, что видело окно (устарело — SG409 stale_state); непустая другая ссылка без p_replace — SG409 replace_required;
-- узел не виден по договору — SG422 node_unavailable / object_unassigned; синоним занят другим объектом — SG409 alias_taken
-- (ссылка и всё остальное откатываются). → {state:'verified', reason:'confirmed', stateVersion, signalLink}.
CREATE OR REPLACE FUNCTION osp_private.signal_confirm(p_contract uuid, p_node uuid, p_url text, p_replace boolean, p_alias_text text,
    p_alias_key text, p_fingerprint text, p_expected_link text, p_expected_version bigint, p_key text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_uid uuid;
  v_c public.contracts%ROWTYPE;
  sc osp_private.signal_contracts%ROWTYPE;
  v_url text := btrim(coalesce(p_url, ''));
  v_old text;
  v_alias text := btrim(coalesce(p_alias_text, ''));
  v_alias_obj uuid;
  v_alias_new boolean := false;
  v_name text;
  v_role text;
  v_rev bigint;
  v_gen bigint;
  v_ver bigint;
  v_res jsonb;
  v_prev_timeout text;
  v_replaced boolean;
BEGIN
  v_uid := osp_private.signal_require('edit');
  IF p_contract IS NULL OR p_node IS NULL OR p_key IS NULL OR btrim(p_key) = '' OR char_length(p_key) > 100
     OR v_url = '' OR char_length(v_url) > 2000 OR p_expected_version IS NULL OR char_length(coalesce(p_expected_link, '')) > 2000
     OR char_length(coalesce(p_fingerprint, '')) > 200
     OR (v_alias <> '' AND (char_length(v_alias) NOT BETWEEN 2 AND 120 OR btrim(coalesce(p_alias_key, '')) = '' OR char_length(p_alias_key) > 200)) THEN
    RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'invalid';
  END IF;
  IF NOT osp_private.signal_contract_ok(p_contract) THEN
    RAISE EXCEPTION USING ERRCODE = 'SG404', MESSAGE = 'not_found';
  END IF;
  SELECT x.last_action_result - 'action' - 'nodeId' INTO v_res FROM osp_private.signal_contracts x
   WHERE x.contract_id = p_contract AND x.last_action_key = p_key AND x.last_action_user = v_uid
     AND x.last_action_result ->> 'action' = 'confirm' AND x.last_action_result ->> 'nodeId' = p_node::text;
  IF v_res IS NOT NULL THEN RETURN v_res; END IF;

  SELECT * INTO v_c FROM public.contracts x WHERE x.id = p_contract AND x.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'SG404', MESSAGE = 'not_found';
  END IF;
  INSERT INTO osp_private.signal_contracts (contract_id, state) VALUES (p_contract, 'none') ON CONFLICT (contract_id) DO NOTHING;
  SELECT * INTO sc FROM osp_private.signal_contracts x WHERE x.contract_id = p_contract FOR UPDATE;
  PERFORM 1 FROM osp_private.signal_candidates k WHERE k.contract_id = p_contract FOR UPDATE;
  PERFORM 1 FROM osp_private.signal_queue q WHERE q.contract_id = p_contract FOR UPDATE;
  IF sc.last_action_key = p_key AND sc.last_action_user = v_uid AND sc.last_action_result ->> 'action' = 'confirm' AND sc.last_action_result ->> 'nodeId' = p_node::text THEN
    RETURN sc.last_action_result - 'action' - 'nodeId';
  END IF;

  IF btrim(coalesce(v_c.signal_link, '')) <> btrim(coalesce(p_expected_link, '')) OR sc.state_version <> p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE = 'SG409', MESSAGE = 'stale_state';
  END IF;

  IF v_c.object_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM osp_private.signal_nodes n
       JOIN osp_private.signal_sources s ON s.id = n.source_id AND s.enabled AND s.ready
       CROSS JOIN osp_private.signal_meta m
       WHERE n.node_id = p_node AND n.kind = 'folder' AND n.seen_gen = m.generation AND n.object_id = v_c.object_id) THEN
    -- Папка корня, объекты которого включают объект договора, но граница не размечена — отдельная причина (подсказка админу).
    IF v_c.object_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM osp_private.signal_nodes n
         JOIN osp_private.signal_sources s ON s.id = n.source_id AND s.enabled AND s.ready
         WHERE n.node_id = p_node AND n.kind = 'folder' AND n.object_id IS NULL
           AND EXISTS (SELECT 1 FROM osp_private.signal_bindings b WHERE b.source_id = s.id AND b.node_id IS NULL AND b.object_id = v_c.object_id)) THEN
      RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'object_unassigned';
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'node_unavailable';
  END IF;

  v_old := btrim(coalesce(v_c.signal_link, ''));
  v_replaced := v_old <> '' AND v_old <> v_url;
  IF v_replaced AND NOT coalesce(p_replace, false) THEN
    RAISE EXCEPTION USING ERRCODE = 'SG409', MESSAGE = 'replace_required';
  END IF;
  IF v_old <> v_url THEN
    UPDATE public.contracts SET signal_link = v_url WHERE id = p_contract;
  END IF;

  IF v_alias <> '' THEN
    SELECT a.object_id INTO v_alias_obj FROM osp_private.signal_aliases a WHERE a.alias_key = p_alias_key;
    IF FOUND THEN
      IF v_alias_obj IS DISTINCT FROM v_c.object_id THEN
        RAISE EXCEPTION USING ERRCODE = 'SG409', MESSAGE = 'alias_taken';
      END IF;
    ELSE
      BEGIN
        INSERT INTO osp_private.signal_aliases (object_id, alias_text, alias_key, created_by)
        VALUES (v_c.object_id, v_alias, p_alias_key, v_uid);
        v_alias_new := true;
      EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION USING ERRCODE = 'SG409', MESSAGE = 'alias_taken';
      END;
    END IF;
  END IF;
  -- Новый синоним — пересчёт договоров этого объекта; если очередь занята, не ждём (следующая публикация поставит всех).
  IF v_alias_new THEN
    v_prev_timeout := current_setting('lock_timeout');
    PERFORM set_config('lock_timeout', '250ms', true);
    BEGIN
      PERFORM osp_private.signal_enqueue_impl(v_c.object_id);
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      RAISE WARNING 'signal_enqueue_skipped %', SQLSTATE;
    END;
    PERFORM set_config('lock_timeout', v_prev_timeout, true);
  END IF;

  -- Очередь этого договора считается обработанной: связь поставил человек (смена ссылки выше ставила новую ревизию).
  DELETE FROM osp_private.signal_queue q WHERE q.contract_id = p_contract RETURNING q.dirty_revision INTO v_rev;
  SELECT m.generation INTO v_gen FROM osp_private.signal_meta m WHERE m.id = 1;
  UPDATE osp_private.signal_contracts x
     SET state = 'verified', reason = 'confirmed', node_id = p_node, confirmed_by = v_uid, confirmed_at = now(),
         state_version = x.state_version + 1, fingerprint = nullif(p_fingerprint, ''), checked_gen = v_gen,
         processed_revision = coalesce(v_rev, x.processed_revision), updated_at = now()
   WHERE x.contract_id = p_contract
   RETURNING x.state_version INTO v_ver;
  DELETE FROM osp_private.signal_candidates k WHERE k.contract_id = p_contract AND k.status = 'open';

  SELECT a.o_name, a.o_role INTO v_name, v_role FROM osp_private.signal_actor() a;
  INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_role, changed_by_name)
  VALUES (p_contract, 'signal_link', 'signal_link',
          CASE WHEN v_old = '' THEN NULL ELSE jsonb_build_object('url', v_old) END, jsonb_build_object('url', v_url),
          CASE WHEN v_replaced THEN 'Signal: ссылка заменена' ELSE 'Signal: связь подтверждена' END, v_role, v_name);

  v_res := jsonb_build_object('state', 'verified', 'reason', 'confirmed', 'stateVersion', v_ver, 'signalLink', v_url);
  UPDATE osp_private.signal_contracts x
     SET last_action_key = p_key, last_action_user = v_uid,
         last_action_result = v_res || jsonb_build_object('action', 'confirm', 'nodeId', p_node)
   WHERE x.contract_id = p_contract;
  RETURN v_res;
END
$$;

-- Отклонить предложенную папку: пара → rejected (ctx_key — контекст договора на момент решения: пока он тот же, пару не
-- предлагают). Больше открытых кандидатов нет и ссылка пуста → none:none; ещё есть — suggested; ссылка непуста — состояние
-- и причина прежние. Событие «Истории» без пути. → {state, reason, stateVersion}.
CREATE OR REPLACE FUNCTION osp_private.signal_reject(p_contract uuid, p_node uuid, p_note text, p_ctx_key text, p_expected_version bigint,
    p_key text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_uid uuid;
  v_c public.contracts%ROWTYPE;
  sc osp_private.signal_contracts%ROWTYPE;
  v_others int;
  v_state text;
  v_reason text;
  v_node uuid;
  v_name text;
  v_role text;
  v_ver bigint;
  v_res jsonb;
BEGIN
  v_uid := osp_private.signal_require('edit');
  IF p_contract IS NULL OR p_node IS NULL OR p_key IS NULL OR btrim(p_key) = '' OR char_length(p_key) > 100
     OR p_expected_version IS NULL OR char_length(coalesce(p_ctx_key, '')) > 200 THEN
    RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'invalid';
  END IF;
  IF NOT osp_private.signal_contract_ok(p_contract) THEN
    RAISE EXCEPTION USING ERRCODE = 'SG404', MESSAGE = 'not_found';
  END IF;
  SELECT x.last_action_result - 'action' - 'nodeId' INTO v_res FROM osp_private.signal_contracts x
   WHERE x.contract_id = p_contract AND x.last_action_key = p_key AND x.last_action_user = v_uid
     AND x.last_action_result ->> 'action' = 'reject' AND x.last_action_result ->> 'nodeId' = p_node::text;
  IF v_res IS NOT NULL THEN RETURN v_res; END IF;

  SELECT * INTO v_c FROM public.contracts x WHERE x.id = p_contract AND x.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'SG404', MESSAGE = 'not_found';
  END IF;
  INSERT INTO osp_private.signal_contracts (contract_id, state) VALUES (p_contract, 'none') ON CONFLICT (contract_id) DO NOTHING;
  SELECT * INTO sc FROM osp_private.signal_contracts x WHERE x.contract_id = p_contract FOR UPDATE;
  PERFORM 1 FROM osp_private.signal_candidates k WHERE k.contract_id = p_contract FOR UPDATE;
  IF sc.last_action_key = p_key AND sc.last_action_user = v_uid AND sc.last_action_result ->> 'action' = 'reject' AND sc.last_action_result ->> 'nodeId' = p_node::text THEN
    RETURN sc.last_action_result - 'action' - 'nodeId';
  END IF;
  IF sc.state_version <> p_expected_version OR NOT EXISTS (
       SELECT 1 FROM osp_private.signal_candidates k WHERE k.contract_id = p_contract AND k.node_id = p_node AND k.status = 'open') THEN
    RAISE EXCEPTION USING ERRCODE = 'SG409', MESSAGE = 'stale_state';
  END IF;

  UPDATE osp_private.signal_candidates k
     SET status = 'rejected', decided_by = v_uid, decided_at = now(), note = nullif(left(btrim(coalesce(p_note, '')), 300), ''),
         ctx_key = p_ctx_key, updated_at = now()
   WHERE k.contract_id = p_contract AND k.node_id = p_node;
  SELECT count(*) INTO v_others FROM osp_private.signal_candidates k WHERE k.contract_id = p_contract AND k.status = 'open';
  IF btrim(coalesce(v_c.signal_link, '')) = '' THEN
    v_state := CASE WHEN v_others = 0 THEN 'none' ELSE 'suggested' END;
    v_reason := CASE WHEN v_others = 0 THEN 'none' END;
    v_node := NULL;
  ELSE
    v_state := sc.state;
    v_reason := sc.reason;
    v_node := sc.node_id;
  END IF;
  UPDATE osp_private.signal_contracts x
     SET state = v_state, reason = v_reason, node_id = v_node, state_version = x.state_version + 1, updated_at = now()
   WHERE x.contract_id = p_contract
   RETURNING x.state_version INTO v_ver;

  SELECT a.o_name, a.o_role INTO v_name, v_role FROM osp_private.signal_actor() a;
  INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, description, changed_by_role, changed_by_name)
  VALUES (p_contract, 'signal_link', NULL, 'Signal: предложенная папка отклонена', v_role, v_name);

  v_res := jsonb_build_object('state', v_state, 'reason', v_reason, 'stateVersion', v_ver);
  UPDATE osp_private.signal_contracts x
     SET last_action_key = p_key, last_action_user = v_uid,
         last_action_result = v_res || jsonb_build_object('action', 'reject', 'nodeId', p_node)
   WHERE x.contract_id = p_contract;
  RETURN v_res;
END
$$;

-- Снять связь: ссылка непуста и совпадает с p_expected_link; связанная папка (node_id состояния) → unlinked с ctx_key;
-- signal_link = NULL; состояние none:unlinked; очередь договора считается обработанной. → {state, reason, stateVersion}.
CREATE OR REPLACE FUNCTION osp_private.signal_unlink(p_contract uuid, p_ctx_key text, p_expected_link text, p_expected_version bigint,
    p_key text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_uid uuid;
  v_c public.contracts%ROWTYPE;
  sc osp_private.signal_contracts%ROWTYPE;
  v_old text;
  v_name text;
  v_role text;
  v_rev bigint;
  v_gen bigint;
  v_ver bigint;
  v_res jsonb;
BEGIN
  v_uid := osp_private.signal_require('edit');
  IF p_contract IS NULL OR p_key IS NULL OR btrim(p_key) = '' OR char_length(p_key) > 100 OR p_expected_version IS NULL
     OR btrim(coalesce(p_expected_link, '')) = '' OR char_length(p_expected_link) > 2000 OR char_length(coalesce(p_ctx_key, '')) > 200 THEN
    RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'invalid';
  END IF;
  IF NOT osp_private.signal_contract_ok(p_contract) THEN
    RAISE EXCEPTION USING ERRCODE = 'SG404', MESSAGE = 'not_found';
  END IF;
  SELECT x.last_action_result - 'action' - 'nodeId' INTO v_res FROM osp_private.signal_contracts x
   WHERE x.contract_id = p_contract AND x.last_action_key = p_key AND x.last_action_user = v_uid
     AND x.last_action_result ->> 'action' = 'unlink';
  IF v_res IS NOT NULL THEN RETURN v_res; END IF;

  SELECT * INTO v_c FROM public.contracts x WHERE x.id = p_contract AND x.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'SG404', MESSAGE = 'not_found';
  END IF;
  INSERT INTO osp_private.signal_contracts (contract_id, state) VALUES (p_contract, 'none') ON CONFLICT (contract_id) DO NOTHING;
  SELECT * INTO sc FROM osp_private.signal_contracts x WHERE x.contract_id = p_contract FOR UPDATE;
  PERFORM 1 FROM osp_private.signal_candidates k WHERE k.contract_id = p_contract FOR UPDATE;
  PERFORM 1 FROM osp_private.signal_queue q WHERE q.contract_id = p_contract FOR UPDATE;
  IF sc.last_action_key = p_key AND sc.last_action_user = v_uid AND sc.last_action_result ->> 'action' = 'unlink' THEN
    RETURN sc.last_action_result - 'action' - 'nodeId';
  END IF;
  v_old := btrim(coalesce(v_c.signal_link, ''));
  IF v_old <> btrim(p_expected_link) OR sc.state_version <> p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE = 'SG409', MESSAGE = 'stale_state';
  END IF;

  IF sc.node_id IS NOT NULL THEN
    INSERT INTO osp_private.signal_candidates AS k (contract_id, node_id, status, ctx_key, decided_by, decided_at)
    VALUES (p_contract, sc.node_id, 'unlinked', p_ctx_key, v_uid, now())
    ON CONFLICT (contract_id, node_id) DO UPDATE
      SET status = 'unlinked', ctx_key = EXCLUDED.ctx_key, decided_by = EXCLUDED.decided_by, decided_at = EXCLUDED.decided_at,
          note = NULL, updated_at = now();
  END IF;
  UPDATE public.contracts SET signal_link = NULL WHERE id = p_contract;

  DELETE FROM osp_private.signal_queue q WHERE q.contract_id = p_contract RETURNING q.dirty_revision INTO v_rev;
  SELECT m.generation INTO v_gen FROM osp_private.signal_meta m WHERE m.id = 1;
  UPDATE osp_private.signal_contracts x
     SET state = 'none', reason = 'unlinked', node_id = NULL, confirmed_by = NULL, confirmed_at = NULL,
         state_version = x.state_version + 1, fingerprint = NULL, checked_gen = v_gen,
         processed_revision = coalesce(v_rev, x.processed_revision), updated_at = now()
   WHERE x.contract_id = p_contract
   RETURNING x.state_version INTO v_ver;

  SELECT a.o_name, a.o_role INTO v_name, v_role FROM osp_private.signal_actor() a;
  INSERT INTO public.contract_audit_log (contract_id, event_type, field_name, old_value, new_value, description, changed_by_role, changed_by_name)
  VALUES (p_contract, 'signal_link', 'signal_link', jsonb_build_object('url', v_old), jsonb_build_object('url', NULL),
          'Signal: связь снята', v_role, v_name);

  v_res := jsonb_build_object('state', 'none', 'reason', 'unlinked', 'stateVersion', v_ver);
  UPDATE osp_private.signal_contracts x
     SET last_action_key = p_key, last_action_user = v_uid,
         last_action_result = v_res || jsonb_build_object('action', 'unlink', 'nodeId', sc.node_id)
   WHERE x.contract_id = p_contract;
  RETURN v_res;
END
$$;

-- ── 9. Синонимы объектов ─────────────────────────────────────────────────────────────────────────────
-- Синоним: другое название объекта в именах папок. p_key — нормализованный ключ синонима (считает сервер тем же кодом, что и
-- сопоставитель). Ключ уже занят — SG409 alias_taken. Правит сопоставление всем договорам: пересчёт очереди.
CREATE OR REPLACE FUNCTION osp_private.signal_alias_create(p_object uuid, p_text text, p_key text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_uid uuid;
  v_text text := btrim(coalesce(p_text, ''));
  v_scope uuid[];
  v_id bigint;
BEGIN
  v_uid := osp_private.signal_require('edit');
  IF p_object IS NULL OR char_length(v_text) NOT BETWEEN 2 AND 120 OR btrim(coalesce(p_key, '')) = '' OR char_length(p_key) > 200 THEN
    RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'invalid';
  END IF;
  v_scope := public.osp_object_scope();
  IF v_scope IS NOT NULL AND NOT (p_object = ANY (v_scope)) THEN
    RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.objects o WHERE o.id = p_object) THEN
    RAISE EXCEPTION USING ERRCODE = 'SG404', MESSAGE = 'not_found';
  END IF;
  BEGIN
    INSERT INTO osp_private.signal_aliases (object_id, alias_text, alias_key, created_by) VALUES (p_object, v_text, p_key, v_uid)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'SG409', MESSAGE = 'alias_taken';
  END;
  PERFORM osp_private.signal_enqueue_impl(NULL);
  RETURN jsonb_build_object('id', v_id);
END
$$;

-- Удалить синоним: администратор, либо автор — пока у него есть право правки раздела и объект синонима в его охвате (W1-09).
CREATE OR REPLACE FUNCTION osp_private.signal_alias_delete(p_id bigint) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_admin boolean;
  a osp_private.signal_aliases%ROWTYPE;
  v_scope uuid[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
  END IF;
  v_admin := coalesce(public.is_admin(), false);
  IF NOT v_admin AND NOT coalesce(public.osp_can('contracts', 'edit'), false) THEN
    RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
  END IF;
  SELECT * INTO a FROM osp_private.signal_aliases x WHERE x.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'SG404', MESSAGE = 'not_found';
  END IF;
  IF NOT v_admin THEN
    v_scope := public.osp_object_scope();
    IF a.created_by IS DISTINCT FROM v_uid OR (v_scope IS NOT NULL AND NOT (a.object_id = ANY (v_scope))) THEN
      RAISE EXCEPTION USING ERRCODE = 'SG403', MESSAGE = 'forbidden';
    END IF;
  END IF;
  DELETE FROM osp_private.signal_aliases WHERE id = p_id;
  PERFORM osp_private.signal_enqueue_impl(NULL);
  RETURN jsonb_build_object('ok', true);
END
$$;

-- Список синонимов (админ): {items:[{id, text, objectId, objectName, author, createdAt}]}.
CREATE OR REPLACE FUNCTION osp_private.signal_alias_list() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  PERFORM osp_private.signal_require('admin');
  RETURN jsonb_build_object('items', coalesce((
    SELECT jsonb_agg(jsonb_build_object('id', a.id, 'text', a.alias_text, 'objectId', a.object_id, 'objectName', o.name,
             'author', (SELECT coalesce(nullif(btrim(ur.full_name), ''), nullif(btrim(ur.email), '')) FROM public.user_roles ur
                         WHERE ur.user_id = a.created_by LIMIT 1),
             'createdAt', a.created_at) ORDER BY o.name, a.alias_text, a.id)
    FROM osp_private.signal_aliases a JOIN public.objects o ON o.id = a.object_id), '[]'::jsonb));
END
$$;

-- ── 10. Администратор: корни, прогоны, границы ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION osp_private.signal_run_json(p_run osp_private.signal_runs) RETURNS jsonb
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object('id', p_run.id, 'kind', p_run.kind, 'mode', p_run.mode, 'status', p_run.status, 'reason', p_run.reason,
                            'initiator', p_run.initiator, 'startedAt', p_run.started_at, 'finishedAt', p_run.finished_at,
                            'generation', p_run.generation, 'stats', p_run.stats, 'acceptedBy', p_run.accepted_by)
$$;

-- Состояние для экрана администратора: {meta:{generation, publishedAt, schemaVersion}, sources:[…], lastRuns:[5 последних]}.
CREATE OR REPLACE FUNCTION osp_private.signal_admin_state() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  PERFORM osp_private.signal_require('admin');
  RETURN jsonb_build_object(
    'meta', (SELECT jsonb_build_object('generation', m.generation, 'publishedAt', m.published_at, 'schemaVersion', m.schema_version)
               FROM osp_private.signal_meta m WHERE m.id = 1),
    'sources', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', s.id, 'projectId', s.project_id, 'folderId', s.folder_id, 'projectName', s.project_name, 'rootPath', s.root_path,
        'enabled', s.enabled, 'ready', s.ready,
        'objects', coalesce((SELECT jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name) ORDER BY o.name, o.id)
                               FROM osp_private.signal_bindings b JOIN public.objects o ON o.id = b.object_id
                              WHERE b.source_id = s.id AND b.node_id IS NULL), '[]'::jsonb),
        'lastOkAt', s.last_ok_at, 'lastFullOkAt', s.last_full_ok_at, 'lastNightOkAt', s.last_night_ok_at, 'lastError', s.last_error,
        'folders', s.folders_count, 'items', s.items_count) ORDER BY s.id)
        FROM osp_private.signal_sources s), '[]'::jsonb),
    'lastRuns', coalesce((SELECT jsonb_agg(osp_private.signal_run_json(t.r) ORDER BY (t.r).id DESC)
                            FROM (SELECT r FROM osp_private.signal_runs r ORDER BY r.id DESC LIMIT 5) t), '[]'::jsonb));
END
$$;

-- Последние прогоны (админ), не больше 20: {items:[{id, kind, mode, status, reason, initiator, startedAt, finishedAt, generation, stats, acceptedBy}]}.
CREATE OR REPLACE FUNCTION osp_private.signal_runs(p_limit int DEFAULT 20) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  PERFORM osp_private.signal_require('admin');
  RETURN jsonb_build_object('items', coalesce((
    SELECT jsonb_agg(osp_private.signal_run_json(t.r) ORDER BY (t.r).id DESC)
    FROM (SELECT r FROM osp_private.signal_runs r ORDER BY r.id DESC LIMIT greatest(1, least(coalesce(p_limit, 20), 20))) t), '[]'::jsonb));
END
$$;

-- Новый корень обхода (админ): проект, папка, имя проекта и путь корня (проверила маршрут по дереву SIGNAL), объекты корня (≤ 20).
-- Корень уже есть — SG409 busy; объекта нет — SG422 invalid. Корень включён, не готов — до первой публикации. → {id, projectName, rootPath}.
CREATE OR REPLACE FUNCTION osp_private.signal_source_add(p_project uuid, p_folder uuid, p_project_name text, p_root_path text,
    p_object_ids uuid[]) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_uid uuid;
  v_objs uuid[];
  v_id bigint;
  v_pname text := left(btrim(coalesce(p_project_name, '')), 500);
  v_path text := left(btrim(coalesce(p_root_path, '')), 2000);
BEGIN
  v_uid := osp_private.signal_require('admin');
  IF p_project IS NULL OR p_folder IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'invalid';
  END IF;
  SELECT coalesce(array_agg(DISTINCT o), '{}'::uuid[]) INTO v_objs FROM unnest(coalesce(p_object_ids, '{}'::uuid[])) o WHERE o IS NOT NULL;
  IF cardinality(v_objs) > 20 OR (SELECT count(*) FROM public.objects x WHERE x.id = ANY (v_objs)) <> cardinality(v_objs) THEN
    RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'invalid';
  END IF;
  BEGIN
    INSERT INTO osp_private.signal_sources (project_id, folder_id, project_name, root_path, created_by)
    VALUES (p_project, p_folder, nullif(v_pname, ''), nullif(v_path, ''), v_uid)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'SG409', MESSAGE = 'busy';
  END;
  INSERT INTO osp_private.signal_bindings (source_id, node_id, object_id, created_by)
  SELECT v_id, NULL, o, v_uid FROM unnest(v_objs) o ORDER BY o;
  RETURN jsonb_build_object('id', v_id, 'projectName', nullif(v_pname, ''), 'rootPath', nullif(v_path, ''));
END
$$;

-- Включить / выключить корень и сменить его объекты (админ). Выключение → ready = false (включение готовность не возвращает —
-- её вернёт следующая публикация). Смена объектов: привязки поддеревьев на убранные объекты удаляются, граница пересчитывается.
-- Любое изменение — пересчёт очереди. Публикация и эти правки идут по одной блокировке signal_meta.
CREATE OR REPLACE FUNCTION osp_private.signal_source_update(p_id bigint, p_enabled boolean DEFAULT NULL, p_object_ids uuid[] DEFAULT NULL) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_uid uuid;
  s osp_private.signal_sources%ROWTYPE;
  v_objs uuid[];
  v_changed boolean := false;
  v_n int;
BEGIN
  v_uid := osp_private.signal_require('admin');
  PERFORM 1 FROM osp_private.signal_meta m WHERE m.id = 1 FOR UPDATE;
  SELECT * INTO s FROM osp_private.signal_sources x WHERE x.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'SG404', MESSAGE = 'not_found';
  END IF;
  IF p_enabled IS NOT NULL AND p_enabled IS DISTINCT FROM s.enabled THEN
    UPDATE osp_private.signal_sources x SET enabled = p_enabled, ready = CASE WHEN p_enabled THEN x.ready ELSE false END,
           updated_at = now() WHERE x.id = p_id;
    v_changed := true;
  END IF;
  IF p_object_ids IS NOT NULL THEN
    SELECT coalesce(array_agg(DISTINCT o), '{}'::uuid[]) INTO v_objs FROM unnest(p_object_ids) o WHERE o IS NOT NULL;
    IF cardinality(v_objs) > 20 OR (SELECT count(*) FROM public.objects x WHERE x.id = ANY (v_objs)) <> cardinality(v_objs) THEN
      RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'invalid';
    END IF;
    DELETE FROM osp_private.signal_bindings b WHERE b.source_id = p_id AND b.node_id IS NULL AND NOT (b.object_id = ANY (v_objs));
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_changed := v_changed OR v_n > 0;
    DELETE FROM osp_private.signal_bindings b WHERE b.source_id = p_id AND b.node_id IS NOT NULL AND NOT (b.object_id = ANY (v_objs));
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_changed := v_changed OR v_n > 0;
    INSERT INTO osp_private.signal_bindings (source_id, node_id, object_id, created_by)
    SELECT p_id, NULL, o, v_uid FROM unnest(v_objs) o ORDER BY o
    ON CONFLICT ON CONSTRAINT signal_bindings_uniq DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_changed := v_changed OR v_n > 0;
    PERFORM osp_private.signal_recompute_objects(p_id);
  END IF;
  IF v_changed THEN
    PERFORM osp_private.signal_enqueue_impl(NULL);
  END IF;
  RETURN jsonb_build_object('ok', true, 'changed', v_changed);
END
$$;

-- Привязать поддерево папки к объекту корня (p_object) или снять привязку (p_object = NULL). Папка — из опубликованного снимка
-- этого корня; объект должен входить в объекты корня (SG422 invalid). Граница пересчитывается, договорам — новая ревизия.
CREATE OR REPLACE FUNCTION osp_private.signal_binding_set(p_source bigint, p_node uuid, p_object uuid DEFAULT NULL) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_uid uuid;
BEGIN
  v_uid := osp_private.signal_require('admin');
  IF p_source IS NULL OR p_node IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'invalid';
  END IF;
  PERFORM 1 FROM osp_private.signal_meta m WHERE m.id = 1 FOR UPDATE;
  PERFORM 1 FROM osp_private.signal_sources x WHERE x.id = p_source FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'SG404', MESSAGE = 'not_found';
  END IF;
  IF p_object IS NULL THEN
    DELETE FROM osp_private.signal_bindings b WHERE b.source_id = p_source AND b.node_id = p_node;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM osp_private.signal_nodes n WHERE n.node_id = p_node AND n.source_id = p_source AND n.kind = 'folder')
       OR NOT EXISTS (SELECT 1 FROM osp_private.signal_bindings b WHERE b.source_id = p_source AND b.node_id IS NULL AND b.object_id = p_object) THEN
      RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'invalid';
    END IF;
    INSERT INTO osp_private.signal_bindings (source_id, node_id, object_id, created_by) VALUES (p_source, p_node, p_object, v_uid)
    ON CONFLICT (source_id, node_id) WHERE node_id IS NOT NULL
    DO UPDATE SET object_id = EXCLUDED.object_id, created_by = EXCLUDED.created_by, created_at = now();
  END IF;
  PERFORM osp_private.signal_recompute_objects(p_source);
  PERFORM osp_private.signal_enqueue_impl(NULL);
  RETURN jsonb_build_object('ok', true);
END
$$;

-- Верхние неразмеченные папки корня с несколькими объектами (админ): подпапки корня без объекта и папки без объекта под
-- размеченной. Элемент: {nodeId, path, items}; items — число файлов внутри поддерева. Страницы по (path, node_id), p_after — «next».
-- Только узлы, виденные в последнем обходе (seen_gen = поколению): исчезнувшие папки и их файлы не показываются и не считаются.
CREATE OR REPLACE FUNCTION osp_private.signal_unassigned(p_source bigint, p_after text DEFAULT NULL, p_limit int DEFAULT 50) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = osp_private, public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_limit int := greatest(1, least(coalesce(p_limit, 50), 100));
  v_root uuid;
  v_after_path text;
  v_after_id uuid;
  v_pos int;
  v_items jsonb;
  v_next text;
BEGIN
  PERFORM osp_private.signal_require('admin');
  SELECT s.folder_id INTO v_root FROM osp_private.signal_sources s WHERE s.id = p_source;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'SG404', MESSAGE = 'not_found';
  END IF;
  IF coalesce(p_after, '') <> '' THEN
    v_pos := length(p_after) - 36;
    IF char_length(p_after) > 8100 OR v_pos < 1 OR substr(p_after, v_pos, 1) <> chr(31) OR substr(p_after, v_pos + 1) !~ '^[0-9a-f-]{36}$' THEN
      RAISE EXCEPTION USING ERRCODE = 'SG422', MESSAGE = 'invalid';
    END IF;
    v_after_path := substr(p_after, 1, v_pos - 1);
    v_after_id := substr(p_after, v_pos + 1)::uuid;
  END IF;
  WITH page AS (
    SELECT n.node_id, n.path,
           (SELECT count(*) FROM osp_private.signal_nodes i
             WHERE i.source_id = p_source AND i.kind = 'item' AND NOT i.deleted AND i.seen_gen = m.generation
               AND i.path_ids @> ARRAY[n.node_id]) AS items
    FROM osp_private.signal_nodes n
    LEFT JOIN osp_private.signal_nodes p ON p.node_id = n.parent_id
    CROSS JOIN osp_private.signal_meta m
    WHERE n.source_id = p_source AND n.kind = 'folder' AND n.object_id IS NULL AND n.node_id <> v_root AND n.seen_gen = m.generation
      AND (n.parent_id = v_root OR p.object_id IS NOT NULL)
      AND (v_after_path IS NULL OR (n.path, n.node_id) > (v_after_path, v_after_id))
    ORDER BY n.path, n.node_id
    LIMIT v_limit + 1
  ), shown AS (SELECT * FROM page ORDER BY path, node_id LIMIT v_limit)
  SELECT (SELECT coalesce(jsonb_agg(jsonb_build_object('nodeId', x.node_id, 'path', x.path, 'items', x.items) ORDER BY x.path, x.node_id), '[]'::jsonb)
            FROM shown x),
         CASE WHEN (SELECT count(*) FROM page) > v_limit
              THEN (SELECT x.path || chr(31) || x.node_id::text FROM shown x ORDER BY x.path DESC, x.node_id DESC LIMIT 1) END
    INTO v_items, v_next;
  RETURN jsonb_build_object('items', v_items, 'next', v_next);
END
$$;
