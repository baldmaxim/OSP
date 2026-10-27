-- После 20261108_dc_request_submission_check: у каждой заявки на ДС — статус ОКС (submission_check, по умолчанию
-- «Не проверено»), комментарий и подпись «кто и когда», которую ставит триггер; правила по строкам на месте.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
cols as (
  select column_name, data_type, is_nullable, column_default
  from information_schema.columns
  where table_schema = 'public' and table_name = 'dc_requests' and column_name like 'submission\_%'
),
checks(n, ok, what) as (
  select 1, exists (select 1 from cols where column_name = 'submission_check' and data_type = 'text'
                      and is_nullable = 'NO' and column_default like '''not_checked''%'),
         'dc_requests.submission_check: text, NOT NULL, по умолчанию «Не проверено» (not_checked)'
  union all
  select 2, (select count(*) from cols where (column_name, data_type) in (('submission_comment', 'text'),
              ('submission_by', 'uuid'), ('submission_by_name', 'text'), ('submission_at', 'timestamp with time zone'))) = 4,
         'dc_requests: комментарий и подпись «кто и когда» (submission_comment, _by, _by_name, _at)'
  union all
  select 3, (select count(*) from pg_constraint where conrelid = 'public.dc_requests'::regclass and contype = 'c'
              and conname in ('dc_requests_submission_check_check', 'dc_requests_submission_comment_check')) = 2,
         'ограничения: пять вариантов статуса ОКС, комментарий до 2000 символов'
  union all
  select 4, not exists (select 1 from public.dc_requests
                        where submission_check <> 'not_checked' and submission_at is null),
         'статус ОКС, отличный от «Не проверено», — с отметкой времени'
  union all
  select 5, exists (select 1 from pg_trigger t where t.tgrelid = 'public.dc_requests'::regclass
                      and t.tgname = 'dc_requests_submission_stamp' and not t.tgisinternal and t.tgenabled = 'O'),
         'триггер dc_requests_submission_stamp: кто и когда сменил статус ОКС'
  union all
  select 6, exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                    where s.nspname = 'public' and p.proname = 'dc_requests_submission_stamp' and not p.prosecdef),
         'функция триггера — с правами вызывающего (не SECURITY DEFINER)'
  union all
  select 7, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.dc_requests'::regclass),
         'dc_requests: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
