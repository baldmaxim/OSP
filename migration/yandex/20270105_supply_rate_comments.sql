-- Комментарий к расценке позиции снабжением (колонка «Комментарий» справа в таблице расценки). Тело
-- supabase/migrations/20270105_supply_rate_comments.sql: та же таблица, триггеры и функция (тексты совпадают —
-- сторожит tests/supply/migrations.test.mjs), иначе — только права под одну учётку:
--  • правила по строкам включены и действуют на владельца, служебные операции — пропуском;
--  • читает сотрудник (osp_is_employee), пишет «Тендеры: редактирование» или «Тендеры на материалы:
--    редактирование» (supply_can_edit) — как цены и документы позиций;
--  • тендер на материалы «Завершён» — комментарии только для чтения (тот же триггер закрытия, что у цен).
-- Один комментарий на позицию тендера — по ключу наименования, без имени ВОР: в таблице одна строка на позицию всех
-- ВОР. Пустой не хранится. Повтор безопасен. Требует 20261020_supply_pricing.

CREATE TABLE IF NOT EXISTS public.tender_supply_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
  material_name text NOT NULL CHECK (btrim(material_name) <> ''),
  material_key text GENERATED ALWAYS AS (public.supply_norm_name(material_name)) STORED,
  comment text NOT NULL CHECK (btrim(comment) <> '' AND length(comment) <= 2000),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tender_id, material_key)
);
COMMENT ON TABLE public.tender_supply_comments IS
  'Комментарий к расценке позиции снабжением: основной тендер и ключ наименования (одна строка на позицию всех ВОР)';

CREATE OR REPLACE FUNCTION public.tender_supply_comments_touch() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.comment := btrim(NEW.comment);
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS tender_supply_comments_touch ON public.tender_supply_comments;
CREATE TRIGGER tender_supply_comments_touch
  BEFORE INSERT OR UPDATE ON public.tender_supply_comments
  FOR EACH ROW EXECUTE FUNCTION public.tender_supply_comments_touch();

DROP TRIGGER IF EXISTS tender_supply_comments_guard ON public.tender_supply_comments;
CREATE TRIGGER tender_supply_comments_guard
  AFTER INSERT OR UPDATE OR DELETE ON public.tender_supply_comments
  FOR EACH ROW EXECUTE FUNCTION public.tender_supply_guard();

-- ── Права под одну учётку ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.tender_supply_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tender_supply_comments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS osp_internal ON public.tender_supply_comments;
CREATE POLICY osp_internal ON public.tender_supply_comments FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

-- Пропуск → да; иначе роль из токена и условие (как TO authenticated USING (…) на проде).
DROP POLICY IF EXISTS supply_comments_read ON public.tender_supply_comments;
CREATE POLICY supply_comments_read ON public.tender_supply_comments FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_is_employee())) END);
DROP POLICY IF EXISTS supply_comments_insert ON public.tender_supply_comments;
CREATE POLICY supply_comments_insert ON public.tender_supply_comments FOR INSERT TO PUBLIC
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.supply_can_edit())) END);
DROP POLICY IF EXISTS supply_comments_update ON public.tender_supply_comments;
CREATE POLICY supply_comments_update ON public.tender_supply_comments FOR UPDATE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.supply_can_edit())) END)
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.supply_can_edit())) END);
DROP POLICY IF EXISTS supply_comments_delete ON public.tender_supply_comments;
CREATE POLICY supply_comments_delete ON public.tender_supply_comments FOR DELETE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.supply_can_edit())) END);

INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'tender_supply_comments', 'supply_comments_read', ARRAY['authenticated']),
  ('public', 'tender_supply_comments', 'supply_comments_insert', ARRAY['authenticated']),
  ('public', 'tender_supply_comments', 'supply_comments_update', ARRAY['authenticated']),
  ('public', 'tender_supply_comments', 'supply_comments_delete', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;
-- osp:allow table tender_supply_comments authenticated=select,insert,update,delete
