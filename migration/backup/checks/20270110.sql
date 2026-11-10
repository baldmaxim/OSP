-- Проверка после 20270110_contract_number_scheme.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение и только каталог: до миграции отвечает FAIL, а не падает. Выполняется на копии (rehearse.sh) и на проде
-- в SQL Editor после миграции. Поведение ключей и счётчика — tests/tender/contract-numbering-db.test.mjs.
with
fn as (
  select p.proname, p.provolatile, p.prosecdef
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('contract_code_norm', 'contract_code_key', 'contract_number_key', 'contracts_number_counter', 'objects_contract_code_guard')
),
idx as (
  select i.indexrelid::regclass::text as name, i.indisunique, pg_get_indexdef(i.indexrelid) as def
  from pg_index i
  where i.indexrelid in (coalesce(to_regclass('public.contracts_scheme_number_uniq'), 0::regclass),
                         coalesce(to_regclass('public.objects_contract_code_uniq'), 0::regclass))
),
trg as (
  select t.tgname, t.tgrelid::regclass::text as rel
  from pg_trigger t
  where not t.tgisinternal and t.tgname in ('contracts_number_counter', 'objects_contract_code_guard')
),
cnt as (
  select c.oid, c.relrowsecurity from pg_class c where c.oid = coalesce(to_regclass('public.contract_number_counters'), 0::regclass)
),
checks(n, ok, what) as (
  select 1, exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'objects' and column_name = 'contract_code' and data_type = 'text')
            and exists (select 1 from pg_constraint where conrelid = 'public.objects'::regclass and conname = 'objects_contract_code_check'),
         'objects.contract_code (text) с проверкой формы кода'
  union all
  select 2, (select count(*) from fn where proname in ('contract_code_norm', 'contract_code_key', 'contract_number_key')
               and provolatile = 'i' and not prosecdef) = 3,
         'ключи кода и номера — неизменяемые функции (на них индексы)'
  union all
  select 3, exists (select 1 from idx where name = 'contracts_scheme_number_uniq' and indisunique
                      and def like '%contract_number_key%' and def like '%record_type%'),
         'номер по схеме у договоров не повторяется (уникальный индекс contracts_scheme_number_uniq)'
  union all
  select 4, exists (select 1 from idx where name = 'objects_contract_code_uniq' and indisunique and def like '%contract_code_key%'),
         'код объекта не повторяется (уникальный индекс objects_contract_code_uniq)'
  union all
  select 5, exists (select 1 from cnt where relrowsecurity
                      and not has_table_privilege('anon', cnt.oid, 'SELECT')
                      and has_table_privilege('authenticated', cnt.oid, 'SELECT')
                      and not has_table_privilege('authenticated', cnt.oid, 'INSERT')
                      and not has_table_privilege('authenticated', cnt.oid, 'UPDATE')
                      and not has_table_privilege('authenticated', cnt.oid, 'DELETE'))
            and exists (select 1 from pg_policy where polrelid = coalesce(to_regclass('public.contract_number_counters'), 0::regclass)
                          and polname = 'contract_number_counters_read' and polcmd = 'r'),
         'счётчик номеров: RLS, читает сотрудник, писать напрямую нельзя, анониму закрыт'
  union all
  select 6, exists (select 1 from trg where tgname = 'contracts_number_counter' and rel = 'contracts')
            and exists (select 1 from fn where proname = 'contracts_number_counter' and prosecdef),
         'счётчик ведёт триггер договоров (служебная функция)'
  union all
  select 7, exists (select 1 from trg where tgname = 'objects_contract_code_guard' and rel = 'objects')
            and exists (select 1 from fn where proname = 'objects_contract_code_guard' and not prosecdef),
         'код объекта меняет только администратор (триггер objects_contract_code_guard)'
  union all
  select 8, (select relrowsecurity from pg_class where oid = 'public.contracts'::regclass)
            and (select relrowsecurity from pg_class where oid = 'public.objects'::regclass),
         'contracts и objects: RLS по-прежнему включён'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
