-- АВАРИЙНЫЙ ОТКАТ 20270201_su10_org_links (только база Яндекса): снимаются триггеры запрета и отзыва сессий, колонка
-- user_roles.counterparty_source (это лишь отметка «контрагента поставил сервер» — при следующем входе через СУ-10 сервер
-- поставит её снова). После отката контрагента учётки снова можно править в «Администрировании», как до миграции.
-- Данные НЕ удаляются: реестр организаций, связи с контрагентами, исключения и журнал (osp_auth.*) остаются — повторное
-- применение миграции продолжит с ними. Сами user_roles.counterparty_id не меняются.
-- Одной транзакцией, повтор безопасен.
--
-- Убрать и таблицы (связи, сделанные администратором, пропадут — только если от фичи отказываются совсем):
--   DROP TABLE IF EXISTS osp_auth.org_links, osp_auth.org_exceptions, osp_auth.subject_orgs, osp_auth.su10_orgs;
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL application_name = 'osp:internal';

DROP TRIGGER IF EXISTS user_roles_counterparty_guard ON public.user_roles;
DROP TRIGGER IF EXISTS user_roles_counterparty_revoke ON public.user_roles;
DROP TRIGGER IF EXISTS counterparties_revoke_sessions ON public.counterparties;
DROP FUNCTION IF EXISTS osp_private.user_roles_counterparty_guard();
DROP FUNCTION IF EXISTS osp_private.user_roles_counterparty_revoke();
DROP FUNCTION IF EXISTS osp_private.counterparties_revoke_sessions();

ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_counterparty_source_check;
ALTER TABLE public.user_roles DROP COLUMN IF EXISTS counterparty_source;

COMMIT;
