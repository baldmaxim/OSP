-- Проверка после 20270218_doc_check_marks_reset.sql (заявки на проверку ДП/ДС). Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде после миграции (Supabase — SQL Editor; база Яндекса — psql с
-- отметкой служебной операции, иначе правила по строкам покажут 0 заявок). До миграции отвечает FAIL, а не падает: колонки
-- читаются через jsonb, таблица прежних значений — по имени из каталога.
with
marked as (
  select count(*) as n from public.doc_check_requests r
  where (to_jsonb(r) ->> 'priority') is not null or (to_jsonb(r) ->> 'color') is not null
),
cols as (
  select column_name from information_schema.columns
  where table_schema = 'public' and table_name = 'doc_check_requests' and column_name in ('priority', 'color')
),
checks(n, ok, what) as (
  select 1, (select n = 0 from marked),
         'заявок с цветом или приоритетом нет (вместе с удалёнными и архивом)'
  union all
  select 2, (select count(*) in (0, 2) from cols),
         'колонки priority и color на месте (база без колонок доски 20261113 — их и не было)'
  union all
  select 3, to_regclass('osp_private.doc_check_marks_backup_20270218') is not null,
         'прежние значения сохранены в osp_private.doc_check_marks_backup_20270218'
  union all
  select 4, coalesce((select tgenabled = 'O' from pg_trigger
                      where tgrelid = 'public.doc_check_requests'::regclass and tgname = 'trg_doc_check_requests_updated_at'), false),
         'триггер updated_at заявок включён'
  union all
  select 5, (select relrowsecurity from pg_class where oid = 'public.doc_check_requests'::regclass),
         'doc_check_requests: RLS по-прежнему включён'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
