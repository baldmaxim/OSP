-- После 20261113_doc_check_board: у заявок на проверку ДП/ДС — исполнители, срок, приоритет, цвет, метки, архив и
-- статус «Проверка документов (исключение налоговой оговорки)»; правила по строкам на месте.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
cols as (
  select column_name, data_type, udt_name, is_nullable from information_schema.columns
  where table_schema = 'public' and table_name = 'doc_check_requests'
),
checks(n, ok, what) as (
  select 1, exists (select 1 from cols where column_name = 'assignee_ids' and udt_name = '_uuid' and is_nullable = 'NO')
        and exists (select 1 from cols where column_name = 'labels' and udt_name = '_text' and is_nullable = 'NO'),
         'doc_check_requests: assignee_ids (uuid[]) и labels (text[]), не NULL'
  union all
  select 2, exists (select 1 from cols where column_name = 'due_date' and data_type = 'date')
        and exists (select 1 from cols where column_name = 'priority' and data_type = 'text')
        and exists (select 1 from cols where column_name = 'color' and data_type = 'text')
        and exists (select 1 from cols where column_name = 'archived_at' and data_type = 'timestamp with time zone'),
         'doc_check_requests: due_date, priority, color, archived_at'
  union all
  select 3, exists (select 1 from pg_constraint where conrelid = 'public.doc_check_requests'::regclass
                      and conname = 'doc_check_requests_status_check' and pg_get_constraintdef(oid) like '%tax_clause%'
                      and pg_get_constraintdef(oid) like '%awaiting_scan%'),
         'статусы: прежние и tax_clause'
  union all
  select 4, (select count(*) = 4 from pg_constraint where conrelid = 'public.doc_check_requests'::regclass
               and conname in ('doc_check_requests_priority_check', 'doc_check_requests_color_check',
                               'doc_check_requests_labels_check', 'doc_check_requests_assignees_check')),
         'ограничения приоритета, цвета, числа меток и исполнителей'
  union all
  select 5, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.doc_check_requests'::regclass),
         'doc_check_requests: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
