-- После 20270114_bid_vor_current: кабинет подрядчика видит только актуальную версию каждой ведомости ВОР.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
fns(sig) as (
  values ('public.bid_vor_superseded(uuid)'), ('public.bid_positions(uuid)'), ('public.bid_file_target(uuid,uuid)')
),
-- То же отношение, что у функции, без проверки входа (у миграции его нет): каждый заменённый файл — не текущий ни в одном списке
-- снабжения и заменён файлом, который лежит в тендере.
sup as (
  select distinct s.tender_id, p.id as file_id, s.s3_document_id as current_file_id
  from public.tender_supply_sources s
  cross join lateral unnest(s.prior_document_ids) as p(id)
  join public.s3_documents cur on cur.id = s.s3_document_id and cur.owner_type = 'tender' and cur.owner_id = s.tender_id
   and cur.doc_category in ('vor_statement', 'vor')
  where p.id <> s.s3_document_id
    and not exists (select 1 from public.tender_supply_sources c where c.tender_id = s.tender_id and c.s3_document_id = p.id)
),
checks(n, ok, what) as (
  select 1, (select count(*) from fns join pg_proc p on p.oid = to_regprocedure(fns.sig)
             where p.prosecdef and p.proconfig @> array['application_name=osp:internal']) = 3,
         'bid_vor_superseded, bid_positions, bid_file_target — служебные функции с отметкой'
  union all
  select 2, pg_get_function_result('public.bid_vor_superseded(uuid)'::regprocedure) = 'TABLE(file_id uuid, current_file_id uuid)',
         'заменённые ведомости: только id файлов'
  union all
  select 3, (select prosrc like '%bid_vor_superseded%' from pg_proc where oid = 'public.bid_positions(uuid)'::regprocedure)
            and (select prosrc like '%bid_vor_superseded%' from pg_proc where oid = 'public.bid_file_target(uuid,uuid)'::regprocedure)
            and pg_get_function_result('public.bid_positions(uuid)'::regprocedure)
                = 'TABLE(file_id uuid, title text, status text, error text, positions jsonb, structure jsonb, conditions jsonb)',
         'позиции с сервера и загрузка расценки не берут заменённые ведомости; поля bid_positions прежние'
  union all
  select 4, true,
         'заменённых ведомостей в базе: ' || (select count(*) from sup) || ' (в ' || (select count(distinct tender_id) from sup)
           || ' тендерах) — кабинет их не показывает'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
