-- АВАРИЙНЫЙ ОТКАТ 20270104_dc_request_amounts_vor: «Заявки на ДС» снова с двумя суммами (страница работает как до
-- миграции: колонок нет — только верхняя часть блока, «ДС подрядчика» не вводится).
-- Суммы ВОР возвращаются в amount_before / amount_after там, где верхняя часть пуста (перенесённые миграцией — все).
-- ВНИМАНИЕ: теряются «ДС подрядчика» и суммы ВОР у заявок, где заполнены обе части. Перед откатом снимите их:
--   select id, request_number, ds_type, amount_before, amount_contractor, amount_after, vor_amount_before, vor_amount_after
--   from public.dc_requests
--   where amount_contractor is not null or vor_amount_before is not null or vor_amount_after is not null;
-- Записи истории о переносе остаются. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'dc_requests' AND column_name = 'vor_amount_before') THEN
    UPDATE public.dc_requests
    SET amount_before = vor_amount_before, amount_after = vor_amount_after
    WHERE amount_before IS NULL AND amount_after IS NULL
      AND (vor_amount_before IS NOT NULL OR vor_amount_after IS NOT NULL);
  END IF;
END $$;

ALTER TABLE public.dc_requests
  DROP COLUMN IF EXISTS vor_amount_before,
  DROP COLUMN IF EXISTS vor_amount_after,
  DROP COLUMN IF EXISTS amount_contractor;

COMMIT;
