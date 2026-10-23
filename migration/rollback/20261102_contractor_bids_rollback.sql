-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261102_contractor_bids.sql (Supabase): кабинет подрядчика работает как до
-- миграции — без открытых тендеров, расценки на сайте и анкеты; файлы — только своих тендеров и договоров.
-- Данные НЕ удаляются: таблицы остаются (без прав у вошедших), функции — без права вызова; повторное применение
-- миграции продолжит с ними. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP POLICY IF EXISTS portal_contractor_select ON public.s3_documents;
CREATE POLICY portal_contractor_select ON public.s3_documents FOR SELECT TO authenticated
  USING (
    (owner_type = 'tender'
      AND doc_category IN ('tender_package', 'vor', 'rd', 'vor_statement')
      AND public.is_my_tender(owner_id))
    OR (owner_type = 'contract' AND public.is_my_contract(owner_id))
  );

DO $$
DECLARE
  t text;
  f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tender_bid_requests', 'tender_bid_rates', 'tender_bid_forms', 'bid_form_fields'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', t);
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.bid_contractor_tenders()', 'public.bid_request(uuid)', 'public.bid_decide(uuid,boolean)',
                           'public.bid_rates_save(uuid,jsonb)', 'public.bid_form_save(uuid,jsonb)', 'public.bid_admin_overview()'] LOOP
    IF to_regprocedure(f) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    END IF;
  END LOOP;
END
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
