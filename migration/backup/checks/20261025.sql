-- Проверка после 20261025_supply_docs_similarity.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: функции вызываются только если есть (query_to_xml).
with
checks(n, ok, what) as (
  select 1, exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tender_supply_links'
                      and column_name = 's3_document_id')
            and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tender_supply_links'
                          and column_name = 'url' and is_nullable = 'YES')
            and exists (select 1 from pg_constraint where conname = 'tender_supply_links_target_check'
                          and conrelid = to_regclass('public.tender_supply_links')),
         'документ позиции — адрес или файл (одно из двух)'
  union all
  select 2, (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'tender_vor_supply_rates'
             and column_name in ('name_stems', 'name_nums', 'name_heads') and is_generated = 'ALWAYS') = 3,
         'у расценок вычисляемые основы слов, числа и ключи поиска похожих'
  union all
  select 3, (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and not p.prosecdef and p.proname in ('supply_name_prepare', 'supply_name_pieces', 'supply_stem_word',
               'supply_name_stems', 'supply_norm_number', 'supply_name_nums', 'supply_name_heads', 'supply_name_word_share', 'supply_name_score')) = 9
            and coalesce(pg_get_function_result(to_regprocedure('public.supply_rate_suggestions(uuid, text, text, text, integer)')) like '%same_size%', false)
            and coalesce(pg_get_function_result(to_regprocedure('public.supply_rate_origins(uuid)')) like '%doc_key%', false),
         'функции похожести — с правами вызывающего; меню похожих — с размером и файлом документа'
  union all
  select 4, case when to_regprocedure('public.supply_name_score(text[], text[], text[], text[], numeric)') is null then false
                 else (xpath('/row/ok/text()', query_to_xml($q$
                   select public.supply_name_score(public.supply_name_stems('Клапан Сигмавент-90-НО-400x300-SVF(220)-к'),
                            public.supply_name_nums('Клапан Сигмавент-90-НО-400x300-SVF(220)-к'),
                            public.supply_name_stems('Сигмавент-90-НО-300 х 400 SVF 220 к'), public.supply_name_nums('Сигмавент-90-НО-300 х 400 SVF 220 к'), 0.6) >= 0.75
                      and public.supply_name_score(public.supply_name_stems('Клапан Сигмавент-90-НО-400x300-SVF(220)-к'),
                            public.supply_name_nums('Клапан Сигмавент-90-НО-400x300-SVF(220)-к'),
                            public.supply_name_stems('Клапан Сигмавент-90-НО-450x350-SVF(220)-к'), public.supply_name_nums('Клапан Сигмавент-90-НО-450x350-SVF(220)-к'), 0.6) < 0.75 as ok
                   $q$, false, true, '')))[1]::text = 'true' end,
         'похожесть: тот же клапан в другой записи — похож, другой размер — нет'
  union all
  select 5, coalesce(not has_function_privilege('anon', to_regprocedure('public.supply_rate_suggestions(uuid, text, text, text, integer)'), 'execute')
                 and not has_function_privilege('anon', to_regprocedure('public.supply_name_score(text[], text[], text[], text[], numeric)'), 'execute')
                 and has_function_privilege('authenticated', to_regprocedure('public.supply_name_stems(text)'), 'execute'), false),
         'гостю функции похожести не выданы; вошедшему — функции вычисляемых колонок'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
