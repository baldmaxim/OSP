-- Просмотр кабинета от имени подрядчика — позиции ВОР с сервера (просьба пользователя 25.11.2026: «загрузка файлов, позиций тендера
-- медленная, нужно ускорить»). Только база Яндекса (прежний портал на Supabase только читается).
--  • bid_positions отдаёт разбор службы (osp_private.bid_vor_files) и администратору — тому, кто смотрит кабинет «как подрядчик»
--    (режим есть только у администратора и суперадмина, is_admin()). Раньше функция отказывала ему («только для подрядчика»), и
--    страница в просмотре скачивала и разбирала в браузере каждый файл ВОР по одному (у тендера № 704 — 21 файл). Состав ответа тот же,
--    что у подрядчика: актуальные ведомости тендера (без заменённых), без пути к файлу и без цен.
--  • Остальным сотрудникам — как раньше, отказ; подрядчику и учётке с регистрации — без изменений (тело 20270114).
-- Шлюз и так пускает к функции только администратора (db-sections.json, call: admin); списки шлюза не меняются. Данные не меняются.
-- Повтор безопасен.

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
    -- Администратор в просмотре «как подрядчик»: организации у него нет, проверять её доступ нечем — ведомости тендера целиком.
    IF NOT public.is_admin() THEN
      RAISE EXCEPTION 'Позиции ВОР — только для подрядчика' USING ERRCODE = '42501';
    END IF;
  ELSE
    v_access := public.bid_access(p_tender);
    IF v_access IS NULL THEN
      RAISE EXCEPTION 'Сначала подайте заявку на участие в этом тендере' USING ERRCODE = '42501';
    END IF;
    IF v_access = 'rejected' OR (public.osp_self_registered() AND NOT public.bid_tender_open(p_tender)) THEN
      RETURN;
    END IF;
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
COMMENT ON FUNCTION public.bid_positions(uuid) IS
  'Кабинет подрядчика: позиции ВОР тендера без файлов; ведомости, заменённые новой версией, не отдаются. Администратору — для просмотра «как подрядчик».';
