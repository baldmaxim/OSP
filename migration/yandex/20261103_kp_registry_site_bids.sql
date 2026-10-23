-- Реестр расценок → «Расценки от подрядчиков (КП)»: цены подрядчиков из кабинета — после завершения тендера.
-- Тело supabase/migrations/20261103_kp_registry_site_bids.sql (то же определение представления), иначе:
--  • реестр здесь — osp_private.kp_rates_registry_mv (материализованные представления в закрытой схеме);
--    пересобирается рядом и подменяется; три представления реестра переключаются на новое, фильтры по
--    подрядчику и объекту — функции osp_private.view_kp_rates_registry_filter_* (загрузчик) — читают его по имени;
--  • ролей Supabase и выдачи прав нет — представление в закрытой схеме PostgREST наружу не отдаёт.
-- Порядок выбора строки при равной дате (идентификатор предложения, 20261015) здесь появляется этой же миграцией.
-- Данные не меняются. Повтор безопасен. Нужна 20261102.

DROP MATERIALIZED VIEW IF EXISTS osp_private.kp_rates_registry_mv_next;
CREATE MATERIALIZED VIEW osp_private.kp_rates_registry_mv_next AS
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
  UNION ALL
  -- Цены подрядчиков, введённые в кабинете (tender_bid_rates, 20261102), — только завершённого тендера: пока тендер
  -- идёт, они видны лишь администратору («Расценки подрядчиков (актуальные тендеры)»). Дата — день последней правки
  -- цены по Москве.
  SELECT b.id, b.kind, b.name, left(b.unit, 50)::character varying(50), b.price, b.tender_id, b.counterparty_id,
         (b.updated_at AT TIME ZONE 'Europe/Moscow')::date, t.object_id, t.work_description, o.name, c.name
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
  item_type, item_name, unit, price, tender_id, counterparty_id, object_id, tender_desc, object_name, counterparty_name, proposal_date
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

-- Представления реестра — те же колонки и то же условие «читает сотрудник» (osp_registry_reader, 20261013).
-- Фильтры по подрядчику и объекту здесь — функции закрытой схемы, они читают представление по имени: не трогаем.
CREATE OR REPLACE VIEW public.kp_rates_registry AS
 SELECT id, item_type, item_name, unit, price, tender_id, counterparty_id, object_id, tender_desc, object_name,
        counterparty_name, proposal_date
   FROM osp_private.kp_rates_registry_mv_next
  WHERE (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.kp_rates_registry_filter_tenders AS
 SELECT DISTINCT tender_id, tender_desc, object_id
   FROM osp_private.kp_rates_registry_mv_next r
  WHERE tender_id IS NOT NULL AND COALESCE(tender_desc, ''::text) <> ''::text AND (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.kp_rates_registry_units AS
 SELECT DISTINCT unit
   FROM osp_private.kp_rates_registry_mv_next
  WHERE unit IS NOT NULL AND unit::text <> ''::text AND (SELECT public.osp_registry_reader());

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
COMMENT ON MATERIALIZED VIEW osp_private.kp_rates_registry_mv IS 'Реестр расценок из КП подрядчиков и цен с сайта завершённых тендеров (дедуп по DISTINCT ON). Обновляется refresh_rates_registry()';
