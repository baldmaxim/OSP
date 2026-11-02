-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261201_contractor_access.sql (Supabase): правила подрядчика — как до
-- миграции (тексты — 20260913_contractor_portal_rls.sql, 20260914_contractor_cabinet.sql). Функции кабинета
-- остаются без прав у вошедших: новая сборка сайта при отказе функции читает таблицы напрямую.
-- Данные не меняются. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP POLICY IF EXISTS portal_contractor_select ON public.tenders;
CREATE POLICY portal_contractor_select ON public.tenders FOR SELECT TO authenticated
  USING (public.is_my_tender(id));

DROP POLICY IF EXISTS portal_contractor_select ON public.objects;
CREATE POLICY portal_contractor_select ON public.objects FOR SELECT TO authenticated
  USING (public.current_counterparty_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.tenders t JOIN public.tender_counterparties tc ON tc.tender_id = t.id
    WHERE t.object_id = objects.id AND tc.counterparty_id = public.current_counterparty_id()));

DROP POLICY IF EXISTS portal_contractor_select ON public.contracts;
CREATE POLICY portal_contractor_select ON public.contracts FOR SELECT TO authenticated
  USING (deleted_at IS NULL AND public.is_my_contract(id));

DROP POLICY IF EXISTS portal_contractor_select ON public.contract_counterparties;
CREATE POLICY portal_contractor_select ON public.contract_counterparties FOR SELECT TO authenticated
  USING (counterparty_id = public.current_counterparty_id());

DROP POLICY IF EXISTS portal_contractor_select ON public.counterparties;
CREATE POLICY portal_contractor_select ON public.counterparties FOR SELECT TO authenticated
  USING (id = public.current_counterparty_id());

DROP POLICY IF EXISTS portal_contractor_select ON public.tender_counterparties;
CREATE POLICY portal_contractor_select ON public.tender_counterparties FOR SELECT TO authenticated
  USING (counterparty_id = public.current_counterparty_id());

DROP POLICY IF EXISTS portal_contractor_update ON public.tender_counterparties;
CREATE POLICY portal_contractor_update ON public.tender_counterparties FOR UPDATE TO authenticated
  USING (counterparty_id = public.current_counterparty_id())
  WITH CHECK (counterparty_id = public.current_counterparty_id());

DROP POLICY IF EXISTS portal_contractor_insert ON public.tender_counterparty_proposals;
CREATE POLICY portal_contractor_insert ON public.tender_counterparty_proposals FOR INSERT TO authenticated
  WITH CHECK (counterparty_id = public.current_counterparty_id() AND public.is_my_tender(tender_id));

DROP POLICY IF EXISTS portal_contractor_delete ON public.tender_counterparty_proposals;
CREATE POLICY portal_contractor_delete ON public.tender_counterparty_proposals FOR DELETE TO authenticated
  USING (counterparty_id = public.current_counterparty_id());

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.contractor_org_name()', 'public.contractor_contracts()',
                           'public.contractor_set_participation(uuid,text)'] LOOP
    IF to_regprocedure(f) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    END IF;
  END LOOP;
END
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
