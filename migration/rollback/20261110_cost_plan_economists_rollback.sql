-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261110_cost_plan_economists.sql (Supabase): вкладка «Экономисты ОСП»
-- перестаёт получать данные (покажет, что раздел появится после обновления базы), форма тендера ничего не
-- подставляет. Данные НЕ удаляются: таблица остаётся (без прав у вошедших) — повторное применение миграции
-- продолжит с ней, назначения сохранятся. Ответственные уже созданных тендеров не меняются. Одной транзакцией,
-- повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF to_regclass('public.cost_plan_economists') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.cost_plan_economists FROM authenticated;
  END IF;
END
$$;

COMMIT;
