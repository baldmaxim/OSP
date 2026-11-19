-- После 20270219_doc_check_dp_conclusion: заявки на заключение ДП — на доске ДП/ДС (тот же id, тип «Заключение ДП», автор и
-- объект прежние), их файлы и уведомления — там же, прежний раздел заявок не принимает, резерв для отката закрыт.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
moved as (
  select d.id, d.object_id, d.created_by, d.created_at, d.created_by_name,
         c.id as copy_id, c.doc_type, c.status, c.object_id as c_object, c.created_by as c_author, c.created_at as c_created,
         c.created_by_name as c_author_name, c.deleted_at as c_deleted, b.dp_deleted_at
  from public.dp_requests d
  join osp_private.dp_moved_requests_20270219 b on b.request_id = d.id
  left join public.doc_check_requests c on c.id = d.id
),
fk as (
  select confrelid::regclass::text as target, confdeltype from pg_constraint
  where conrelid = 'public.dp_request_alerts'::regclass and contype = 'f' and conname = 'dp_request_alerts_request_id_fkey'
),
trg as (
  select tgname, tgenabled, tgrelid::regclass::text as rel from pg_trigger
  where tgname in ('doc_check_dp_conclusion_alert', 'dp_requests_moved', 'doc_check_requests_write_guard') and not tgisinternal
),
backup as (
  select c.relname, c.relrowsecurity and c.relforcerowsecurity as forced from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'osp_private' and c.relname in ('dp_moved_requests_20270219', 'dp_moved_files_20270219', 'dp_moved_alerts_20270219')
),
checks(n, ok, what) as (
  select 1, coalesce((select pg_get_constraintdef(oid) like '%dp_conclusion%' from pg_constraint
                      where conrelid = 'public.doc_check_requests'::regclass and conname = 'doc_check_requests_doc_type_check'), false),
         'тип заявки доски: ДП, ДС и «Заключение ДП»'
  union all
  select 2, not exists (select 1 from public.dp_requests d where d.status <> 'draft'
                          and not exists (select 1 from public.doc_check_requests c where c.id = d.id and c.doc_type = 'dp_conclusion')),
         'каждая поданная заявка на ДП — на доске с тем же id, тип «Заключение ДП»: '
           || (select count(*) from moved where copy_id is not null)::text
  union all
  select 3, not exists (select 1 from moved where copy_id is null or c_object is distinct from object_id
                          or c_author is distinct from created_by or c_created is distinct from created_at
                          or c_author_name is distinct from created_by_name
                          or (c_deleted is null) is distinct from (dp_deleted_at is null)),
         'автор, объект и дата создания прежние; удалённые — в «Удалённых» доски'
  union all
  select 4, not exists (select 1 from public.dp_requests where status <> 'draft' and deleted_at is null),
         'в прежнем разделе живых заявок не осталось'
  union all
  select 5, not exists (select 1 from public.s3_documents s join osp_private.dp_moved_requests_20270219 b on b.request_id = s.owner_id
                        where s.owner_type = 'dp_request')
            and not exists (select 1 from osp_private.dp_moved_files_20270219 f
                            left join public.s3_documents s on s.id = f.doc_id
                            where s.id is null or s.owner_type <> 'doc_check_request' or s.owner_id <> f.request_id
                               or s.doc_category not in ('doc_check_concept_agreement', 'general')),
         'файлы перенесённых заявок — у заявок доски (понятийное соглашение — своей частью): '
           || (select count(*) from osp_private.dp_moved_files_20270219)::text
  union all
  select 6, coalesce((select target = 'doc_check_requests' and confdeltype = 'c' from fk), false)
            and not exists (select 1 from public.dp_request_alerts a where not exists (select 1 from public.doc_check_requests c where c.id = a.request_id)),
         'уведомления ссылаются на заявки доски; без заявки уведомлений нет (в резерве: '
           || (select count(*) from osp_private.dp_moved_alerts_20270219)::text || ')'
  union all
  select 7, coalesce((select tgenabled = 'O' and rel = 'doc_check_requests' from trg where tgname = 'doc_check_dp_conclusion_alert'), false)
            and coalesce((select prosrc like '%doc_check_requests%' and prosrc not like '%dp_requests r%' from pg_proc
                          where proname = 'dp_request_my_alerts' and pronamespace = 'public'::regnamespace), false),
         'окно о новой заявке: уведомления заводит «Заключение ДП» на доске, окно читает доску'
  union all
  select 8, coalesce((select tgenabled = 'O' and rel = 'dp_requests' from trg where tgname = 'dp_requests_moved'), false),
         'прежний раздел заявок не принимает'
  union all
  select 9, coalesce((select tgenabled = 'O' from trg where tgname = 'doc_check_requests_write_guard'), false),
         'запрет записи заявок доски (doc_check_requests_write_guard) снова включён'
  union all
  select 10, (select count(*) = 3 and bool_and(forced) from backup),
         'резерв отката — в osp_private, RLS включён и действует на владельца'
  union all
  select 11, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.doc_check_requests'::regclass),
         'doc_check_requests: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
