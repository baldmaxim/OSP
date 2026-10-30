-- Проверка после 20261118_dc_request_submission_access.sql. Каждая строка — «OK …» или «FAIL …».
-- Только чтение. Выполняется на копии (rehearse.sh) и на проде в SQL Editor после миграции.
-- До миграции отвечает FAIL, а не падает: смотрит только каталог (функцию и колонки триггера).
with
fn as (
  select p.prosecdef, p.prosrc from pg_proc p join pg_namespace s on s.oid = p.pronamespace
  where s.nspname = 'public' and p.proname = 'dc_requests_submission_stamp'
),
trg_cols as (
  select a.attname from pg_trigger t
  join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = any (t.tgattr::int2[])
  where t.tgrelid = 'public.dc_requests'::regclass and t.tgname = 'dc_requests_submission_stamp' and not t.tgisinternal
),
checks(n, ok, what) as (
  select 1, exists (select 1 from pg_trigger t where t.tgrelid = 'public.dc_requests'::regclass
                      and t.tgname = 'dc_requests_submission_stamp' and not t.tgisinternal and t.tgenabled = 'O'),
         'триггер dc_requests_submission_stamp на месте'
  union all
  select 2, (select count(*) from trg_cols where attname in ('submission_check', 'submission_comment',
              'submission_resp_user_id', 'submission_resp_name')) = 4,
         'триггер следит за статусом ОКС, комментарием и ответственным'
  union all
  select 3, coalesce((select prosrc like '%udoroj%' and prosrc like '%42501%' from fn), false),
         'менять статус ОКС может только «Отдел по удорожанию»'
  union all
  select 4, coalesce((select prosrc like '%submission_resp_user_id := v_uid%' from fn), false),
         'ответственный — тот, кто поставил статус ОКС'
  union all
  select 5, coalesce((select not prosecdef from fn), false),
         'функция триггера — с правами вызывающего (не SECURITY DEFINER)'
  union all
  select 6, (select relrowsecurity from pg_class where oid = 'public.dc_requests'::regclass),
         'dc_requests: RLS на месте'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
