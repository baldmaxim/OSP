-- Версии файлов списка (решение пользователя 26.11.2026, окно «ВОРы и РД»): новую версию ведомости ВОР прикрепляют к прежнему
-- файлу, а не отдельным документом; файл можно сделать версией другого файла того же списка или снова самостоятельным.
-- Часть 1 — та же, что supabase/migrations/20270307_s3_document_versions.sql.
--
-- s3_documents.version_group_id — одна группа на все версии файла; NULL — файл без версий (все прежние строки). Номер версии не
-- хранится: порядок по времени загрузки внутри группы (created_at, затем id), последняя — текущая; удалили версию — следующие
-- сдвигаются, порядок прежний (src/utils/docVersions.js). Группа из одного файла — обычный файл (так помечен файл, который сделали
-- самостоятельным: связь снята явно). Версии — только у списков с ними (osp-api VERSIONED_CATEGORIES: ВОР тендера vor_statement,
-- ВОР заявки без тендера vor_request_vor); база проверяет одно — версии в одной группе принадлежат одному списку.
-- Правила строк s3_documents и список шлюза не меняются (колонка той же таблицы, чтение — «*»; запись — только osp-api);
-- s3_documents_user_guard (20270120) пропускает правку группы версий пользователем, как имени и описания.
--
-- Часть 2 — кабинет подрядчика видит только текущую версию ведомости. bid_vor_superseded (20270114) отдаёт ещё и прежние версии
-- группы (текущая — последняя загруженная книга Excel группы, как у снабжения: supplyAutoImport.vorFilesForImport); через неё —
-- bid_positions, bid_file_target, bid_vor_changes. Связь версий главнее отметки снабжения prior_document_ids: файл в группе
-- версий отметка делает прежним только для списка, чей текущий файл в той же группе, — файл, который сделали самостоятельным,
-- подрядчику снова виден. bid_vor_changes: прежняя версия ведомости ищется и среди версий её группы.
-- Данные не меняются: колонка у всех пустая. Повтор безопасен. Проверка — 20270307_s3_document_versions.check.sql;
-- откат — migration/rollback/20270307_s3_document_versions_rollback.sql.
-- ── 1. Группа версий у файла ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.s3_documents ADD COLUMN IF NOT EXISTS version_group_id uuid;
COMMENT ON COLUMN public.s3_documents.version_group_id IS
  'Группа версий файла (одна на все версии, порядок — по времени загрузки, последняя — текущая); NULL — файл без версий';
CREATE INDEX IF NOT EXISTS s3_documents_version_group_idx ON public.s3_documents (version_group_id)
  WHERE version_group_id IS NOT NULL;

-- Версии — только у файлов одного списка: того же владельца и категории. Пишут osp-api (s3-presign: confirm с version_of, version)
-- и прежний портал правкой строки; проверка — здесь, по всем строкам (служебная функция видит и чужие).
CREATE OR REPLACE FUNCTION public.s3_documents_version_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  IF NEW.version_group_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.s3_documents o
    WHERE o.version_group_id = NEW.version_group_id AND o.id <> NEW.id
      AND (o.owner_type IS DISTINCT FROM NEW.owner_type OR o.owner_id IS DISTINCT FROM NEW.owner_id
           OR o.doc_category IS DISTINCT FROM NEW.doc_category)
  ) THEN
    RAISE EXCEPTION 'Версии — только у файлов одного списка (тот же владелец и раздел)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION public.s3_documents_version_guard() IS
  'Триггер s3_documents: версии (version_group_id) — только у файлов одного владельца и категории.';
DROP TRIGGER IF EXISTS s3_documents_version_guard ON public.s3_documents;
CREATE TRIGGER s3_documents_version_guard
  BEFORE INSERT OR UPDATE OF version_group_id, owner_type, owner_id, doc_category ON public.s3_documents
  FOR EACH ROW
  WHEN (NEW.version_group_id IS NOT NULL)
  EXECUTE FUNCTION public.s3_documents_version_guard();

-- Правка строки файла пользователем (20270120): кроме имени и описания — ещё группа версий. Пишет её только osp-api (s3-presign:
-- version и confirm с version_of — право как у удаления, тот же владелец и категория); прямая правка s3_documents через шлюз закрыта.
-- Остальное тело — как в 20270120.
CREATE OR REPLACE FUNCTION public.s3_documents_user_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  a record;
  v_free constant text[] := ARRAY['file_name', 'notes', 'version_group_id', 'updated_at'];
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

-- ── 2. Кабинет подрядчика: прежние версии ведомости ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bid_vor_superseded(p_tender uuid)
RETURNS TABLE (file_id uuid, current_file_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  WITH vors AS MATERIALIZED (
    SELECT d.id, d.version_group_id, d.created_at, d.file_name ~* '\.(xlsx|xlsm|xls)$' AS workbook
    FROM public.s3_documents d
    WHERE d.owner_type = 'tender' AND d.owner_id = p_tender AND d.doc_category IN ('vor_statement', 'vor')
  ),
  -- Версии файла: прежние книги Excel группы → последняя загруженная книга группы.
  by_version AS (
    SELECT o.id AS file_id, n.id AS current_file_id
    FROM vors o
    JOIN LATERAL (SELECT x.id FROM vors x WHERE x.version_group_id = o.version_group_id AND x.workbook
                  ORDER BY x.created_at DESC, x.id DESC LIMIT 1) n ON true
    WHERE o.version_group_id IS NOT NULL AND o.workbook AND n.id <> o.id
  ),
  -- Отметка снабжения (20270114): прежний файл списка, если его заменивший лежит в тендере, а сам он не текущий файл другого
  -- списка; файл в группе версий — только для списка, чей текущий файл в той же группе.
  by_supply AS (
    SELECT p.id AS file_id, s.s3_document_id AS current_file_id, s.updated_at, s.id AS source_id
    FROM public.tender_supply_sources s
    CROSS JOIN LATERAL unnest(s.prior_document_ids) AS p(id)
    JOIN vors cur ON cur.id = s.s3_document_id
    LEFT JOIN vors pd ON pd.id = p.id
    WHERE s.tender_id = p_tender
      AND p.id <> s.s3_document_id
      AND NOT EXISTS (SELECT 1 FROM public.tender_supply_sources c WHERE c.tender_id = p_tender AND c.s3_document_id = p.id)
      AND (pd.version_group_id IS NULL OR pd.version_group_id = cur.version_group_id)
  )
  SELECT DISTINCT ON (x.file_id) x.file_id, x.current_file_id
  FROM (
    SELECT v.file_id, v.current_file_id, 0 AS rank, NULL::timestamptz AS updated_at, NULL::uuid AS source_id FROM by_version v
    UNION ALL
    SELECT s.file_id, s.current_file_id, 1, s.updated_at, s.source_id FROM by_supply s
  ) x
  WHERE public.osp_is_employee() OR public.bid_access(p_tender) IS NOT NULL
  ORDER BY x.file_id, x.rank, x.updated_at DESC NULLS LAST, x.source_id
$$;
COMMENT ON FUNCTION public.bid_vor_superseded(uuid) IS
  'Кабинет подрядчика: файлы ВОР тендера, заменённые новой версией (версии файла version_group_id или отметка снабжения prior_document_ids), и файл, который их заменил.';

-- Тело 20270301 + прежняя версия среди версий группы ведомости.
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
           d.version_group_id, s.estimate_name, s.prior_document_ids, s.separate_at, s.id IS NOT NULL AS tracked
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
      UNION
      SELECT g.id FROM public.s3_documents g
      WHERE c.version_group_id IS NOT NULL AND g.version_group_id = c.version_group_id
        AND g.owner_type = 'tender' AND g.owner_id = p_tender AND g.id <> c.id
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
