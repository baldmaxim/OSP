-- Кабинет подрядчика: только актуальная версия каждой ведомости ВОР (просьба пользователя 11.11.2026, тендер № 847), только база Яндекса.
-- Нужны 20261029 (версии ВОР у снабжения), 20261204 (позиции с сервера), 20270113 (свой ВОР с расценками).
--
-- У тендера № 847 два файла ВОР: «ЗИЛ лот 33 ВОР ЭН.xlsx» (13.10) и «ЗИЛ лот 33 ВОР ЭН от 03.11.2026 версия 2.xlsx». Снабжение отметило
-- старый как прежнюю версию нового (tender_supply_sources.prior_document_ids, миграция 20261029: замена файла или ответ «да, это новая
-- версия»), и «Сравнение КП» показывает один ВОР — а кабинет подрядчика оба: таблица списков снабжения подрядчику закрыта.
--
-- Заменённая ведомость — файл из prior_document_ids списка тендера, если файл, который его заменил, лежит в тендере (отдел удалил новую
-- версию или перешёл на вкладку «ВОР» — прежний файл снова единственный и показывается) и сам заменённый не стоит текущим файлом другого
-- списка. По имени файла не судим: у тендера № 741 «ВОР 2026-09-25» и «ВОР 2026-09-25 (1)» — разные ведомости.
--
--  • bid_vor_superseded(p_tender) — заменённые файлы тендера и файл, который их заменил. Кабинету: не показывать старые, расценку подрядчика
--    к старой показать у новой с пометкой «загрузите заново». Сотруднику — всегда, подрядчику — при доступе к тендеру; только id файлов.
--  • bid_positions — без заменённых (учётка с регистрации получает позиции с сервера).
--  • bid_file_target (и bid_file_save через неё) — к заменённой ведомости расценку не приложить (P0002): открытая со вчера вкладка получит
--    понятный отказ, а не файл к старой версии.
-- Данные не меняются. Повтор безопасен.

-- ── 1. Заменённые ведомости тендера ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bid_vor_superseded(p_tender uuid)
RETURNS TABLE (file_id uuid, current_file_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT DISTINCT ON (p.id) p.id, s.s3_document_id
  FROM public.tender_supply_sources s
  CROSS JOIN LATERAL unnest(s.prior_document_ids) AS p(id)
  JOIN public.s3_documents cur ON cur.id = s.s3_document_id AND cur.owner_type = 'tender' AND cur.owner_id = p_tender
   AND cur.doc_category IN ('vor_statement', 'vor')
  WHERE s.tender_id = p_tender
    AND p.id <> s.s3_document_id
    AND NOT EXISTS (SELECT 1 FROM public.tender_supply_sources c WHERE c.tender_id = p_tender AND c.s3_document_id = p.id)
    AND (public.osp_is_employee() OR public.bid_access(p_tender) IS NOT NULL)
  ORDER BY p.id, s.updated_at DESC, s.id
$$;
COMMENT ON FUNCTION public.bid_vor_superseded(uuid) IS
  'Кабинет подрядчика: файлы ВОР тендера, заменённые новой версией (отметка снабжения prior_document_ids), и файл, который их заменил.';
-- osp:allow rpc bid_vor_superseded authenticated

-- ── 2. Позиции ВОР с сервера — без заменённых (тело 20261204 + условие) ──────────────────────────────
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

-- ── 3. Куда можно приложить расценку — не к заменённой ведомости (тело 20270113 + условие) ─────────────
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
  IF EXISTS (SELECT 1 FROM public.bid_vor_superseded(p_tender) s WHERE s.file_id = p_vor_file) THEN
    RAISE EXCEPTION 'Отдел заменил эту ведомость новой версией — обновите страницу и загрузите расценку к новой' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY SELECT v_cp, left(coalesce(NULLIF(btrim(regexp_replace(v_name, '\.(xlsx|xlsm|xls)$', '', 'i')), ''), v_name), 500);
END
$$;
COMMENT ON FUNCTION public.bid_file_target(uuid, uuid) IS
  'Кабинет подрядчика: можно ли приложить расценку к ведомости тендера (не заменённой новой версией); организация и имя ведомости. Только для службы.';
