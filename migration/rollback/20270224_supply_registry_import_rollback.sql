-- АВАРИЙНЫЙ ОТКАТ 20270224_supply_registry_import (обе базы: Supabase и Яндекса): реестр «Расценки от снабжения СУ-10»
-- снова только из цен снабжения в тендерах (как после 20261023), кнопки «Загрузить из Excel» на странице нет (страница
-- понимает отсутствие таблицы как «обновление базы не применено»). Материализованное представление не трогается.
-- Загруженные расценки ОСТАЮТСЯ в таблицах supply_registry_imports / supply_registry_rates (в реестре не видны, пока
-- миграция не применена снова). Убрать таблицы — только отдельным решением, после выгрузки строк:
--   select i.file_name, i.created_at, i.created_by_name, r.* from public.supply_registry_rates r
--   join public.supply_registry_imports i on i.id = r.import_id order by i.created_at, r.row_no;
-- Вместе с откатом в шлюзе можно оставить строки allow.json / db-sections.json. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
DECLARE
  v_mv text := CASE WHEN to_regclass('osp_private.supply_rates_registry_mv') IS NOT NULL
                    THEN 'osp_private.supply_rates_registry_mv' ELSE 'public.supply_rates_registry_mv' END;
BEGIN
  -- Колонку import_id представление теряет — пересоздать (CREATE OR REPLACE колонку не убирает).
  DROP VIEW IF EXISTS public.supply_rates_registry;
  EXECUTE format($v$
    CREATE VIEW public.supply_rates_registry AS
     SELECT id, source_type, source_name, item_name, unit, price, tender_id, object_id, tender_desc, object_name, rate_date
       FROM %1$s
      WHERE (SELECT public.osp_registry_reader())$v$, v_mv);
  EXECUTE format($v$
    CREATE OR REPLACE VIEW public.supply_rates_registry_filter_objects AS
     SELECT DISTINCT object_id, object_name
       FROM %1$s r
      WHERE object_id IS NOT NULL AND (SELECT public.osp_registry_reader())$v$, v_mv);
  EXECUTE format($v$
    CREATE OR REPLACE VIEW public.supply_rates_registry_filter_tenders AS
     SELECT DISTINCT tender_id, tender_desc, object_id
       FROM %1$s r
      WHERE tender_id IS NOT NULL AND coalesce(tender_desc, '') <> '' AND (SELECT public.osp_registry_reader())$v$, v_mv);
  EXECUTE format($v$
    CREATE OR REPLACE VIEW public.supply_rates_registry_units AS
     SELECT DISTINCT unit
       FROM %1$s
      WHERE unit IS NOT NULL AND unit <> '' AND (SELECT public.osp_registry_reader())$v$, v_mv);
  -- Supabase: права пересозданного представления — как были (20261013, Р2d; служебному ключу — по умолчанию).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.supply_rates_registry FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT SELECT ON public.supply_rates_registry TO authenticated';
  END IF;
END
$$;
COMMENT ON VIEW public.supply_rates_registry IS 'Реестр «Расценки от снабжения СУ-10»: цены снабжения из тендеров — читателю реестра';

DROP FUNCTION IF EXISTS public.supply_registry_import(uuid, text, jsonb, jsonb);
DROP FUNCTION IF EXISTS osp_private.view_supply_registry_rates();

COMMIT;
