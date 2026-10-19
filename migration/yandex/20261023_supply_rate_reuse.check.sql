-- После 20261023_supply_rate_reuse: дата расценки, копии цен из других тендеров, поиск похожих, реестр СУ-10 без
-- копий. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
cols as (
  select column_name from information_schema.columns where table_schema = 'public' and table_name = 'tender_vor_supply_rates'
    and column_name in ('price_date', 'source_rate_id', 'source_tender_id', 'source_kind', 'name_tokens', 'name_words', 'unit_key')
),
fn as (
  select p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('supply_name_tokens', 'supply_name_words', 'supply_name_similarity', 'supply_autofill',
    'supply_suggestion_counts', 'supply_rate_suggestions', 'supply_rate_origins')
),
checks(n, ok, what) as (
  select 1, (select count(*) from cols) = 7,
         'у расценок семь новых колонок: день расценки, источник копии (расценка, тендер, способ), слова наименования, ед. изм. в едином виде'
  union all
  select 2, not exists (select 1 from public.tender_vor_supply_rates where price_date is null),
         'у каждой цены есть день расценки (прежним — по времени изменения, по Москве)'
  union all
  select 3, (select count(*) from fn) = 7 and not (select bool_or(prosecdef) from fn),
         'семь функций подбора — с правами вызывающего (правила по строкам действуют)'
  union all
  select 4, pg_get_functiondef('public.tender_vor_supply_rates_compute()'::regprocedure) like '%price_date%'
            and pg_get_functiondef('public.tender_vor_supply_rates_compute()'::regprocedure) like '%Europe/Moscow%',
         'триггер расчёта ставит день расценки по Москве и ведёт копии'
  union all
  select 5, public.supply_name_tokens('Труба стальная Ø57×3,5 ГОСТ 10704-91') @> array['57', '3.5', '10704', '91']
            and public.supply_name_similarity(public.supply_name_tokens('Труба электросварная 57х3,5'),
                                              public.supply_name_tokens('Труба стальная электросварная Ø57×3,5')) >= 0.5
            and public.supply_name_similarity(public.supply_name_tokens('Кабель 3х2,5'), public.supply_name_tokens('Труба 3х2,5')) = 0,
         'слова наименования и похожесть: числа отдельно, одни общие числа — не похожесть'
  union all
  select 6, exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'osp_private' and c.relname = 'supply_rates_registry_mv' and c.relkind = 'm')
            and pg_get_viewdef('osp_private.supply_rates_registry_mv'::regclass) like '%source_rate_id IS NULL%'
            and not exists (select 1 from pg_class c where c.relname = 'supply_rates_registry_mv_next'),
         'реестр СУ-10 пересобран в закрытой схеме: без скопированных цен, временного представления не осталось'
  union all
  select 7, (select count(*) from pg_indexes where schemaname = 'osp_private' and tablename = 'supply_rates_registry_mv') = 7
            and exists (select 1 from pg_indexes where schemaname = 'osp_private' and indexname = 'idx_supply_rates_mv_id'
                          and indexdef like 'CREATE UNIQUE INDEX%'),
         'у реестра семь индексов с прежними именами (уникальный id — для пересчёта без блокировки)'
  union all
  select 8, (select count(*) from pg_views where schemaname = 'public'
               and viewname in ('supply_rates_registry', 'supply_rates_registry_filter_objects',
                                'supply_rates_registry_filter_tenders', 'supply_rates_registry_units')
               and definition like '%osp_private.supply_rates_registry_mv%' and definition like '%osp_registry_reader()%') = 4,
         'четыре представления реестра читают новое представление и по-прежнему только для сотрудников'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
