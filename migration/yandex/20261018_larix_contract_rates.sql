-- Договорные расценки из Larix.CPM — четвёртая вкладка реестра расценок. Тело
-- supabase/migrations/20261018_larix_contract_rates.sql: те же таблицы, индексы и функции загрузки (тексты
-- функций совпадают — проверяет tests/osp-api/larix-sync.test.mjs), иначе — только права под одну учётку:
--  • правила по строкам включены и действуют на владельца, у каждой таблицы пропуск служебных операций;
--  • реестр и журнал читает вошедший с правом раздела «Реестр расценок» (osp_can), порции — никто;
--  • функции загрузки — не служебные (не SECURITY DEFINER) и в список шлюза не входят: их вызывает только
--    osp-api служебной операцией (отметка osp:internal), браузеру они недоступны.
-- Повтор безопасен; годится и для базы, куда эти таблицы уже пришли с копией прода.
CREATE TABLE IF NOT EXISTS public.larix_sync_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_by text NOT NULL DEFAULT 'schedule' CHECK (started_by IN ('schedule', 'cli')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'held', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  positions_count integer,
  rows_count integer,
  skipped_count integer,
  larix_contracts integer,
  matched_contracts integer,
  error_code text CHECK (error_code IN ('login', 'http', 'timeout', 'too_large', 'invalid', 'db', 'stale', 'empty', 'shrink')),
  error_text text CHECK (char_length(error_text) <= 300),
  response_keys text[] CHECK (cardinality(response_keys) <= 200),
  filters jsonb
);
-- Одна загрузка одновременно: вторая получает «занято» (unique_violation в larix_sync_begin).
CREATE UNIQUE INDEX IF NOT EXISTS larix_sync_runs_one_running ON public.larix_sync_runs ((true)) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS larix_sync_runs_started_idx ON public.larix_sync_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS public.larix_sync_stage (
  run_id bigint NOT NULL REFERENCES public.larix_sync_runs(id) ON DELETE CASCADE,
  chunk_no integer NOT NULL CHECK (chunk_no >= 0),
  rows jsonb NOT NULL CHECK (jsonb_typeof(rows) = 'array'),
  PRIMARY KEY (run_id, chunk_no)
);

CREATE TABLE IF NOT EXISTS public.larix_contract_rates (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL,
  item_type text NOT NULL CHECK (item_type IN ('material', 'work')),
  item_name text NOT NULL,
  unit text,
  price numeric NOT NULL CHECK (price > 0),
  price_material numeric,
  price_work numeric,
  vat_rate numeric,
  materials_used text,
  comment text,
  project_id bigint,
  project_name text,
  contractor_id bigint,
  contractor_name text,
  contract_id bigint,
  contract_number text,
  contract_date date,
  contract_state text,
  object_type text,
  osp_contract_id uuid
);
CREATE INDEX IF NOT EXISTS larix_contract_rates_name_idx ON public.larix_contract_rates (item_type, item_name, id);
CREATE INDEX IF NOT EXISTS larix_contract_rates_price_idx ON public.larix_contract_rates (item_type, price, id);
CREATE INDEX IF NOT EXISTS larix_contract_rates_date_idx ON public.larix_contract_rates (item_type, contract_date, id);
CREATE INDEX IF NOT EXISTS larix_contract_rates_name_trgm ON public.larix_contract_rates USING gin (item_name gin_trgm_ops);

COMMENT ON TABLE public.larix_contract_rates IS 'Договорные расценки из Larix.CPM (ВОР по договорам) — строки реестра; пишет только загрузка osp-api';
COMMENT ON COLUMN public.larix_contract_rates.contract_date IS 'Дата договора по Москве (Larix отдаёт полночь Москвы в UTC)';
COMMENT ON COLUMN public.larix_contract_rates.osp_contract_id IS 'Наш договор: единственный contracts.document_link вида …/contract/<contract_id>';
COMMENT ON TABLE public.larix_sync_runs IS 'Журнал загрузок из Larix.CPM: статус, счётчики, причина отказа, списки для фильтров вкладки';
COMMENT ON TABLE public.larix_sync_stage IS 'Порции текущей загрузки из Larix.CPM; после замены удаляются';

-- ── Шаги загрузки ────────────────────────────────────────────────────────────────────────────────────

-- Начать загрузку. По расписанию — не раньше 05:00 по Москве, один успешный (или отложенный) прогон в
-- день, повтор после сбоя — через 30 минут, не больше 6 попыток за день. Ручной запуск (cli) сроков не
-- ждёт. Идёт другая загрузка или ещё рано — null.
CREATE OR REPLACE FUNCTION public.larix_sync_begin(p_started_by text DEFAULT 'schedule')
  RETURNS bigint
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_day timestamptz := (date_trunc('day', now() AT TIME ZONE 'Europe/Moscow') + interval '5 hours') AT TIME ZONE 'Europe/Moscow';
  v_id bigint;
BEGIN
  IF p_started_by IS NULL OR p_started_by NOT IN ('schedule', 'cli') THEN
    RAISE EXCEPTION 'larix: неизвестный вид запуска %', p_started_by USING ERRCODE = '22023';
  END IF;
  UPDATE public.larix_sync_runs
     SET status = 'failed', finished_at = now(), error_code = 'stale', error_text = 'Загрузка не завершилась за 30 минут'
   WHERE status = 'running' AND started_at < now() - interval '30 minutes';
  DELETE FROM public.larix_sync_stage s
   WHERE NOT EXISTS (SELECT 1 FROM public.larix_sync_runs r WHERE r.id = s.run_id AND r.status = 'running');
  IF p_started_by = 'schedule' AND (
       now() < v_day
    OR EXISTS (SELECT 1 FROM public.larix_sync_runs WHERE status IN ('ok', 'held') AND started_at >= v_day)
    OR EXISTS (SELECT 1 FROM public.larix_sync_runs WHERE started_at > now() - interval '30 minutes')
    OR (SELECT count(*) FROM public.larix_sync_runs WHERE started_at >= v_day) >= 6) THEN
    RETURN NULL;
  END IF;
  BEGIN
    INSERT INTO public.larix_sync_runs (started_by) VALUES (p_started_by) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN NULL;
  END;
  RETURN v_id;
END
$$;

-- Порция позиций (массив объектов, как отдал Larix после проверки загрузчиком). Повтор той же порции
-- ничего не меняет.
CREATE OR REPLACE FUNCTION public.larix_sync_add_rows(p_run bigint, p_chunk integer, p_rows jsonb)
  RETURNS integer
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) > 5000 THEN
    RAISE EXCEPTION 'larix: порция — массив не длиннее 5000 позиций' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.larix_sync_runs WHERE id = p_run AND status = 'running') THEN
    RAISE EXCEPTION 'larix: загрузка % не выполняется', p_run USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.larix_sync_stage (run_id, chunk_no, rows) VALUES (p_run, p_chunk, p_rows)
  ON CONFLICT (run_id, chunk_no) DO NOTHING;
  RETURN jsonb_array_length(p_rows);
END
$$;

-- Замена расценок одной транзакцией. Порций ровно столько, сколько отправлено; пустой ответ при непустых
-- данных или падение ниже 30 % прежнего числа позиций — held, расценки не трогаем (p_force — принять).
-- statement_timeout на функции действует при вызове через PostgREST (у service_role там 8 с); при прямом
-- подключении предел задаёт вызывающий.
CREATE OR REPLACE FUNCTION public.larix_sync_finish(p_run bigint, p_expected integer, p_skipped integer DEFAULT 0,
    p_keys text[] DEFAULT NULL, p_force boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  SET statement_timeout = '120s'
AS $$
DECLARE
  v_status text;
  v_staged integer;
  v_prev integer;
  v_held text;
  v_rows integer;
  v_contracts integer;
  v_matched integer;
  v_filters jsonb;
BEGIN
  SELECT status INTO v_status FROM public.larix_sync_runs WHERE id = p_run FOR UPDATE;
  IF v_status IS DISTINCT FROM 'running' THEN
    RAISE EXCEPTION 'larix: загрузка % не выполняется', p_run USING ERRCODE = '55000';
  END IF;
  SELECT coalesce(sum(jsonb_array_length(s.rows)), 0)::integer INTO v_staged
    FROM public.larix_sync_stage s WHERE s.run_id = p_run;
  IF v_staged IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'larix: в порциях % позиций, отправлено %', v_staged, p_expected USING ERRCODE = '22023';
  END IF;

  SELECT r.positions_count INTO v_prev FROM public.larix_sync_runs r
   WHERE r.status = 'ok' ORDER BY r.finished_at DESC NULLS LAST, r.id DESC LIMIT 1;
  IF NOT coalesce(p_force, false) THEN
    IF v_staged = 0 AND coalesce(v_prev, 0) > 0 THEN
      v_held := 'empty';
    ELSIF coalesce(v_prev, 0) >= 50 AND v_staged < v_prev * 0.3 THEN
      v_held := 'shrink';
    END IF;
  END IF;
  IF v_held IS NOT NULL THEN
    UPDATE public.larix_sync_runs
       SET status = 'held', finished_at = now(), error_code = v_held,
           error_text = CASE v_held
             WHEN 'empty' THEN 'Larix вернул пустой список — оставлены расценки прежней загрузки'
             ELSE format('Позиций стало %s вместо %s — оставлены расценки прежней загрузки', v_staged, v_prev) END,
           positions_count = v_staged, skipped_count = p_skipped, response_keys = p_keys
     WHERE id = p_run;
    DELETE FROM public.larix_sync_stage WHERE run_id = p_run;
    RETURN jsonb_build_object('status', 'held', 'reason', v_held, 'positions', v_staged, 'previous', v_prev);
  END IF;

  -- WHERE true: на Supabase у PostgREST включён safeupdate — DELETE без условия он отклоняет.
  DELETE FROM public.larix_contract_rates WHERE true;
  WITH src AS (
    SELECT s.chunk_no, e.ord, e.r
    FROM public.larix_sync_stage s
    CROSS JOIN LATERAL jsonb_array_elements(s.rows) WITH ORDINALITY AS e(r, ord)
    WHERE s.run_id = p_run
  ), links AS (
    -- Наш договор — по ссылке «Путь к Larix.CPM» (contracts.document_link); только однозначное совпадение.
    SELECT x.larix_id, min(x.id::text)::uuid AS osp_id, count(*) AS n
    FROM (SELECT c.id,
                 (regexp_match(c.document_link, '^\s*https?://cpm\.su10\.larix\.ru/contract/(\d{1,15})/?([?#].*)?\s*$', 'i'))[1]::bigint AS larix_id
          FROM public.contracts c
          WHERE c.deleted_at IS NULL AND c.document_link IS NOT NULL) x
    WHERE x.larix_id IS NOT NULL
    GROUP BY x.larix_id
  ), pos AS (
    SELECT src.chunk_no, src.ord,
      left(nullif(btrim(src.r->>'work_title'), ''), 2000) AS item_name,
      left(nullif(btrim(src.r->>'measure_title'), ''), 100) AS unit,
      CASE WHEN jsonb_typeof(src.r->'price_material') = 'number' THEN (src.r->>'price_material')::numeric END AS pm,
      CASE WHEN jsonb_typeof(src.r->'price_work') = 'number' THEN (src.r->>'price_work')::numeric END AS pw,
      CASE WHEN jsonb_typeof(src.r->'vat_rate') = 'number' THEN (src.r->>'vat_rate')::numeric END AS vat_rate,
      left(nullif(btrim(src.r->>'materials_used'), ''), 2000) AS materials_used,
      left(nullif(btrim(src.r->>'comment'), ''), 2000) AS comment,
      CASE WHEN jsonb_typeof(src.r->'project_id') = 'number' THEN (src.r->>'project_id')::bigint END AS project_id,
      left(nullif(btrim(src.r->>'project_name'), ''), 500) AS project_name,
      CASE WHEN jsonb_typeof(src.r->'contractor_id') = 'number' THEN (src.r->>'contractor_id')::bigint END AS contractor_id,
      left(nullif(btrim(src.r->>'contractor_short_name'), ''), 500) AS contractor_name,
      CASE WHEN jsonb_typeof(src.r->'contract_id') = 'number' THEN (src.r->>'contract_id')::bigint END AS contract_id,
      left(nullif(btrim(src.r->>'contract_number'), ''), 200) AS contract_number,
      -- Larix отдаёт полночь по Москве в UTC (…T21:00:00+00:00) — дата договора считается по Москве.
      CASE WHEN src.r->>'contract_date' ~ '^\d{4}-\d{2}-\d{2}$' THEN (src.r->>'contract_date')::date
           WHEN src.r->>'contract_date' ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}'
             THEN ((src.r->>'contract_date')::timestamptz AT TIME ZONE 'Europe/Moscow')::date END AS contract_date,
      left(nullif(btrim(src.r->>'contract_state'), ''), 100) AS contract_state,
      left(nullif(btrim(src.r->>'object_type'), ''), 100) AS object_type
    FROM src
  )
  INSERT INTO public.larix_contract_rates (run_id, item_type, item_name, unit, price, price_material, price_work, vat_rate,
    materials_used, comment, project_id, project_name, contractor_id, contractor_name, contract_id, contract_number,
    contract_date, contract_state, object_type, osp_contract_id)
  SELECT p_run, v.item_type, pos.item_name, pos.unit, v.price, pos.pm, pos.pw, pos.vat_rate,
    pos.materials_used, pos.comment, pos.project_id, pos.project_name, pos.contractor_id, pos.contractor_name,
    pos.contract_id, pos.contract_number, pos.contract_date, pos.contract_state, pos.object_type,
    CASE WHEN l.n = 1 THEN l.osp_id END
  FROM pos
  CROSS JOIN LATERAL (VALUES ('material', 1, pos.pm), ('work', 2, pos.pw)) AS v(item_type, k, price)
  LEFT JOIN links l ON l.larix_id = pos.contract_id
  WHERE pos.item_name IS NOT NULL AND v.price > 0
  ORDER BY pos.chunk_no, pos.ord, v.k;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  SELECT count(DISTINCT contract_id)::integer, (count(DISTINCT contract_id) FILTER (WHERE osp_contract_id IS NOT NULL))::integer
    INTO v_contracts, v_matched
    FROM public.larix_contract_rates;
  -- Списки для фильтров вкладки: читаются один раз вместе со статусом загрузки.
  SELECT jsonb_build_object(
    'projects', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.project_id, 'name', p.project_name) ORDER BY p.project_name, p.project_id)
       FROM (SELECT DISTINCT ON (project_id) project_id, project_name FROM public.larix_contract_rates
             WHERE project_id IS NOT NULL ORDER BY project_id, id) p), '[]'::jsonb),
    'contractors', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.contractor_id, 'name', p.contractor_name) ORDER BY p.contractor_name, p.contractor_id)
       FROM (SELECT DISTINCT ON (contractor_id) contractor_id, contractor_name FROM public.larix_contract_rates
             WHERE contractor_id IS NOT NULL ORDER BY contractor_id, id) p), '[]'::jsonb),
    'contracts', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.contract_id, 'number', p.contract_number, 'date', p.contract_date) ORDER BY p.contract_number, p.contract_id)
       FROM (SELECT DISTINCT ON (contract_id) contract_id, contract_number, contract_date FROM public.larix_contract_rates
             WHERE contract_id IS NOT NULL ORDER BY contract_id, id) p), '[]'::jsonb),
    'states', coalesce((SELECT jsonb_agg(p.contract_state ORDER BY p.contract_state)
       FROM (SELECT DISTINCT contract_state FROM public.larix_contract_rates WHERE contract_state IS NOT NULL) p), '[]'::jsonb)
  ) INTO v_filters;

  UPDATE public.larix_sync_runs
     SET status = 'ok', finished_at = now(), error_code = NULL, error_text = NULL,
         positions_count = v_staged, rows_count = v_rows, skipped_count = p_skipped,
         larix_contracts = v_contracts, matched_contracts = v_matched, response_keys = p_keys, filters = v_filters
   WHERE id = p_run;
  DELETE FROM public.larix_sync_stage WHERE run_id = p_run;
  DELETE FROM public.larix_sync_runs WHERE started_at < now() - interval '90 days' AND id <> p_run;
  RETURN jsonb_build_object('status', 'ok', 'positions', v_staged, 'rows', v_rows, 'contracts', v_contracts, 'matched', v_matched);
END
$$;

-- Загрузка не удалась: причина — из фиксированного набора, текст — без логина, пароля и токена (их
-- загрузчик в текст не кладёт), не длиннее 300 символов.
CREATE OR REPLACE FUNCTION public.larix_sync_fail(p_run bigint, p_code text, p_text text DEFAULT NULL)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.larix_sync_runs
     SET status = 'failed', finished_at = now(),
         error_code = CASE WHEN p_code IN ('login', 'http', 'timeout', 'too_large', 'invalid', 'db') THEN p_code ELSE 'db' END,
         error_text = left(p_text, 300)
   WHERE id = p_run AND status = 'running';
  DELETE FROM public.larix_sync_stage WHERE run_id = p_run;
END
$$;

-- ── Права под одну учётку ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.larix_contract_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.larix_contract_rates FORCE ROW LEVEL SECURITY;
ALTER TABLE public.larix_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.larix_sync_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.larix_sync_stage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.larix_sync_stage FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS osp_internal ON public.larix_contract_rates;
CREATE POLICY osp_internal ON public.larix_contract_rates FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));
DROP POLICY IF EXISTS osp_internal ON public.larix_sync_runs;
CREATE POLICY osp_internal ON public.larix_sync_runs FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));
DROP POLICY IF EXISTS osp_internal ON public.larix_sync_stage;
CREATE POLICY osp_internal ON public.larix_sync_stage FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

-- Пропуск → да; иначе роль из токена и право раздела (как TO authenticated USING (osp_can(…)) на проде).
DROP POLICY IF EXISTS larix_contract_rates_read ON public.larix_contract_rates;
CREATE POLICY larix_contract_rates_read ON public.larix_contract_rates FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_can('rates_registry', 'view'))) END);
DROP POLICY IF EXISTS larix_sync_runs_read ON public.larix_sync_runs;
CREATE POLICY larix_sync_runs_read ON public.larix_sync_runs FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_can('rates_registry', 'view'))) END);
INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'larix_contract_rates', 'larix_contract_rates_read', ARRAY['authenticated']),
  ('public', 'larix_sync_runs', 'larix_sync_runs_read', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;
-- osp:allow table larix_contract_rates authenticated=select
-- osp:allow table larix_sync_runs authenticated=select
