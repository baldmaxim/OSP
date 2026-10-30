-- После 20261121_cost_plan_calc_objects: у компенсации НДС и инфляции — да / нет, процент и подтверждающий документ
-- объекта; ограничения, ссылки на документы объекта и триггер на месте, правила по строкам не тронуты. Строки
-- «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
cols as (
  select column_name, data_type, numeric_precision, numeric_scale from information_schema.columns
  where table_schema = 'public' and table_name = 'cost_plan_compensation'
),
checks(n, ok, what) as (
  select 1, (select count(*) from cols where column_name in ('vat_compensated', 'inflation_compensated') and data_type = 'boolean') = 2
            and (select count(*) from cols where column_name in ('vat_percent', 'inflation_percent') and data_type = 'numeric'
                   and numeric_precision = 5 and numeric_scale = 2) = 2
            and (select count(*) from cols where column_name in ('vat_document_id', 'inflation_document_id') and data_type = 'uuid') = 2
            and (select count(*) from cols where column_name in ('vat_note', 'inflation_note')) = 2,
         'колонки: да / нет, процент, подтверждающий документ; примечания на месте'
  union all
  select 2, (select count(*) from pg_constraint where conrelid = 'public.cost_plan_compensation'::regclass and contype = 'f'
               and confrelid = 'public.object_documents'::regclass and confdeltype = 'n') = 2,
         'подтверждающий документ — из документов объекта; удаление документа снимает ссылку'
  union all
  select 3, (select count(*) from pg_constraint where conrelid = 'public.cost_plan_compensation'::regclass and contype = 'c'
               and conname in ('cost_plan_compensation_vat_check', 'cost_plan_compensation_inflation_check')
               and pg_get_constraintdef(oid) like '%<= (100)%') = 2,
         'процент и документ — только при «да», процент от 0 до 100'
  union all
  select 4, exists (select 1 from pg_trigger tg where tg.tgrelid = 'public.cost_plan_compensation'::regclass
                      and tg.tgname = 'cost_plan_compensation_touch' and not tg.tgisinternal)
            and (select prosrc like '%object_documents%' and not prosecdef from pg_proc
                 where oid = 'public.cost_plan_compensation_touch()'::regprocedure),
         'триггер: кто изменил и документ того же объекта (с правами вызывающего)'
  union all
  select 5, coalesce((select relrowsecurity and relforcerowsecurity from pg_class
                      where oid = 'public.cost_plan_compensation'::regclass), false)
            and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'cost_plan_compensation') = 5,
         'cost_plan_compensation: правила по строкам на месте (пропуск и четыре политики)'
  union all
  select 6, true, 'строк сведений: ' || (select count(*) from public.cost_plan_compensation)
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
