-- «Планы затрат» → «Документы» → «Расчёт ПЗ» (решение пользователя 29.10.2026):
--  • подвкладки «Прямые затраты» и «КП до перекидок» — списки файлов (шаблоны и образцы расчёта). Якорь списка —
--    строка section_templates (cost_plan_direct_costs, cost_plan_kp_before_transfers), файлы — s3_documents
--    (owner_type 'general', owner_id = id строки, doc_category 'cost_plan_calc'). Загружает и удаляет только
--    администратор — то же правило, что у шаблонов разделов (osp-api: WRITE_RULES.section_templates). Нужна
--    20261107_section_templates; без неё строки не заводятся (вкладка подскажет про обновление базы).
--  • cost_plan_compensation — компенсация НДС и инфляции по объекту: строка = объект (одна на объект), сведения
--    текстом (сколько компенсировано, по какому ДС, с какой даты). Учитываются в каждом плане затрат объекта.
--    Удаление объекта удаляет и сведения. Кто и когда изменил — триггером. Читает сотрудник, вносит и меняет
--    только администратор (is_admin()).
--
-- Только добавление, повтор безопасен. Пока миграции нет, вкладка «Расчёт ПЗ» подсказывает про обновление базы.
-- База нового портала — migration/yandex/20261116_cost_plan_calc.sql.
-- Проверка: migration/backup/checks/20261116.sql, откат — migration/rollback/20261116_cost_plan_calc_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

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

-- ── Права ────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.cost_plan_compensation ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cost_plan_compensation_read ON public.cost_plan_compensation;
CREATE POLICY cost_plan_compensation_read ON public.cost_plan_compensation FOR SELECT TO authenticated
  USING ((SELECT public.osp_is_employee()));
DROP POLICY IF EXISTS cost_plan_compensation_insert ON public.cost_plan_compensation;
CREATE POLICY cost_plan_compensation_insert ON public.cost_plan_compensation FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.is_admin()));
DROP POLICY IF EXISTS cost_plan_compensation_update ON public.cost_plan_compensation;
CREATE POLICY cost_plan_compensation_update ON public.cost_plan_compensation FOR UPDATE TO authenticated
  USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));
DROP POLICY IF EXISTS cost_plan_compensation_delete ON public.cost_plan_compensation;
CREATE POLICY cost_plan_compensation_delete ON public.cost_plan_compensation FOR DELETE TO authenticated
  USING ((SELECT public.is_admin()));

-- Новые таблицы и функции Supabase по умолчанию выдаёт анониму — снимаем всё явно.
REVOKE ALL ON TABLE public.cost_plan_compensation FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cost_plan_compensation TO authenticated;
GRANT ALL ON TABLE public.cost_plan_compensation TO service_role;
REVOKE ALL ON FUNCTION public.cost_plan_compensation_touch() FROM PUBLIC, anon;

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

COMMIT;
