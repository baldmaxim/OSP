-- АВАРИЙНЫЙ ОТКАТ 20270112_keycloak_identity (только база Яндекса): нужен, только если возвращается служба osp-api,
-- выпущенная раньше входа через Keycloak. Обычный возврат на свой вход — без отката: AUTH_MODE=own
-- (bash scripts/deploy-server.sh auth-mode own).
--
-- Что делает:
--   • отзывает сессии Keycloak: прежняя служба не знает вида сессии и приняла бы такую сессию как свою парольную;
--   • снимает запрет выдачи роли «Администратор» не суперадминистратором (прежние права AdminPage);
--   • связи и заявки СУ-10, колонки сессий и затирание токенов при отзыве ОСТАЮТСЯ: прежней службе они не мешают, а
--     повторное применение миграции продолжит с ними (связи переносить заново не придётся).
-- Одной транзакцией, повтор безопасен. Запускать с отметкой служебной операции (как migrate.sh).
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL application_name = 'osp:internal';

UPDATE osp_session.sessions SET revoked_at = now(), revoke_reason = 'rollback_keycloak'
 WHERE auth_source = 'keycloak' AND revoked_at IS NULL;

DROP TRIGGER IF EXISTS user_roles_admin_guard ON public.user_roles;
DROP FUNCTION IF EXISTS osp_private.user_roles_admin_guard();

COMMIT;
