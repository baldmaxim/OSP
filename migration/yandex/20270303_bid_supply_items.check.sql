-- После 20270303_bid_supply_items: цены снабжения подрядчику — по позициям, решает инженер ОСП или администратор.
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
fns as (
  select p.oid, p.proname, p.prosecdef, p.proconfig, p.prosrc
  from pg_proc p
  where p.oid in (to_regprocedure('public.bid_supply_prices(uuid,uuid)'), to_regprocedure('public.bid_supply_take(uuid,jsonb,boolean)'),
                  to_regprocedure('public.bid_supply_decide(uuid,uuid,boolean)'), to_regprocedure('public.bid_supply_list(uuid[])'),
                  to_regprocedure('public.bid_supply_grant(uuid,uuid,jsonb,boolean)'), to_regprocedure('public.bid_supply_items(uuid,uuid)'),
                  to_regprocedure('public.osp_supply_engineer()'))
),
doc_rows as (select p.prosrc from pg_proc p where p.oid = to_regprocedure('osp_private.bid_supply_doc_rows(uuid,uuid)')),
open_rows as (select p.prosrc from pg_proc p where p.oid = to_regprocedure('osp_private.bid_supply_open_rows(uuid,uuid)')),
checks(n, ok, what) as (
  select 1, (select count(*) from fns where prosecdef and proconfig @> array['application_name=osp:internal']) = 7,
         'bid_supply_prices / take / decide / list / grant / items, osp_supply_engineer — служебные функции с отметкой'
  union all
  select 2, to_regclass('public.tender_bid_supply_items') is not null
            and (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.tender_bid_supply_items'::regclass)
            and (select count(*) from pg_policy where polrelid = 'public.tender_bid_supply_items'::regclass) = 1,
         'открытые позиции: таблица под правилами, только пропуск служебных функций (напрямую не читается)'
  union all
  select 3, coalesce((select prosrc like '%status = ''granted''%' and prosrc like '%tender_bid_supply_items%' from open_rows), false),
         'открытая цена = разрешение отдела и отмеченная позиция'
  union all
  select 4, (select count(*) from fns where proname in ('bid_supply_prices', 'bid_supply_take')
               and prosrc like '%bid_supply_open_rows%' and prosrc not like '%bid_supply_price_rows%') = 2
            and coalesce((select prosrc like '%bid_supply_open_rows%' and prosrc not like '%bid_supply_price_rows%' from doc_rows), false),
         'цены, «взять» и счета подрядчику — только по открытым позициям'
  union all
  select 5, (select count(*) from fns where proname in ('bid_supply_decide', 'bid_supply_list', 'bid_supply_grant', 'bid_supply_items')
               and prosrc like '%osp_supply_engineer()%') = 4
            and coalesce((select pg_get_expr(polqual, polrelid) like '%osp_supply_engineer()%' from pg_policy
                          where polrelid = 'public.tender_bid_supply_access'::regclass and polname = 'tender_bid_supply_access_read'), false),
         'решает и видит просьбы только инженер ОСП или администратор'
  union all
  select 6, coalesce((select prosrc like '%IF p_allow THEN%RAISE EXCEPTION%' and prosrc like '%DELETE FROM public.tender_bid_supply_items%'
                      from fns where proname = 'bid_supply_decide'), false),
         'разрешить тендер целиком нельзя (только по позициям); запрет закрывает открытые позиции'
  union all
  select 7, (select count(*) from public.tender_bid_supply_access a where a.status = 'granted'
               and not exists (select 1 from public.tender_bid_supply_items i
                               where i.tender_id = a.tender_id and i.counterparty_id = a.counterparty_id)) >= 0,
         'разрешений: ' || (select count(*) from public.tender_bid_supply_access where status = 'granted')
           || ' (без открытых позиций — ' || (select count(*) from public.tender_bid_supply_access a where a.status = 'granted'
               and not exists (select 1 from public.tender_bid_supply_items i
                               where i.tender_id = a.tender_id and i.counterparty_id = a.counterparty_id))
           || ', им цены не отдаются, пока инженер не отметит позиции); просьб ждёт — '
           || (select count(*) from public.tender_bid_supply_access where status = 'requested')
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
