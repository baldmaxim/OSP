-- Цены снабжения из других тендеров: сами — для одинаковых позиций, на выбор — для похожих (решения пользователя
-- 19.10). Дата расценки — только день, по Москве; старше 3 месяцев не подставляется и не предлагается, но остаётся
-- в реестре «Расценки от снабжения СУ-10».
--
--  • tender_vor_supply_rates.price_date — день расценки: ставит триггер расчёта, когда вводят или меняют саму цену
--    (на сайте, импортом Excel); перенос ВОР, ед. изм. и прочее её не трогают. Прежние — по времени изменения.
--  • price_by — кто поставил цену (для администратора): вошедший при вводе, импорте и выборе из похожих; у сама
--    подставленной — пусто (автор — у исходной цены). updated_by — по-прежнему последний, кто менял строку (перенос
--    ВОР тоже). Прежним — из журнала цен: кто последним менял саму цену.
--  • source_rate_id / source_tender_id / source_kind — цена скопирована из другого тендера: сама (auto, одинаковая
--    позиция) или выбрана из меню похожих (pick). Копия хранит дату исходной цены и сама источником не служит —
--    иначе старая цена переезжала бы из тендера в тендер «помолодевшей». Правка цены — уже своя цена.
--  • name_tokens — слова и числа наименования (supply_name_tokens), name_words — только слова (по ним ищутся
--    кандидаты: числа есть почти в каждом наименовании, поиск по ним сравнивал бы каждую позицию со всеми ценами),
--    unit_key — ед. изм. в едином виде (kp_norm_unit, как реестр). supply_name_similarity — доля общих слов и чисел
--    (Dice), 0 без общего слова — одни общие числа (диаметры) похожестью не считаются.
--  • supply_autofill — подставить одинаковые; supply_suggestion_counts (порцией позиций — видимых строк) /
--    supply_rate_suggestions — похожие (меню);
--    supply_rate_origins — откуда скопированы цены (пометка в строке). Права вызывающего: правила по строкам
--    действуют, читать расценки — сотрудник, подставлять — право правки (как цены).
--  • Реестр СУ-10 — без копий (повтор, а не новая расценка), дата — день расценки. Материализованное
--    представление пересобирается рядом и подменяется: представления над ним те же, с теми же правами.
--
-- Только добавление, повтор безопасен. Требует 20261020_supply_pricing и 20261022_supply_links. База нового
-- портала — migration/yandex/20261023_supply_rate_reuse.sql (те же функции; реестр там в osp_private).
BEGIN;

-- ── 1. Слова наименования и похожесть ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.supply_name_tokens(p_name text) RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT coalesce(array_agg(DISTINCT translate(t, 'авеёкмнорстух', 'abeekmhopctyx')), '{}'::text[])
  FROM (
    SELECT btrim(w, '.') AS t
    FROM regexp_split_to_table(
           regexp_replace(regexp_replace(regexp_replace(
             lower(normalize(coalesce(p_name, ''), NFC)),
             '([0-9])[.,]([0-9])', '\1.\2', 'g'),
             '([a-zа-яё])([0-9])', '\1 \2', 'g'),
             '([0-9])([a-zа-яё])', '\1 \2', 'g'),
           '[^a-zа-яё0-9.]+') AS w
  ) s
  WHERE t <> '' AND (t ~ '^[0-9.]+$' OR length(t) >= 3)
    AND t NOT IN ('гост', 'для', 'или', 'при', 'без', 'тип', 'марка')
$$;

-- Только слова (без чисел) — по ним ищутся кандидаты в похожие.
CREATE OR REPLACE FUNCTION public.supply_name_words(p_name text) RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT coalesce(array_agg(x ORDER BY x), '{}'::text[]) FROM unnest(public.supply_name_tokens(p_name)) x WHERE x !~ '^[0-9.]+$'
$$;

CREATE OR REPLACE FUNCTION public.supply_name_similarity(a text[], b text[]) RETURNS numeric
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM unnest(a) x WHERE x = ANY (b) AND x !~ '^[0-9.]+$') THEN 0::numeric
    ELSE round(2.0 * (SELECT count(*) FROM unnest(a) x WHERE x = ANY (b)) / (cardinality(a) + cardinality(b)), 3)
  END
$$;

-- ── 2. Колонки расценок ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.tender_vor_supply_rates
  ADD COLUMN IF NOT EXISTS price_date date,
  ADD COLUMN IF NOT EXISTS price_by uuid,
  ADD COLUMN IF NOT EXISTS source_rate_id uuid,
  ADD COLUMN IF NOT EXISTS source_tender_id uuid,
  ADD COLUMN IF NOT EXISTS source_kind text,
  ADD COLUMN IF NOT EXISTS name_tokens text[] GENERATED ALWAYS AS (public.supply_name_tokens(material_name)) STORED,
  ADD COLUMN IF NOT EXISTS name_words text[] GENERATED ALWAYS AS (public.supply_name_words(material_name)) STORED,
  ADD COLUMN IF NOT EXISTS unit_key text GENERATED ALWAYS AS (public.kp_norm_unit(unit)) STORED;

ALTER TABLE public.tender_vor_supply_rates DROP CONSTRAINT IF EXISTS tender_vor_supply_rates_source_kind_check;
ALTER TABLE public.tender_vor_supply_rates ADD CONSTRAINT tender_vor_supply_rates_source_kind_check
  CHECK ((source_kind IS NULL OR source_kind IN ('auto', 'pick')) AND (source_rate_id IS NULL) = (source_kind IS NULL));

COMMENT ON COLUMN public.tender_vor_supply_rates.price_date IS 'День расценки (по Москве): когда ввели или изменили саму цену; у копии — день исходной цены';
COMMENT ON COLUMN public.tender_vor_supply_rates.price_by IS 'Кто поставил цену: вошедший при вводе, импорте Excel и выборе из похожих; у сама подставленной — пусто';
COMMENT ON COLUMN public.tender_vor_supply_rates.source_rate_id IS 'Цена скопирована из этой расценки другого тендера (без FK: исходную могут удалить)';
COMMENT ON COLUMN public.tender_vor_supply_rates.source_tender_id IS 'Тендер исходной цены — номер виден, даже если её удалили';
COMMENT ON COLUMN public.tender_vor_supply_rates.source_kind IS 'auto — подставлена сама (одинаковая позиция), pick — выбрана из похожих';
COMMENT ON COLUMN public.tender_vor_supply_rates.name_tokens IS 'Слова и числа наименования (supply_name_tokens) — похожесть';
COMMENT ON COLUMN public.tender_vor_supply_rates.name_words IS 'Только слова наименования — поиск кандидатов в похожие';
COMMENT ON COLUMN public.tender_vor_supply_rates.unit_key IS 'Ед. изм. в едином виде (kp_norm_unit): «шт» = «штук», «мп» = «пог. м»';

-- Прежним ценам — день последнего изменения (по Москве). Триггеры выключены на время заполнения: иначе
-- выросли бы версии и «кто изменил», а у завершённых тендеров запись упёрлась бы в закрытие.
ALTER TABLE public.tender_vor_supply_rates DISABLE TRIGGER USER;
UPDATE public.tender_vor_supply_rates
   SET price_date = (coalesce(updated_at, created_at, now()) AT TIME ZONE 'Europe/Moscow')::date
 WHERE price_date IS NULL;
UPDATE public.tender_vor_supply_rates r
   SET price_by = coalesce((SELECT l.changed_by FROM public.tender_supply_rate_log l
                            WHERE l.rate_id = r.id AND l.op IN ('insert', 'update') AND l.new_price IS DISTINCT FROM l.old_price
                            ORDER BY l.id DESC LIMIT 1), r.updated_by)
 WHERE r.price_by IS NULL AND r.source_rate_id IS NULL;
ALTER TABLE public.tender_vor_supply_rates ENABLE TRIGGER USER;

CREATE INDEX IF NOT EXISTS tender_vor_supply_rates_reuse_idx
  ON public.tender_vor_supply_rates (material_key, unit_key, price_date DESC) WHERE source_rate_id IS NULL;
CREATE INDEX IF NOT EXISTS tender_vor_supply_rates_words_idx
  ON public.tender_vor_supply_rates USING gin (name_words) WHERE source_rate_id IS NULL;

-- ── 3. Расчёт: дата расценки и копии ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tender_vor_supply_rates_compute() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_page boolean;
  v_priced boolean;
  v_src record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.row_version := 1;
    v_page := NEW.price_input IN ('unit', 'total');
  ELSE
    NEW.row_version := OLD.row_version + 1;
    v_page := NEW.price_input IN ('unit', 'total')
      AND (NEW.price_input IS DISTINCT FROM OLD.price_input
           OR NEW.input_value IS DISTINCT FROM OLD.input_value
           OR NEW.volume_at_input IS DISTINCT FROM OLD.volume_at_input);
  END IF;
  NEW.updated_by := auth.uid();

  IF v_page THEN
    IF NEW.input_value IS NULL OR NEW.input_value <= 0 THEN
      RAISE EXCEPTION 'Цена и сумма должны быть больше нуля' USING ERRCODE = '23514', HINT = 'supply_value';
    END IF;
    IF NEW.price_input = 'unit' THEN
      NEW.supply_price := round(NEW.input_value, 2);
      NEW.supply_price_exact := NULL;
      NEW.supply_total := CASE WHEN NEW.volume_at_input > 0 THEN round(NEW.supply_price * NEW.volume_at_input, 2) END;
    ELSE
      IF NEW.volume_at_input IS NULL OR NEW.volume_at_input <= 0 THEN
        RAISE EXCEPTION 'Сумму можно ввести только у позиции с объёмом' USING ERRCODE = '23514', HINT = 'supply_volume';
      END IF;
      NEW.supply_total := round(NEW.input_value, 2);
      NEW.supply_price_exact := NEW.supply_total / NEW.volume_at_input;
      NEW.supply_price := round(NEW.supply_price_exact, 2);
    END IF;
    IF NEW.supply_price <= 0 THEN
      RAISE EXCEPTION 'Цена за единицу выходит меньше копейки' USING ERRCODE = '23514', HINT = 'supply_value';
    END IF;
  ELSIF TG_OP = 'INSERT' OR NEW.supply_price IS DISTINCT FROM OLD.supply_price THEN
    IF NEW.supply_price IS NULL OR NEW.supply_price <= 0 THEN
      RAISE EXCEPTION 'Цена должна быть больше нуля' USING ERRCODE = '23514', HINT = 'supply_value';
    END IF;
    NEW.price_input := 'import';
    NEW.input_value := NEW.supply_price;
    NEW.volume_at_input := NULL;
    NEW.supply_price_exact := NULL;
    NEW.supply_total := NULL;
  END IF;

  -- Копия цены другого тендера: дата — исходной цены, источник — только своя (не скопированная) цена.
  -- Цена изменилась без нового источника — это уже своя цена: дата — сегодня (по Москве), отметка снимается.
  -- Иначе день расценки и отметка копии не меняются: прямой правкой колонки старую цену не «омолодить».
  v_priced := TG_OP = 'INSERT' OR NEW.supply_price IS DISTINCT FROM OLD.supply_price
              OR NEW.supply_price_exact IS DISTINCT FROM OLD.supply_price_exact;
  IF NEW.source_rate_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.source_rate_id IS DISTINCT FROM OLD.source_rate_id) THEN
    SELECT s.price_date, s.tender_id, s.source_rate_id AS copied INTO v_src
      FROM public.tender_vor_supply_rates s WHERE s.id = NEW.source_rate_id;
    IF NOT FOUND OR v_src.price_date IS NULL OR v_src.copied IS NOT NULL THEN
      RAISE EXCEPTION 'Исходная цена не найдена или сама скопирована из другого тендера' USING ERRCODE = '23514', HINT = 'supply_source';
    END IF;
    NEW.price_date := v_src.price_date;
    NEW.source_tender_id := v_src.tender_id;
    NEW.source_kind := coalesce(NEW.source_kind, 'pick');
    NEW.price_by := CASE WHEN NEW.source_kind = 'pick' THEN auth.uid() END;
  ELSIF v_priced OR OLD.price_date IS NULL THEN
    NEW.source_rate_id := NULL;
    NEW.source_tender_id := NULL;
    NEW.source_kind := NULL;
    NEW.price_date := (now() AT TIME ZONE 'Europe/Moscow')::date;
    NEW.price_by := auth.uid();
  ELSE
    NEW.price_date := OLD.price_date;
    NEW.price_by := OLD.price_by;
    NEW.source_rate_id := OLD.source_rate_id;
    NEW.source_tender_id := OLD.source_tender_id;
    NEW.source_kind := OLD.source_kind;
  END IF;
  RETURN NEW;
END
$$;

-- ── 4. Одинаковые позиции — сами ─────────────────────────────────────────────────────────────────────
-- Позиции списков ВОР тендера без цены и без записей в журнале (убранная вручную цена сама не вернётся):
-- самая свежая своя (не скопированная) цена другого тендера с тем же ключом наименования и той же ед. изм.,
-- не старше 3 месяцев (по дням, по Москве). Цену не перезаписывает никогда. Ответ — сколько подставлено.
CREATE OR REPLACE FUNCTION public.supply_autofill(p_tender uuid) RETURNS integer
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_since date := ((now() AT TIME ZONE 'Europe/Moscow')::date - interval '3 months')::date;
  v_count integer;
BEGIN
  IF NOT public.supply_can_edit() OR public.supply_rates_locked(p_tender) THEN
    RETURN 0;
  END IF;
  WITH pos AS MATERIALIZED (
    SELECT s.estimate_name AS doc, e->>'name' AS name, e->>'unit' AS unit, e->>'k' AS k, public.kp_norm_unit(e->>'unit') AS u,
           CASE WHEN jsonb_typeof(e->'volume') = 'number' THEN (e->>'volume')::numeric END AS volume
    FROM public.tender_supply_sources s, jsonb_array_elements(s.positions) e
    WHERE s.tender_id = p_tender AND coalesce(e->>'k', '') <> '' AND coalesce(btrim(e->>'unit'), '') <> '' AND NOT (e ? 'units')
  ),
  logged AS (
    SELECT DISTINCT l.estimate_name AS doc, public.supply_norm_name(l.material_name) AS k
    FROM public.tender_supply_rate_log l WHERE l.tender_id = p_tender
  ),
  todo AS (
    SELECT p.* FROM pos p
    WHERE NOT EXISTS (SELECT 1 FROM public.tender_vor_supply_rates r
                      WHERE r.tender_id = p_tender AND r.estimate_name = p.doc AND r.material_key = p.k)
      AND NOT EXISTS (SELECT 1 FROM logged g WHERE g.doc = p.doc AND g.k = p.k)
  ),
  pick AS (
    SELECT DISTINCT ON (t.doc, t.k) t.doc, t.name, t.unit, t.volume, src.id AS src_id,
           coalesce(src.supply_price_exact, src.supply_price) AS price
    FROM todo t
    JOIN public.tender_vor_supply_rates src
      ON src.material_key = t.k AND src.source_rate_id IS NULL AND src.price_date >= v_since
     AND src.tender_id <> p_tender AND src.unit_key = t.u
    JOIN public.tenders st ON st.id = src.tender_id AND st.deleted_at IS NULL
    ORDER BY t.doc, t.k, src.price_date DESC, src.updated_at DESC NULLS LAST
  )
  INSERT INTO public.tender_vor_supply_rates (tender_id, estimate_name, material_name, unit, price_input, input_value,
                                              volume_at_input, source_rate_id, source_kind)
  SELECT p_tender, doc, name, unit, 'unit', price, volume, src_id, 'auto' FROM pick
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

-- ── 5. Похожие позиции — на выбор ────────────────────────────────────────────────────────────────────
-- Сколько похожих свежих цен у позиций (порция — видимые строки таблицы, не больше 200): p_items —
-- [{ "doc": ВОР, "k": ключ, "name": наименование, "unit": ед. изм. }]. Похожая — та же ед. изм., общее слово,
-- доля общих слов и чисел ≥ 0,5; сама позиция не считается. Кандидаты — по словам (GIN), не по числам.
CREATE OR REPLACE FUNCTION public.supply_suggestion_counts(p_tender uuid, p_items jsonb)
  RETURNS TABLE (estimate_name text, k text, n integer)
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  -- MATERIALIZED: слова позиции считаются один раз, а не на каждую пару «позиция × цена».
  WITH pos AS MATERIALIZED (
    SELECT i->>'doc' AS doc, i->>'k' AS k, public.supply_name_tokens(i->>'name') AS tokens,
           public.supply_name_words(i->>'name') AS words, public.kp_norm_unit(i->>'unit') AS u
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END)
         WITH ORDINALITY AS x(i, o)
    WHERE x.o <= 200 AND coalesce(i->>'k', '') <> '' AND coalesce(btrim(i->>'unit'), '') <> ''
  )
  SELECT p.doc, p.k, count(*)::integer
  FROM pos p
  JOIN public.tender_vor_supply_rates r
    ON r.name_words && p.words AND r.source_rate_id IS NULL AND r.unit_key = p.u
   AND r.price_date >= ((now() AT TIME ZONE 'Europe/Moscow')::date - interval '3 months')::date
  JOIN public.tenders t ON t.id = r.tender_id AND t.deleted_at IS NULL
  WHERE NOT (r.tender_id = p_tender AND r.estimate_name = p.doc AND r.material_key = p.k)
    AND public.supply_name_similarity(p.tokens, r.name_tokens) >= 0.5
  GROUP BY p.doc, p.k
$$;

-- Меню похожих одной позиции: от самых недавних, затем по похожести; тендер, объект, ВОР, цена за единицу,
-- день расценки и ссылка на документ исходной позиции.
CREATE OR REPLACE FUNCTION public.supply_rate_suggestions(p_tender uuid, p_estimate text, p_name text, p_unit text,
                                                         p_limit integer DEFAULT 15)
  RETURNS TABLE (rate_id uuid, tender_id uuid, tender_number integer, object_name text, estimate_name text,
                 material_name text, unit text, unit_price numeric, price_date date, url text, similarity numeric,
                 same_name boolean)
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  WITH q AS MATERIALIZED (
    SELECT public.supply_name_tokens(p_name) AS tokens, public.supply_name_words(p_name) AS words,
           public.supply_norm_name(p_name) AS k, public.kp_norm_unit(p_unit) AS u,
           ((now() AT TIME ZONE 'Europe/Moscow')::date - interval '3 months')::date AS since
  )
  SELECT r.id, r.tender_id, t.public_tender_number, coalesce(o.name, t.custom_object_name), r.estimate_name,
         r.material_name, r.unit, coalesce(r.supply_price_exact, r.supply_price), r.price_date, l.url,
         public.supply_name_similarity(q.tokens, r.name_tokens), r.material_key = q.k
  FROM q
  JOIN public.tender_vor_supply_rates r
    ON r.name_words && q.words AND r.source_rate_id IS NULL AND r.unit_key = q.u AND r.price_date >= q.since
  JOIN public.tenders t ON t.id = r.tender_id AND t.deleted_at IS NULL
  LEFT JOIN public.objects o ON o.id = t.object_id
  LEFT JOIN public.tender_supply_links l
    ON l.tender_id = r.tender_id AND l.estimate_name = r.estimate_name AND l.material_key = r.material_key
  WHERE NOT (r.tender_id = p_tender AND r.estimate_name = p_estimate AND r.material_key = q.k)
    AND public.supply_name_similarity(q.tokens, r.name_tokens) >= 0.5
  ORDER BY r.price_date DESC, public.supply_name_similarity(q.tokens, r.name_tokens) DESC, r.updated_at DESC NULLS LAST
  LIMIT least(greatest(coalesce(p_limit, 15), 1), 50)
$$;

-- Откуда скопированы цены тендера: тендер, объект, ВОР, наименование, документ и автор исходной цены, день расценки.
CREATE OR REPLACE FUNCTION public.supply_rate_origins(p_tender uuid)
  RETURNS TABLE (rate_id uuid, source_kind text, source_tender_id uuid, tender_number integer, object_name text,
                 estimate_name text, material_name text, price_date date, url text, source_price_by uuid)
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  SELECT r.id, r.source_kind, r.source_tender_id, t.public_tender_number, coalesce(o.name, t.custom_object_name),
         s.estimate_name, s.material_name, r.price_date, l.url, s.price_by
  FROM public.tender_vor_supply_rates r
  LEFT JOIN public.tender_vor_supply_rates s ON s.id = r.source_rate_id
  LEFT JOIN public.tenders t ON t.id = r.source_tender_id
  LEFT JOIN public.objects o ON o.id = t.object_id
  LEFT JOIN public.tender_supply_links l
    ON l.tender_id = s.tender_id AND l.estimate_name = s.estimate_name AND l.material_key = s.material_key
  WHERE r.tender_id = p_tender AND r.source_kind IS NOT NULL
$$;

-- ── 6. Реестр «Расценки от снабжения СУ-10»: без копий, дата — день расценки ──────────────────────────
-- Новое материализованное представление строится рядом, представления реестра переключаются на него (те же
-- колонки и права), прежнее удаляется, новое получает его имя и имена индексов.
DROP MATERIALIZED VIEW IF EXISTS public.supply_rates_registry_mv_next;
CREATE MATERIALIZED VIEW public.supply_rates_registry_mv_next AS
SELECT DISTINCT ON (sr.tender_id, public.kp_norm_name(sr.material_name), public.kp_norm_unit(sr.unit))
  md5(sr.tender_id::text || '|' || public.kp_norm_name(sr.material_name) || '|' || public.kp_norm_unit(sr.unit)) AS id,
  'supply_su10'::text AS source_type,
  'СУ-10'::text AS source_name,
  sr.material_name AS item_name,
  sr.unit AS unit,
  sr.supply_price AS price,
  sr.tender_id,
  t.object_id,
  t.work_description AS tender_desc,
  o.name AS object_name,
  coalesce(sr.price_date::timestamp AT TIME ZONE 'Europe/Moscow', sr.updated_at, sr.created_at) AS rate_date
FROM public.tender_vor_supply_rates sr
JOIN public.tenders t ON t.id = sr.tender_id
LEFT JOIN public.objects o ON o.id = t.object_id
WHERE public.kp_norm_name(sr.material_name) <> '' AND sr.source_rate_id IS NULL
ORDER BY sr.tender_id, public.kp_norm_name(sr.material_name), public.kp_norm_unit(sr.unit),
         coalesce(sr.updated_at, sr.created_at) DESC NULLS LAST;

CREATE UNIQUE INDEX supply_rates_mv_next_id ON public.supply_rates_registry_mv_next (id);
CREATE INDEX supply_rates_mv_next_date ON public.supply_rates_registry_mv_next (rate_date DESC NULLS LAST);
CREATE INDEX supply_rates_mv_next_name ON public.supply_rates_registry_mv_next (item_name, id);
CREATE INDEX supply_rates_mv_next_name_trgm ON public.supply_rates_registry_mv_next USING gin (item_name gin_trgm_ops);
CREATE INDEX supply_rates_mv_next_object ON public.supply_rates_registry_mv_next (object_id);
CREATE INDEX supply_rates_mv_next_price ON public.supply_rates_registry_mv_next (price);
CREATE INDEX supply_rates_mv_next_tender ON public.supply_rates_registry_mv_next (tender_id);

CREATE OR REPLACE VIEW public.supply_rates_registry AS
 SELECT id, source_type, source_name, item_name, unit, price, tender_id, object_id, tender_desc, object_name, rate_date
   FROM public.supply_rates_registry_mv_next
  WHERE (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.supply_rates_registry_filter_objects AS
 SELECT DISTINCT object_id, object_name
   FROM public.supply_rates_registry_mv_next r
  WHERE object_id IS NOT NULL AND (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.supply_rates_registry_filter_tenders AS
 SELECT DISTINCT tender_id, tender_desc, object_id
   FROM public.supply_rates_registry_mv_next r
  WHERE tender_id IS NOT NULL AND coalesce(tender_desc, '') <> '' AND (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.supply_rates_registry_units AS
 SELECT DISTINCT unit
   FROM public.supply_rates_registry_mv_next
  WHERE unit IS NOT NULL AND unit <> '' AND (SELECT public.osp_registry_reader());

DROP MATERIALIZED VIEW IF EXISTS public.supply_rates_registry_mv;
ALTER MATERIALIZED VIEW public.supply_rates_registry_mv_next RENAME TO supply_rates_registry_mv;
ALTER INDEX public.supply_rates_mv_next_id RENAME TO idx_supply_rates_mv_id;
ALTER INDEX public.supply_rates_mv_next_date RENAME TO idx_supply_rates_mv_date;
ALTER INDEX public.supply_rates_mv_next_name RENAME TO idx_supply_rates_mv_name;
ALTER INDEX public.supply_rates_mv_next_name_trgm RENAME TO idx_supply_rates_mv_name_trgm;
ALTER INDEX public.supply_rates_mv_next_object RENAME TO idx_supply_rates_mv_object;
ALTER INDEX public.supply_rates_mv_next_price RENAME TO idx_supply_rates_mv_price;
ALTER INDEX public.supply_rates_mv_next_tender RENAME TO idx_supply_rates_mv_tender;

-- Права реестра (20261013, Р2d): само представление — только служебному ключу, представления — как были.
REVOKE ALL ON TABLE public.supply_rates_registry_mv FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.supply_rates_registry_mv TO service_role;

-- ── 7. Права функций ─────────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.supply_name_tokens(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_name_words(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_name_similarity(text[], text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_autofill(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_suggestion_counts(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_rate_suggestions(uuid, text, text, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_rate_origins(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supply_name_tokens(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_name_words(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_name_similarity(text[], text[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_autofill(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_suggestion_counts(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_rate_suggestions(uuid, text, text, text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_rate_origins(uuid) TO authenticated, service_role;

COMMIT;
