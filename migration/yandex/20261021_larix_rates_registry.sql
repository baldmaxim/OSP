-- Договорные расценки Larix (вкладка реестра расценок), правки 16.10 после первой загрузки (72 199 позиций):
--  • строка — позиция договора с ОБЕИМИ ценами (материалов и работ), а не две строки «материал» и «работа»:
--    в отдельной строке была видна только одна цена;
--  • повторы схлопываются: та же позиция в том же договоре (наименование и единица — без учёта регистра и
--    лишних пробелов) с теми же ценами — одна строка, число повторов — в repeats;
--  • поиск — по индексу. Таблица с правилами по строкам (larix_contract_rates) поиск подстрокой (ILIKE) по
--    индексу не пускает: оператор не «герметичный» (не leakproof), и PostgreSQL вычисляет его только после
--    правила — полным перебором. Поэтому строки — в закрытой схеме (osp_private.larix_rates, без правил;
--    PostgREST видит только public), вкладка читает представление larix_rates_registry с правами владельца:
--    условие «вошедший с правом раздела» вычисляется один раз на запрос, поиск идёт по триграммному индексу.
--    Так же устроены вкладки КП и СУ-10 (представления над закрытыми материализованными).
--  • larix_sync_finish пишет новую таблицу; прежняя public.larix_contract_rates больше не пишется (остаётся
--    для вкладок, открытых до выкладки, и убирается отдельной миграцией).
--  • строки прежней таблицы сразу переносятся в новую (позиции собираются обратно, повторы схлопываются) —
--    вкладка не пустеет до следующей загрузки.
-- Только база нового портала: прежний портал (Supabase) заморожен, загрузка пишет в него только при
-- LARIX_SYNC_TARGETS=supabase — там остаётся прежний вид (supabase/migrations/20261018).
-- Повтор безопасен. Проверка — 20261021_larix_rates_registry.check.sql.

CREATE TABLE IF NOT EXISTS osp_private.larix_rates (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL,
  item_name text NOT NULL,
  unit text,
  price_material numeric CHECK (price_material > 0),
  price_work numeric CHECK (price_work > 0),
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
  osp_contract_id uuid,
  repeats integer NOT NULL DEFAULT 1 CHECK (repeats >= 1),
  CHECK (price_material IS NOT NULL OR price_work IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS larix_rates_name_idx ON osp_private.larix_rates (item_name, id);
CREATE INDEX IF NOT EXISTS larix_rates_name_trgm ON osp_private.larix_rates USING gin (item_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS larix_rates_price_material_idx ON osp_private.larix_rates (price_material, id);
CREATE INDEX IF NOT EXISTS larix_rates_price_work_idx ON osp_private.larix_rates (price_work, id);
CREATE INDEX IF NOT EXISTS larix_rates_date_idx ON osp_private.larix_rates (contract_date, id);
CREATE INDEX IF NOT EXISTS larix_rates_contract_idx ON osp_private.larix_rates (contract_number, id);
CREATE INDEX IF NOT EXISTS larix_rates_contractor_idx ON osp_private.larix_rates (contractor_name, id);
COMMENT ON TABLE osp_private.larix_rates IS 'Договорные расценки из Larix.CPM: позиция договора с ценой материалов и ценой работ, повторы схлопнуты; читается через public.larix_rates_registry';
COMMENT ON COLUMN osp_private.larix_rates.repeats IS 'Сколько одинаковых строк ВОР Larix (договор, позиция, единица, цены) схлопнуто в эту';

-- Вкладка «Договорные расценки (Larix)»: строки — только вошедшему с правом раздела «Реестр расценок».
CREATE OR REPLACE VIEW public.larix_rates_registry AS
SELECT r.id, r.item_name, r.unit, r.price_material, r.price_work, r.vat_rate, r.materials_used, r.comment,
       r.project_id, r.project_name, r.contractor_id, r.contractor_name, r.contract_id, r.contract_number,
       r.contract_date, r.contract_state, r.object_type, r.osp_contract_id, r.repeats
FROM osp_private.larix_rates r
WHERE (SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_can('rates_registry', 'view'));
CREATE OR REPLACE RULE osp_readonly_insert AS ON INSERT TO public.larix_rates_registry DO INSTEAD NOTHING;
CREATE OR REPLACE RULE osp_readonly_update AS ON UPDATE TO public.larix_rates_registry DO INSTEAD NOTHING;
CREATE OR REPLACE RULE osp_readonly_delete AS ON DELETE TO public.larix_rates_registry DO INSTEAD NOTHING;
COMMENT ON VIEW public.larix_rates_registry IS 'Договорные расценки Larix для вкладки реестра расценок: osp_private.larix_rates вошедшему с osp_can(rates_registry, view)';
-- osp:allow table larix_rates_registry authenticated=select

-- Замена расценок одной транзакцией (подпись прежняя). Порций ровно столько, сколько отправлено; пустой ответ
-- при непустых данных или падение ниже 30 % прежнего числа позиций — held, расценки не трогаем (p_force —
-- принять). statement_timeout на функции действует при вызове через PostgREST; при прямом подключении предел
-- задаёт вызывающий.
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

  DELETE FROM osp_private.larix_rates WHERE true;
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
      CASE WHEN jsonb_typeof(src.r->'price_material') IS DISTINCT FROM 'number' THEN NULL
           WHEN (src.r->>'price_material')::numeric > 0 THEN (src.r->>'price_material')::numeric END AS pm,
      CASE WHEN jsonb_typeof(src.r->'price_work') IS DISTINCT FROM 'number' THEN NULL
           WHEN (src.r->>'price_work')::numeric > 0 THEN (src.r->>'price_work')::numeric END AS pw,
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
  ), keyed AS (
    -- Повтор — та же позиция того же договора: наименование и единица без учёта регистра и лишних пробелов,
    -- те же цены. Остаётся первая по порядку ответа Larix, сколько их было — в repeats.
    SELECT pos.*, count(*) OVER w AS repeats, row_number() OVER (w ORDER BY pos.chunk_no, pos.ord) AS rn
    FROM pos
    WHERE pos.item_name IS NOT NULL AND (pos.pm IS NOT NULL OR pos.pw IS NOT NULL)
    WINDOW w AS (PARTITION BY pos.contract_id, pos.project_id, pos.contractor_id,
                 lower(btrim(regexp_replace(pos.item_name, '\s+', ' ', 'g'))),
                 lower(btrim(regexp_replace(coalesce(pos.unit, ''), '\s+', ' ', 'g'))), pos.pm, pos.pw)
  )
  INSERT INTO osp_private.larix_rates (run_id, item_name, unit, price_material, price_work, vat_rate, materials_used,
    comment, project_id, project_name, contractor_id, contractor_name, contract_id, contract_number, contract_date,
    contract_state, object_type, osp_contract_id, repeats)
  SELECT p_run, k.item_name, k.unit, k.pm, k.pw, k.vat_rate, k.materials_used, k.comment, k.project_id, k.project_name,
    k.contractor_id, k.contractor_name, k.contract_id, k.contract_number, k.contract_date, k.contract_state,
    k.object_type, CASE WHEN l.n = 1 THEN l.osp_id END, k.repeats
  FROM keyed k
  LEFT JOIN links l ON l.larix_id = k.contract_id
  WHERE k.rn = 1
  ORDER BY k.chunk_no, k.ord;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  SELECT count(DISTINCT contract_id)::integer, (count(DISTINCT contract_id) FILTER (WHERE osp_contract_id IS NOT NULL))::integer
    INTO v_contracts, v_matched
    FROM osp_private.larix_rates;
  -- Списки для фильтров вкладки: читаются один раз вместе со статусом загрузки.
  SELECT jsonb_build_object(
    'projects', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.project_id, 'name', p.project_name) ORDER BY p.project_name, p.project_id)
       FROM (SELECT DISTINCT ON (project_id) project_id, project_name FROM osp_private.larix_rates
             WHERE project_id IS NOT NULL ORDER BY project_id, id) p), '[]'::jsonb),
    'contractors', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.contractor_id, 'name', p.contractor_name) ORDER BY p.contractor_name, p.contractor_id)
       FROM (SELECT DISTINCT ON (contractor_id) contractor_id, contractor_name FROM osp_private.larix_rates
             WHERE contractor_id IS NOT NULL ORDER BY contractor_id, id) p), '[]'::jsonb),
    'contracts', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.contract_id, 'number', p.contract_number, 'date', p.contract_date) ORDER BY p.contract_number, p.contract_id)
       FROM (SELECT DISTINCT ON (contract_id) contract_id, contract_number, contract_date FROM osp_private.larix_rates
             WHERE contract_id IS NOT NULL ORDER BY contract_id, id) p), '[]'::jsonb),
    'states', coalesce((SELECT jsonb_agg(p.contract_state ORDER BY p.contract_state)
       FROM (SELECT DISTINCT contract_state FROM osp_private.larix_rates WHERE contract_state IS NOT NULL) p), '[]'::jsonb)
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

-- Уже загруженное — в новую таблицу (только если она пуста): строки «материал» и «работа» одной позиции
-- несут обе цены (price_material, price_work), поэтому позиция собирается обратно тем же ключом, что и при
-- загрузке; repeats — число строк группы, делённое на число цен позиции.
INSERT INTO osp_private.larix_rates (run_id, item_name, unit, price_material, price_work, vat_rate, materials_used,
  comment, project_id, project_name, contractor_id, contractor_name, contract_id, contract_number, contract_date,
  contract_state, object_type, osp_contract_id, repeats)
SELECT g.run_id, g.item_name, g.unit, g.pm, g.pw, g.vat_rate, g.materials_used, g.comment, g.project_id, g.project_name,
  g.contractor_id, g.contractor_name, g.contract_id, g.contract_number, g.contract_date, g.contract_state,
  g.object_type, g.osp_contract_id,
  greatest(1, g.n / ((g.pm IS NOT NULL)::int + (g.pw IS NOT NULL)::int))
FROM (
  SELECT c.*, count(*) OVER w AS n, row_number() OVER (w ORDER BY c.id) AS rn
  FROM (SELECT r.*, CASE WHEN r.price_material > 0 THEN r.price_material END AS pm,
               CASE WHEN r.price_work > 0 THEN r.price_work END AS pw
        FROM public.larix_contract_rates r) c
  WHERE c.pm IS NOT NULL OR c.pw IS NOT NULL
  WINDOW w AS (PARTITION BY c.contract_id, c.project_id, c.contractor_id,
               lower(btrim(regexp_replace(c.item_name, '\s+', ' ', 'g'))),
               lower(btrim(regexp_replace(coalesce(c.unit, ''), '\s+', ' ', 'g'))), c.pm, c.pw)
) g
WHERE g.rn = 1 AND NOT EXISTS (SELECT 1 FROM osp_private.larix_rates)
ORDER BY g.id;
