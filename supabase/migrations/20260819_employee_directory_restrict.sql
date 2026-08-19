-- Ограничение справочника сотрудников employee_directory только сотрудниками СУ-10.
--
-- Проблема. Вью создано в 20260818_tasks_foundation.sql намеренно как SECURITY
-- DEFINER (security_invoker = false по умолчанию): политика
-- user_roles_select_self_or_admin отдаёт обычному сотруднику ТОЛЬКО его строку,
-- и без обхода RLS выпадающий список исполнителей задач пуст у всех, кроме
-- админа. Но GRANT SELECT ... TO authenticated означает ЛЮБОГО залогиненного,
-- а подрядчики — такие же пользователи Supabase Auth (user_roles.counterparty_id
-- заполнен, см. 20260815_contract_negotiation_foundation.sql). То есть логин
-- подрядчика мог прямым запросом к API прочитать ФИО, рабочие почты и роли
-- сотрудников СУ-10. Через UI он туда не попадал, но защиты на уровне БД не было.
--
-- Решение. Добавляем в WHERE проверку is_negotiation_employee() (функция из
-- 20260815): справочник отдаётся только подтверждённому пользователю без
-- привязки к контрагенту. Для подрядчика вью возвращает пустой результат.
--
-- Предупреждение Supabase Advisor «View is defined with the SECURITY DEFINER
-- property» после этой миграции ОСТАНЕТСЯ: правило срабатывает на само свойство
-- вью, а не на то, что через него доступно. Убрать его можно только переводом на
-- security_invoker = true, но тогда потребуется отдельная политика на user_roles
-- («сотрудник видит строки других сотрудников») — это трогает RLS ключевой
-- таблицы прав, поэтому сознательно оставляем текущую модель.
--
-- Миграция идемпотентна. Набор и порядок колонок не меняются, поэтому
-- CREATE OR REPLACE VIEW проходит; выданные ранее GRANT сохраняются, но
-- дублируем их ниже на случай применения до 20260818.

CREATE OR REPLACE VIEW public.employee_directory
-- security_barrier: не даёт «протащить» дешёвую пользовательскую функцию в
-- условие запроса и через неё увидеть отфильтрованные строки. Справочник
-- маленький (десятки строк), потерей push-down предикатов можно пренебречь.
WITH (security_barrier = true) AS
  SELECT
    ur.user_id,
    ur.role,
    COALESCE(NULLIF(ur.full_name, ''), ur.email) AS display_name,
    ur.full_name,
    ur.email
  FROM public.user_roles ur
  WHERE ur.is_approved = true
    AND ur.counterparty_id IS NULL
    AND ur.role <> 'contractor'
    -- Читать справочник может только сотрудник СУ-10, но не подрядчик.
    AND public.is_negotiation_employee();

REVOKE ALL ON public.employee_directory FROM anon;
GRANT SELECT ON public.employee_directory TO authenticated;

COMMENT ON VIEW public.employee_directory IS
  'Справочник сотрудников СУ-10 (подтверждённые логины без привязки к контрагенту) для выбора исполнителя задач. Виден только сотрудникам: для логина подрядчика возвращает пустой результат';
