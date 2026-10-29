-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261116_cost_plan_calc.sql (Supabase): блок «Компенсация НДС и инфляции по
-- объектам» перестаёт получать данные (покажет, что сведения появятся после обновления базы). Данные НЕ удаляются:
-- таблица остаётся (без прав у вошедших) — повторное применение миграции продолжит с ней, сведения сохранятся.
-- Якоря файлов «Расчёта ПЗ» (строки section_templates) и сами файлы не трогаются: загружать и удалять их может
-- только администратор, убирать их незачем. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF to_regclass('public.cost_plan_compensation') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.cost_plan_compensation FROM authenticated;
  END IF;
END
$$;

COMMIT;
