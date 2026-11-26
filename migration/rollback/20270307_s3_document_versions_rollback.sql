-- АВАРИЙНЫЙ ОТКАТ 20270307_s3_document_versions: у файлов снова нет версий — каждая версия показывается отдельным файлом (окно
-- «ВОРы и РД» работает как до миграции: колонки нет — кнопок версий и перетаскивания нет), кабинет подрядчика снова скрывает только
-- файлы с отметкой снабжения (тела bid_vor_superseded из 20270114 и bid_vor_changes из 20270301). Сами файлы и строки не удаляются.
-- ВНИМАНИЕ: теряется связь версий. Перед откатом снимите её выгрузкой:
--   select id, owner_type, owner_id, doc_category, file_name, created_at, version_group_id from public.s3_documents
--   where version_group_id is not null order by version_group_id, created_at;
-- Одной транзакцией, повтор безопасен. Часть 2 (функции кабинета) — только для базы Яндекса: в базе Supabase их нет, выполняйте
-- там только часть 1.
BEGIN;
SET LOCAL lock_timeout = '10s';

-- ── 2. Функции кабинета — как до миграции (только база Яндекса) ───────────────────────────────────────
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

CREATE OR REPLACE FUNCTION public.bid_vor_changes(p_tender uuid)
RETURNS TABLE (file_id uuid, created_at timestamptz, tracked boolean, separate boolean, valuable boolean,
               prior_id uuid, prior_title text, prior_at timestamptz, positions jsonb)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_access text;
BEGIN
  IF public.osp_counterparty_id() IS NULL THEN
    IF NOT public.osp_is_employee() THEN
      RAISE EXCEPTION 'Изменения ВОР — только для подрядчика' USING ERRCODE = '42501';
    END IF;
  ELSE
    v_access := public.bid_access(p_tender);
    IF v_access IS NULL OR v_access = 'rejected' OR (public.osp_self_registered() AND NOT public.bid_tender_open(p_tender)) THEN
      RETURN;
    END IF;
  END IF;
  RETURN QUERY
  WITH sup AS MATERIALIZED (SELECT s.file_id FROM public.bid_vor_superseded(p_tender) s),
  cur AS (
    SELECT d.id, d.created_at, lower(btrim(regexp_replace(d.file_name, '\.(xlsx|xlsm|xls)$', '', 'i'))) AS title_key,
           s.estimate_name, s.prior_document_ids, s.separate_at, s.id IS NOT NULL AS tracked
    FROM public.s3_documents d
    LEFT JOIN LATERAL (SELECT x.* FROM public.tender_supply_sources x
                       WHERE x.tender_id = p_tender AND x.s3_document_id = d.id ORDER BY x.updated_at DESC LIMIT 1) s ON true
    WHERE d.owner_type = 'tender' AND d.owner_id = p_tender AND d.doc_category IN ('vor_statement', 'vor')
      AND d.file_name ~* '\.(xlsx|xlsm|xls)$'
      AND NOT EXISTS (SELECT 1 FROM sup WHERE sup.file_id = d.id)
  )
  SELECT c.id, c.created_at, c.tracked, c.separate_at IS NOT NULL,
         c.estimate_name IS NOT NULL AND EXISTS (SELECT 1 FROM public.tender_vor_supply_rates r
                                                 WHERE r.tender_id = p_tender AND r.estimate_name = c.estimate_name),
         pr.id, pr.title, pr.at, pr.positions
  FROM cur c
  LEFT JOIN LATERAL (
    WITH cand AS (
      SELECT x.id FROM unnest(coalesce(c.prior_document_ids, '{}'::uuid[])) AS x(id)
      UNION
      SELECT r.old_document_id FROM public.tender_supply_revisions r
      WHERE r.tender_id = p_tender AND c.estimate_name IS NOT NULL AND r.estimate_name = c.estimate_name AND r.old_document_id IS NOT NULL
      UNION
      SELECT a.s3_document_id FROM osp_private.bid_vor_archive a
      WHERE a.tender_id = p_tender AND lower(btrim(a.title)) = c.title_key
    ),
    found AS (
      SELECT d.id, regexp_replace(d.file_name, '\.(xlsx|xlsm|xls)$', '', 'i') AS title, d.created_at AS at,
             osp_private.bid_slim_positions(f.positions) AS positions
      FROM cand JOIN public.s3_documents d ON d.id = cand.id AND d.owner_type = 'tender' AND d.owner_id = p_tender
      JOIN osp_private.bid_vor_files f ON f.s3_document_id = d.id AND f.status = 'ok'
      WHERE EXISTS (SELECT 1 FROM sup WHERE sup.file_id = d.id)
      UNION ALL
      SELECT a.s3_document_id, a.title, coalesce(a.doc_created_at, a.archived_at), a.positions
      FROM cand JOIN osp_private.bid_vor_archive a ON a.s3_document_id = cand.id AND a.tender_id = p_tender
    )
    SELECT found.* FROM found
    WHERE found.id <> c.id AND found.at < c.created_at
    ORDER BY found.at DESC, found.id
    LIMIT 1
  ) pr ON true
  ORDER BY c.created_at DESC, c.id;
END
$$;
COMMENT ON FUNCTION public.bid_vor_changes(uuid) IS
  'Кабинет подрядчика: актуальные ведомости тендера — что о них знает снабжение и позиции прежней версии (без цен).';

-- Правка строки файла пользователем — как в 20270120 (только имя и описание).
CREATE OR REPLACE FUNCTION public.s3_documents_user_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  a record;
  v_free constant text[] := ARRAY['file_name', 'notes', 'updated_at'];
BEGIN
  IF auth.uid() IS NULL OR (SELECT osp_private.bypass()) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO a FROM public.psdc_actor();
    NEW.uploaded_by := auth.uid();
    NEW.uploaded_by_name := coalesce(nullif(btrim(a.full_name), ''), nullif(auth.email(), ''));
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - v_free) IS DISTINCT FROM (to_jsonb(OLD) - v_free) THEN
    RAISE EXCEPTION 'У файла можно изменить только имя и описание' USING ERRCODE = '42501', HINT = 's3_document_immutable';
  END IF;
  RETURN NEW;
END
$$;

-- ── 1. Группа версий ─────────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS s3_documents_version_guard ON public.s3_documents;
DROP FUNCTION IF EXISTS public.s3_documents_version_guard();
DROP INDEX IF EXISTS public.s3_documents_version_group_idx;
ALTER TABLE public.s3_documents DROP COLUMN IF EXISTS version_group_id;

COMMIT;
