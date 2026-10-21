-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261031_counterparty_contract_links.sql (Supabase): раздел «Договоры и ДС»
-- карточки контрагента показывает договоры, где контрагент — сторона, как до миграции; кнопки «Прикрепить договор»
-- нет, прикреплённые вручную договоры не видны.
-- Данные НЕ удаляются: таблица остаётся (без прав у вошедших) — повторное применение миграции продолжит с ней.
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF to_regclass('public.counterparty_contract_links') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.counterparty_contract_links FROM authenticated;
  END IF;
END
$$;

COMMIT;
