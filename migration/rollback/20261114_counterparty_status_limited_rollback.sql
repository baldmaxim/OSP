-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261114_counterparty_status_limited.sql (Supabase): контрагенты «Малые суммы»
-- снова действующие (как до миграции, у прежнего портала такого статуса нет).
-- Само значение limited в ENUM остаётся: PostgreSQL не удаляет значения ENUM без пересоздания типа, а лишнее
-- неиспользуемое значение ничему не мешает. Повторная миграция его просто найдёт (IF NOT EXISTS).
-- ВНИМАНИЕ: отметки «Малые суммы» теряются — перед откатом снимите их выгрузкой:
--   select id, name, inn from public.counterparties where status::text = 'limited';
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

UPDATE public.counterparties SET status = 'active' WHERE status::text = 'limited';

COMMENT ON COLUMN public.counterparties.status IS 'Статус контрагента (действующий/черный список)';

COMMIT;
