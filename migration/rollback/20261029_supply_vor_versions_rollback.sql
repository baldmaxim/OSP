-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261029_supply_vor_versions.sql (Supabase): версии ВОР убираются.
-- Цены, ссылки на документы и списки позиций не трогаются: страница расценки работает как до миграции (без подсветки
-- изменений, вопросов о новой версии и истории версий). Теряется только история версий ВОР (что изменилось и снимки
-- цен) и ответы «отдельный ВОР» — сначала снимите копию таблицы, если она нужна. Повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS tender_supply_sources_revision ON public.tender_supply_sources;
DROP FUNCTION IF EXISTS public.tender_supply_revision_write();
DROP FUNCTION IF EXISTS public.supply_vor_adopt(uuid, text, text);
DROP FUNCTION IF EXISTS public.supply_rate_carry(uuid, integer, text, text, text);
DROP FUNCTION IF EXISTS public.supply_revisions_review(uuid, bigint[]);
DROP FUNCTION IF EXISTS public.supply_positions_by_key(jsonb);
DROP TABLE IF EXISTS public.tender_supply_revisions;

-- Расчёт списка позиций — как в 20261020 (без прежних файлов и ответа «отдельный ВОР»).
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

-- Закрытие расценки — как в 20261020 (удаление файла ВОР у завершённой расценки снова упирается в закрытие).
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

ALTER TABLE public.tender_supply_sources DROP COLUMN IF EXISTS prior_document_ids;
ALTER TABLE public.tender_supply_sources DROP COLUMN IF EXISTS separate_at;
ALTER TABLE public.tender_supply_sources DROP COLUMN IF EXISTS separate_by;

COMMIT;
