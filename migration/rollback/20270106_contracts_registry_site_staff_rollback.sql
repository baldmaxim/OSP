-- Откат 20270106_contracts_registry_site_staff.sql: экономисту объекта снова закрыт «Реестр по договорам» (как до миграции).
-- Руководителю строительства просмотр был и до неё (20260507) — не трогается. Если экономисту объекта просмотр выдали
-- галочкой ещё до миграции, откат его тоже снимет: вернуть — галочкой в «Правах доступа». Данные не меняются.
BEGIN;

UPDATE public.role_permissions
   SET can_view = false, can_edit = false
 WHERE role = 'economist_object' AND section = 'contracts';

COMMIT;
