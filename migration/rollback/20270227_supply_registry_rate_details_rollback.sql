-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20270227_supply_registry_rate_details.sql (база Supabase; для базы Яндекса —
-- 20270227_supply_registry_rate_details_yandex_rollback.sql): реестр «Расценки от снабжения СУ-10» — снова 12 колонок, как
-- после 20270224, загрузка не пишет подробности строки. Страница это понимает (колонок нет — без колонки «Документ» и окна
-- подробностей).
-- Данные НЕ удаляются: колонки contractor_label, doc_number, order_number, source_file, invoice_url, их ограничения и
-- индексы поиска остаются в supply_registry_rates (в реестре не видны). Очистка полей при записи — та, что поставила
-- 20270227 (колонки на месте). Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF to_regclass('osp_private.supply_registry_rates') IS NOT NULL THEN
    RAISE EXCEPTION 'Это база Яндекса — откат 20270227_supply_registry_rate_details_yandex_rollback.sql';
  END IF;
END
$$;

-- Колонки подробностей представление теряет — пересоздать (CREATE OR REPLACE колонку не убирает). Права — как были
-- (20261013, Р2d; служебному ключу — по умолчанию).
DROP VIEW IF EXISTS public.supply_rates_registry;
CREATE VIEW public.supply_rates_registry AS
 SELECT u.id, u.source_type, u.source_name, u.item_name, u.unit, u.price, u.tender_id, u.object_id, u.tender_desc,
        u.object_name, u.rate_date, u.import_id
   FROM (SELECT r.id, r.source_type, r.source_name, r.item_name, r.unit, r.price, r.tender_id, r.object_id, r.tender_desc,
                r.object_name, r.rate_date, NULL::uuid AS import_id
           FROM public.supply_rates_registry_mv r
         UNION ALL
         SELECT md5('import|' || m.id::text), 'supply_import'::text, m.source_name, m.item_name, m.unit::text, m.price,
                m.tender_id, m.object_id, coalesce(t.work_description, m.tender_label),
                coalesce(o.name, left(m.object_label, 255))::character varying(255),
                (m.rate_date::timestamp AT TIME ZONE 'Europe/Moscow'), m.import_id
           FROM public.supply_registry_rates m
           LEFT JOIN public.tenders t ON t.id = m.tender_id
           LEFT JOIN public.objects o ON o.id = m.object_id) u
  WHERE (SELECT public.osp_registry_reader());
REVOKE ALL ON public.supply_rates_registry FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.supply_rates_registry TO authenticated;
COMMENT ON VIEW public.supply_rates_registry IS
  'Реестр «Расценки от снабжения СУ-10»: цены снабжения из тендеров (материализованное) и загруженные из Excel (supply_registry_rates), — читателю реестра';

-- Загрузка порцией — тело 20270224 (без подробностей строки).
CREATE OR REPLACE FUNCTION public.supply_registry_import(p_import uuid, p_file_name text, p_options jsonb, p_rows jsonb)
  RETURNS TABLE (import_id uuid, added integer, skipped integer)
  LANGUAGE plpgsql VOLATILE
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_import uuid := p_import;
  v_n integer;
  v_added integer;
  v_bad integer;
BEGIN
  IF NOT public.osp_can('rates_registry', 'edit') THEN
    RAISE EXCEPTION 'Нет права правки реестра расценок' USING ERRCODE = '42501';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'Строки — массивом' USING ERRCODE = '22023';
  END IF;
  v_n := jsonb_array_length(p_rows);
  IF v_n > 1000 THEN
    RAISE EXCEPTION 'За один раз — не больше 1000 строк' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_bad
  FROM jsonb_to_recordset(p_rows) AS r(rate_date date)
  WHERE r.rate_date IS NULL OR r.rate_date < date '2000-01-01'
     OR r.rate_date > (now() AT TIME ZONE 'Europe/Moscow')::date + 1;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Дата расценки не указана или из будущего: строк %', v_bad USING ERRCODE = '22023';
  END IF;

  IF v_import IS NULL THEN
    INSERT INTO public.supply_registry_imports (file_name, options)
    VALUES (left(coalesce(nullif(btrim(p_file_name), ''), 'файл'), 500), coalesce(p_options, '{}'::jsonb))
    RETURNING id INTO v_import;
  ELSIF NOT EXISTS (SELECT 1 FROM public.supply_registry_imports i WHERE i.id = v_import) THEN
    RAISE EXCEPTION 'Загрузка не найдена — возможно, её уже удалили' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.supply_registry_rates (import_id, source_name, item_name, unit, price, object_id, object_label,
                                            tender_id, tender_label, rate_date, row_no)
  SELECT v_import, r.source_name, r.item_name, left(r.unit, 50), round(r.price, 2), r.object_id, left(r.object_label, 255),
         r.tender_id, left(r.tender_label, 1000), r.rate_date, r.row_no
  FROM jsonb_to_recordset(p_rows) AS r(source_name text, item_name text, unit text, price numeric, object_id uuid,
                                       object_label text, tender_id uuid, tender_label text, rate_date date, row_no integer)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;

  RETURN QUERY SELECT v_import, v_added, v_n - v_added;
END
$$;
REVOKE ALL ON FUNCTION public.supply_registry_import(uuid, text, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supply_registry_import(uuid, text, jsonb, jsonb) TO authenticated, service_role;

COMMIT;
