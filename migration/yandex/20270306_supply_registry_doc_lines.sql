-- Реестр расценок → «Расценки от снабжения СУ-10»: строки счетов и КП, загруженных в тендер (просьба пользователя 25.11.2026:
-- «подгрузил счета в 704 тендер в /tenders/materials, там не были найдены позиции, но я всё равно хочу, чтобы они заносились в
-- реестр … и документ чтобы этот отображался»; файл удалён из тендера — источник красный; статус «не применена в тендере»).
-- Только база Яндекса (прежний портал на Supabase только читается).
--  • Строки распознанного файла хранятся при нём — JSON в s3_documents.notes (src/utils/supplyOffers.js, doc_category supply_doc
--    основного тендера). Теперь каждая строка с ценой — ещё и строка реестра (источник «Счёт / КП», документ — сам файл), даже
--    если позиции ВОР для неё не нашлось. Снимок строк — osp_private.supply_doc_rates: строки переживают удаление файла
--    (doc_deleted_at — реестр показывает источник красным). Закрытая схема без правил, как загрузки из Excel (20270227):
--    представление реестра читает её по индексу.
--  • Строки берутся по тем же правилам, что readOffer в браузере (supplyOffers.js): документ kind = supply_offer, v = 1; строка —
--    наименование и цена > 0; у документа из двух частей (часть цен «с НДС» колонкой, часть — нет) цена строки с НДС колонкой
--    возвращается к цене по колонке (priceByColumn: тендер № 704, «…_MLN.pdf» — иначе +22 %); цены не в рублях (currency) — не
--    в реестр. Совпадение с браузером сторожит tests/supply/registry-doc-lines-db.test.mjs (те же строки, те же цены).
--  • Обновляются сами: загрузили файл, перечитали, поменяли выбор в окне «Счета и КП» (notes), переименовали — триггер на
--    s3_documents пересобирает строки файла (ключ — файл и номер строки, id в реестре не меняется); удалили файл или он перестал
--    быть счётом тендера — строки остаются с отметкой «файл удалён». Сбой разбора не мешает работе с файлом: триггер ловит
--    ошибку и пишет предупреждение (загрузка, сохранение выбора и удаление файла проходят всегда).
--  • Дата расценки — дата документа из файла (не позже дня загрузки: «03.10.54» у спецификаций — не дата), иначе день загрузки.
--  • Один и тот же файл, загруженный дважды, и одна и та же строка в разных файлах тендера (то же наименование и ед. изм. после
--    kp_norm_name / kp_norm_unit, та же цена) — в реестре один раз: строка файла, который есть, иначе — загруженного раньше.
--  • «Применена в тендере» — функция supply_doc_rates_status (для показанных строк и окна «Расценка»): цена позиции тендера, у
--    которой этот файл — документ (или был им до удаления, след 20270223), своя (не копия и не из Excel) и совпала с ценой строки
--    — как есть, с другим НДС или на единицу упаковки; то же правило, что offerOfPrice в окне «Счета и КП». Пересчитывается при
--    каждом чтении: триггеров на ценах и документах позиций нет.
--  • Объект и описание тендера хранятся у строки (представление с правами владельца таблицы с правилами не читает) — ставит
--    разбор, меняются вместе с тендером и объектом (триггеры).
--  • Права: строки — читателю реестра (osp_registry_reader) через представление; статус — ему же; писать строки напрямую некому.
-- Нужны 20270223 и 20270227. Повтор безопасен. Проверка — 20270306_supply_registry_doc_lines.check.sql, откат —
-- migration/rollback/20270306_supply_registry_doc_lines_rollback.sql (откатывать 20270227 или 20270224 — только после него).

-- ── 1. Строки счетов и КП тендеров ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS osp_private.supply_doc_rates (
  doc_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  reg_id text GENERATED ALWAYS AS (md5('doc|' || doc_id::text || '|' || line_no::text)) STORED,
  tender_id uuid NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
  object_id uuid REFERENCES public.objects(id) ON DELETE SET NULL,
  object_name text,
  tender_desc text,
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 500),
  item_name text NOT NULL CHECK (char_length(item_name) BETWEEN 1 AND 1000),
  unit text CHECK (unit IS NULL OR char_length(unit) <= 50),
  price numeric(15,2) NOT NULL CHECK (price > 0 AND price < 1e12),
  qty numeric,
  code text,
  unsure boolean NOT NULL DEFAULT false,
  norm_key text NOT NULL,
  vat_k numeric NOT NULL,
  pack_qty numeric,
  packs jsonb,
  doc_date date,
  rate_date date NOT NULL,
  rate_at timestamptz GENERATED ALWAYS AS ((rate_date::timestamp AT TIME ZONE 'Europe/Moscow')) STORED,
  doc_created_at timestamptz NOT NULL,
  doc_deleted_at timestamptz,
  doc_deleted_by uuid,
  PRIMARY KEY (doc_id, line_no)
);
COMMENT ON TABLE osp_private.supply_doc_rates IS
  'Строки счетов и КП, загруженных в тендер (s3_documents supply_doc, notes) — строки реестра «Расценки от снабжения СУ-10»; переживают удаление файла';
COMMENT ON COLUMN osp_private.supply_doc_rates.doc_id IS 'Файл s3_documents (без внешнего ключа: строки остаются после удаления файла)';
COMMENT ON COLUMN osp_private.supply_doc_rates.line_no IS 'Номер строки в notes файла (с 1) — вместе с файлом даёт id строки в реестре';
COMMENT ON COLUMN osp_private.supply_doc_rates.reg_id IS 'id строки в реестре (public.supply_rates_registry.id)';
COMMENT ON COLUMN osp_private.supply_doc_rates.norm_key IS 'md5(kp_norm_name(наименование) | kp_norm_unit(ед. изм.)) — одна и та же строка в разных файлах тендера';
COMMENT ON COLUMN osp_private.supply_doc_rates.vat_k IS 'Множитель НДС документа (1 + ставка / 100) — цена «с другим НДС» в статусе «применена»';
COMMENT ON COLUMN osp_private.supply_doc_rates.pack_qty IS 'Сколько в упаковке (pq строки) — цена за единицу упаковки в статусе «применена»';
COMMENT ON COLUMN osp_private.supply_doc_rates.packs IS 'Пересчёт упаковок, указанный человеком (pm строки: позиция → число)';
COMMENT ON COLUMN osp_private.supply_doc_rates.unsure IS 'Строка со скана, цифры которой не сошлись между собой (un) — сверить с файлом';
COMMENT ON COLUMN osp_private.supply_doc_rates.doc_date IS 'Дата документа из файла (notes.date)';
COMMENT ON COLUMN osp_private.supply_doc_rates.rate_at IS 'Полночь дня расценки по Москве — дата расценки в реестре';
COMMENT ON COLUMN osp_private.supply_doc_rates.doc_deleted_at IS 'Файл удалён из тендера (или перестал быть его счётом / КП) — источник в реестре красный';

CREATE UNIQUE INDEX IF NOT EXISTS supply_doc_rates_reg_id ON osp_private.supply_doc_rates (reg_id);
CREATE INDEX IF NOT EXISTS supply_doc_rates_name_idx ON osp_private.supply_doc_rates (item_name, reg_id);
CREATE INDEX IF NOT EXISTS supply_doc_rates_name_trgm ON osp_private.supply_doc_rates USING gin (item_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS supply_doc_rates_date_idx ON osp_private.supply_doc_rates (rate_at);
CREATE INDEX IF NOT EXISTS supply_doc_rates_price_idx ON osp_private.supply_doc_rates (price);
CREATE INDEX IF NOT EXISTS supply_doc_rates_same_idx ON osp_private.supply_doc_rates (tender_id, norm_key, price);
CREATE INDEX IF NOT EXISTS supply_doc_rates_object_idx ON osp_private.supply_doc_rates (object_id) WHERE object_id IS NOT NULL;

-- ── 2. Разбор notes файла — как readOffer (src/utils/supplyOffers.js) ────────────────────────────────
-- Число JSON — num(): число или строка-число; иначе NULL.
CREATE OR REPLACE FUNCTION osp_private.supply_offer_num(p jsonb) RETURNS numeric
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE jsonb_typeof(p)
           WHEN 'number' THEN (p #>> '{}')::numeric
           WHEN 'string' THEN CASE WHEN btrim(p #>> '{}') ~ '^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][-+]?[0-9]{1,3})?$'
                                   THEN btrim(p #>> '{}')::numeric END
         END
$$;

-- Текст — text(): пробелы схлопываются, края обрезаются, не длиннее p_max; пусто — NULL.
CREATE OR REPLACE FUNCTION osp_private.supply_offer_text(p text, p_max integer) RETURNS text
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT nullif(left(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')), p_max), '')
$$;

-- notes → jsonb; не JSON или не документ поставщика — NULL (без ошибки).
CREATE OR REPLACE FUNCTION osp_private.supply_offer_json(p text) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  IF p IS NULL OR strpos(p, 'supply_offer') = 0 THEN
    RETURN NULL;
  END IF;
  RETURN p::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;

-- Дата документа 'ГГГГ-ММ-ДД' (notes.date); не дата (2026-02-30, год 0) — NULL.
CREATE OR REPLACE FUNCTION osp_private.supply_offer_date(p text) RETURNS date
  LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  IF p IS NULL OR p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RETURN NULL;
  END IF;
  RETURN make_date(substr(p, 1, 4)::int, substr(p, 6, 2)::int, substr(p, 9, 2)::int);
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;

-- Строки документа с ценой: номер строки в notes (с 1), наименование, ед. изм., количество, артикул, цена в расценку (у документа
-- из двух частей — по колонке НДС, priceByColumn), «со скана, сверить», упаковка и пересчёт. Документ не тот (kind, v), цены не в
-- рублях (currency) — строк нет.
CREATE OR REPLACE FUNCTION osp_private.supply_offer_lines(p_notes jsonb)
  RETURNS TABLE (line_no integer, item_name text, unit text, qty numeric, code text, price numeric, unsure boolean,
                 pack_qty numeric, packs jsonb)
  LANGUAGE sql IMMUTABLE
AS $$
  WITH o AS (
    SELECT p_notes AS j,
           1 + coalesce(osp_private.supply_offer_num(p_notes -> 'vat' -> 'rate'), 22) / 100 AS k,
           coalesce(nullif(osp_private.supply_offer_num(p_notes -> 'delivery'), 0), 1) AS delivery
    WHERE jsonb_typeof(p_notes) = 'object' AND p_notes ->> 'kind' = 'supply_offer' AND p_notes -> 'v' = '1'::jsonb
      AND jsonb_typeof(p_notes -> 'lines') = 'array'
      -- currency: o.currency || null — «не в рублях» только непустое значение.
      AND (p_notes -> 'currency' IS NULL OR p_notes -> 'currency' IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb))
  ), l AS (
    SELECT e.r, e.n::integer AS line_no, o.k, o.delivery
    FROM o CROSS JOIN LATERAL jsonb_array_elements(o.j -> 'lines') WITH ORDINALITY AS e(r, n)
  ), m AS (
    -- Есть строка без НДС колонкой (как `r && r.dv !== 'gross' && r.dv !== 'net'`).
    SELECT EXISTS (SELECT 1 FROM l WHERE l.r NOT IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)
                                     AND coalesce(l.r ->> 'dv', '') NOT IN ('gross', 'net')) AS mixed
  ), x AS (
    SELECT l.line_no, l.k, l.delivery, l.r,
           osp_private.supply_offer_text(l.r ->> 'n', 250) AS item_name,
           osp_private.supply_offer_num(l.r -> 'p') AS p,
           osp_private.supply_offer_num(l.r -> 'd') AS d,
           l.r ->> 'dv' AS dv
    FROM l
    WHERE jsonb_typeof(l.r) = 'object'
  )
  SELECT x.line_no, x.item_name,
         osp_private.supply_offer_text(x.r ->> 'u', 40),
         osp_private.supply_offer_num(x.r -> 'q'),
         osp_private.supply_offer_text(x.r ->> 'c', 80),
         CASE WHEN m.mixed AND x.d > 0 AND x.dv IN ('gross', 'net') THEN
                (SELECT CASE WHEN abs(x.p - e.v * x.k) <= greatest(0.011, e.v * x.k * 0.001)
                               OR abs(x.p - e.v / x.k) <= greatest(0.011, e.v / x.k * 0.001)
                             THEN e.v ELSE x.p END
                 FROM (SELECT round(x.d * CASE WHEN x.dv = 'net' THEN x.k ELSE 1 END * x.delivery, 2) AS v) e)
              ELSE x.p END,
         coalesce(x.r -> 'un' = '1'::jsonb, false),
         osp_private.supply_offer_num(x.r -> 'pq'),
         CASE WHEN jsonb_typeof(x.r -> 'pm') = 'object' THEN x.r -> 'pm' END
  FROM x CROSS JOIN m
  WHERE x.item_name IS NOT NULL AND x.p > 0 AND x.k > 0
$$;

-- ── 3. Строки файла → реестр ─────────────────────────────────────────────────────────────────────────
-- Файл — счёт / КП тендера: строки = строки notes (новые добавляются, изменённые обновляются, исчезнувшие удаляются), отметка
-- «удалён» снимается. Файла нет или он больше не счёт тендера — строки остаются, отмечены удалёнными. С пропуском: читает файл,
-- тендер и объект при любом входе (триггер, заполнение при миграции). Ответ — сколько строк добавлено или изменено.
CREATE OR REPLACE FUNCTION osp_private.supply_doc_rates_sync(p_doc uuid) RETURNS integer
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v record;
  v_j jsonb;
  v_day date;
  v_doc_date date;
  v_k numeric;
  v_n integer;
BEGIN
  SELECT d.id, d.owner_id, d.file_name, d.notes, d.created_at, t.object_id, t.work_description, ob.name AS object_name
    INTO v
    FROM public.s3_documents d
    JOIN public.tenders t ON t.id = d.owner_id
    LEFT JOIN public.objects ob ON ob.id = t.object_id
   WHERE d.id = p_doc AND d.doc_category = 'supply_doc' AND d.owner_type = 'tender';
  IF NOT FOUND THEN
    UPDATE osp_private.supply_doc_rates SET doc_deleted_at = now(), doc_deleted_by = auth.uid()
     WHERE doc_id = p_doc AND doc_deleted_at IS NULL;
    RETURN 0;
  END IF;

  v_j := osp_private.supply_offer_json(v.notes);
  v_day := (coalesce(v.created_at, now()) AT TIME ZONE 'Europe/Moscow')::date;
  v_doc_date := osp_private.supply_offer_date(v_j ->> 'date');
  v_k := 1 + coalesce(osp_private.supply_offer_num(v_j -> 'vat' -> 'rate'), 22) / 100;

  WITH src AS MATERIALIZED (
    SELECT s.* FROM osp_private.supply_offer_lines(v_j) s WHERE round(s.price, 2) > 0 AND s.price < 1e12
  ), up AS (
    INSERT INTO osp_private.supply_doc_rates AS r
      (doc_id, line_no, tender_id, object_id, object_name, tender_desc, file_name, item_name, unit, price, qty, code, unsure,
       norm_key, vat_k, pack_qty, packs, doc_date, rate_date, doc_created_at, doc_deleted_at, doc_deleted_by)
    SELECT p_doc, s.line_no, v.owner_id, v.object_id, v.object_name, v.work_description,
           left(coalesce(nullif(btrim(v.file_name), ''), 'Файл без имени'), 500), s.item_name, s.unit, round(s.price, 2), s.qty,
           s.code, s.unsure, md5(public.kp_norm_name(s.item_name) || '|' || coalesce(public.kp_norm_unit(s.unit), '')),
           v_k, s.pack_qty, s.packs, v_doc_date,
           CASE WHEN v_doc_date BETWEEN date '2000-01-01' AND v_day THEN v_doc_date ELSE v_day END,
           coalesce(v.created_at, now()), NULL, NULL
    FROM src s
    ON CONFLICT (doc_id, line_no) DO UPDATE SET
      tender_id = EXCLUDED.tender_id, object_id = EXCLUDED.object_id, object_name = EXCLUDED.object_name,
      tender_desc = EXCLUDED.tender_desc, file_name = EXCLUDED.file_name, item_name = EXCLUDED.item_name, unit = EXCLUDED.unit,
      price = EXCLUDED.price, qty = EXCLUDED.qty, code = EXCLUDED.code, unsure = EXCLUDED.unsure, norm_key = EXCLUDED.norm_key,
      vat_k = EXCLUDED.vat_k, pack_qty = EXCLUDED.pack_qty, packs = EXCLUDED.packs, doc_date = EXCLUDED.doc_date,
      rate_date = EXCLUDED.rate_date, doc_created_at = EXCLUDED.doc_created_at, doc_deleted_at = NULL, doc_deleted_by = NULL
    WHERE (r.tender_id, r.object_id, r.object_name, r.tender_desc, r.file_name, r.item_name, r.unit, r.price, r.qty, r.code,
           r.unsure, r.norm_key, r.vat_k, r.pack_qty, r.packs, r.doc_date, r.rate_date, r.doc_created_at, r.doc_deleted_at)
          IS DISTINCT FROM
          (EXCLUDED.tender_id, EXCLUDED.object_id, EXCLUDED.object_name, EXCLUDED.tender_desc, EXCLUDED.file_name,
           EXCLUDED.item_name, EXCLUDED.unit, EXCLUDED.price, EXCLUDED.qty, EXCLUDED.code, EXCLUDED.unsure, EXCLUDED.norm_key,
           EXCLUDED.vat_k, EXCLUDED.pack_qty, EXCLUDED.packs, EXCLUDED.doc_date, EXCLUDED.rate_date, EXCLUDED.doc_created_at,
           EXCLUDED.doc_deleted_at)
    RETURNING 1
  ), gone AS (
    DELETE FROM osp_private.supply_doc_rates r
     WHERE r.doc_id = p_doc AND NOT EXISTS (SELECT 1 FROM src s WHERE s.line_no = r.line_no)
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM up) + (SELECT count(*) FROM gone) INTO v_n;
  RETURN v_n;
END
$$;
COMMENT ON FUNCTION osp_private.supply_doc_rates_sync(uuid) IS
  'Строки счёта / КП тендера (notes файла) → osp_private.supply_doc_rates; файла нет — строки отмечаются удалёнными';

-- ── 4. Файл загрузили, перечитали, переименовали, удалили — строки следом ────────────────────────────
-- Ошибка здесь не должна мешать работе с файлом: перехватывается, остаётся предупреждением в журнале базы.
CREATE OR REPLACE FUNCTION osp_private.supply_doc_rates_on_doc() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      UPDATE osp_private.supply_doc_rates SET doc_deleted_at = now(), doc_deleted_by = auth.uid()
       WHERE doc_id = OLD.id AND doc_deleted_at IS NULL;
    ELSE
      PERFORM osp_private.supply_doc_rates_sync(NEW.id);
    END IF;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'Реестр СУ-10: строки файла % не обновлены: % (%)',
      CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS s3_documents_supply_doc_rates_ins ON public.s3_documents;
CREATE TRIGGER s3_documents_supply_doc_rates_ins
  AFTER INSERT ON public.s3_documents
  FOR EACH ROW WHEN (NEW.doc_category = 'supply_doc' AND NEW.owner_type = 'tender')
  EXECUTE FUNCTION osp_private.supply_doc_rates_on_doc();
DROP TRIGGER IF EXISTS s3_documents_supply_doc_rates_upd ON public.s3_documents;
CREATE TRIGGER s3_documents_supply_doc_rates_upd
  AFTER UPDATE OF notes, file_name, doc_category, owner_type, owner_id ON public.s3_documents
  FOR EACH ROW WHEN ((NEW.doc_category = 'supply_doc' OR OLD.doc_category = 'supply_doc')
                     AND (NEW.notes IS DISTINCT FROM OLD.notes OR NEW.file_name IS DISTINCT FROM OLD.file_name
                          OR NEW.doc_category IS DISTINCT FROM OLD.doc_category OR NEW.owner_type IS DISTINCT FROM OLD.owner_type
                          OR NEW.owner_id IS DISTINCT FROM OLD.owner_id))
  EXECUTE FUNCTION osp_private.supply_doc_rates_on_doc();
DROP TRIGGER IF EXISTS s3_documents_supply_doc_rates_del ON public.s3_documents;
CREATE TRIGGER s3_documents_supply_doc_rates_del
  AFTER DELETE ON public.s3_documents
  FOR EACH ROW WHEN (OLD.doc_category = 'supply_doc')
  EXECUTE FUNCTION osp_private.supply_doc_rates_on_doc();

-- ── 5. Переименовали объект, сменили описание или объект тендера — у строк тоже ──────────────────────
CREATE OR REPLACE FUNCTION osp_private.supply_doc_rates_names() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  BEGIN
    IF TG_TABLE_NAME = 'objects' THEN
      UPDATE osp_private.supply_doc_rates SET object_name = NEW.name
       WHERE object_id = NEW.id AND object_name IS DISTINCT FROM NEW.name;
    ELSE
      UPDATE osp_private.supply_doc_rates r
         SET tender_desc = NEW.work_description, object_id = NEW.object_id,
             object_name = (SELECT ob.name FROM public.objects ob WHERE ob.id = NEW.object_id)
       WHERE r.tender_id = NEW.id;
    END IF;
  EXCEPTION WHEN others THEN
    RAISE WARNING 'Реестр СУ-10: названия у строк счетов не обновлены: % (%)', SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS supply_doc_rates_object_name ON public.objects;
CREATE TRIGGER supply_doc_rates_object_name
  AFTER UPDATE OF name ON public.objects
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION osp_private.supply_doc_rates_names();
DROP TRIGGER IF EXISTS supply_doc_rates_tender ON public.tenders;
CREATE TRIGGER supply_doc_rates_tender
  AFTER UPDATE OF work_description, object_id ON public.tenders
  FOR EACH ROW WHEN (OLD.work_description IS DISTINCT FROM NEW.work_description OR OLD.object_id IS DISTINCT FROM NEW.object_id)
  EXECUTE FUNCTION osp_private.supply_doc_rates_names();

-- ── 6. Уже загруженные счета и КП — в реестр сейчас (миграция идёт с пропуском) ──────────────────────
-- Строки, чьих файлов больше нет (повтор после отката), — отмечаются удалёнными. Файл, который не разобрался, — предупреждение
-- здесь и FAIL в .check.sql (у каждого файла со строками — строки в реестре): миграция откатится целиком.
DO $$
DECLARE
  d record;
BEGIN
  FOR d IN SELECT s.id FROM public.s3_documents s
           WHERE s.doc_category = 'supply_doc' AND s.owner_type = 'tender' AND strpos(coalesce(s.notes, ''), 'supply_offer') > 0
           ORDER BY s.created_at, s.id
  LOOP
    BEGIN
      PERFORM osp_private.supply_doc_rates_sync(d.id);
    EXCEPTION WHEN others THEN
      RAISE WARNING 'Реестр СУ-10: строки файла % не разобраны: % (%)', d.id, SQLERRM, SQLSTATE;
    END;
  END LOOP;
  UPDATE osp_private.supply_doc_rates r SET doc_deleted_at = now()
   WHERE r.doc_deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.s3_documents s
                     WHERE s.id = r.doc_id AND s.doc_category = 'supply_doc' AND s.owner_type = 'tender');
END
$$;

-- ── 7. Представления реестра: третья ветка — строки счетов; новые колонки — в конце ──────────────────
-- doc_id — файл строки (у прочих — пусто), doc_deleted_at — файл удалён из тендера. Одна и та же строка (тендер, наименование и
-- ед. изм. по kp_norm_*, цена) — один раз: у файла, который есть, иначе — у загруженного раньше.
CREATE OR REPLACE VIEW public.supply_rates_registry AS
 SELECT u.id, u.source_type, u.source_name, u.item_name, u.unit, u.price, u.tender_id, u.object_id, u.tender_desc,
        u.object_name, u.rate_date, u.import_id, u.contractor_label, u.doc_number, u.order_number, u.source_file,
        u.invoice_url, u.object_label, u.tender_label, u.row_no, u.doc_id, u.doc_deleted_at
   FROM (SELECT r.id, r.source_type, r.source_name, r.item_name, r.unit, r.price, r.tender_id, r.object_id, r.tender_desc,
                r.object_name, r.rate_date, NULL::uuid AS import_id, NULL::text AS contractor_label, NULL::text AS doc_number,
                NULL::text AS order_number, NULL::text AS source_file, NULL::text AS invoice_url, NULL::text AS object_label,
                NULL::text AS tender_label, NULL::integer AS row_no, NULL::uuid AS doc_id, NULL::timestamptz AS doc_deleted_at
           FROM osp_private.supply_rates_registry_mv r
         UNION ALL
         SELECT m.reg_id, 'supply_import'::text, m.source_name, m.item_name, m.unit::text, m.price, m.tender_id, m.object_id,
                CASE WHEN m.tender_id IS NULL THEN m.tender_label ELSE coalesce(m.tender_desc, m.tender_label) END,
                (CASE WHEN m.object_id IS NULL THEN left(m.object_label, 255)
                      ELSE coalesce(m.object_name, left(m.object_label, 255)) END)::character varying(255),
                m.rate_at, m.import_id, m.contractor_label, m.doc_number, m.order_number, m.source_file, m.invoice_url,
                m.object_label, m.tender_label, m.row_no, NULL::uuid, NULL::timestamptz
           FROM osp_private.supply_registry_rates m
         UNION ALL
         SELECT d.reg_id, 'supply_doc'::text, 'Счёт / КП'::text, d.item_name, d.unit, d.price::numeric(15,2), d.tender_id,
                d.object_id, d.tender_desc,
                (CASE WHEN d.object_id IS NULL THEN NULL ELSE left(d.object_name, 255) END)::character varying(255),
                d.rate_at, NULL::uuid, NULL::text, NULL::text, NULL::text, d.file_name, NULL::text, NULL::text, NULL::text,
                NULL::integer, d.doc_id, d.doc_deleted_at
           FROM osp_private.supply_doc_rates d
          WHERE NOT EXISTS (SELECT 1 FROM osp_private.supply_doc_rates o
                            WHERE o.tender_id = d.tender_id AND o.norm_key = d.norm_key AND o.price = d.price
                              AND (o.doc_deleted_at IS NOT NULL, o.doc_created_at, o.doc_id, o.line_no)
                                < (d.doc_deleted_at IS NOT NULL, d.doc_created_at, d.doc_id, d.line_no))) u
  WHERE (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.supply_rates_registry_filter_objects AS
 SELECT DISTINCT x.object_id, x.object_name
   FROM (SELECT r.object_id, r.object_name FROM osp_private.supply_rates_registry_mv r
         UNION SELECT m.object_id, coalesce(m.object_name, left(m.object_label, 255))::character varying(255)
                 FROM osp_private.supply_registry_rates m WHERE m.object_id IS NOT NULL
         UNION SELECT d.object_id, left(d.object_name, 255)::character varying(255)
                 FROM osp_private.supply_doc_rates d WHERE d.object_id IS NOT NULL) x
  WHERE x.object_id IS NOT NULL AND (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.supply_rates_registry_filter_tenders AS
 SELECT DISTINCT x.tender_id, x.tender_desc, x.object_id
   FROM (SELECT r.tender_id, r.tender_desc, r.object_id FROM osp_private.supply_rates_registry_mv r
         UNION SELECT m.tender_id, coalesce(m.tender_desc, m.tender_label), m.object_id
                 FROM osp_private.supply_registry_rates m WHERE m.tender_id IS NOT NULL
         UNION SELECT d.tender_id, d.tender_desc, d.object_id FROM osp_private.supply_doc_rates d) x
  WHERE x.tender_id IS NOT NULL AND coalesce(x.tender_desc, '') <> '' AND (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.supply_rates_registry_units AS
 SELECT DISTINCT x.unit
   FROM (SELECT r.unit FROM osp_private.supply_rates_registry_mv r
         UNION SELECT m.unit::text FROM osp_private.supply_registry_rates m
         UNION SELECT d.unit FROM osp_private.supply_doc_rates d) x
  WHERE x.unit IS NOT NULL AND x.unit <> '' AND (SELECT public.osp_registry_reader());
COMMENT ON VIEW public.supply_rates_registry IS
  'Реестр «Расценки от снабжения СУ-10»: цены снабжения из тендеров (материализованное), загруженные из Excel и строки счетов и КП тендеров (osp_private), — читателю реестра';

-- ── 8. Статус «применена в тендере» — для показанных строк реестра ───────────────────────────────────
-- Цена позиции p_price — из строки с ценой p_line: как есть, с другим НДС (p_k), на единицу упаковки (pq) или по пересчёту,
-- указанному человеком (pm); с точностью до копейки (offerOfPrice / pricesOf в src/utils/supplyAutoPick.js).
CREATE OR REPLACE FUNCTION osp_private.supply_doc_price_hit(p_line numeric, p_k numeric, p_pack numeric, p_packs jsonb,
                                                           p_price numeric) RETURNS boolean
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT p_line > 0 AND p_price IS NOT NULL AND EXISTS (
    SELECT 1
    FROM (SELECT 1::numeric AS f UNION ALL SELECT p_k WHERE p_k > 0 UNION ALL SELECT 1 / p_k WHERE p_k > 0) v
    CROSS JOIN (SELECT 1::numeric AS q
                UNION ALL SELECT p_pack WHERE p_pack > 0
                UNION ALL SELECT osp_private.supply_offer_num(e.value)
                  FROM jsonb_each(CASE WHEN jsonb_typeof(p_packs) = 'object' THEN p_packs ELSE '{}'::jsonb END) e
                 WHERE osp_private.supply_offer_num(e.value) > 0) w
    WHERE abs(round(p_line * v.f / w.q, 2) - round(p_price, 2)) <= 0.011)
$$;

-- p_ids — id строк реестра (не больше 1000). Ответ — строки счетов из них: id и applied. Применена — цена этой строки (или той же
-- строки в другом файле тендера, см. представление) стоит у позиции тендера, чей документ — этот файл; файл удалён — по следу
-- удалённого файла (tender_supply_removed_docs), пока цену не трогали и у позиции нет другого документа (removedDocPrices).
-- Служебная (SECURITY DEFINER с пропуском — правило 5 проверки прав): цены и документы позиций читает всем читателям реестра
-- одинаково; отвечает только читателю реестра.
CREATE OR REPLACE FUNCTION public.supply_doc_rates_status(p_ids text[])
  RETURNS TABLE (id text, applied boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT d.reg_id,
         EXISTS (
           SELECT 1 FROM osp_private.supply_doc_rates o
           WHERE o.tender_id = d.tender_id AND o.norm_key = d.norm_key AND o.price = d.price
             AND (EXISTS (SELECT 1
                          FROM public.tender_supply_links l
                          JOIN public.tender_vor_supply_rates r
                            ON r.tender_id = l.tender_id AND r.estimate_name = l.estimate_name AND r.material_key = l.material_key
                          WHERE l.s3_document_id = o.doc_id AND r.source_kind IS NULL AND r.price_input IS DISTINCT FROM 'import'
                            AND osp_private.supply_doc_price_hit(o.price, o.vat_k, o.pack_qty, o.packs,
                                                                 coalesce(r.supply_price_exact, r.supply_price)))
                  OR EXISTS (SELECT 1
                             FROM public.tender_supply_removed_docs t
                             JOIN public.tender_vor_supply_rates r ON r.id = t.rate_id
                             WHERE t.doc_id = o.doc_id AND r.source_kind IS NULL
                               AND abs(round(coalesce(r.supply_price_exact, r.supply_price), 2) - round(t.price, 2)) <= 0.011
                               AND NOT EXISTS (SELECT 1 FROM public.tender_supply_links l2
                                               WHERE l2.tender_id = r.tender_id AND l2.estimate_name = r.estimate_name
                                                 AND l2.material_key = r.material_key)
                               AND osp_private.supply_doc_price_hit(o.price, o.vat_k, o.pack_qty, o.packs, t.price))))
  FROM osp_private.supply_doc_rates d
  WHERE d.reg_id = ANY (p_ids) AND coalesce(cardinality(p_ids), 0) <= 1000 AND (SELECT public.osp_registry_reader())
$$;
COMMENT ON FUNCTION public.supply_doc_rates_status(text[]) IS
  'Реестр СУ-10: применена ли строка счёта / КП в тендере (цена позиции из этого файла) — для показанных строк, читателю реестра';
-- osp:allow rpc supply_doc_rates_status authenticated
