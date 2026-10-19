-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261023_supply_rate_reuse.sql (Supabase): цены из других тендеров больше
-- не подставляются и не предлагаются (функции подбора удаляются — страница работает как до миграции), триггер
-- расчёта — прежний (без дня расценки и копий), реестр СУ-10 — прежний (копии в нём снова видны, дата — время
-- изменения строки).
-- Данные НЕ удаляются: колонки дня расценки, источника копии и слов наименования остаются (слова — вычисляемые,
-- поэтому функция слов остаётся), скопированные цены остаются ценами тендеров. Повторное применение миграции
-- продолжит с ними. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

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

DROP FUNCTION IF EXISTS public.supply_autofill(uuid);
DROP FUNCTION IF EXISTS public.supply_suggestion_counts(uuid, jsonb);
DROP FUNCTION IF EXISTS public.supply_rate_suggestions(uuid, text, text, text, integer);
DROP FUNCTION IF EXISTS public.supply_rate_origins(uuid);

-- Реестр — прежнее тело (20260902) тем же способом: рядом, переключить, подменить.
DROP MATERIALIZED VIEW IF EXISTS public.supply_rates_registry_mv_next;
CREATE MATERIALIZED VIEW public.supply_rates_registry_mv_next AS
SELECT DISTINCT ON (sr.tender_id, public.kp_norm_name(sr.material_name), public.kp_norm_unit(sr.unit))
  md5(sr.tender_id::text || '|' || public.kp_norm_name(sr.material_name) || '|' || public.kp_norm_unit(sr.unit)) AS id,
  'supply_su10'::text AS source_type,
  'СУ-10'::text AS source_name,
  sr.material_name AS item_name,
  sr.unit AS unit,
  sr.supply_price AS price,
  sr.tender_id,
  t.object_id,
  t.work_description AS tender_desc,
  o.name AS object_name,
  coalesce(sr.updated_at, sr.created_at) AS rate_date
FROM public.tender_vor_supply_rates sr
JOIN public.tenders t ON t.id = sr.tender_id
LEFT JOIN public.objects o ON o.id = t.object_id
WHERE public.kp_norm_name(sr.material_name) <> ''
ORDER BY sr.tender_id, public.kp_norm_name(sr.material_name), public.kp_norm_unit(sr.unit),
         coalesce(sr.updated_at, sr.created_at) DESC NULLS LAST;

CREATE UNIQUE INDEX supply_rates_mv_next_id ON public.supply_rates_registry_mv_next (id);
CREATE INDEX supply_rates_mv_next_date ON public.supply_rates_registry_mv_next (rate_date DESC NULLS LAST);
CREATE INDEX supply_rates_mv_next_name ON public.supply_rates_registry_mv_next (item_name, id);
CREATE INDEX supply_rates_mv_next_name_trgm ON public.supply_rates_registry_mv_next USING gin (item_name gin_trgm_ops);
CREATE INDEX supply_rates_mv_next_object ON public.supply_rates_registry_mv_next (object_id);
CREATE INDEX supply_rates_mv_next_price ON public.supply_rates_registry_mv_next (price);
CREATE INDEX supply_rates_mv_next_tender ON public.supply_rates_registry_mv_next (tender_id);

CREATE OR REPLACE VIEW public.supply_rates_registry AS
 SELECT id, source_type, source_name, item_name, unit, price, tender_id, object_id, tender_desc, object_name, rate_date
   FROM public.supply_rates_registry_mv_next
  WHERE (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.supply_rates_registry_filter_objects AS
 SELECT DISTINCT object_id, object_name
   FROM public.supply_rates_registry_mv_next r
  WHERE object_id IS NOT NULL AND (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.supply_rates_registry_filter_tenders AS
 SELECT DISTINCT tender_id, tender_desc, object_id
   FROM public.supply_rates_registry_mv_next r
  WHERE tender_id IS NOT NULL AND coalesce(tender_desc, '') <> '' AND (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.supply_rates_registry_units AS
 SELECT DISTINCT unit
   FROM public.supply_rates_registry_mv_next
  WHERE unit IS NOT NULL AND unit <> '' AND (SELECT public.osp_registry_reader());

DROP MATERIALIZED VIEW IF EXISTS public.supply_rates_registry_mv;
ALTER MATERIALIZED VIEW public.supply_rates_registry_mv_next RENAME TO supply_rates_registry_mv;
ALTER INDEX public.supply_rates_mv_next_id RENAME TO idx_supply_rates_mv_id;
ALTER INDEX public.supply_rates_mv_next_date RENAME TO idx_supply_rates_mv_date;
ALTER INDEX public.supply_rates_mv_next_name RENAME TO idx_supply_rates_mv_name;
ALTER INDEX public.supply_rates_mv_next_name_trgm RENAME TO idx_supply_rates_mv_name_trgm;
ALTER INDEX public.supply_rates_mv_next_object RENAME TO idx_supply_rates_mv_object;
ALTER INDEX public.supply_rates_mv_next_price RENAME TO idx_supply_rates_mv_price;
ALTER INDEX public.supply_rates_mv_next_tender RENAME TO idx_supply_rates_mv_tender;

-- Права реестра (20261013, Р2d): само представление — только служебному ключу, представления — как были.
REVOKE ALL ON TABLE public.supply_rates_registry_mv FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.supply_rates_registry_mv TO service_role;

COMMIT;
