-- Откат 20261015_rates_registry_deterministic.sql: прежний порядок (без идентификатора предложения).
-- СЕЙЧАС НЕ ВЫПОЛНЯТЬ — только при проблеме.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP MATERIALIZED VIEW public.kp_rates_registry_mv CASCADE;

CREATE MATERIALIZED VIEW public.kp_rates_registry_mv AS
WITH entries AS (
         SELECT p.id AS proposal_id,
            'material'::text AS item_type,
            ei.cost_name AS item_name,
            ei.unit,
            p.unit_price_materials AS price,
            p.tender_id,
            p.counterparty_id,
            p.proposal_date,
            t.object_id,
            t.work_description AS tender_desc,
            o.name AS object_name,
            c.name AS counterparty_name
           FROM tender_counterparty_proposals p
             JOIN tender_estimate_items ei ON ei.id = p.estimate_item_id
             JOIN tenders t ON t.id = p.tender_id
             LEFT JOIN objects o ON o.id = t.object_id
             LEFT JOIN counterparties c ON c.id = p.counterparty_id
          WHERE COALESCE(ei.material_consumption, 0::numeric) > 0::numeric AND COALESCE(p.unit_price_materials, 0::numeric) > 0::numeric AND kp_norm_name(ei.cost_name) <> ''::text
        UNION ALL
         SELECT p.id,
            'work'::text AS text,
            ei.cost_name,
            ei.unit,
            p.unit_price_works,
            p.tender_id,
            p.counterparty_id,
            p.proposal_date,
            t.object_id,
            t.work_description,
            o.name,
            c.name
           FROM tender_counterparty_proposals p
             JOIN tender_estimate_items ei ON ei.id = p.estimate_item_id
             JOIN tenders t ON t.id = p.tender_id
             LEFT JOIN objects o ON o.id = t.object_id
             LEFT JOIN counterparties c ON c.id = p.counterparty_id
          WHERE COALESCE(ei.work_volume, 0::numeric) > 0::numeric AND COALESCE(p.unit_price_works, 0::numeric) > 0::numeric AND kp_norm_name(ei.cost_name) <> ''::text
        )
 SELECT DISTINCT ON (tender_id, counterparty_id, item_type, (kp_norm_name(item_name)), (kp_norm_unit(unit::text))) md5((((((((tender_id::text || '|'::text) || counterparty_id::text) || '|'::text) || item_type) || '|'::text) || kp_norm_name(item_name)) || '|'::text) || kp_norm_unit(unit::text)) AS id,
    item_type,
    item_name,
    unit,
    price,
    tender_id,
    counterparty_id,
    object_id,
    tender_desc,
    object_name,
    counterparty_name,
    proposal_date
   FROM entries
  ORDER BY tender_id, counterparty_id, item_type, (kp_norm_name(item_name)), (kp_norm_unit(unit::text)), proposal_date DESC NULLS LAST
WITH DATA;

CREATE INDEX idx_kp_rates_mv_counterparty ON public.kp_rates_registry_mv USING btree (counterparty_id);
CREATE INDEX idx_kp_rates_mv_date ON public.kp_rates_registry_mv USING btree (proposal_date DESC NULLS LAST);
CREATE UNIQUE INDEX idx_kp_rates_mv_id ON public.kp_rates_registry_mv USING btree (id);
CREATE INDEX idx_kp_rates_mv_name_trgm ON public.kp_rates_registry_mv USING gin (item_name gin_trgm_ops);
CREATE INDEX idx_kp_rates_mv_object ON public.kp_rates_registry_mv USING btree (object_id);
CREATE INDEX idx_kp_rates_mv_price ON public.kp_rates_registry_mv USING btree (price);
CREATE INDEX idx_kp_rates_mv_tender ON public.kp_rates_registry_mv USING btree (tender_id);
CREATE INDEX idx_kp_rates_mv_type_name ON public.kp_rates_registry_mv USING btree (item_type, item_name, id);

COMMENT ON MATERIALIZED VIEW public.kp_rates_registry_mv IS 'Реестр расценок из КП подрядчиков (дедуп по DISTINCT ON). Обновляется refresh_rates_registry()';
REVOKE ALL ON public.kp_rates_registry_mv FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.kp_rates_registry_mv TO service_role;

CREATE VIEW public.kp_rates_registry AS
SELECT id,
    item_type,
    item_name,
    unit,
    price,
    tender_id,
    counterparty_id,
    object_id,
    tender_desc,
    object_name,
    counterparty_name,
    proposal_date
   FROM kp_rates_registry_mv
  WHERE ( SELECT osp_registry_reader() AS osp_registry_reader);
REVOKE ALL ON public.kp_rates_registry FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.kp_rates_registry TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.kp_rates_registry TO service_role;

CREATE VIEW public.kp_rates_registry_filter_counterparties AS
SELECT DISTINCT r.counterparty_id,
    c.name AS counterparty_name
   FROM kp_rates_registry_mv r
     JOIN counterparties c ON c.id = r.counterparty_id
  WHERE r.counterparty_id IS NOT NULL AND ( SELECT osp_registry_reader() AS osp_registry_reader);
REVOKE ALL ON public.kp_rates_registry_filter_counterparties FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.kp_rates_registry_filter_counterparties TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.kp_rates_registry_filter_counterparties TO service_role;

CREATE VIEW public.kp_rates_registry_filter_objects AS
SELECT DISTINCT r.object_id,
    o.name AS object_name
   FROM kp_rates_registry_mv r
     JOIN objects o ON o.id = r.object_id
  WHERE r.object_id IS NOT NULL AND ( SELECT osp_registry_reader() AS osp_registry_reader);
REVOKE ALL ON public.kp_rates_registry_filter_objects FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.kp_rates_registry_filter_objects TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.kp_rates_registry_filter_objects TO service_role;

CREATE VIEW public.kp_rates_registry_filter_tenders AS
SELECT DISTINCT tender_id,
    tender_desc,
    object_id
   FROM kp_rates_registry_mv r
  WHERE tender_id IS NOT NULL AND COALESCE(tender_desc, ''::text) <> ''::text AND ( SELECT osp_registry_reader() AS osp_registry_reader);
REVOKE ALL ON public.kp_rates_registry_filter_tenders FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.kp_rates_registry_filter_tenders TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.kp_rates_registry_filter_tenders TO service_role;

CREATE VIEW public.kp_rates_registry_units AS
SELECT DISTINCT unit
   FROM kp_rates_registry_mv
  WHERE unit IS NOT NULL AND unit::text <> ''::text AND ( SELECT osp_registry_reader() AS osp_registry_reader);
REVOKE ALL ON public.kp_rates_registry_units FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.kp_rates_registry_units TO authenticated;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.kp_rates_registry_units TO service_role;

COMMIT;
