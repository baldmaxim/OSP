-- После 20270112_keycloak_identity: связи и заявки СУ-10 в закрытой схеме, сессии нового вида, запрет выдачи роли
-- «Администратор». Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
tbl as (
  select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'osp_auth' and c.relkind = 'r' and c.relname in ('identity_links', 'identity_requests')
),
pol as (
  select tablename, policyname, coalesce(qual, '') as qual, coalesce(with_check, '') as chk from pg_policies
  where schemaname = 'osp_auth' and tablename in ('identity_links', 'identity_requests')
),
col as (
  select a.attname from pg_attribute a
  where a.attrelid = 'osp_session.sessions'::regclass and a.attnum > 0 and not a.attisdropped
),
trg as (
  select c.relname, tg.tgname from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
  where not tg.tgisinternal and tg.tgname in ('sessions_wipe_kc_tokens', 'user_roles_admin_guard')
),
fn as (
  select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as cfg from pg_proc p
  join pg_namespace s on s.oid = p.pronamespace
  where s.nspname = 'osp_private' and p.proname in ('sessions_wipe_kc_tokens', 'user_roles_admin_guard')
),
checks(n, ok, what) as (
  select 1, (select count(*) from tbl where relrowsecurity and relforcerowsecurity) = 2,
         'связи и заявки СУ-10: таблицы есть, правила по строкам действуют и на владельца'
  union all
  select 2, (select count(*) from pol where policyname = 'osp_auth_only' and qual like '%osp:auth%' and chk like '%osp:auth%') = 2
            and (select count(*) from pol) = 2,
         'связи и заявки — только с отметкой модуля входа (osp:auth), других правил нет'
  union all
  select 3, (select count(*) from col where attname in ('auth_source', 'kc_issuer', 'kc_subject', 'kc_sid', 'kc_refresh_enc',
              'kc_id_token_enc', 'kc_checked_at', 'kc_check_owner', 'kc_check_lease_until', 'kc_retry_after', 'last_activity_at')) = 11,
         'сессии: колонки вида входа и Keycloak на месте'
  union all
  select 4, not exists (select 1 from osp_session.sessions where auth_source <> 'password'),
         'прежние сессии — парольные'
  union all
  select 5, (select count(*) from pg_constraint where conrelid = 'osp_session.sessions'::regclass
              and conname in ('sessions_auth_source_check', 'sessions_kc_fields_check')) = 2,
         'сессии: ограничения вида и полей Keycloak на месте'
  union all
  select 6, (select count(*) from trg) = 2,
         'триггеры: затирание токенов при отзыве и запрет выдачи роли «Администратор»'
  union all
  select 7, exists (select 1 from fn where proname = 'user_roles_admin_guard' and prosecdef and cfg like '%application_name=osp:internal%')
            and exists (select 1 from fn where proname = 'sessions_wipe_kc_tokens' and not prosecdef),
         'запрет роли — служебная функция с отметкой пропуска; затирание токенов — в правах вызывающего'
  union all
  select 8, not has_function_privilege('public', 'osp_private.user_roles_admin_guard()', 'execute'),
         'функцию запрета нельзя вызвать напрямую'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
