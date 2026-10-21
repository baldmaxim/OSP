-- Проверка после 20261029_supply_vor_versions.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: таблица и функции ищутся через to_regclass / to_regprocedure.
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual, roles from pg_policies
  where schemaname = 'public' and tablename = 'tender_supply_revisions'
),
t as (select to_regclass('public.tender_supply_revisions') as oid),
fn as (
  select to_regprocedure('public.supply_vor_adopt(uuid, text, text)') as adopt,
         to_regprocedure('public.supply_rate_carry(uuid, integer, text, text, text)') as carry,
         to_regprocedure('public.supply_revisions_review(uuid, bigint[])') as review,
         to_regprocedure('public.supply_positions_by_key(jsonb)') as by_key
),
checks(n, ok, what) as (
  select 1, coalesce((select c.relrowsecurity from pg_class c, t where c.oid = t.oid), false),
         'версии ВОР: таблица создана, RLS включён'
  union all
  select 2, (select count(*) from pol) = 1
            and exists (select 1 from pol where cmd = 'SELECT' and roles = '{authenticated}' and qual like '%osp_is_employee()%'),
         'читает сотрудник; правил записи для вошедших нет'
  union all
  select 3, coalesce((select has_table_privilege('authenticated', t.oid, 'select')
                         and not has_table_privilege('authenticated', t.oid, 'insert')
                         and not has_table_privilege('authenticated', t.oid, 'update')
                         and not has_table_privilege('authenticated', t.oid, 'delete')
                         and not has_table_privilege('anon', t.oid, 'select') from t), false),
         'вошедшему — только чтение версий, гостю — ничего'
  union all
  select 4, (select count(*) from pg_attribute a where a.attrelid = to_regclass('public.tender_supply_sources') and a.attnum > 0
               and not a.attisdropped and a.attname in ('prior_document_ids', 'separate_at', 'separate_by')) = 3,
         'списки позиций: прежние файлы ВОР и ответ «отдельный ВОР»'
  union all
  select 5, coalesce((select fn.adopt is not null and fn.carry is not null and fn.review is not null and fn.by_key is not null
                         and has_function_privilege('authenticated', fn.adopt, 'execute')
                         and has_function_privilege('authenticated', fn.carry, 'execute')
                         and has_function_privilege('authenticated', fn.review, 'execute')
                         and not has_function_privilege('anon', fn.adopt, 'execute')
                         and not has_function_privilege('anon', fn.carry, 'execute')
                         and not has_function_privilege('anon', fn.review, 'execute')
                         and not has_function_privilege('authenticated', fn.by_key, 'execute') from fn), false),
         'решения снабжения (новая версия, перенос цены, «просмотрено») — вошедшему, гостю — нет; разбор позиций — только базе'
  union all
  select 6, exists (select 1 from pg_trigger tg where tg.tgrelid = to_regclass('public.tender_supply_sources')
                      and tg.tgname = 'tender_supply_sources_revision' and not tg.tgisinternal),
         'версию пишет триггер на списках позиций'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
