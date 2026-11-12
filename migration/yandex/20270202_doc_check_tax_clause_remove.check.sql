-- После 20270202_doc_check_tax_clause_remove: заявок со статусом tax_clause нет, в списке статусов его нет; каждая заявка,
-- удалённая миграцией как дубль, — в «Удалённых» со статусом «Завершено», и её оригинал на месте (не удалён).
-- Строки «OK …» / «FAIL …»; выполняется в транзакции миграции (migrate.sh), с отметкой служебной операции.
with
removed as (
  select r.* from public.doc_check_requests r
  where exists (select 1 from public.doc_check_request_audit_log l
                where l.request_id = r.id and l.event_type = 'soft_deleted'
                  and l.changed_by_name = 'Исправление данных 12.11.2026 (миграция 20270202)')
),
moved as (
  select r.* from public.doc_check_requests r
  where exists (select 1 from public.doc_check_request_audit_log l
                where l.request_id = r.id and l.event_type = 'status_changed'
                  and l.changed_by_name = 'Исправление данных 12.11.2026 (миграция 20270202)')
),
orphans as (
  select r.id from removed r
  where not exists (
    select 1 from public.doc_check_requests x
    where x.id <> r.id and x.deleted_at is null and x.doc_type = r.doc_type
      and x.object_id is not distinct from r.object_id
      and x.counterparty_id is not distinct from r.counterparty_id
      and regexp_replace(coalesce(x.doc_number, ''), '[^0-9A-Za-zА-Яа-яЁё/._-]', '', 'g')
          = regexp_replace(coalesce(r.doc_number, ''), '[^0-9A-Za-zА-Яа-яЁё/._-]', '', 'g')
      and regexp_replace(split_part(coalesce(x.notes, ''), 'Исполнители', 1), '[^0-9A-Za-zА-Яа-яЁё]', '', 'g')
          = regexp_replace(split_part(coalesce(r.notes, ''), 'Исполнители', 1), '[^0-9A-Za-zА-Яа-яЁё]', '', 'g'))
),
con as (
  select pg_get_constraintdef(oid) as def from pg_constraint
  where conrelid = 'public.doc_check_requests'::regclass and conname = 'doc_check_requests_status_check'
),
checks(n, ok, what) as (
  select 1, not exists (select 1 from public.doc_check_requests where status = 'tax_clause'),
         'заявок со статусом «Проверка документов (исключение налоговой оговорки)» нет'
  union all
  select 2, coalesce((select def not like '%tax_clause%' and def like '%awaiting_scan%' and def like '%done%' from con), false),
         'в списке статусов (doc_check_requests_status_check) tax_clause нет, семь статусов доски на месте'
  union all
  select 3, not exists (select 1 from removed where deleted_at is null or status <> 'done'),
         'дубли — в «Удалённых» со статусом «Завершено»: ' || (select count(*) from removed)
  union all
  select 4, not exists (select 1 from orphans),
         'у каждого удалённого дубля оригинал на месте (не удалён)'
  union all
  select 5, not exists (select 1 from moved where status <> 'done'),
         'заявки без оригинала — в «Завершено»: ' || (select count(*) from moved where deleted_at is null)
  union all
  select 6, coalesce((select tgenabled = 'O' from pg_trigger
                      where tgrelid = 'public.doc_check_requests'::regclass and tgname = 'trg_doc_check_requests_updated_at'), false),
         'триггер updated_at заявок снова включён'
  union all
  select 7, (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.doc_check_requests'::regclass),
         'doc_check_requests: RLS включён и действует на владельца'
)
select case when ok then 'OK' else 'FAIL' end || ' ' || what from checks order by n;
