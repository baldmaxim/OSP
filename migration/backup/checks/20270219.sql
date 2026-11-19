-- Проверка после 20270219_doc_check_dp_conclusion.sql (заявки на заключение ДП — на доске ДП/ДС). Каждая строка — «OK …» или
-- «FAIL …». Только чтение. Выполняется на копии (rehearse.sh) и на проде после миграции (Supabase — SQL Editor; база Яндекса —
-- psql с отметкой служебной операции, иначе правила по строкам покажут 0 заявок). До миграции отвечает FAIL, а не падает:
-- таблицы и функции — по каталогу, данные — query_to_xml и только если таблицы есть.
with
t as (
  select to_regclass('public.dp_requests') is not null as dp,
         to_regclass('osp_private.dp_moved_requests_20270219') is not null as moved,
         to_regclass('osp_private.dp_moved_files_20270219') is not null as files
),
n as (
  select
    case when (select dp from t) then (xpath('/row/n/text()', query_to_xml(
      'select count(*) as n from public.dp_requests d where d.status <> ''draft''
         and not exists (select 1 from public.doc_check_requests c where c.id = d.id and c.doc_type = ''dp_conclusion'')',
      false, true, '')))[1]::text::bigint end as not_moved,
    case when (select dp from t) then (xpath('/row/n/text()', query_to_xml(
      'select count(*) as n from public.dp_requests where status <> ''draft'' and deleted_at is null', false, true, '')))[1]::text::bigint
    end as dp_live,
    case when (select moved from t) then (xpath('/row/n/text()', query_to_xml(
      'select count(*) as n from osp_private.dp_moved_requests_20270219', false, true, '')))[1]::text::bigint end as moved,
    case when (select moved from t) then (xpath('/row/n/text()', query_to_xml(
      'select count(*) as n from public.s3_documents s join osp_private.dp_moved_requests_20270219 b on b.request_id = s.owner_id
        where s.owner_type = ''dp_request''', false, true, '')))[1]::text::bigint end as files_left,
    case when (select files from t) then (xpath('/row/n/text()', query_to_xml(
      'select count(*) as n from osp_private.dp_moved_files_20270219', false, true, '')))[1]::text::bigint end as files_moved
),
fk as (
  select confrelid::regclass::text as target from pg_constraint
  where conname = 'dp_request_alerts_request_id_fkey' and contype = 'f'
    and conrelid = coalesce(to_regclass('public.dp_request_alerts'), 0::oid)
),
trg as (
  select tgname, tgenabled from pg_trigger
  where tgname in ('doc_check_dp_conclusion_alert', 'dp_requests_moved', 'doc_check_requests_write_guard') and not tgisinternal
),
checks(n, ok, what) as (
  select 1, coalesce((select pg_get_constraintdef(oid) like '%dp_conclusion%' from pg_constraint
                      where conrelid = 'public.doc_check_requests'::regclass and conname = 'doc_check_requests_doc_type_check'), false),
         'тип заявки доски: ДП, ДС и «Заключение ДП»'
  union all
  select 2, coalesce((select moved from t) and (select not_moved = 0 from n), false),
         'каждая поданная заявка на ДП — на доске с тем же id (перенесено: ' || coalesce((select moved from n)::text, '—') || ')'
  union all
  select 3, coalesce((select dp_live = 0 from n), false),
         'в прежнем разделе живых заявок не осталось'
  union all
  select 4, coalesce((select files_left = 0 from n), false),
         'файлы перенесённых заявок — у заявок доски (перенесено: ' || coalesce((select files_moved from n)::text, '—') || ')'
  union all
  select 5, coalesce((select target = 'doc_check_requests' from fk), false),
         'уведомления о новой заявке ссылаются на заявки доски'
  union all
  select 6, exists (select 1 from trg where tgname = 'doc_check_dp_conclusion_alert' and tgenabled = 'O')
            and exists (select 1 from trg where tgname = 'dp_requests_moved' and tgenabled = 'O'),
         'уведомление заводит «Заключение ДП» на доске; прежний раздел заявок не принимает'
  union all
  select 7, coalesce((select tgenabled = 'O' from trg where tgname = 'doc_check_requests_write_guard'), true),
         'запрет записи заявок доски включён (или его нет в этой базе)'
  union all
  select 8, (select relrowsecurity from pg_class where oid = 'public.doc_check_requests'::regclass),
         'doc_check_requests: RLS по-прежнему включён'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
