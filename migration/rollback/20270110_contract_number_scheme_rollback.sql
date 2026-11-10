-- АВАРИЙНЫЙ ОТКАТ 20270110_contract_number_scheme: форма договора снова без номера по схеме (страница работает как до
-- миграции: колонки кода нет — подставляет прежний «следующий номер»), номера по схеме снова могут повторяться.
-- Номера договоров НЕ меняются — выданные номера остаются в contracts.contract_number.
-- ВНИМАНИЕ: теряются коды объектов и счётчики. Перед откатом снимите их выгрузкой:
--   select id, name, contract_code from public.objects where contract_code is not null;
--   select * from public.contract_number_counters;
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS contracts_number_counter ON public.contracts;
DROP FUNCTION IF EXISTS public.contracts_number_counter();
DROP INDEX IF EXISTS public.contracts_scheme_number_uniq;
DROP TABLE IF EXISTS public.contract_number_counters;

DROP TRIGGER IF EXISTS objects_contract_code_guard ON public.objects;
DROP FUNCTION IF EXISTS public.objects_contract_code_guard();
DROP INDEX IF EXISTS public.objects_contract_code_uniq;
ALTER TABLE public.objects DROP CONSTRAINT IF EXISTS objects_contract_code_check;
ALTER TABLE public.objects DROP COLUMN IF EXISTS contract_code;

DROP FUNCTION IF EXISTS public.contract_number_key(text);
DROP FUNCTION IF EXISTS public.contract_code_key(text);
DROP FUNCTION IF EXISTS public.contract_code_norm(text);

COMMIT;
