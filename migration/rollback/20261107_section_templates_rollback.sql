-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261107_section_templates.sql (Supabase): карточки шаблонов в «Документах»
-- тендеров и заявок на ДС перестают видеть файл (покажут, что прикрепить его можно после обновления базы).
-- Данные НЕ удаляются: таблица и файлы шаблонов (s3_documents) остаются — повторное применение миграции вернёт
-- те же строки с теми же id, и прикреплённые файлы снова появятся. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF to_regclass('public.section_templates') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.section_templates FROM authenticated;
  END IF;
END
$$;

COMMIT;
