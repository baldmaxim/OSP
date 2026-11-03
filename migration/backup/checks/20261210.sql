-- Проверка после 20261210_tender_concept_agreement.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: смотрит только каталог.
with
fn as (
  select p.prosecdef, p.prosrc from pg_proc p join pg_namespace s on s.oid = p.pronamespace
  where s.nspname = 'public' and p.proname = 'tenders_concept_agreement_guard'
),
checks(n, ok, what) as (
  select 1, exists (select 1 from pg_trigger t where t.tgrelid = 'public.tenders'::regclass
                      and t.tgname = 'tenders_concept_agreement_guard' and not t.tgisinternal and t.tgenabled = 'O'),
         'триггер tenders_concept_agreement_guard на месте'
  union all
  select 2, coalesce((select prosrc like '%concept_agreement_signed%' and prosrc like '%winner_counterparty_id%' from fn), false),
         'проверяются подписанное соглашение и победитель'
  union all
  select 3, coalesce((select prosrc like '%OLD.status IS NOT DISTINCT FROM ''Завершен''%' from fn), false),
         'уже завершённые тендеры не проверяются'
  union all
  select 4, coalesce((select not prosecdef from fn), false),
         'функция триггера — с правами вызывающего (не SECURITY DEFINER)'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
