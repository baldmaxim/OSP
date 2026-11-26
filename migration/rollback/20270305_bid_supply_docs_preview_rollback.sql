-- АВАРИЙНЫЙ ОТКАТ 20270305_bid_supply_docs_preview (только база Яндекса): bid_supply_docs — как в 20270302 (счета только к цене,
-- взятой в базе, и сотруднику тоже); в просмотре от имени подрядчика у цены, взятой в черновике, счёта снова нет — страница так и
-- работает. Данных миграция не меняла. Строка миграции в osp_meta.schema_migrations остаётся (как у других откатов). Одной
-- транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.bid_supply_docs(p_tender uuid, p_counterparty uuid DEFAULT NULL)
RETURNS TABLE (item_key text, unit_key text, document_id uuid, file_name text, uploaded_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid := osp_private.bid_supply_docs_cp(p_tender, p_counterparty);
BEGIN
  IF v_cp IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT x.item_key, x.unit_key, d.id, d.file_name::text, d.created_at
  FROM osp_private.bid_supply_doc_rows(p_tender, v_cp) x
  JOIN public.s3_documents d ON d.id = x.document_id AND d.owner_type = 'tender' AND d.doc_category = 'supply_doc'
  ORDER BY x.item_key, x.unit_key, d.created_at DESC, d.id;
END
$$;
COMMENT ON FUNCTION public.bid_supply_docs(uuid, uuid) IS
  'Кабинет подрядчика: файлы счетов / КП снабжения к позициям, цену которых организация взяла у снабжения (только с разрешения отдела).';

DROP FUNCTION IF EXISTS osp_private.bid_supply_open_doc_rows(uuid, uuid);

COMMIT;
