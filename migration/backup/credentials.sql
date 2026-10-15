-- Отпечатки паролей Supabase для своего входа нового портала (backup.sh --credentials). Одна транзакция «только
-- чтение». Только bcrypt-отпечатки и поля, нужные отпечатку учёток (migration/accounts/lib/sealed.mjs), — строкой
-- JSON на учётку. Вывод сразу уходит в migration/accounts/seal.mjs: на диск попадает только запечатанный файл.
-- Решение владельца портала от 2026-10-15: отпечатки переносятся (вход в новом портале — тем же паролем).
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL row_security = off;
SELECT json_build_object('id', id, 'email', email, 'encrypted_password', encrypted_password,
                         'email_confirmed_at', email_confirmed_at, 'banned_until', banned_until, 'deleted_at', deleted_at)::text
FROM auth.users
-- Только настоящие bcrypt-отпечатки: строка другого вида паролем не является (учётка без пароля — временный
-- пароль от администратора; accounts-check покажет их число).
WHERE encrypted_password ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$'
ORDER BY id;
COMMIT;
