-- После 20261010: одно правило сотрудника, широких политик нет. Строки «OK …» / «FAIL …»; только чтение.
with
broad as (
  select count(*) n from pg_policies
  where schemaname = 'public' and cmd = 'ALL' and qual = 'true' and with_check = 'true'
),
sa as (
  select to_regclass('public.superadmins') rel
),
fns(sig) as (values ('public.osp_is_employee()'), ('public.osp_counterparty_id()'), ('public.osp_can(text,text)')),
checks(n, ok, what) as (
  select 1, (select n = 0 from broad), 'широких политик USING (true) не осталось'
  union all
  select 2, coalesce((select c.relrowsecurity from pg_class c, sa where c.oid = sa.rel), false)
            and not has_table_privilege('authenticated', (select rel from sa), 'SELECT,INSERT,UPDATE,DELETE')
            and not has_table_privilege('anon', (select rel from sa), 'SELECT,INSERT,UPDATE,DELETE'),
         'superadmins: RLS включён, клиентам недоступна'
  union all
  select 3, case when (select rel from sa) is null then false
                 when exists (select 1 from auth.users u where lower(u.email) = 'sadovnikov.d.y@su10.ru')
                   then exists (select 1 from public.superadmins s join auth.users u on u.id = s.user_id
                                where lower(u.email) = 'sadovnikov.d.y@su10.ru')
                 else true end,
         'суперадмин перенесён в superadmins (или его учётки нет в этой базе)'
  union all
  select 4, pg_get_functiondef('public.is_admin()'::regprocedure) !~ 'auth\.users'
            and pg_get_functiondef('public.vor_requests_can_access()'::regprocedure) !~ 'auth\.users',
         'is_admin и vor_requests_can_access не читают адрес почты'
  union all
  select 5, bool_and(to_regprocedure(sig) is not null
              and coalesce((select p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
                            from pg_proc p where p.oid = to_regprocedure(sig)), false)
              and has_function_privilege('authenticated', to_regprocedure(sig), 'EXECUTE')
              and not has_function_privilege('anon', to_regprocedure(sig), 'EXECUTE')),
         'osp_is_employee / osp_counterparty_id / osp_can: SECURITY DEFINER, EXECUTE только у authenticated'
  from fns
  union all
  select 6, exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'tender_rd_document_codes'
                    and policyname = 'rd_doc_codes_write' and qual ~ 'osp_is_employee'),
         'rd_doc_codes_write: только сотрудник'
  union all
  select 7, exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_roles'
                    and policyname = 'user_roles_insert_self_pending'
                    and with_check ~ 'counterparty_id IS NULL' and with_check ~ 'is_blocked = false'),
         'саморегистрация: без организации и блокировки'
)
select case when ok then 'OK ' else 'FAIL ' end || what from checks order by n;
