-- Проверка 20261019_own_auth: только структура. Полноту учёток проверяет accounts-check перед включением
-- своего входа, поэтому миграция проходит и на базе, где учётки ещё не дозаполнены.
WITH auth_tables AS (
  SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relacl
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'osp_auth' AND c.relkind IN ('r', 'p')
), checks(n, ok, what) AS (
  SELECT 1, (SELECT count(*) FROM auth_tables) = 5
            AND (SELECT count(*) FROM auth_tables t WHERE NOT (t.relrowsecurity AND t.relforcerowsecurity
                   AND t.relacl IS NULL
                   AND (SELECT count(*) FROM pg_policy p WHERE p.polrelid = t.oid) = 1
                   AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = t.oid AND p.polname = 'osp_auth_only'))) = 0,
         'osp_auth: 5 таблиц, правила действуют на владельца, единственная политика — отметка osp:auth'
  UNION ALL
  SELECT 2, (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'osp_session.sessions'::regclass)
            AND EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'osp_session.sessions'::regclass AND polname = 'osp_internal'),
         'osp_session.sessions: правила действуют на владельца, пропуск только служебным операциям'
  UNION ALL
  SELECT 3, NOT has_schema_privilege('public', 'osp_auth', 'USAGE') AND NOT has_schema_privilege('public', 'osp_session', 'USAGE'),
         'схемы osp_auth и osp_session «всем» недоступны'
  UNION ALL
  SELECT 4, (SELECT provolatile = 'i' FROM pg_proc WHERE oid = 'osp_private.email_norm(text)'::regprocedure)
            AND osp_private.email_norm('  Ivanov@SU10.ru ') = 'ivanov@su10.ru',
         'нормализация почты: одна функция, неизменяемая'
  UNION ALL
  SELECT 5, EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                    WHERE i.indrelid = 'auth.users'::regclass AND i.indisunique AND c.relname = 'users_email_norm_key'),
         'одна почта — одна учётка (уникальный индекс по нормализованной почте)'
  UNION ALL
  SELECT 6, (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.user_roles'::regclass
             AND tgname IN ('user_roles_revoke_sessions', 'user_roles_revoke_sessions_delete') AND NOT tgisinternal) = 2,
         'блокировка, снятие одобрения и удаление строки ролей отзывают сессии'
  UNION ALL
  SELECT 7, (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'osp_auth') AND p.prosrc ~ 'osp_auth') = 0,
         'ни одна функция базы не ссылается на osp_auth'
)
SELECT CASE WHEN ok THEN 'OK ' ELSE 'FAIL ' END || what FROM checks ORDER BY n;
