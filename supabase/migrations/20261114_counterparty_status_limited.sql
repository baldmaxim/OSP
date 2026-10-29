-- Контрагенты: жёлтый статус «Малые суммы» — привлекать можно, но только на небольшие суммы (решение пользователя 29.10.2026).
--
--  • counterparty_status получает значение limited (между active и blacklist). Такой контрагент остаётся во вкладке
--    «Активные» реестра /general/counterparties; подписи и разбор — src/utils/counterpartyStatus.js.
--  • Только добавление значения: строки не меняются, права и политики не трогаются, повтор безопасен.
--  • ADD VALUE внутри транзакции допустим (PostgreSQL 12+), новое значение до COMMIT здесь не используется.
--
-- База нового портала (Яндекс) — migration/yandex/20261114_counterparty_status_limited.sql.
-- Проверка: migration/backup/checks/20261114.sql; откат — migration/rollback/20261114_counterparty_status_limited_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TYPE public.counterparty_status ADD VALUE IF NOT EXISTS 'limited' BEFORE 'blacklist';

COMMENT ON COLUMN public.counterparties.status IS
  'Статус контрагента: active — действующий, limited — «Малые суммы» (привлекать только на небольшие суммы), blacklist — чёрный список';

COMMIT;
