-- Смета КП / ПЗ объекта — совместная работа экономистов над одним загруженным документом (вкладка «Смета» карточки
-- объекта, просьба пользователя 12.11.2026, пример — ЖК Примавера, корпус 14).
--
--  • kp_estimates — загруженный документ: черновик (идёт загрузка строк) → действующий (один на объект) → прежний
--    (заменён новой версией файла). Исходные файлы — s3_documents объекта, паспорт и коэффициенты — meta;
--  • kp_estimate_rows — строки сметы: строка КП (раздел, группа, укрупнённая позиция, позиция) с данными ПЗ (kp / pz),
--    вложенность — parent_row_no. Пишутся только в черновик, потом не меняются;
--  • kp_estimate_marks — отметки строки: примечание, заливка строки и ячеек, актуальный объём и причина, ответственный;
--  • kp_estimate_allocations — распределение объёма позиции: тендер и объём в расчёте ПЗ, подрядчик, договор и
--    закреплённый объём; пара «тендер + подрядчик» у позиции одна (двойное списание той же пары невозможно);
--  • kp_estimate_log — история правок (было / стало, кто, когда) и загрузок версий; пишут только триггеры.
-- Новая версия файла (kp_estimate_activate): прежняя становится архивной, отметки, распределения и их история переходят на
-- строки новой с тем же ключом, остальные остаются у прежней — ничего не удаляется.
--
-- Права: читает обладатель права «Объекты» или «Объекты: смета КП/ПЗ», пишет — «Объекты: смета КП/ПЗ» с правкой (раздел
-- kp_estimate, по умолчанию у экономиста ОСП); то и другое — по объектам своего охвата (kp_estimate_in_scope).
-- Только добавление, повтор безопасен. База нового портала — migration/yandex/20270215_kp_estimate.sql (те же объекты,
-- права под одну учётку).

BEGIN;

-- ── Таблицы ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kp_estimates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES public.objects(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  title text NOT NULL DEFAULT '' CHECK (length(title) <= 500),
  kp_file_name text CHECK (length(kp_file_name) <= 500),
  pz_file_name text CHECK (length(pz_file_name) <= 500),
  kp_s3_document_id uuid REFERENCES public.s3_documents(id) ON DELETE SET NULL,
  pz_s3_document_id uuid REFERENCES public.s3_documents(id) ON DELETE SET NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(meta) = 'object'),
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count BETWEEN 0 AND 50000),
  replaced_estimate_id uuid,
  transfer jsonb,
  created_by uuid DEFAULT auth.uid(),
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS kp_estimates_one_active ON public.kp_estimates (object_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS kp_estimates_object_idx ON public.kp_estimates (object_id, created_at DESC);
COMMENT ON TABLE public.kp_estimates IS
  'Смета КП / ПЗ объекта: загруженный документ (черновик → действующий, один на объект → прежний). Строки — kp_estimate_rows';

CREATE TABLE IF NOT EXISTS public.kp_estimate_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id uuid NOT NULL REFERENCES public.kp_estimates(id) ON DELETE CASCADE,
  object_id uuid NOT NULL,
  row_no integer NOT NULL CHECK (row_no > 0),
  parent_row_no integer CHECK (parent_row_no > 0 AND parent_row_no < row_no),
  level smallint NOT NULL CHECK (level BETWEEN 1 AND 30),
  kind text NOT NULL CHECK (kind IN ('title', 'section', 'group', 'aggregate', 'position', 'note', 'adjust')),
  row_key text NOT NULL CHECK (length(row_key) <= 1000),
  code text,
  pos_no text,
  name text NOT NULL DEFAULT '',
  unit text,
  customer_note text,
  gp_note text,
  kp jsonb,
  pz jsonb,
  UNIQUE (estimate_id, row_no),
  UNIQUE (estimate_id, row_key)
);
COMMENT ON TABLE public.kp_estimate_rows IS
  'Строки сметы КП / ПЗ: строка КП с данными ПЗ (kp / pz). Пишутся только в черновик, потом не меняются';

CREATE TABLE IF NOT EXISTS public.kp_estimate_marks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id uuid NOT NULL REFERENCES public.kp_estimates(id) ON DELETE CASCADE,
  row_id uuid NOT NULL UNIQUE REFERENCES public.kp_estimate_rows(id) ON DELETE CASCADE,
  object_id uuid NOT NULL,
  note text CHECK (length(note) <= 4000),
  fill text CHECK (fill ~ '^#[0-9a-f]{6}$'),
  cell_fills jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(cell_fills) = 'object'),
  actual_qty numeric CHECK (actual_qty >= 0),
  actual_reason text CHECK (length(actual_reason) <= 2000),
  responsible_id uuid,
  responsible_name text CHECK (length(responsible_name) <= 200),
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_by_name text
);
CREATE INDEX IF NOT EXISTS kp_estimate_marks_estimate_idx ON public.kp_estimate_marks (estimate_id);
COMMENT ON TABLE public.kp_estimate_marks IS
  'Отметки строки сметы КП / ПЗ: примечание, заливка строки и ячеек, актуальный объём и причина, ответственный экономист';

CREATE TABLE IF NOT EXISTS public.kp_estimate_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id uuid NOT NULL REFERENCES public.kp_estimates(id) ON DELETE CASCADE,
  row_id uuid NOT NULL REFERENCES public.kp_estimate_rows(id) ON DELETE CASCADE,
  object_id uuid NOT NULL,
  tender_id uuid REFERENCES public.tenders(id) ON DELETE SET NULL,
  tender_label text CHECK (length(tender_label) <= 300),
  pz_qty numeric NOT NULL DEFAULT 0 CHECK (pz_qty >= 0),
  counterparty_id uuid REFERENCES public.counterparties(id) ON DELETE SET NULL,
  counterparty_name text CHECK (length(counterparty_name) <= 300),
  contract_id uuid REFERENCES public.contracts(id) ON DELETE SET NULL,
  contract_label text CHECK (length(contract_label) <= 300),
  contract_qty numeric NOT NULL DEFAULT 0 CHECK (contract_qty >= 0),
  note text CHECK (length(note) <= 2000),
  row_version integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_by_name text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kp_estimate_allocations_target CHECK (tender_id IS NOT NULL OR nullif(btrim(tender_label), '') IS NOT NULL
    OR counterparty_id IS NOT NULL OR nullif(btrim(counterparty_name), '') IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS kp_estimate_allocations_estimate_idx ON public.kp_estimate_allocations (estimate_id);
CREATE INDEX IF NOT EXISTS kp_estimate_allocations_row_idx ON public.kp_estimate_allocations (row_id);
-- Одна пара «тендер + подрядчик» на позицию: та же пара второй строкой — двойное списание.
CREATE UNIQUE INDEX IF NOT EXISTS kp_estimate_allocations_pair ON public.kp_estimate_allocations (row_id,
  (coalesce(tender_id::text, 'l:' || lower(btrim(coalesce(tender_label, ''))))),
  (coalesce(counterparty_id::text, 'l:' || lower(btrim(coalesce(counterparty_name, ''))))));
COMMENT ON TABLE public.kp_estimate_allocations IS
  'Распределение объёма позиции сметы КП / ПЗ: тендер и объём в расчёте ПЗ, подрядчик, договор и закреплённый объём';

CREATE TABLE IF NOT EXISTS public.kp_estimate_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  estimate_id uuid NOT NULL,
  object_id uuid NOT NULL,
  row_id uuid,
  row_label text,
  entity text NOT NULL CHECK (entity IN ('estimate', 'mark', 'allocation')),
  action text NOT NULL CHECK (action IN ('import', 'activate', 'insert', 'update', 'delete')),
  changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  changed_by uuid,
  changed_by_name text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kp_estimate_log_estimate_idx ON public.kp_estimate_log (estimate_id, id);
CREATE INDEX IF NOT EXISTS kp_estimate_log_row_idx ON public.kp_estimate_log (row_id, id) WHERE row_id IS NOT NULL;
COMMENT ON TABLE public.kp_estimate_log IS
  'История сметы КП / ПЗ: правки отметок и распределений (было / стало, кто, когда), загрузка версии. Пишут только триггеры';

-- ── Права и кто ─────────────────────────────────────────────────────────────────────────────────────
-- Право раздела: просмотр — «Объекты» или «Объекты: смета КП/ПЗ» (правка включает просмотр), правка — второе.
CREATE OR REPLACE FUNCTION public.kp_estimate_can(p_kind text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT CASE WHEN p_kind = 'edit' THEN public.osp_can('kp_estimate', 'edit')
              ELSE public.osp_can('kp_estimate', 'view') OR public.osp_can('kp_estimate', 'edit') OR public.osp_can('objects', 'view') END
$$;

-- ФИО вошедшего (иначе почта) — слепком в отметке, распределении и истории: справочник сотрудников читают не все.
CREATE OR REPLACE FUNCTION public.kp_estimate_actor_name() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT coalesce(nullif(btrim(ur.full_name), ''), nullif(btrim(ur.email), ''))
  FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1
$$;

-- Перенос на новую версию идёт с этой отметкой транзакции (её ставит только kp_estimate_activate).
CREATE OR REPLACE FUNCTION public.kp_estimate_transfer_on() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$ SELECT coalesce(current_setting('osp.kp_estimate_transfer', true), '') = 'on' $$;

-- ── Триггеры ────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.kp_estimates_touch() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'kp_estimate_insert_draft: смета загружается черновиком' USING ERRCODE = '42501';
    END IF;
    NEW.created_by := auth.uid();
    NEW.created_by_name := public.kp_estimate_actor_name();
    NEW.created_at := now();
    NEW.activated_at := NULL;
    NEW.replaced_estimate_id := NULL;
    NEW.transfer := NULL;
  ELSIF NOT public.kp_estimate_transfer_on() THEN
    -- Без служебной функции: только черновик и только его файлы, паспорт и число строк.
    IF OLD.status <> 'draft'
       OR (NEW.status, NEW.object_id, NEW.created_by, NEW.created_at, NEW.activated_at, NEW.replaced_estimate_id, NEW.transfer)
          IS DISTINCT FROM (OLD.status, OLD.object_id, OLD.created_by, OLD.created_at, OLD.activated_at, OLD.replaced_estimate_id, OLD.transfer) THEN
      RAISE EXCEPTION 'kp_estimate_locked: действующую смету меняет только загрузка новой версии' USING ERRCODE = '42501';
    END IF;
  END IF;
  NEW.title := btrim(coalesce(NEW.title, ''));
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS kp_estimates_touch ON public.kp_estimates;
CREATE TRIGGER kp_estimates_touch BEFORE INSERT OR UPDATE ON public.kp_estimates
  FOR EACH ROW EXECUTE FUNCTION public.kp_estimates_touch();

-- Строки — только в черновик; объект — от сметы.
CREATE OR REPLACE FUNCTION public.kp_estimate_rows_touch() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_object uuid;
  v_status text;
BEGIN
  SELECT e.object_id, e.status INTO v_object, v_status FROM public.kp_estimates e WHERE e.id = NEW.estimate_id;
  IF v_object IS NULL THEN
    RAISE EXCEPTION 'Смета не найдена' USING ERRCODE = '23503';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'kp_estimate_rows_locked: строки пишутся только в черновик' USING ERRCODE = '42501';
  END IF;
  NEW.object_id := v_object;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS kp_estimate_rows_touch ON public.kp_estimate_rows;
CREATE TRIGGER kp_estimate_rows_touch BEFORE INSERT OR UPDATE ON public.kp_estimate_rows
  FOR EACH ROW EXECUTE FUNCTION public.kp_estimate_rows_touch();

-- Отметка и распределение: смета и объект — от строки; правка — только у действующей сметы; кто и когда.
-- При переносе на новую версию меняются только строка и смета, остальное — как было.
CREATE OR REPLACE FUNCTION public.kp_estimate_item_touch() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_estimate uuid;
  v_object uuid;
  v_status text;
  v_kind text;
  v_unit text;
BEGIN
  IF TG_OP = 'UPDATE' AND public.kp_estimate_transfer_on() THEN
    IF (to_jsonb(NEW) - 'row_id' - 'estimate_id') IS DISTINCT FROM (to_jsonb(OLD) - 'row_id' - 'estimate_id') THEN
      RAISE EXCEPTION 'kp_estimate_transfer: при переносе меняется только строка' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  SELECT r.estimate_id, r.object_id, e.status, r.kind, r.unit INTO v_estimate, v_object, v_status, v_kind, v_unit
  FROM public.kp_estimate_rows r JOIN public.kp_estimates e ON e.id = r.estimate_id
  WHERE r.id = NEW.row_id;
  IF v_estimate IS NULL THEN
    RAISE EXCEPTION 'Строка сметы не найдена' USING ERRCODE = '23503';
  END IF;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'kp_estimate_not_active: смета заменена новой версией — правка закрыта' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.row_id IS DISTINCT FROM OLD.row_id THEN
    RAISE EXCEPTION 'kp_estimate_row_fixed: строку у записи не меняют' USING ERRCODE = '42501';
  END IF;
  NEW.estimate_id := v_estimate;
  NEW.object_id := v_object;
  NEW.updated_by := auth.uid();
  NEW.updated_by_name := public.kp_estimate_actor_name();
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' THEN
    NEW.row_version := OLD.row_version + 1;
    NEW.created_at := OLD.created_at;
  ELSE
    NEW.row_version := 1;
    NEW.created_at := now();
  END IF;
  IF TG_TABLE_NAME = 'kp_estimate_marks' THEN
    NEW.note := nullif(btrim(NEW.note), '');
    NEW.actual_reason := nullif(btrim(NEW.actual_reason), '');
    NEW.responsible_name := nullif(btrim(NEW.responsible_name), '');
    NEW.cell_fills := coalesce(NEW.cell_fills, '{}'::jsonb);
    IF NEW.actual_qty IS NOT NULL AND (v_unit IS NULL OR v_kind NOT IN ('position', 'aggregate', 'adjust')) THEN
      RAISE EXCEPTION 'kp_estimate_no_volume: у строки нет объёма' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF v_kind NOT IN ('position', 'adjust') THEN
      RAISE EXCEPTION 'kp_estimate_not_position: распределяется объём позиции' USING ERRCODE = '22023';
    END IF;
    NEW.tender_label := nullif(btrim(NEW.tender_label), '');
    NEW.counterparty_name := nullif(btrim(NEW.counterparty_name), '');
    NEW.contract_label := nullif(btrim(NEW.contract_label), '');
    NEW.note := nullif(btrim(NEW.note), '');
    IF TG_OP = 'INSERT' THEN
      NEW.created_by := auth.uid();
      NEW.created_by_name := NEW.updated_by_name;
    ELSE
      NEW.created_by := OLD.created_by;
      NEW.created_by_name := OLD.created_by_name;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS kp_estimate_marks_touch ON public.kp_estimate_marks;
CREATE TRIGGER kp_estimate_marks_touch BEFORE INSERT OR UPDATE ON public.kp_estimate_marks
  FOR EACH ROW EXECUTE FUNCTION public.kp_estimate_item_touch();
DROP TRIGGER IF EXISTS kp_estimate_allocations_touch ON public.kp_estimate_allocations;
CREATE TRIGGER kp_estimate_allocations_touch BEFORE INSERT OR UPDATE ON public.kp_estimate_allocations
  FOR EACH ROW EXECUTE FUNCTION public.kp_estimate_item_touch();

-- История: что изменилось (было / стало), кто, когда. Удаление строк вместе со сметой не пишется (сметы уже нет).
CREATE OR REPLACE FUNCTION public.kp_estimate_log_write() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_old jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  v_any jsonb := coalesce(v_new, v_old);
  v_fields text[];
  v_changes jsonb := '{}'::jsonb;
  v_key text;
  v_label text;
BEGIN
  IF public.kp_estimate_transfer_on() THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.kp_estimates e WHERE e.id = (v_old ->> 'estimate_id')::uuid) THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'kp_estimate_marks' THEN
    v_fields := ARRAY['note', 'fill', 'cell_fills', 'actual_qty', 'actual_reason', 'responsible_id', 'responsible_name'];
  ELSE
    v_fields := ARRAY['tender_id', 'tender_label', 'pz_qty', 'counterparty_id', 'counterparty_name', 'contract_id', 'contract_label', 'contract_qty', 'note'];
  END IF;
  FOREACH v_key IN ARRAY v_fields LOOP
    IF coalesce(v_old -> v_key, 'null'::jsonb) IS DISTINCT FROM coalesce(v_new -> v_key, 'null'::jsonb)
       AND NOT (v_key = 'cell_fills' AND coalesce(v_old -> v_key, '{}'::jsonb) = coalesce(v_new -> v_key, '{}'::jsonb)) THEN
      v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('old', v_old -> v_key, 'new', v_new -> v_key));
    END IF;
  END LOOP;
  IF v_changes = '{}'::jsonb THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'kp_estimate_allocations' THEN
    -- Какое распределение: тендер и подрядчик строкой, даже если менялся только объём.
    v_changes := v_changes || jsonb_build_object('_allocation', jsonb_build_object('id', v_any ->> 'id',
      'tender', v_any ->> 'tender_label', 'counterparty', v_any ->> 'counterparty_name', 'contract', v_any ->> 'contract_label'));
  END IF;
  SELECT left(concat_ws(' ', coalesce(r.code, CASE WHEN r.pos_no IS NOT NULL THEN '№ ' || r.pos_no END), r.name), 300) INTO v_label
  FROM public.kp_estimate_rows r WHERE r.id = (v_any ->> 'row_id')::uuid;
  INSERT INTO public.kp_estimate_log (estimate_id, object_id, row_id, row_label, entity, action, changes, changed_by, changed_by_name)
  VALUES ((v_any ->> 'estimate_id')::uuid, (v_any ->> 'object_id')::uuid, (v_any ->> 'row_id')::uuid, v_label,
          CASE WHEN TG_TABLE_NAME = 'kp_estimate_marks' THEN 'mark' ELSE 'allocation' END,
          lower(TG_OP), v_changes, auth.uid(), public.kp_estimate_actor_name());
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS kp_estimate_marks_log ON public.kp_estimate_marks;
CREATE TRIGGER kp_estimate_marks_log AFTER INSERT OR UPDATE OR DELETE ON public.kp_estimate_marks
  FOR EACH ROW EXECUTE FUNCTION public.kp_estimate_log_write();
DROP TRIGGER IF EXISTS kp_estimate_allocations_log ON public.kp_estimate_allocations;
CREATE TRIGGER kp_estimate_allocations_log AFTER INSERT OR UPDATE OR DELETE ON public.kp_estimate_allocations
  FOR EACH ROW EXECUTE FUNCTION public.kp_estimate_log_write();

-- Смету удалили (черновик после сбоя загрузки или администратор) — её история уходит вместе с ней.
CREATE OR REPLACE FUNCTION public.kp_estimates_log_cleanup() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  DELETE FROM public.kp_estimate_log WHERE estimate_id = OLD.id;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS kp_estimates_log_cleanup ON public.kp_estimates;
CREATE TRIGGER kp_estimates_log_cleanup AFTER DELETE ON public.kp_estimates
  FOR EACH ROW EXECUTE FUNCTION public.kp_estimates_log_cleanup();

-- ── Новая версия: черновик → действующая, перенос отметок и распределений ─────────────────────────
-- Соответствие строк прежней и новой версии: тот же ключ (номер позиции + наименование); не нашлось — тот же вид,
-- код и наименование, если такая строка одна с обеих сторон.
CREATE OR REPLACE FUNCTION public.kp_estimate_row_map(p_old uuid, p_new uuid) RETURNS TABLE (old_id uuid, new_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  WITH by_key AS (
    SELECT o.id AS old_id, n.id AS new_id
    FROM public.kp_estimate_rows o
    JOIN public.kp_estimate_rows n ON n.estimate_id = p_new AND n.row_key = o.row_key
    WHERE o.estimate_id = p_old
  ),
  old_rest AS (
    SELECT o.id, o.kind, coalesce(o.code, '') AS code, lower(btrim(o.name)) AS name,
           count(*) OVER (PARTITION BY o.kind, coalesce(o.code, ''), lower(btrim(o.name))) AS cnt
    FROM public.kp_estimate_rows o
    WHERE o.estimate_id = p_old AND NOT EXISTS (SELECT 1 FROM by_key k WHERE k.old_id = o.id)
  ),
  new_rest AS (
    SELECT n.id, n.kind, coalesce(n.code, '') AS code, lower(btrim(n.name)) AS name,
           count(*) OVER (PARTITION BY n.kind, coalesce(n.code, ''), lower(btrim(n.name))) AS cnt
    FROM public.kp_estimate_rows n
    WHERE n.estimate_id = p_new AND NOT EXISTS (SELECT 1 FROM by_key k WHERE k.new_id = n.id)
  )
  SELECT old_id, new_id FROM by_key
  UNION ALL
  SELECT o.id, n.id FROM old_rest o JOIN new_rest n ON n.kind = o.kind AND n.code = o.code AND n.name = o.name
  WHERE o.cnt = 1 AND n.cnt = 1
$$;

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
  v_marks_left integer := 0;
  v_allocs_left integer := 0;
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
    UPDATE public.kp_estimate_log l SET row_id = m.new_id, estimate_id = p_estimate
    FROM public.kp_estimate_row_map(v_prev, p_estimate) m WHERE l.row_id = m.old_id;
    GET DIAGNOSTICS v_logs = ROW_COUNT;
    SELECT count(*) INTO v_marks_left FROM public.kp_estimate_marks WHERE estimate_id = v_prev;
    SELECT count(*) INTO v_allocs_left FROM public.kp_estimate_allocations WHERE estimate_id = v_prev;
  END IF;

  v_result := jsonb_build_object('estimate_id', p_estimate, 'previous_id', v_prev, 'rows', v_rows,
    'moved_marks', v_marks, 'moved_allocations', v_allocs, 'moved_log', v_logs,
    'left_marks', v_marks_left, 'left_allocations', v_allocs_left);
  UPDATE public.kp_estimates SET transfer = v_result WHERE id = p_estimate;
  INSERT INTO public.kp_estimate_log (estimate_id, object_id, entity, action, changes, changed_by, changed_by_name)
  VALUES (p_estimate, v_est.object_id, 'estimate', 'activate',
          v_result || jsonb_build_object('title', v_est.title, 'kp_file', v_est.kp_file_name, 'pz_file', v_est.pz_file_name),
          auth.uid(), public.kp_estimate_actor_name());
  PERFORM set_config('osp.kp_estimate_transfer', 'off', true);
  RETURN v_result;
END
$$;

-- ── Право раздела ───────────────────────────────────────────────────────────────────────────────────
INSERT INTO public.role_permissions (role, section, can_view, can_edit)
SELECT r.key, 'kp_estimate', true, true FROM public.roles r WHERE r.key = 'economist'
ON CONFLICT (role, section) DO NOTHING;

-- ── Права ──────────────────────────────────────────────────────────────────────────────────────────
-- Охват объектов вошедшего: psdc_object_in_scope (20260908) вошедшим не выдана — правило по строкам с ней отказало бы
-- каждому, поэтому — служебная обёртка (только эта проверка, без данных).
CREATE OR REPLACE FUNCTION public.kp_estimate_in_scope(p_object uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$ SELECT public.psdc_object_in_scope(p_object) $$;

DO $$
DECLARE
  v_table text;
  v_read constant text := '(SELECT public.kp_estimate_can(''view'')) AND public.kp_estimate_in_scope(object_id)';
  v_edit constant text := '(SELECT public.kp_estimate_can(''edit'')) AND public.kp_estimate_in_scope(object_id)';
BEGIN
  FOREACH v_table IN ARRAY ARRAY['kp_estimates', 'kp_estimate_rows', 'kp_estimate_marks', 'kp_estimate_allocations', 'kp_estimate_log'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_table || '_read', v_table);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s)', v_table || '_read', v_table, v_read);
    -- Новые таблицы Supabase по умолчанию выдаёт анониму — снимаем всё явно.
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', v_table);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', v_table);
    IF v_table = 'kp_estimate_log' THEN
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', v_table);
      CONTINUE;
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_table || '_insert', v_table);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (%s)', v_table || '_insert', v_table, v_edit);
    IF v_table = 'kp_estimate_rows' THEN
      EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO authenticated', v_table);
      CONTINUE;
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_table || '_update', v_table);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', v_table || '_update', v_table, v_edit, v_edit);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_table || '_delete', v_table);
    -- Смету целиком удаляют: черновик — правом раздела (сбой загрузки), действующую и прежнюю — только администратор.
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (%s)', v_table || '_delete', v_table,
      v_edit || CASE WHEN v_table = 'kp_estimates' THEN ' AND (status = ''draft'' OR (SELECT public.is_admin()))' ELSE '' END);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', v_table);
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION public.kp_estimate_can(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kp_estimate_in_scope(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kp_estimate_actor_name() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kp_estimate_transfer_on() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kp_estimate_row_map(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kp_estimate_activate(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kp_estimates_touch() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kp_estimate_rows_touch() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kp_estimate_item_touch() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.kp_estimate_log_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kp_estimates_log_cleanup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kp_estimate_can(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_estimate_in_scope(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_estimate_actor_name() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_estimate_transfer_on() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kp_estimate_activate(uuid) TO authenticated, service_role;

COMMIT;
