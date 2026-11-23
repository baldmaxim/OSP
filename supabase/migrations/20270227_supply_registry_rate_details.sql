-- Реестр расценок → «Расценки от снабжения СУ-10»: подробности загруженной расценки, колонка «Документ» и поиск по индексу
-- (просьба пользователя 23.11.2026).
--  • Файл из папок счетов: к прежним колонкам — «Подрядчик по папке», «№ документа из имени файла», «№ заявки / заказа»,
--    «Файл-источник» (contractor_label, doc_number, order_number, source_file) и ссылка на счёт (invoice_url, только
--    http/https; пока задаётся колонкой файла «Ссылка на счёт», привязка — следующим шагом). Видны по нажатию на строку
--    реестра; ссылка — значком колонки «Документ». Распознавание колонок — в браузере (src/utils/supplyRegistryImport.js).
--  • Поиск подстрокой по наименованию загруженных строк — по триграммному индексу, порядок по наименованию — по индексу.
--    Представление здесь и так читает таблицу напрямую (владелец представления правилами по строкам не ограничен).
--  • Представление реестра: прежние колонки на своих местах и тех же типов, новые — в конце (у цен из тендеров — пусто).
--  • Права прежние: читает читатель реестра, загружает и удаляет загрузку право правки «Реестра расценок».
-- Вариант для базы Яндекса — migration/yandex/20270227_supply_registry_rate_details.sql (там строки ещё и переезжают в
-- закрытую схему). Данные портала не меняются. Нужна 20270224. Повтор безопасен. Проверка:
-- migration/backup/checks/20270227.sql, откат: migration/rollback/20270227_supply_registry_rate_details_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';
-- gin_trgm_ops на Supabase — в схеме extensions.
SET LOCAL search_path = public, extensions;

-- ── 1. Поля строки из файла и ссылка на счёт ─────────────────────────────────────────────────────────
ALTER TABLE public.supply_registry_rates
  ADD COLUMN IF NOT EXISTS contractor_label text,
  ADD COLUMN IF NOT EXISTS doc_number text,
  ADD COLUMN IF NOT EXISTS order_number text,
  ADD COLUMN IF NOT EXISTS source_file text,
  ADD COLUMN IF NOT EXISTS invoice_url text;
ALTER TABLE public.supply_registry_rates DROP CONSTRAINT IF EXISTS supply_registry_rates_details_len;
ALTER TABLE public.supply_registry_rates ADD CONSTRAINT supply_registry_rates_details_len CHECK (
  (contractor_label IS NULL OR char_length(contractor_label) <= 500)
  AND (doc_number IS NULL OR char_length(doc_number) <= 200)
  AND (order_number IS NULL OR char_length(order_number) <= 200)
  AND (source_file IS NULL OR char_length(source_file) <= 2000));
ALTER TABLE public.supply_registry_rates DROP CONSTRAINT IF EXISTS supply_registry_rates_invoice_url;
ALTER TABLE public.supply_registry_rates ADD CONSTRAINT supply_registry_rates_invoice_url CHECK (
  invoice_url IS NULL OR (char_length(invoice_url) <= 2000 AND invoice_url ~* '^https?://\S+$'));
COMMENT ON COLUMN public.supply_registry_rates.contractor_label IS 'Подрядчик по папке (колонка файла)';
COMMENT ON COLUMN public.supply_registry_rates.doc_number IS '№ документа из имени файла (колонка файла)';
COMMENT ON COLUMN public.supply_registry_rates.order_number IS '№ заявки / заказа (колонка файла)';
COMMENT ON COLUMN public.supply_registry_rates.source_file IS 'Файл-источник (колонка файла: путь или имя файла счёта)';
COMMENT ON COLUMN public.supply_registry_rates.invoice_url IS 'Ссылка на счёт (http/https)';

-- ── 2. Поиск и порядок по наименованию — по индексу ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS supply_registry_rates_name_idx ON public.supply_registry_rates (item_name, id);
CREATE INDEX IF NOT EXISTS supply_registry_rates_name_trgm ON public.supply_registry_rates USING gin (item_name gin_trgm_ops);

-- ── 3. Очистка полей строки при записи; кто и когда — сервер ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.supply_registry_rates_stamp() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.source_name := btrim(regexp_replace(NEW.source_name, '\s+', ' ', 'g'));
  NEW.item_name := btrim(regexp_replace(NEW.item_name, '\s+', ' ', 'g'));
  NEW.unit := nullif(btrim(NEW.unit), '');
  NEW.object_label := nullif(btrim(regexp_replace(NEW.object_label, '\s+', ' ', 'g')), '');
  NEW.tender_label := nullif(btrim(regexp_replace(NEW.tender_label, '\s+', ' ', 'g')), '');
  NEW.contractor_label := nullif(btrim(regexp_replace(NEW.contractor_label, '\s+', ' ', 'g')), '');
  NEW.doc_number := nullif(btrim(regexp_replace(NEW.doc_number, '\s+', ' ', 'g')), '');
  NEW.order_number := nullif(btrim(regexp_replace(NEW.order_number, '\s+', ' ', 'g')), '');
  NEW.source_file := nullif(btrim(NEW.source_file), '');
  NEW.invoice_url := nullif(btrim(NEW.invoice_url), '');
  NEW.created_at := now();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.supply_registry_rates_stamp() FROM PUBLIC, anon;

-- ── 4. Загрузка порцией: новые поля ──────────────────────────────────────────────────────────────────
-- Подпись прежняя: окно, открытое до выкладки, шлёт строки без новых полей — они пустые. Ссылка на счёт не http/https —
-- не пишется (строка — пишется).
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
                                            tender_id, tender_label, rate_date, row_no, contractor_label, doc_number,
                                            order_number, source_file, invoice_url)
  SELECT v_import, r.source_name, r.item_name, left(r.unit, 50), round(r.price, 2), r.object_id, left(r.object_label, 255),
         r.tender_id, left(r.tender_label, 1000), r.rate_date, r.row_no,
         left(r.contractor_label, 500), left(r.doc_number, 200), left(r.order_number, 200), left(r.source_file, 2000),
         CASE WHEN btrim(r.invoice_url) ~* '^https?://\S+$' AND char_length(btrim(r.invoice_url)) <= 2000
              THEN btrim(r.invoice_url) END
  FROM jsonb_to_recordset(p_rows) AS r(source_name text, item_name text, unit text, price numeric, object_id uuid,
                                       object_label text, tender_id uuid, tender_label text, rate_date date, row_no integer,
                                       contractor_label text, doc_number text, order_number text, source_file text,
                                       invoice_url text)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;

  RETURN QUERY SELECT v_import, v_added, v_n - v_added;
END
$$;
COMMENT ON FUNCTION public.supply_registry_import(uuid, text, jsonb, jsonb) IS
  'Загрузка расценок из Excel в реестр СУ-10 порцией до 1000 строк; такая же расценка пропускается; права вызывающего';
REVOKE ALL ON FUNCTION public.supply_registry_import(uuid, text, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supply_registry_import(uuid, text, jsonb, jsonb) TO authenticated, service_role;

-- ── 5. Представление реестра: подробности загруженной расценки — в конце ─────────────────────────────
CREATE OR REPLACE VIEW public.supply_rates_registry AS
 SELECT u.id, u.source_type, u.source_name, u.item_name, u.unit, u.price, u.tender_id, u.object_id, u.tender_desc,
        u.object_name, u.rate_date, u.import_id, u.contractor_label, u.doc_number, u.order_number, u.source_file,
        u.invoice_url, u.object_label, u.tender_label, u.row_no
   FROM (SELECT r.id, r.source_type, r.source_name, r.item_name, r.unit, r.price, r.tender_id, r.object_id, r.tender_desc,
                r.object_name, r.rate_date, NULL::uuid AS import_id, NULL::text AS contractor_label, NULL::text AS doc_number,
                NULL::text AS order_number, NULL::text AS source_file, NULL::text AS invoice_url, NULL::text AS object_label,
                NULL::text AS tender_label, NULL::integer AS row_no
           FROM public.supply_rates_registry_mv r
         UNION ALL
         SELECT md5('import|' || m.id::text), 'supply_import'::text, m.source_name, m.item_name, m.unit::text, m.price,
                m.tender_id, m.object_id, coalesce(t.work_description, m.tender_label),
                coalesce(o.name, left(m.object_label, 255))::character varying(255),
                (m.rate_date::timestamp AT TIME ZONE 'Europe/Moscow'), m.import_id, m.contractor_label, m.doc_number,
                m.order_number, m.source_file, m.invoice_url, m.object_label, m.tender_label, m.row_no
           FROM public.supply_registry_rates m
           LEFT JOIN public.tenders t ON t.id = m.tender_id
           LEFT JOIN public.objects o ON o.id = m.object_id) u
  WHERE (SELECT public.osp_registry_reader());
COMMENT ON VIEW public.supply_rates_registry IS
  'Реестр «Расценки от снабжения СУ-10»: цены снабжения из тендеров (материализованное) и загруженные из Excel (supply_registry_rates), — читателю реестра';

COMMIT;
