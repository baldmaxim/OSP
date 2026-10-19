-- После 20261021_larix_rates_registry: договорные расценки Larix — позиция с обеими ценами, без повторов, в
-- закрытой схеме; вкладка читает представление. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции
-- (migrate.sh), с отметкой служебной операции.
with
v as (
  select c.oid, coalesce((select o.option_value::boolean from pg_options_to_table(c.reloptions) o where o.option_name = 'security_invoker'), false) as invoker
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'larix_rates_registry' and c.relkind = 'v'
),
dups as (
  select 1 from osp_private.larix_rates
  group by contract_id, project_id, contractor_id, lower(btrim(regexp_replace(item_name, '\s+', ' ', 'g'))),
           lower(btrim(regexp_replace(coalesce(unit, ''), '\s+', ' ', 'g'))), price_material, price_work
  having count(*) > 1
),
checks(n, ok, what) as (
  select 1, to_regclass('osp_private.larix_rates') is not null
            and not (select relrowsecurity from pg_class where oid = to_regclass('osp_private.larix_rates')),
         'договорные расценки — в закрытой схеме (osp_private.larix_rates), без правил по строкам: поиск идёт по индексу'
  union all
  select 2, exists (select 1 from v where not invoker)
            and pg_get_viewdef('public.larix_rates_registry'::regclass) like '%role_in(%authenticated%'
            and pg_get_viewdef('public.larix_rates_registry'::regclass) like '%osp_can(%rates_registry%view%',
         'представление larix_rates_registry: строки — только вошедшему с правом раздела «Реестр расценок»'
  union all
  select 3, (select count(*) from pg_rewrite r where r.ev_class = 'public.larix_rates_registry'::regclass and r.is_instead
               and r.rulename in ('osp_readonly_insert', 'osp_readonly_update', 'osp_readonly_delete')) = 3,
         'через представление larix_rates_registry записать нельзя'
  union all
  select 4, not exists (select 1 from dups),
         'повторов нет: та же позиция того же договора с теми же ценами — одна строка'
  union all
  select 5, not exists (select 1 from osp_private.larix_rates where price_material is null and price_work is null),
         'у каждой строки есть цена материалов или цена работ'
  union all
  select 6, (select count(*) from public.larix_contract_rates) = 0 or (select count(*) from osp_private.larix_rates) > 0,
         'уже загруженные расценки перенесены: строк ' || (select count(*) from osp_private.larix_rates)
         || ' (было строк «материал/работа» ' || (select count(*) from public.larix_contract_rates) || ')'
  union all
  select 7, (select count(*) from osp_private.larix_rates) <= (select count(*) from public.larix_contract_rates)
            or (select count(*) from public.larix_contract_rates) = 0,
         'позиций не больше, чем было строк «материал/работа»'
  union all
  select 8, (select bool_and(pg_get_functiondef(p.oid) like '%osp_private.larix_rates%'
                             and pg_get_functiondef(p.oid) not like '%INSERT INTO public.larix_contract_rates%')
             from pg_proc p where p.oid = 'public.larix_sync_finish(bigint,integer,integer,text[],boolean)'::regprocedure),
         'замена расценок (larix_sync_finish) пишет новую таблицу'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
