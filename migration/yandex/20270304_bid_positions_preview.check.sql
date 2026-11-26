-- После 20270304_bid_positions_preview: позиции ВОР с сервера — и администратору в просмотре кабинета «как подрядчик».
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
fn as (select p.prosecdef, p.proconfig, p.prosrc from pg_proc p where p.oid = to_regprocedure('public.bid_positions(uuid)')),
checks(n, ok, what) as (
  select 1, coalesce((select prosecdef and proconfig @> array['application_name=osp:internal'] from fn), false),
         'bid_positions — служебная функция с отметкой'
  union all
  select 2, pg_get_function_result('public.bid_positions(uuid)'::regprocedure)
              = 'TABLE(file_id uuid, title text, status text, error text, positions jsonb, structure jsonb, conditions jsonb)',
         'поля bid_positions прежние (без пути к файлу и цен)'
  union all
  select 3, coalesce((select prosrc like '%IF NOT public.is_admin() THEN%RAISE EXCEPTION%' and prosrc not like '%osp_is_employee%' from fn), false),
         'без организации — только администратор (просмотр «как подрядчик»); прочим сотрудникам отказ'
  union all
  select 4, coalesce((select prosrc like '%bid_access(p_tender)%' and prosrc like '%bid_vor_superseded%' and prosrc like '%osp_self_registered()%'
                      from fn), false),
         'подрядчику — как раньше: только при доступе к тендеру, без заменённых ведомостей'
  union all
  select 5, true,
         'ведомостей с разбором службы: ' || (select count(*) from osp_private.bid_vor_files where status = 'ok')
           || ', с ошибкой — ' || (select count(*) from osp_private.bid_vor_files where status <> 'ok')
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
