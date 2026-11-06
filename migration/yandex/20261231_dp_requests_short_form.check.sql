-- После 20261231_dp_requests_short_form: короткая форма подающего заявку на ДП. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой
-- служебной операции.
with
col as (
  select column_name from information_schema.columns
  where table_schema = 'public' and table_name = 'dp_requests' and is_nullable = 'YES'
    and column_name in ('object_id', 'contract_title', 'amount', 'reason')
),
fn as (
  select p.proname, p.prosrc from pg_proc p join pg_namespace s on s.oid = p.pronamespace
  where s.nspname = 'public' and p.proname in ('dp_requests_guard', 's3_documents_dp_request_guard')
),
pol as (
  select policyname, coalesce(qual, '') as qual, coalesce(with_check, '') as chk from pg_policies
  where schemaname = 'public' and tablename = 'dp_requests'
),
checks(n, ok, what) as (
  select 1, (select count(*) from col) = 4, 'объект, договор, сумма и примечание могут быть пустыми'
  union all
  select 2, coalesce((select prosrc like '%dp_concept_agreement_required%'
                             and prosrc not like '%dp_contract_doc_required%' and prosrc not like '%dp_responsible_required%'
                      from fn where proname = 'dp_requests_guard'), false),
         'подача требует только понятийное соглашение'
  union all
  select 3, coalesce((select prosrc like '%dp_work_fields%' from fn where proname = 'dp_requests_guard'), false),
         'объект, договор, сумму и ответственного автор не меняет'
  union all
  select 4, coalesce((select prosrc like '%dp_required_file_last%' and prosrc not like '%dp_contract_doc%'
                      from fn where proname = 's3_documents_dp_request_guard'), false),
         'нельзя убрать только последнее понятийное соглашение, документы необязательны'
  union all
  select 5, coalesce((select qual like '%object_id IS NULL%' from pol where policyname = 'dp_requests_read'), false)
            and coalesce((select chk like '%object_id IS NULL%' from pol where policyname = 'dp_requests_insert'), false)
            and coalesce((select qual like '%object_id IS NULL%' and chk like '%object_id IS NULL%' from pol where policyname = 'dp_requests_update'), false),
         'заявка без объекта проходит правила чтения, создания и правки'
  union all
  select 6, coalesce((select relrowsecurity and relforcerowsecurity from pg_class where oid = to_regclass('public.dp_requests')), false),
         'dp_requests: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
