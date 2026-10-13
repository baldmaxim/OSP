-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261016_public_tenders_view.sql: возвращает гостю чтение таблиц
-- tenders и objects — то есть и саму дыру (все поля открытых тендеров и их объектов без входа).
-- Применять только если после миграции страница /public/tenders у обновлённого сайта не показывает
-- тендеры и это нельзя переждать, — и сразу сообщить. Представление public_open_tenders остаётся.
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP POLICY IF EXISTS "Anon public tender list" ON public.tenders;
CREATE POLICY "Anon public tender list" ON public.tenders
  FOR SELECT TO anon
  USING (
    status::text = 'Идет тендерная процедура'
    AND deleted_at IS NULL
    AND (tender_type IS NULL OR tender_type = 'main')
  );

DROP POLICY IF EXISTS "Anon public objects via open tenders" ON public.objects;
CREATE POLICY "Anon public objects via open tenders" ON public.objects
  FOR SELECT TO anon
  USING (
    EXISTS (
      SELECT 1 FROM public.tenders t
      WHERE t.object_id = objects.id
        AND t.status::text = 'Идет тендерная процедура'
        AND t.deleted_at IS NULL
        AND (t.tender_type IS NULL OR t.tender_type = 'main')
    )
  );

COMMIT;
