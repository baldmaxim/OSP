-- АВАРИЙНЫЙ ОТКАТ 20261225_counterparty_number: реестр контрагентов снова без постоянного номера в базе и без фильтра
-- «С регистрацией» (страница работает как до миграции: номер считает сама, функции нет — нет ни кнопки, ни столбца).
-- ВНИМАНИЕ: номера теряются, повторная миграция выдаст их заново и у новых контрагентов они могут измениться. Перед откатом
-- снимите их выгрузкой:
--   select id, counterparty_number from public.counterparties order by counterparty_number;
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.counterparty_site_accounts();
DROP INDEX IF EXISTS public.counterparties_number_key;
ALTER TABLE public.counterparties DROP COLUMN IF EXISTS counterparty_number;

COMMIT;
