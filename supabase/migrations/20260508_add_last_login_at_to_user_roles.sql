-- Собственное поле «последний вход», которое обновляется приложением при успешной авторизации.
-- Поле auth.users.last_sign_in_at у Supabase ненадёжно отражает реальный момент логина.

ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

COMMENT ON COLUMN user_roles.last_login_at IS 'Время последнего успешного входа (обновляется приложением при signInWithPassword)';
