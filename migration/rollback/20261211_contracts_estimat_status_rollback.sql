-- АВАРИЙНЫЙ ОТКАТ 20261211_contracts_estimat_status: реестр «Договоры и ДС» снова без плашки Estimat
-- (страница работает как до миграции: колонки нет — плашки нет).
-- ВНИМАНИЕ: теряются выставленные отметки. Перед откатом снимите их выгрузкой:
--   select id, estimat_status, estimat_status_at, estimat_status_by from public.contracts where estimat_status <> 'none';
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_estimat_status_check;
ALTER TABLE public.contracts
  DROP COLUMN IF EXISTS estimat_status,
  DROP COLUMN IF EXISTS estimat_status_at,
  DROP COLUMN IF EXISTS estimat_status_by;

COMMIT;
