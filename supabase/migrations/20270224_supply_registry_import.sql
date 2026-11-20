-- Реестр расценок → «Расценки от снабжения СУ-10»: загрузка расценок из Excel (просьба пользователя 20.11.2026).
-- Файл — как выгрузка этой вкладки: № п/п, Источник, Объект, Наименование, Ед. изм., Цена, Тендер, Дата расценки.
-- Распознавание (шапка, числа, даты, объект по неочевидному названию, тендер) — в браузере
-- (src/utils/supplyRegistryImport.js); база хранит итог и не даёт загрузить одну и ту же расценку дважды.
--  • supply_registry_imports — загрузка (файл, кто, когда, разовые настройки распознавания в options);
--    supply_registry_rates — её строки (удаляются вместе с загрузкой). Читает читатель реестра (osp_registry_reader),
--    загружает и удаляет загрузку право правки «Реестра расценок» (osp_can('rates_registry', 'edit'));
--  • supply_registry_import() — строки файла одной порцией (до 1000): новая загрузка или добавка к начатой; такая же
--    расценка (наименование, ед. изм., цена, день, объект, источник — уникальный индекс) пропускается;
--  • реестр — supply_rates_registry_mv (не пересобирается) ∪ загруженные строки; прежние колонки — на своих местах и
--    тех же типов, новая (import_id) — в конце.
-- Вариант для базы Яндекса — migration/yandex/20270224_supply_registry_import.sql. Данные портала не меняются.
-- Повтор безопасен. Нужна 20261023. Проверка: migration/backup/checks/20270224.sql, откат:
-- migration/rollback/20270224_supply_registry_import_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

-- ── 1. Загрузки ──────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.supply_registry_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name text NOT NULL CHECK (char_length(btrim(file_name)) BETWEEN 1 AND 500),
  options jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(options) = 'object'),
  created_by uuid,
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.supply_registry_imports IS
  'Загрузка расценок из Excel в реестр «Расценки от снабжения СУ-10» (строки — supply_registry_rates)';
COMMENT ON COLUMN public.supply_registry_imports.options IS
  'Разовые настройки распознавания этого файла (например, {"primavera": "k14"} — «Primavera» без корпуса = к14)';

-- ── 2. Строки загрузки ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.supply_registry_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES public.supply_registry_imports(id) ON DELETE CASCADE,
  source_name text NOT NULL CHECK (char_length(btrim(source_name)) BETWEEN 1 AND 200),
  item_name text NOT NULL CHECK (char_length(btrim(item_name)) BETWEEN 1 AND 1000),
  unit character varying(50),
  price numeric(15,2) NOT NULL CHECK (price > 0 AND price < 1e12),
  object_id uuid REFERENCES public.objects(id) ON DELETE SET NULL,
  object_label text CHECK (object_label IS NULL OR char_length(object_label) <= 255),
  tender_id uuid REFERENCES public.tenders(id) ON DELETE SET NULL,
  tender_label text CHECK (tender_label IS NULL OR char_length(tender_label) <= 1000),
  rate_date date NOT NULL,
  row_no integer CHECK (row_no IS NULL OR row_no > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.supply_registry_rates IS
  'Расценка, загруженная из Excel в реестр «Расценки от снабжения СУ-10»: цена за единицу, источник и объект — как в файле';
COMMENT ON COLUMN public.supply_registry_rates.object_label IS 'Объект как написан в файле (объект портала — object_id, если распознан)';
COMMENT ON COLUMN public.supply_registry_rates.tender_label IS 'Тендер как написан в файле (тендер портала — tender_id, если найден однозначно)';
COMMENT ON COLUMN public.supply_registry_rates.row_no IS 'Строка файла';

CREATE INDEX IF NOT EXISTS supply_registry_rates_import_idx ON public.supply_registry_rates (import_id);
CREATE INDEX IF NOT EXISTS supply_registry_rates_object_idx ON public.supply_registry_rates (object_id) WHERE object_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS supply_registry_rates_tender_idx ON public.supply_registry_rates (tender_id) WHERE tender_id IS NOT NULL;
-- Одна расценка — один раз: тот же файл второй раз и выгрузка реестра обратно строк не добавляют.
CREATE UNIQUE INDEX IF NOT EXISTS supply_registry_rates_uniq ON public.supply_registry_rates
  (public.kp_norm_name(item_name), public.kp_norm_unit(unit), price, rate_date,
   coalesce(object_id::text, lower(btrim(coalesce(object_label, '')))), lower(btrim(source_name)));

CREATE OR REPLACE FUNCTION public.supply_registry_imports_stamp() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  NEW.file_name := btrim(NEW.file_name);
  NEW.created_by := v_uid;
  NEW.created_by_name := (SELECT nullif(btrim(ur.full_name), '') FROM public.user_roles ur WHERE ur.user_id = v_uid LIMIT 1);
  NEW.created_at := now();
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS supply_registry_imports_stamp ON public.supply_registry_imports;
CREATE TRIGGER supply_registry_imports_stamp
  BEFORE INSERT ON public.supply_registry_imports
  FOR EACH ROW EXECUTE FUNCTION public.supply_registry_imports_stamp();

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
  NEW.created_at := now();
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS supply_registry_rates_stamp ON public.supply_registry_rates;
CREATE TRIGGER supply_registry_rates_stamp
  BEFORE INSERT ON public.supply_registry_rates
  FOR EACH ROW EXECUTE FUNCTION public.supply_registry_rates_stamp();

-- ── 3. Правила по строкам и права ────────────────────────────────────────────────────────────────────
ALTER TABLE public.supply_registry_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supply_registry_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS supply_registry_imports_read ON public.supply_registry_imports;
CREATE POLICY supply_registry_imports_read ON public.supply_registry_imports FOR SELECT TO authenticated
  USING ((SELECT public.osp_registry_reader()));
DROP POLICY IF EXISTS supply_registry_imports_insert ON public.supply_registry_imports;
CREATE POLICY supply_registry_imports_insert ON public.supply_registry_imports FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.osp_can('rates_registry', 'edit')));
DROP POLICY IF EXISTS supply_registry_imports_delete ON public.supply_registry_imports;
CREATE POLICY supply_registry_imports_delete ON public.supply_registry_imports FOR DELETE TO authenticated
  USING ((SELECT public.osp_can('rates_registry', 'edit')));

DROP POLICY IF EXISTS supply_registry_rates_read ON public.supply_registry_rates;
CREATE POLICY supply_registry_rates_read ON public.supply_registry_rates FOR SELECT TO authenticated
  USING ((SELECT public.osp_registry_reader()));
DROP POLICY IF EXISTS supply_registry_rates_insert ON public.supply_registry_rates;
CREATE POLICY supply_registry_rates_insert ON public.supply_registry_rates FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.osp_can('rates_registry', 'edit')));

-- Вставка — только через supply_registry_import() (права вызывающего: ей нужен INSERT, правила по строкам — свои).
REVOKE ALL ON TABLE public.supply_registry_imports FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.supply_registry_rates FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.supply_registry_imports TO authenticated;
GRANT SELECT, INSERT ON TABLE public.supply_registry_rates TO authenticated;
GRANT ALL ON TABLE public.supply_registry_imports TO service_role;
GRANT ALL ON TABLE public.supply_registry_rates TO service_role;
REVOKE ALL ON FUNCTION public.supply_registry_imports_stamp() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_registry_rates_stamp() FROM PUBLIC, anon;

-- ── 4. Загрузка порцией ──────────────────────────────────────────────────────────────────────────────
-- p_import — начатая загрузка (следующая порция того же файла) или NULL (новая: p_file_name, p_options). p_rows — массив
-- { source_name, item_name, unit, price, object_id, object_label, tender_id, tender_label, rate_date, row_no }.
-- Ответ: загрузка, сколько строк добавлено, сколько пропущено (такая расценка уже есть). Ошибка в любой строке —
-- порция не записывается целиком.
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
COMMENT ON FUNCTION public.supply_registry_import(uuid, text, jsonb, jsonb) IS
  'Загрузка расценок из Excel в реестр СУ-10 порцией до 1000 строк; такая же расценка пропускается; права вызывающего';
REVOKE ALL ON FUNCTION public.supply_registry_import(uuid, text, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supply_registry_import(uuid, text, jsonb, jsonb) TO authenticated, service_role;

-- ── 5. Представления реестра: материализованное + загруженные строки, только читателю реестра ─────
-- Представления — с правами владельца (как прежде), условие «читатель реестра» — над объединением. Дата — полночь
-- дня расценки по Москве, как у материализованного; объект и тендер не распознаны — как в файле.
CREATE OR REPLACE VIEW public.supply_rates_registry AS
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
CREATE OR REPLACE VIEW public.supply_rates_registry_filter_objects AS
 SELECT DISTINCT x.object_id, x.object_name
   FROM (SELECT r.object_id, r.object_name FROM public.supply_rates_registry_mv r
         UNION SELECT m.object_id, o.name FROM public.supply_registry_rates m JOIN public.objects o ON o.id = m.object_id) x
  WHERE x.object_id IS NOT NULL AND (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.supply_rates_registry_filter_tenders AS
 SELECT DISTINCT x.tender_id, x.tender_desc, x.object_id
   FROM (SELECT r.tender_id, r.tender_desc, r.object_id FROM public.supply_rates_registry_mv r
         UNION SELECT m.tender_id, t.work_description, m.object_id FROM public.supply_registry_rates m
               JOIN public.tenders t ON t.id = m.tender_id) x
  WHERE x.tender_id IS NOT NULL AND coalesce(x.tender_desc, '') <> '' AND (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.supply_rates_registry_units AS
 SELECT DISTINCT x.unit
   FROM (SELECT r.unit FROM public.supply_rates_registry_mv r
         UNION SELECT m.unit::text FROM public.supply_registry_rates m) x
  WHERE x.unit IS NOT NULL AND x.unit <> '' AND (SELECT public.osp_registry_reader());
COMMENT ON VIEW public.supply_rates_registry IS
  'Реестр «Расценки от снабжения СУ-10»: цены снабжения из тендеров (материализованное) и загруженные из Excel (supply_registry_rates), — читателю реестра';

COMMIT;
