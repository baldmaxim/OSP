-- Кабинет подрядчика: сведения о тендерах, договорах и организации — только функциями с перечнем полей.
-- Тело supabase/migrations/20261201_contractor_access.sql, права под одну учётку.
--  • Тендеры кабинета отдаёт bid_contractor_tenders (20261102). Договоры — contractor_contracts, название своей
--    организации — contractor_org_name, отметка участия («КП загружено», «Отказ») — contractor_set_participation.
--  • Прямого чтения tenders, objects, contracts, contract_counterparties, counterparties и строки участия у
--    подрядчика больше нет, прямой записи в строку участия тоже. Сотрудники работают как раньше.
--  • Смета, файлы, свои КП, согласование договора — без изменений.
--  • Своё КП подрядчик загружает и заменяет, пока идёт приём предложений (bid_tender_open), и только на позиции
--    этого тендера. После приёма КП меняет сотрудник.
-- Данные не меняются. Повтор безопасен.

-- ── 1. Функции кабинета ───────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.contractor_org_name() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT c.name::text FROM public.counterparties c WHERE c.id = public.osp_counterparty_id()
$$;
COMMENT ON FUNCTION public.contractor_org_name() IS 'Кабинет подрядчика: название своей организации.';

CREATE OR REPLACE FUNCTION public.contractor_contracts()
RETURNS TABLE (id uuid, display_id bigint, contract_number text, contract_date date, work_name text, status text,
               contract_amount numeric, currency text, object_name text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid := public.osp_counterparty_id();
BEGIN
  IF v_cp IS NULL THEN
    RAISE EXCEPTION 'Договоры кабинета — только для подрядчика' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT c.id, c.display_id, c.contract_number::text, c.contract_date, c.work_name, c.status::text,
         c.contract_amount, c.currency::text, o.name::text
  FROM public.contracts c
  LEFT JOIN public.objects o ON o.id = c.object_id
  WHERE c.deleted_at IS NULL
    AND (c.counterparty_id = v_cp OR EXISTS (
      SELECT 1 FROM public.contract_counterparties cc WHERE cc.contract_id = c.id AND cc.counterparty_id = v_cp))
  ORDER BY c.contract_date DESC NULLS LAST, c.id;
END $$;
COMMENT ON FUNCTION public.contractor_contracts() IS 'Кабинет подрядчика: договоры и ДС своей организации, поля — перечнем.';

CREATE OR REPLACE FUNCTION public.contractor_set_participation(p_tender uuid, p_status text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid := public.osp_counterparty_id();
  v_row uuid;
  v_status text;
BEGIN
  IF v_cp IS NULL THEN
    RAISE EXCEPTION 'Отметку участия ставит подрядчик' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('proposal_provided', 'declined') THEN
    RAISE EXCEPTION 'Недопустимая отметка участия' USING ERRCODE = '22023';
  END IF;
  SELECT tc.id, tc.status::text INTO v_row, v_status
  FROM public.tender_counterparties tc
  WHERE tc.tender_id = p_tender AND tc.counterparty_id = v_cp
  FOR UPDATE;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'Организация не участвует в этом тендере' USING ERRCODE = '42501';
  END IF;
  IF NOT public.bid_tender_open(p_tender) THEN
    RAISE EXCEPTION 'Приём предложений по этому тендеру закрыт' USING ERRCODE = 'P0001';
  END IF;
  IF v_status = 'accepted_for_work' THEN
    RAISE EXCEPTION 'Участие уже подтверждено — обратитесь к ответственному по тендеру' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.tender_counterparties SET status = p_status::public.tender_counterparty_status WHERE id = v_row;
END $$;
COMMENT ON FUNCTION public.contractor_set_participation(uuid, text) IS 'Кабинет подрядчика: «КП загружено» или «Отказ» по своему участию, пока идёт приём.';

-- Условие правила: приём предложений идёт, позиция — этого тендера.
CREATE OR REPLACE FUNCTION public.contractor_kp_item_open(p_tender uuid, p_item uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT public.bid_tender_open(p_tender) AND EXISTS (
    SELECT 1 FROM public.tender_estimate_items i WHERE i.id = p_item AND i.tender_id = p_tender)
$$;

-- ── 2. Прямое чтение и запись подрядчика уходят вместе с записями об их ролях ──────────────────────────
DROP POLICY IF EXISTS portal_contractor_select ON public.tenders;
DROP POLICY IF EXISTS portal_contractor_select ON public.objects;
DROP POLICY IF EXISTS portal_contractor_select ON public.contracts;
DROP POLICY IF EXISTS portal_contractor_select ON public.contract_counterparties;
DROP POLICY IF EXISTS portal_contractor_select ON public.counterparties;
DROP POLICY IF EXISTS portal_contractor_select ON public.tender_counterparties;
DROP POLICY IF EXISTS portal_contractor_update ON public.tender_counterparties;
DELETE FROM osp_meta.policy_roles
 WHERE schema_name = 'public'
   AND policy_name IN ('portal_contractor_select', 'portal_contractor_update')
   AND table_name IN ('tenders', 'objects', 'contracts', 'contract_counterparties', 'counterparties', 'tender_counterparties');

-- ── 3. Свои КП — пока идёт приём ───────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS portal_contractor_insert ON public.tender_counterparty_proposals;
CREATE POLICY portal_contractor_insert ON public.tender_counterparty_proposals FOR INSERT TO PUBLIC
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated'))
                     AND counterparty_id = (SELECT public.current_counterparty_id())
                     AND public.is_my_tender(tender_id)
                     AND public.contractor_kp_item_open(tender_id, estimate_item_id)) END);
DROP POLICY IF EXISTS portal_contractor_delete ON public.tender_counterparty_proposals;
CREATE POLICY portal_contractor_delete ON public.tender_counterparty_proposals FOR DELETE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated'))
                AND counterparty_id = (SELECT public.current_counterparty_id())
                AND public.bid_tender_open(tender_id)) END);

-- ── 4. Список шлюза ────────────────────────────────────────────────────────────────────────────────────
-- osp:allow rpc contractor_org_name authenticated
-- osp:allow rpc contractor_contracts authenticated
-- osp:allow rpc contractor_set_participation authenticated
-- osp:allow rpc contractor_kp_item_open authenticated
