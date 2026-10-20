-- После 20261025_supply_docs_similarity: документ позиции — адрес или файл, новая похожесть наименований (колонки,
-- функции, меню похожих). Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой
-- служебной операции.
with
checks(n, ok, what) as (
  select 1, exists (select 1 from pg_attribute a where a.attrelid = 'public.tender_supply_links'::regclass
                      and a.attname = 's3_document_id' and not a.attisdropped)
            and exists (select 1 from pg_attribute a where a.attrelid = 'public.tender_supply_links'::regclass
                          and a.attname = 'url' and not a.attnotnull)
            and exists (select 1 from pg_constraint where conname = 'tender_supply_links_target_check'
                          and conrelid = 'public.tender_supply_links'::regclass),
         'документ позиции — адрес или файл (одно из двух)'
  union all
  select 2, pg_get_functiondef('public.tender_supply_links_touch()'::regprocedure) like '%s3_document_id%',
         'записали адрес — файл снимается, и наоборот'
  union all
  select 3, (select count(*) from pg_attribute a where a.attrelid = 'public.tender_vor_supply_rates'::regclass
             and a.attname in ('name_stems', 'name_nums', 'name_heads') and a.attgenerated = 's') = 3,
         'у расценок вычисляемые основы слов, числа и ключи поиска похожих'
  union all
  select 4, (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and not p.prosecdef and p.proname in ('supply_name_prepare', 'supply_name_pieces', 'supply_stem_word',
               'supply_name_stems', 'supply_norm_number', 'supply_name_nums', 'supply_name_heads', 'supply_name_word_share', 'supply_name_score')) = 9
            and pg_get_function_result('public.supply_rate_suggestions(uuid, text, text, text, integer)'::regprocedure) like '%same_size%'
            and pg_get_function_result('public.supply_rate_origins(uuid)'::regprocedure) like '%doc_key%',
         'функции похожести — с правами вызывающего; меню похожих — с размером и файлом документа'
  union all
  select 5, public.supply_name_score(public.supply_name_stems('Клапан Сигмавент-90-НО-400x300-SVF(220)-к'),
              public.supply_name_nums('Клапан Сигмавент-90-НО-400x300-SVF(220)-к'),
              public.supply_name_stems('Сигмавент-90-НО-300 х 400 SVF 220 к'), public.supply_name_nums('Сигмавент-90-НО-300 х 400 SVF 220 к'), 0.6) >= 0.75
            and public.supply_name_score(public.supply_name_stems('Клапан Сигмавент-90-НО-400x300-SVF(220)-к'),
              public.supply_name_nums('Клапан Сигмавент-90-НО-400x300-SVF(220)-к'),
              public.supply_name_stems('Клапан Сигмавент-90-НО-450x350-SVF(220)-к'), public.supply_name_nums('Клапан Сигмавент-90-НО-450x350-SVF(220)-к'), 0.6) < 0.75,
         'похожесть: тот же клапан в другой записи — похож, другой размер — нет'
  union all
  select 6, (select count(*) from public.tender_vor_supply_rates where name_heads is null) = 0,
         'у всех расценок посчитаны ключи поиска похожих'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
