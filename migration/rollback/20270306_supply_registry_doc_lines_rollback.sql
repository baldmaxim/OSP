-- АВАРИЙНЫЙ ОТКАТ migration/yandex/20270306_supply_registry_doc_lines.sql (только база Яндекса): реестр «Расценки от снабжения
-- СУ-10» — снова как после 20270227 (цены тендеров и загрузки из Excel, без строк счетов и КП тендеров).
-- Снимаются триггеры на s3_documents, objects и tenders, функция статуса и разбор; представления реестра — снова 20 колонок (без
-- doc_id и doc_deleted_at) — страница это понимает: колонок нет (42703) — строк счетов и их статуса нет, остальное как было.
-- Данные НЕ удаляются: osp_private.supply_doc_rates остаётся (в реестре не видна). Применить 20270306 снова — строки соберутся
-- заново по файлам тендеров (те же id в реестре), строки файлов, удалённых после отката, будут отмечены «файл удалён» (время —
-- время повторной миграции).
-- Запуск — под учёткой-владельцем, одной транзакцией (psql -f), с отметкой служебной операции. Повтор безопасен.
-- Порядок: откат 20270227 (или 20270224) — только после этого отката: их откаты пересоздают представления реестра без строк счетов,
-- а триггеры 20270306 продолжали бы собирать строки, которых реестр уже не показывает.
-- Шлюз: строку «supply_doc_rates_status» из allow.json убирать не обязательно — функции нет, база ответит ошибкой, страница
-- работает без статуса.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL application_name = 'osp:internal';

DROP TRIGGER IF EXISTS s3_documents_supply_doc_rates_ins ON public.s3_documents;
DROP TRIGGER IF EXISTS s3_documents_supply_doc_rates_upd ON public.s3_documents;
DROP TRIGGER IF EXISTS s3_documents_supply_doc_rates_del ON public.s3_documents;
DROP TRIGGER IF EXISTS supply_doc_rates_object_name ON public.objects;
DROP TRIGGER IF EXISTS supply_doc_rates_tender ON public.tenders;
DROP FUNCTION IF EXISTS public.supply_doc_rates_status(text[]);

-- Представления — как в 20270227 (колонки убираются только пересозданием; от них ничего в базе не зависит).
DROP VIEW IF EXISTS public.supply_rates_registry;
CREATE VIEW public.supply_rates_registry AS
 SELECT u.id, u.source_type, u.source_name, u.item_name, u.unit, u.price, u.tender_id, u.object_id, u.tender_desc,
        u.object_name, u.rate_date, u.import_id, u.contractor_label, u.doc_number, u.order_number, u.source_file,
        u.invoice_url, u.object_label, u.tender_label, u.row_no
   FROM (SELECT r.id, r.source_type, r.source_name, r.item_name, r.unit, r.price, r.tender_id, r.object_id, r.tender_desc,
                r.object_name, r.rate_date, NULL::uuid AS import_id, NULL::text AS contractor_label, NULL::text AS doc_number,
                NULL::text AS order_number, NULL::text AS source_file, NULL::text AS invoice_url, NULL::text AS object_label,
                NULL::text AS tender_label, NULL::integer AS row_no
           FROM osp_private.supply_rates_registry_mv r
         UNION ALL
         SELECT m.reg_id, 'supply_import'::text, m.source_name, m.item_name, m.unit::text, m.price, m.tender_id, m.object_id,
                CASE WHEN m.tender_id IS NULL THEN m.tender_label ELSE coalesce(m.tender_desc, m.tender_label) END,
                (CASE WHEN m.object_id IS NULL THEN left(m.object_label, 255)
                      ELSE coalesce(m.object_name, left(m.object_label, 255)) END)::character varying(255),
                m.rate_at, m.import_id, m.contractor_label, m.doc_number, m.order_number, m.source_file, m.invoice_url,
                m.object_label, m.tender_label, m.row_no
           FROM osp_private.supply_registry_rates m) u
  WHERE (SELECT public.osp_registry_reader());
COMMENT ON VIEW public.supply_rates_registry IS
  'Реестр «Расценки от снабжения СУ-10»: цены снабжения из тендеров (материализованное) и загруженные из Excel (osp_private.supply_registry_rates), — читателю реестра';
CREATE OR REPLACE VIEW public.supply_rates_registry_filter_objects AS
 SELECT DISTINCT x.object_id, x.object_name
   FROM (SELECT r.object_id, r.object_name FROM osp_private.supply_rates_registry_mv r
         UNION SELECT m.object_id, coalesce(m.object_name, left(m.object_label, 255))::character varying(255)
                 FROM osp_private.supply_registry_rates m WHERE m.object_id IS NOT NULL) x
  WHERE x.object_id IS NOT NULL AND (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.supply_rates_registry_filter_tenders AS
 SELECT DISTINCT x.tender_id, x.tender_desc, x.object_id
   FROM (SELECT r.tender_id, r.tender_desc, r.object_id FROM osp_private.supply_rates_registry_mv r
         UNION SELECT m.tender_id, coalesce(m.tender_desc, m.tender_label), m.object_id
                 FROM osp_private.supply_registry_rates m WHERE m.tender_id IS NOT NULL) x
  WHERE x.tender_id IS NOT NULL AND coalesce(x.tender_desc, '') <> '' AND (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.supply_rates_registry_units AS
 SELECT DISTINCT x.unit
   FROM (SELECT r.unit FROM osp_private.supply_rates_registry_mv r
         UNION SELECT m.unit::text FROM osp_private.supply_registry_rates m) x
  WHERE x.unit IS NOT NULL AND x.unit <> '' AND (SELECT public.osp_registry_reader());

DROP FUNCTION IF EXISTS osp_private.supply_doc_rates_on_doc();
DROP FUNCTION IF EXISTS osp_private.supply_doc_rates_names();
DROP FUNCTION IF EXISTS osp_private.supply_doc_rates_sync(uuid);
DROP FUNCTION IF EXISTS osp_private.supply_doc_price_hit(numeric, numeric, numeric, jsonb, numeric);
DROP FUNCTION IF EXISTS osp_private.supply_offer_lines(jsonb);
DROP FUNCTION IF EXISTS osp_private.supply_offer_date(text);
DROP FUNCTION IF EXISTS osp_private.supply_offer_json(text);
DROP FUNCTION IF EXISTS osp_private.supply_offer_text(text, integer);
DROP FUNCTION IF EXISTS osp_private.supply_offer_num(jsonb);

COMMIT;
