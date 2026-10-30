-- Проверка после 20261121_cost_plan_calc_objects.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции (и до 20261116) отвечает FAIL, а не падает: всё — через каталог.
with
tbl as (select to_regclass('public.cost_plan_compensation') as rel),
cols as (
  select column_name, data_type from information_schema.columns
  where table_schema = 'public' and table_name = 'cost_plan_compensation'
),
checks(n, ok, what) as (
  select 1, (select count(*) from cols where column_name in ('vat_compensated', 'inflation_compensated') and data_type = 'boolean') = 2
            and (select count(*) from cols where column_name in ('vat_percent', 'inflation_percent') and data_type = 'numeric') = 2
            and (select count(*) from cols where column_name in ('vat_document_id', 'inflation_document_id') and data_type = 'uuid') = 2,
         'компенсация НДС и инфляции: да / нет, процент, подтверждающий документ'
  union all
  select 2, (select count(*) from pg_constraint, tbl where conrelid = tbl.rel and contype = 'f'
               and confrelid = to_regclass('public.object_documents') and confdeltype = 'n') = 2,
         'подтверждающий документ — из документов объекта; удаление документа снимает ссылку'
  union all
  select 3, (select count(*) from pg_constraint, tbl where conrelid = tbl.rel and contype = 'c'
               and conname in ('cost_plan_compensation_vat_check', 'cost_plan_compensation_inflation_check')) = 2,
         'процент и документ — только при «да»'
  union all
  select 4, coalesce((select prosrc like '%object_documents%' from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                      where s.nspname = 'public' and p.proname = 'cost_plan_compensation_touch'), false),
         'триггер проверяет документ того же объекта'
  union all
  select 5, coalesce((select relrowsecurity from pg_class, tbl where oid = tbl.rel), false)
            and not coalesce(has_table_privilege('anon', (select rel from tbl), 'select'), false),
         'cost_plan_compensation: RLS на месте, анониму закрыто'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
