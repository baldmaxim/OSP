-- Реестр расценок → «Расценки от снабжения СУ-10»: подробности загруженной расценки, колонка «Документ» и поиск по индексу
-- (просьба пользователя 23.11.2026).
--  • Файл из папок счетов: к прежним колонкам — «Подрядчик по папке», «№ документа из имени файла», «№ заявки / заказа»,
--    «Файл-источник» (contractor_label, doc_number, order_number, source_file) и ссылка на счёт (invoice_url, только
--    http/https; пока задаётся колонкой файла «Ссылка на счёт», привязка — следующим шагом). Видны по нажатию на строку
--    реестра; ссылка — значком колонки «Документ». Распознавание колонок — в браузере (src/utils/supplyRegistryImport.js).
--  • Скорость. С 20270224 загруженные строки читались представлениями через функцию с отметкой пропуска, и каждый запрос
--    вкладки (страница, поиск, подсчёт) перебирал их все без индекса: на 50 тыс. строк — 0,10–0,13 с на запрос, дальше
--    линейно. Таблица с правилами по строкам поиск подстрокой по индексу не пускает (ILIKE не leakproof, см. 20261021),
--    поэтому строки переезжают в закрытую схему — osp_private.supply_registry_rates, без правил, PostgREST её не видит, —
--    как договорные расценки Larix, и представления читают её напрямую: страница — 3 мс, поиск — 2–20 мс, подсчёт — 4 мс
--    (замер на копии прода с 50 тыс. загруженных строк).
--  • Названия объекта и тендера портала хранятся у строки (object_name, tender_desc): представление с правами владельца не
--    должно читать таблицы с правилами. Ставит их функция загрузки, переименовали объект или тендер — триггер (сразу, только
--    при настоящей смене названия). Объект или тендер удалили — у строки снова название из файла.
--  • Перенос строк — в этой же транзакции; до удаления прежней таблицы проверяется, что перенесены все её строки (иначе
--    отказ, ничего не меняется). Прежние id строк сохраняются, id в реестре (md5('import|' || id)) — тоже.
--  • Права прежние: читает читатель реестра (osp_registry_reader), загружает и удаляет загрузку право правки «Реестра
--    расценок»; строки напрямую — никому (функция загрузки; удаляются вместе с загрузкой).
-- Вариант для базы прежнего портала (Supabase) — supabase/migrations/20270227_supply_registry_rate_details.sql (там
-- представление и так читает таблицу по индексу: владелец представления правилами не ограничен). Нужна 20270224.
-- Повтор безопасен. Проверка — 20270227_supply_registry_rate_details.check.sql, откат —
-- migration/rollback/20270227_supply_registry_rate_details_rollback.sql.

-- ── 1. Строки загрузок — в закрытой схеме ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS osp_private.supply_registry_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reg_id text GENERATED ALWAYS AS (md5('import|' || id::text)) STORED,
  import_id uuid NOT NULL REFERENCES public.supply_registry_imports(id) ON DELETE CASCADE,
  source_name text NOT NULL CHECK (char_length(btrim(source_name)) BETWEEN 1 AND 200),
  item_name text NOT NULL CHECK (char_length(btrim(item_name)) BETWEEN 1 AND 1000),
  unit character varying(50),
  price numeric(15,2) NOT NULL CHECK (price > 0 AND price < 1e12),
  object_id uuid REFERENCES public.objects(id) ON DELETE SET NULL,
  object_label text CHECK (object_label IS NULL OR char_length(object_label) <= 255),
  object_name text,
  tender_id uuid REFERENCES public.tenders(id) ON DELETE SET NULL,
  tender_label text CHECK (tender_label IS NULL OR char_length(tender_label) <= 1000),
  tender_desc text,
  rate_date date NOT NULL,
  rate_at timestamptz GENERATED ALWAYS AS ((rate_date::timestamp AT TIME ZONE 'Europe/Moscow')) STORED,
  row_no integer CHECK (row_no IS NULL OR row_no > 0),
  contractor_label text CHECK (contractor_label IS NULL OR char_length(contractor_label) <= 500),
  doc_number text CHECK (doc_number IS NULL OR char_length(doc_number) <= 200),
  order_number text CHECK (order_number IS NULL OR char_length(order_number) <= 200),
  source_file text CHECK (source_file IS NULL OR char_length(source_file) <= 2000),
  invoice_url text CHECK (invoice_url IS NULL OR (char_length(invoice_url) <= 2000 AND invoice_url ~* '^https?://\S+$')),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE osp_private.supply_registry_rates IS
  'Расценки, загруженные из Excel в реестр «Расценки от снабжения СУ-10» (загрузка — public.supply_registry_imports); читаются через public.supply_rates_registry';
COMMENT ON COLUMN osp_private.supply_registry_rates.reg_id IS 'id строки в реестре (public.supply_rates_registry.id)';
COMMENT ON COLUMN osp_private.supply_registry_rates.object_label IS 'Объект как написан в файле (объект портала — object_id, если распознан)';
COMMENT ON COLUMN osp_private.supply_registry_rates.object_name IS 'Название объекта портала (ставит загрузка, обновляет триггер переименования объекта)';
COMMENT ON COLUMN osp_private.supply_registry_rates.tender_label IS 'Тендер как написан в файле (тендер портала — tender_id, если найден однозначно)';
COMMENT ON COLUMN osp_private.supply_registry_rates.tender_desc IS 'Описание работ тендера портала (ставит загрузка, обновляет триггер смены описания)';
COMMENT ON COLUMN osp_private.supply_registry_rates.rate_at IS 'Полночь дня расценки по Москве — дата расценки в реестре';
COMMENT ON COLUMN osp_private.supply_registry_rates.row_no IS 'Строка файла';
COMMENT ON COLUMN osp_private.supply_registry_rates.contractor_label IS 'Подрядчик по папке (колонка файла)';
COMMENT ON COLUMN osp_private.supply_registry_rates.doc_number IS '№ документа из имени файла (колонка файла)';
COMMENT ON COLUMN osp_private.supply_registry_rates.order_number IS '№ заявки / заказа (колонка файла)';
COMMENT ON COLUMN osp_private.supply_registry_rates.source_file IS 'Файл-источник (колонка файла: путь или имя файла счёта)';
COMMENT ON COLUMN osp_private.supply_registry_rates.invoice_url IS 'Ссылка на счёт (http/https)';

CREATE UNIQUE INDEX IF NOT EXISTS supply_registry_rates_reg_id ON osp_private.supply_registry_rates (reg_id);
CREATE INDEX IF NOT EXISTS supply_registry_rates_name_idx ON osp_private.supply_registry_rates (item_name, reg_id);
CREATE INDEX IF NOT EXISTS supply_registry_rates_name_trgm ON osp_private.supply_registry_rates USING gin (item_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS supply_registry_rates_date_idx ON osp_private.supply_registry_rates (rate_at);
CREATE INDEX IF NOT EXISTS supply_registry_rates_price_idx ON osp_private.supply_registry_rates (price);
CREATE INDEX IF NOT EXISTS supply_registry_rates_import_idx ON osp_private.supply_registry_rates (import_id);
CREATE INDEX IF NOT EXISTS supply_registry_rates_object_idx ON osp_private.supply_registry_rates (object_id) WHERE object_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS supply_registry_rates_tender_idx ON osp_private.supply_registry_rates (tender_id) WHERE tender_id IS NOT NULL;
-- Одна расценка — один раз (как в 20270224): тот же файл второй раз и выгрузка реестра обратно строк не добавляют.
CREATE UNIQUE INDEX IF NOT EXISTS supply_registry_rates_uniq ON osp_private.supply_registry_rates
  (public.kp_norm_name(item_name), public.kp_norm_unit(unit), price, rate_date,
   coalesce(object_id::text, lower(btrim(coalesce(object_label, '')))), lower(btrim(source_name)));

-- ── 2. Перенос строк из public.supply_registry_rates (20270224) ──────────────────────────────────────
-- До триггера: время загрузки строки — прежнее. Названия объекта и тендера — сразу (миграция идёт с пропуском).
DO $$
DECLARE
  v_old bigint;
  v_moved bigint;
BEGIN
  IF to_regclass('public.supply_registry_rates') IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO osp_private.supply_registry_rates (id, import_id, source_name, item_name, unit, price, object_id, object_label,
                                                 object_name, tender_id, tender_label, tender_desc, rate_date, row_no, created_at)
  SELECT m.id, m.import_id, m.source_name, m.item_name, m.unit, m.price, m.object_id, m.object_label, o.name,
         m.tender_id, m.tender_label, t.work_description, m.rate_date, m.row_no, m.created_at
  FROM public.supply_registry_rates m
  LEFT JOIN public.objects o ON o.id = m.object_id
  LEFT JOIN public.tenders t ON t.id = m.tender_id
  ON CONFLICT (id) DO NOTHING;
  SELECT count(*) INTO v_old FROM public.supply_registry_rates;
  SELECT count(*) INTO v_moved FROM public.supply_registry_rates m
  WHERE EXISTS (SELECT 1 FROM osp_private.supply_registry_rates n
                WHERE n.id = m.id AND n.import_id = m.import_id AND n.item_name = m.item_name AND n.price = m.price
                  AND n.rate_date = m.rate_date);
  IF v_moved <> v_old THEN
    RAISE EXCEPTION 'Перенесено % из % загруженных расценок — прежняя таблица не удаляется', v_moved, v_old;
  END IF;
END
$$;

-- Очистка полей строки при записи; кто и когда — сервер (created_at не задаётся снаружи).
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
DROP TRIGGER IF EXISTS supply_registry_rates_stamp ON osp_private.supply_registry_rates;
CREATE TRIGGER supply_registry_rates_stamp
  BEFORE INSERT ON osp_private.supply_registry_rates
  FOR EACH ROW EXECUTE FUNCTION public.supply_registry_rates_stamp();

-- ── 3. Представления реестра: материализованное + загруженные строки напрямую, только читателю реестра ──
-- Прежние колонки — на своих местах и тех же типов, новые — в конце (у цен из тендеров — пусто).
CREATE OR REPLACE VIEW public.supply_rates_registry AS
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
COMMENT ON VIEW public.supply_rates_registry IS
  'Реестр «Расценки от снабжения СУ-10»: цены снабжения из тендеров (материализованное) и загруженные из Excel (osp_private.supply_registry_rates), — читателю реестра';

-- ── 4. Прежнее чтение через функцию и прежняя таблица — прочь ────────────────────────────────────────
DROP FUNCTION IF EXISTS osp_private.view_supply_registry_rates();
DELETE FROM osp_meta.policy_roles WHERE schema_name = 'public' AND table_name = 'supply_registry_rates';
-- Без CASCADE: если на таблицу ещё что-то опирается, миграция упадёт и откатится целиком.
DROP TABLE IF EXISTS public.supply_registry_rates;
-- osp:allow table supply_registry_rates none

-- ── 5. Загрузка порцией: новые поля и названия объекта и тендера ─────────────────────────────────────
-- Подпись прежняя: окно, открытое до выкладки, шлёт строки без новых полей — они пустые. p_rows — массив { source_name,
-- item_name, unit, price, object_id, object_label, tender_id, tender_label, rate_date, row_no, contractor_label,
-- doc_number, order_number, source_file, invoice_url }. Ссылка на счёт не http/https — не пишется (строка — пишется).
-- Права вызывающего: в начале — право правки реестра, загрузку заводят правила по строкам supply_registry_imports;
-- названия объекта и тендера — как их видит загружающий (сотрудник; объекты и тендеры видят все сотрудники).
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

  INSERT INTO osp_private.supply_registry_rates (import_id, source_name, item_name, unit, price, object_id, object_label,
                                                 object_name, tender_id, tender_label, tender_desc, rate_date, row_no,
                                                 contractor_label, doc_number, order_number, source_file, invoice_url)
  SELECT v_import, r.source_name, r.item_name, left(r.unit, 50), round(r.price, 2), r.object_id, left(r.object_label, 255),
         o.name, r.tender_id, left(r.tender_label, 1000), t.work_description, r.rate_date, r.row_no,
         left(r.contractor_label, 500), left(r.doc_number, 200), left(r.order_number, 200), left(r.source_file, 2000),
         CASE WHEN btrim(r.invoice_url) ~* '^https?://\S+$' AND char_length(btrim(r.invoice_url)) <= 2000
              THEN btrim(r.invoice_url) END
  FROM jsonb_to_recordset(p_rows) AS r(source_name text, item_name text, unit text, price numeric, object_id uuid,
                                       object_label text, tender_id uuid, tender_label text, rate_date date, row_no integer,
                                       contractor_label text, doc_number text, order_number text, source_file text,
                                       invoice_url text)
  LEFT JOIN public.objects o ON o.id = r.object_id
  LEFT JOIN public.tenders t ON t.id = r.tender_id
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;

  RETURN QUERY SELECT v_import, v_added, v_n - v_added;
END
$$;
COMMENT ON FUNCTION public.supply_registry_import(uuid, text, jsonb, jsonb) IS
  'Загрузка расценок из Excel в реестр СУ-10 порцией до 1000 строк; такая же расценка пропускается; права вызывающего';
-- osp:allow rpc supply_registry_import authenticated

-- ── 6. Переименовали объект или тендер — новое название и у загруженных строк ────────────────────────
-- Только при настоящей смене названия (WHEN), только строки с этим объектом или тендером (по индексу).
CREATE OR REPLACE FUNCTION public.supply_registry_rates_names() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'objects' THEN
    UPDATE osp_private.supply_registry_rates SET object_name = NEW.name
     WHERE object_id = NEW.id AND object_name IS DISTINCT FROM NEW.name;
  ELSE
    UPDATE osp_private.supply_registry_rates SET tender_desc = NEW.work_description
     WHERE tender_id = NEW.id AND tender_desc IS DISTINCT FROM NEW.work_description;
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS supply_registry_rates_object_name ON public.objects;
CREATE TRIGGER supply_registry_rates_object_name
  AFTER UPDATE OF name ON public.objects
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION public.supply_registry_rates_names();
DROP TRIGGER IF EXISTS supply_registry_rates_tender_desc ON public.tenders;
CREATE TRIGGER supply_registry_rates_tender_desc
  AFTER UPDATE OF work_description ON public.tenders
  FOR EACH ROW WHEN (OLD.work_description IS DISTINCT FROM NEW.work_description)
  EXECUTE FUNCTION public.supply_registry_rates_names();
