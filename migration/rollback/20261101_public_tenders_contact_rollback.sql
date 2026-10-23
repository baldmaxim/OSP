-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261101_public_tenders_contact.sql: представление public_open_tenders снова
-- без ответственного — 11 полей, как после 20261016. Страница /public/tenders продолжает работать: без колонок
-- ответственного она читает список без них (в контактах остаётся общая почта).
-- Убрать колонки из представления CREATE OR REPLACE не может — оно пересоздаётся, выдача повторяется.
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP VIEW IF EXISTS public.public_open_tenders;
CREATE VIEW public.public_open_tenders
WITH (security_barrier = true, security_invoker = false) AS
 SELECT t.id,
    t.public_tender_number,
    t.work_description,
    t.start_date,
    t.end_date,
    t.tender_start_date,
    t.tender_end_date,
    t.tender_package_link,
    o.name AS object_name,
    o.address AS object_address,
    o.map_link AS object_map_link
   FROM public.tenders t
     JOIN public.objects o ON o.id = t.object_id
  WHERE t.status::text = 'Идет тендерная процедура'
    AND t.deleted_at IS NULL
    AND (t.tender_type IS NULL OR t.tender_type = 'main')
    AND o.status IN ('main_construction', 'warranty_service');

COMMENT ON VIEW public.public_open_tenders IS
  'Открытые тендеры для страницы без входа (/public/tenders): только публичные поля. Единственное, что читает гость (anon); из таблиц tenders и objects он не читает ничего. Новую колонку добавлять сюда — значит публиковать её в интернете';

REVOKE ALL ON TABLE public.public_open_tenders FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.public_open_tenders TO anon, authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
