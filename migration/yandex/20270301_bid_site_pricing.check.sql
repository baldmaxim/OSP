-- После 20270301_bid_site_pricing: расценка на сайте, цены снабжения с разрешения отдела, изменения ВОР, граница кабинета.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
fns(sig) as (
  values ('public.bid_supply_request(uuid)'), ('public.bid_supply_decide(uuid,uuid,boolean)'), ('public.bid_supply_list(uuid[])'),
         ('public.bid_supply_prices(uuid,uuid)'), ('public.bid_supply_take(uuid,jsonb,boolean)'), ('public.bid_rates_save(uuid,jsonb)'),
         ('public.bid_vor_changes(uuid)'), ('public.current_counterparty_id()')
),
pol as (
  select pg_get_expr(p.polqual, p.polrelid) as qual
  from pg_policy p where p.polrelid = 'public.s3_documents'::regclass and p.polname = 'portal_contractor_select'
),
mv as (select definition from pg_matviews where schemaname = 'osp_private' and matviewname = 'kp_rates_registry_mv'),
checks(n, ok, what) as (
  select 1, (select count(*) from fns join pg_proc p on p.oid = to_regprocedure(fns.sig)
             where p.prosecdef and p.proconfig @> array['application_name=osp:internal']) = 8,
         'bid_supply_*, bid_rates_save, bid_vor_changes, current_counterparty_id — служебные функции с отметкой'
  union all
  select 2, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.tender_bid_supply_access'::regclass)
            and (select count(*) from pg_policy where polrelid = 'public.tender_bid_supply_access'::regclass) = 2
            and exists (select 1 from osp_meta.policy_roles where table_name = 'tender_bid_supply_access'
                        and policy_name = 'tender_bid_supply_access_read'),
         'разрешения на цены снабжения: правила включены (пропуск + чтение сотруднику и своей организации), прямой записи нет'
  union all
  select 3, pg_get_function_result('public.bid_supply_prices(uuid,uuid)'::regprocedure) = 'TABLE(item_key text, unit_key text, price numeric)'
            and (select prosrc like '%status = ''granted''%' and prosrc like '%bid_tender_open%' from pg_proc
                 where oid = 'public.bid_supply_prices(uuid,uuid)'::regprocedure),
         'цены снабжения подрядчику: только ключ и цена, только с разрешением и пока идёт приём'
  union all
  select 4, (select pg_get_constraintdef(c.oid) like '%supply%' from pg_constraint c
             where c.conrelid = 'public.tender_bid_rates'::regclass and c.conname = 'tender_bid_rates_source_check')
            and (select prosrc like '%bid_known_positions%' from pg_proc where oid = 'public.bid_rates_save(uuid,jsonb)'::regprocedure),
         'цены подрядчика: отметка «supply»; позиции сверяются с разбором ВОР'
  union all
  select 5, exists (select 1 from pg_trigger where tgrelid = 'public.s3_documents'::regclass and tgname = 's3_documents_bid_vor_archive'
                    and not tgisinternal)
            and to_regclass('osp_private.bid_vor_archive') is not null,
         'удалённый файл ВОР — разбор в архив (прежняя версия ведомости для кабинета)'
  union all
  select 6, (select qual not like '%contract%' and qual like '%bid_tender_open%' from pol),
         'файлы подрядчику: без файлов договоров, по заявке — пока идёт приём'
  union all
  select 7, (select prosrc like '%is_blocked = false%' from pg_proc where oid = 'public.current_counterparty_id()'::regprocedure),
         'организация заблокированной учётки не определяется'
  union all
  select 8, coalesce((select definition like '%tender_bid_rates%' and definition like '%supply%' and definition like '%rejected%'
                      and definition like '%registered_via%' from mv), false)
            and to_regclass('osp_private.kp_rates_registry_mv_next') is null
            and exists (select 1 from pg_indexes where schemaname = 'osp_private' and indexname = 'idx_kp_rates_mv_id'),
         'реестр КП пересобран: цены с сайта — без взятых у снабжения и без отклонённых заявок; уникальный индекс на месте'
  union all
  select 9, true,
         'реестр КП: строк с сайта — ' || (select count(*) from osp_private.kp_rates_registry_mv where source_kind = 'site')
           || '; цен подрядчиков с сайта в базе — ' || (select count(*) from public.tender_bid_rates where price is not null)
           || '; архив ВОР — ' || (select count(*) from osp_private.bid_vor_archive)
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
