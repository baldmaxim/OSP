-- Кабинет подрядчика (решения пользователя 05.11.2026), только база Яндекса. Нужны 20261204 и 20261225.
--  • contractor_org_card: кроме прежних полей — постоянный номер контрагента на сайте, ставка НДС и контактные лица компании. Статус,
--    примечания и служебные пометки по-прежнему не отдаются. Меняется набор колонок, поэтому функция пересоздаётся.
--  • bid_vor_file: сам файл ВОР для расценки. Вызывает только служба (маршрут /api/fn/bid-vor-file), в списке шлюза функции нет: браузер её
--    не видит, ключ файла наружу не выходит. Отдаёт только Excel-файл ВОР идущего тендера и только организации с доступом к тендеру
--    (участник или заявка не отклонена) — те же условия, что у bid_positions. Пакет и РД тендера учётке с регистрации по-прежнему не отдаются.
-- Данные портала не меняются. Повтор безопасен.

DROP FUNCTION IF EXISTS public.contractor_org_card();
CREATE FUNCTION public.contractor_org_card()
RETURNS TABLE (name text, inn text, kpp text, legal_address text, actual_address text, website text, work_type text,
               contact_name text, contact_phone text, contact_email text,
               counterparty_number integer, vat_rate numeric, vat_exempt boolean, contacts jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT c.name::text, c.inn::text, c.kpp::text, c.legal_address::text, c.actual_address::text, c.website::text, c.work_type::text,
         ur.full_name::text, ur.work_phone::text, ur.email::text,
         c.counterparty_number, c.vat_rate, c.vat_exempt,
         coalesce((
           SELECT jsonb_agg(jsonb_build_object('id', cc.id, 'full_name', cc.full_name, 'position', cc.position, 'phone', cc.phone, 'email', cc.email)
                            ORDER BY cc.created_at, cc.id)
           FROM public.counterparty_contacts cc WHERE cc.counterparty_id = c.id
         ), '[]'::jsonb)
  FROM public.user_roles ur
  JOIN public.counterparties c ON c.id = ur.counterparty_id AND c.deleted_at IS NULL
  WHERE ur.user_id = auth.uid() AND ur.is_approved AND NOT ur.is_blocked
$$;
COMMENT ON FUNCTION public.contractor_org_card() IS 'Кабинет подрядчика: сведения о своей организации, её контактные лица и контакт учётки, поля — перечнем.';

CREATE OR REPLACE FUNCTION public.bid_vor_file(p_file uuid)
RETURNS TABLE (s3_key text, file_name text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_tender uuid;
  v_access text;
BEGIN
  IF public.osp_counterparty_id() IS NULL THEN
    RAISE EXCEPTION 'Файл ВОР — только для подрядчика' USING ERRCODE = '42501';
  END IF;
  SELECT d.owner_id INTO v_tender
  FROM public.s3_documents d
  WHERE d.id = p_file AND d.owner_type = 'tender' AND d.doc_category IN ('vor_statement', 'vor')
    AND d.file_name ~* '\.(xlsx|xlsm|xls)$';
  IF v_tender IS NULL THEN RETURN; END IF;
  v_access := public.bid_access(v_tender);
  IF v_access IS NULL OR v_access = 'rejected' OR NOT public.bid_tender_open(v_tender) THEN RETURN; END IF;
  RETURN QUERY SELECT d.s3_key::text, d.file_name::text FROM public.s3_documents d WHERE d.id = p_file;
END $$;
COMMENT ON FUNCTION public.bid_vor_file(uuid) IS 'Кабинет подрядчика: ключ и имя файла ВОР идущего тендера для организации с доступом. Только для службы, в списке шлюза нет.';
