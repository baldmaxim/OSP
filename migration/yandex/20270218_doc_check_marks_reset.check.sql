-- После 20270218_doc_check_marks_reset: ни у одной заявки на проверку ДП/ДС нет цвета и приоритета (вместе с удалёнными и
-- архивом), прежние значения сохранены, колонки на месте, триггер updated_at снова включён.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
cols as (
  select column_name from information_schema.columns
  where table_schema = 'public' and table_name = 'doc_check_requests' and column_name in ('priority', 'color')
),
marked as (
  select count(*) as n from public.doc_check_requests r
  where (to_jsonb(r) ->> 'priority') is not null or (to_jsonb(r) ->> 'color') is not null
),
checks(n, ok, what) as (
  select 1, (select n = 0 from marked),
         'заявок с цветом или приоритетом нет (вместе с удалёнными и архивом)'
  union all
  select 2, (select count(*) = 2 from cols),
         'колонки priority и color на месте — прежняя страница до выкладки читает их по имени'
  union all
  select 3, to_regclass('osp_private.doc_check_marks_backup_20270218') is not null
            and coalesce((select relrowsecurity and relforcerowsecurity from pg_class
                          where oid = to_regclass('osp_private.doc_check_marks_backup_20270218')), false),
         'прежние значения — в osp_private.doc_check_marks_backup_20270218 (RLS включён и действует на владельца): '
           || coalesce((select count(*)::text from osp_private.doc_check_marks_backup_20270218), '0')
  union all
  select 4, coalesce((select tgenabled = 'O' from pg_trigger
                      where tgrelid = 'public.doc_check_requests'::regclass and tgname = 'trg_doc_check_requests_updated_at'), false),
         'триггер updated_at заявок включён'
  union all
  select 5, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.doc_check_requests'::regclass),
         'doc_check_requests: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
