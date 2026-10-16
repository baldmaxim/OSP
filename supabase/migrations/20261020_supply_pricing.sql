-- Расценка материалов ВОР снабжением прямо на сайте (страница /tenders/materials/:id/pricing).
--
-- Снабжение видит позиции листа «Материалы» из ВОР основного тендера и вводит цену за единицу или
-- итоговую сумму. Введённое — обычная расценка снабжения в tender_vor_supply_rates (по ней уже строятся
-- вкладка «Расценки снабжения» карточки, «Сравнение КП», выгрузка ВОР и реестр «Расценки от снабжения
-- СУ-10»), поэтому отдельной передачи нет.
--
--  • tender_vor_supply_rates — новые необязательные колонки: как ввели (price_input, input_value,
--    volume_at_input), точная цена при вводе суммы (supply_price_exact), сумма (supply_total), версия
--    строки (row_version) для проверки «изменено другим», кто изменил (updated_by), ключ наименования
--    (material_key = supply_norm_name(material_name), вычисляемый). supply_price (копейки) остаётся главной:
--    её читают реестр, rates-api и прежние вкладки браузера.
--  • Расчёт — в базе (триггер): цена → сумма = round(цена × объём, 2); сумма → точная цена = сумма / объём,
--    supply_price = round(точная, 2). Запись только supply_price (импорт Excel в карточке, старая вкладка)
--    сбрасывает точную цену и сумму — карточка не покажет устаревшее.
--  • Закрытие: тендер на материалы «Завершён» → расценки и списки позиций его основного тендера только для
--    чтения (триггер после записи; каскадное удаление тендера или файла не задевает).
--  • Права: читать — сотрудникам, как прежде; писать — «Тендеры: редактирование» или «Тендеры на материалы:
--    редактирование» (раньше — любому одобренному сотруднику).
--  • tender_supply_sources — разобранный ВОР (позиции листа «Материалы» или вкладки «ВОР» карточки), одна
--    строка на основной тендер и ВОР-документ.
--  • tender_supply_rate_log — журнал каждого изменения расценки, откуда бы оно ни шло (без внешнего ключа на
--    тендер: не мешает удалению тендера). Пишет только триггер.
--  • tender_supply_progress — сколько позиций ВОР расценено (для реестра тендеров на материалы).
--  • supply_estimate_rename — перенести расценки и список позиций на другое имя ВОР одной транзакцией.
--
-- Только добавление: прежние колонки, ключ уникальности и данные не меняются; представление реестра не
-- пересоздаётся. Повтор безопасен. База нового портала — migration/yandex/20261020_supply_pricing.sql
-- (те же объекты и тела функций, права под одну учётку). Проверка: migration/backup/checks/20261020.sql.
-- Откат: migration/rollback/20261020_supply_pricing_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

-- ── 1. Ключ наименования — как normName в src/utils/supplyRateHelpers.js ────────────────────────────────
-- NFC → нижний регистр → десятичная запятая/точка между цифрами → точка → кириллические двойники латиницей
-- → только латиница, кириллица, цифры и точка. [0-9] вместо \d: \d в PostgreSQL ловит и не-ASCII цифры.
-- Совпадение с JS проверяет tests/supply/norm-name.test.mjs.
CREATE OR REPLACE FUNCTION public.supply_norm_name(p_name text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT regexp_replace(
           translate(
             regexp_replace(lower(normalize(coalesce(p_name, ''), NFC)), '([0-9])[.,]([0-9])', '\1.\2', 'g'),
             'авеёкмнорстух', 'abeekmhopctyx'),
           '[^a-zа-я0-9.]+', '', 'g')
$$;

-- Может ли вошедший менять расценки снабжения (как canEdit в RoleContext).
CREATE OR REPLACE FUNCTION public.supply_can_edit() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  SELECT public.osp_can('tenders', 'edit') OR public.osp_can('tenders_materials', 'edit')
$$;

-- Закрыты ли расценки тендера: у него есть неудалённый тендер на материалы, и все такие «Завершён».
-- p_tender — основной тендер (или сам тендер на материалы без основного).
CREATE OR REPLACE FUNCTION public.supply_rates_locked(p_tender uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.tenders m
                 WHERE m.tender_type = 'materials' AND m.deleted_at IS NULL
                   AND (m.parent_tender_id = p_tender OR m.id = p_tender))
     AND NOT EXISTS (SELECT 1 FROM public.tenders m
                 WHERE m.tender_type = 'materials' AND m.deleted_at IS NULL
                   AND (m.parent_tender_id = p_tender OR m.id = p_tender)
                   AND m.status::text NOT IN ('Завершён', 'Завершен'))
$$;

-- ── 2. Новые колонки расценок ────────────────────────────────────────────────────────────────────────
ALTER TABLE public.tender_vor_supply_rates
  ADD COLUMN IF NOT EXISTS price_input text,
  ADD COLUMN IF NOT EXISTS input_value numeric,
  ADD COLUMN IF NOT EXISTS volume_at_input numeric,
  ADD COLUMN IF NOT EXISTS supply_price_exact numeric,
  ADD COLUMN IF NOT EXISTS supply_total numeric(15, 2),
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_by uuid,
  ADD COLUMN IF NOT EXISTS material_key text GENERATED ALWAYS AS (public.supply_norm_name(material_name)) STORED;

ALTER TABLE public.tender_vor_supply_rates DROP CONSTRAINT IF EXISTS tender_vor_supply_rates_price_input_check;
ALTER TABLE public.tender_vor_supply_rates ADD CONSTRAINT tender_vor_supply_rates_price_input_check
  CHECK (price_input IS NULL OR price_input IN ('unit', 'total', 'import'));

CREATE INDEX IF NOT EXISTS tender_vor_supply_rates_key_idx
  ON public.tender_vor_supply_rates (tender_id, estimate_name, material_key);

COMMENT ON COLUMN public.tender_vor_supply_rates.price_input IS
  'Как ввели: unit — цена за единицу, total — итоговая сумма (страница расценки), import — Excel в карточке; пусто — до 20261020';
COMMENT ON COLUMN public.tender_vor_supply_rates.input_value IS 'Введённое значение: цена за единицу или сумма — по price_input';
COMMENT ON COLUMN public.tender_vor_supply_rates.volume_at_input IS 'Объём позиции ВОР, по которому считали сумму';
COMMENT ON COLUMN public.tender_vor_supply_rates.supply_price_exact IS
  'Цена без округления, когда вводили сумму (сумма / объём); карточка считает по ней, чтобы сумма совпала до копейки';
COMMENT ON COLUMN public.tender_vor_supply_rates.supply_total IS 'Сумма по позиции: введённая или цена × объём';
COMMENT ON COLUMN public.tender_vor_supply_rates.row_version IS 'Растёт при каждом изменении: правка со старой версией не проходит';
COMMENT ON COLUMN public.tender_vor_supply_rates.material_key IS 'supply_norm_name(material_name) — ключ сопоставления с позициями ВОР';

-- ── 3. Расчёт и версия строки ────────────────────────────────────────────────────────────────────────
-- Запись со страницы расценки задаёт price_input (unit | total) и input_value; прежние клиенты пишут только
-- supply_price — такая запись помечается import, точная цена и сумма сбрасываются.
CREATE OR REPLACE FUNCTION public.tender_vor_supply_rates_compute() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_page boolean;
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
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS tender_vor_supply_rates_compute ON public.tender_vor_supply_rates;
CREATE TRIGGER tender_vor_supply_rates_compute
  BEFORE INSERT OR UPDATE ON public.tender_vor_supply_rates
  FOR EACH ROW EXECUTE FUNCTION public.tender_vor_supply_rates_compute();

-- ── 4. Закрытие после завершения тендера на материалы ─────────────────────────────────────────────────
-- После записи: правило по строкам и уникальность срабатывают раньше, отказ закрытия — только у того, кому
-- запись иначе разрешена. Пустая правка (те же значения) и каскад (удаление тендера, файла) проходят.
CREATE OR REPLACE FUNCTION public.tender_supply_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_skip text[] := ARRAY['row_version', 'updated_at', 'updated_by', 'parsed_at', 'parsed_by'];
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - v_skip) = (to_jsonb(OLD) - v_skip) THEN RETURN NULL; END IF;
  IF (TG_OP <> 'INSERT' AND public.supply_rates_locked(OLD.tender_id))
     OR (TG_OP <> 'DELETE' AND public.supply_rates_locked(NEW.tender_id)) THEN
    RAISE EXCEPTION 'Тендер на материалы завершён — расценки снабжения только для чтения. Чтобы изменить, верните тендеру на материалы прежний статус.'
      USING ERRCODE = 'P0001', HINT = 'supply_locked';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS tender_vor_supply_rates_guard ON public.tender_vor_supply_rates;
CREATE TRIGGER tender_vor_supply_rates_guard
  AFTER INSERT OR UPDATE OR DELETE ON public.tender_vor_supply_rates
  FOR EACH ROW EXECUTE FUNCTION public.tender_supply_guard();

-- ── 5. Журнал изменений расценок ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tender_supply_rate_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tender_id uuid NOT NULL,
  rate_id uuid NOT NULL,
  op text NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
  estimate_name text NOT NULL,
  old_estimate_name text,
  material_name text NOT NULL,
  unit text,
  old_price numeric,
  new_price numeric,
  old_price_exact numeric,
  new_price_exact numeric,
  old_total numeric,
  new_total numeric,
  old_input text,
  new_input text,
  input_value numeric,
  volume_at_input numeric,
  changed_by uuid,
  changed_by_name text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tender_supply_rate_log_tender_idx ON public.tender_supply_rate_log (tender_id, id DESC);
CREATE INDEX IF NOT EXISTS tender_supply_rate_log_rate_idx ON public.tender_supply_rate_log (rate_id, id DESC);
COMMENT ON TABLE public.tender_supply_rate_log IS
  'Журнал изменений расценок снабжения (триггер на tender_vor_supply_rates): было / стало, кто, когда. Без внешнего ключа на тендер';

CREATE OR REPLACE FUNCTION public.tender_supply_rate_log_write() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_name text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.supply_price IS NOT DISTINCT FROM OLD.supply_price
     AND NEW.supply_price_exact IS NOT DISTINCT FROM OLD.supply_price_exact
     AND NEW.supply_total IS NOT DISTINCT FROM OLD.supply_total
     AND NEW.price_input IS NOT DISTINCT FROM OLD.price_input
     AND NEW.estimate_name IS NOT DISTINCT FROM OLD.estimate_name
     AND NEW.material_name IS NOT DISTINCT FROM OLD.material_name
     AND NEW.unit IS NOT DISTINCT FROM OLD.unit THEN
    RETURN NULL;
  END IF;
  SELECT nullif(btrim(ur.full_name), '') INTO v_name FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1;
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.tender_supply_rate_log (tender_id, rate_id, op, estimate_name, material_name, unit,
      old_price, old_price_exact, old_total, old_input, changed_by, changed_by_name)
    VALUES (OLD.tender_id, OLD.id, 'delete', OLD.estimate_name, OLD.material_name, OLD.unit,
      OLD.supply_price, OLD.supply_price_exact, OLD.supply_total, OLD.price_input, auth.uid(), v_name);
  ELSE
    INSERT INTO public.tender_supply_rate_log (tender_id, rate_id, op, estimate_name, old_estimate_name, material_name, unit,
      old_price, new_price, old_price_exact, new_price_exact, old_total, new_total, old_input, new_input,
      input_value, volume_at_input, changed_by, changed_by_name)
    VALUES (NEW.tender_id, NEW.id, lower(TG_OP), NEW.estimate_name,
      CASE WHEN TG_OP = 'UPDATE' AND OLD.estimate_name IS DISTINCT FROM NEW.estimate_name THEN OLD.estimate_name END,
      NEW.material_name, NEW.unit,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.supply_price END, NEW.supply_price,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.supply_price_exact END, NEW.supply_price_exact,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.supply_total END, NEW.supply_total,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.price_input END, NEW.price_input,
      NEW.input_value, NEW.volume_at_input, auth.uid(), v_name);
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS tender_vor_supply_rates_log ON public.tender_vor_supply_rates;
CREATE TRIGGER tender_vor_supply_rates_log
  AFTER INSERT OR UPDATE OR DELETE ON public.tender_vor_supply_rates
  FOR EACH ROW EXECUTE FUNCTION public.tender_supply_rate_log_write();

-- ── 6. Разобранный ВОР: позиции для расценки ─────────────────────────────────────────────────────────
-- positions — массив {name, unit, volume, order[, units: [{unit, volume}]]}; ключ k = supply_norm_name(name)
-- проставляет триггер. units — когда у одного наименования разные ед. изм. (тогда unit и volume пусты).
CREATE TABLE IF NOT EXISTS public.tender_supply_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
  estimate_name text NOT NULL CHECK (btrim(estimate_name) <> ''),
  source text NOT NULL CHECK (source IN ('vor_file', 'vor_tab')),
  s3_document_id uuid REFERENCES public.s3_documents(id) ON DELETE SET NULL,
  file_name text,
  sheet_name text,
  column_map jsonb,
  source_version text,
  positions jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (CASE WHEN jsonb_typeof(positions) = 'array' THEN jsonb_array_length(positions) <= 20000 ELSE false END),
  positions_count integer NOT NULL DEFAULT 0,
  row_version integer NOT NULL DEFAULT 1,
  parsed_by uuid,
  parsed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tender_id, estimate_name)
);
CREATE INDEX IF NOT EXISTS tender_supply_sources_document_idx ON public.tender_supply_sources (s3_document_id);
COMMENT ON TABLE public.tender_supply_sources IS
  'Позиции ВОР для расценки снабжением: лист «Материалы» файла из «ВОРов и РД» или вкладка «ВОР» карточки; строка на основной тендер и ВОР';
COMMENT ON COLUMN public.tender_supply_sources.source_version IS
  'Признак версии источника (файл: id и дата загрузки; вкладка ВОР: время загрузки) — по нему страница видит, что ВОР обновился';

CREATE OR REPLACE FUNCTION public.tender_supply_sources_compute() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.positions IS DISTINCT FROM OLD.positions THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.positions) e
               WHERE jsonb_typeof(e) <> 'object' OR coalesce(btrim(e->>'name'), '') = '') THEN
      RAISE EXCEPTION 'В списке позиций есть строка без наименования' USING ERRCODE = '22023';
    END IF;
    NEW.positions := (SELECT coalesce(jsonb_agg(e || jsonb_build_object('k', public.supply_norm_name(e->>'name')) ORDER BY o), '[]'::jsonb)
                      FROM jsonb_array_elements(NEW.positions) WITH ORDINALITY AS t(e, o));
    NEW.positions_count := (SELECT count(DISTINCT e->>'k') FROM jsonb_array_elements(NEW.positions) e WHERE e->>'k' <> '');
    NEW.parsed_at := now();
    NEW.parsed_by := auth.uid();
  END IF;
  NEW.row_version := CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE OLD.row_version + 1 END;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS tender_supply_sources_compute ON public.tender_supply_sources;
CREATE TRIGGER tender_supply_sources_compute
  BEFORE INSERT OR UPDATE ON public.tender_supply_sources
  FOR EACH ROW EXECUTE FUNCTION public.tender_supply_sources_compute();

DROP TRIGGER IF EXISTS tender_supply_sources_guard ON public.tender_supply_sources;
CREATE TRIGGER tender_supply_sources_guard
  AFTER INSERT OR UPDATE OR DELETE ON public.tender_supply_sources
  FOR EACH ROW EXECUTE FUNCTION public.tender_supply_guard();

-- ── 7. Сколько позиций расценено (реестр тендеров на материалы) ────────────────────────────────────────
-- Два источника в FROM — представление не обновляемое (запись только в таблицы).
CREATE OR REPLACE VIEW public.tender_supply_progress WITH (security_invoker = true) AS
SELECT s.tender_id, s.estimate_name, s.positions_count, coalesce(p.priced, 0) AS priced_count,
       s.parsed_at, s.row_version
FROM public.tender_supply_sources s
LEFT JOIN LATERAL (
  SELECT count(DISTINCT e->>'k')::integer AS priced
  FROM jsonb_array_elements(s.positions) e
  WHERE e->>'k' <> ''
    AND EXISTS (SELECT 1 FROM public.tender_vor_supply_rates r
                WHERE r.tender_id = s.tender_id AND r.estimate_name = s.estimate_name AND r.material_key = e->>'k')
) p ON true;

-- ── 8. Перенос расценок и позиций на другое имя ВОР (привязка к ВОР карточки) ─────────────────────────
-- С правами вызывающего: правила по строкам и закрытие действуют. Пересечение цен — отказ целиком.
CREATE OR REPLACE FUNCTION public.supply_estimate_rename(p_tender uuid, p_from text, p_to text) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_rates integer;
  v_sources integer;
BEGIN
  IF NOT public.supply_can_edit() THEN
    RAISE EXCEPTION 'Нет права менять расценки снабжения' USING ERRCODE = '42501';
  END IF;
  IF coalesce(btrim(p_to), '') = '' OR p_from IS NULL THEN
    RAISE EXCEPTION 'Не задано имя ВОР' USING ERRCODE = '22023';
  END IF;
  IF p_from = p_to THEN
    RETURN jsonb_build_object('rates', 0, 'sources', 0);
  END IF;
  IF EXISTS (SELECT 1 FROM public.tender_vor_supply_rates a
             JOIN public.tender_vor_supply_rates b
               ON b.tender_id = a.tender_id AND b.estimate_name = p_to AND b.material_key = a.material_key
             WHERE a.tender_id = p_tender AND a.estimate_name = p_from) THEN
    RAISE EXCEPTION 'В ВОР «%» уже есть цены на те же материалы — перенести автоматически нельзя', p_to
      USING ERRCODE = '23505', HINT = 'supply_rename_overlap';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tender_supply_sources WHERE tender_id = p_tender AND estimate_name = p_to)
     AND EXISTS (SELECT 1 FROM public.tender_supply_sources WHERE tender_id = p_tender AND estimate_name = p_from) THEN
    RAISE EXCEPTION 'У ВОР «%» уже есть свой список позиций', p_to USING ERRCODE = '23505', HINT = 'supply_rename_overlap';
  END IF;
  UPDATE public.tender_vor_supply_rates SET estimate_name = p_to WHERE tender_id = p_tender AND estimate_name = p_from;
  GET DIAGNOSTICS v_rates = ROW_COUNT;
  UPDATE public.tender_supply_sources SET estimate_name = p_to WHERE tender_id = p_tender AND estimate_name = p_from;
  GET DIAGNOSTICS v_sources = ROW_COUNT;
  RETURN jsonb_build_object('rates', v_rates, 'sources', v_sources);
END
$$;

-- ── 9. Права ─────────────────────────────────────────────────────────────────────────────────────────
-- Расценки: одна широкая политика (Р2a — любой сотрудник всё) → чтение сотрудникам, запись — по праву.
DROP POLICY IF EXISTS "Allow all for authenticated users" ON public.tender_vor_supply_rates;
DROP POLICY IF EXISTS supply_rates_read ON public.tender_vor_supply_rates;
CREATE POLICY supply_rates_read ON public.tender_vor_supply_rates FOR SELECT TO authenticated
  USING ((SELECT public.osp_is_employee()));
DROP POLICY IF EXISTS supply_rates_insert ON public.tender_vor_supply_rates;
CREATE POLICY supply_rates_insert ON public.tender_vor_supply_rates FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.supply_can_edit()));
DROP POLICY IF EXISTS supply_rates_update ON public.tender_vor_supply_rates;
CREATE POLICY supply_rates_update ON public.tender_vor_supply_rates FOR UPDATE TO authenticated
  USING ((SELECT public.supply_can_edit())) WITH CHECK ((SELECT public.supply_can_edit()));
DROP POLICY IF EXISTS supply_rates_delete ON public.tender_vor_supply_rates;
CREATE POLICY supply_rates_delete ON public.tender_vor_supply_rates FOR DELETE TO authenticated
  USING ((SELECT public.supply_can_edit()));

ALTER TABLE public.tender_supply_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supply_sources_read ON public.tender_supply_sources;
CREATE POLICY supply_sources_read ON public.tender_supply_sources FOR SELECT TO authenticated
  USING ((SELECT public.osp_is_employee()));
DROP POLICY IF EXISTS supply_sources_insert ON public.tender_supply_sources;
CREATE POLICY supply_sources_insert ON public.tender_supply_sources FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.supply_can_edit()));
DROP POLICY IF EXISTS supply_sources_update ON public.tender_supply_sources;
CREATE POLICY supply_sources_update ON public.tender_supply_sources FOR UPDATE TO authenticated
  USING ((SELECT public.supply_can_edit())) WITH CHECK ((SELECT public.supply_can_edit()));
DROP POLICY IF EXISTS supply_sources_delete ON public.tender_supply_sources;
CREATE POLICY supply_sources_delete ON public.tender_supply_sources FOR DELETE TO authenticated
  USING ((SELECT public.supply_can_edit()));

ALTER TABLE public.tender_supply_rate_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supply_rate_log_read ON public.tender_supply_rate_log;
CREATE POLICY supply_rate_log_read ON public.tender_supply_rate_log FOR SELECT TO authenticated
  USING ((SELECT public.osp_is_employee()));

-- Новые таблицы, представление и функции Supabase по умолчанию выдаёт анониму — снимаем всё явно.
REVOKE ALL ON TABLE public.tender_supply_sources, public.tender_supply_rate_log, public.tender_supply_progress
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.tender_supply_rate_log_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tender_supply_sources TO authenticated;
GRANT SELECT ON TABLE public.tender_supply_rate_log, public.tender_supply_progress TO authenticated;
GRANT ALL ON TABLE public.tender_supply_sources, public.tender_supply_rate_log, public.tender_supply_progress TO service_role;
GRANT ALL ON SEQUENCE public.tender_supply_rate_log_id_seq TO service_role;

REVOKE ALL ON FUNCTION public.supply_norm_name(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_can_edit() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_rates_locked(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_estimate_rename(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tender_vor_supply_rates_compute() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tender_supply_guard() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tender_supply_rate_log_write() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tender_supply_sources_compute() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supply_norm_name(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_can_edit() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_rates_locked(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_estimate_rename(uuid, text, text) TO authenticated, service_role;

COMMIT;
