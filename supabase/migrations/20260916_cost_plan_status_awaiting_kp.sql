-- План затрат: статус «Ожидание КП» (awaiting_kp) между «В работе» и «Завершён».
-- План посчитан, но закрыть его нельзя, пока не пришли КП подрядчиков.
-- Данные не меняются: существующие строки остаются в своих статусах.
--
-- Старое ограничение снимаем НЕ по имени: в миграциях оно называется
-- valid_cost_plan_status, но если в базе его когда-то создали иначе (например,
-- автоимя tenders_cost_plan_status_check), DROP ... IF EXISTS по имени промолчит,
-- и старый CHECK продолжит отклонять новый статус. Поэтому удаляем любые
-- CHECK-ограничения таблицы tenders, которые проверяют cost_plan_status.

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'public.tenders'::regclass
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%cost_plan_status%'
  LOOP
    EXECUTE format('ALTER TABLE public.tenders DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.tenders
  ADD CONSTRAINT valid_cost_plan_status
  CHECK (cost_plan_status IN ('not_started', 'in_progress', 'awaiting_kp', 'completed', 'not_required'));

COMMENT ON COLUMN public.tenders.cost_plan_status IS
  'Статус плана затрат: not_started | in_progress | awaiting_kp | completed | not_required';
