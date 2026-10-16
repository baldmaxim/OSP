-- Расценка материалов ВОР снабжением прямо на сайте. Тело supabase/migrations/20261020_supply_pricing.sql:
-- те же колонки, таблицы, представление и функции (тексты функций совпадают — сторожит
-- tests/supply/migrations.test.mjs), иначе — только права под одну учётку:
--  • правила по строкам включены и действуют на владельца, у новых таблиц — пропуск служебных операций;
--  • расценки, списки позиций и журнал читает сотрудник (osp_is_employee), пишет — «Тендеры: редактирование»
--    или «Тендеры на материалы: редактирование» (supply_can_edit); журнал пишет только триггер;
--  • служебные функции (SECURITY DEFINER) — с отметкой osp:internal.
-- Прежняя широкая политика расценок («любой сотрудник всё») снимается вместе с записью о её ролях.
-- Повтор безопасен; годится и для базы, куда эти объекты уже пришли с копией прода.

-- ── 1. Ключ наименования, право правки, закрытие ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.supply_norm_name(p_name text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT regexp_replace(
           translate(
             regexp_replace(lower(normalize(coalesce(p_name, ''), NFC)), '([0-9])[.,]([0-9])', '\1.\2', 'g'),
             'авеёкмнорстух', 'abeekmhopctyx'),
           '[^a-zа-я0-9.]+', '', 'g')
$$;

CREATE OR REPLACE FUNCTION public.supply_can_edit() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  SELECT public.osp_can('tenders', 'edit') OR public.osp_can('tenders_materials', 'edit')
$$;

CREATE OR REPLACE FUNCTION public.supply_rates_locked(p_tender uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT EXISTS (SELECT 1 FROM public.tenders m
                 WHERE m.tender_type = 'materials' AND m.deleted_at IS NULL
                   AND (m.parent_tender_id = p_tender OR m.id = p_tender))
     AND NOT EXISTS (SELECT 1 FROM public.tenders m
                 WHERE m.tender_type = 'materials' AND m.deleted_at IS NULL
                   AND (m.parent_tender_id = p_tender OR m.id = p_tender)
                   AND m.status::text NOT IN ('Завершён', 'Завершен'))
$$;

-- ── 2. Новые колонки расценок ────────────────────────────────────────────────────────────────────────
ALTER TABLE public.tender_vor_supply_rates
  ADD COLUMN IF NOT EXISTS price_input text,
  ADD COLUMN IF NOT EXISTS input_value numeric,
  ADD COLUMN IF NOT EXISTS volume_at_input numeric,
  ADD COLUMN IF NOT EXISTS supply_price_exact numeric,
  ADD COLUMN IF NOT EXISTS supply_total numeric(15, 2),
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_by uuid,
  ADD COLUMN IF NOT EXISTS material_key text GENERATED ALWAYS AS (public.supply_norm_name(material_name)) STORED;

ALTER TABLE public.tender_vor_supply_rates DROP CONSTRAINT IF EXISTS tender_vor_supply_rates_price_input_check;
ALTER TABLE public.tender_vor_supply_rates ADD CONSTRAINT tender_vor_supply_rates_price_input_check
  CHECK (price_input IS NULL OR price_input IN ('unit', 'total', 'import'));

CREATE INDEX IF NOT EXISTS tender_vor_supply_rates_key_idx
  ON public.tender_vor_supply_rates (tender_id, estimate_name, material_key);

COMMENT ON COLUMN public.tender_vor_supply_rates.price_input IS
  'Как ввели: unit — цена за единицу, total — итоговая сумма (страница расценки), import — Excel в карточке; пусто — до 20261020';
COMMENT ON COLUMN public.tender_vor_supply_rates.input_value IS 'Введённое значение: цена за единицу или сумма — по price_input';
COMMENT ON COLUMN public.tender_vor_supply_rates.volume_at_input IS 'Объём позиции ВОР, по которому считали сумму';
COMMENT ON COLUMN public.tender_vor_supply_rates.supply_price_exact IS
  'Цена без округления, когда вводили сумму (сумма / объём); карточка считает по ней, чтобы сумма совпала до копейки';
COMMENT ON COLUMN public.tender_vor_supply_rates.supply_total IS 'Сумма по позиции: введённая или цена × объём';
COMMENT ON COLUMN public.tender_vor_supply_rates.row_version IS 'Растёт при каждом изменении: правка со старой версией не проходит';
COMMENT ON COLUMN public.tender_vor_supply_rates.material_key IS 'supply_norm_name(material_name) — ключ сопоставления с позициями ВОР';

-- ── 3. Расчёт и версия строки ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tender_vor_supply_rates_compute() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_page boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.row_version := 1;
    v_page := NEW.price_input IN ('unit', 'total');
  ELSE
    NEW.row_version := OLD.row_version + 1;
    v_page := NEW.price_input IN ('unit', 'total')
      AND (NEW.price_input IS DISTINCT FROM OLD.price_input
           OR NEW.input_value IS DISTINCT FROM OLD.input_value
           OR NEW.volume_at_input IS DISTINCT FROM OLD.volume_at_input);
  END IF;
  NEW.updated_by := auth.uid();

  IF v_page THEN
    IF NEW.input_value IS NULL OR NEW.input_value <= 0 THEN
      RAISE EXCEPTION 'Цена и сумма должны быть больше нуля' USING ERRCODE = '23514', HINT = 'supply_value';
    END IF;
    IF NEW.price_input = 'unit' THEN
      NEW.supply_price := round(NEW.input_value, 2);
      NEW.supply_price_exact := NULL;
      NEW.supply_total := CASE WHEN NEW.volume_at_input > 0 THEN round(NEW.supply_price * NEW.volume_at_input, 2) END;
    ELSE
      IF NEW.volume_at_input IS NULL OR NEW.volume_at_input <= 0 THEN
        RAISE EXCEPTION 'Сумму можно ввести только у позиции с объёмом' USING ERRCODE = '23514', HINT = 'supply_volume';
      END IF;
      NEW.supply_total := round(NEW.input_value, 2);
      NEW.supply_price_exact := NEW.supply_total / NEW.volume_at_input;
      NEW.supply_price := round(NEW.supply_price_exact, 2);
    END IF;
    IF NEW.supply_price <= 0 THEN
      RAISE EXCEPTION 'Цена за единицу выходит меньше копейки' USING ERRCODE = '23514', HINT = 'supply_value';
    END IF;
  ELSIF TG_OP = 'INSERT' OR NEW.supply_price IS DISTINCT FROM OLD.supply_price THEN
    IF NEW.supply_price IS NULL OR NEW.supply_price <= 0 THEN
      RAISE EXCEPTION 'Цена должна быть больше нуля' USING ERRCODE = '23514', HINT = 'supply_value';
    END IF;
    NEW.price_input := 'import';
    NEW.input_value := NEW.supply_price;
    NEW.volume_at_input := NULL;
    NEW.supply_price_exact := NULL;
    NEW.supply_total := NULL;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS tender_vor_supply_rates_compute ON public.tender_vor_supply_rates;
CREATE TRIGGER tender_vor_supply_rates_compute
  BEFORE INSERT OR UPDATE ON public.tender_vor_supply_rates
  FOR EACH ROW EXECUTE FUNCTION public.tender_vor_supply_rates_compute();

-- ── 4. Закрытие после завершения тендера на материалы ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tender_supply_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_skip text[] := ARRAY['row_version', 'updated_at', 'updated_by', 'parsed_at', 'parsed_by'];
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - v_skip) = (to_jsonb(OLD) - v_skip) THEN RETURN NULL; END IF;
  IF (TG_OP <> 'INSERT' AND public.supply_rates_locked(OLD.tender_id))
     OR (TG_OP <> 'DELETE' AND public.supply_rates_locked(NEW.tender_id)) THEN
    RAISE EXCEPTION 'Тендер на материалы завершён — расценки снабжения только для чтения. Чтобы изменить, верните тендеру на материалы прежний статус.'
      USING ERRCODE = 'P0001', HINT = 'supply_locked';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS tender_vor_supply_rates_guard ON public.tender_vor_supply_rates;
CREATE TRIGGER tender_vor_supply_rates_guard
  AFTER INSERT OR UPDATE OR DELETE ON public.tender_vor_supply_rates
  FOR EACH ROW EXECUTE FUNCTION public.tender_supply_guard();

-- ── 5. Журнал изменений расценок ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tender_supply_rate_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tender_id uuid NOT NULL,
  rate_id uuid NOT NULL,
  op text NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
  estimate_name text NOT NULL,
  old_estimate_name text,
  material_name text NOT NULL,
  unit text,
  old_price numeric,
  new_price numeric,
  old_price_exact numeric,
  new_price_exact numeric,
  old_total numeric,
  new_total numeric,
  old_input text,
  new_input text,
  input_value numeric,
  volume_at_input numeric,
  changed_by uuid,
  changed_by_name text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tender_supply_rate_log_tender_idx ON public.tender_supply_rate_log (tender_id, id DESC);
CREATE INDEX IF NOT EXISTS tender_supply_rate_log_rate_idx ON public.tender_supply_rate_log (rate_id, id DESC);
COMMENT ON TABLE public.tender_supply_rate_log IS
  'Журнал изменений расценок снабжения (триггер на tender_vor_supply_rates): было / стало, кто, когда. Без внешнего ключа на тендер';

CREATE OR REPLACE FUNCTION public.tender_supply_rate_log_write() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_name text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.supply_price IS NOT DISTINCT FROM OLD.supply_price
     AND NEW.supply_price_exact IS NOT DISTINCT FROM OLD.supply_price_exact
     AND NEW.supply_total IS NOT DISTINCT FROM OLD.supply_total
     AND NEW.price_input IS NOT DISTINCT FROM OLD.price_input
     AND NEW.estimate_name IS NOT DISTINCT FROM OLD.estimate_name
     AND NEW.material_name IS NOT DISTINCT FROM OLD.material_name
     AND NEW.unit IS NOT DISTINCT FROM OLD.unit THEN
    RETURN NULL;
  END IF;
  SELECT nullif(btrim(ur.full_name), '') INTO v_name FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1;
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.tender_supply_rate_log (tender_id, rate_id, op, estimate_name, material_name, unit,
      old_price, old_price_exact, old_total, old_input, changed_by, changed_by_name)
    VALUES (OLD.tender_id, OLD.id, 'delete', OLD.estimate_name, OLD.material_name, OLD.unit,
      OLD.supply_price, OLD.supply_price_exact, OLD.supply_total, OLD.price_input, auth.uid(), v_name);
  ELSE
    INSERT INTO public.tender_supply_rate_log (tender_id, rate_id, op, estimate_name, old_estimate_name, material_name, unit,
      old_price, new_price, old_price_exact, new_price_exact, old_total, new_total, old_input, new_input,
      input_value, volume_at_input, changed_by, changed_by_name)
    VALUES (NEW.tender_id, NEW.id, lower(TG_OP), NEW.estimate_name,
      CASE WHEN TG_OP = 'UPDATE' AND OLD.estimate_name IS DISTINCT FROM NEW.estimate_name THEN OLD.estimate_name END,
      NEW.material_name, NEW.unit,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.supply_price END, NEW.supply_price,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.supply_price_exact END, NEW.supply_price_exact,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.supply_total END, NEW.supply_total,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.price_input END, NEW.price_input,
      NEW.input_value, NEW.volume_at_input, auth.uid(), v_name);
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS tender_vor_supply_rates_log ON public.tender_vor_supply_rates;
CREATE TRIGGER tender_vor_supply_rates_log
  AFTER INSERT OR UPDATE OR DELETE ON public.tender_vor_supply_rates
  FOR EACH ROW EXECUTE FUNCTION public.tender_supply_rate_log_write();

-- ── 6. Разобранный ВОР: позиции для расценки ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tender_supply_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
  estimate_name text NOT NULL CHECK (btrim(estimate_name) <> ''),
  source text NOT NULL CHECK (source IN ('vor_file', 'vor_tab')),
  s3_document_id uuid REFERENCES public.s3_documents(id) ON DELETE SET NULL,
  file_name text,
  sheet_name text,
  column_map jsonb,
  source_version text,
  positions jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (CASE WHEN jsonb_typeof(positions) = 'array' THEN jsonb_array_length(positions) <= 20000 ELSE false END),
  positions_count integer NOT NULL DEFAULT 0,
  row_version integer NOT NULL DEFAULT 1,
  parsed_by uuid,
  parsed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tender_id, estimate_name)
);
CREATE INDEX IF NOT EXISTS tender_supply_sources_document_idx ON public.tender_supply_sources (s3_document_id);
COMMENT ON TABLE public.tender_supply_sources IS
  'Позиции ВОР для расценки снабжением: лист «Материалы» файла из «ВОРов и РД» или вкладка «ВОР» карточки; строка на основной тендер и ВОР';
COMMENT ON COLUMN public.tender_supply_sources.source_version IS
  'Признак версии источника (файл: id и дата загрузки; вкладка ВОР: время загрузки) — по нему страница видит, что ВОР обновился';

CREATE OR REPLACE FUNCTION public.tender_supply_sources_compute() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.positions IS DISTINCT FROM OLD.positions THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.positions) e
               WHERE jsonb_typeof(e) <> 'object' OR coalesce(btrim(e->>'name'), '') = '') THEN
      RAISE EXCEPTION 'В списке позиций есть строка без наименования' USING ERRCODE = '22023';
    END IF;
    NEW.positions := (SELECT coalesce(jsonb_agg(e || jsonb_build_object('k', public.supply_norm_name(e->>'name')) ORDER BY o), '[]'::jsonb)
                      FROM jsonb_array_elements(NEW.positions) WITH ORDINALITY AS t(e, o));
    NEW.positions_count := (SELECT count(DISTINCT e->>'k') FROM jsonb_array_elements(NEW.positions) e WHERE e->>'k' <> '');
    NEW.parsed_at := now();
    NEW.parsed_by := auth.uid();
  END IF;
  NEW.row_version := CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE OLD.row_version + 1 END;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS tender_supply_sources_compute ON public.tender_supply_sources;
CREATE TRIGGER tender_supply_sources_compute
  BEFORE INSERT OR UPDATE ON public.tender_supply_sources
  FOR EACH ROW EXECUTE FUNCTION public.tender_supply_sources_compute();

DROP TRIGGER IF EXISTS tender_supply_sources_guard ON public.tender_supply_sources;
CREATE TRIGGER tender_supply_sources_guard
  AFTER INSERT OR UPDATE OR DELETE ON public.tender_supply_sources
  FOR EACH ROW EXECUTE FUNCTION public.tender_supply_guard();

-- ── 7. Сколько позиций расценено ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.tender_supply_progress WITH (security_invoker = true) AS
SELECT s.tender_id, s.estimate_name, s.positions_count, coalesce(p.priced, 0) AS priced_count,
       s.parsed_at, s.row_version
FROM public.tender_supply_sources s
LEFT JOIN LATERAL (
  SELECT count(DISTINCT e->>'k')::integer AS priced
  FROM jsonb_array_elements(s.positions) e
  WHERE e->>'k' <> ''
    AND EXISTS (SELECT 1 FROM public.tender_vor_supply_rates r
                WHERE r.tender_id = s.tender_id AND r.estimate_name = s.estimate_name AND r.material_key = e->>'k')
) p ON true;

-- ── 8. Перенос расценок и позиций на другое имя ВОР ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.supply_estimate_rename(p_tender uuid, p_from text, p_to text) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_rates integer;
  v_sources integer;
BEGIN
  IF NOT public.supply_can_edit() THEN
    RAISE EXCEPTION 'Нет права менять расценки снабжения' USING ERRCODE = '42501';
  END IF;
  IF coalesce(btrim(p_to), '') = '' OR p_from IS NULL THEN
    RAISE EXCEPTION 'Не задано имя ВОР' USING ERRCODE = '22023';
  END IF;
  IF p_from = p_to THEN
    RETURN jsonb_build_object('rates', 0, 'sources', 0);
  END IF;
  IF EXISTS (SELECT 1 FROM public.tender_vor_supply_rates a
             JOIN public.tender_vor_supply_rates b
               ON b.tender_id = a.tender_id AND b.estimate_name = p_to AND b.material_key = a.material_key
             WHERE a.tender_id = p_tender AND a.estimate_name = p_from) THEN
    RAISE EXCEPTION 'В ВОР «%» уже есть цены на те же материалы — перенести автоматически нельзя', p_to
      USING ERRCODE = '23505', HINT = 'supply_rename_overlap';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tender_supply_sources WHERE tender_id = p_tender AND estimate_name = p_to)
     AND EXISTS (SELECT 1 FROM public.tender_supply_sources WHERE tender_id = p_tender AND estimate_name = p_from) THEN
    RAISE EXCEPTION 'У ВОР «%» уже есть свой список позиций', p_to USING ERRCODE = '23505', HINT = 'supply_rename_overlap';
  END IF;
  UPDATE public.tender_vor_supply_rates SET estimate_name = p_to WHERE tender_id = p_tender AND estimate_name = p_from;
  GET DIAGNOSTICS v_rates = ROW_COUNT;
  UPDATE public.tender_supply_sources SET estimate_name = p_to WHERE tender_id = p_tender AND estimate_name = p_from;
  GET DIAGNOSTICS v_sources = ROW_COUNT;
  RETURN jsonb_build_object('rates', v_rates, 'sources', v_sources);
END
$$;

-- ── 9. Права под одну учётку ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.tender_supply_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tender_supply_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tender_supply_rate_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tender_supply_rate_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS osp_internal ON public.tender_supply_sources;
CREATE POLICY osp_internal ON public.tender_supply_sources FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));
DROP POLICY IF EXISTS osp_internal ON public.tender_supply_rate_log;
CREATE POLICY osp_internal ON public.tender_supply_rate_log FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

-- Расценки: прежняя широкая политика уходит вместе с записью о её ролях.
DROP POLICY IF EXISTS "Allow all for authenticated users" ON public.tender_vor_supply_rates;
DELETE FROM osp_meta.policy_roles
 WHERE schema_name = 'public' AND table_name = 'tender_vor_supply_rates' AND policy_name = 'Allow all for authenticated users';

-- Пропуск → да; иначе роль из токена и условие (как TO authenticated USING (…) на проде).
DROP POLICY IF EXISTS supply_rates_read ON public.tender_vor_supply_rates;
CREATE POLICY supply_rates_read ON public.tender_vor_supply_rates FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_is_employee())) END);
DROP POLICY IF EXISTS supply_rates_insert ON public.tender_vor_supply_rates;
CREATE POLICY supply_rates_insert ON public.tender_vor_supply_rates FOR INSERT TO PUBLIC
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.supply_can_edit())) END);
DROP POLICY IF EXISTS supply_rates_update ON public.tender_vor_supply_rates;
CREATE POLICY supply_rates_update ON public.tender_vor_supply_rates FOR UPDATE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.supply_can_edit())) END)
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.supply_can_edit())) END);
DROP POLICY IF EXISTS supply_rates_delete ON public.tender_vor_supply_rates;
CREATE POLICY supply_rates_delete ON public.tender_vor_supply_rates FOR DELETE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.supply_can_edit())) END);

DROP POLICY IF EXISTS supply_sources_read ON public.tender_supply_sources;
CREATE POLICY supply_sources_read ON public.tender_supply_sources FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_is_employee())) END);
DROP POLICY IF EXISTS supply_sources_insert ON public.tender_supply_sources;
CREATE POLICY supply_sources_insert ON public.tender_supply_sources FOR INSERT TO PUBLIC
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.supply_can_edit())) END);
DROP POLICY IF EXISTS supply_sources_update ON public.tender_supply_sources;
CREATE POLICY supply_sources_update ON public.tender_supply_sources FOR UPDATE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.supply_can_edit())) END)
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.supply_can_edit())) END);
DROP POLICY IF EXISTS supply_sources_delete ON public.tender_supply_sources;
CREATE POLICY supply_sources_delete ON public.tender_supply_sources FOR DELETE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.supply_can_edit())) END);

DROP POLICY IF EXISTS supply_rate_log_read ON public.tender_supply_rate_log;
CREATE POLICY supply_rate_log_read ON public.tender_supply_rate_log FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_is_employee())) END);

INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'tender_vor_supply_rates', 'supply_rates_read', ARRAY['authenticated']),
  ('public', 'tender_vor_supply_rates', 'supply_rates_insert', ARRAY['authenticated']),
  ('public', 'tender_vor_supply_rates', 'supply_rates_update', ARRAY['authenticated']),
  ('public', 'tender_vor_supply_rates', 'supply_rates_delete', ARRAY['authenticated']),
  ('public', 'tender_supply_sources', 'supply_sources_read', ARRAY['authenticated']),
  ('public', 'tender_supply_sources', 'supply_sources_insert', ARRAY['authenticated']),
  ('public', 'tender_supply_sources', 'supply_sources_update', ARRAY['authenticated']),
  ('public', 'tender_supply_sources', 'supply_sources_delete', ARRAY['authenticated']),
  ('public', 'tender_supply_rate_log', 'supply_rate_log_read', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;
-- osp:allow table tender_supply_sources authenticated=select,insert,update,delete
-- osp:allow table tender_supply_rate_log authenticated=select
-- osp:allow table tender_supply_progress authenticated=select
-- osp:allow rpc supply_estimate_rename authenticated
-- osp:allow rpc supply_rates_locked authenticated
