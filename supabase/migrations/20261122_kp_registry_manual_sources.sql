-- Реестр расценок → «Расценки от подрядчиков (КП)»: расценки, добавленные вручную, документ, из которого взята
-- расценка, и поиск похожих расценок для проверки файла (решения пользователя 30.10.2026).
--
--  • kp_manual_rates — расценка подрядчика, добавленная в реестр вручную (кнопка «Добавить расценку») или строками
--    файла (окно «Проверить по файлу» → «Добавить в реестр»): вид (материал / работа), наименование, ед. изм., цена
--    за единицу с НДС, подрядчик, по желанию — объект и тендер, день расценки, документ (ссылка http(s) / сетевой путь
--    или файл s3_documents: owner_type 'general', owner_id — id строки, doc_category 'kp_manual_rate'), примечание.
--    Кто и когда добавил и изменил — триггером. Читает читатель реестра (сотрудник), добавляет, меняет и удаляет право
--    правки «Реестра расценок» (osp_can('rates_registry', 'edit') = canEdit('rates_registry') на странице).
--  • Реестр КП показывает их сразу — без пересчёта: представление kp_rates_registry = материализованное (КП из файлов
--    и цены с сайта) + строки kp_manual_rates как есть. Ручные строки не схлопываются с КП (их вносит человек).
--  • Документ-источник у строк КП: ВОР (estimate_name позиции) и файл КП, сохранённый вместе с ценами — окно загрузки
--    КП сохраняет файл сразу после цен (на копии прода 15.10: у 404 из 426 загрузок — в ту же минуту), поэтому файл —
--    КП того же подрядчика и тендера, сохранённый с минуты до загрузки цен по 10 минут после, ближайший. Данные КП не
--    меняются — файл подбирается при пересчёте реестра. Цены с сайта — источник «кабинет подрядчика».
--  • Новые колонки представления — в конце (прежние запросы, API rates-api и выгрузки не меняются): source_kind
--    ('kp' | 'site' | 'manual'), estimate_name, source_doc_id, source_doc_name, source_url, manual_id, note.
--  • kp_rates_lookup(names, kind) — похожие расценки реестра для строк файла (окно «Проверить по файлу»): по каждому
--    наименованию до 60 строк по сочетаниям букв (pg_trgm, индекс по наименованию); окончательную похожесть считает
--    страница (тот же расчёт, что «Цены из счёта / КП» снабжения). Права вызывающего — представление реестра.
--
-- Материализованное представление строится рядом и подменяется (как 20261103); на время выполнения (секунды) чтение
-- реестра ждёт — применять в нерабочее время. Нужна 20261103. Данные портала не меняются. Повтор безопасен.
-- База нового портала — migration/yandex/20261122_kp_registry_manual_sources.sql. Проверка —
-- migration/backup/checks/20261122.sql, откат — migration/rollback/20261122_kp_registry_manual_sources_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';
-- pg_trgm на Supabase — в схеме extensions (оператор-класс индекса, similarity).
SET LOCAL search_path = public, extensions;

-- ── 1. Расценки, добавленные вручную ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kp_manual_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type text NOT NULL CHECK (item_type IN ('material', 'work')),
  item_name text NOT NULL CHECK (char_length(btrim(item_name)) BETWEEN 1 AND 1000),
  unit character varying(50),
  price numeric(15,2) NOT NULL CHECK (price > 0 AND price < 1e12),
  counterparty_id uuid NOT NULL REFERENCES public.counterparties(id) ON DELETE CASCADE,
  object_id uuid REFERENCES public.objects(id) ON DELETE SET NULL,
  tender_id uuid REFERENCES public.tenders(id) ON DELETE SET NULL,
  rate_date date NOT NULL DEFAULT ((now() AT TIME ZONE 'Europe/Moscow')::date),
  doc_url text CHECK (doc_url IS NULL OR (length(doc_url) <= 2000 AND doc_url ~* '^(https?://\S|\\\\\S)')),
  s3_document_id uuid REFERENCES public.s3_documents(id) ON DELETE SET NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 2000),
  created_by uuid,
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kp_manual_rates_one_doc CHECK (doc_url IS NULL OR s3_document_id IS NULL)
);
COMMENT ON TABLE public.kp_manual_rates IS
  'Расценка подрядчика, добавленная в реестр расценок вручную (вкладка «Расценки от подрядчиков (КП)»); цена за единицу с НДС';
COMMENT ON COLUMN public.kp_manual_rates.doc_url IS 'Документ, откуда взята расценка: адрес http(s) или сетевой путь \\сервер\папка (или файл — s3_document_id)';
COMMENT ON COLUMN public.kp_manual_rates.s3_document_id IS 'Файл документа: s3_documents owner_type general, owner_id — эта строка, doc_category kp_manual_rate';
COMMENT ON COLUMN public.kp_manual_rates.created_by_name IS 'Кто добавил (ФИО на момент добавления, ставит триггер)';

CREATE INDEX IF NOT EXISTS kp_manual_rates_counterparty_idx ON public.kp_manual_rates (counterparty_id);
CREATE INDEX IF NOT EXISTS kp_manual_rates_tender_idx ON public.kp_manual_rates (tender_id) WHERE tender_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS kp_manual_rates_object_idx ON public.kp_manual_rates (object_id) WHERE object_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS kp_manual_rates_doc_idx ON public.kp_manual_rates (s3_document_id) WHERE s3_document_id IS NOT NULL;

-- Кто и когда добавил и изменил — вошедший и текущее время, а не значения со страницы; лишние пробелы — прочь.
CREATE OR REPLACE FUNCTION public.kp_manual_rates_stamp() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  NEW.item_name := btrim(regexp_replace(NEW.item_name, '\s+', ' ', 'g'));
  NEW.unit := nullif(btrim(NEW.unit), '');
  NEW.doc_url := nullif(btrim(NEW.doc_url), '');
  NEW.note := nullif(btrim(NEW.note), '');
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := v_uid;
    NEW.created_by_name := (SELECT nullif(btrim(ur.full_name), '') FROM public.user_roles ur WHERE ur.user_id = v_uid LIMIT 1);
    NEW.created_at := now();
  ELSE
    NEW.created_by := OLD.created_by;
    NEW.created_by_name := OLD.created_by_name;
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_by := v_uid;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS kp_manual_rates_stamp ON public.kp_manual_rates;
CREATE TRIGGER kp_manual_rates_stamp
  BEFORE INSERT OR UPDATE ON public.kp_manual_rates
  FOR EACH ROW EXECUTE FUNCTION public.kp_manual_rates_stamp();

ALTER TABLE public.kp_manual_rates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kp_manual_rates_read ON public.kp_manual_rates;
CREATE POLICY kp_manual_rates_read ON public.kp_manual_rates FOR SELECT TO authenticated
  USING ((SELECT public.osp_registry_reader()));
DROP POLICY IF EXISTS kp_manual_rates_insert ON public.kp_manual_rates;
CREATE POLICY kp_manual_rates_insert ON public.kp_manual_rates FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.osp_can('rates_registry', 'edit')));
DROP POLICY IF EXISTS kp_manual_rates_update ON public.kp_manual_rates;
CREATE POLICY kp_manual_rates_update ON public.kp_manual_rates FOR UPDATE TO authenticated
  USING ((SELECT public.osp_can('rates_registry', 'edit'))) WITH CHECK ((SELECT public.osp_can('rates_registry', 'edit')));
DROP POLICY IF EXISTS kp_manual_rates_delete ON public.kp_manual_rates;
CREATE POLICY kp_manual_rates_delete ON public.kp_manual_rates FOR DELETE TO authenticated
  USING ((SELECT public.osp_can('rates_registry', 'edit')));

-- Новые таблицы и функции Supabase по умолчанию выдаёт анониму — снимаем всё явно.
REVOKE ALL ON TABLE public.kp_manual_rates FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.kp_manual_rates TO authenticated;
GRANT ALL ON TABLE public.kp_manual_rates TO service_role;
REVOKE ALL ON FUNCTION public.kp_manual_rates_stamp() FROM PUBLIC, anon;

-- ── 2. Реестр КП: документ-источник ──────────────────────────────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS public.kp_rates_registry_mv_next;
CREATE MATERIALIZED VIEW public.kp_rates_registry_mv_next AS
WITH kp AS (
  -- КП из файлов: позиция ВОР (estimate_name — какой ВОР) и файл КП, сохранённый вместе с ценами (окно загрузки КП
  -- пишет файл сразу после цен): того же подрядчика и тендера, с минуты до по 10 минут после, ближайший.
  SELECT p.id AS proposal_id, p.tender_id, p.counterparty_id, p.proposal_date, p.unit_price_materials, p.unit_price_works,
         ei.cost_name, ei.unit, ei.material_consumption, ei.work_volume, ei.estimate_name,
         t.object_id, t.work_description, o.name AS object_name, c.name AS counterparty_name,
         kf.s3_document_id AS source_doc_id, kf.file_name AS source_doc_name
  FROM public.tender_counterparty_proposals p
  JOIN public.tender_estimate_items ei ON ei.id = p.estimate_item_id
  JOIN public.tenders t ON t.id = p.tender_id
  LEFT JOIN public.objects o ON o.id = t.object_id
  LEFT JOIN public.counterparties c ON c.id = p.counterparty_id
  LEFT JOIN LATERAL (
    SELECT f.s3_document_id, d.file_name
    FROM public.tender_proposal_files f
    JOIN public.s3_documents d ON d.id = f.s3_document_id
    WHERE f.tender_id = p.tender_id AND f.counterparty_id = p.counterparty_id AND f.file_kind = 'commercial_proposal'
      AND f.created_at >= p.created_at - interval '1 minute' AND f.created_at <= p.created_at + interval '10 minutes'
    ORDER BY abs(extract(epoch FROM f.created_at - p.created_at)), f.id
    LIMIT 1
  ) kf ON true
), entries AS (
  SELECT kp.proposal_id, 'material'::text AS item_type, kp.cost_name AS item_name, kp.unit,
         kp.unit_price_materials AS price, kp.tender_id, kp.counterparty_id, kp.proposal_date, kp.object_id,
         kp.work_description AS tender_desc, kp.object_name, kp.counterparty_name,
         'kp'::text AS source_kind, kp.estimate_name, kp.source_doc_id, kp.source_doc_name
  FROM kp
  WHERE COALESCE(kp.material_consumption, 0::numeric) > 0::numeric AND COALESCE(kp.unit_price_materials, 0::numeric) > 0::numeric
    AND public.kp_norm_name(kp.cost_name) <> ''::text
  UNION ALL
  SELECT kp.proposal_id, 'work'::text, kp.cost_name, kp.unit, kp.unit_price_works, kp.tender_id, kp.counterparty_id,
         kp.proposal_date, kp.object_id, kp.work_description, kp.object_name, kp.counterparty_name,
         'kp'::text, kp.estimate_name, kp.source_doc_id, kp.source_doc_name
  FROM kp
  WHERE COALESCE(kp.work_volume, 0::numeric) > 0::numeric AND COALESCE(kp.unit_price_works, 0::numeric) > 0::numeric
    AND public.kp_norm_name(kp.cost_name) <> ''::text
  UNION ALL
  -- Цены подрядчиков, введённые в кабинете (tender_bid_rates, 20261102), — только завершённого тендера (20261103).
  SELECT b.id, b.kind, b.name, left(b.unit, 50)::character varying(50), b.price, b.tender_id, b.counterparty_id,
         (b.updated_at AT TIME ZONE 'Europe/Moscow')::date, t.object_id, t.work_description, o.name, c.name,
         'site'::text, NULL::text, NULL::uuid, NULL::text
  FROM public.tender_bid_rates b
  JOIN public.tenders t ON t.id = b.tender_id
  LEFT JOIN public.objects o ON o.id = t.object_id
  LEFT JOIN public.counterparties c ON c.id = b.counterparty_id
  WHERE t.status::text = 'Завершен' AND t.deleted_at IS NULL
    AND COALESCE(b.price, 0::numeric) > 0::numeric AND public.kp_norm_name(b.name) <> ''::text
)
SELECT DISTINCT ON (tender_id, counterparty_id, item_type, (public.kp_norm_name(item_name)), (public.kp_norm_unit(unit::text)))
  md5((((((((tender_id::text || '|'::text) || counterparty_id::text) || '|'::text) || item_type) || '|'::text)
       || public.kp_norm_name(item_name)) || '|'::text) || public.kp_norm_unit(unit::text)) AS id,
  item_type, item_name, unit, price, tender_id, counterparty_id, object_id, tender_desc, object_name, counterparty_name, proposal_date,
  source_kind, estimate_name, source_doc_id, source_doc_name
FROM entries
ORDER BY tender_id, counterparty_id, item_type, (public.kp_norm_name(item_name)), (public.kp_norm_unit(unit::text)),
         proposal_date DESC NULLS LAST, proposal_id;

CREATE UNIQUE INDEX kp_rates_mv_next_id ON public.kp_rates_registry_mv_next USING btree (id);
CREATE INDEX kp_rates_mv_next_counterparty ON public.kp_rates_registry_mv_next USING btree (counterparty_id);
CREATE INDEX kp_rates_mv_next_date ON public.kp_rates_registry_mv_next USING btree (proposal_date DESC NULLS LAST);
CREATE INDEX kp_rates_mv_next_name_trgm ON public.kp_rates_registry_mv_next USING gin (item_name gin_trgm_ops);
CREATE INDEX kp_rates_mv_next_object ON public.kp_rates_registry_mv_next USING btree (object_id);
CREATE INDEX kp_rates_mv_next_price ON public.kp_rates_registry_mv_next USING btree (price);
CREATE INDEX kp_rates_mv_next_tender ON public.kp_rates_registry_mv_next USING btree (tender_id);
CREATE INDEX kp_rates_mv_next_type_name ON public.kp_rates_registry_mv_next USING btree (item_type, item_name, id);

-- ── 3. Представления реестра: материализованное + ручные строки, только читателю реестра ───────────
-- Прежние колонки — на своих местах и тех же типов, новые — в конце. Объект ручной строки — свой, иначе объект тендера.
-- Условие «читатель реестра» — над объединением, а не в каждой части: так страница реестра (сортировка по
-- наименованию, по 100 строк) читает материализованное по индексу и сливает с ручными строками (Merge Append); с
-- условием в каждой части планировщик сортировал весь вид расценки (на копии прода 15.10 — 33 мс вместо 1,7 мс).
CREATE OR REPLACE VIEW public.kp_rates_registry AS
 SELECT u.id, u.item_type, u.item_name, u.unit, u.price, u.tender_id, u.counterparty_id, u.object_id, u.tender_desc,
        u.object_name, u.counterparty_name, u.proposal_date, u.source_kind, u.estimate_name, u.source_doc_id,
        u.source_doc_name, u.source_url, u.manual_id, u.note
   FROM (SELECT r.id, r.item_type, r.item_name, r.unit, r.price, r.tender_id, r.counterparty_id, r.object_id, r.tender_desc,
                r.object_name, r.counterparty_name, r.proposal_date, r.source_kind, r.estimate_name, r.source_doc_id,
                r.source_doc_name, NULL::text AS source_url, NULL::uuid AS manual_id, NULL::text AS note
           FROM public.kp_rates_registry_mv_next r
         UNION ALL
         SELECT md5('manual|' || m.id::text), m.item_type, m.item_name, m.unit, m.price, m.tender_id, m.counterparty_id,
                coalesce(m.object_id, t.object_id), t.work_description, o.name, c.name, m.rate_date, 'manual'::text, NULL::text,
                m.s3_document_id, d.file_name, m.doc_url, m.id, m.note
           FROM public.kp_manual_rates m
           LEFT JOIN public.tenders t ON t.id = m.tender_id
           LEFT JOIN public.objects o ON o.id = coalesce(m.object_id, t.object_id)
           LEFT JOIN public.counterparties c ON c.id = m.counterparty_id
           LEFT JOIN public.s3_documents d ON d.id = m.s3_document_id) u
  WHERE (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.kp_rates_registry_filter_counterparties AS
 SELECT DISTINCT x.counterparty_id, c.name AS counterparty_name
   FROM (SELECT r.counterparty_id FROM public.kp_rates_registry_mv_next r
         UNION SELECT m.counterparty_id FROM public.kp_manual_rates m) x
   JOIN public.counterparties c ON c.id = x.counterparty_id
  WHERE x.counterparty_id IS NOT NULL AND (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.kp_rates_registry_filter_objects AS
 SELECT DISTINCT x.object_id, o.name AS object_name
   FROM (SELECT r.object_id FROM public.kp_rates_registry_mv_next r
         UNION SELECT coalesce(m.object_id, t.object_id) FROM public.kp_manual_rates m LEFT JOIN public.tenders t ON t.id = m.tender_id) x
   JOIN public.objects o ON o.id = x.object_id
  WHERE x.object_id IS NOT NULL AND (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.kp_rates_registry_filter_tenders AS
 SELECT DISTINCT x.tender_id, x.tender_desc, x.object_id
   FROM (SELECT r.tender_id, r.tender_desc, r.object_id FROM public.kp_rates_registry_mv_next r
         UNION SELECT t.id, t.work_description, t.object_id FROM public.kp_manual_rates m JOIN public.tenders t ON t.id = m.tender_id) x
  WHERE x.tender_id IS NOT NULL AND COALESCE(x.tender_desc, ''::text) <> ''::text AND (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.kp_rates_registry_units AS
 SELECT DISTINCT x.unit
   FROM (SELECT r.unit FROM public.kp_rates_registry_mv_next r UNION SELECT m.unit FROM public.kp_manual_rates m) x
  WHERE x.unit IS NOT NULL AND x.unit::text <> ''::text AND (SELECT public.osp_registry_reader());

-- Прежнее представление — прочь, новое получает его имя и имена индексов: refresh_rates_registry() обращается к
-- нему по имени (REFRESH … CONCURRENTLY — по уникальному индексу idx_kp_rates_mv_id).
DROP MATERIALIZED VIEW IF EXISTS public.kp_rates_registry_mv;
ALTER MATERIALIZED VIEW public.kp_rates_registry_mv_next RENAME TO kp_rates_registry_mv;
ALTER INDEX public.kp_rates_mv_next_id RENAME TO idx_kp_rates_mv_id;
ALTER INDEX public.kp_rates_mv_next_counterparty RENAME TO idx_kp_rates_mv_counterparty;
ALTER INDEX public.kp_rates_mv_next_date RENAME TO idx_kp_rates_mv_date;
ALTER INDEX public.kp_rates_mv_next_name_trgm RENAME TO idx_kp_rates_mv_name_trgm;
ALTER INDEX public.kp_rates_mv_next_object RENAME TO idx_kp_rates_mv_object;
ALTER INDEX public.kp_rates_mv_next_price RENAME TO idx_kp_rates_mv_price;
ALTER INDEX public.kp_rates_mv_next_tender RENAME TO idx_kp_rates_mv_tender;
ALTER INDEX public.kp_rates_mv_next_type_name RENAME TO idx_kp_rates_mv_type_name;
COMMENT ON MATERIALIZED VIEW public.kp_rates_registry_mv IS 'Реестр расценок из КП подрядчиков (с ВОР и файлом КП) и цен с сайта завершённых тендеров (дедуп по DISTINCT ON). Обновляется refresh_rates_registry()';
COMMENT ON VIEW public.kp_rates_registry IS 'Реестр «Расценки от подрядчиков (КП)»: материализованное представление и расценки, добавленные вручную (kp_manual_rates), — читателю реестра';

-- Права (20261013, Р2d): само представление — только служебному ключу, представления реестра — как были.
REVOKE ALL ON public.kp_rates_registry_mv FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.kp_rates_registry_mv TO service_role;

-- ── 4. Похожие расценки для проверки файла ───────────────────────────────────────────────────────────
-- По каждому наименованию (до 300 за вызов) — до 60 строк реестра: общие сочетания букв (similarity ≥ 0,3) или
-- наименование почти целиком входит в строку реестра (word_similarity ≥ 0,6); лучшие — первыми. kind — 'material' /
-- 'work' или NULL (оба вида). Права вызывающего: строки — только читателю реестра (условие представления).
CREATE OR REPLACE FUNCTION public.kp_rates_lookup(p_names text[], p_kind text DEFAULT NULL)
  RETURNS TABLE (idx integer, id text, item_type text, item_name text, unit text, price numeric, tender_id uuid,
                 counterparty_id uuid, object_id uuid, tender_desc text, object_name text, counterparty_name text,
                 proposal_date date, source_kind text, estimate_name text, source_doc_id uuid, source_doc_name text,
                 source_url text, manual_id uuid, sim real)
  LANGUAGE plpgsql STABLE
  SET search_path = public, extensions, pg_temp
  SET pg_trgm.similarity_threshold = '0.3'
  SET pg_trgm.word_similarity_threshold = '0.6'
AS $$
DECLARE
  v_n integer := coalesce(array_length(p_names, 1), 0);
  v_name text;
BEGIN
  IF v_n > 300 THEN
    RAISE EXCEPTION 'За один раз — не больше 300 наименований' USING ERRCODE = '22023';
  END IF;
  IF p_kind IS NOT NULL AND p_kind NOT IN ('material', 'work') THEN
    RAISE EXCEPTION 'Вид расценки — material или work' USING ERRCODE = '22023';
  END IF;
  FOR i IN 1..v_n LOOP
    v_name := left(btrim(regexp_replace(coalesce(p_names[i], ''), '\s+', ' ', 'g')), 300);
    CONTINUE WHEN char_length(v_name) < 2;
    RETURN QUERY
      SELECT i, r.id, r.item_type, r.item_name, r.unit::text, r.price, r.tender_id, r.counterparty_id, r.object_id,
             r.tender_desc, r.object_name::text, r.counterparty_name, r.proposal_date, r.source_kind, r.estimate_name,
             r.source_doc_id, r.source_doc_name, r.source_url, r.manual_id,
             greatest(similarity(r.item_name, v_name), word_similarity(v_name, r.item_name) * 0.9)::real
      FROM public.kp_rates_registry r
      WHERE (r.item_name % v_name OR v_name <% r.item_name)
        AND (p_kind IS NULL OR r.item_type = p_kind)
      ORDER BY 20 DESC, r.proposal_date DESC NULLS LAST, r.id
      LIMIT 60;
  END LOOP;
END
$$;
COMMENT ON FUNCTION public.kp_rates_lookup(text[], text) IS
  'Похожие расценки реестра КП для строк файла (окно «Проверить по файлу»): до 60 на наименование, права вызывающего';
REVOKE ALL ON FUNCTION public.kp_rates_lookup(text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kp_rates_lookup(text[], text) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
