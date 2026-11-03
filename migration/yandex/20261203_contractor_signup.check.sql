-- После 20261203_contractor_signup: заявки, сброс пароля и очередь писем закрыты отметкой osp:auth; учётка с признаком
-- регистрации — только подрядчик; чёрный список закрывает доступ. Строки «OK …» / «FAIL …».
with
tbl(name) as (values ('registrations'), ('password_resets'), ('mail_outbox')),
info as (
  select tbl.name, c.relrowsecurity and c.relforcerowsecurity and c.relacl is null as closed,
         (select count(*) from pg_policy p where p.polrelid = c.oid and p.polname = 'osp_auth_only') as own,
         (select count(*) from pg_policy p where p.polrelid = c.oid) as all_pol
  from tbl left join pg_class c on c.oid = to_regclass('osp_auth.' || tbl.name)
),
checks(n, ok, what) as (
  select 1, (select count(*) from info where closed and own = 1 and all_pol = 1) = 3,
         'таблицы регистрации в osp_auth: правила на владельце, только отметка osp:auth, выдач нет'
  union all
  select 2, exists (select 1 from pg_attribute a where a.attrelid = 'public.user_roles'::regclass and a.attname = 'self_registered' and not a.attisdropped)
            and exists (select 1 from pg_constraint c where c.conrelid = 'public.user_roles'::regclass
                          and c.conname = 'user_roles_self_registered_contractor' and c.convalidated),
         'учётка с признаком регистрации — только подрядчик (ограничение на месте)'
  union all
  select 3, (select count(*) from public.user_roles where self_registered) = 0,
         'учёток с признаком регистрации ещё нет'
  union all
  select 4, exists (select 1 from pg_trigger t where t.tgrelid = 'public.counterparties'::regclass and t.tgname = 'counterparties_close_accounts' and t.tgenabled <> 'D'),
         'чёрный список блокирует учётки организации (триггер на месте)'
  union all
  select 5, exists (select 1 from pg_indexes where schemaname = 'osp_auth' and indexname = 'registrations_open_email_key'),
         'одна незавершённая заявка на почту'
)
select case when ok then 'OK ' else 'FAIL ' end || what from checks order by n;
