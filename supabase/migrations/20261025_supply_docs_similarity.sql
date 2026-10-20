-- Расценка снабжением: файл документа поставщика к позиции и новая похожесть наименований.
--
--  • tender_supply_links.s3_document_id — документ позиции может быть файлом (счёт, КП, чек в Excel / PDF), а не только
--    ссылкой: файл лежит в хранилище документов тендера (s3_documents, owner_type = 'tender', doc_category =
--    'supply_doc'), к позициям — ссылка на строку. Ровно одно из двух: адрес или файл; новая запись заменяет прежнее
--    (адрес поверх файла — файл снимается, и наоборот: так пишут и прежние вкладки, которые о файлах не знают).
--    Удалили файл — пропадает у всех позиций (ON DELETE CASCADE); у завершённого тендера на материалы файл его позиции
--    не удалить, как и документ не изменить (тот же триггер закрытия). Файл распознанного счёта / КП прикрепляет к
--    расценённым позициям страница.
--  • Похожесть (supply_name_score): прежняя (20261023) считала общие слова и числа одной кучей — у клапанов одной серии
--    разных размеров общих больше половины, и на копии прода 15.10 у позиции набиралось до полутора сотен «похожих»
--    цен. Теперь слова — по основе (supply_stem_word: «трубы» = «труба»), сокращение — по началу слова не короче
--    4 букв, двухбуквенные обозначения — тоже слова; размер «700x700» — одно число с двойным весом (стороны по
--    возрастанию); ГОСТ / ТУ и единицы со степенью не считаются; итог — 0,4 × слова + 0,6 × числа, у обоих свои числа
--    вместо общих — штраф. Похожие — слова совпадают не меньше чем на 0,6 и итог не ниже 0,75. Тот же расчёт — в
--    портале (src/utils/supplySimilarity.js): совпадение сторожит tests/supply/similarity.test.mjs.
--  • Колонки расценок name_stems / name_nums / name_heads (вычисляемые) и GIN по name_heads: кандидаты в похожие —
--    по первым четырём буквам основы (ловит и сокращения), дальше — точный расчёт. Прежние name_tokens / name_words
--    остаются до следующей миграции (их не читает больше никто).
--  • supply_suggestion_counts / supply_rate_suggestions — новый расчёт; меню — сначала то же наименование, затем
--    самые похожие, затем самые новые; у каждой — тот ли размер (same_size) и файл документа исходной позиции.
--    supply_rate_origins — и файл документа исходной позиции.
--
-- Только добавление и замена функций, повтор безопасен. Требует 20261020, 20261022 и 20261023. База нового портала —
-- migration/yandex/20261025_supply_docs_similarity.sql (те же функции; права под одну учётку).
-- Проверка: migration/backup/checks/20261025.sql. Откат: migration/rollback/20261025_supply_docs_similarity_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

-- ── 1. Файл документа к позиции ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.tender_supply_links
  ADD COLUMN IF NOT EXISTS s3_document_id uuid REFERENCES public.s3_documents(id) ON DELETE CASCADE;
ALTER TABLE public.tender_supply_links ALTER COLUMN url DROP NOT NULL;
ALTER TABLE public.tender_supply_links DROP CONSTRAINT IF EXISTS tender_supply_links_url_check;
ALTER TABLE public.tender_supply_links DROP CONSTRAINT IF EXISTS tender_supply_links_target_check;
ALTER TABLE public.tender_supply_links ADD CONSTRAINT tender_supply_links_target_check
  CHECK (num_nonnulls(url, s3_document_id) = 1 AND (url IS NULL OR (length(url) <= 2000 AND url ~* '^(https?://\S|\\\\\S)')));
CREATE INDEX IF NOT EXISTS tender_supply_links_doc_idx
  ON public.tender_supply_links (s3_document_id) WHERE s3_document_id IS NOT NULL;
COMMENT ON COLUMN public.tender_supply_links.url IS 'Адрес http(s) или сетевой путь \\сервер\папка — либо файл (s3_document_id)';
COMMENT ON COLUMN public.tender_supply_links.s3_document_id IS
  'Файл документа (счёт, КП, чек) в хранилище документов тендера — либо адрес (url)';

-- Кто и когда изменил; адрес и файл — одно из двух: записали одно — другое снимается.
CREATE OR REPLACE FUNCTION public.tender_supply_links_touch() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.url := nullif(btrim(NEW.url), '');
  IF TG_OP = 'UPDATE' THEN
    IF NEW.url IS NOT NULL AND NEW.url IS DISTINCT FROM OLD.url AND NEW.s3_document_id IS NOT DISTINCT FROM OLD.s3_document_id THEN
      NEW.s3_document_id := NULL;
    ELSIF NEW.s3_document_id IS NOT NULL AND NEW.s3_document_id IS DISTINCT FROM OLD.s3_document_id
          AND NEW.url IS NOT DISTINCT FROM OLD.url THEN
      NEW.url := NULL;
    END IF;
  END IF;
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- ── 2. Слова и числа наименования ────────────────────────────────────────────────────────────────────
-- Подготовка строки — как prepareName в портале: явные классы символов (\s и \d в браузере и в базе разные).
CREATE OR REPLACE FUNCTION public.supply_name_prepare(p_name text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           replace(replace(replace(replace(lower(normalize(coalesce(p_name, ''), NFC)), 'i' || chr(775), 'i'), 'ё', 'е'), '²', '2'), '³', '3'),
           '[^a-zа-я0-9.,/×*–—-]+', ' ', 'g'),
           '([0-9])[.,](?=[0-9])', '\1.', 'g'),
           '(^|[^a-zа-я])(гост|ту|сто|снип|сп|din|iso|en) ?(р ?)?[0-9][0-9.–—/-]*', '\1 ', 'g'),
           '(^|[^a-zа-я])(мм|см|дм|м|m)[23](?![0-9a-zа-я])', '\1 ', 'g'),
           '([0-9]) ?[xх×*] ?(?=[0-9])', '\1×', 'g'),
           '([a-zа-я])(?=[0-9])', '\1 ', 'g'),
           '([0-9])(?=[a-zа-я])', '\1 ', 'g')
$$;

-- Кусочки наименования: число (размер «57×3.5», дробь «1/2») целиком, остальное — по точкам и дробям.
CREATE OR REPLACE FUNCTION public.supply_name_pieces(p_name text) RETURNS SETOF text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT x.p
  FROM regexp_split_to_table(public.supply_name_prepare(p_name), '[^a-zа-я0-9.×/]+') AS c(raw)
  CROSS JOIN LATERAL (SELECT regexp_replace(c.raw, '^[./×]+|[./×]+$', '', 'g') AS chunk) k
  CROSS JOIN LATERAL (
    SELECT k.chunk AS p WHERE k.chunk ~ '^[0-9.×/]*[0-9][0-9.×/]*$'
    UNION ALL
    SELECT s.p FROM regexp_split_to_table(k.chunk, '[./×]+') AS s(p) WHERE k.chunk !~ '^[0-9.×/]*[0-9][0-9.×/]*$'
  ) x
  WHERE k.chunk <> '' AND x.p <> ''
$$;

-- Основа слова: самое длинное окончание из списка, если остаётся не меньше трёх букв.
CREATE OR REPLACE FUNCTION public.supply_stem_word(p_word text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT regexp_replace(p_word, '^(.{3,}?)(иями|ями|ами|ием|иях|ого|его|ому|ему|ыми|ими|ией|ий|ый|ой|ая|яя|ое|ее|ые|ие|ую|юю|ом|ем|ам|ям|ах|ях|ов|ев|ей|ью|ия|ье|а|я|ы|и|е|о|у|ю|ь|й)$', '\1')
$$;

-- Основы слов без служебных; кириллические двойники латиницы — латиницей (как supply_norm_name).
CREATE OR REPLACE FUNCTION public.supply_name_stems(p_name text) RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT coalesce(array_agg(s.w ORDER BY s.w COLLATE "C"), '{}'::text[])
  FROM (SELECT DISTINCT translate(public.supply_stem_word(t.p), 'авекмнорстух', 'abekmhopctyx') AS w
        FROM public.supply_name_pieces(p_name) AS t(p)
        WHERE t.p ~ '^[a-zа-я]+$' AND length(t.p) >= 2
          AND t.p <> ALL (ARRAY['для', 'или', 'при', 'без', 'тип', 'марка', 'марки', 'на', 'из', 'до', 'от', 'по', 'за', 'не',
                                'со', 'под', 'над', 'ед', 'шт', 'мм', 'см', 'дм', 'кг', 'тн', 'мп', 'пм', 'пог', 'кв', 'куб',
                                'компл', 'комплект', 'квт', 'вт', 'па', 'кпа', 'мпа', 'гост', 'ту', 'сто', 'снип', 'сп', 'руб',
                                'ндс', 'mm'])) s
$$;

-- Число в едином виде: без ведущих нулей и хвостовых нулей дроби; стороны размера — по возрастанию.
CREATE OR REPLACE FUNCTION public.supply_norm_number(p text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  WITH dims AS (
    SELECT (SELECT string_agg(CASE WHEN f.q ~ '^[0-9]+(\.[0-9]+)?$'
                                   THEN regexp_replace(split_part(f.q, '.', 1), '^0+(?=[0-9])', '')
                                        || CASE WHEN regexp_replace(split_part(f.q, '.', 2), '0+$', '') <> ''
                                                THEN '.' || regexp_replace(split_part(f.q, '.', 2), '0+$', '') ELSE '' END
                                   ELSE f.q END, '/' ORDER BY f.o)
              FROM unnest(string_to_array(d.dim, '/')) WITH ORDINALITY AS f(q, o)) AS v
    FROM unnest(string_to_array(p, '×')) AS d(dim)
  )
  SELECT CASE WHEN count(*) < 2 THEN min(v)
              ELSE string_agg(v, '×' ORDER BY CASE WHEN v ~ '^[0-9]+(\.[0-9]+)?$' THEN v::numeric END NULLS LAST, v COLLATE "C") END
  FROM dims
$$;

CREATE OR REPLACE FUNCTION public.supply_name_nums(p_name text) RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT coalesce(array_agg(s.n ORDER BY s.n COLLATE "C"), '{}'::text[])
  FROM (SELECT DISTINCT public.supply_norm_number(t.p) AS n
        FROM public.supply_name_pieces(p_name) AS t(p)
        WHERE t.p ~ '^[0-9.×/]*[0-9][0-9.×/]*$') s
$$;

-- Ключи поиска кандидатов: первые четыре буквы основ (одно слово — начало другого → те же четыре буквы).
CREATE OR REPLACE FUNCTION public.supply_name_heads(p_words text[]) RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT coalesce(array_agg(DISTINCT left(w, 4)), '{}'::text[]) FROM unnest(p_words) AS w
$$;

-- ── 3. Похожесть ─────────────────────────────────────────────────────────────────────────────────────
-- Доля совпавших слов с обеих сторон (то же слово или одно — начало другого, оба не короче 4 букв), три знака.
CREATE OR REPLACE FUNCTION public.supply_name_word_share(aw text[], bw text[]) RETURNS numeric
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
DECLARE
  v_den integer := cardinality(aw) + cardinality(bw);
  v_hit integer := 0;
  x text;
  y text;
BEGIN
  IF v_den = 0 THEN RETURN 0; END IF;
  FOREACH x IN ARRAY aw LOOP
    FOREACH y IN ARRAY bw LOOP
      IF x = y OR (length(x) >= 4 AND length(y) >= 4 AND (left(y, length(x)) = x OR left(x, length(y)) = y)) THEN
        v_hit := v_hit + 1;
        EXIT;
      END IF;
    END LOOP;
  END LOOP;
  FOREACH y IN ARRAY bw LOOP
    FOREACH x IN ARRAY aw LOOP
      IF x = y OR (length(x) >= 4 AND length(y) >= 4 AND (left(y, length(x)) = x OR left(x, length(y)) = y)) THEN
        v_hit := v_hit + 1;
        EXIT;
      END IF;
    END LOOP;
  END LOOP;
  RETURN round(v_hit::numeric / v_den, 3);
END
$$;

-- Итог 0…1 (три знака): 0,4 × слова + 0,6 × числа (размер — вес 2; у обоих свои числа вместо общих — штраф); чисел
-- нет у обоих — слова; у одного — слова × 0,8. Слова совпали меньше чем на p_words_min — 0. Цикл, а не подзапросы:
-- счётчики похожих считают тысячи пар, так в 20 раз быстрее.
CREATE OR REPLACE FUNCTION public.supply_name_score(aw text[], an text[], bw text[], bn text[], p_words_min numeric DEFAULT 0) RETURNS numeric
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
DECLARE
  v_den integer := cardinality(aw) + cardinality(bw);
  v_hit integer := 0;
  v_common integer := 0;
  v_only_a integer := 0;
  v_only_b integer := 0;
  v_total integer;
  x text;
  y text;
BEGIN
  IF v_den = 0 THEN RETURN 0; END IF;
  FOREACH x IN ARRAY aw LOOP
    FOREACH y IN ARRAY bw LOOP
      IF x = y OR (length(x) >= 4 AND length(y) >= 4 AND (left(y, length(x)) = x OR left(x, length(y)) = y)) THEN
        v_hit := v_hit + 1;
        EXIT;
      END IF;
    END LOOP;
  END LOOP;
  FOREACH y IN ARRAY bw LOOP
    FOREACH x IN ARRAY aw LOOP
      IF x = y OR (length(x) >= 4 AND length(y) >= 4 AND (left(y, length(x)) = x OR left(x, length(y)) = y)) THEN
        v_hit := v_hit + 1;
        EXIT;
      END IF;
    END LOOP;
  END LOOP;
  IF round(v_hit::numeric / v_den, 3) < coalesce(p_words_min, 0) THEN RETURN 0; END IF;
  IF cardinality(an) > 0 AND cardinality(bn) > 0 THEN
    FOREACH x IN ARRAY an LOOP
      IF x = ANY (bn) THEN
        v_common := v_common + CASE WHEN strpos(x, '×') > 0 THEN 2 ELSE 1 END;
      ELSE
        v_only_a := v_only_a + CASE WHEN strpos(x, '×') > 0 THEN 2 ELSE 1 END;
      END IF;
    END LOOP;
    FOREACH y IN ARRAY bn LOOP
      IF NOT (y = ANY (an)) THEN v_only_b := v_only_b + CASE WHEN strpos(y, '×') > 0 THEN 2 ELSE 1 END; END IF;
    END LOOP;
    v_total := 2 * v_common + v_only_a + v_only_b;
    RETURN round((2 * v_hit * v_total + 3 * greatest(0, 2 * v_common - least(v_only_a, v_only_b)) * v_den)::numeric
                 / (5 * v_den * v_total), 3);
  ELSIF cardinality(an) + cardinality(bn) > 0 THEN
    RETURN round((4 * v_hit)::numeric / (5 * v_den), 3);
  END IF;
  RETURN round(v_hit::numeric / v_den, 3);
END
$$;

-- ── 4. Колонки расценок ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.tender_vor_supply_rates
  ADD COLUMN IF NOT EXISTS name_stems text[] GENERATED ALWAYS AS (public.supply_name_stems(material_name)) STORED,
  ADD COLUMN IF NOT EXISTS name_nums text[] GENERATED ALWAYS AS (public.supply_name_nums(material_name)) STORED,
  ADD COLUMN IF NOT EXISTS name_heads text[] GENERATED ALWAYS AS (public.supply_name_heads(public.supply_name_stems(material_name))) STORED;
COMMENT ON COLUMN public.tender_vor_supply_rates.name_stems IS 'Основы слов наименования (supply_name_stems) — похожесть';
COMMENT ON COLUMN public.tender_vor_supply_rates.name_nums IS 'Числа и размеры наименования (supply_name_nums) — похожесть';
COMMENT ON COLUMN public.tender_vor_supply_rates.name_heads IS 'Первые четыре буквы основ — поиск кандидатов в похожие';

CREATE INDEX IF NOT EXISTS tender_vor_supply_rates_heads_idx
  ON public.tender_vor_supply_rates USING gin (name_heads) WHERE source_rate_id IS NULL;

-- ── 5. Похожие цены ──────────────────────────────────────────────────────────────────────────────────
-- Сколько похожих свежих цен у позиций (порция — видимые строки таблицы, не больше 200): p_items —
-- [{ "doc": ВОР, "k": ключ, "name": наименование, "unit": ед. изм. }]. Та же ед. изм., не старше 3 месяцев; сама
-- позиция не считается. У обоих есть числа, а общих нет — не похожие (итог ≤ 0,4): такие пары не считаются вовсе.
CREATE OR REPLACE FUNCTION public.supply_suggestion_counts(p_tender uuid, p_items jsonb)
  RETURNS TABLE (estimate_name text, k text, n integer)
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  -- MATERIALIZED: слова позиции считаются один раз, а не на каждую пару «позиция × цена».
  WITH pos AS MATERIALIZED (
    SELECT s.doc, s.k, s.w, s.nums, public.supply_name_heads(s.w) AS h, s.u
    FROM (SELECT i->>'doc' AS doc, i->>'k' AS k, public.supply_name_stems(i->>'name') AS w,
                 public.supply_name_nums(i->>'name') AS nums, public.kp_norm_unit(i->>'unit') AS u
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END)
               WITH ORDINALITY AS x(i, o)
          WHERE x.o <= 200 AND coalesce(i->>'k', '') <> '' AND coalesce(btrim(i->>'unit'), '') <> '') s
  )
  SELECT p.doc, p.k, count(*)::integer
  FROM pos p
  JOIN public.tender_vor_supply_rates r
    ON r.name_heads && p.h AND r.source_rate_id IS NULL AND r.unit_key = p.u
   AND r.price_date >= ((now() AT TIME ZONE 'Europe/Moscow')::date - interval '3 months')::date
  JOIN public.tenders t ON t.id = r.tender_id AND t.deleted_at IS NULL
  WHERE NOT (r.tender_id = p_tender AND r.estimate_name = p.doc AND r.material_key = p.k)
    AND (cardinality(p.nums) = 0 OR cardinality(r.name_nums) = 0 OR p.nums && r.name_nums)
    AND public.supply_name_score(p.w, p.nums, r.name_stems, r.name_nums, 0.6) >= 0.75
  GROUP BY p.doc, p.k
$$;

-- Меню похожих одной позиции: сначала то же наименование, затем самые похожие, затем самые новые; тендер, объект,
-- ВОР, цена за единицу, день расценки, тот ли размер и документ исходной позиции (адрес или файл).
DROP FUNCTION IF EXISTS public.supply_rate_suggestions(uuid, text, text, text, integer);
CREATE OR REPLACE FUNCTION public.supply_rate_suggestions(p_tender uuid, p_estimate text, p_name text, p_unit text,
                                                         p_limit integer DEFAULT 15)
  RETURNS TABLE (rate_id uuid, tender_id uuid, tender_number integer, object_name text, estimate_name text,
                 material_name text, unit text, unit_price numeric, price_date date, url text, similarity numeric,
                 same_name boolean, same_size boolean, doc_id uuid, doc_name text, doc_key text)
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  WITH q AS MATERIALIZED (
    SELECT s.w, s.nums, public.supply_name_heads(s.w) AS h, public.supply_norm_name(p_name) AS k,
           public.kp_norm_unit(p_unit) AS u, ((now() AT TIME ZONE 'Europe/Moscow')::date - interval '3 months')::date AS since
    FROM (SELECT public.supply_name_stems(p_name) AS w, public.supply_name_nums(p_name) AS nums) s
  ),
  c AS (
    SELECT r.id, r.tender_id, r.estimate_name, r.material_name, r.material_key, r.unit, r.price_date, r.updated_at,
           coalesce(r.supply_price_exact, r.supply_price) AS unit_price,
           public.supply_name_score(q.w, q.nums, r.name_stems, r.name_nums, 0.6) AS score,
           r.material_key = q.k AS same_name,
           cardinality(q.nums) > 0 AND r.name_nums = q.nums AS same_size
    FROM q
    JOIN public.tender_vor_supply_rates r
      ON r.name_heads && q.h AND r.source_rate_id IS NULL AND r.unit_key = q.u AND r.price_date >= q.since
    WHERE NOT (r.tender_id = p_tender AND r.estimate_name = p_estimate AND r.material_key = q.k)
      AND (cardinality(q.nums) = 0 OR cardinality(r.name_nums) = 0 OR q.nums && r.name_nums)
  )
  SELECT c.id, c.tender_id, t.public_tender_number, coalesce(o.name, t.custom_object_name), c.estimate_name,
         c.material_name, c.unit, c.unit_price, c.price_date, l.url, c.score, c.same_name, c.same_size,
         d.id, d.file_name, d.s3_key
  FROM c
  JOIN public.tenders t ON t.id = c.tender_id AND t.deleted_at IS NULL
  LEFT JOIN public.objects o ON o.id = t.object_id
  LEFT JOIN public.tender_supply_links l
    ON l.tender_id = c.tender_id AND l.estimate_name = c.estimate_name AND l.material_key = c.material_key
  LEFT JOIN public.s3_documents d ON d.id = l.s3_document_id
  WHERE c.same_name OR c.score >= 0.75
  ORDER BY c.same_name DESC, c.score DESC, c.price_date DESC, c.updated_at DESC NULLS LAST
  LIMIT least(greatest(coalesce(p_limit, 15), 1), 50)
$$;

-- Откуда скопированы цены тендера: тендер, объект, ВОР, наименование, документ (адрес или файл) и автор исходной цены.
DROP FUNCTION IF EXISTS public.supply_rate_origins(uuid);
CREATE OR REPLACE FUNCTION public.supply_rate_origins(p_tender uuid)
  RETURNS TABLE (rate_id uuid, source_kind text, source_tender_id uuid, tender_number integer, object_name text,
                 estimate_name text, material_name text, price_date date, url text, source_price_by uuid,
                 doc_id uuid, doc_name text, doc_key text)
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  SELECT r.id, r.source_kind, r.source_tender_id, t.public_tender_number, coalesce(o.name, t.custom_object_name),
         s.estimate_name, s.material_name, r.price_date, l.url, s.price_by, d.id, d.file_name, d.s3_key
  FROM public.tender_vor_supply_rates r
  LEFT JOIN public.tender_vor_supply_rates s ON s.id = r.source_rate_id
  LEFT JOIN public.tenders t ON t.id = r.source_tender_id
  LEFT JOIN public.objects o ON o.id = t.object_id
  LEFT JOIN public.tender_supply_links l
    ON l.tender_id = s.tender_id AND l.estimate_name = s.estimate_name AND l.material_key = s.material_key
  LEFT JOIN public.s3_documents d ON d.id = l.s3_document_id
  WHERE r.tender_id = p_tender AND r.source_kind IS NOT NULL
$$;

-- ── 6. Права функций ─────────────────────────────────────────────────────────────────────────────────
-- Вычисляемые колонки считаются от имени того, кто пишет расценку, — вошедшему нужен вызов функций слов и чисел.
REVOKE ALL ON FUNCTION public.supply_name_prepare(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_name_pieces(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_stem_word(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_name_stems(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_norm_number(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_name_nums(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_name_heads(text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_name_word_share(text[], text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_name_score(text[], text[], text[], text[], numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_suggestion_counts(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_rate_suggestions(uuid, text, text, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_rate_origins(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supply_name_prepare(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_name_pieces(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_stem_word(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_name_stems(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_norm_number(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_name_nums(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_name_heads(text[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_name_word_share(text[], text[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_name_score(text[], text[], text[], text[], numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_suggestion_counts(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_rate_suggestions(uuid, text, text, text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_rate_origins(uuid) TO authenticated, service_role;

COMMIT;
