-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261104_company_departments.sql (Supabase): страница «Отделы» перестаёт
-- получать данные (покажет, что раздел появится после обновления базы).
-- Данные НЕ удаляются: таблица остаётся (без прав у вошедших) — повторное применение миграции продолжит с ней,
-- внесённые руководители и телефоны сохранятся. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF to_regclass('public.company_departments') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.company_departments FROM authenticated;
  END IF;
END
$$;

COMMIT;
