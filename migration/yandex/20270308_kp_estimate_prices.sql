-- Смета КП / ПЗ объекта: цены, изменённые администратором (просьба пользователя 27.11.2026: «в будущем возможно изменение
-- объёмов, общей цены… нужна возможность для админа подгрузки документа, чтобы сопоставлять позиции и менять их цену, чтобы она
-- в дальнейшем рассчитывалась и на позиции внутри, уменьшенной / увеличенной; вручную менять цены — отдельным режимом; доступ
-- только у админа»). Тело supabase/migrations/20270308_kp_estimate_prices.sql: те же таблицы и функции, иначе — права под одну
-- учётку.
--
-- Строки сметы после загрузки по-прежнему не меняются (kp_estimate_rows — только черновик). Новая цена — отдельной записью:
--  • kp_estimate_prices — одна на строку: у позиции — новая цена за единицу (unit_price, по желанию — материалы и работы;
--    без «Кол-ва (ГП)» — сумма total),
--    у группы, раздела и укрупнённой позиции — новая сумма (total): её состав пересчитывается пропорционально (уменьшается
--    или увеличивается), своя цена вложенной позиции закреплена — остаток суммы делится на остальные (расчёт —
--    src/utils/kpEstimatePrices.js);
--  • kp_estimate_price_docs — применённые документы (ДС, ДГП, ПСДЦ, этап файла): название, этап, кто и когда, сводка.
-- Пишут только служебные функции kp_estimate_price_apply / kp_estimate_price_reset — администратор (is_admin()) и объект
-- в охвате; таблицам вошедший может только читать (как смету). Каждая правка — в историю сметы (kp_estimate_log, entity
-- 'price'). Новая версия файла (kp_estimate_activate) переносит цены, как отметки: на строку с тем же ключом.
-- Требует 20270215_kp_estimate. Только добавление, повтор безопасен.

-- ── Таблицы ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kp_estimate_price_docs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id uuid NOT NULL REFERENCES public.kp_estimates(id) ON DELETE CASCADE,
  object_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  stage text CHECK (length(stage) <= 300),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  applied_by uuid,
  applied_by_name text,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kp_estimate_price_docs_estimate_idx ON public.kp_estimate_price_docs (estimate_id, applied_at DESC);
COMMENT ON TABLE public.kp_estimate_price_docs IS
  'Документы, по которым администратор изменил цены сметы КП / ПЗ: название, этап, кто и когда, сводка';

CREATE TABLE IF NOT EXISTS public.kp_estimate_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id uuid NOT NULL REFERENCES public.kp_estimates(id) ON DELETE CASCADE,
  row_id uuid NOT NULL UNIQUE REFERENCES public.kp_estimate_rows(id) ON DELETE CASCADE,
  object_id uuid NOT NULL,
  unit_price numeric,
  unit_materials numeric,
  unit_works numeric,
  total numeric,
  doc_qty numeric CHECK (doc_qty >= 0),
  source text NOT NULL CHECK (source IN ('manual', 'document')),
  doc_id uuid REFERENCES public.kp_estimate_price_docs(id) ON DELETE SET NULL,
  note text CHECK (length(note) <= 2000),
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_by_name text,
  CONSTRAINT kp_estimate_prices_value CHECK (unit_price IS NOT NULL OR total IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS kp_estimate_prices_estimate_idx ON public.kp_estimate_prices (estimate_id);
COMMENT ON TABLE public.kp_estimate_prices IS
  'Цена строки сметы КП / ПЗ, изменённая администратором: у позиции — за единицу, у группы — сумма (состав пропорционально)';

-- История: правки цен — entity 'price' (строка), применённый документ — 'price' без строки, action 'import'.
ALTER TABLE public.kp_estimate_log DROP CONSTRAINT IF EXISTS kp_estimate_log_entity_check;
ALTER TABLE public.kp_estimate_log ADD CONSTRAINT kp_estimate_log_entity_check
  CHECK (entity IN ('estimate', 'mark', 'allocation', 'price'));

-- ── Запись цен: только администратор ─────────────────────────────────────────────────────────────────
-- p_items — [{ row_id, unit_price | unit_materials + unit_works (позиция) | total (группа), doc_qty, note, row_version,
-- actual_qty, actual_reason }]. row_version — для правки вручную: какую версию цены видел администратор (null — цены не было);
-- коллега успел раньше — строка не пишется, её id в conflicts. actual_qty — «Актуальный» объём из документа (отметка строки,
-- с её историей). p_doc — { title, stage, summary } (новый документ) или { id } (продолжение того же документа порцией),
-- null — правка вручную. Ответ: { doc_id, applied, same, conflicts, skipped, volumes }.
CREATE OR REPLACE FUNCTION public.kp_estimate_price_apply(p_estimate uuid, p_doc jsonb, p_items jsonb) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_est public.kp_estimates%ROWTYPE;
  v_row public.kp_estimate_rows%ROWTYPE;
  v_old public.kp_estimate_prices%ROWTYPE;
  v_item jsonb;
  v_doc uuid;
  v_doc_title text;
  v_exists boolean;
  v_group boolean;
  v_unit numeric;
  v_mat numeric;
  v_work numeric;
  v_total numeric;
  v_qty numeric;
  v_note text;
  v_changes jsonb;
  v_applied integer := 0;
  v_same integer := 0;
  v_volumes integer := 0;
  v_conflicts jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_name text := public.kp_estimate_actor_name();
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Нужен вход' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'kp_estimate_price_admin: цены сметы меняет только администратор' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_est FROM public.kp_estimates WHERE id = p_estimate;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Смета не найдена' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.psdc_object_in_scope(v_est.object_id) THEN
    RAISE EXCEPTION 'Нет доступа к смете этого объекта' USING ERRCODE = '42501';
  END IF;
  IF v_est.status <> 'active' THEN
    RAISE EXCEPTION 'kp_estimate_not_active: смета заменена новой версией — правка закрыта' USING ERRCODE = 'P0001';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 5000 THEN
    RAISE EXCEPTION 'kp_estimate_price_items: нужен список цен, не больше 5000 строк за раз' USING ERRCODE = '22023';
  END IF;

  IF p_doc IS NOT NULL AND jsonb_typeof(p_doc) = 'object' THEN
    IF p_doc ? 'id' THEN
      SELECT d.id, d.title INTO v_doc, v_doc_title FROM public.kp_estimate_price_docs d
      WHERE d.id = (p_doc ->> 'id')::uuid AND d.estimate_id = p_estimate AND d.applied_by = auth.uid();
      IF v_doc IS NULL THEN
        RAISE EXCEPTION 'kp_estimate_price_doc: документ цен не найден' USING ERRCODE = 'P0002';
      END IF;
    ELSE
      v_doc_title := left(coalesce(nullif(btrim(p_doc ->> 'title'), ''), 'Документ'), 500);
      INSERT INTO public.kp_estimate_price_docs (estimate_id, object_id, title, stage, summary, applied_by, applied_by_name)
      VALUES (p_estimate, v_est.object_id, v_doc_title, nullif(left(btrim(coalesce(p_doc ->> 'stage', '')), 300), ''),
              CASE WHEN jsonb_typeof(p_doc -> 'summary') = 'object' THEN p_doc -> 'summary' ELSE '{}'::jsonb END, auth.uid(), v_name)
      RETURNING id INTO v_doc;
    END IF;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_row FROM public.kp_estimate_rows WHERE id = (v_item ->> 'row_id')::uuid AND estimate_id = p_estimate;
    IF NOT FOUND THEN
      v_skipped := v_skipped || jsonb_build_array(v_item ->> 'row_id');
      CONTINUE;
    END IF;
    v_group := EXISTS (SELECT 1 FROM public.kp_estimate_rows c WHERE c.estimate_id = p_estimate AND c.parent_row_no = v_row.row_no);
    v_unit := (v_item ->> 'unit_price')::numeric;
    v_mat := (v_item ->> 'unit_materials')::numeric;
    v_work := (v_item ->> 'unit_works')::numeric;
    v_total := (v_item ->> 'total')::numeric;
    v_qty := (v_item ->> 'doc_qty')::numeric;
    v_note := nullif(left(btrim(coalesce(v_item ->> 'note', '')), 2000), '');
    IF v_group THEN
      -- Группа, раздел, укрупнённая позиция — новой суммой: состав пересчитывается пропорционально.
      v_unit := NULL; v_mat := NULL; v_work := NULL;
      IF v_total IS NULL THEN
        v_skipped := v_skipped || jsonb_build_array(v_row.id);
        CONTINUE;
      END IF;
    ELSE
      -- Позиция — ценой за единицу; без «Кол-ва (ГП)» (у «События 6.2» — 2 позиции со стоимостью ДГП) — суммой.
      IF v_mat IS NOT NULL OR v_work IS NOT NULL THEN
        v_unit := coalesce(v_mat, 0) + coalesce(v_work, 0);
      END IF;
      IF v_unit IS NOT NULL THEN
        v_total := NULL;
      END IF;
      IF v_row.kind NOT IN ('position', 'adjust') OR (v_unit IS NULL AND v_total IS NULL)
         OR (v_unit IS NULL AND coalesce((v_row.kp ->> 'qty_gp')::numeric, (v_row.pz ->> 'qty_gp')::numeric, 0) <> 0) THEN
        v_skipped := v_skipped || jsonb_build_array(v_row.id);
        CONTINUE;
      END IF;
    END IF;

    SELECT * INTO v_old FROM public.kp_estimate_prices WHERE row_id = v_row.id FOR UPDATE;
    v_exists := FOUND;
    IF v_item ? 'row_version' AND (CASE WHEN v_exists THEN v_old.row_version END) IS DISTINCT FROM (v_item ->> 'row_version')::integer THEN
      v_conflicts := v_conflicts || jsonb_build_array(v_row.id);
      CONTINUE;
    END IF;

    v_changes := '{}'::jsonb;
    IF (CASE WHEN v_exists THEN v_old.unit_price END) IS DISTINCT FROM v_unit THEN
      v_changes := v_changes || jsonb_build_object('unit_price', jsonb_build_object('old', CASE WHEN v_exists THEN v_old.unit_price END, 'new', v_unit));
    END IF;
    IF (CASE WHEN v_exists THEN v_old.unit_materials END) IS DISTINCT FROM v_mat THEN
      v_changes := v_changes || jsonb_build_object('unit_materials', jsonb_build_object('old', CASE WHEN v_exists THEN v_old.unit_materials END, 'new', v_mat));
    END IF;
    IF (CASE WHEN v_exists THEN v_old.unit_works END) IS DISTINCT FROM v_work THEN
      v_changes := v_changes || jsonb_build_object('unit_works', jsonb_build_object('old', CASE WHEN v_exists THEN v_old.unit_works END, 'new', v_work));
    END IF;
    IF (CASE WHEN v_exists THEN v_old.total END) IS DISTINCT FROM v_total THEN
      v_changes := v_changes || jsonb_build_object('total', jsonb_build_object('old', CASE WHEN v_exists THEN v_old.total END, 'new', v_total));
    END IF;
    IF (CASE WHEN v_exists THEN v_old.note END) IS DISTINCT FROM v_note THEN
      v_changes := v_changes || jsonb_build_object('note', jsonb_build_object('old', CASE WHEN v_exists THEN v_old.note END, 'new', v_note));
    END IF;

    IF v_changes = '{}'::jsonb THEN
      v_same := v_same + 1;
    ELSE
      IF v_exists THEN
        UPDATE public.kp_estimate_prices SET unit_price = v_unit, unit_materials = v_mat, unit_works = v_work, total = v_total,
          doc_qty = v_qty, source = CASE WHEN v_doc IS NULL THEN 'manual' ELSE 'document' END, doc_id = v_doc, note = v_note,
          row_version = row_version + 1, updated_at = now(), updated_by = auth.uid(), updated_by_name = v_name
        WHERE id = v_old.id;
      ELSE
        INSERT INTO public.kp_estimate_prices (estimate_id, row_id, object_id, unit_price, unit_materials, unit_works, total, doc_qty,
          source, doc_id, note, updated_by, updated_by_name)
        VALUES (p_estimate, v_row.id, v_est.object_id, v_unit, v_mat, v_work, v_total, v_qty,
          CASE WHEN v_doc IS NULL THEN 'manual' ELSE 'document' END, v_doc, v_note, auth.uid(), v_name);
      END IF;
      IF v_doc IS NOT NULL THEN
        v_changes := v_changes || jsonb_build_object('_doc', jsonb_build_object('id', v_doc, 'title', v_doc_title));
      END IF;
      INSERT INTO public.kp_estimate_log (estimate_id, object_id, row_id, row_label, entity, action, changes, changed_by, changed_by_name)
      VALUES (p_estimate, v_est.object_id, v_row.id,
              left(concat_ws(' ', coalesce(v_row.code, CASE WHEN v_row.pos_no IS NOT NULL THEN '№ ' || v_row.pos_no END), v_row.name), 300),
              'price', CASE WHEN v_exists THEN 'update' ELSE 'insert' END, v_changes, auth.uid(), v_name);
      v_applied := v_applied + 1;
    END IF;

    -- Объём из документа — в «Актуальный» (отметка строки: её триггеры проверят строку и запишут историю).
    IF v_item ? 'actual_qty' AND (v_item ->> 'actual_qty') IS NOT NULL AND v_row.unit IS NOT NULL
       AND v_row.kind IN ('position', 'aggregate', 'adjust') AND (v_item ->> 'actual_qty')::numeric >= 0 THEN
      INSERT INTO public.kp_estimate_marks AS mk (estimate_id, object_id, row_id, actual_qty, actual_reason)
      VALUES (p_estimate, v_est.object_id, v_row.id, (v_item ->> 'actual_qty')::numeric,
              nullif(left(btrim(coalesce(v_item ->> 'actual_reason', '')), 2000), ''))
      ON CONFLICT (row_id) DO UPDATE SET actual_qty = EXCLUDED.actual_qty,
        actual_reason = coalesce(EXCLUDED.actual_reason, mk.actual_reason)
      WHERE mk.actual_qty IS DISTINCT FROM EXCLUDED.actual_qty;
      IF FOUND THEN
        v_volumes := v_volumes + 1;
      END IF;
    END IF;
  END LOOP;

  IF v_doc IS NOT NULL THEN
    UPDATE public.kp_estimate_price_docs SET summary = summary || jsonb_build_object(
      'applied', coalesce((summary ->> 'applied')::integer, 0) + v_applied,
      'volumes', coalesce((summary ->> 'volumes')::integer, 0) + v_volumes)
    WHERE id = v_doc;
    IF NOT (p_doc ? 'id') THEN
      INSERT INTO public.kp_estimate_log (estimate_id, object_id, entity, action, changes, changed_by, changed_by_name)
      VALUES (p_estimate, v_est.object_id, 'price', 'import',
              jsonb_build_object('doc_id', v_doc, 'title', v_doc_title, 'stage', p_doc ->> 'stage'), auth.uid(), v_name);
    END IF;
  END IF;
  RETURN jsonb_build_object('doc_id', v_doc, 'applied', v_applied, 'same', v_same, 'conflicts', v_conflicts,
    'skipped', v_skipped, 'volumes', v_volumes);
END
$$;
-- osp:allow rpc kp_estimate_price_apply authenticated

-- Вернуть цену из файла (убрать изменённую): строки — p_row_ids. Ответ — сколько цен убрано.
CREATE OR REPLACE FUNCTION public.kp_estimate_price_reset(p_estimate uuid, p_row_ids uuid[]) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_est public.kp_estimates%ROWTYPE;
  v_name text := public.kp_estimate_actor_name();
  v_count integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Нужен вход' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'kp_estimate_price_admin: цены сметы меняет только администратор' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_est FROM public.kp_estimates WHERE id = p_estimate;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Смета не найдена' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.psdc_object_in_scope(v_est.object_id) THEN
    RAISE EXCEPTION 'Нет доступа к смете этого объекта' USING ERRCODE = '42501';
  END IF;
  IF v_est.status <> 'active' THEN
    RAISE EXCEPTION 'kp_estimate_not_active: смета заменена новой версией — правка закрыта' USING ERRCODE = 'P0001';
  END IF;
  IF coalesce(cardinality(p_row_ids), 0) > 5000 THEN
    RAISE EXCEPTION 'kp_estimate_price_items: не больше 5000 строк за раз' USING ERRCODE = '22023';
  END IF;
  WITH gone AS (
    DELETE FROM public.kp_estimate_prices p WHERE p.estimate_id = p_estimate AND p.row_id = ANY (p_row_ids) RETURNING p.*
  )
  INSERT INTO public.kp_estimate_log (estimate_id, object_id, row_id, row_label, entity, action, changes, changed_by, changed_by_name)
  SELECT g.estimate_id, g.object_id, g.row_id,
         left(concat_ws(' ', coalesce(r.code, CASE WHEN r.pos_no IS NOT NULL THEN '№ ' || r.pos_no END), r.name), 300),
         'price', 'delete',
         CASE WHEN g.unit_price IS NOT NULL THEN jsonb_build_object('unit_price', jsonb_build_object('old', g.unit_price, 'new', NULL)) ELSE '{}'::jsonb END
         || CASE WHEN g.total IS NOT NULL THEN jsonb_build_object('total', jsonb_build_object('old', g.total, 'new', NULL)) ELSE '{}'::jsonb END,
         auth.uid(), v_name
  FROM gone g JOIN public.kp_estimate_rows r ON r.id = g.row_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
-- osp:allow rpc kp_estimate_price_reset authenticated

-- ── Новая версия файла: цены переходят, как отметки (тело 20270215 + перенос цен и документов) ─────
CREATE OR REPLACE FUNCTION public.kp_estimate_activate(p_estimate uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_est public.kp_estimates%ROWTYPE;
  v_prev uuid;
  v_rows integer;
  v_marks integer := 0;
  v_allocs integer := 0;
  v_logs integer := 0;
  v_prices integer := 0;
  v_marks_left integer := 0;
  v_allocs_left integer := 0;
  v_prices_left integer := 0;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Нужен вход' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_est FROM public.kp_estimates WHERE id = p_estimate FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Смета не найдена' USING ERRCODE = 'P0002';
  END IF;
  IF NOT (public.kp_estimate_can('edit') AND public.psdc_object_in_scope(v_est.object_id)) THEN
    RAISE EXCEPTION 'Нет права загружать смету этого объекта' USING ERRCODE = '42501';
  END IF;
  IF v_est.status <> 'draft' THEN
    RAISE EXCEPTION 'kp_estimate_not_draft: смета уже загружена' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) INTO v_rows FROM public.kp_estimate_rows WHERE estimate_id = p_estimate;
  IF v_rows = 0 OR v_rows <> v_est.row_count THEN
    RAISE EXCEPTION 'kp_estimate_incomplete: загружено строк % из %', v_rows, v_est.row_count USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('osp.kp_estimate_transfer', 'on', true);
  SELECT id INTO v_prev FROM public.kp_estimates WHERE object_id = v_est.object_id AND status = 'active' FOR UPDATE;
  IF v_prev IS NOT NULL THEN
    UPDATE public.kp_estimates SET status = 'archived' WHERE id = v_prev;
  END IF;
  UPDATE public.kp_estimates SET status = 'active', activated_at = now(), replaced_estimate_id = v_prev WHERE id = p_estimate;

  IF v_prev IS NOT NULL THEN
    UPDATE public.kp_estimate_marks k SET row_id = m.new_id, estimate_id = p_estimate
    FROM public.kp_estimate_row_map(v_prev, p_estimate) m WHERE k.row_id = m.old_id;
    GET DIAGNOSTICS v_marks = ROW_COUNT;
    UPDATE public.kp_estimate_allocations a SET row_id = m.new_id, estimate_id = p_estimate
    FROM public.kp_estimate_row_map(v_prev, p_estimate) m WHERE a.row_id = m.old_id;
    GET DIAGNOSTICS v_allocs = ROW_COUNT;
    UPDATE public.kp_estimate_prices p SET row_id = m.new_id, estimate_id = p_estimate
    FROM public.kp_estimate_row_map(v_prev, p_estimate) m WHERE p.row_id = m.old_id;
    GET DIAGNOSTICS v_prices = ROW_COUNT;
    -- Применённые документы — к новой версии (их список и история продолжаются).
    UPDATE public.kp_estimate_price_docs SET estimate_id = p_estimate WHERE estimate_id = v_prev;
    UPDATE public.kp_estimate_log l SET row_id = m.new_id, estimate_id = p_estimate
    FROM public.kp_estimate_row_map(v_prev, p_estimate) m WHERE l.row_id = m.old_id;
    GET DIAGNOSTICS v_logs = ROW_COUNT;
    SELECT count(*) INTO v_marks_left FROM public.kp_estimate_marks WHERE estimate_id = v_prev;
    SELECT count(*) INTO v_allocs_left FROM public.kp_estimate_allocations WHERE estimate_id = v_prev;
    SELECT count(*) INTO v_prices_left FROM public.kp_estimate_prices WHERE estimate_id = v_prev;
  END IF;

  v_result := jsonb_build_object('estimate_id', p_estimate, 'previous_id', v_prev, 'rows', v_rows,
    'moved_marks', v_marks, 'moved_allocations', v_allocs, 'moved_prices', v_prices, 'moved_log', v_logs,
    'left_marks', v_marks_left, 'left_allocations', v_allocs_left, 'left_prices', v_prices_left);
  UPDATE public.kp_estimates SET transfer = v_result WHERE id = p_estimate;
  INSERT INTO public.kp_estimate_log (estimate_id, object_id, entity, action, changes, changed_by, changed_by_name)
  VALUES (p_estimate, v_est.object_id, 'estimate', 'activate',
          v_result || jsonb_build_object('title', v_est.title, 'kp_file', v_est.kp_file_name, 'pz_file', v_est.pz_file_name),
          auth.uid(), public.kp_estimate_actor_name());
  PERFORM set_config('osp.kp_estimate_transfer', 'off', true);
  RETURN v_result;
END
$$;

-- ── Права под одну учётку: читать — как смету, писать — только служебными функциями ───────────────────
DO $$
DECLARE
  v_table text;
  v_read constant text := '(SELECT public.kp_estimate_can(''view'')) AND ((SELECT public.osp_object_scope()) IS NULL OR object_id = ANY ((SELECT public.osp_object_scope())::uuid[]))';
  v_wrap constant text := 'CASE WHEN (SELECT osp_private.bypass()) THEN true ELSE ((SELECT osp_private.role_in(''authenticated'')) AND (%s)) END';
BEGIN
  FOREACH v_table IN ARRAY ARRAY['kp_estimate_prices', 'kp_estimate_price_docs'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_table);
    EXECUTE format('DROP POLICY IF EXISTS osp_internal ON public.%I', v_table);
    EXECUTE format('CREATE POLICY osp_internal ON public.%I FOR ALL TO PUBLIC USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()))', v_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_table || '_read', v_table);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO PUBLIC USING (%s)', v_table || '_read', v_table, format(v_wrap, v_read));
    INSERT INTO osp_meta.policy_roles VALUES ('public', v_table, v_table || '_read', ARRAY['authenticated'])
    ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;
  END LOOP;
END
$$;
-- osp:allow table kp_estimate_prices authenticated=select
-- osp:allow table kp_estimate_price_docs authenticated=select
