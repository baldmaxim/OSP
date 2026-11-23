-- АВАРИЙНЫЙ ОТКАТ migration/yandex/20270227_supply_registry_rate_details.sql (только база Яндекса; для Supabase —
-- 20270227_supply_registry_rate_details_rollback.sql): реестр «Расценки от снабжения СУ-10» — снова как после 20270224.
-- Загруженные строки возвращаются в public.supply_registry_rates (с правилами по строкам) и читаются через
-- osp_private.view_supply_registry_rates(); загрузка пишет туда же; подробностей строки (подрядчик по папке, № документа,
-- № заявки / заказа, файл-источник, ссылка на счёт) в реестре нет — страница это понимает (колонок нет — без колонки
-- «Документ» и окна подробностей).
-- Данные НЕ удаляются: osp_private.supply_registry_rates остаётся со всеми полями (в реестре не видна). Применить
-- 20270227 снова — её перенос сольёт строки по id (новые после отката — перенесутся, удалённые с загрузкой — удалены в
-- обеих таблицах каскадом).
-- Запуск — под учёткой-владельцем, одной транзакцией (psql -f), с отметкой служебной операции (она задаётся ниже: без
-- неё правила по строкам прежней таблицы не дали бы вернуть строки). Повтор безопасен.
-- Шлюз: вернуть строку «supply_registry_rates authenticated=select» в allow.json не обязательно — страница читает число
-- строк загрузки через представление реестра.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL application_name = 'osp:internal';

DO $$
BEGIN
  IF to_regclass('osp_private.supply_registry_rates') IS NULL THEN
    RAISE EXCEPTION 'Нет osp_private.supply_registry_rates: 20270227 здесь не применена (или это база Supabase) — откатывать нечего';
  END IF;
END
$$;

-- ── 1. Прежняя таблица строк (как в 20270224) и строки в неё — с прежним временем загрузки ──────────────
CREATE TABLE IF NOT EXISTS public.supply_registry_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES public.supply_registry_imports(id) ON DELETE CASCADE,
  source_name text NOT NULL CHECK (char_length(btrim(source_name)) BETWEEN 1 AND 200),
  item_name text NOT NULL CHECK (char_length(btrim(item_name)) BETWEEN 1 AND 1000),
  unit character varying(50),
  price numeric(15,2) NOT NULL CHECK (price > 0 AND price < 1e12),
  object_id uuid REFERENCES public.objects(id) ON DELETE SET NULL,
  object_label text CHECK (object_label IS NULL OR char_length(object_label) <= 255),
  tender_id uuid REFERENCES public.tenders(id) ON DELETE SET NULL,
  tender_label text CHECK (tender_label IS NULL OR char_length(tender_label) <= 1000),
  rate_date date NOT NULL,
  row_no integer CHECK (row_no IS NULL OR row_no > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.supply_registry_rates IS
  'Расценка, загруженная из Excel в реестр «Расценки от снабжения СУ-10»: цена за единицу, источник и объект — как в файле';
CREATE INDEX IF NOT EXISTS supply_registry_rates_import_idx ON public.supply_registry_rates (import_id);
CREATE INDEX IF NOT EXISTS supply_registry_rates_object_idx ON public.supply_registry_rates (object_id) WHERE object_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS supply_registry_rates_tender_idx ON public.supply_registry_rates (tender_id) WHERE tender_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS supply_registry_rates_uniq ON public.supply_registry_rates
  (public.kp_norm_name(item_name), public.kp_norm_unit(unit), price, rate_date,
   coalesce(object_id::text, lower(btrim(coalesce(object_label, '')))), lower(btrim(source_name)));

DROP TRIGGER IF EXISTS supply_registry_rates_stamp ON public.supply_registry_rates;
INSERT INTO public.supply_registry_rates (id, import_id, source_name, item_name, unit, price, object_id, object_label,
                                          tender_id, tender_label, rate_date, row_no, created_at)
SELECT m.id, m.import_id, m.source_name, m.item_name, m.unit, m.price, m.object_id, m.object_label, m.tender_id,
       m.tender_label, m.rate_date, m.row_no, m.created_at
FROM osp_private.supply_registry_rates m
ON CONFLICT (id) DO NOTHING;
DO $$
DECLARE
  v_all bigint;
  v_back bigint;
BEGIN
  SELECT count(*) INTO v_all FROM osp_private.supply_registry_rates;
  SELECT count(*) INTO v_back FROM osp_private.supply_registry_rates m
  WHERE EXISTS (SELECT 1 FROM public.supply_registry_rates p WHERE p.id = m.id);
  IF v_back <> v_all THEN
    RAISE EXCEPTION 'В прежнюю таблицу вернулось % из % строк — откат не выполнен', v_back, v_all;
  END IF;
END
$$;

-- Очистка полей — прежняя (без новых колонок: их у прежней таблицы нет).
CREATE OR REPLACE FUNCTION public.supply_registry_rates_stamp() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.source_name := btrim(regexp_replace(NEW.source_name, '\s+', ' ', 'g'));
  NEW.item_name := btrim(regexp_replace(NEW.item_name, '\s+', ' ', 'g'));
  NEW.unit := nullif(btrim(NEW.unit), '');
  NEW.object_label := nullif(btrim(regexp_replace(NEW.object_label, '\s+', ' ', 'g')), '');
  NEW.tender_label := nullif(btrim(regexp_replace(NEW.tender_label, '\s+', ' ', 'g')), '');
  NEW.created_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER supply_registry_rates_stamp
  BEFORE INSERT ON public.supply_registry_rates
  FOR EACH ROW EXECUTE FUNCTION public.supply_registry_rates_stamp();
DROP TRIGGER IF EXISTS supply_registry_rates_stamp ON osp_private.supply_registry_rates;

-- ── 2. Правила по строкам (как в 20270224) ───────────────────────────────────────────────────────────
ALTER TABLE public.supply_registry_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supply_registry_rates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS osp_internal ON public.supply_registry_rates;
CREATE POLICY osp_internal ON public.supply_registry_rates FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));
DROP POLICY IF EXISTS supply_registry_rates_read ON public.supply_registry_rates;
CREATE POLICY supply_registry_rates_read ON public.supply_registry_rates FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_registry_reader())) END);
DROP POLICY IF EXISTS supply_registry_rates_insert ON public.supply_registry_rates;
CREATE POLICY supply_registry_rates_insert ON public.supply_registry_rates FOR INSERT TO PUBLIC
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_can('rates_registry', 'edit'))) END);
INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'supply_registry_rates', 'supply_registry_rates_read', ARRAY['authenticated']),
  ('public', 'supply_registry_rates', 'supply_registry_rates_insert', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;

-- ── 3. Чтение загруженных строк через функцию и представления (как в 20270224) ─────────────────────────
CREATE OR REPLACE FUNCTION osp_private.view_supply_registry_rates()
  RETURNS TABLE (id text, source_type text, source_name text, item_name text, unit text, price numeric(15,2),
                 tender_id uuid, object_id uuid, tender_desc text, object_name character varying(255),
                 rate_date timestamptz, import_id uuid)
  LANGUAGE sql STABLE
  SET search_path = public
  SET application_name = 'osp:internal'
AS $$
  SELECT md5('import|' || m.id::text), 'supply_import'::text, m.source_name, m.item_name, m.unit::text, m.price,
         m.tender_id, m.object_id, coalesce(t.work_description, m.tender_label),
         coalesce(o.name, left(m.object_label, 255))::character varying(255),
         (m.rate_date::timestamp AT TIME ZONE 'Europe/Moscow'), m.import_id
  FROM public.supply_registry_rates m
  LEFT JOIN public.tenders t ON t.id = m.tender_id
  LEFT JOIN public.objects o ON o.id = m.object_id
  WHERE (SELECT public.osp_registry_reader())
$$;

-- Колонки подробностей представление теряет — пересоздать (CREATE OR REPLACE колонку не убирает).
DROP VIEW IF EXISTS public.supply_rates_registry;
CREATE VIEW public.supply_rates_registry AS
 SELECT u.id, u.source_type, u.source_name, u.item_name, u.unit, u.price, u.tender_id, u.object_id, u.tender_desc,
        u.object_name, u.rate_date, u.import_id
   FROM (SELECT r.id, r.source_type, r.source_name, r.item_name, r.unit, r.price, r.tender_id, r.object_id, r.tender_desc,
                r.object_name, r.rate_date, NULL::uuid AS import_id
           FROM osp_private.supply_rates_registry_mv r
         UNION ALL
         SELECT f.id, f.source_type, f.source_name, f.item_name, f.unit, f.price::numeric(15,2), f.tender_id, f.object_id,
                f.tender_desc, f.object_name::character varying(255), f.rate_date, f.import_id
           FROM osp_private.view_supply_registry_rates() f) u
  WHERE (SELECT public.osp_registry_reader());
COMMENT ON VIEW public.supply_rates_registry IS
  'Реестр «Расценки от снабжения СУ-10»: цены снабжения из тендеров (материализованное) и загруженные из Excel (supply_registry_rates), — читателю реестра';
CREATE OR REPLACE VIEW public.supply_rates_registry_filter_objects AS
 SELECT DISTINCT x.object_id, x.object_name
   FROM (SELECT r.object_id, r.object_name FROM osp_private.supply_rates_registry_mv r
         UNION SELECT f.object_id, f.object_name::character varying(255) FROM osp_private.view_supply_registry_rates() f) x
  WHERE x.object_id IS NOT NULL AND (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.supply_rates_registry_filter_tenders AS
 SELECT DISTINCT x.tender_id, x.tender_desc, x.object_id
   FROM (SELECT r.tender_id, r.tender_desc, r.object_id FROM osp_private.supply_rates_registry_mv r
         UNION SELECT f.tender_id, f.tender_desc, f.object_id FROM osp_private.view_supply_registry_rates() f) x
  WHERE x.tender_id IS NOT NULL AND coalesce(x.tender_desc, '') <> '' AND (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.supply_rates_registry_units AS
 SELECT DISTINCT x.unit
   FROM (SELECT r.unit FROM osp_private.supply_rates_registry_mv r
         UNION SELECT f.unit FROM osp_private.view_supply_registry_rates() f) x
  WHERE x.unit IS NOT NULL AND x.unit <> '' AND (SELECT public.osp_registry_reader());

-- ── 4. Загрузка порцией — в прежнюю таблицу (тело 20270224) ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.supply_registry_import(p_import uuid, p_file_name text, p_options jsonb, p_rows jsonb)
  RETURNS TABLE (import_id uuid, added integer, skipped integer)
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_import uuid := p_import;
  v_n integer;
  v_added integer;
  v_bad integer;
BEGIN
  IF NOT public.osp_can('rates_registry', 'edit') THEN
    RAISE EXCEPTION 'Нет права правки реестра расценок' USING ERRCODE = '42501';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Строки — массивом' USING ERRCODE = '22023';
  END IF;
  v_n := jsonb_array_length(p_rows);
  IF v_n > 1000 THEN
    RAISE EXCEPTION 'За один раз — не больше 1000 строк' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_bad
  FROM jsonb_to_recordset(p_rows) AS r(rate_date date)
  WHERE r.rate_date IS NULL OR r.rate_date < date '2000-01-01'
     OR r.rate_date > (now() AT TIME ZONE 'Europe/Moscow')::date + 1;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Дата расценки не указана или из будущего: строк %', v_bad USING ERRCODE = '22023';
  END IF;

  IF v_import IS NULL THEN
    INSERT INTO public.supply_registry_imports (file_name, options)
    VALUES (left(coalesce(nullif(btrim(p_file_name), ''), 'файл'), 500), coalesce(p_options, '{}'::jsonb))
    RETURNING id INTO v_import;
  ELSIF NOT EXISTS (SELECT 1 FROM public.supply_registry_imports i WHERE i.id = v_import) THEN
    RAISE EXCEPTION 'Загрузка не найдена — возможно, её уже удалили' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.supply_registry_rates (import_id, source_name, item_name, unit, price, object_id, object_label,
                                            tender_id, tender_label, rate_date, row_no)
  SELECT v_import, r.source_name, r.item_name, left(r.unit, 50), round(r.price, 2), r.object_id, left(r.object_label, 255),
         r.tender_id, left(r.tender_label, 1000), r.rate_date, r.row_no
  FROM jsonb_to_recordset(p_rows) AS r(source_name text, item_name text, unit text, price numeric, object_id uuid,
                                       object_label text, tender_id uuid, tender_label text, rate_date date, row_no integer)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;

  RETURN QUERY SELECT v_import, v_added, v_n - v_added;
END
$$;

-- ── 5. Триггеры переименования — прочь ──────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS supply_registry_rates_object_name ON public.objects;
DROP TRIGGER IF EXISTS supply_registry_rates_tender_desc ON public.tenders;
DROP FUNCTION IF EXISTS public.supply_registry_rates_names();

COMMIT;
