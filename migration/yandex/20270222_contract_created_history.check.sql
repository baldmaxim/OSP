-- После 20270222_contract_created_history: у каждого договора и ДС в «Истории» есть «Создание»; восстановленная запись — одна на
-- документ, с датой создания документа, с основанием и текстом; автор — только из журнала базы.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
restored as (
  select l.*, c.created_at as doc_created
  from public.contract_audit_log l
  join public.contracts c on c.id = l.contract_id
  where l.new_value ->> 'restored' = '20270222'
),
first_insert as (
  select distinct on (d.row_id) d.row_id, d.actor, d.actor_name
  from osp_private.data_audit_log d
  where d.table_name = 'contracts' and d.op = 'INSERT' and d.row_id is not null
  order by d.row_id, d.at, d.id
),
checks(n, ok, what) as (
  select 1, not exists (select 1 from public.contracts c
                        where not exists (select 1 from public.contract_audit_log l
                                          where l.contract_id = c.id and l.event_type = 'created')),
         'у каждого договора и ДС в «Истории» есть «Создание»'
  union all
  select 2, not exists (select 1 from restored group by contract_id having count(*) > 1),
         'восстановленная запись «Создание» — не больше одной на документ'
  union all
  select 3, not exists (select 1 from restored where event_type <> 'created' or changed_at is distinct from doc_created),
         'восстановленная запись — «Создание» с датой создания документа'
  union all
  select 4, not exists (select 1 from restored
                        where coalesce(new_value ->> 'basis', '') not in ('journal', 'before_history', 'batch', 'single')
                           or description !~ '^Создан[оа]? '),
         'у каждой восстановленной записи — основание и текст «Создан…»'
  union all
  select 5, not exists (select 1 from restored r
                        where (r.new_value ->> 'basis') <> 'journal'
                          and (r.changed_by is not null or r.changed_by_name is not null or r.changed_by_role is not null)),
         'автор не придуман: без журнала базы — пустой'
  union all
  select 6, not exists (select 1 from restored r
                        left join first_insert f on f.row_id = r.contract_id
                        where (r.new_value ->> 'basis') = 'journal'
                          and (f.row_id is null or r.changed_by is distinct from f.actor
                               or r.changed_by_name is distinct from f.actor_name)),
         'автор из журнала базы — тот, кто создал строку договора'
  union all
  select 7, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.contract_audit_log'::regclass),
         'contract_audit_log: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
