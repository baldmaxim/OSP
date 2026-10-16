-- После 20261020_supply_pricing: расценка снабжением на сайте — колонки и триггеры расценок, списки позиций,
-- журнал, прогресс и права под одну учётку. Строки «OK …» / «FAIL …»; выполняется в транзакции миграции
-- (migrate.sh), с отметкой служебной операции.
with
t as (
  select c.relname, c.relrowsecurity and c.relforcerowsecurity as forced
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname in ('tender_vor_supply_rates', 'tender_supply_sources', 'tender_supply_rate_log')
),
pol as (
  select tablename, policyname, cmd, coalesce(qual, '') as qual, coalesce(with_check, '') as chk from pg_policies
  where schemaname = 'public' and tablename in ('tender_vor_supply_rates', 'tender_supply_sources', 'tender_supply_rate_log')
),
fn as (
  select p.proname, p.prosecdef, coalesce(p.proconfig::text, '') ~ 'application_name=osp:internal' as marked
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('supply_norm_name', 'supply_can_edit', 'supply_rates_locked',
    'tender_vor_supply_rates_compute', 'tender_supply_guard', 'tender_supply_rate_log_write',
    'tender_supply_sources_compute', 'supply_estimate_rename')
),
trg as (
  select c.relname, tg.tgname from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not tg.tgisinternal
    and c.relname in ('tender_vor_supply_rates', 'tender_supply_sources')
),
checks(n, ok, what) as (
  select 1, (select count(*) from t) = 3 and (select bool_and(forced) from t),
         'расценки, списки позиций и журнал: правила по строкам включены и действуют на владельца'
  union all
  select 2, (select count(*) from pol where policyname = 'osp_internal') = 3,
         'у каждой из трёх таблиц — пропуск служебных операций'
  union all
  select 3, not exists (select 1 from pol where tablename = 'tender_vor_supply_rates' and policyname = 'Allow all for authenticated users')
            and not exists (select 1 from osp_meta.policy_roles where schema_name = 'public'
                              and table_name = 'tender_vor_supply_rates' and policy_name = 'Allow all for authenticated users'),
         'прежней широкой политики расценок («любой сотрудник всё») нет, записи о её ролях тоже'
  union all
  select 4, (select count(*) from pol where policyname <> 'osp_internal' and qual || chk like '%role_in(%authenticated%') = 9
            and exists (select 1 from pol where tablename = 'tender_vor_supply_rates' and cmd = 'SELECT' and qual like '%osp_is_employee()%')
            and (select count(*) from pol where tablename = 'tender_vor_supply_rates' and cmd in ('INSERT', 'UPDATE', 'DELETE')
                   and qual || chk like '%supply_can_edit()%') = 3
            and (select count(*) from pol where tablename = 'tender_supply_sources' and cmd in ('INSERT', 'UPDATE', 'DELETE')
                   and qual || chk like '%supply_can_edit()%') = 3
            and (select count(*) from pol where tablename = 'tender_supply_rate_log' and policyname <> 'osp_internal') = 1,
         'читает сотрудник; пишет только право правки «Тендеры» или «Тендеры на материалы»; журнал — только чтение'
  union all
  select 5, (select count(*) from osp_meta.policy_roles where schema_name = 'public'
             and table_name in ('tender_vor_supply_rates', 'tender_supply_sources', 'tender_supply_rate_log')
             and roles = array['authenticated']) = 9,
         'записи о ролях девяти новых политик'
  union all
  select 6, (select count(*) from fn) = 8
            and (select bool_and(prosecdef = marked) from fn)
            and (select count(*) from fn where prosecdef) = 2,
         'восемь функций; служебные (закрытие, журнал) — с отметкой osp:internal, остальные — с правами вызывающего'
  union all
  select 7, (select count(*) from trg where relname = 'tender_vor_supply_rates'
               and tgname in ('tender_vor_supply_rates_compute', 'tender_vor_supply_rates_guard', 'tender_vor_supply_rates_log')) = 3
            and (select count(*) from trg where relname = 'tender_supply_sources'
               and tgname in ('tender_supply_sources_compute', 'tender_supply_sources_guard')) = 2,
         'триггеры расчёта, закрытия и журнала на месте'
  union all
  select 8, public.supply_norm_name('Труба МЕДНАЯ Ø12,7') = 'tpyбameдhaя12.7'
            and public.supply_norm_name('1,2,3 мм') = '1.23mm',
         'ключ наименования как в портале (кириллица в нижнем регистре, десятичная точка, двойники)'
  union all
  select 9, exists (select 1 from pg_attribute a where a.attrelid = 'public.tender_vor_supply_rates'::regclass
                      and a.attname = 'material_key' and a.attgenerated = 's')
            and not exists (select 1 from public.tender_vor_supply_rates
                            where material_key is distinct from public.supply_norm_name(material_name)),
         'ключ наименования у каждой расценки вычислен'
  union all
  select 10, coalesce((select o.option_value::boolean from pg_class c, pg_options_to_table(c.reloptions) o
                       where c.oid = 'public.tender_supply_progress'::regclass and o.option_name = 'security_invoker'), false),
         'прогресс расценки читается с правами вызывающего'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
