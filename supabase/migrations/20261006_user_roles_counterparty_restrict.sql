-- Запрет удалять контрагента, к которому привязаны логины подрядчиков.
--
-- ПРОБЛЕМА. user_roles.counterparty_id ссылается на counterparties с
-- ON DELETE SET NULL (миграция 20260815). А «counterparty_id IS NULL» — это и
-- есть признак сотрудника СУ-10 (is_portal_employee). Поэтому окончательное
-- удаление контрагента превращает его подтверждённых подрядчиков в сотрудников
-- с полным доступом. Таблица counterparties пока открыта на запись любому
-- вошедшему (USING (true)), то есть подрядчик может удалить свою организацию
-- прямым запросом к REST и сам получить права сотрудника.
--
-- РЕШЕНИЕ. ON DELETE RESTRICT: пока к организации привязан хоть один логин,
-- база не даст её удалить (ошибка 23503). Сначала отвязать или удалить логины
-- в «Администрировании», потом удалять контрагента. Мягкое удаление (deleted_at)
-- не затрагивается.
--
-- Миграция идемпотентна: ограничение пересоздаётся, только если сейчас оно не
-- RESTRICT.
DO $mig$
DECLARE
  c record;
BEGIN
  IF to_regclass('public.user_roles') IS NULL OR to_regclass('public.counterparties') IS NULL THEN
    RETURN;
  END IF;

  FOR c IN
    SELECT k.conname, k.confdeltype
    FROM pg_constraint k
    JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
    WHERE k.conrelid = 'public.user_roles'::regclass
      AND k.contype = 'f'
      AND k.confrelid = 'public.counterparties'::regclass
      AND a.attname = 'counterparty_id'
  LOOP
    IF c.confdeltype <> 'r' THEN
      EXECUTE format('ALTER TABLE public.user_roles DROP CONSTRAINT %I', c.conname);
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint k
    JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
    WHERE k.conrelid = 'public.user_roles'::regclass
      AND k.contype = 'f'
      AND k.confrelid = 'public.counterparties'::regclass
      AND a.attname = 'counterparty_id'
  ) THEN
    ALTER TABLE public.user_roles
      ADD CONSTRAINT user_roles_counterparty_id_fkey
      FOREIGN KEY (counterparty_id) REFERENCES public.counterparties(id) ON DELETE RESTRICT;
  END IF;
END $mig$;

COMMENT ON COLUMN public.user_roles.counterparty_id IS
  'Организация-контрагент, к которой привязан логин (NULL = сотрудник СУ-10). ON DELETE RESTRICT: удаление организации не должно превращать её логины в сотрудников';
