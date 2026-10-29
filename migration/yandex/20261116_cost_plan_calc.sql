-- «Планы затрат» → «Документы» → «Расчёт ПЗ»: якоря файлов подвкладок «Прямые затраты» и «КП до перекидок»
-- (строки section_templates) и компенсация НДС и инфляции по объектам. Тело
-- supabase/migrations/20261116_cost_plan_calc.sql: та же таблица, триггер и строки шаблонов, иначе — только права
-- под одну учётку:
--  • правила по строкам включены и действуют на владельца, служебные операции — пропуском;
--  • читает сотрудник (osp_is_employee), вносит и меняет только администратор (is_admin).
-- Строки section_templates — той же таблицы, её права и список шлюза не меняются (без 20261107 не заводятся).
-- Только добавление, повтор безопасен.

CREATE TABLE IF NOT EXISTS public.cost_plan_compensation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES public.objects(id) ON DELETE CASCADE,
  vat_note text CHECK (vat_note IS NULL OR length(vat_note) <= 2000),
  inflation_note text CHECK (inflation_note IS NULL OR length(inflation_note) <= 2000),
  created_by uuid DEFAULT auth.uid(),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cost_plan_compensation_object_key UNIQUE (object_id)
);
COMMENT ON TABLE public.cost_plan_compensation IS
  'Компенсация НДС и инфляции по объекту — учитывается в каждом плане затрат объекта («Планы затрат» → «Документы» → «Расчёт ПЗ»)';

CREATE OR REPLACE FUNCTION public.cost_plan_compensation_touch() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS cost_plan_compensation_touch ON public.cost_plan_compensation;
CREATE TRIGGER cost_plan_compensation_touch
  BEFORE INSERT OR UPDATE ON public.cost_plan_compensation
  FOR EACH ROW EXECUTE FUNCTION public.cost_plan_compensation_touch();

-- ── Права под одну учётку ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.cost_plan_compensation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cost_plan_compensation FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS osp_internal ON public.cost_plan_compensation;
CREATE POLICY osp_internal ON public.cost_plan_compensation FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

-- Пропуск → да; иначе роль из токена и условие (как TO authenticated USING (…) на проде).
DROP POLICY IF EXISTS cost_plan_compensation_read ON public.cost_plan_compensation;
CREATE POLICY cost_plan_compensation_read ON public.cost_plan_compensation FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_is_employee())) END);
DROP POLICY IF EXISTS cost_plan_compensation_insert ON public.cost_plan_compensation;
CREATE POLICY cost_plan_compensation_insert ON public.cost_plan_compensation FOR INSERT TO PUBLIC
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.is_admin())) END);
DROP POLICY IF EXISTS cost_plan_compensation_update ON public.cost_plan_compensation;
CREATE POLICY cost_plan_compensation_update ON public.cost_plan_compensation FOR UPDATE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.is_admin())) END)
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.is_admin())) END);
DROP POLICY IF EXISTS cost_plan_compensation_delete ON public.cost_plan_compensation;
CREATE POLICY cost_plan_compensation_delete ON public.cost_plan_compensation FOR DELETE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.is_admin())) END);

INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'cost_plan_compensation', 'cost_plan_compensation_read', ARRAY['authenticated']),
  ('public', 'cost_plan_compensation', 'cost_plan_compensation_insert', ARRAY['authenticated']),
  ('public', 'cost_plan_compensation', 'cost_plan_compensation_update', ARRAY['authenticated']),
  ('public', 'cost_plan_compensation', 'cost_plan_compensation_delete', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;
-- osp:allow table cost_plan_compensation authenticated=select,insert,update,delete

-- ── Якоря файлов «Расчёта ПЗ» ────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.section_templates') IS NOT NULL THEN
    INSERT INTO public.section_templates (code, title) VALUES
      ('cost_plan_direct_costs', 'Расчёт ПЗ: прямые затраты'),
      ('cost_plan_kp_before_transfers', 'Расчёт ПЗ: КП до перекидок')
    ON CONFLICT (code) DO NOTHING;
  END IF;
END
$$;
