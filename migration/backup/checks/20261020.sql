-- Проверка после 20261020_supply_pricing.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: функции вызываются только если есть (query_to_xml).
with
t as (
  select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname in ('tender_supply_sources', 'tender_supply_rate_log')
),
pol as (
  select tablename, policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk, roles from pg_policies
  where schemaname = 'public' and tablename in ('tender_vor_supply_rates', 'tender_supply_sources', 'tender_supply_rate_log')
),
trg as (
  select c.relname, tg.tgname from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not tg.tgisinternal and c.relname in ('tender_vor_supply_rates', 'tender_supply_sources')
),
checks(n, ok, what) as (
  select 1, (select count(*) from t) = 2 and coalesce((select bool_and(relrowsecurity) from t), false),
         'списки позиций и журнал расценок созданы, RLS включён'
  union all
  select 2, (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'tender_vor_supply_rates'
             and column_name in ('price_input', 'input_value', 'volume_at_input', 'supply_price_exact', 'supply_total',
                                 'row_version', 'updated_by', 'material_key')) = 8,
         'у расценок восемь новых колонок (способ ввода, точная цена, сумма, версия, ключ наименования)'
  union all
  select 3, not exists (select 1 from pol where tablename = 'tender_vor_supply_rates' and policyname = 'Allow all for authenticated users')
            and exists (select 1 from pol where tablename = 'tender_vor_supply_rates' and cmd = 'SELECT'
                          and roles = '{authenticated}' and qual like '%osp_is_employee()%')
            and (select count(*) from pol where tablename = 'tender_vor_supply_rates' and cmd in ('INSERT', 'UPDATE', 'DELETE')
                   and roles = '{authenticated}' and qual || chk like '%supply_can_edit()%') = 3,
         'расценки: читает сотрудник, пишет только право правки «Тендеры» или «Тендеры на материалы»'
  union all
  select 4, (select count(*) from pol where tablename = 'tender_supply_sources' and roles = '{authenticated}') = 4
            and (select count(*) from pol where tablename = 'tender_supply_rate_log') = 1
            and exists (select 1 from pol where tablename = 'tender_supply_rate_log' and cmd = 'SELECT' and roles = '{authenticated}'),
         'списки позиций — как расценки; журнал — только чтение сотрудником'
  union all
  select 5, coalesce(not has_table_privilege('anon', to_regclass('public.tender_supply_sources'), 'select')
                 and not has_table_privilege('anon', to_regclass('public.tender_supply_rate_log'), 'select')
                 and not has_table_privilege('anon', to_regclass('public.tender_supply_progress'), 'select')
                 and not has_table_privilege('authenticated', to_regclass('public.tender_supply_rate_log'), 'insert,update,delete'), false),
         'гостю ничего не выдано; журнал вошедшему — только чтение'
  union all
  select 6, (select count(*) from trg where relname = 'tender_vor_supply_rates'
               and tgname in ('tender_vor_supply_rates_compute', 'tender_vor_supply_rates_guard', 'tender_vor_supply_rates_log')) = 3
            and (select count(*) from trg where relname = 'tender_supply_sources'
               and tgname in ('tender_supply_sources_compute', 'tender_supply_sources_guard')) = 2,
         'триггеры расчёта, закрытия и журнала на месте'
  union all
  select 7, case when to_regprocedure('public.supply_norm_name(text)') is null then false
                 else (xpath('/row/ok/text()', query_to_xml(
                   'select public.supply_norm_name(''Труба МЕДНАЯ Ø12,7'') = ''tpyбameдhaя12.7''
                       and public.supply_norm_name(''1,2,3 мм'') = ''1.23mm'' as ok', false, true, '')))[1]::text = 'true' end,
         'ключ наименования как в портале (кириллица в нижнем регистре, десятичная точка, двойники)'
  union all
  select 8, case when to_regprocedure('public.supply_norm_name(text)') is null
                   or not exists (select 1 from information_schema.columns where table_schema = 'public'
                                   and table_name = 'tender_vor_supply_rates' and column_name = 'material_key') then false
                 else (xpath('/row/n/text()', query_to_xml(
                   'select count(*) as n from public.tender_vor_supply_rates
                     where material_key is distinct from public.supply_norm_name(material_name)', false, true, '')))[1]::text = '0' end,
         'ключ наименования у каждой расценки вычислен'
  union all
  select 9, (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname in ('supply_rates_locked', 'tender_supply_rate_log_write') and p.prosecdef) = 2
            and coalesce(not has_function_privilege('anon', to_regprocedure('public.supply_rates_locked(uuid)'), 'execute'), false),
         'служебные функции закрытия и журнала; гостю не выданы'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
