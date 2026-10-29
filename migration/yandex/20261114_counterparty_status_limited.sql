-- Контрагенты: жёлтый статус «Малые суммы». Тело supabase/migrations/20261114_counterparty_status_limited.sql:
-- новое значение ENUM той же колонки counterparties.status — правила по строкам и список шлюза не меняются.
--  • limited — привлекать можно, но только на небольшие суммы; в реестре — во вкладке «Активные».
-- Только добавление значения, строки не меняются, повтор безопасен. ADD VALUE в транзакции migrate.sh допустим
-- (PostgreSQL 12+): до COMMIT значение не используется — проверка читает только каталог.
ALTER TYPE public.counterparty_status ADD VALUE IF NOT EXISTS 'limited' BEFORE 'blacklist';

COMMENT ON COLUMN public.counterparties.status IS
  'Статус контрагента: active — действующий, limited — «Малые суммы» (привлекать только на небольшие суммы), blacklist — чёрный список';
