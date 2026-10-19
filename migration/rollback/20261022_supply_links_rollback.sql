-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261022_supply_links.sql (Supabase): колонка «Документ» расценки
-- перестаёт работать (страница покажет, что раздел не включён), перенос ВОР — снова без ссылок.
-- Данные НЕ удаляются: таблица ссылок остаётся (без прав у вошедших) — повторное применение миграции
-- продолжит с ней. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS tender_supply_links_guard ON public.tender_supply_links;
DROP TRIGGER IF EXISTS tender_supply_links_touch ON public.tender_supply_links;
REVOKE ALL ON TABLE public.tender_supply_links FROM authenticated;

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

COMMIT;
