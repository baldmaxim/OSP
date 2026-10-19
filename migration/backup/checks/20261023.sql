-- Проверка после 20261023_supply_rate_reuse.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: функции вызываются только если есть (query_to_xml).
with
checks(n, ok, what) as (
  select 1, (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'tender_vor_supply_rates'
             and column_name in ('price_date', 'price_by', 'source_rate_id', 'source_tender_id', 'source_kind', 'name_tokens', 'name_words', 'unit_key')) = 8,
         'у расценок восемь новых колонок: день расценки, кто поставил цену, источник копии, слова наименования, ед. изм. в едином виде'
  union all
  select 2, case when not exists (select 1 from information_schema.columns where table_schema = 'public'
                                   and table_name = 'tender_vor_supply_rates' and column_name = 'price_date') then false
                 else (xpath('/row/n/text()', query_to_xml(
                   'select count(*) as n from public.tender_vor_supply_rates where price_date is null', false, true, '')))[1]::text = '0' end,
         'у каждой цены есть день расценки'
  union all
  select 3, (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname in ('supply_name_tokens', 'supply_name_words', 'supply_name_similarity', 'supply_autofill',
               'supply_suggestion_counts', 'supply_rate_suggestions', 'supply_rate_origins') and not p.prosecdef) = 7,
         'семь функций подбора — с правами вызывающего'
  union all
  select 4, coalesce(not has_function_privilege('anon', to_regprocedure('public.supply_autofill(uuid)'), 'execute')
                 and not has_function_privilege('anon', to_regprocedure('public.supply_rate_suggestions(uuid, text, text, text, integer)'), 'execute'), false),
         'гостю функции подбора не выданы'
  union all
  select 5, coalesce(pg_get_viewdef(to_regclass('public.supply_rates_registry_mv')) like '%source_rate_id IS NULL%', false)
            and coalesce(not has_table_privilege('authenticated', to_regclass('public.supply_rates_registry_mv'), 'select'), false),
         'реестр СУ-10 без скопированных цен; само представление по-прежнему закрыто для вошедших'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
