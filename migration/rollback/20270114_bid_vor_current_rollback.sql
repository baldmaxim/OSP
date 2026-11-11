-- АВАРИЙНЫЙ ОТКАТ 20270114_bid_vor_current (только база Яндекса): кабинет подрядчика снова показывает все файлы ВОР тендера, и прежние
-- версии тоже (как до миграции): страница без функции bid_vor_superseded ничего не отбрасывает. Позиции с сервера и загрузка расценки —
-- тела 20261204 и 20270113. Данные не меняются. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.bid_positions(p_tender uuid)
RETURNS TABLE (file_id uuid, title text, status text, error text, positions jsonb, structure jsonb, conditions jsonb)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_access text;
BEGIN
  IF public.osp_counterparty_id() IS NULL THEN
    RAISE EXCEPTION 'Позиции ВОР — только для подрядчика' USING ERRCODE = '42501';
  END IF;
  v_access := public.bid_access(p_tender);
  IF v_access IS NULL THEN
    RAISE EXCEPTION 'Сначала подайте заявку на участие в этом тендере' USING ERRCODE = '42501';
  END IF;
  IF v_access = 'rejected' OR (public.osp_self_registered() AND NOT public.bid_tender_open(p_tender)) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT d.id, regexp_replace(d.file_name, '\.(xlsx|xlsm|xls)$', '', 'i'), coalesce(f.status, 'pending'), f.error,
         coalesce(f.positions, '[]'::jsonb), coalesce(f.structure, '[]'::jsonb), coalesce(f.conditions, '[]'::jsonb)
  FROM public.s3_documents d
  LEFT JOIN osp_private.bid_vor_files f ON f.s3_document_id = d.id
  WHERE d.owner_type = 'tender' AND d.owner_id = p_tender AND d.doc_category IN ('vor_statement', 'vor')
    AND d.file_name ~* '\.(xlsx|xlsm|xls)$'
  ORDER BY d.created_at DESC, d.id;
END $$;
COMMENT ON FUNCTION public.bid_positions(uuid) IS 'Кабинет подрядчика: позиции ВОР тендера без файлов.';

CREATE OR REPLACE FUNCTION public.bid_file_target(p_tender uuid, p_vor_file uuid)
RETURNS TABLE (counterparty_id uuid, vor_name text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid := public.osp_counterparty_id();
  v_name text;
BEGIN
  IF v_cp IS NULL THEN
    RAISE EXCEPTION 'Файл с расценкой загружает подрядчик' USING ERRCODE = '42501';
  END IF;
  IF NOT public.bid_can_edit(p_tender) THEN
    RAISE EXCEPTION 'Приём предложений по этому тендеру закрыт или заявка не подана' USING ERRCODE = '42501';
  END IF;
  SELECT d.file_name INTO v_name
  FROM public.s3_documents d
  WHERE d.id = p_vor_file AND d.owner_type = 'tender' AND d.owner_id = p_tender
    AND d.doc_category IN ('vor_statement', 'vor') AND d.file_name ~* '\.(xlsx|xlsm|xls)$';
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Такой ведомости в тендере нет' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY SELECT v_cp, left(coalesce(NULLIF(btrim(regexp_replace(v_name, '\.(xlsx|xlsm|xls)$', '', 'i')), ''), v_name), 500);
END
$$;
COMMENT ON FUNCTION public.bid_file_target(uuid, uuid) IS
  'Кабинет подрядчика: можно ли приложить расценку к ведомости тендера; организация и имя ведомости. Только для службы, в списке шлюза нет.';

DROP FUNCTION IF EXISTS public.bid_vor_superseded(uuid);

COMMIT;
