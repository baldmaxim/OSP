-- АВАРИЙНЫЙ ОТКАТ 20270304_bid_positions_preview (только база Яндекса): bid_positions снова только для подрядчика (тело 20270114).
-- Просмотр кабинета «как подрядчик» после отката сам вернётся к разбору файлов ВОР в браузере (страница так делает при отказе функции).
-- Данные не меняются. Строка миграции в osp_meta.schema_migrations остаётся (как у других откатов). Одной транзакцией, повтор безопасен.
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
    AND NOT EXISTS (SELECT 1 FROM public.bid_vor_superseded(p_tender) s WHERE s.file_id = d.id)
  ORDER BY d.created_at DESC, d.id;
END $$;
COMMENT ON FUNCTION public.bid_positions(uuid) IS 'Кабинет подрядчика: позиции ВОР тендера без файлов; ведомости, заменённые новой версией, не отдаются.';

COMMIT;
