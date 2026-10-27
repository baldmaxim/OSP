-- После 20261109_contracts_dc_requests: у заявок на ДС — договор, ДС реестра договоров и подразделение; договоры
-- прежних заявок — только договоры (не ДС); «Шаблон ДГП» заведён; правила по строкам на месте.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
col as (
  select column_name, data_type from information_schema.columns
  where table_schema = 'public' and table_name = 'dc_requests' and column_name in ('contract_id', 'amendment_id', 'division')
),
fk as (
  select a.attname, c.confdeltype from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
  where c.conrelid = 'public.dc_requests'::regclass and c.contype = 'f' and c.confrelid = 'public.contracts'::regclass
    and array_length(c.conkey, 1) = 1
),
checks(n, ok, what) as (
  select 1, (select count(*) from col where (column_name in ('contract_id', 'amendment_id') and data_type = 'uuid')
                                         or (column_name = 'division' and data_type = 'text')) = 3,
         'dc_requests: contract_id, amendment_id (uuid), division (text)'
  union all
  select 2, exists (select 1 from fk where attname = 'contract_id' and confdeltype = 'n')
            and exists (select 1 from fk where attname = 'amendment_id' and confdeltype = 'n'),
         'contract_id и amendment_id ссылаются на contracts, при удалении договора — пусто'
  union all
  select 3, exists (select 1 from pg_constraint where conrelid = 'public.dc_requests'::regclass
                      and conname = 'dc_requests_division_check' and pg_get_constraintdef(oid) like '%finishing%'),
         'подразделение — только коды подразделений ВОР'
  union all
  select 4, to_regclass('public.idx_dc_requests_contract') is not null and to_regclass('public.idx_dc_requests_amendment') is not null,
         'индексы по договору и ДС заявки'
  union all
  select 5, not exists (select 1 from public.dc_requests r join public.contracts c on c.id = r.contract_id where c.record_type <> 'dp'),
         'договор заявки — договор (ДП), а не ДС'
  union all
  select 6, to_regclass('public.section_templates') is null
            or exists (select 1 from public.section_templates where code = 'contracts_dgp' and title = 'Шаблон ДГП'),
         '«Шаблон ДГП» заведён'
  union all
  select 7, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.dc_requests'::regclass),
         'dc_requests: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
