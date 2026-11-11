-- После 20270201_su10_org_links: реестр организаций СУ-10, связи 1:1 с контрагентами, исключения, запрет правки контрагента
-- учётки СУ-10 мимо сервера, отзыв сессий. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh).
-- Таблицы osp_auth читаются только с отметкой модуля входа — первая строка её ставит (её вывод не OK и не FAIL).
SELECT 'mark ' || pg_catalog.set_config('application_name', 'osp:auth', true);

with
tbl as (
  select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'osp_auth' and c.relkind = 'r' and c.relname in ('su10_orgs', 'org_links', 'subject_orgs', 'org_exceptions')
),
pol as (
  select tablename, policyname, coalesce(qual, '') as qual, coalesce(with_check, '') as chk from pg_policies
  where schemaname = 'osp_auth' and tablename in ('su10_orgs', 'org_links', 'subject_orgs', 'org_exceptions')
),
fk as (
  select conname, confdeltype from pg_constraint
  where conrelid = 'osp_auth.org_links'::regclass and contype = 'f'
),
uq as (
  select conname from pg_constraint where conrelid = 'osp_auth.org_links'::regclass and contype in ('p', 'u')
),
trg as (
  select c.relname, tg.tgname from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
  where not tg.tgisinternal and tg.tgname in ('user_roles_counterparty_guard', 'user_roles_counterparty_revoke', 'counterparties_revoke_sessions')
),
fn as (
  select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as cfg from pg_proc p
  join pg_namespace s on s.oid = p.pronamespace
  where s.nspname = 'osp_private'
    and p.proname in ('user_roles_counterparty_guard', 'user_roles_counterparty_revoke', 'counterparties_revoke_sessions')
),
checks(n, ok, what) as (
  select 1, (select count(*) from tbl where relrowsecurity and relforcerowsecurity) = 4,
         'организации СУ-10: четыре таблицы есть, правила по строкам действуют и на владельца'
  union all
  select 2, (select count(*) from pol where policyname = 'osp_auth_only' and qual like '%osp:auth%' and chk like '%osp:auth%') = 4
            and (select count(*) from pol) = 4,
         'таблицы организаций — только с отметкой модуля входа (osp:auth), других правил нет'
  union all
  select 3, exists (select 1 from fk where conname = 'org_links_counterparty_fkey' and confdeltype = 'r')
            and exists (select 1 from fk where conname = 'org_links_org_fkey' and confdeltype = 'r'),
         'связь: контрагент и организация — внешними ключами RESTRICT (связанного контрагента не удалить)'
  union all
  select 4, (select count(*) from uq where conname in ('org_links_pkey', 'org_links_counterparty_key')) = 2,
         'связь строго 1:1: одна организация — один контрагент и наоборот'
  union all
  select 5, (select count(*) from osp_auth.org_links) = (select count(distinct su10_org_id) from osp_auth.org_links)
            and (select count(*) from osp_auth.org_links) = (select count(distinct counterparty_id) from osp_auth.org_links),
         'связей-дублей нет'
  union all
  select 6, exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'user_roles' and column_name = 'counterparty_source'),
         'user_roles.counterparty_source на месте'
  union all
  select 7, (select count(*) from trg) = 3,
         'триггеры: запрет правки контрагента учётки СУ-10 мимо сервера, отзыв сессий при смене контрагента и при ЧС/удалении'
  union all
  select 8, exists (select 1 from fn where proname = 'user_roles_counterparty_guard' and not prosecdef and cfg not like '%osp:internal%')
            and (select count(*) from fn where proname in ('user_roles_counterparty_revoke', 'counterparties_revoke_sessions')
                   and prosecdef and cfg like '%application_name=osp:internal%') = 2,
         'запрет — в правах вызывающего; отзыв сессий — служебные функции с отметкой пропуска'
  union all
  select 9, not has_function_privilege('public', 'osp_private.user_roles_counterparty_revoke()', 'execute')
            and not has_function_privilege('public', 'osp_private.counterparties_revoke_sessions()', 'execute')
            and not has_function_privilege('public', 'osp_private.user_roles_counterparty_guard()', 'execute'),
         'функции триггеров нельзя вызвать напрямую'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;

-- Прежние строки не тронуты: отметку 'su10' ставит только сервер при входе через СУ-10 (служебная отметка — снова).
SELECT 'mark ' || pg_catalog.set_config('application_name', 'osp:internal', true);
SELECT CASE WHEN count(*) = 0 THEN 'OK' ELSE 'FAIL' END
       || ' user_roles.counterparty_source пуст у всех прежних строк (миграция данные не меняет)'
  FROM public.user_roles WHERE counterparty_source IS NOT NULL;
