-- Проверка после 20270122_contracts_reopen_with_live_ds.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение и только каталог: до миграции отвечает FAIL, а не падает. Выполняется на копии (rehearse.sh) и на проде
-- в SQL Editor после миграции. Поведение — tests/psdc/contract-reopen.test.mjs.
with
fn as (
  select p.prosrc, p.prosecdef
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'contracts_hierarchy_guard' and p.pronargs = 0
),
trg as (
  select t.tgenabled
  from pg_trigger t
  where not t.tgisinternal and t.tgname = 'trg_contracts_hierarchy_guard'
    and t.tgrelid = coalesce(to_regclass('public.contracts'), 0::regclass)
),
checks(n, ok, what) as (
  select 1, exists (select 1 from fn where prosrc like '%AND deleted_at IS NULL AND status = ''completed''%'
                                       and prosrc like '%Сначала верните из «Завершено» ДС к документу ID %'
                                       and prosrc not like '%Сначала верните на доработку зависимые документы%'),
         'выход из «Завершено» держат только завершённые ДС к документу (ДС в работе не мешает)'
  union all
  select 2, exists (select 1 from fn where prosrc like '%в ветке правится только последнее изменение%'),
         'у ДС на изменение ВОР выход из «Завершено» держит следующее изменение ветки'
  union all
  select 3, exists (select 1 from fn where prosrc like '%Чтобы изменить условия, сначала верните его из статуса «Завершено»%'
                                       and prosrc like '%уже изменён соглашением ID %'),
         'прежние правила на месте: заморозка условий завершённого документа, одно изменение на документ'
  union all
  select 4, exists (select 1 from fn where not prosecdef),
         'функция триггера — с правами вызывающего'
  union all
  select 5, exists (select 1 from trg where tgenabled = 'O'),
         'триггер trg_contracts_hierarchy_guard на contracts включён'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
