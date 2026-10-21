-- После 20261029_supply_vor_versions: версии ВОР в расценке снабжением — таблица, колонки списков позиций, функции,
-- триггер и права под одну учётку. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с
-- отметкой служебной операции.
with
pol as (
  select policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk from pg_policies
  where schemaname = 'public' and tablename = 'tender_supply_revisions'
),
col as (
  select a.attname from pg_attribute a
  where a.attrelid = to_regclass('public.tender_supply_sources') and a.attnum > 0 and not a.attisdropped
    and a.attname in ('prior_document_ids', 'separate_at', 'separate_by')
),
fn as (
  select p.proname, p.prosecdef, coalesce(p.proconfig::text, '') ~ 'application_name=osp:internal' as marked
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('supply_positions_by_key', 'tender_supply_sources_compute', 'tender_supply_guard',
    'tender_supply_revision_write', 'supply_vor_adopt', 'supply_rate_carry', 'supply_revisions_review')
),
checks(n, ok, what) as (
  select 1, coalesce((select c.relrowsecurity and c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relname = 'tender_supply_revisions' and c.relkind = 'r'), false),
         'версии ВОР: таблица есть, правила по строкам включены и действуют на владельца'
  union all
  select 2, exists (select 1 from pol where policyname = 'osp_internal')
            and (select count(*) from pol where policyname <> 'osp_internal') = 1
            and exists (select 1 from pol where cmd = 'SELECT' and policyname <> 'osp_internal'
                          and qual like '%role_in(%authenticated%' and qual like '%osp_is_employee()%'),
         'пропуск служебных операций; читает сотрудник, правил записи для вошедших нет'
  union all
  select 3, (select count(*) from osp_meta.policy_roles where schema_name = 'public' and table_name = 'tender_supply_revisions'
             and roles = array['authenticated']) = 1,
         'запись о ролях политики чтения'
  union all
  select 4, (select count(*) from col) = 3,
         'списки позиций: прежние файлы ВОР и ответ «отдельный ВОР»'
  union all
  select 5, (select count(*) from fn) = 7
            and (select bool_and(prosecdef = marked) from fn)
            and (select array_agg(proname order by proname) from fn where prosecdef) = array['supply_revisions_review', 'tender_supply_revision_write']::name[],
         'семь функций; служебные (запись версии, «просмотрено») — с отметкой osp:internal, остальные — с правами вызывающего'
  union all
  select 6, exists (select 1 from pg_trigger tg where tg.tgrelid = to_regclass('public.tender_supply_sources')
                      and tg.tgname = 'tender_supply_sources_revision' and not tg.tgisinternal),
         'версию пишет триггер на списках позиций'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
