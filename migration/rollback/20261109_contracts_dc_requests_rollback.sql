-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261109_contracts_dc_requests.sql (Supabase): заявки на ДС снова без договора,
-- ДС реестра договоров и подразделения (страница работает как до миграции: «№ ДС» одной строкой, без фильтра по
-- подразделению); «Шаблон ДГП» в «Документах» договоров покажет, что прикрепить файл можно после обновления базы.
-- ВНИМАНИЕ: выбранные в заявках договоры, ДС и подразделения теряются — перед откатом снимите их выгрузкой:
--   select id, contract_id, amendment_id, division from public.dc_requests
--   where contract_id is not null or amendment_id is not null or division is not null;
-- Строка шаблона и его файл не удаляются (повторное применение миграции вернёт плитку с тем же файлом).
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP INDEX IF EXISTS public.idx_dc_requests_contract;
DROP INDEX IF EXISTS public.idx_dc_requests_amendment;
ALTER TABLE public.dc_requests DROP CONSTRAINT IF EXISTS dc_requests_division_check;
ALTER TABLE public.dc_requests DROP COLUMN IF EXISTS contract_id;
ALTER TABLE public.dc_requests DROP COLUMN IF EXISTS amendment_id;
ALTER TABLE public.dc_requests DROP COLUMN IF EXISTS division;

COMMIT;
