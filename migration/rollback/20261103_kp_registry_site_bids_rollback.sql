-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261103_kp_registry_site_bids.sql (Supabase): «Расценки от подрядчиков (КП)»
-- снова только из КП файлами (tender_counterparty_proposals), как после 20261015; цены с сайта в реестр не попадают
-- (в таблице tender_bid_rates они остаются). Та же подмена представления рядом. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP MATERIALIZED VIEW IF EXISTS public.kp_rates_registry_mv_next;
CREATE MATERIALIZED VIEW public.kp_rates_registry_mv_next AS
WITH entries AS (
  SELECT p.id AS proposal_id, 'material'::text AS item_type, ei.cost_name AS item_name, ei.unit,
         p.unit_price_materials AS price, p.tender_id, p.counterparty_id, p.proposal_date, t.object_id,
         t.work_description AS tender_desc, o.name AS object_name, c.name AS counterparty_name
  FROM public.tender_counterparty_proposals p
  JOIN public.tender_estimate_items ei ON ei.id = p.estimate_item_id
  JOIN public.tenders t ON t.id = p.tender_id
  LEFT JOIN public.objects o ON o.id = t.object_id
  LEFT JOIN public.counterparties c ON c.id = p.counterparty_id
  WHERE COALESCE(ei.material_consumption, 0::numeric) > 0::numeric AND COALESCE(p.unit_price_materials, 0::numeric) > 0::numeric
    AND public.kp_norm_name(ei.cost_name) <> ''::text
  UNION ALL
  SELECT p.id, 'work'::text, ei.cost_name, ei.unit, p.unit_price_works, p.tender_id, p.counterparty_id, p.proposal_date,
         t.object_id, t.work_description, o.name, c.name
  FROM public.tender_counterparty_proposals p
  JOIN public.tender_estimate_items ei ON ei.id = p.estimate_item_id
  JOIN public.tenders t ON t.id = p.tender_id
  LEFT JOIN public.objects o ON o.id = t.object_id
  LEFT JOIN public.counterparties c ON c.id = p.counterparty_id
  WHERE COALESCE(ei.work_volume, 0::numeric) > 0::numeric AND COALESCE(p.unit_price_works, 0::numeric) > 0::numeric
    AND public.kp_norm_name(ei.cost_name) <> ''::text
)
SELECT DISTINCT ON (tender_id, counterparty_id, item_type, (public.kp_norm_name(item_name)), (public.kp_norm_unit(unit::text)))
  md5((((((((tender_id::text || '|'::text) || counterparty_id::text) || '|'::text) || item_type) || '|'::text)
       || public.kp_norm_name(item_name)) || '|'::text) || public.kp_norm_unit(unit::text)) AS id,
  item_type, item_name, unit, price, tender_id, counterparty_id, object_id, tender_desc, object_name, counterparty_name, proposal_date
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

-- Представления реестра — те же колонки и то же условие «читает сотрудник» (osp_registry_reader, 20261013).
CREATE OR REPLACE VIEW public.kp_rates_registry AS
 SELECT id, item_type, item_name, unit, price, tender_id, counterparty_id, object_id, tender_desc, object_name,
        counterparty_name, proposal_date
   FROM public.kp_rates_registry_mv_next
  WHERE (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.kp_rates_registry_filter_counterparties AS
 SELECT DISTINCT r.counterparty_id, c.name AS counterparty_name
   FROM public.kp_rates_registry_mv_next r
   JOIN public.counterparties c ON c.id = r.counterparty_id
  WHERE r.counterparty_id IS NOT NULL AND (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.kp_rates_registry_filter_objects AS
 SELECT DISTINCT r.object_id, o.name AS object_name
   FROM public.kp_rates_registry_mv_next r
   JOIN public.objects o ON o.id = r.object_id
  WHERE r.object_id IS NOT NULL AND (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.kp_rates_registry_filter_tenders AS
 SELECT DISTINCT tender_id, tender_desc, object_id
   FROM public.kp_rates_registry_mv_next r
  WHERE tender_id IS NOT NULL AND COALESCE(tender_desc, ''::text) <> ''::text AND (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.kp_rates_registry_units AS
 SELECT DISTINCT unit
   FROM public.kp_rates_registry_mv_next
  WHERE unit IS NOT NULL AND unit::text <> ''::text AND (SELECT public.osp_registry_reader());

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
COMMENT ON MATERIALIZED VIEW public.kp_rates_registry_mv IS 'Реестр расценок из КП подрядчиков (дедуп по DISTINCT ON). Обновляется refresh_rates_registry()';

-- Права (20261013, Р2d): само представление — только служебному ключу, представления реестра — как были.
REVOKE ALL ON public.kp_rates_registry_mv FROM PUBLIC, anon, authenticated, service_role;
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.kp_rates_registry_mv TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
