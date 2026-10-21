-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261027_vor_rd_sets.sql (Supabase): раскрывающийся список комплектов
-- РД в «ВОРах и РД» перестаёт работать (страница покажет, что список появится после обновления базы).
-- Данные НЕ удаляются: таблица остаётся (без прав у вошедших) — повторное применение миграции продолжит с
-- ней. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF to_regclass('public.vor_rd_sets') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.vor_rd_sets FROM authenticated;
  END IF;
END
$$;

COMMIT;
