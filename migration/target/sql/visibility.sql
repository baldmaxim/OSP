-- Сколько строк каждой таблицы и представления видит каждый вид пользователя. ТОЛЬКО ЧТЕНИЕ.
-- Запускает migration/target/visibility.sh. Одна читающая транзакция; запросы идут под учёткой-владельцем
-- с теми же данными о пользователе, что ставит PostgREST за шлюзом (request.jwt.claims, osp_role).
-- Пользователи берутся из самих данных (первый по порядку идентификатора); в вывод идут только вид
-- пользователя, имя таблицы и число — ни идентификаторов, ни значений строк.
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
-- Отметка служебной операции — только чтобы выбрать пользователей; дальше она снята.
SET LOCAL application_name = 'osp:internal';
-- Каждое значение — текст, пустой при отсутствии такой учётки: переменная psql должна быть задана всегда
-- (при NULL \gset её не создаёт). Нет учётки — ниже берётся несуществующая.
SELECT coalesce((select user_id::text from public.user_roles where role = 'admin' and is_approved and not coalesce(is_blocked, false) order by user_id limit 1), '') AS admin_id,
       coalesce((select user_id::text from public.user_roles where role not in ('admin', 'contractor') and counterparty_id is null and is_approved and not coalesce(is_blocked, false) order by user_id limit 1), '') AS eng_id,
       coalesce((select user_id::text from public.user_roles where counterparty_id is not null and is_approved and not coalesce(is_blocked, false) order by user_id limit 1), '') AS contractor_id,
       coalesce((select user_id::text from public.user_roles where is_approved is not true order by user_id limit 1), '') AS pend_id,
       coalesce((select user_id::text from public.user_roles where coalesce(is_blocked, false) order by user_id limit 1), '') AS blocked_id \gset
SELECT set_config('application_name', 'osp-visibility', true) \gset ignored_
\set counts 'select :''cls'' || ''|'' || c.relname || ''|'' || coalesce((xpath(''/row/n/text()'', query_to_xml(format(''select count(*) as n from public.%I'', c.relname), false, true, '''')))[1]::text, ''?'') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = ''public'' and c.relkind in (''r'', ''p'', ''v'') order by c.relname'
\set cls admin
SELECT set_config('request.jwt.claims', json_build_object('osp_role', 'authenticated', 'sub', coalesce(nullif(:'admin_id', ''), '00000000-0000-4000-8000-000000000004'))::text, true) \gset ignored_
:counts;
\set cls engineer
SELECT set_config('request.jwt.claims', json_build_object('osp_role', 'authenticated', 'sub', coalesce(nullif(:'eng_id', ''), '00000000-0000-4000-8000-000000000005'))::text, true) \gset ignored_
:counts;
\set cls contractor
SELECT set_config('request.jwt.claims', json_build_object('osp_role', 'authenticated', 'sub', coalesce(nullif(:'contractor_id', ''), '00000000-0000-4000-8000-000000000003'))::text, true) \gset ignored_
:counts;
\set cls unapproved
SELECT set_config('request.jwt.claims', json_build_object('osp_role', 'authenticated', 'sub', coalesce(nullif(:'pend_id', ''), '00000000-0000-4000-8000-000000000001'))::text, true) \gset ignored_
:counts;
\set cls blocked
SELECT set_config('request.jwt.claims', json_build_object('osp_role', 'authenticated', 'sub', coalesce(nullif(:'blocked_id', ''), '00000000-0000-4000-8000-000000000002'))::text, true) \gset ignored_
:counts;
\set cls stranger
SELECT set_config('request.jwt.claims', json_build_object('osp_role', 'authenticated', 'sub', '00000000-0000-4000-8000-00000000dead')::text, true) \gset ignored_
:counts;
\set cls anon
SELECT set_config('request.jwt.claims', json_build_object('osp_role', 'anon')::text, true) \gset ignored_
:counts;
\set cls no_token
SELECT set_config('request.jwt.claims', '', true) \gset ignored_
:counts;
ROLLBACK;
