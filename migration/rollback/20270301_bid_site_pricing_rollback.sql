-- АВАРИЙНЫЙ ОТКАТ 20270301_bid_site_pricing (только база Яндекса): кабинет подрядчика без цен снабжения и без «что изменилось в ВОР»
-- (страница раньше миграции так и работает: нет функций — нет блоков), цены подрядчика — тело 20261204 (позиции сверяются только у
-- учётки с регистрации), файлы подрядчику и организация учётки — как в 20261204 (с файлами договоров, без условия блокировки), реестр
-- КП — определение 20261204 (с ценами снабжения и отклонённых заявок). Таблицы tender_bid_supply_access и osp_private.bid_vor_archive и
-- их строки остаются (вернуть миграцию — без потерь); отметка «supply» у цен остаётся допустимой (у прежних функций её нет).
-- Одной транзакцией, повтор безопасен. Реестр КП пересобирается рядом и подменяется — до минуты на большой базе.
BEGIN;
SET LOCAL lock_timeout = '10s';
-- Реестр КП читает таблицы с правилами по строкам: пересобирать — с отметкой служебной операции (как migrate.sh), иначе он выйдет пустым.
SET LOCAL application_name = 'osp:internal';

DROP TRIGGER IF EXISTS s3_documents_bid_vor_archive ON public.s3_documents;
DROP FUNCTION IF EXISTS osp_private.bid_vor_archive_keep();
DROP FUNCTION IF EXISTS public.bid_vor_changes(uuid);
DROP FUNCTION IF EXISTS public.bid_supply_take(uuid, jsonb, boolean);
DROP FUNCTION IF EXISTS public.bid_supply_prices(uuid, uuid);
DROP FUNCTION IF EXISTS public.bid_supply_list(uuid[]);
DROP FUNCTION IF EXISTS public.bid_supply_decide(uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.bid_supply_request(uuid);

-- Цены подрядчика — тело 20261204.
CREATE OR REPLACE FUNCTION public.bid_rates_save(p_tender uuid, p_rows jsonb) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid := public.osp_counterparty_id();
  v_self boolean := public.osp_self_registered();
  v_known jsonb;
  v_pos jsonb;
  r record;
  v_price numeric;
  v_note text;
  v_name text;
  v_unit text;
  v_volume numeric;
  v_n integer := 0;
BEGIN
  IF v_cp IS NULL THEN
    RAISE EXCEPTION 'Цены вводит подрядчик' USING ERRCODE = '42501';
  END IF;
  IF NOT public.bid_can_edit(p_tender) THEN
    RAISE EXCEPTION 'Расценка этого тендера закрыта' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) > 2000 THEN
    RAISE EXCEPTION 'Неверный список цен (не больше 2000 строк за раз)' USING ERRCODE = '22023';
  END IF;
  IF v_self THEN
    SELECT coalesce(jsonb_object_agg(x.k, jsonb_build_object('name', x.n, 'unit', x.u, 'volume', x.v)), '{}'::jsonb) INTO v_known
    FROM (
      SELECT p ->> 'key' AS k, min(p ->> 'name') AS n, min(p ->> 'unit') AS u, round(sum((p ->> 'volume')::numeric), 4) AS v
      FROM osp_private.bid_vor_files f
      JOIN public.s3_documents d ON d.id = f.s3_document_id AND d.doc_category IN ('vor_statement', 'vor')
      CROSS JOIN LATERAL jsonb_array_elements(f.positions) p
      WHERE f.tender_id = p_tender AND f.status = 'ok'
      GROUP BY p ->> 'key'
    ) x;
  END IF;
  FOR r IN SELECT * FROM jsonb_to_recordset(p_rows)
             AS x(kind text, key text, unit_key text, name text, unit text, volume numeric, price numeric, note text, source text)
  LOOP
    IF r.kind IS NULL OR r.kind NOT IN ('material', 'work') OR coalesce(btrim(r.key), '') = '' OR coalesce(btrim(r.name), '') = '' THEN
      RAISE EXCEPTION 'Позиция без вида, ключа или наименования' USING ERRCODE = '22023';
    END IF;
    v_price := round(r.price, 2);
    v_note := NULLIF(btrim(r.note), '');
    v_name := btrim(r.name);
    v_unit := NULLIF(btrim(r.unit), '');
    v_volume := r.volume;
    IF v_price IS NULL AND v_note IS NULL THEN
      DELETE FROM public.tender_bid_rates
       WHERE tender_id = p_tender AND counterparty_id = v_cp AND kind = r.kind
         AND item_key = r.key AND unit_key = coalesce(r.unit_key, '');
    ELSE
      IF v_self THEN
        v_pos := v_known -> (r.kind || '|' || r.key || '|' || coalesce(r.unit_key, ''));
        IF v_pos IS NULL THEN
          RAISE EXCEPTION 'Позиции нет в ВОР этого тендера — обновите страницу' USING ERRCODE = '22023';
        END IF;
        v_name := v_pos ->> 'name';
        v_unit := NULLIF(btrim(v_pos ->> 'unit'), '');
        v_volume := (v_pos ->> 'volume')::numeric;
      END IF;
      INSERT INTO public.tender_bid_rates AS b
        (tender_id, counterparty_id, kind, item_key, unit_key, name, unit, volume, price, total, note, source, updated_by)
      VALUES (p_tender, v_cp, r.kind, r.key, coalesce(r.unit_key, ''), v_name, v_unit, v_volume,
              v_price, round(v_price * coalesce(v_volume, 0), 2), v_note,
              CASE WHEN r.source IN ('manual', 'import', 'history') THEN r.source ELSE 'manual' END, auth.uid())
      ON CONFLICT (tender_id, counterparty_id, kind, item_key, unit_key) DO UPDATE
        SET name = excluded.name, unit = excluded.unit, volume = excluded.volume, price = excluded.price,
            total = excluded.total, note = excluded.note, source = excluded.source,
            updated_at = now(), updated_by = excluded.updated_by;
    END IF;
    v_n := v_n + 1;
  END LOOP;
  IF (SELECT count(*) FROM public.tender_bid_rates WHERE tender_id = p_tender AND counterparty_id = v_cp) > 20000 THEN
    RAISE EXCEPTION 'Слишком много позиций в расценке (больше 20 000)' USING ERRCODE = '22023';
  END IF;
  RETURN v_n;
END
$$;
DROP FUNCTION IF EXISTS osp_private.bid_known_positions(uuid, text[]);
DROP FUNCTION IF EXISTS osp_private.bid_supply_price_rows(uuid);

-- Организация учётки и файлы подрядчику — как в 20261204.
CREATE OR REPLACE FUNCTION public.current_counterparty_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT ur.counterparty_id
  FROM public.user_roles ur
  WHERE ur.user_id = auth.uid() AND ur.is_approved = true AND NOT ur.self_registered
  LIMIT 1
$$;

DROP POLICY IF EXISTS portal_contractor_select ON public.s3_documents;
CREATE POLICY portal_contractor_select ON public.s3_documents FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND NOT (SELECT public.osp_self_registered()) AND (
                (owner_type = 'tender'
                  AND doc_category IN ('tender_package', 'vor', 'rd', 'vor_statement')
                  AND (public.is_my_tender(owner_id)
                       OR ((SELECT public.osp_counterparty_id()) IS NOT NULL AND public.bid_access(owner_id) IN ('pending', 'accepted'))))
                OR (owner_type = 'contract' AND public.is_my_contract(owner_id)))) END);
COMMENT ON POLICY portal_contractor_select ON public.s3_documents IS
  'Подрядчик от администратора: тендерный пакет и ВОР своих тендеров и тендеров с заявкой + документы своих договоров. Учётке с регистрации файлов нет.';

-- Реестр КП — определение 20261204.
-- Определение и подмена — как в 20261122 (пересоздаётся рядом), меняется одно условие у цен с сайта.
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
    -- Компания, созданная регистрацией на сайте: только если инженер сделал её участником этого тендера (20261204).
    AND (c.registered_via IS DISTINCT FROM 'self' OR EXISTS (
      SELECT 1 FROM public.tender_counterparties tc WHERE tc.tender_id = b.tender_id AND tc.counterparty_id = b.counterparty_id))
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

-- Представления реестра: материализованное + ручные строки, только читателю реестра.
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
-- нему по имени (пересчёт без блокировки чтения — по уникальному индексу idx_kp_rates_mv_id).
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

COMMIT;
