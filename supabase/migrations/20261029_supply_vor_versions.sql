-- Версии ВОР в расценке снабжением: сметный отдел обновил ВОР — цены не слетают, снабжение видит, что изменилось
-- (решения пользователя 21.10: цену переносить только при полном совпадении наименования, остальное — спрашивать,
-- уведомлять об изменении ВОР, подсвечивать что и где изменилось, старые расценки сохранять).
--
-- Раньше новая версия файла под другим именем («ВОР ОВ изм.1.xlsx») заводила отдельный ВОР «расценено 0 из N», а
-- цены оставались у прежнего — без способа их перенести; о самом обновлении никто не узнавал.
--
--  • tender_supply_revisions — версия ВОР: что изменилось в позициях (новые, убранные, другой объём, другая ед.
--    изм.) и снимок цен ВОР на момент изменения («старые расценки»). Пишет только триггер на списках позиций —
--    одинаково для страницы и службы osp-api. kind: update — новая версия (файл заменён, вкладка «ВОР»
--    перезагружена, принят новый файл), added — в тендере, где уже расценивают, появился ещё ВОР, removed — файл
--    ВОР удалён из «ВОРов и РД» (позиции и цены остались). Пока версию не отметили просмотренной (reviewed_at),
--    снабжению показываются изменения и уведомление. Без цен в тендере, без изменений в позициях и у завершённой
--    расценки — сразу просмотрена (сообщать не о чем).
--  • Цена переходит в новую версию сама только у той же позиции: тот же ВОР и то же наименование (ключ
--    supply_norm_name) — строка цены та же. Остальное решает человек: supply_rate_carry — перенести цену (и документ)
--    убранной позиции на другую позицию, дата расценки остаётся прежней; supply_vor_adopt — файл с другим именем —
--    новая версия прежнего ВОР (а не отдельный ВОР); «отдельный ВОР» — tender_supply_sources.separate_at.
--  • tender_supply_sources.prior_document_ids — прежние файлы ВОР: автозагрузка не заводит из старого файла
--    отдельный ВОР, если рядом лежит его новая версия.
--  • supply_revisions_review — отметить изменения просмотренными (право правки расценки).
--  • tender_supply_guard: удаление файла ВОР из «ВОРов и РД» у завершённой расценки больше не упирается в закрытие
--    (внешний ключ обнуляет ссылку на файл — это не правка расценки); раньше такой файл было не удалить.
--
-- Только добавление: прежние данные не меняются, цены не удаляются ничем, кроме решения человека. Повтор безопасен.
-- Требует 20261020–20261025. База нового портала — migration/yandex/20261029_supply_vor_versions.sql (те же функции,
-- права под одну учётку). Проверка: migration/backup/checks/20261029.sql. Откат:
-- migration/rollback/20261029_supply_vor_versions_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

-- ── 1. Списки позиций: прежние файлы и «отдельный ВОР» ───────────────────────────────────────────────
ALTER TABLE public.tender_supply_sources ADD COLUMN IF NOT EXISTS prior_document_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
ALTER TABLE public.tender_supply_sources ADD COLUMN IF NOT EXISTS separate_at timestamptz;
ALTER TABLE public.tender_supply_sources ADD COLUMN IF NOT EXISTS separate_by uuid;
COMMENT ON COLUMN public.tender_supply_sources.prior_document_ids IS
  'Прежние файлы ВОР этого списка (заменены новой версией): автозагрузка не заводит из них отдельный ВОР';
COMMENT ON COLUMN public.tender_supply_sources.separate_at IS
  'Снабжение ответило: файл — отдельный ВОР, а не новая версия другого (больше не спрашивать)';

-- Расчёт списка (20261020) + прежние файлы и ответ «отдельный ВОР»: значения ставит база, прямой правкой из списка
-- прежних файлов не убрать и автора ответа не подменить.
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
  IF TG_OP = 'INSERT' THEN
    NEW.prior_document_ids := '{}'::uuid[];
    NEW.separate_at := NULL;
    NEW.separate_by := NULL;
  ELSE
    NEW.prior_document_ids := array_remove(ARRAY(
      SELECT DISTINCT x FROM unnest(OLD.prior_document_ids || coalesce(NEW.prior_document_ids, '{}'::uuid[])
        || CASE WHEN OLD.s3_document_id IS NOT NULL AND NEW.s3_document_id IS NOT NULL AND NEW.s3_document_id <> OLD.s3_document_id
                THEN ARRAY[OLD.s3_document_id] ELSE '{}'::uuid[] END) AS t(x)
      WHERE x IS NOT NULL ORDER BY x), NEW.s3_document_id);
    IF NEW.separate_at IS DISTINCT FROM OLD.separate_at THEN
      NEW.separate_by := CASE WHEN NEW.separate_at IS NOT NULL THEN auth.uid() END;
      NEW.separate_at := CASE WHEN NEW.separate_at IS NOT NULL THEN now() END;
    ELSE
      NEW.separate_by := OLD.separate_by;
    END IF;
  END IF;
  NEW.row_version := CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE OLD.row_version + 1 END;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- Закрытие расценки (20261020) пропускает удаление файла ВОР из «ВОРов и РД»: внешний ключ обнуляет ссылку на файл в
-- списке позиций, позиции и цены остаются — это не правка расценки. Раньше у тендера с завершённым тендером на
-- материалы файл ВОР было не удалить: отложенный триггер закрытия срабатывает не внутри каскада (pg_trigger_depth = 1).
CREATE OR REPLACE FUNCTION public.tender_supply_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_skip text[] := ARRAY['row_version', 'updated_at', 'updated_by', 'parsed_at', 'parsed_by'];
  v_file text[] := ARRAY['s3_document_id', 'prior_document_ids'];
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - v_skip) = (to_jsonb(OLD) - v_skip) THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND to_jsonb(OLD)->>'s3_document_id' IS NOT NULL AND to_jsonb(NEW)->>'s3_document_id' IS NULL
     AND (to_jsonb(NEW) - v_skip - v_file) = (to_jsonb(OLD) - v_skip - v_file) THEN
    RETURN NULL;
  END IF;
  IF (TG_OP <> 'INSERT' AND public.supply_rates_locked(OLD.tender_id))
     OR (TG_OP <> 'DELETE' AND public.supply_rates_locked(NEW.tender_id)) THEN
    RAISE EXCEPTION 'Тендер на материалы завершён — расценки снабжения только для чтения. Чтобы изменить, верните тендеру на материалы прежний статус.'
      USING ERRCODE = 'P0001', HINT = 'supply_locked';
  END IF;
  RETURN NULL;
END
$$;

-- ── 2. Версии ВОР ────────────────────────────────────────────────────────────────────────────────────
-- changes — [{ op: added | removed | volume | unit, k, name, unit, volume, old_unit, old_volume, rate_id, price, total }]:
-- unit / volume — в новой версии, old_* — в прежней, цена — позиции на момент изменения. prices — снимок цен ВОР
-- на момент изменения: [{ rate_id, k, name, unit, volume (прежний), price, total, input, date, source_kind }].
CREATE TABLE IF NOT EXISTS public.tender_supply_revisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tender_id uuid NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
  estimate_name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('update', 'added', 'removed')),
  source text,
  old_document_id uuid,
  new_document_id uuid,
  old_file_name text,
  new_file_name text,
  uploaded_by_name text,
  uploaded_at timestamptz,
  positions_before integer NOT NULL DEFAULT 0,
  positions_after integer NOT NULL DEFAULT 0,
  added integer NOT NULL DEFAULT 0,
  removed integer NOT NULL DEFAULT 0,
  volume_changed integer NOT NULL DEFAULT 0,
  unit_changed integer NOT NULL DEFAULT 0,
  priced_removed integer NOT NULL DEFAULT 0,
  changes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(changes) = 'array'),
  prices jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(prices) = 'array'),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid
);
CREATE INDEX IF NOT EXISTS tender_supply_revisions_tender_idx ON public.tender_supply_revisions (tender_id, id DESC);
CREATE INDEX IF NOT EXISTS tender_supply_revisions_unreviewed_idx ON public.tender_supply_revisions (tender_id) WHERE reviewed_at IS NULL;
COMMENT ON TABLE public.tender_supply_revisions IS
  'Версии ВОР в расценке снабжением: что изменилось в позициях и снимок цен на момент изменения. Пишет только триггер на tender_supply_sources';

-- Позиции списка по ключу наименования — как mergePositions страницы: строки одного ключа складываются, объёмы — по
-- ед. изм. в едином виде (kp_norm_unit). unit — как в ВОР (через запятую, если единиц несколько), volume — только
-- при одной единице; unit_sig / vol_sig — подписи для сравнения версий.
CREATE OR REPLACE FUNCTION public.supply_positions_by_key(p_positions jsonb)
  RETURNS TABLE (k text, name text, unit text, volume numeric, unit_sig text, vol_sig text)
  LANGUAGE sql IMMUTABLE
  SET search_path = public, pg_temp
AS $$
  WITH e AS (
    SELECT x.o, x.e->>'k' AS k, x.e->>'name' AS name, u.u
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_positions) = 'array' THEN p_positions ELSE '[]'::jsonb END)
           WITH ORDINALITY AS x(e, o)
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(x.e->'units') = 'array' THEN x.e->'units'
                                                  ELSE jsonb_build_array(jsonb_build_object('unit', x.e->'unit', 'volume', x.e->'volume')) END) AS u(u)
    WHERE jsonb_typeof(x.e) = 'object' AND coalesce(x.e->>'k', '') <> ''
  ),
  nm AS (SELECT DISTINCT ON (e.k) e.k, e.name FROM e ORDER BY e.k, e.o),
  pu AS (
    SELECT e.k, public.kp_norm_unit(nullif(btrim(e.u->>'unit'), '')) AS uk, min(e.o) AS o,
           (array_agg(nullif(btrim(e.u->>'unit'), '') ORDER BY e.o))[1] AS unit,
           trim_scale(sum(CASE WHEN jsonb_typeof(e.u->'volume') = 'number' THEN (e.u->>'volume')::numeric END)) AS volume
    FROM e GROUP BY e.k, public.kp_norm_unit(nullif(btrim(e.u->>'unit'), ''))
  )
  SELECT pu.k, nm.name,
         string_agg(coalesce(pu.unit, ''), ', ' ORDER BY pu.o),
         CASE WHEN count(*) = 1 THEN max(pu.volume) END,
         string_agg(pu.uk, '|' ORDER BY pu.uk),
         string_agg(pu.uk || '=' || coalesce(pu.volume::text, ''), ';' ORDER BY pu.uk)
  FROM pu JOIN nm ON nm.k = pu.k
  GROUP BY pu.k, nm.name
$$;

-- Версия ВОР — после записи списка позиций. Новая версия: файл заменён другим (в том числе удалённый — новым), позиции
-- стали из файла вместо вкладки «ВОР», вкладка «ВОР» перезагружена (её подпись, без признака разбора vor/vor2).
-- Не версия: перечитали тем же разбором, указали другой лист или колонки, перенесли ВОР на другое имя (его версии
-- переходят вместе с ним). Список удалён (пустой или принят новой версией другого ВОР) — его изменения смотреть не к
-- чему: отмечаются просмотренными.
CREATE OR REPLACE FUNCTION public.tender_supply_revision_write() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_kind text;
  v_review boolean;
  v_by text;
  v_at timestamptz;
  v_changes jsonb := '[]'::jsonb;
  v_prices jsonb := '[]'::jsonb;
  v_added integer := 0;
  v_removed integer := 0;
  v_volume integer := 0;
  v_unit integer := 0;
  v_priced_removed integer := 0;
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.tender_supply_revisions SET reviewed_at = now()
     WHERE tender_id = OLD.tender_id AND estimate_name = OLD.estimate_name AND reviewed_at IS NULL;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.estimate_name IS DISTINCT FROM OLD.estimate_name THEN
    UPDATE public.tender_supply_revisions SET estimate_name = NEW.estimate_name
     WHERE tender_id = NEW.tender_id AND estimate_name = OLD.estimate_name;
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    v_kind := 'added';
  ELSIF OLD.source = 'vor_file' AND NEW.source = 'vor_file' AND OLD.s3_document_id IS NOT NULL AND NEW.s3_document_id IS NULL THEN
    v_kind := 'removed';
  ELSIF (NEW.s3_document_id IS NOT NULL AND NEW.s3_document_id IS DISTINCT FROM OLD.s3_document_id)
     OR NEW.source IS DISTINCT FROM OLD.source
     OR (NEW.source = 'vor_tab' AND regexp_replace(coalesce(NEW.source_version, ''), '^vor2?:', '')
                                    <> regexp_replace(coalesce(OLD.source_version, ''), '^vor2?:', '')) THEN
    v_kind := 'update';
  ELSE
    RETURN NULL;
  END IF;

  -- Сообщать есть кому, только если в тендере уже расценивают (есть цены) и расценка не закрыта.
  v_review := EXISTS (SELECT 1 FROM public.tender_vor_supply_rates r WHERE r.tender_id = NEW.tender_id)
              AND NOT public.supply_rates_locked(NEW.tender_id);
  IF v_kind = 'added' AND NOT v_review THEN
    RETURN NULL;
  END IF;
  IF v_kind <> 'removed' AND NEW.s3_document_id IS NOT NULL THEN
    SELECT d.uploaded_by_name, d.created_at INTO v_by, v_at FROM public.s3_documents d WHERE d.id = NEW.s3_document_id;
  END IF;

  IF v_kind = 'update' THEN
    WITH o AS MATERIALIZED (SELECT * FROM public.supply_positions_by_key(OLD.positions)),
         n AS MATERIALIZED (SELECT * FROM public.supply_positions_by_key(NEW.positions)),
         d AS (
           SELECT coalesce(n.k, o.k) AS k,
                  CASE WHEN o.k IS NULL THEN 'added' WHEN n.k IS NULL THEN 'removed'
                       WHEN o.unit_sig <> n.unit_sig THEN 'unit'
                       WHEN o.vol_sig <> n.vol_sig THEN 'volume' END AS op,
                  coalesce(n.name, o.name) AS name, n.unit, n.volume, o.unit AS old_unit, o.volume AS old_volume
           FROM o FULL JOIN n ON n.k = o.k
         ),
         c AS (
           SELECT d.*, p.id AS rate_id, p.price, p.total
           FROM d
           LEFT JOIN LATERAL (
             SELECT r.id, coalesce(r.supply_price_exact, r.supply_price) AS price, r.supply_total AS total
             FROM public.tender_vor_supply_rates r
             WHERE r.tender_id = NEW.tender_id AND r.estimate_name = NEW.estimate_name AND r.material_key = d.k
             ORDER BY r.updated_at DESC NULLS LAST, r.id
             LIMIT 1
           ) p ON true
           WHERE d.op IS NOT NULL
         )
    SELECT coalesce((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                       'op', c.op, 'k', c.k, 'name', c.name, 'unit', c.unit, 'volume', c.volume,
                       'old_unit', CASE WHEN c.op <> 'added' THEN c.old_unit END,
                       'old_volume', CASE WHEN c.op <> 'added' THEN c.old_volume END,
                       'rate_id', c.rate_id, 'price', c.price, 'total', c.total)) ORDER BY c.op, c.name) FROM c), '[]'::jsonb),
           (SELECT count(*) FROM c WHERE c.op = 'added'),
           (SELECT count(*) FROM c WHERE c.op = 'removed'),
           (SELECT count(*) FROM c WHERE c.op = 'volume'),
           (SELECT count(*) FROM c WHERE c.op = 'unit'),
           (SELECT count(*) FROM c WHERE c.op = 'removed' AND c.rate_id IS NOT NULL),
           coalesce((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                       'rate_id', r.id, 'k', r.material_key, 'name', r.material_name, 'unit', r.unit, 'volume', o.volume,
                       'price', coalesce(r.supply_price_exact, r.supply_price), 'total', r.supply_total, 'input', r.price_input,
                       'date', r.price_date, 'source_kind', r.source_kind)) ORDER BY r.material_name, r.id)
                     FROM public.tender_vor_supply_rates r LEFT JOIN o ON o.k = r.material_key
                     WHERE r.tender_id = NEW.tender_id AND r.estimate_name = NEW.estimate_name), '[]'::jsonb)
      INTO v_changes, v_added, v_removed, v_volume, v_unit, v_priced_removed, v_prices;
  ELSIF v_kind = 'added' THEN
    v_added := NEW.positions_count;
  END IF;

  INSERT INTO public.tender_supply_revisions (tender_id, estimate_name, kind, source, old_document_id, new_document_id,
    old_file_name, new_file_name, uploaded_by_name, uploaded_at, positions_before, positions_after,
    added, removed, volume_changed, unit_changed, priced_removed, changes, prices, created_by, reviewed_at)
  VALUES (NEW.tender_id, NEW.estimate_name, v_kind, NEW.source,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.s3_document_id END, NEW.s3_document_id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.file_name END, CASE WHEN v_kind <> 'removed' THEN NEW.file_name END,
    v_by, v_at, CASE WHEN TG_OP = 'UPDATE' THEN OLD.positions_count ELSE 0 END, NEW.positions_count,
    v_added, v_removed, v_volume, v_unit, v_priced_removed, v_changes, v_prices, auth.uid(),
    CASE WHEN NOT v_review OR (v_kind = 'update' AND v_added + v_removed + v_volume + v_unit = 0) THEN now() END);
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS tender_supply_sources_revision ON public.tender_supply_sources;
CREATE TRIGGER tender_supply_sources_revision
  AFTER INSERT OR UPDATE OR DELETE ON public.tender_supply_sources
  FOR EACH ROW EXECUTE FUNCTION public.tender_supply_revision_write();

-- ── 3. Решения человека ──────────────────────────────────────────────────────────────────────────────
-- Файл ВОР с другим именем — новая версия прежнего ВОР p_old (а не отдельный ВОР p_new). Прежний ВОР получает файл и
-- позиции нового (триггер записывает версию: что изменилось и прежние цены); цены и документы нового ВОР переходят в
-- прежний: подставленная из другого тендера цена уступает своей цене прежнего ВОР, введённая для новой версии —
-- заменяет прежнюю (та остаётся в снимке цен версии и в журнале). Список нового ВОР удаляется. С правами вызывающего:
-- правила по строкам и закрытие действуют.
CREATE OR REPLACE FUNCTION public.supply_vor_adopt(p_tender uuid, p_new text, p_old text) RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_new public.tender_supply_sources%ROWTYPE;
  v_old public.tender_supply_sources%ROWTYPE;
  v_dropped integer;
  v_replaced integer;
  v_moved integer;
  v_links integer;
BEGIN
  IF NOT public.supply_can_edit() THEN
    RAISE EXCEPTION 'Нет права менять расценки снабжения' USING ERRCODE = '42501';
  END IF;
  IF p_new IS NULL OR p_old IS NULL OR p_new = p_old THEN
    RAISE EXCEPTION 'Не заданы ВОР' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_new FROM public.tender_supply_sources WHERE tender_id = p_tender AND estimate_name = p_new FOR UPDATE;
  SELECT * INTO v_old FROM public.tender_supply_sources WHERE tender_id = p_tender AND estimate_name = p_old FOR UPDATE;
  IF v_new.id IS NULL OR v_old.id IS NULL THEN
    RAISE EXCEPTION 'ВОР уже изменили — обновите страницу' USING ERRCODE = '23505', HINT = 'supply_adopt_gone';
  END IF;
  IF v_new.source <> 'vor_file' OR v_new.s3_document_id IS NULL THEN
    RAISE EXCEPTION 'Новой версией ВОР может быть только файл из «ВОРов и РД»' USING ERRCODE = '22023';
  END IF;

  UPDATE public.tender_supply_sources
     SET source = 'vor_file', s3_document_id = v_new.s3_document_id, file_name = v_new.file_name, sheet_name = v_new.sheet_name,
         column_map = v_new.column_map, source_version = v_new.source_version, positions = v_new.positions,
         prior_document_ids = v_old.prior_document_ids || v_new.prior_document_ids
   WHERE id = v_old.id;

  DELETE FROM public.tender_vor_supply_rates a
   WHERE a.tender_id = p_tender AND a.estimate_name = p_new AND a.source_kind = 'auto'
     AND EXISTS (SELECT 1 FROM public.tender_vor_supply_rates b
                 WHERE b.tender_id = p_tender AND b.estimate_name = p_old AND b.material_key = a.material_key);
  GET DIAGNOSTICS v_dropped = ROW_COUNT;
  DELETE FROM public.tender_vor_supply_rates b
   WHERE b.tender_id = p_tender AND b.estimate_name = p_old
     AND EXISTS (SELECT 1 FROM public.tender_vor_supply_rates a
                 WHERE a.tender_id = p_tender AND a.estimate_name = p_new AND a.material_key = b.material_key);
  GET DIAGNOSTICS v_replaced = ROW_COUNT;
  UPDATE public.tender_vor_supply_rates SET estimate_name = p_old WHERE tender_id = p_tender AND estimate_name = p_new;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  DELETE FROM public.tender_supply_links b
   WHERE b.tender_id = p_tender AND b.estimate_name = p_old
     AND EXISTS (SELECT 1 FROM public.tender_supply_links a
                 WHERE a.tender_id = p_tender AND a.estimate_name = p_new AND a.material_key = b.material_key);
  UPDATE public.tender_supply_links SET estimate_name = p_old WHERE tender_id = p_tender AND estimate_name = p_new;
  GET DIAGNOSTICS v_links = ROW_COUNT;

  DELETE FROM public.tender_supply_sources WHERE id = v_new.id;
  RETURN jsonb_build_object('moved', v_moved, 'replaced', v_replaced, 'dropped', v_dropped, 'links', v_links);
END
$$;

-- Перенести цену (и документ) убранной позиции на другую позицию ВОР — тот же материал под другим наименованием.
-- Строка цены та же: день расценки, автор и история сохраняются; ед. изм. — новой позиции. У позиции уже своя цена —
-- отказ; подставленная из другого тендера — уступает. Версия строки — защита от правки поверх чужой.
CREATE OR REPLACE FUNCTION public.supply_rate_carry(p_rate uuid, p_version integer, p_estimate text, p_name text, p_unit text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_rate public.tender_vor_supply_rates%ROWTYPE;
  v_key text := public.supply_norm_name(p_name);
  v_dropped uuid[];
  v_links integer;
BEGIN
  IF NOT public.supply_can_edit() THEN
    RAISE EXCEPTION 'Нет права менять расценки снабжения' USING ERRCODE = '42501';
  END IF;
  IF coalesce(btrim(p_name), '') = '' OR coalesce(btrim(p_estimate), '') = '' OR v_key = '' THEN
    RAISE EXCEPTION 'Не задана позиция' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_rate FROM public.tender_vor_supply_rates WHERE id = p_rate FOR UPDATE;
  IF v_rate.id IS NULL OR v_rate.row_version IS DISTINCT FROM p_version THEN
    RAISE EXCEPTION 'Эту цену уже изменили — обновите страницу' USING ERRCODE = '23505', HINT = 'supply_carry_stale';
  END IF;
  IF v_rate.estimate_name = p_estimate AND v_rate.material_key = v_key THEN
    RETURN jsonb_build_object('rate', to_jsonb(v_rate), 'dropped', '[]'::jsonb, 'links', 0);
  END IF;
  IF EXISTS (SELECT 1 FROM public.tender_vor_supply_rates x
             WHERE x.tender_id = v_rate.tender_id AND x.estimate_name = p_estimate AND x.material_key = v_key
               AND x.source_kind IS DISTINCT FROM 'auto') THEN
    RAISE EXCEPTION 'У позиции «%» уже есть своя цена', p_name USING ERRCODE = '23505', HINT = 'supply_carry_taken';
  END IF;
  WITH gone AS (
    DELETE FROM public.tender_vor_supply_rates x
     WHERE x.tender_id = v_rate.tender_id AND x.estimate_name = p_estimate AND x.material_key = v_key
    RETURNING x.id
  )
  SELECT coalesce(array_agg(id), '{}'::uuid[]) INTO v_dropped FROM gone;

  UPDATE public.tender_supply_links l SET estimate_name = p_estimate, material_name = p_name
   WHERE l.tender_id = v_rate.tender_id AND l.estimate_name = v_rate.estimate_name AND l.material_key = v_rate.material_key
     AND NOT EXISTS (SELECT 1 FROM public.tender_supply_links t
                     WHERE t.tender_id = v_rate.tender_id AND t.estimate_name = p_estimate AND t.material_key = v_key);
  GET DIAGNOSTICS v_links = ROW_COUNT;

  UPDATE public.tender_vor_supply_rates
     SET estimate_name = p_estimate, material_name = btrim(p_name), unit = coalesce(nullif(btrim(p_unit), ''), unit)
   WHERE id = v_rate.id
  RETURNING * INTO v_rate;
  RETURN jsonb_build_object('rate', to_jsonb(v_rate), 'dropped', to_jsonb(v_dropped), 'links', v_links);
END
$$;

-- Изменения ВОР просмотрены: подсветка и уведомление снимаются (версия и снимок цен остаются в истории).
CREATE OR REPLACE FUNCTION public.supply_revisions_review(p_tender uuid, p_ids bigint[]) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT public.supply_can_edit() THEN
    RAISE EXCEPTION 'Нет права менять расценки снабжения' USING ERRCODE = '42501';
  END IF;
  UPDATE public.tender_supply_revisions SET reviewed_at = now(), reviewed_by = auth.uid()
   WHERE tender_id = p_tender AND id = ANY (coalesce(p_ids, '{}'::bigint[])) AND reviewed_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

-- ── 4. Права ─────────────────────────────────────────────────────────────────────────────────────────
-- Версии читает сотрудник (как расценки); пишут только триггер и отметка «просмотрено» (служебные функции).
ALTER TABLE public.tender_supply_revisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supply_revisions_read ON public.tender_supply_revisions;
CREATE POLICY supply_revisions_read ON public.tender_supply_revisions FOR SELECT TO authenticated
  USING ((SELECT public.osp_is_employee()));

REVOKE ALL ON TABLE public.tender_supply_revisions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.tender_supply_revisions_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.tender_supply_revisions TO authenticated;
GRANT ALL ON TABLE public.tender_supply_revisions TO service_role;
GRANT ALL ON SEQUENCE public.tender_supply_revisions_id_seq TO service_role;

REVOKE ALL ON FUNCTION public.supply_positions_by_key(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tender_supply_revision_write() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_vor_adopt(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_rate_carry(uuid, integer, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_revisions_review(uuid, bigint[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supply_positions_by_key(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supply_vor_adopt(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_rate_carry(uuid, integer, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_revisions_review(uuid, bigint[]) TO authenticated, service_role;

COMMIT;
