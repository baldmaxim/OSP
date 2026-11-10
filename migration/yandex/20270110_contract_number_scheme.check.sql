-- После 20270110_contract_number_scheme: коды объектов, ключи номера, счётчик и уникальность номера по схеме.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
cnt as (
  select c.oid, c.relrowsecurity, c.relforcerowsecurity from pg_class c where c.oid = 'public.contract_number_counters'::regclass
),
checks(n, ok, what) as (
  select 1, public.contract_number_key('АЛИЯ-ДП-26-001') = 'АЛИЯ|2026|1'
            and public.contract_number_key(' алия-дп-26-1 ') = 'АЛИЯ|2026|1'
            and public.contract_number_key('CБ2-ДП-26-007') = 'СБ2|2026|7'
            and public.contract_number_key('ЗИЛ18-19-27-ДП-27-012') = 'ЗИЛ18-19-27|2027|12'
            and public.contract_number_key('СУ10-ВЭЙВ-СП-Э1-25') is null
            and public.contract_number_key('АЛИЯ-ДП-26-000') is null
            and public.contract_code_key('ДОМ56Рен') = 'ДОМ56РЕН' and public.contract_code_key('ЗИЛ 33') is null,
         'ключи номера и кода: регистр, латиница-двойник и ведущие нули не важны; старый вид — не по схеме'
  union all
  select 2, (select count(*) from public.objects where contract_code is not null) =
            (select count(distinct public.contract_code_key(contract_code)) from public.objects where contract_code is not null),
         'коды объектов не повторяются; задано у ' || (select count(*) from public.objects where contract_code is not null)
         || ' из 17 объектов файла'
  union all
  select 3, exists (select 1 from pg_index i where i.indexrelid = 'public.contracts_scheme_number_uniq'::regclass and i.indisunique),
         'номер по схеме у договоров не повторяется (уникальный индекс)'
  union all
  select 4, (select count(*) from (select public.contract_number_key(contract_number) k from public.contracts where record_type = 'dp') s
               where k is not null
                 and coalesce((select c.last_number from public.contract_number_counters c
                               where c.code_key = split_part(k, '|', 1) and c.year = split_part(k, '|', 2)::int), 0)
                     < split_part(k, '|', 3)::int) = 0,
         'счётчик не меньше уже введённых номеров по схеме (их ' || (select count(*) from public.contracts
           where record_type = 'dp' and public.contract_number_key(contract_number) is not null) || ')'
  union all
  select 5, exists (select 1 from cnt where relrowsecurity and relforcerowsecurity)
            and (select count(*) from pg_policy where polrelid = 'public.contract_number_counters'::regclass) = 2
            and exists (select 1 from pg_policy where polrelid = 'public.contract_number_counters'::regclass
                          and polname = 'contract_number_counters_read' and polcmd = 'r'),
         'счётчик: правила включены и действуют на владельца; сотрудник только читает'
  union all
  select 6, exists (select 1 from pg_trigger where not tgisinternal and tgname = 'contracts_number_counter'
                      and tgrelid = 'public.contracts'::regclass)
            and exists (select 1 from pg_trigger where not tgisinternal and tgname = 'objects_contract_code_guard'
                          and tgrelid = 'public.objects'::regclass),
         'триггеры: счётчик у договоров, запрет правки кода не администратором у объектов'
  union all
  select 7, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.objects'::regclass),
         'objects: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
