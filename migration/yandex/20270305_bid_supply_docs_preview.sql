-- Кабинет подрядчика, просмотр от имени подрядчика: счета снабжения у цен, «взятых» в черновике просмотра (просьба пользователя
-- 25.11.2026: «в личном кабинете подрядчика не вижу столбец со счётом и возможностью его посмотреть по позиции после того как
-- подрядчик применил нашу цену (на те позиции где у нас есть счёт)»). Только база Яндекса.
--
-- Что было: в просмотре «взять» ложится в черновик страницы (в базу не пишется), а bid_supply_docs отдаёт счета только к цене,
-- взятой в базе, — у цены, взятой в просмотре, счёта не было (на 25.11 в рабочей базе нет ни одной цены подрядчика: кабинет видели
-- только в просмотре).
-- Что стало: администратору (режим просмотра есть только у администратора и суперадмина, is_admin(), как bid_positions в 20270304;
-- в шлюзе сотруднику функция и так только «call: admin») — счета всех позиций, которые отдел открыл организации; страница
-- показывает счёт только у взятой (в черновике или в базе) и не изменённой цены. Подрядчику и прочим сотрудникам — как было: только
-- к цене, взятой в базе (osp_private.bid_supply_doc_rows не меняется — по ней же решает скачивание подрядчиком bid_supply_doc_file).
--
-- Данные портала не меняются. Повтор безопасен. Сигнатура и ответ bid_supply_docs прежние — списки шлюза не меняются.
-- Нужны 20270302 (bid_supply_docs, bid_supply_docs_cp), 20270303 (bid_supply_open_rows).

-- ── 1. Документы всех открытых организации позиций ──────────────────────────────────────────────────
-- Как osp_private.bid_supply_doc_rows (20270303), но без условия «цена взята у снабжения»: позиции — только открытые отделом
-- (разрешение и отметка позиции), документы — тех строк расценки снабжения, что дали цену (ВОР со списком позиций, цена > 0);
-- у цены, скопированной из другого тендера, — документ исходной позиции; только файлы. Служебная: вызывает только bid_supply_docs.
CREATE OR REPLACE FUNCTION osp_private.bid_supply_open_doc_rows(p_tender uuid, p_cp uuid)
RETURNS TABLE (item_key text, unit_key text, document_id uuid)
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  WITH rates AS (
    SELECT o.item_key, o.unit_key, r.estimate_name, r.material_key, r.source_rate_id
    FROM osp_private.bid_supply_open_rows(p_tender, p_cp) o
    JOIN public.tender_vor_supply_rates r
      ON r.tender_id = p_tender AND r.material_key = o.item_key AND public.kp_norm_unit(coalesce(r.unit, '')) = o.unit_key
    WHERE r.supply_price > 0
      AND (NOT EXISTS (SELECT 1 FROM public.tender_supply_sources s WHERE s.tender_id = p_tender)
           OR r.estimate_name IN (SELECT s.estimate_name FROM public.tender_supply_sources s WHERE s.tender_id = p_tender))
  )
  SELECT DISTINCT r.item_key, r.unit_key, coalesce(own.s3_document_id, src.s3_document_id)
  FROM rates r
  LEFT JOIN public.tender_supply_links own
    ON own.tender_id = p_tender AND own.estimate_name = r.estimate_name AND own.material_key = r.material_key
  LEFT JOIN public.tender_vor_supply_rates s ON s.id = r.source_rate_id AND own.id IS NULL
  LEFT JOIN public.tender_supply_links src
    ON src.tender_id = s.tender_id AND src.estimate_name = s.estimate_name AND src.material_key = s.material_key
  WHERE coalesce(own.s3_document_id, src.s3_document_id) IS NOT NULL
$$;

-- ── 2. Счета снабжения: администратору в просмотре — по открытым позициям ────────────────────────────
-- Подрядчик: как в 20270302 (свои, только к цене, взятой в базе). Сотрудник: организация p_counterparty с разрешением отдела
-- (bid_supply_docs_cp); администратор — по всем открытым ей позициям, остальные сотрудники — как раньше.
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
  IF public.osp_counterparty_id() IS NULL AND public.is_admin() THEN
    RETURN QUERY
    SELECT x.item_key, x.unit_key, d.id, d.file_name::text, d.created_at
    FROM osp_private.bid_supply_open_doc_rows(p_tender, v_cp) x
    JOIN public.s3_documents d ON d.id = x.document_id AND d.owner_type = 'tender' AND d.doc_category = 'supply_doc'
    ORDER BY x.item_key, x.unit_key, d.created_at DESC, d.id;
    RETURN;
  END IF;
  RETURN QUERY
  SELECT x.item_key, x.unit_key, d.id, d.file_name::text, d.created_at
  FROM osp_private.bid_supply_doc_rows(p_tender, v_cp) x
  JOIN public.s3_documents d ON d.id = x.document_id AND d.owner_type = 'tender' AND d.doc_category = 'supply_doc'
  ORDER BY x.item_key, x.unit_key, d.created_at DESC, d.id;
END
$$;
COMMENT ON FUNCTION public.bid_supply_docs(uuid, uuid) IS
  'Кабинет подрядчика: файлы счетов / КП снабжения к позициям, цену которых организация взяла у снабжения (только с разрешения отдела); администратору в просмотре от имени подрядчика — ко всем открытым позициям.';
