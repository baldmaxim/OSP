-- Ссылка на документ (чек, счёт, КП поставщика) к позиции расценки снабжением на сайте (колонка «Документ»
-- таблицы расценки: вкладка «Расценки снабжения» карточки и страница /tenders/materials/:id/pricing).
--
--  • tender_supply_links — одна ссылка на позицию ВОР основного тендера: (tender_id, estimate_name, ключ
--    наименования material_key = supply_norm_name(material_name)), как у цен. Ссылка живёт отдельно от цены
--    (решение пользователя 19.10): её можно приложить до ввода цены, и она остаётся, если цену очистили.
--    Адрес — http(s) или сетевой путь \\сервер\папка; кто и когда изменил — триггером.
--  • Права — как у цен: читает сотрудник, пишет «Тендеры» или «Тендеры на материалы» с правкой; тендер на
--    материалы «Завершён» — только чтение (тот же триггер закрытия tender_supply_guard).
--  • supply_estimate_rename переносит на другое имя ВОР и ссылки.
--
-- Только добавление, повтор безопасен. База нового портала — migration/yandex/20261022_supply_links.sql
-- (те же объекты, права под одну учётку). Требует 20261020_supply_pricing.
BEGIN;

-- ── 1. Ссылки ────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tender_supply_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
  estimate_name text NOT NULL CHECK (btrim(estimate_name) <> ''),
  material_name text NOT NULL CHECK (btrim(material_name) <> ''),
  material_key text GENERATED ALWAYS AS (public.supply_norm_name(material_name)) STORED,
  url text NOT NULL CHECK (length(url) <= 2000 AND url ~* '^(https?://\S|\\\\\S)'),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tender_id, estimate_name, material_key)
);
COMMENT ON TABLE public.tender_supply_links IS
  'Ссылка на документ (чек, счёт, КП поставщика) к позиции расценки снабжением: основной тендер, ВОР и ключ наименования';
COMMENT ON COLUMN public.tender_supply_links.url IS 'Адрес http(s) или сетевой путь \\сервер\папка';

CREATE OR REPLACE FUNCTION public.tender_supply_links_touch() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.url := btrim(NEW.url);
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS tender_supply_links_touch ON public.tender_supply_links;
CREATE TRIGGER tender_supply_links_touch
  BEFORE INSERT OR UPDATE ON public.tender_supply_links
  FOR EACH ROW EXECUTE FUNCTION public.tender_supply_links_touch();

DROP TRIGGER IF EXISTS tender_supply_links_guard ON public.tender_supply_links;
CREATE TRIGGER tender_supply_links_guard
  AFTER INSERT OR UPDATE OR DELETE ON public.tender_supply_links
  FOR EACH ROW EXECUTE FUNCTION public.tender_supply_guard();

-- ── 2. Перенос ВОР на другое имя — вместе со ссылками ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.supply_estimate_rename(p_tender uuid, p_from text, p_to text) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_rates integer;
  v_sources integer;
  v_links integer;
BEGIN
  IF NOT public.supply_can_edit() THEN
    RAISE EXCEPTION 'Нет права менять расценки снабжения' USING ERRCODE = '42501';
  END IF;
  IF coalesce(btrim(p_to), '') = '' OR p_from IS NULL THEN
    RAISE EXCEPTION 'Не задано имя ВОР' USING ERRCODE = '22023';
  END IF;
  IF p_from = p_to THEN
    RETURN jsonb_build_object('rates', 0, 'sources', 0, 'links', 0);
  END IF;
  IF EXISTS (SELECT 1 FROM public.tender_vor_supply_rates a
             JOIN public.tender_vor_supply_rates b
               ON b.tender_id = a.tender_id AND b.estimate_name = p_to AND b.material_key = a.material_key
             WHERE a.tender_id = p_tender AND a.estimate_name = p_from) THEN
    RAISE EXCEPTION 'В ВОР «%» уже есть цены на те же материалы — перенести автоматически нельзя', p_to
      USING ERRCODE = '23505', HINT = 'supply_rename_overlap';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tender_supply_links a
             JOIN public.tender_supply_links b
               ON b.tender_id = a.tender_id AND b.estimate_name = p_to AND b.material_key = a.material_key
             WHERE a.tender_id = p_tender AND a.estimate_name = p_from) THEN
    RAISE EXCEPTION 'В ВОР «%» уже есть ссылки на документы тех же материалов — перенести автоматически нельзя', p_to
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
  UPDATE public.tender_supply_links SET estimate_name = p_to WHERE tender_id = p_tender AND estimate_name = p_from;
  GET DIAGNOSTICS v_links = ROW_COUNT;
  RETURN jsonb_build_object('rates', v_rates, 'sources', v_sources, 'links', v_links);
END
$$;

-- ── 3. Права ─────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.tender_supply_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supply_links_read ON public.tender_supply_links;
CREATE POLICY supply_links_read ON public.tender_supply_links FOR SELECT TO authenticated
  USING ((SELECT public.osp_is_employee()));
DROP POLICY IF EXISTS supply_links_insert ON public.tender_supply_links;
CREATE POLICY supply_links_insert ON public.tender_supply_links FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.supply_can_edit()));
DROP POLICY IF EXISTS supply_links_update ON public.tender_supply_links;
CREATE POLICY supply_links_update ON public.tender_supply_links FOR UPDATE TO authenticated
  USING ((SELECT public.supply_can_edit())) WITH CHECK ((SELECT public.supply_can_edit()));
DROP POLICY IF EXISTS supply_links_delete ON public.tender_supply_links;
CREATE POLICY supply_links_delete ON public.tender_supply_links FOR DELETE TO authenticated
  USING ((SELECT public.supply_can_edit()));

-- Новые таблицы и функции Supabase по умолчанию выдаёт анониму — снимаем всё явно.
REVOKE ALL ON TABLE public.tender_supply_links FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tender_supply_links TO authenticated;
GRANT ALL ON TABLE public.tender_supply_links TO service_role;
REVOKE ALL ON FUNCTION public.tender_supply_links_touch() FROM PUBLIC, anon;

COMMIT;
