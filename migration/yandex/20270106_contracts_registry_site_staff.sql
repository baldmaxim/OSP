-- «Реестр по договорам» для сотрудников объекта (решение пользователя 10.11.2026). Тело supabase/migrations/20270106_contracts_registry_site_staff.sql,
-- там же зачем и как: руководитель строительства и экономист объекта — «Договоры»: просмотр без правки (страница показывает им
-- только договоры своих объектов и даёт подать заявку на заключение ДП). Только строки role_permissions: правила по строкам,
-- функции и данные не меняются, блокировок, кроме строк справочника прав, нет. Повтор безопасен.

INSERT INTO public.role_permissions (role, section, can_view, can_edit)
SELECT r.key, 'contracts', true, false
FROM public.roles r
WHERE r.key IN ('construction_manager', 'economist_object')
ON CONFLICT (role, section) DO UPDATE SET can_view = true, can_edit = false;
