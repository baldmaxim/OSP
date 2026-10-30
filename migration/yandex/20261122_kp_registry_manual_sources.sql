-- Реестр расценок → «Расценки от подрядчиков (КП)»: расценки, добавленные вручную, документ, из которого взята
-- расценка, и поиск похожих расценок для проверки файла (решения пользователя 30.10.2026).
-- Тело supabase/migrations/20261122_kp_registry_manual_sources.sql (та же таблица, то же определение реестра и той
-- же функции поиска), иначе — под одну учётку:
--  • kp_manual_rates — правила по строкам включены и действуют на владельца, служебные операции — пропуском; читает
--    читатель реестра (osp_registry_reader), добавляет, меняет и удаляет право правки «Реестра расценок»
--    (osp_can('rates_registry', 'edit'));
--  • реестр — osp_private.kp_rates_registry_mv (пересобирается рядом и подменяется, как 20261103); ручные строки
--    представления реестра читают через функцию закрытой схемы osp_private.view_kp_manual_rates() с отметкой
--    пропуска (как фильтры по подрядчику и объекту — load-single-owner.sql, п. 9): представление с правами владельца
--    таблицу с правилами напрямую не читает; фильтры по подрядчику и объекту — те же функции, с ручными строками;
--  • ролей Supabase и выдачи прав нет; разрешения шлюза — строками osp:allow.
-- Документ-источник у строк КП — ВОР позиции и файл КП, сохранённый вместе с ценами (подбирается при пересчёте
-- реестра, данные КП не меняются). Данные портала не меняются. Повтор безопасен. Нужна 20261103.

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
ALTER TABLE public.kp_manual_rates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS osp_internal ON public.kp_manual_rates;
CREATE POLICY osp_internal ON public.kp_manual_rates FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

-- Пропуск → да; иначе роль из токена и условие (как TO authenticated USING (…) на проде).
DROP POLICY IF EXISTS kp_manual_rates_read ON public.kp_manual_rates;
CREATE POLICY kp_manual_rates_read ON public.kp_manual_rates FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_registry_reader())) END);
DROP POLICY IF EXISTS kp_manual_rates_insert ON public.kp_manual_rates;
CREATE POLICY kp_manual_rates_insert ON public.kp_manual_rates FOR INSERT TO PUBLIC
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_can('rates_registry', 'edit'))) END);
DROP POLICY IF EXISTS kp_manual_rates_update ON public.kp_manual_rates;
CREATE POLICY kp_manual_rates_update ON public.kp_manual_rates FOR UPDATE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_can('rates_registry', 'edit'))) END)
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_can('rates_registry', 'edit'))) END);
DROP POLICY IF EXISTS kp_manual_rates_delete ON public.kp_manual_rates;
CREATE POLICY kp_manual_rates_delete ON public.kp_manual_rates FOR DELETE TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.osp_can('rates_registry', 'edit'))) END);

INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'kp_manual_rates', 'kp_manual_rates_read', ARRAY['authenticated']),
  ('public', 'kp_manual_rates', 'kp_manual_rates_insert', ARRAY['authenticated']),
  ('public', 'kp_manual_rates', 'kp_manual_rates_update', ARRAY['authenticated']),
  ('public', 'kp_manual_rates', 'kp_manual_rates_delete', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;
-- osp:allow table kp_manual_rates authenticated=select,insert,update,delete

-- Ручные строки для представлений реестра: с отметкой пропуска (правила по строкам таблиц не мешают), только читателю
-- реестра — как функции фильтров реестра (load-single-owner.sql, п. 9). Объект — свой, иначе объект тендера.
CREATE OR REPLACE FUNCTION osp_private.view_kp_manual_rates()
  RETURNS TABLE (id text, item_type text, item_name text, unit character varying(50), price numeric(15,2), tender_id uuid,
                 counterparty_id uuid, object_id uuid, tender_desc text, object_name character varying(255),
                 counterparty_name text, proposal_date date, source_kind text, estimate_name text, source_doc_id uuid,
                 source_doc_name text, source_url text, manual_id uuid, note text)
  LANGUAGE sql STABLE
  SET search_path = public
  SET application_name = 'osp:internal'
AS $$
  SELECT md5('manual|' || m.id::text), m.item_type, m.item_name, m.unit, m.price, m.tender_id, m.counterparty_id,
         coalesce(m.object_id, t.object_id), t.work_description, o.name, c.name, m.rate_date, 'manual'::text, NULL::text,
         m.s3_document_id, d.file_name, m.doc_url, m.id, m.note
  FROM public.kp_manual_rates m
  LEFT JOIN public.tenders t ON t.id = m.tender_id
  LEFT JOIN public.objects o ON o.id = coalesce(m.object_id, t.object_id)
  LEFT JOIN public.counterparties c ON c.id = m.counterparty_id
  LEFT JOIN public.s3_documents d ON d.id = m.s3_document_id
  WHERE (SELECT public.osp_registry_reader())
$$;

-- ── 2. Реестр КП: документ-источник ──────────────────────────────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS osp_private.kp_rates_registry_mv_next;
CREATE MATERIALIZED VIEW osp_private.kp_rates_registry_mv_next AS
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

CREATE UNIQUE INDEX kp_rates_mv_next_id ON osp_private.kp_rates_registry_mv_next USING btree (id);
CREATE INDEX kp_rates_mv_next_counterparty ON osp_private.kp_rates_registry_mv_next USING btree (counterparty_id);
CREATE INDEX kp_rates_mv_next_date ON osp_private.kp_rates_registry_mv_next USING btree (proposal_date DESC NULLS LAST);
CREATE INDEX kp_rates_mv_next_name_trgm ON osp_private.kp_rates_registry_mv_next USING gin (item_name gin_trgm_ops);
CREATE INDEX kp_rates_mv_next_object ON osp_private.kp_rates_registry_mv_next USING btree (object_id);
CREATE INDEX kp_rates_mv_next_price ON osp_private.kp_rates_registry_mv_next USING btree (price);
CREATE INDEX kp_rates_mv_next_tender ON osp_private.kp_rates_registry_mv_next USING btree (tender_id);
CREATE INDEX kp_rates_mv_next_type_name ON osp_private.kp_rates_registry_mv_next USING btree (item_type, item_name, id);

-- ── 3. Представления реестра: материализованное + ручные строки, только читателю реестра ───────────
-- Прежние колонки — на своих местах и тех же типов (ручные строки приводятся к ним), новые — в конце. Условие
-- «читатель реестра» — над объединением: так страница читает материализованное по индексу (как в Supabase-варианте).
CREATE OR REPLACE VIEW public.kp_rates_registry AS
 SELECT u.id, u.item_type, u.item_name, u.unit, u.price, u.tender_id, u.counterparty_id, u.object_id, u.tender_desc,
        u.object_name, u.counterparty_name, u.proposal_date, u.source_kind, u.estimate_name, u.source_doc_id,
        u.source_doc_name, u.source_url, u.manual_id, u.note
   FROM (SELECT r.id, r.item_type, r.item_name, r.unit, r.price, r.tender_id, r.counterparty_id, r.object_id, r.tender_desc,
                r.object_name, r.counterparty_name, r.proposal_date, r.source_kind, r.estimate_name, r.source_doc_id,
                r.source_doc_name, NULL::text AS source_url, NULL::uuid AS manual_id, NULL::text AS note
           FROM osp_private.kp_rates_registry_mv_next r
         UNION ALL
         SELECT f.id, f.item_type, f.item_name, f.unit::character varying(50), f.price::numeric(15,2), f.tender_id,
                f.counterparty_id, f.object_id, f.tender_desc, f.object_name::character varying(255), f.counterparty_name,
                f.proposal_date, f.source_kind, f.estimate_name, f.source_doc_id, f.source_doc_name, f.source_url,
                f.manual_id, f.note
           FROM osp_private.view_kp_manual_rates() f) u
  WHERE (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.kp_rates_registry_filter_tenders AS
 SELECT DISTINCT x.tender_id, x.tender_desc, x.object_id
   FROM (SELECT r.tender_id, r.tender_desc, r.object_id FROM osp_private.kp_rates_registry_mv_next r
         UNION SELECT f.tender_id, f.tender_desc, f.object_id FROM osp_private.view_kp_manual_rates() f) x
  WHERE x.tender_id IS NOT NULL AND COALESCE(x.tender_desc, ''::text) <> ''::text AND (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.kp_rates_registry_units AS
 SELECT DISTINCT x.unit
   FROM (SELECT r.unit FROM osp_private.kp_rates_registry_mv_next r
         UNION SELECT f.unit::character varying(50) FROM osp_private.view_kp_manual_rates() f) x
  WHERE x.unit IS NOT NULL AND x.unit::text <> ''::text AND (SELECT public.osp_registry_reader());

-- Прежнее представление — прочь, новое получает его имя и имена индексов: refresh_rates_registry() обращается к
-- нему по имени (REFRESH … CONCURRENTLY — по уникальному индексу idx_kp_rates_mv_id).
DROP MATERIALIZED VIEW IF EXISTS osp_private.kp_rates_registry_mv;
ALTER MATERIALIZED VIEW osp_private.kp_rates_registry_mv_next RENAME TO kp_rates_registry_mv;
ALTER INDEX osp_private.kp_rates_mv_next_id RENAME TO idx_kp_rates_mv_id;
ALTER INDEX osp_private.kp_rates_mv_next_counterparty RENAME TO idx_kp_rates_mv_counterparty;
ALTER INDEX osp_private.kp_rates_mv_next_date RENAME TO idx_kp_rates_mv_date;
ALTER INDEX osp_private.kp_rates_mv_next_name_trgm RENAME TO idx_kp_rates_mv_name_trgm;
ALTER INDEX osp_private.kp_rates_mv_next_object RENAME TO idx_kp_rates_mv_object;
ALTER INDEX osp_private.kp_rates_mv_next_price RENAME TO idx_kp_rates_mv_price;
ALTER INDEX osp_private.kp_rates_mv_next_tender RENAME TO idx_kp_rates_mv_tender;
ALTER INDEX osp_private.kp_rates_mv_next_type_name RENAME TO idx_kp_rates_mv_type_name;
COMMENT ON MATERIALIZED VIEW osp_private.kp_rates_registry_mv IS 'Реестр расценок из КП подрядчиков (с ВОР и файлом КП) и цен с сайта завершённых тендеров (дедуп по DISTINCT ON). Обновляется refresh_rates_registry()';
COMMENT ON VIEW public.kp_rates_registry IS 'Реестр «Расценки от подрядчиков (КП)»: материализованное представление и расценки, добавленные вручную (kp_manual_rates), — читателю реестра';

-- Фильтры по подрядчику и объекту — функции закрытой схемы (загрузчик): те же колонки, с ручными строками. Читают
-- представление по имени — после переименования это уже новое.
CREATE OR REPLACE FUNCTION osp_private.view_kp_rates_registry_filter_counterparties()
  RETURNS TABLE (counterparty_id uuid, counterparty_name text)
  LANGUAGE sql STABLE
  SET search_path = public
  SET application_name = 'osp:internal'
AS $$
  SELECT DISTINCT x.counterparty_id, c.name AS counterparty_name
  FROM (SELECT r.counterparty_id FROM osp_private.kp_rates_registry_mv r
        UNION SELECT m.counterparty_id FROM public.kp_manual_rates m) x
  JOIN public.counterparties c ON c.id = x.counterparty_id
  WHERE x.counterparty_id IS NOT NULL AND (SELECT public.osp_registry_reader())
$$;
CREATE OR REPLACE FUNCTION osp_private.view_kp_rates_registry_filter_objects()
  RETURNS TABLE (object_id uuid, object_name character varying(255))
  LANGUAGE sql STABLE
  SET search_path = public
  SET application_name = 'osp:internal'
AS $$
  SELECT DISTINCT x.object_id, o.name AS object_name
  FROM (SELECT r.object_id FROM osp_private.kp_rates_registry_mv r
        UNION SELECT coalesce(m.object_id, t.object_id) FROM public.kp_manual_rates m
              LEFT JOIN public.tenders t ON t.id = m.tender_id) x
  JOIN public.objects o ON o.id = x.object_id
  WHERE x.object_id IS NOT NULL AND (SELECT public.osp_registry_reader())
$$;

-- ── 4. Похожие расценки для проверки файла ───────────────────────────────────────────────────────────
-- Тело — как в Supabase-варианте (pg_trgm здесь — в схеме public). Права вызывающего: строки — только читателю
-- реестра (условие представления).
CREATE OR REPLACE FUNCTION public.kp_rates_lookup(p_names text[], p_kind text DEFAULT NULL)
  RETURNS TABLE (idx integer, id text, item_type text, item_name text, unit text, price numeric, tender_id uuid,
                 counterparty_id uuid, object_id uuid, tender_desc text, object_name text, counterparty_name text,
                 proposal_date date, source_kind text, estimate_name text, source_doc_id uuid, source_doc_name text,
                 source_url text, manual_id uuid, sim real)
  LANGUAGE plpgsql STABLE
  SET search_path = public, pg_temp
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
-- osp:allow rpc kp_rates_lookup authenticated
