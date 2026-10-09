-- Р2-0 (срочно): представление employee_directory — только чтение.
--
-- ПРОБЛЕМА. employee_directory — представление над одной таблицей user_roles, поэтому PostgreSQL
-- позволяет писать в него (INSERT/UPDATE/DELETE переводятся в user_roles). Представление работает с
-- правами владельца, а владелец таблицы обходит её RLS; у authenticated на представление GRANT ALL.
-- Итог: любой одобренный сотрудник одним запросом к API мог выдать себе role = 'admin' или изменить и
-- удалить чужие строки user_roles. Подтверждено на копии прода (test:db, osp_test.self_promote).
--
-- РЕШЕНИЕ. Отозвать запись. Чтение не трогаем (интерфейс только читает: src/services/employees.js),
-- поэтому окна, когда список сотрудников недоступен, нет. service_role прав не теряет.
--
-- Миграция идемпотентна, данные не трогает.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.employee_directory FROM PUBLIC, anon, authenticated;

COMMENT ON VIEW public.employee_directory IS
  'Справочник сотрудников для выбора в интерфейсе. Только чтение: запись через представление шла бы в user_roles мимо RLS (миграция 20261009).';
