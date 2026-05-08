-- Однократный бэкфилл: для пользователей, которые ещё не входили после применения
-- 20260508_add_last_login_at_to_user_roles.sql, копируем в last_login_at значение
-- из auth.users.last_sign_in_at, чтобы вкладка «Администрирование» не показывала «—»
-- для всех старых учётных записей.

UPDATE user_roles ur
SET last_login_at = au.last_sign_in_at
FROM auth.users au
WHERE ur.user_id = au.id
  AND ur.last_login_at IS NULL
  AND au.last_sign_in_at IS NOT NULL;
