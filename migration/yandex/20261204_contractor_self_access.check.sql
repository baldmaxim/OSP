-- После 20261204_contractor_self_access: учётке с регистрации закрыто всё, кроме тендеров, расценки и своей компании.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции, с отметкой служебной операции.
with
fn(sig) as (values ('public.osp_self_registered()'), ('public.current_counterparty_id()'), ('public.contractor_contracts()'),
  ('public.contractor_set_participation(uuid,text)'), ('public.bid_positions(uuid)'), ('public.contractor_org_card()'),
  ('public.bid_rates_save(uuid,jsonb)')),
checks(n, ok, what) as (
  select 1, (select count(*) from fn join pg_proc p on p.oid = to_regprocedure(fn.sig)
              where p.prosecdef and 'application_name=osp:internal' = any (coalesce(p.proconfig, '{}'))) = 7,
         'функции на месте: служебные, с отметкой пропуска'
  union all
  select 2, pg_get_functiondef('public.current_counterparty_id()'::regprocedure) like '%NOT ur.self_registered%',
         'current_counterparty_id: для учётки с регистрации — пусто'
  union all
  select 3, exists (select 1 from pg_policies where schemaname = 'public' and tablename = 's3_documents' and policyname = 'portal_contractor_select'
                      and qual like '%osp_self_registered()%' and qual like '%bypass%'),
         'правило файлов: учётке с регистрации файлов нет'
  union all
  select 4, pg_get_functiondef('public.contractor_contracts()'::regprocedure) like '%osp_self_registered()%'
            and pg_get_functiondef('public.contractor_set_participation(uuid,text)'::regprocedure) like '%osp_self_registered()%',
         'договоры и отметка участия: учётке с регистрации закрыты'
  union all
  select 5, pg_get_functiondef('public.bid_rates_save(uuid,jsonb)'::regprocedure) like '%Позиции нет в ВОР%',
         'цены учётки с регистрации — только на позиции ВОР'
  union all
  select 6, to_regclass('osp_private.bid_vor_files') is not null
            and not has_schema_privilege('public', 'osp_private', 'USAGE'),
         'разбор ВОР — в закрытой схеме'
  union all
  select 7, pg_get_viewdef('osp_private.kp_rates_registry_mv'::regclass) like '%registered_via%',
         'реестр расценок: цены компании с регистрации — только участника тендера'
  union all
  select 8, not exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.kp_rates_registry_mv') and not a.attisdropped),
         'материализованное представление реестра не в открытой схеме'
)
select case when ok then 'OK ' else 'FAIL ' end || what from checks order by n;
