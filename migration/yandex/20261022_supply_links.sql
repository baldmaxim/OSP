-- Ссылка на документ (чек, счёт, КП поставщика) к позиции расценки снабжением. Тело
-- supabase/migrations/20261022_supply_links.sql: та же таблица, триггеры и функции (тексты функций совпадают —
-- сторожит tests/supply/migrations.test.mjs), иначе — только права под одну учётку:
--  • правила по строкам включены и действуют на владельца, служебные операции — пропуском;
--  • читает сотрудник (osp_is_employee), пишет «Тендеры: редактирование» или «Тендеры на материалы:
--    редактирование» (supply_can_edit) — как цены;
--  • тендер на материалы «Завершён» — ссылки только для чтения (тот же триггер закрытия, что у цен).
-- Ссылка живёт отдельно от цены (решение пользователя 19.10): её можно приложить до ввода цены, и она
-- остаётся, если цену очистили. Одна ссылка на позицию ВОР — по ключу наименования, как у цен.
-- Повтор безопасен.

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

-- ── 3. Права под одну учётку ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.tender_supply_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tender_supply_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS osp_internal ON public.tender_supply_links;
CREATE POLICY osp_internal ON public.tender_supply_links FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

-- Пропуск → да; иначе роль из токена и условие (как TO authenticated USING (…) на проде).
DROP POLICY IF EXISTS supply_links_read ON public.tender_supply_links;
CREATE POLICY supply_links_read ON public.tender_supply_links FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_is_employee())) END);
DROP POLICY IF EXISTS supply_links_insert ON public.tender_supply_links;
CREATE POLICY supply_links_insert ON public.tender_supply_links FOR INSERT TO PUBLIC
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.supply_can_edit())) END);
DROP POLICY IF EXISTS supply_links_update ON public.tender_supply_links;
CREATE POLICY supply_links_update ON public.tender_supply_links FOR UPDATE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.supply_can_edit())) END)
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.supply_can_edit())) END);
DROP POLICY IF EXISTS supply_links_delete ON public.tender_supply_links;
CREATE POLICY supply_links_delete ON public.tender_supply_links FOR DELETE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.supply_can_edit())) END);

INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'tender_supply_links', 'supply_links_read', ARRAY['authenticated']),
  ('public', 'tender_supply_links', 'supply_links_insert', ARRAY['authenticated']),
  ('public', 'tender_supply_links', 'supply_links_update', ARRAY['authenticated']),
  ('public', 'tender_supply_links', 'supply_links_delete', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;
-- osp:allow table tender_supply_links authenticated=select,insert,update,delete
