-- ПСДЦ / ВОР (второй этап модуля «Договоры и ДС»).
--
-- ПСДЦ — структурированная ведомость стоимости работ, привязанная к документу
-- первого этапа (договор или ДС) через его id в таблице contracts. Своего
-- бэкенда в проекте нет, фронт ходит в PostgREST напрямую, поэтому «серверная
-- сторона» ПСДЦ — это функции этой миграции:
--
--   • расчёт ведётся ТОЛЬКО здесь, в NUMERIC (без float), с округлением на каждой
--     строке; round(numeric) в PostgreSQL округляет половину от нуля — это та же
--     семантика, что у Excel ROUND;
--   • браузер лишь читает XLSX и присылает сырые значения ячеек; формулы и
--     сохранённые результаты K/M/N/O/итогов источником истины не являются;
--   • изменения — только через SECURITY DEFINER-функции с проверкой прав, статуса
--     документа и блокировкой строки документа. Прямой записи в таблицы ПСДЦ у
--     клиента нет (RLS: только чтение);
--   • сумма документа меняется только функцией «Применить ВОР» и снова
--     становится ручной после «Удалить ВОР». Ручная сумма contract_amount не
--     перезаписывается никогда.
--
-- Требует миграцию 20260906_contract_amendments (root_contract_id, changed_fields,
-- триггеры иерархии). Миграция additive и идемпотентна.

-- ────────────────────────────────────────────────────────────────────────────
-- 0) Сумма применённой ПСДЦ на документе.
--
-- Денормализация нужна, чтобы существующий расчёт актуальной суммы (реестр грузит
-- договоры одним select *) получил эффективную сумму документа без второго
-- запроса и без второго алгоритма: effective = psdc_total ?? contract_amount.
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS psdc_total NUMERIC(20, 2),
  ADD COLUMN IF NOT EXISTS psdc_applied_id UUID;

COMMENT ON COLUMN contracts.psdc_total IS
  'Итог применённой ПСДЦ документа. Пока задан, он и есть сумма документа; ручная contract_amount сохраняется и снова действует после удаления ПСДЦ. Пишется только функциями psdc_apply / psdc_delete';
COMMENT ON COLUMN contracts.psdc_applied_id IS 'Применённая ПСДЦ документа (psdc.id)';

-- Момент внедрения ПСДЦ. Завершённые договоры, заведённые ДО него, разрешено
-- дополнить ПСДЦ без возврата на доработку (миграция тысяч старых ведомостей).
-- Функция создаётся один раз: повторный прогон миграции дату не сдвигает.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'psdc_feature_started_at' AND pronamespace = 'public'::regnamespace
  ) THEN
    EXECUTE format(
      $f$CREATE FUNCTION public.psdc_feature_started_at() RETURNS timestamptz
         LANGUAGE sql IMMUTABLE AS $b$ SELECT %L::timestamptz $b$ $f$,
      now());
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Таблицы.

-- Пакет массовой загрузки. Сопоставление файл → документ хранится на уровне
-- пакета (в psdc.document_id + match_method), а не в XLSX.
CREATE TABLE IF NOT EXISTS psdc_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT,
  created_by UUID,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Одна загруженная ведомость (один XLSX).
CREATE TABLE IF NOT EXISTS psdc (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL — файл массовой загрузки, ещё не сопоставленный с документом.
  document_id UUID REFERENCES contracts(id) ON DELETE CASCADE,
  batch_id UUID REFERENCES psdc_batches(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (state IN ('uploaded', 'validated', 'invalid', 'applied', 'cancelled', 'deleted')),
  previous_psdc_id UUID REFERENCES psdc(id) ON DELETE SET NULL,
  match_method TEXT CHECK (match_method IN ('auto', 'manual', 'table', 'card')),
  match_note TEXT,

  source_filename TEXT NOT NULL,
  source_hash TEXT,
  source_size BIGINT,
  source_s3_document_id UUID REFERENCES s3_documents(id) ON DELETE SET NULL,
  sheet_name TEXT,
  has_legacy_u BOOLEAN NOT NULL DEFAULT false,
  source_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_row_count INT NOT NULL DEFAULT 0,

  uploaded_by UUID,
  uploaded_by_name TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  validated_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  applied_by UUID,
  applied_by_name TEXT,
  cancelled_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  deleted_by_name TEXT,

  section_count INT,
  process_count INT,
  legacy_deleted_count INT,
  error_count INT NOT NULL DEFAULT 0,
  warning_count INT NOT NULL DEFAULT 0,

  total_material NUMERIC(20, 2),
  total_work NUMERIC(20, 2),
  total NUMERIC(20, 2),
  dm_material_excluded NUMERIC(20, 2),
  vat_rate_snapshot NUMERIC(5, 2),
  vat_included_snapshot BOOLEAN,
  vat_amount NUMERIC(20, 2),
  file_vat_rate NUMERIC(7, 2),
  legacy_total NUMERIC(20, 2)
);

-- Максимум одна применённая ПСДЦ на документ — гарантия на уровне БД, а не UI.
CREATE UNIQUE INDEX IF NOT EXISTS uq_psdc_one_applied_per_document
  ON psdc(document_id) WHERE state = 'applied';
CREATE INDEX IF NOT EXISTS idx_psdc_document_state ON psdc(document_id, state);
CREATE INDEX IF NOT EXISTS idx_psdc_batch ON psdc(batch_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contracts_psdc_applied_id_fkey') THEN
    ALTER TABLE contracts ADD CONSTRAINT contracts_psdc_applied_id_fkey
      FOREIGN KEY (psdc_applied_id) REFERENCES psdc(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Сырые значения ячеек, как их прочитал браузер: { "A": {"t":"s","v":"5.10"}, … }.
-- Это исходное представление файла; нормализованные значения живут в psdc_rows.
CREATE TABLE IF NOT EXISTS psdc_source_rows (
  psdc_id UUID NOT NULL REFERENCES psdc(id) ON DELETE CASCADE,
  excel_row INT NOT NULL,
  cells JSONB NOT NULL,
  PRIMARY KEY (psdc_id, excel_row)
);

-- Нормализованные и рассчитанные строки ведомости.
CREATE TABLE IF NOT EXISTS psdc_rows (
  id UUID PRIMARY KEY,
  psdc_id UUID NOT NULL REFERENCES psdc(id) ON DELETE CASCADE,
  logical_line_id TEXT NOT NULL,          -- постоянный ID строки между редакциями (столбец T)
  source_line_id TEXT,                    -- что было в T исходного файла
  row_order INT NOT NULL,                 -- фактический порядок строк Excel
  excel_row INT NOT NULL,
  row_kind TEXT CHECK (row_kind IN ('section', 'process')),

  number TEXT,                            -- A, всегда текст: 5.10 ≠ 5.1
  resource_type TEXT,                     -- B как в файле
  code TEXT,                              -- C
  customer_material TEXT,                 -- D как в файле
  is_customer_material BOOLEAN NOT NULL DEFAULT false,  -- D = «ДМ»
  cost_item TEXT,                         -- E
  name TEXT,                              -- F
  unit TEXT,                              -- G
  consumption_norm NUMERIC(20, 2),        -- H
  volume NUMERIC(22, 5),                  -- I
  material_price NUMERIC(20, 2),          -- J
  material_cost NUMERIC(20, 2),           -- K (расчёт)
  work_price NUMERIC(20, 2),              -- L
  work_cost NUMERIC(20, 2),               -- M (расчёт)
  unit_price NUMERIC(20, 2),              -- N (расчёт)
  total_cost NUMERIC(20, 2),              -- O (расчёт)
  manufacturer TEXT,                      -- P
  materials TEXT,                         -- Q
  work_location TEXT,                     -- R
  comment TEXT,                           -- S
  parent_section_id UUID REFERENCES psdc_rows(id) ON DELETE SET NULL,
  legacy_deleted BOOLEAN NOT NULL DEFAULT false         -- скрытый U = deleted
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_psdc_rows_order ON psdc_rows(psdc_id, row_order);
CREATE UNIQUE INDEX IF NOT EXISTS uq_psdc_rows_logical ON psdc_rows(psdc_id, logical_line_id);
-- Без индекса по ссылке на секцию удаление строк ведомости квадратично: на
-- каждую удаляемую строку база искала бы ссылающиеся строки полным просмотром.
CREATE INDEX IF NOT EXISTS idx_psdc_rows_parent_section ON psdc_rows(parent_section_id);

-- Ошибки и предупреждения проверки. Ошибки блокируют применение, предупреждения — нет.
CREATE TABLE IF NOT EXISTS psdc_issues (
  id BIGSERIAL PRIMARY KEY,
  psdc_id UUID NOT NULL REFERENCES psdc(id) ON DELETE CASCADE,
  severity TEXT NOT NULL CHECK (severity IN ('error', 'warning')),
  excel_row INT,
  cell TEXT,
  field TEXT,
  code TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_psdc_issues_psdc ON psdc_issues(psdc_id, severity);

COMMENT ON TABLE psdc IS 'ПСДЦ / ВОР: одна загруженная ведомость. state: uploaded → validated|invalid → applied → deleted; незавершённая загрузка → cancelled';
COMMENT ON TABLE psdc_rows IS 'Строки ПСДЦ после нормализации и расчёта (NUMERIC, округление на каждой строке)';
COMMENT ON TABLE psdc_source_rows IS 'Сырые значения ячеек XLSX строк ПСДЦ (исходное представление файла)';
COMMENT ON TABLE psdc_issues IS 'Ошибки/предупреждения проверки ПСДЦ с привязкой к строке и ячейке Excel';

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Защита суммы ПСДЦ на документе.
--
-- Только функции применения/удаления поднимают локальный флаг транзакции.
-- Без него поле не меняется ни формой, ни импортом, ни прямым PATCH в PostgREST.
CREATE OR REPLACE FUNCTION contracts_psdc_total_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF COALESCE(current_setting('osp.psdc_write', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.psdc_total := NULL;
    NEW.psdc_applied_id := NULL;
  ELSIF NEW.psdc_total IS DISTINCT FROM OLD.psdc_total
     OR NEW.psdc_applied_id IS DISTINCT FROM OLD.psdc_applied_id THEN
    RAISE EXCEPTION 'Сумма по ПСДЦ меняется только действиями «Применить ВОР» и «Удалить ВОР»';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contracts_psdc_total_guard ON contracts;
CREATE TRIGGER trg_contracts_psdc_total_guard
  BEFORE INSERT OR UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION contracts_psdc_total_guard();

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Права — по существующей модели: раздел «contracts» в role_permissions,
--    админ видит всё, сотрудник с привязкой к объектам — только свои объекты.
--    Колонки object_ids/object_id/counterparty_id появлялись в разных
--    миграциях, поэтому читаем их через to_jsonb — функция не ломается, если
--    какой-то из них в базе нет.

CREATE OR REPLACE FUNCTION psdc_contracts_permission(p_edit boolean)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM user_roles ur
      JOIN role_permissions rp ON rp.role = ur.role AND rp.section = 'contracts'
      WHERE ur.user_id = auth.uid()
        AND ur.is_approved = true
        AND (to_jsonb(ur) ->> 'counterparty_id') IS NULL
        AND CASE WHEN p_edit THEN rp.can_edit ELSE rp.can_view END
    )
  );
$$;

CREATE OR REPLACE FUNCTION psdc_object_in_scope(p_object_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp
AS $$
  SELECT public.is_admin() OR COALESCE((
    SELECT CASE
      WHEN jsonb_typeof(to_jsonb(ur) -> 'object_ids') = 'array'
           AND jsonb_array_length(to_jsonb(ur) -> 'object_ids') > 0
        THEN p_object_id IS NOT NULL AND (to_jsonb(ur) -> 'object_ids') ? p_object_id::text
      WHEN (to_jsonb(ur) ->> 'object_id') IS NOT NULL
        THEN p_object_id IS NOT NULL AND p_object_id::text = to_jsonb(ur) ->> 'object_id'
      ELSE true
    END
    FROM user_roles ur
    WHERE ur.user_id = auth.uid()
    LIMIT 1
  ), false);
$$;

CREATE OR REPLACE FUNCTION psdc_can_view_document(p_document_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp
AS $$
  SELECT psdc_contracts_permission(false)
     AND EXISTS (SELECT 1 FROM contracts c WHERE c.id = p_document_id AND psdc_object_in_scope(c.object_id));
$$;

CREATE OR REPLACE FUNCTION psdc_can_edit_document(p_document_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp
AS $$
  SELECT psdc_contracts_permission(true)
     AND EXISTS (SELECT 1 FROM contracts c WHERE c.id = p_document_id AND psdc_object_in_scope(c.object_id));
$$;

CREATE OR REPLACE FUNCTION psdc_visible(p_psdc_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM psdc p
    WHERE p.id = p_psdc_id
      AND CASE
            WHEN p.document_id IS NULL THEN p.uploaded_by = auth.uid() OR psdc_contracts_permission(true)
            ELSE psdc_can_view_document(p.document_id)
          END
  );
$$;

-- Почему документ сейчас нельзя менять (NULL — можно). Одно место для правила,
-- чтобы карточка, массовая загрузка и сами операции объясняли одно и то же.
CREATE OR REPLACE FUNCTION psdc_document_lock_reason(p_doc contracts)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_doc.id IS NULL THEN
    RETURN 'Документ не найден';
  END IF;
  IF p_doc.deleted_at IS NOT NULL THEN
    RETURN format('Документ ID %s удалён', p_doc.display_id);
  END IF;
  IF NOT psdc_can_edit_document(p_doc.id) THEN
    RETURN 'Недостаточно прав для изменения документа';
  END IF;
  -- Завершённое ДС меняется только после возврата на доработку. Для договоров,
  -- существовавших до внедрения ПСДЦ, первичная загрузка разрешена в любом статусе.
  IF p_doc.status = 'completed' THEN
    IF p_doc.record_type <> 'dp' THEN
      RETURN format('ДС ID %s завершено. Чтобы изменить ПСДЦ, верните его на доработку', p_doc.display_id);
    ELSIF COALESCE(p_doc.created_at, '-infinity'::timestamptz) >= psdc_feature_started_at() THEN
      RETURN format('Договор ID %s завершён. Чтобы изменить ПСДЦ, верните его на доработку', p_doc.display_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4) Служебные функции.

CREATE OR REPLACE FUNCTION psdc_actor(OUT user_id uuid, OUT full_name text, OUT role text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp
AS $$
  SELECT auth.uid(),
         (SELECT ur.full_name FROM user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1),
         (SELECT ur.role FROM user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1);
$$;

-- Запись в существующий аудит договора (contract_audit_log).
CREATE OR REPLACE FUNCTION psdc_audit(p_document_id uuid, p_event text, p_description text, p_payload jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  a record;
BEGIN
  IF p_document_id IS NULL THEN RETURN; END IF;
  SELECT * INTO a FROM psdc_actor();
  INSERT INTO contract_audit_log (contract_id, event_type, field_name, new_value, description, changed_by_role, changed_by_name)
  VALUES (p_document_id, p_event, 'psdc', p_payload, p_description, a.role, a.full_name);
END;
$$;

-- Текст ячейки: для числовой ячейки — отображаемое значение (w), иначе значение.
CREATE OR REPLACE FUNCTION psdc_cell_value(p_cell jsonb)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_cell) IS DISTINCT FROM 'object' THEN NULL
    WHEN p_cell ->> 't' = 'n' THEN COALESCE(p_cell ->> 'w', p_cell ->> 'v')
    ELSE p_cell ->> 'v'
  END;
$$;

-- Нормализация заголовка: внешние/повторные пробелы и переносы, ё/е, регистр.
-- Совершенно другие заголовки не «угадываются».
CREATE OR REPLACE FUNCTION psdc_norm_header(p_text text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT lower(btrim(regexp_replace(translate(COALESCE(p_text, ''), 'ёЁ', 'еЕ'),
                                    '[[:space:]' || chr(160) || chr(8199) || chr(8239) || ']+', ' ', 'g')));
$$;

-- Разбор числа из ячейки в NUMERIC без двоичного float.
--   числовая ячейка Excel → её точное десятичное представление;
--   текст: «1000000.25», «1000000,25», «1 000 000,25», неразрывные пробелы;
--   формула → только сохранённый числовой результат (с предупреждением), сама
--   формула не исполняется.
-- Возвращает одну строку (val, err, warn). Написана одним SELECT на SQL, чтобы
-- планировщик встраивал её в запрос проверки: на ведомость из тысяч строк это
-- десятки тысяч вызовов.
DROP FUNCTION IF EXISTS psdc_parse_decimal(jsonb);
CREATE OR REPLACE FUNCTION psdc_parse_decimal(p_cell jsonb)
RETURNS TABLE (val numeric, err text, warn text)
LANGUAGE sql IMMUTABLE
AS $$
  SELECT
    CASE WHEN x.e IS NULL THEN x.num END,
    x.e,
    CASE WHEN x.e IS NULL AND x.num IS NOT NULL AND x.f THEN 'formula' END
  FROM (
    SELECT q.f, CASE WHEN q.big THEN NULL ELSE q.num END AS num,
      CASE
        WHEN NOT q.obj THEN NULL
        WHEN q.f AND NOT (q.t = 'n' AND q.ok) THEN 'formula_no_value'
        WHEN q.t = 'e' THEN 'excel_error'
        WHEN q.s IS NULL OR q.s = '' THEN NULL
        WHEN NOT q.ok THEN 'not_number'
        WHEN q.big THEN 'too_large'
      END AS e
    FROM (
      SELECT r.*, COALESCE(abs(r.num) >= 1000000000000000, false) AS big
      FROM (
        SELECT y.*, CASE WHEN y.ok THEN y.s::numeric END AS num
        FROM (
          SELECT z.*,
            COALESCE(z.s <> '' AND z.s ~ CASE WHEN z.t = 'n'
              THEN '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$'
              ELSE '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$' END, false) AS ok
          FROM (
            SELECT
              COALESCE(jsonb_typeof(p_cell) = 'object', false) AS obj,
              COALESCE(p_cell ->> 't', '') AS t,
              COALESCE(p_cell ->> 'f', '') IN ('1', 'true') AS f,
              CASE
                WHEN jsonb_typeof(p_cell) IS DISTINCT FROM 'object' OR p_cell ->> 'v' IS NULL OR p_cell ->> 't' = 'e' THEN NULL
                WHEN p_cell ->> 't' = 'n' THEN p_cell ->> 'v'
                WHEN COALESCE(p_cell ->> 'f', '') IN ('1', 'true') THEN NULL
                ELSE replace(regexp_replace(p_cell ->> 'v', '[[:space:]' || chr(160) || chr(8199) || chr(8239) || ']', '', 'g'), ',', '.')
              END AS s
            OFFSET 0
          ) z
          OFFSET 0
        ) y
        OFFSET 0
      ) r
      OFFSET 0
    ) q
  ) x;
$$;

CREATE OR REPLACE FUNCTION psdc_number_message(p_label text, p_err text, p_raw text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE p_err
    WHEN 'formula_no_value' THEN format('%s: в ячейке формула без сохранённого числового значения', p_label)
    WHEN 'excel_error' THEN format('%s: ошибка Excel в ячейке (%s)', p_label, COALESCE(p_raw, '—'))
    WHEN 'too_large' THEN format('%s: слишком большое значение', p_label)
    ELSE format('%s: некорректное число «%s»', p_label, left(COALESCE(p_raw, ''), 60))
  END;
$$;

-- Ставка НДС документа. Договор и ДС на доп. работы (основание своей ветки)
-- берут своё значение; ДС на изменение — своё, если меняет это поле, иначе
-- значение изменяемого документа (так же наследует условия первый этап).
CREATE OR REPLACE FUNCTION psdc_document_vat(p_document_id uuid, OUT rate numeric, OUT includes boolean)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_temp
AS $$
DECLARE
  cur contracts%ROWTYPE;
  guard int := 0;
  rate_done boolean := false;
  incl_done boolean := false;
BEGIN
  SELECT * INTO cur FROM contracts WHERE id = p_document_id;
  WHILE FOUND AND guard < 1000 AND NOT (rate_done AND incl_done) LOOP
    guard := guard + 1;
    IF cur.record_type IN ('dp', 'ds_extra') OR cur.parent_contract_id IS NULL THEN
      IF NOT rate_done THEN rate := cur.vat_rate; rate_done := true; END IF;
      IF NOT incl_done THEN includes := cur.amount_includes_vat; incl_done := true; END IF;
      EXIT;
    END IF;
    IF NOT rate_done AND 'vat_rate' = ANY (COALESCE(cur.changed_fields, '{}')) THEN
      rate := cur.vat_rate; rate_done := true;
    END IF;
    IF NOT incl_done AND 'amount_includes_vat' = ANY (COALESCE(cur.changed_fields, '{}')) THEN
      includes := cur.amount_includes_vat; incl_done := true;
    END IF;
    SELECT * INTO cur FROM contracts WHERE id = cur.parent_contract_id;
  END LOOP;
  includes := COALESCE(includes, true);
END;
$$;

-- Предыдущая ПСДЦ для документа: ближайшая ПРИМЕНЁННАЯ вверх по цепочке
-- родителей В ТОЙ ЖЕ ВЕТКЕ. Договор и ДС на доп. работы начинают ветку сами,
-- поэтому у них предыдущей нет; подъём останавливается на основании ветки.
CREATE OR REPLACE FUNCTION psdc_find_previous(p_document_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_temp
AS $$
DECLARE
  doc contracts%ROWTYPE;
  cur contracts%ROWTYPE;
  found_id uuid;
  guard int := 0;
BEGIN
  SELECT * INTO doc FROM contracts WHERE id = p_document_id;
  IF NOT FOUND OR doc.record_type <> 'ds_vor' OR doc.parent_contract_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO cur FROM contracts WHERE id = doc.parent_contract_id;
  WHILE FOUND AND guard < 1000 LOOP
    guard := guard + 1;
    SELECT p.id INTO found_id FROM psdc p WHERE p.document_id = cur.id AND p.state = 'applied';
    IF found_id IS NOT NULL THEN
      RETURN found_id;
    END IF;
    IF cur.record_type IN ('dp', 'ds_extra') OR cur.parent_contract_id IS NULL THEN
      RETURN NULL;
    END IF;
    SELECT * INTO cur FROM contracts WHERE id = cur.parent_contract_id;
  END LOOP;
  RETURN NULL;
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 5) Расчётный движок и проверка. ЕДИНСТВЕННАЯ реализация формул ПСДЦ.
--
-- Процесс (не deleted):
--   K = ROUND(ROUND(I,5) × ROUND(J,2), 2)          (J пусто → 0)
--   M = ROUND(ROUND(I,5) × ROUND(L,2), 2)          (L пусто → 0)
--   N = ROUND(ROUND(J,2) + ROUND(L,2), 2)
--   O = M, если D = «ДМ»; иначе ROUND(K + M, 2)     — ДМ исключает только материал
-- Секция S (не deleted): по всем не deleted процессам, чей № начинается с S.№ + «.»
--   K = ROUND(SUM(K без ДМ), 2);  M = ROUND(SUM(M), 2) — работы ДМ входят;
--   N = NULL;  O = ROUND(K + M, 2)
-- Итог — только из процессов (секции не суммируются — нет двойного счёта):
--   Материалы = ROUND(SUM(K без ДМ), 2); Работы = ROUND(SUM(M), 2);
--   Итого = ROUND(Материалы + Работы, 2), и обязано совпасть с SUM(O).
CREATE OR REPLACE FUNCTION psdc_validate_internal(p_psdc_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  p psdc%ROWTYPE;
  canon CONSTANT text[] := ARRAY[
    '№ п/п', 'Тип ресурса', 'Шифр', 'Давальческий материал', 'Статья затрат',
    'Наименование работы', 'Ед. изм.', 'Норма расхода', 'Объём', 'Цена за материал',
    'Стоимость за материал', 'Цена за работу', 'Стоимость за работу', 'Единичная расценка',
    'Общая стоимость', 'Завод-изготовитель', 'Применяемые материалы',
    'Место проведения работ', 'Комментарий', 'ID строки в системе'];
  cap CONSTANT int := 300;
  hdr jsonb;
  v_col int;
  v_prev uuid;
  v_rate numeric;
  v_incl boolean;
  v_tm numeric;
  v_tw numeric;
  v_t numeric;
  v_sum_o numeric;
  v_dm numeric;
  v_errors int;
  v_warnings int;
  v_cnt int;
  v_legacy record;
  v_file_rate numeric;
  v_vat numeric;
  v_sections int;
  v_processes int;
  v_deleted int;
  v_missing_t int;
BEGIN
  SELECT * INTO p FROM psdc WHERE id = p_psdc_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ПСДЦ не найдена';
  END IF;

  DELETE FROM psdc_issues WHERE psdc_id = p.id;
  DELETE FROM psdc_rows WHERE psdc_id = p.id;

  -- Ошибки уровня файла, найденные при чтении XLSX (не читается, нет листа…).
  INSERT INTO psdc_issues (psdc_id, severity, code, message)
  SELECT p.id, 'error', 'file', m
  FROM jsonb_array_elements_text(COALESCE(p.source_meta -> 'fatal', '[]'::jsonb)) m;

  -- Шапка A:T. Порядок и названия не меняются, лишних обязательных столбцов нет.
  IF NOT EXISTS (SELECT 1 FROM psdc_issues WHERE psdc_id = p.id) THEN
    hdr := COALESCE(p.source_meta -> 'header', '[]'::jsonb);
    FOR v_col IN 1..20 LOOP
      IF psdc_norm_header(hdr ->> (v_col - 1)) IS DISTINCT FROM psdc_norm_header(canon[v_col]) THEN
        INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
        VALUES (p.id, 'error', 1, chr(64 + v_col) || '1', canon[v_col], 'header',
          format('Заголовок столбца %s должен быть «%s»%s', chr(64 + v_col), canon[v_col],
            CASE WHEN COALESCE(btrim(hdr ->> (v_col - 1)), '') = '' THEN ' — ячейка пуста'
                 ELSE format(' — в файле «%s»', left(btrim(hdr ->> (v_col - 1)), 80)) END));
      END IF;
    END LOOP;
  END IF;

  IF EXISTS (SELECT 1 FROM psdc_issues WHERE psdc_id = p.id AND severity = 'error') THEN
    -- Со сдвинутыми столбцами разбирать строки бессмысленно: ошибки были бы мусором.
    UPDATE psdc SET
      state = 'invalid', validated_at = now(),
      error_count = (SELECT count(*) FROM psdc_issues WHERE psdc_id = p.id AND severity = 'error'),
      warning_count = 0, section_count = NULL, process_count = NULL, legacy_deleted_count = NULL,
      total_material = NULL, total_work = NULL, total = NULL, dm_material_excluded = NULL,
      vat_rate_snapshot = NULL, vat_included_snapshot = NULL, vat_amount = NULL
    WHERE id = p.id;
    RETURN;
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS psdc_work (
    row_id uuid, row_order int, excel_row int,
    num text, rtype text, kind text, is_dm boolean, is_deleted boolean,
    code text, dm_text text, cost_item text, name text, unit text,
    manufacturer text, materials text, work_location text, comment text,
    h_raw text, i_raw text, j_raw text, l_raw text,
    h numeric, h_e text, h_w text,
    i numeric, i_e text, i_w text,
    j numeric, j_e text, j_w text,
    l numeric, l_e text, l_w text,
    ck numeric, cm numeric, cn numeric, co numeric,
    t_ref text, prefixes text[], logical_id text, parent_id uuid,
    k numeric, m numeric, n numeric, o numeric
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.psdc_work;

  -- Разбор строк и расчёт процессов одним проходом. Ячейки строки извлекаются
  -- из JSONB один раз; префиксы номера («5.1.10» → «5», «5.1») считаются здесь же
  -- и дальше служат и привязке к секции, и итогам секций.
  --   K = ROUND(ROUND(I,5) × ROUND(J,2), 2);   M = ROUND(ROUND(I,5) × ROUND(L,2), 2)
  --   N = ROUND(ROUND(J,2) + ROUND(L,2), 2);   O = M при ДМ, иначе ROUND(K + M, 2)
  INSERT INTO pg_temp.psdc_work (
    row_id, row_order, excel_row, num, rtype, kind, is_dm, is_deleted,
    code, dm_text, cost_item, name, unit, manufacturer, materials, work_location, comment,
    h_raw, i_raw, j_raw, l_raw,
    h, h_e, h_w, i, i_e, i_w, j, j_e, j_w, l, l_e, l_w,
    ck, cm, cn, co, t_ref, prefixes, k, m, n, o)
  SELECT
    b.row_id, b.row_order, b.excel_row, b.num, b.rtype, b.kind, b.is_dm, b.is_deleted,
    b.code, b.dm_text, b.cost_item, b.name, b.unit, b.manufacturer, b.materials, b.work_location, b.comment,
    b.h_raw, b.i_raw, b.j_raw, b.l_raw,
    b.h, b.h_e, b.h_w, b.i, b.i_e, b.i_w, b.j, b.j_e, b.j_w, b.l, b.l_e, b.l_w,
    b.ck, b.cm, b.cn, b.co, b.t_ref, b.prefixes,
    b.k, b.m, b.n,
    CASE WHEN b.k IS NOT NULL THEN CASE WHEN b.is_dm THEN b.m ELSE round(b.k + b.m, 2) END END
  FROM (
    SELECT a.*,
      CASE WHEN a.calc THEN round(round(a.i, 5) * round(COALESCE(a.j, 0), 2), 2) END AS k,
      CASE WHEN a.calc THEN round(round(a.i, 5) * round(COALESCE(a.l, 0), 2), 2) END AS m,
      CASE WHEN a.calc THEN round(round(COALESCE(a.j, 0), 2) + round(COALESCE(a.l, 0), 2), 2) END AS n
    FROM (
      SELECT
        gen_random_uuid() AS row_id,
        (row_number() OVER (ORDER BY s.excel_row))::int AS row_order,
        s.excel_row,
        t.num, t.rtype, t.kind, t.is_dm, t.is_deleted,
        t.code, t.dm_text, t.cost_item, t.name, t.unit, t.manufacturer, t.materials, t.work_location, t.comment,
        t.h_raw, t.i_raw, t.j_raw, t.l_raw,
        hh.val AS h, hh.err AS h_e, hh.warn AS h_w,
        ii.val AS i, ii.err AS i_e, ii.warn AS i_w,
        jj.val AS j, jj.err AS j_e, jj.warn AS j_w,
        ll.val AS l, ll.err AS l_e, ll.warn AS l_w,
        kk.val AS ck, mm.val AS cm, nn.val AS cn, oo.val AS co,
        t.t_ref,
        CASE WHEN t.num IS NULL OR strpos(t.num, '.') = 0 THEN '{}'::text[]
             ELSE ARRAY(SELECT array_to_string(t.parts[1:g], '.') FROM generate_series(1, cardinality(t.parts) - 1) g ORDER BY g)
        END AS prefixes,
        (t.kind = 'process' AND NOT t.is_deleted AND ii.val IS NOT NULL
          AND ii.err IS NULL AND jj.err IS NULL AND ll.err IS NULL) AS calc
      FROM psdc_source_rows s
      CROSS JOIN LATERAL jsonb_to_record(s.cells) AS c(
        "A" jsonb, "B" jsonb, "C" jsonb, "D" jsonb, "E" jsonb, "F" jsonb, "G" jsonb, "H" jsonb, "I" jsonb, "J" jsonb,
        "K" jsonb, "L" jsonb, "M" jsonb, "N" jsonb, "O" jsonb, "P" jsonb, "Q" jsonb, "R" jsonb, "S" jsonb, "T" jsonb, "U" jsonb)
      CROSS JOIN LATERAL (
        SELECT v.*,
          CASE lower(COALESCE(v.rtype, ''))
            WHEN 'секция' THEN 'section'
            WHEN 'комплексный процесс' THEN 'process'
          END AS kind,
          lower(COALESCE(v.dm_text, '')) = 'дм' AS is_dm,
          p.has_legacy_u AND lower(btrim(COALESCE(v.u_raw, ''))) = 'deleted' AS is_deleted,
          string_to_array(v.num, '.') AS parts
        FROM (
          SELECT
            NULLIF(btrim(psdc_cell_value(c."A")), '') AS num,
            NULLIF(btrim(psdc_cell_value(c."B")), '') AS rtype,
            NULLIF(psdc_cell_value(c."C"), '') AS code,
            NULLIF(btrim(psdc_cell_value(c."D")), '') AS dm_text,
            NULLIF(psdc_cell_value(c."E"), '') AS cost_item,
            NULLIF(psdc_cell_value(c."F"), '') AS name,
            NULLIF(psdc_cell_value(c."G"), '') AS unit,
            NULLIF(psdc_cell_value(c."P"), '') AS manufacturer,
            NULLIF(psdc_cell_value(c."Q"), '') AS materials,
            NULLIF(psdc_cell_value(c."R"), '') AS work_location,
            NULLIF(psdc_cell_value(c."S"), '') AS comment,
            psdc_cell_value(c."H") AS h_raw,
            psdc_cell_value(c."I") AS i_raw,
            psdc_cell_value(c."J") AS j_raw,
            psdc_cell_value(c."L") AS l_raw,
            psdc_cell_value(c."U") AS u_raw,
            NULLIF(btrim(psdc_cell_value(c."T")), '') AS t_ref
          OFFSET 0
        ) v
        OFFSET 0
      ) t
      CROSS JOIN LATERAL psdc_parse_decimal(c."H") hh
      CROSS JOIN LATERAL psdc_parse_decimal(c."I") ii
      CROSS JOIN LATERAL psdc_parse_decimal(c."J") jj
      CROSS JOIN LATERAL psdc_parse_decimal(c."L") ll
      CROSS JOIN LATERAL psdc_parse_decimal(c."K") kk
      CROSS JOIN LATERAL psdc_parse_decimal(c."M") mm
      CROSS JOIN LATERAL psdc_parse_decimal(c."N") nn
      CROSS JOIN LATERAL psdc_parse_decimal(c."O") oo
      WHERE s.psdc_id = p.id
    ) a
  ) b;

  CREATE INDEX IF NOT EXISTS psdc_work_num_idx ON pg_temp.psdc_work (num);
  ANALYZE pg_temp.psdc_work;

  -- Тип строки.
  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, CASE WHEN w.is_deleted THEN 'warning' ELSE 'error' END, w.excel_row, 'B' || w.excel_row, 'Тип ресурса',
    'resource_type',
    CASE WHEN w.rtype IS NULL THEN 'Не указан тип ресурса' ELSE format('Неизвестный тип ресурса «%s»', left(w.rtype, 60)) END
      || CASE WHEN w.is_deleted THEN ' (строка помечена deleted)' ELSE '' END
  FROM pg_temp.psdc_work w
  WHERE w.kind IS NULL;

  -- Числовые исходные поля процесса.
  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, CASE WHEN w.is_deleted THEN 'warning' ELSE 'error' END, w.excel_row, x.col || w.excel_row, x.label,
    'number',
    psdc_number_message(x.label, x.err, x.raw)
      || CASE WHEN w.is_deleted THEN ' (строка помечена deleted и не участвует в расчёте)' ELSE '' END
  FROM pg_temp.psdc_work w
  CROSS JOIN LATERAL (VALUES
    ('H', 'Норма расхода', w.h_e, w.h_raw), ('I', 'Объём', w.i_e, w.i_raw),
    ('J', 'Цена за материал', w.j_e, w.j_raw), ('L', 'Цена за работу', w.l_e, w.l_raw)) x(col, label, err, raw)
  WHERE w.kind = 'process' AND x.err IS NOT NULL;

  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, 'warning', w.excel_row, x.col || w.excel_row, x.label, 'source_formula',
    format('%s: в исходной ячейке формула — формула не исполняется, использовано сохранённое значение %s', x.label, x.val::text)
  FROM pg_temp.psdc_work w
  CROSS JOIN LATERAL (VALUES
    ('H', 'Норма расхода', w.h_w, w.h), ('I', 'Объём', w.i_w, w.i),
    ('J', 'Цена за материал', w.j_w, w.j), ('L', 'Цена за работу', w.l_w, w.l)) x(col, label, wrn, val)
  WHERE w.kind = 'process' AND NOT w.is_deleted AND x.wrn = 'formula';

  -- Обязательные поля активной секции.
  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, 'error', w.excel_row, x.col || w.excel_row, x.label, 'required', x.msg
  FROM pg_temp.psdc_work w
  CROSS JOIN LATERAL (VALUES
    ('A', '№ п/п', '№ п/п секции не заполнен', w.num IS NULL),
    ('F', 'Наименование', 'Не заполнено наименование секции', COALESCE(btrim(w.name), '') = '')
  ) x(col, label, msg, bad)
  WHERE w.kind = 'section' AND NOT w.is_deleted AND x.bad;

  -- Обязательные поля активного процесса.
  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, 'error', w.excel_row, x.col || w.excel_row, x.label, 'required', x.msg
  FROM pg_temp.psdc_work w
  CROSS JOIN LATERAL (VALUES
    ('A', '№ п/п', '№ п/п процесса не заполнен', w.num IS NULL),
    ('F', 'Наименование', 'Не заполнено наименование работы', COALESCE(btrim(w.name), '') = ''),
    ('G', 'Ед. изм.', 'Не заполнена единица измерения', COALESCE(btrim(w.unit), '') = ''),
    ('I', 'Объём', 'Не заполнен объём', w.i IS NULL AND w.i_e IS NULL)
  ) x(col, label, msg, bad)
  WHERE w.kind = 'process' AND NOT w.is_deleted AND x.bad;

  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, 'error', w.excel_row, 'I' || w.excel_row, 'Объём', 'volume_negative', 'Некорректный объём: значение отрицательное'
  FROM pg_temp.psdc_work w
  WHERE w.kind = 'process' AND NOT w.is_deleted AND w.i < 0;

  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, 'warning', w.excel_row, 'I' || w.excel_row, 'Объём', 'volume_zero', 'Объём равен 0'
  FROM pg_temp.psdc_work w
  WHERE w.kind = 'process' AND NOT w.is_deleted AND w.i IS NOT NULL AND round(w.i, 5) = 0;

  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, 'warning', w.excel_row, x.col || w.excel_row, x.label, 'price_negative', format('%s: отрицательное значение', x.label)
  FROM pg_temp.psdc_work w
  CROSS JOIN LATERAL (VALUES ('J', 'Цена за материал', w.j), ('L', 'Цена за работу', w.l)) x(col, label, val)
  WHERE w.kind = 'process' AND NOT w.is_deleted AND x.val < 0;

  -- Дубли номеров секций делают принадлежность процессов неоднозначной.
  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, 'error', w.excel_row, 'A' || w.excel_row, '№ п/п', 'section_duplicate',
    format('Номер секции «%s» повторяется (строки %s)', w.num, d.rows_list)
  FROM pg_temp.psdc_work w
  JOIN (
    SELECT num, string_agg(excel_row::text, ', ' ORDER BY excel_row) AS rows_list
    FROM pg_temp.psdc_work
    WHERE kind = 'section' AND NOT is_deleted AND num IS NOT NULL
    GROUP BY num HAVING count(*) > 1
  ) d ON d.num = w.num
  WHERE w.kind = 'section' AND NOT w.is_deleted;

  -- Принадлежность строки секции — по текстовому префиксу «№ секции + точка»:
  -- самая вложенная активная секция, чей номер совпадает с одним из префиксов.
  -- Числового сравнения нет: «5.10» относится к «5», а не к «5.1».
  UPDATE pg_temp.psdc_work w SET parent_id = x.section_id
  FROM (
    SELECT DISTINCT ON (c.row_id) c.row_id AS child_id, s.row_id AS section_id
    FROM pg_temp.psdc_work c
    CROSS JOIN LATERAL unnest(c.prefixes) WITH ORDINALITY u(prefix, depth)
    JOIN pg_temp.psdc_work s ON s.kind = 'section' AND NOT s.is_deleted AND s.num = u.prefix
    WHERE c.kind IS NOT NULL
    ORDER BY c.row_id, u.depth DESC, s.row_order
  ) x
  WHERE w.row_id = x.child_id;

  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, 'error', w.excel_row, 'A' || w.excel_row, '№ п/п', 'section_not_found',
    format('Не найдена секция для процесса № %s', w.num)
  FROM pg_temp.psdc_work w
  WHERE w.kind = 'process' AND NOT w.is_deleted AND w.num IS NOT NULL AND w.parent_id IS NULL;

  -- Секции: агрегат по всем не deleted процессам, чей номер начинается с № секции + «.».
  --   K = ROUND(SUM(K без ДМ), 2);  M = ROUND(SUM(M), 2) — работы ДМ входят;  O = ROUND(K + M, 2)
  UPDATE pg_temp.psdc_work s SET k = a.sk, m = a.sm, o = round(a.sk + a.sm, 2)
  FROM (
    SELECT sec.row_id,
      round(COALESCE(sum(c.k) FILTER (WHERE NOT c.is_dm), 0), 2) AS sk,
      round(COALESCE(sum(c.m), 0), 2) AS sm
    FROM pg_temp.psdc_work sec
    LEFT JOIN (
      SELECT u.prefix, c.k, c.m, c.is_dm
      FROM pg_temp.psdc_work c
      CROSS JOIN LATERAL unnest(c.prefixes) u(prefix)
      WHERE c.kind = 'process' AND NOT c.is_deleted AND c.k IS NOT NULL
    ) c ON c.prefix = sec.num
    WHERE sec.kind = 'section' AND NOT sec.is_deleted AND sec.num IS NOT NULL
    GROUP BY sec.row_id
  ) a
  WHERE s.row_id = a.row_id;

  -- Итог — только из процессов.
  SELECT
    round(COALESCE(sum(k) FILTER (WHERE NOT is_dm), 0), 2),
    round(COALESCE(sum(m), 0), 2),
    COALESCE(sum(o), 0),
    round(COALESCE(sum(k) FILTER (WHERE is_dm), 0), 2)
  INTO v_tm, v_tw, v_sum_o, v_dm
  FROM pg_temp.psdc_work
  WHERE kind = 'process' AND NOT is_deleted AND k IS NOT NULL;

  v_t := round(v_tm + v_tw, 2);
  IF v_t <> round(v_sum_o, 2) THEN
    RAISE EXCEPTION 'Внутренняя ошибка расчёта ПСДЦ: Материалы + Работы = %, сумма общих стоимостей = %', v_t, v_sum_o;
  END IF;

  SELECT count(*) FILTER (WHERE kind = 'section' AND NOT is_deleted),
         count(*) FILTER (WHERE kind = 'process' AND NOT is_deleted),
         count(*) FILTER (WHERE is_deleted),
         count(*) FILTER (WHERE t_ref IS NULL)
  INTO v_sections, v_processes, v_deleted, v_missing_t
  FROM pg_temp.psdc_work;

  IF v_processes = 0 THEN
    INSERT INTO psdc_issues (psdc_id, severity, code, message)
    VALUES (p.id, 'error', 'no_processes', 'В ведомости нет ни одного комплексного процесса');
  END IF;

  -- ID строки в системе (T): сохраняется, только если однозначно совпал с
  -- постоянным ID строки предыдущей ПСДЦ той же ветки. Иначе строка получает
  -- новый ID (её row_id) — чужую строку T изменить не может.
  v_prev := CASE WHEN p.document_id IS NOT NULL THEN psdc_find_previous(p.document_id) END;

  IF v_prev IS NOT NULL THEN
    UPDATE pg_temp.psdc_work w SET logical_id = w.t_ref
    FROM (
      SELECT t_ref FROM pg_temp.psdc_work WHERE t_ref IS NOT NULL GROUP BY t_ref HAVING count(*) = 1
    ) u
    WHERE w.t_ref = u.t_ref
      AND EXISTS (SELECT 1 FROM psdc_rows pr WHERE pr.psdc_id = v_prev AND pr.logical_line_id = w.t_ref);
  END IF;

  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, 'warning', q.excel_row, 'T' || q.excel_row, 'ID строки в системе', q.code, q.msg
  FROM (
    SELECT w.excel_row, w.row_order,
      CASE WHEN d.cnt > 1 THEN 't_duplicate' ELSE 't_unknown' END AS code,
      CASE WHEN d.cnt > 1
        THEN format('ID строки «%s» повторяется в файле — строке назначен новый ID', left(w.t_ref, 60))
        ELSE format('ID строки «%s» не найден в предыдущей ПСДЦ ветки — строке назначен новый ID', left(w.t_ref, 60))
      END AS msg,
      row_number() OVER (ORDER BY w.row_order) AS rn
    FROM pg_temp.psdc_work w
    JOIN (SELECT t_ref, count(*) AS cnt FROM pg_temp.psdc_work WHERE t_ref IS NOT NULL GROUP BY t_ref) d ON d.t_ref = w.t_ref
    WHERE w.logical_id IS NULL
  ) q
  WHERE q.rn <= cap;

  SELECT count(*) INTO v_cnt FROM pg_temp.psdc_work WHERE t_ref IS NOT NULL AND logical_id IS NULL;
  IF v_cnt > cap THEN
    INSERT INTO psdc_issues (psdc_id, severity, code, message)
    VALUES (p.id, 'warning', 't_unknown_more', format('И ещё %s строк с неизвестным или повторяющимся ID строки', v_cnt - cap));
  END IF;

  IF v_missing_t > 0 THEN
    INSERT INTO psdc_issues (psdc_id, severity, code, message)
    VALUES (p.id, 'warning', 't_missing',
      format('ID строки в системе (T) не заполнен в %s строк — при применении им будут назначены новые постоянные ID', v_missing_t));
  END IF;

  -- Сохранённые значения старого файла — только для сравнения, не для расчёта.
  INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
  SELECT p.id, 'warning', q.excel_row, q.col || q.excel_row, q.label, 'legacy_value',
    format('%s: в файле %s, расчёт системы %s', q.label, round(q.cached, 2)::text, q.calc::text)
  FROM (
    SELECT w.excel_row, x.col, x.label, x.cached, x.calc,
           row_number() OVER (ORDER BY w.row_order, x.col) AS rn
    FROM pg_temp.psdc_work w
    CROSS JOIN LATERAL (VALUES
      ('K', 'Стоимость за материал', w.ck, w.k), ('M', 'Стоимость за работу', w.cm, w.m),
      ('N', 'Единичная расценка', w.cn, w.n), ('O', 'Общая стоимость', w.co, w.o)) x(col, label, cached, calc)
    WHERE NOT w.is_deleted AND w.kind IS NOT NULL
      AND x.calc IS NOT NULL AND x.cached IS NOT NULL AND round(x.cached, 2) <> x.calc
  ) q
  WHERE q.rn <= cap;

  SELECT count(*) INTO v_cnt
  FROM pg_temp.psdc_work w
  CROSS JOIN LATERAL (VALUES (w.ck, w.k), (w.cm, w.m), (w.cn, w.n), (w.co, w.o)) x(cached, calc)
  WHERE NOT w.is_deleted AND w.kind IS NOT NULL
    AND x.calc IS NOT NULL AND x.cached IS NOT NULL AND round(x.cached, 2) <> x.calc;
  IF v_cnt > cap THEN
    INSERT INTO psdc_issues (psdc_id, severity, code, message)
    VALUES (p.id, 'warning', 'legacy_value_more', format('И ещё %s расхождений сохранённых значений файла с расчётом системы', v_cnt - cap));
  END IF;

  SELECT tk.val AS k, tm.val AS m, tt.val AS o, COALESCE(p.source_meta -> 'totals' ->> 'row', '') AS row_no
  INTO v_legacy
  FROM psdc_parse_decimal(p.source_meta -> 'totals' -> 'k') tk,
       psdc_parse_decimal(p.source_meta -> 'totals' -> 'm') tm,
       psdc_parse_decimal(p.source_meta -> 'totals' -> 'o') tt;

  IF v_legacy.o IS NOT NULL AND round(v_legacy.o, 2) <> v_t THEN
    INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
    VALUES (p.id, 'warning', NULLIF(v_legacy.row_no, '')::int, CASE WHEN v_legacy.row_no <> '' THEN 'O' || v_legacy.row_no END,
      'Итого', 'legacy_total',
      format('Итог в файле %s отличается от расчёта системы %s', round(v_legacy.o, 2)::text, v_t::text));
  END IF;
  IF v_legacy.k IS NOT NULL AND round(v_legacy.k, 2) <> v_tm THEN
    INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
    VALUES (p.id, 'warning', NULLIF(v_legacy.row_no, '')::int, CASE WHEN v_legacy.row_no <> '' THEN 'K' || v_legacy.row_no END,
      'Итого материалы', 'legacy_total',
      format('Материалы в итоге файла %s, расчёт системы %s', round(v_legacy.k, 2)::text, v_tm::text));
  END IF;
  IF v_legacy.m IS NOT NULL AND round(v_legacy.m, 2) <> v_tw THEN
    INSERT INTO psdc_issues (psdc_id, severity, excel_row, cell, field, code, message)
    VALUES (p.id, 'warning', NULLIF(v_legacy.row_no, '')::int, CASE WHEN v_legacy.row_no <> '' THEN 'M' || v_legacy.row_no END,
      'Итого работы', 'legacy_total',
      format('Работы в итоге файла %s, расчёт системы %s (в старых формулах ДМ мог исключаться и из работ)', round(v_legacy.m, 2)::text, v_tw::text));
  END IF;

  -- НДС — только из документа. Подпись в файле — диагностика.
  IF p.document_id IS NOT NULL THEN
    SELECT rate, includes INTO v_rate, v_incl FROM psdc_document_vat(p.document_id);
    v_vat := CASE
      WHEN v_rate IS NULL OR v_rate = 0 OR v_incl = false THEN 0
      ELSE round(v_t * v_rate / (100 + v_rate), 2)
    END;
  ELSE
    v_rate := NULL;
    v_incl := NULL;
    v_vat := NULL;
  END IF;

  v_file_rate := NULL;
  IF COALESCE(p.source_meta -> 'totals' ->> 'vat_text', '') ~ '[0-9]' THEN
    BEGIN
      v_file_rate := replace((regexp_match(p.source_meta -> 'totals' ->> 'vat_text', '([0-9]+([.,][0-9]+)?)\s*%'))[1], ',', '.')::numeric;
    EXCEPTION WHEN others THEN
      v_file_rate := NULL;
    END;
  END IF;
  IF p.document_id IS NOT NULL AND v_file_rate IS NOT NULL
     AND v_file_rate IS DISTINCT FROM (CASE WHEN v_incl = false THEN NULL ELSE v_rate END) THEN
    INSERT INTO psdc_issues (psdc_id, severity, excel_row, code, message)
    VALUES (p.id, 'warning', NULLIF(p.source_meta -> 'totals' ->> 'vat_row', '')::int, 'vat_rate_mismatch',
      format('В файле указан НДС %s%%, у документа %s — расчёт выполнен по ставке документа', v_file_rate::text,
        CASE WHEN v_rate IS NULL OR v_rate = 0 OR v_incl = false THEN 'без НДС' ELSE v_rate::text || '%' END));
  END IF;

  INSERT INTO psdc_rows (
    id, psdc_id, logical_line_id, source_line_id, row_order, excel_row, row_kind,
    number, resource_type, code, customer_material, is_customer_material, cost_item, name, unit,
    consumption_norm, volume, material_price, material_cost, work_price, work_cost, unit_price, total_cost,
    manufacturer, materials, work_location, comment, parent_section_id, legacy_deleted)
  SELECT
    w.row_id, p.id, COALESCE(w.logical_id, w.row_id::text), w.t_ref, w.row_order, w.excel_row, w.kind,
    w.num, w.rtype, w.code, w.dm_text, w.kind = 'process' AND w.is_dm, w.cost_item, w.name, w.unit,
    CASE WHEN w.kind = 'process' THEN round(w.h, 2) END,
    CASE WHEN w.kind = 'process' THEN round(w.i, 5) END,
    CASE WHEN w.kind = 'process' THEN round(w.j, 2) END,
    w.k,
    CASE WHEN w.kind = 'process' THEN round(w.l, 2) END,
    w.m, w.n, w.o,
    w.manufacturer, w.materials, w.work_location, w.comment,
    w.parent_id,
    w.is_deleted
  FROM pg_temp.psdc_work w;

  SELECT count(*) FILTER (WHERE severity = 'error'), count(*) FILTER (WHERE severity = 'warning')
  INTO v_errors, v_warnings
  FROM psdc_issues WHERE psdc_id = p.id;

  UPDATE psdc SET
    state = CASE WHEN v_errors > 0 THEN 'invalid' ELSE 'validated' END,
    validated_at = now(),
    previous_psdc_id = v_prev,
    error_count = v_errors,
    warning_count = v_warnings,
    section_count = v_sections,
    process_count = v_processes,
    legacy_deleted_count = v_deleted,
    total_material = v_tm,
    total_work = v_tw,
    total = v_t,
    dm_material_excluded = v_dm,
    vat_rate_snapshot = v_rate,
    vat_included_snapshot = v_incl,
    vat_amount = v_vat,
    file_vat_rate = v_file_rate,
    legacy_total = round(v_legacy.o, 2)
  WHERE id = p.id;
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 6) Представление ПСДЦ для клиента: денежные значения — текстом, чтобы в
--    браузере они не проходили через двоичный float.

CREATE OR REPLACE FUNCTION psdc_json(p_psdc_id uuid, p_issue_limit int DEFAULT 500)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'id', p.id,
    'document_id', p.document_id,
    'batch_id', p.batch_id,
    'state', p.state,
    'previous_psdc_id', p.previous_psdc_id,
    'match_method', p.match_method,
    'match_note', p.match_note,
    'source_filename', p.source_filename,
    'source_size', p.source_size,
    'source_hash', p.source_hash,
    'source_s3_document_id', p.source_s3_document_id,
    'sheet_name', p.sheet_name,
    'has_legacy_u', p.has_legacy_u,
    'uploaded_by_name', p.uploaded_by_name,
    'uploaded_at', p.uploaded_at,
    'validated_at', p.validated_at,
    'applied_at', p.applied_at,
    'applied_by_name', p.applied_by_name,
    'deleted_at', p.deleted_at,
    'section_count', p.section_count,
    'process_count', p.process_count,
    'legacy_deleted_count', p.legacy_deleted_count,
    'error_count', p.error_count,
    'warning_count', p.warning_count,
    'total_material', p.total_material::text,
    'total_work', p.total_work::text,
    'total', p.total::text,
    'dm_material_excluded', p.dm_material_excluded::text,
    'vat_rate', p.vat_rate_snapshot::text,
    'vat_included', p.vat_included_snapshot,
    'vat_amount', p.vat_amount::text,
    'file_vat_rate', p.file_vat_rate::text,
    'legacy_total', p.legacy_total::text,
    'issues', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'severity', i.severity, 'excel_row', i.excel_row, 'cell', i.cell,
               'field', i.field, 'code', i.code, 'message', i.message)
             ORDER BY (i.severity = 'warning'), i.excel_row NULLS FIRST, i.id)
      FROM (
        SELECT * FROM psdc_issues WHERE psdc_id = p.id
        ORDER BY (severity = 'warning'), excel_row NULLS FIRST, id
        LIMIT GREATEST(p_issue_limit, 0)
      ) i
    ), '[]'::jsonb)
  )
  FROM psdc p
  WHERE p.id = p_psdc_id;
$$;

CREATE OR REPLACE FUNCTION psdc_get(p_psdc_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT psdc_visible(p_psdc_id) THEN
    RAISE EXCEPTION 'ПСДЦ не найдена или нет доступа' USING ERRCODE = '42501';
  END IF;
  RETURN psdc_json(p_psdc_id, 5000);
END;
$$;

CREATE OR REPLACE FUNCTION psdc_get_rows(p_psdc_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT psdc_visible(p_psdc_id) THEN
    RAISE EXCEPTION 'ПСДЦ не найдена или нет доступа' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', r.id, 'logical_line_id', r.logical_line_id, 'row_order', r.row_order, 'excel_row', r.excel_row,
      'row_kind', r.row_kind, 'number', r.number, 'resource_type', r.resource_type, 'code', r.code,
      'customer_material', r.customer_material, 'is_customer_material', r.is_customer_material,
      'cost_item', r.cost_item, 'name', r.name, 'unit', r.unit,
      'consumption_norm', r.consumption_norm::text, 'volume', r.volume::text,
      'material_price', r.material_price::text, 'material_cost', r.material_cost::text,
      'work_price', r.work_price::text, 'work_cost', r.work_cost::text,
      'unit_price', r.unit_price::text, 'total_cost', r.total_cost::text,
      'manufacturer', r.manufacturer, 'materials', r.materials, 'work_location', r.work_location,
      'comment', r.comment, 'parent_section_id', r.parent_section_id, 'legacy_deleted', r.legacy_deleted
    ) ORDER BY r.row_order)
    FROM psdc_rows r
    WHERE r.psdc_id = p_psdc_id
  ), '[]'::jsonb);
END;
$$;

-- Состояние ПСДЦ документа для карточки: применённая, текущая загрузка из
-- карточки и почему финансовые действия недоступны.
CREATE OR REPLACE FUNCTION psdc_document_state(p_document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_temp
AS $$
DECLARE
  doc contracts%ROWTYPE;
  v_applied uuid;
  v_staging uuid;
  v_prev uuid;
  v_rate numeric;
  v_incl boolean;
BEGIN
  SELECT * INTO doc FROM contracts WHERE id = p_document_id;
  IF NOT FOUND OR NOT psdc_can_view_document(p_document_id) THEN
    RAISE EXCEPTION 'Документ не найден или нет доступа' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_applied FROM psdc WHERE document_id = doc.id AND state = 'applied';
  SELECT id INTO v_staging FROM psdc
  WHERE document_id = doc.id AND batch_id IS NULL AND state IN ('uploaded', 'validated', 'invalid')
  ORDER BY uploaded_at DESC LIMIT 1;
  v_prev := psdc_find_previous(doc.id);
  SELECT rate, includes INTO v_rate, v_incl FROM psdc_document_vat(doc.id);

  RETURN jsonb_build_object(
    'document', jsonb_build_object(
      'id', doc.id, 'display_id', doc.display_id, 'record_type', doc.record_type, 'status', doc.status,
      'manual_amount', doc.contract_amount::text, 'psdc_total', doc.psdc_total::text,
      'vat_rate', v_rate::text, 'vat_included', v_incl),
    'can_edit', psdc_can_edit_document(doc.id),
    'lock_reason', psdc_document_lock_reason(doc),
    'applied', CASE WHEN v_applied IS NOT NULL THEN psdc_json(v_applied, 0) END,
    'staging', CASE WHEN v_staging IS NOT NULL THEN psdc_json(v_staging, 1000) END,
    'previous', CASE WHEN v_prev IS NOT NULL THEN (
      SELECT jsonb_build_object('id', pp.id, 'document_id', pp.document_id, 'display_id', c.display_id,
                                'record_type', c.record_type, 'total', pp.total::text)
      FROM psdc pp JOIN contracts c ON c.id = pp.document_id WHERE pp.id = v_prev) END,
    'pending_batch_files', (
      SELECT count(*) FROM psdc WHERE document_id = doc.id AND batch_id IS NOT NULL
        AND state IN ('uploaded', 'validated', 'invalid'))
  );
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 7) Операции.

-- Внутренняя отмена временной загрузки: состояние + освобождение строк.
CREATE OR REPLACE FUNCTION psdc_discard_internal(p_psdc_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE psdc SET state = 'cancelled', cancelled_at = now() WHERE id = p_psdc_id;
  DELETE FROM psdc_issues WHERE psdc_id = p_psdc_id;
  DELETE FROM psdc_rows WHERE psdc_id = p_psdc_id;
  DELETE FROM psdc_source_rows WHERE psdc_id = p_psdc_id;
END;
$$;

-- Шаг 1 «Импорт ВОР»: временная версия. Документ при этом не меняется.
-- p_document_id — из контекста карточки; для массовой загрузки NULL + p_batch_id.
CREATE OR REPLACE FUNCTION psdc_create(p_document_id uuid, p_batch_id uuid, p_meta jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  doc contracts%ROWTYPE;
  a record;
  v_reason text;
  v_id uuid;
  v_name text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Требуется вход в систему' USING ERRCODE = '42501';
  END IF;
  IF p_meta IS NULL OR jsonb_typeof(p_meta) <> 'object' OR pg_column_size(p_meta) > 200000 THEN
    RAISE EXCEPTION 'Некорректные сведения о файле';
  END IF;
  v_name := left(btrim(COALESCE(p_meta ->> 'source_filename', '')), 255);
  IF v_name = '' THEN
    RAISE EXCEPTION 'Не указано имя файла';
  END IF;

  IF p_document_id IS NOT NULL THEN
    SELECT * INTO doc FROM contracts WHERE id = p_document_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Документ не найден';
    END IF;
    v_reason := psdc_document_lock_reason(doc);
    IF v_reason IS NOT NULL THEN
      RAISE EXCEPTION '%', v_reason USING ERRCODE = '42501';
    END IF;
    -- Новая загрузка из карточки заменяет предыдущую непримененную загрузку.
    PERFORM psdc_discard_internal(x.id)
    FROM psdc x
    WHERE x.document_id = doc.id AND x.batch_id IS NULL AND x.state IN ('uploaded', 'validated', 'invalid');
  ELSE
    IF p_batch_id IS NULL OR NOT EXISTS (SELECT 1 FROM psdc_batches WHERE id = p_batch_id) THEN
      RAISE EXCEPTION 'Пакет массовой загрузки не найден';
    END IF;
    IF NOT psdc_contracts_permission(true) THEN
      RAISE EXCEPTION 'Недостаточно прав для загрузки ПСДЦ' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT * INTO a FROM psdc_actor();
  INSERT INTO psdc (document_id, batch_id, state, match_method, source_filename, source_hash, source_size,
                    sheet_name, has_legacy_u, source_meta, uploaded_by, uploaded_by_name)
  VALUES (p_document_id, CASE WHEN p_document_id IS NULL THEN p_batch_id END, 'uploaded',
          CASE WHEN p_document_id IS NOT NULL THEN 'card' END,
          v_name, left(p_meta ->> 'source_hash', 128), NULLIF(p_meta ->> 'source_size', '')::bigint,
          left(p_meta ->> 'sheet_name', 120), COALESCE((p_meta ->> 'has_u')::boolean, false),
          jsonb_build_object(
            'header', COALESCE(p_meta -> 'header', '[]'::jsonb),
            'totals', COALESCE(p_meta -> 'totals', '{}'::jsonb),
            'fatal', COALESCE(p_meta -> 'fatal', '[]'::jsonb)),
          a.user_id, a.full_name)
  RETURNING id INTO v_id;

  IF p_document_id IS NOT NULL THEN
    PERFORM psdc_audit(p_document_id, 'psdc_uploaded', format('Загружена ПСДЦ «%s» (не применена)', v_name),
      jsonb_build_object('psdc_id', v_id, 'file', v_name));
  END IF;
  RETURN v_id;
END;
$$;

-- Строки временной версии — порциями, чтобы большой файл не упирался в размер запроса.
CREATE OR REPLACE FUNCTION psdc_add_rows(p_psdc_id uuid, p_rows jsonb)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  p psdc%ROWTYPE;
  v_count int;
BEGIN
  SELECT * INTO p FROM psdc WHERE id = p_psdc_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ПСДЦ не найдена';
  END IF;
  IF p.state <> 'uploaded' OR p.validated_at IS NOT NULL THEN
    RAISE EXCEPTION 'Строки можно добавлять только до проверки файла';
  END IF;
  IF p.uploaded_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Загрузку продолжает только её автор' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) > 5000 THEN
    RAISE EXCEPTION 'За один запрос передаётся не более 5000 строк';
  END IF;
  -- Предел согласован с браузером (PSDC_LIMITS.rows): проверка такой ведомости
  -- укладывается в лимит времени запроса Supabase.
  IF p.source_row_count + jsonb_array_length(p_rows) > 25000 THEN
    RAISE EXCEPTION 'Слишком много строк в ведомости (более 25 000)';
  END IF;

  INSERT INTO psdc_source_rows (psdc_id, excel_row, cells)
  SELECT p.id, (e ->> 'r')::int,
         COALESCE((
           SELECT jsonb_object_agg(k, v)
           FROM jsonb_each(e -> 'c') AS kv(k, v)
           WHERE k ~ '^[A-U]$' AND jsonb_typeof(v) = 'object' AND length(v::text) <= 40000
         ), '{}'::jsonb)
  FROM jsonb_array_elements(p_rows) e
  WHERE (e ->> 'r') ~ '^[0-9]{1,7}$';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE psdc SET source_row_count = source_row_count + v_count WHERE id = p.id;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION psdc_set_source_file(p_psdc_id uuid, p_s3_document_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  p psdc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM psdc WHERE id = p_psdc_id FOR UPDATE;
  IF NOT FOUND OR p.uploaded_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ПСДЦ не найдена' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM s3_documents d
    WHERE d.id = p_s3_document_id AND d.owner_type = 'general' AND d.owner_id = p.id
  ) THEN
    RAISE EXCEPTION 'Файл-источник не относится к этой ПСДЦ';
  END IF;
  UPDATE psdc SET source_s3_document_id = p_s3_document_id WHERE id = p.id;
END;
$$;

-- Проверка ВОР: разбор, расчёт, предупреждения. На сумму документа не влияет.
CREATE OR REPLACE FUNCTION psdc_validate(p_psdc_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  p psdc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM psdc WHERE id = p_psdc_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ПСДЦ не найдена';
  END IF;
  IF p.document_id IS NOT NULL THEN
    IF NOT psdc_can_edit_document(p.document_id) THEN
      RAISE EXCEPTION 'Недостаточно прав для изменения документа' USING ERRCODE = '42501';
    END IF;
  ELSIF p.uploaded_by IS DISTINCT FROM auth.uid() AND NOT psdc_contracts_permission(true) THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  IF p.state NOT IN ('uploaded', 'validated', 'invalid') THEN
    RAISE EXCEPTION 'Проверять можно только непримененную загрузку';
  END IF;

  PERFORM psdc_validate_internal(p.id);
  SELECT * INTO p FROM psdc WHERE id = p_psdc_id;

  IF p.document_id IS NOT NULL THEN
    PERFORM psdc_audit(p.document_id, 'psdc_validated',
      format('Проверена ПСДЦ «%s»: %s', p.source_filename,
        CASE WHEN p.error_count > 0 THEN format('ошибок %s', p.error_count)
             ELSE format('итого %s', p.total::text) END),
      jsonb_build_object('psdc_id', p.id, 'errors', p.error_count, 'warnings', p.warning_count, 'total', p.total::text));
  END IF;
  RETURN psdc_json(p.id, 1000);
END;
$$;

-- Применить ВОР — атомарно. Одна транзакция: блокировки → повторная проверка на
-- актуальных данных документа → единственная применённая версия → сумма документа
-- → аудит. Любая ошибка откатывает всё.
CREATE OR REPLACE FUNCTION psdc_apply(p_psdc_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  p psdc%ROWTYPE;
  doc contracts%ROWTYPE;
  a record;
  v_reason text;
  v_other bigint;
  v_rate numeric;
  v_incl boolean;
BEGIN
  SELECT * INTO p FROM psdc WHERE id = p_psdc_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ПСДЦ не найдена';
  END IF;
  IF p.state = 'applied' THEN
    RAISE EXCEPTION 'Эта ПСДЦ уже применена';
  END IF;
  IF p.state NOT IN ('uploaded', 'validated', 'invalid') THEN
    RAISE EXCEPTION 'Загрузка ПСДЦ отменена или удалена';
  END IF;
  IF p.document_id IS NULL THEN
    RAISE EXCEPTION 'Файл не сопоставлен с документом';
  END IF;

  SELECT * INTO doc FROM contracts WHERE id = p.document_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Документ не найден';
  END IF;
  v_reason := psdc_document_lock_reason(doc);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION '%', v_reason USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM psdc WHERE document_id = doc.id AND state = 'applied') THEN
    RAISE EXCEPTION 'У документа ID % уже есть применённая ПСДЦ. Удалите её в карточке документа, затем примените новую', doc.display_id
      USING ERRCODE = '40001', HINT = 'conflict';
  END IF;

  IF p.batch_id IS NOT NULL THEN
    SELECT count(*) INTO v_other FROM psdc
    WHERE batch_id = p.batch_id AND document_id = doc.id AND id <> p.id
      AND state IN ('uploaded', 'validated', 'invalid');
    IF v_other > 0 THEN
      RAISE EXCEPTION 'В пакете документ ID % сопоставлен нескольким файлам — снимите лишнее сопоставление', doc.display_id
        USING ERRCODE = '40001', HINT = 'conflict';
    END IF;
  END IF;

  -- Исходные строки после загрузки неизменяемы, поэтому результат проверки
  -- зависит от документа только через ставку НДС и предыдущую ПСДЦ ветки
  -- (сопоставление ID строк). Если с момента проверки они изменились —
  -- пересчитываем здесь же, в этой транзакции.
  SELECT rate, includes INTO v_rate, v_incl FROM psdc_document_vat(doc.id);
  IF p.state <> 'validated'
     OR p.vat_rate_snapshot IS DISTINCT FROM v_rate
     OR p.vat_included_snapshot IS DISTINCT FROM v_incl
     OR p.previous_psdc_id IS DISTINCT FROM psdc_find_previous(doc.id) THEN
    PERFORM psdc_validate_internal(p.id);
    SELECT * INTO p FROM psdc WHERE id = p_psdc_id;
  END IF;
  IF p.state <> 'validated' THEN
    RAISE EXCEPTION 'ПСДЦ содержит ошибки (%). Исправьте файл и загрузите его заново', p.error_count;
  END IF;

  SELECT * INTO a FROM psdc_actor();
  BEGIN
    UPDATE psdc SET state = 'applied', applied_at = now(), applied_by = a.user_id, applied_by_name = a.full_name
    WHERE id = p.id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'У документа ID % уже есть применённая ПСДЦ', doc.display_id USING ERRCODE = '40001', HINT = 'conflict';
  END;

  PERFORM set_config('osp.psdc_write', 'on', true);
  UPDATE contracts SET psdc_total = p.total, psdc_applied_id = p.id WHERE id = doc.id;
  PERFORM set_config('osp.psdc_write', 'off', true);

  PERFORM psdc_audit(doc.id, 'psdc_applied',
    format('Применена ПСДЦ «%s»: сумма документа %s (ручная сумма %s сохранена)', p.source_filename, p.total::text,
      COALESCE(doc.contract_amount::text, 'не задана')),
    jsonb_build_object('psdc_id', p.id, 'total', p.total::text, 'manual_amount', doc.contract_amount::text,
                       'vat_amount', p.vat_amount::text, 'previous_psdc_id', p.previous_psdc_id));

  RETURN psdc_json(p.id, 0);
END;
$$;

-- Отменить загрузку ВОР (временная версия). Документ не меняется.
CREATE OR REPLACE FUNCTION psdc_cancel(p_psdc_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  p psdc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM psdc WHERE id = p_psdc_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ПСДЦ не найдена';
  END IF;
  IF p.state NOT IN ('uploaded', 'validated', 'invalid') THEN
    RAISE EXCEPTION 'Отменить можно только непримененную загрузку';
  END IF;
  IF p.document_id IS NOT NULL THEN
    IF NOT psdc_can_edit_document(p.document_id) THEN
      RAISE EXCEPTION 'Недостаточно прав для изменения документа' USING ERRCODE = '42501';
    END IF;
  ELSIF p.uploaded_by IS DISTINCT FROM auth.uid() AND NOT psdc_contracts_permission(true) THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;

  PERFORM psdc_discard_internal(p.id);
  PERFORM psdc_audit(p.document_id, 'psdc_upload_cancelled', format('Отменена загрузка ПСДЦ «%s»', p.source_filename),
    jsonb_build_object('psdc_id', p.id));
END;
$$;

-- Удалить ВОР (применённую). Сумма документа снова берётся из ручной суммы.
CREATE OR REPLACE FUNCTION psdc_delete(p_psdc_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  p psdc%ROWTYPE;
  doc contracts%ROWTYPE;
  a record;
  v_reason text;
BEGIN
  SELECT * INTO p FROM psdc WHERE id = p_psdc_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ПСДЦ не найдена';
  END IF;
  IF p.state <> 'applied' THEN
    RAISE EXCEPTION 'Удалить можно только применённую ПСДЦ';
  END IF;
  SELECT * INTO doc FROM contracts WHERE id = p.document_id FOR UPDATE;
  v_reason := psdc_document_lock_reason(doc);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION '%', v_reason USING ERRCODE = '42501';
  END IF;

  SELECT * INTO a FROM psdc_actor();
  UPDATE psdc SET state = 'deleted', deleted_at = now(), deleted_by_name = a.full_name WHERE id = p.id;

  PERFORM set_config('osp.psdc_write', 'on', true);
  UPDATE contracts SET psdc_total = NULL, psdc_applied_id = NULL WHERE id = doc.id;
  PERFORM set_config('osp.psdc_write', 'off', true);

  PERFORM psdc_audit(doc.id, 'psdc_deleted',
    format('Удалена ПСДЦ «%s» (итог %s). Сумма документа — ручная: %s', p.source_filename, p.total::text,
      COALESCE(doc.contract_amount::text, 'не задана')),
    jsonb_build_object('psdc_id', p.id, 'total', p.total::text, 'manual_amount', doc.contract_amount::text));
END;
$$;

CREATE OR REPLACE FUNCTION psdc_log_export(p_psdc_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  p psdc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM psdc WHERE id = p_psdc_id;
  IF NOT FOUND OR NOT psdc_visible(p_psdc_id) THEN
    RAISE EXCEPTION 'ПСДЦ не найдена или нет доступа' USING ERRCODE = '42501';
  END IF;
  PERFORM psdc_audit(p.document_id, 'psdc_exported', format('Экспорт ПСДЦ «%s»', p.source_filename),
    jsonb_build_object('psdc_id', p.id));
END;
$$;

-- Визуальное сравнение с предыдущей ПСДЦ ветки. Вспомогательное: ничего не
-- блокирует и ничего не пишет. Сначала по постоянному ID строки, затем
-- best-effort по № п/п + наименованию.
CREATE OR REPLACE FUNCTION psdc_compare(p_psdc_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_temp
AS $$
DECLARE
  p psdc%ROWTYPE;
  v_prev uuid;
BEGIN
  IF NOT psdc_visible(p_psdc_id) THEN
    RAISE EXCEPTION 'ПСДЦ не найдена или нет доступа' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO p FROM psdc WHERE id = p_psdc_id;
  v_prev := COALESCE(p.previous_psdc_id, CASE WHEN p.document_id IS NOT NULL THEN psdc_find_previous(p.document_id) END);
  IF v_prev IS NULL OR v_prev = p.id THEN
    RETURN jsonb_build_object('previous', NULL, 'rows', '{}'::jsonb, 'removed', '[]'::jsonb);
  END IF;

  RETURN (
    WITH cur AS (
      SELECT r.*, lower(btrim(COALESCE(r.name, ''))) AS nname FROM psdc_rows r WHERE r.psdc_id = p.id
    ), prv AS (
      SELECT r.*, lower(btrim(COALESCE(r.name, ''))) AS nname FROM psdc_rows r WHERE r.psdc_id = v_prev
    ), by_id AS (
      SELECT c.id AS cur_id, pr.id AS prev_id
      FROM cur c JOIN prv pr ON pr.logical_line_id = c.logical_line_id
    ), cur_rest AS (
      SELECT c.id, COALESCE(c.number, '') AS knum, c.nname, c.row_kind,
             count(*) OVER (PARTITION BY COALESCE(c.number, ''), c.nname) AS cnt
      FROM cur c WHERE NOT EXISTS (SELECT 1 FROM by_id b WHERE b.cur_id = c.id)
    ), prv_rest AS (
      SELECT pr.id, COALESCE(pr.number, '') AS knum, pr.nname, pr.row_kind,
             count(*) OVER (PARTITION BY COALESCE(pr.number, ''), pr.nname) AS cnt
      FROM prv pr WHERE NOT EXISTS (SELECT 1 FROM by_id b WHERE b.prev_id = pr.id)
    ), by_key AS (
      -- Без ID строки пара признаётся только при однозначном совпадении.
      SELECT c.id AS cur_id, pr.id AS prev_id
      FROM cur_rest c
      JOIN prv_rest pr ON pr.knum = c.knum AND pr.nname = c.nname
                      AND pr.row_kind IS NOT DISTINCT FROM c.row_kind
      WHERE c.cnt = 1 AND pr.cnt = 1
    ), pairs AS (
      SELECT * FROM by_id UNION ALL SELECT * FROM by_key
    ), diffs AS (
      SELECT c.id,
        CASE WHEN pr.id IS NULL THEN 'new' ELSE 'matched' END AS status,
        CASE WHEN pr.id IS NULL THEN '[]'::jsonb ELSE (
          SELECT COALESCE(jsonb_agg(f), '[]'::jsonb) FROM (VALUES
            ('number', c.number IS DISTINCT FROM pr.number),
            ('resource_type', lower(c.resource_type) IS DISTINCT FROM lower(pr.resource_type)),
            ('code', c.code IS DISTINCT FROM pr.code),
            ('customer_material', c.is_customer_material IS DISTINCT FROM pr.is_customer_material),
            ('cost_item', c.cost_item IS DISTINCT FROM pr.cost_item),
            ('name', c.name IS DISTINCT FROM pr.name),
            ('unit', c.unit IS DISTINCT FROM pr.unit),
            ('consumption_norm', c.consumption_norm IS DISTINCT FROM pr.consumption_norm),
            ('volume', c.volume IS DISTINCT FROM pr.volume),
            ('material_price', c.material_price IS DISTINCT FROM pr.material_price),
            ('work_price', c.work_price IS DISTINCT FROM pr.work_price),
            ('material_cost', c.material_cost IS DISTINCT FROM pr.material_cost),
            ('work_cost', c.work_cost IS DISTINCT FROM pr.work_cost),
            ('total_cost', c.total_cost IS DISTINCT FROM pr.total_cost),
            ('manufacturer', c.manufacturer IS DISTINCT FROM pr.manufacturer),
            ('materials', c.materials IS DISTINCT FROM pr.materials),
            ('work_location', c.work_location IS DISTINCT FROM pr.work_location),
            ('comment', c.comment IS DISTINCT FROM pr.comment),
            ('legacy_deleted', c.legacy_deleted IS DISTINCT FROM pr.legacy_deleted)
          ) v(f, changed) WHERE v.changed) END AS fields
      FROM cur c
      LEFT JOIN pairs pa ON pa.cur_id = c.id
      LEFT JOIN prv pr ON pr.id = pa.prev_id
    )
    SELECT jsonb_build_object(
      'previous', (SELECT jsonb_build_object('id', pp.id, 'display_id', dc.display_id, 'record_type', dc.record_type,
                                             'total', pp.total::text, 'source_filename', pp.source_filename)
                   FROM psdc pp LEFT JOIN contracts dc ON dc.id = pp.document_id WHERE pp.id = v_prev),
      'rows', COALESCE((
        SELECT jsonb_object_agg(d.id, jsonb_build_object(
          'status', CASE WHEN d.status = 'new' THEN 'new' WHEN jsonb_array_length(d.fields) > 0 THEN 'changed' ELSE 'same' END,
          'fields', d.fields))
        FROM diffs d
      ), '{}'::jsonb),
      'removed', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('number', pr.number, 'name', pr.name, 'row_kind', pr.row_kind,
                                            'total_cost', pr.total_cost::text) ORDER BY pr.row_order)
        FROM prv pr WHERE NOT EXISTS (SELECT 1 FROM pairs pa WHERE pa.prev_id = pr.id)
      ), '[]'::jsonb)
    )
  );
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 8) Массовая загрузка.

CREATE OR REPLACE FUNCTION psdc_batch_create(p_title text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  a record;
  v_id uuid;
BEGIN
  IF NOT psdc_contracts_permission(true) THEN
    RAISE EXCEPTION 'Недостаточно прав для загрузки ПСДЦ' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO a FROM psdc_actor();
  INSERT INTO psdc_batches (title, created_by, created_by_name)
  VALUES (NULLIF(left(btrim(COALESCE(p_title, '')), 200), ''), a.user_id, a.full_name)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Сопоставление файлов пакета с документами. Каждый элемент обрабатывается
-- независимо: ошибка одного не мешает остальным.
-- p_items: [{ psdc_id, document_id | display_id | null, method: auto|manual|table, note }]
CREATE OR REPLACE FUNCTION psdc_batch_set_documents(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  item jsonb;
  p psdc%ROWTYPE;
  doc contracts%ROWTYPE;
  v_doc_id uuid;
  v_method text;
  v_results jsonb := '[]'::jsonb;
BEGIN
  IF NOT psdc_contracts_permission(true) THEN
    RAISE EXCEPTION 'Недостаточно прав для загрузки ПСДЦ' USING ERRCODE = '42501';
  END IF;
  -- Сопоставление перепроверяет файл (НДС и ID строк зависят от документа),
  -- поэтому порции небольшие — запрос не должен упираться в statement_timeout.
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION 'За один запрос сопоставляется не более 100 файлов';
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    BEGIN
      SELECT * INTO p FROM psdc WHERE id = (item ->> 'psdc_id')::uuid FOR UPDATE;
      IF NOT FOUND OR p.batch_id IS NULL THEN
        RAISE EXCEPTION 'Файл пакета не найден';
      END IF;
      IF p.state NOT IN ('uploaded', 'validated', 'invalid') THEN
        RAISE EXCEPTION 'Файл уже применён или отменён — сопоставление не меняется';
      END IF;

      v_doc_id := NULL;
      IF COALESCE(item ->> 'document_id', '') <> '' THEN
        v_doc_id := (item ->> 'document_id')::uuid;
      ELSIF COALESCE(item ->> 'display_id', '') <> '' THEN
        IF (item ->> 'display_id') !~ '^[0-9]{1,15}$' THEN
          RAISE EXCEPTION 'Некорректный ID документа «%»', item ->> 'display_id';
        END IF;
        SELECT id INTO v_doc_id FROM contracts WHERE display_id = (item ->> 'display_id')::bigint;
        IF v_doc_id IS NULL THEN
          RAISE EXCEPTION 'Документ с ID % не найден', item ->> 'display_id';
        END IF;
      END IF;

      IF v_doc_id IS NOT NULL THEN
        SELECT * INTO doc FROM contracts WHERE id = v_doc_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Документ не найден';
        END IF;
        IF doc.deleted_at IS NOT NULL THEN
          RAISE EXCEPTION 'Документ ID % удалён', doc.display_id;
        END IF;
        IF NOT psdc_can_edit_document(doc.id) THEN
          RAISE EXCEPTION 'Нет доступа к документу ID %', doc.display_id USING ERRCODE = '42501';
        END IF;
      END IF;

      v_method := CASE WHEN v_doc_id IS NULL THEN NULL
                       WHEN item ->> 'method' IN ('auto', 'manual', 'table') THEN item ->> 'method'
                       ELSE 'manual' END;

      IF p.document_id IS DISTINCT FROM v_doc_id OR p.state = 'uploaded' THEN
        UPDATE psdc SET document_id = v_doc_id, match_method = v_method,
                        match_note = NULLIF(left(COALESCE(item ->> 'note', ''), 500), '')
        WHERE id = p.id;
        PERFORM psdc_validate_internal(p.id);
        IF v_doc_id IS NOT NULL THEN
          PERFORM psdc_audit(v_doc_id, 'psdc_uploaded',
            format('Файл ПСДЦ «%s» сопоставлен с документом при массовой загрузке (не применён)', p.source_filename),
            jsonb_build_object('psdc_id', p.id, 'batch_id', p.batch_id, 'method', v_method));
        END IF;
      ELSE
        UPDATE psdc SET match_method = v_method,
                        match_note = NULLIF(left(COALESCE(item ->> 'note', ''), 500), '')
        WHERE id = p.id;
      END IF;

      v_results := v_results || jsonb_build_object('psdc_id', p.id, 'ok', true);
    EXCEPTION WHEN others THEN
      v_results := v_results || jsonb_build_object('psdc_id', item ->> 'psdc_id', 'ok', false, 'error', SQLERRM);
    END;
  END LOOP;
  RETURN v_results;
END;
$$;

-- Заметка сопоставления без смены документа (например «несколько кандидатов»).
CREATE OR REPLACE FUNCTION psdc_batch_set_notes(p_items jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT psdc_contracts_permission(true) THEN
    RAISE EXCEPTION 'Недостаточно прав' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) > 2000 THEN
    RAISE EXCEPTION 'Слишком много элементов';
  END IF;
  UPDATE psdc p SET match_note = NULLIF(left(COALESCE(e ->> 'note', ''), 500), '')
  FROM jsonb_array_elements(p_items) e
  WHERE p.id = (e ->> 'psdc_id')::uuid AND p.batch_id IS NOT NULL AND p.document_id IS NULL
    AND p.state IN ('uploaded', 'validated', 'invalid');
END;
$$;

-- Применение нескольких файлов: каждый файл — отдельная подтранзакция.
-- Один XLSX применяется целиком или не применяется совсем; ошибка одного
-- файла не отменяет остальные.
CREATE OR REPLACE FUNCTION psdc_batch_apply(p_psdc_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_results jsonb := '[]'::jsonb;
BEGIN
  IF COALESCE(array_length(p_psdc_ids, 1), 0) > 200 THEN
    RAISE EXCEPTION 'За один запрос применяется не более 200 файлов';
  END IF;
  FOREACH v_id IN ARRAY COALESCE(p_psdc_ids, '{}') LOOP
    BEGIN
      PERFORM psdc_apply(v_id);
      v_results := v_results || jsonb_build_object('psdc_id', v_id, 'ok', true);
    EXCEPTION WHEN others THEN
      v_results := v_results || jsonb_build_object('psdc_id', v_id, 'ok', false, 'error', SQLERRM);
    END;
  END LOOP;
  RETURN v_results;
END;
$$;

-- Строки таблицы пакета с состоянием сопоставления и проверки.
CREATE OR REPLACE FUNCTION psdc_batch_items(p_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT psdc_contracts_permission(true)
     AND NOT EXISTS (SELECT 1 FROM psdc_batches WHERE id = p_batch_id AND created_by = auth.uid()) THEN
    RAISE EXCEPTION 'Нет доступа к пакету' USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', p.id, 'state', p.state, 'document_id', p.document_id, 'match_method', p.match_method,
      'match_note', p.match_note, 'source_filename', p.source_filename, 'source_size', p.source_size,
      'source_hash', p.source_hash, 'source_s3_document_id', p.source_s3_document_id,
      'uploaded_at', p.uploaded_at, 'applied_at', p.applied_at,
      'error_count', p.error_count, 'warning_count', p.warning_count,
      'section_count', p.section_count, 'process_count', p.process_count,
      'total', p.total::text, 'vat_amount', p.vat_amount::text,
      'document', CASE WHEN c.id IS NOT NULL THEN jsonb_build_object(
        'id', c.id, 'display_id', c.display_id, 'record_type', c.record_type, 'contract_number', c.contract_number,
        'status', c.status, 'deleted', c.deleted_at IS NOT NULL, 'counterparty', cp.name,
        'root_display_id', rc.display_id, 'root_contract_number', rc.contract_number) END,
      'lock_reason', CASE WHEN c.id IS NOT NULL THEN psdc_document_lock_reason(c) END,
      'document_has_applied', CASE WHEN c.id IS NOT NULL THEN EXISTS (
        SELECT 1 FROM psdc x WHERE x.document_id = c.id AND x.state = 'applied' AND x.id <> p.id) ELSE false END,
      'conflict', CASE WHEN p.document_id IS NOT NULL AND p.state IN ('uploaded', 'validated', 'invalid') THEN EXISTS (
        SELECT 1 FROM psdc x WHERE x.batch_id = p.batch_id AND x.document_id = p.document_id AND x.id <> p.id
          AND x.state IN ('uploaded', 'validated', 'invalid', 'applied')) ELSE false END,
      'duplicate_file', CASE WHEN p.source_hash IS NOT NULL THEN EXISTS (
        SELECT 1 FROM psdc x WHERE x.batch_id = p.batch_id AND x.source_hash = p.source_hash AND x.id <> p.id
          AND x.state <> 'cancelled') ELSE false END,
      'first_issues', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('severity', i.severity, 'excel_row', i.excel_row, 'cell', i.cell, 'message', i.message))
        FROM (SELECT * FROM psdc_issues WHERE psdc_id = p.id ORDER BY (severity = 'warning'), excel_row NULLS FIRST, id LIMIT 3) i
      ), '[]'::jsonb)
    ) ORDER BY p.source_filename, p.uploaded_at)
    FROM psdc p
    LEFT JOIN contracts c ON c.id = p.document_id
    LEFT JOIN counterparties cp ON cp.id = c.counterparty_id
    LEFT JOIN contracts rc ON rc.id = c.root_contract_id AND rc.id <> c.id
    WHERE p.batch_id = p_batch_id AND p.state <> 'cancelled'
  ), '[]'::jsonb);
END;
$$;

-- Ошибки всех файлов пакета одной таблицей: Файл | Строка | Ячейка | Ошибка.
CREATE OR REPLACE FUNCTION psdc_batch_issues(p_batch_id uuid, p_severity text DEFAULT 'error')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT psdc_contracts_permission(true)
     AND NOT EXISTS (SELECT 1 FROM psdc_batches WHERE id = p_batch_id AND created_by = auth.uid()) THEN
    RAISE EXCEPTION 'Нет доступа к пакету' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(x ORDER BY x ->> 'file', (x ->> 'excel_row')::int NULLS FIRST)
    FROM (
      SELECT jsonb_build_object('psdc_id', p.id, 'file', p.source_filename, 'excel_row', i.excel_row,
                                'cell', i.cell, 'field', i.field, 'severity', i.severity, 'message', i.message) AS x
      FROM psdc p
      JOIN psdc_issues i ON i.psdc_id = p.id
      WHERE p.batch_id = p_batch_id AND p.state IN ('uploaded', 'validated', 'invalid')
        AND (p_severity IS NULL OR i.severity = p_severity)
      LIMIT 20000
    ) q
  ), '[]'::jsonb);
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 9) RLS: таблицы ПСДЦ только для чтения; запись — только функциями выше.
ALTER TABLE psdc_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE psdc ENABLE ROW LEVEL SECURITY;
ALTER TABLE psdc_source_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE psdc_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE psdc_issues ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS psdc_batches_select ON psdc_batches;
CREATE POLICY psdc_batches_select ON psdc_batches FOR SELECT TO authenticated
  USING (created_by = auth.uid() OR psdc_contracts_permission(true));

DROP POLICY IF EXISTS psdc_select ON psdc;
CREATE POLICY psdc_select ON psdc FOR SELECT TO authenticated
  USING (CASE WHEN document_id IS NULL THEN uploaded_by = auth.uid() OR psdc_contracts_permission(true)
              ELSE psdc_can_view_document(document_id) END);

DROP POLICY IF EXISTS psdc_source_rows_select ON psdc_source_rows;
CREATE POLICY psdc_source_rows_select ON psdc_source_rows FOR SELECT TO authenticated
  USING (psdc_visible(psdc_id));

DROP POLICY IF EXISTS psdc_rows_select ON psdc_rows;
CREATE POLICY psdc_rows_select ON psdc_rows FOR SELECT TO authenticated
  USING (psdc_visible(psdc_id));

DROP POLICY IF EXISTS psdc_issues_select ON psdc_issues;
CREATE POLICY psdc_issues_select ON psdc_issues FOR SELECT TO authenticated
  USING (psdc_visible(psdc_id));

REVOKE ALL ON psdc_batches, psdc, psdc_source_rows, psdc_rows, psdc_issues FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON psdc_batches, psdc, psdc_source_rows, psdc_rows, psdc_issues FROM authenticated;
GRANT SELECT ON psdc_batches, psdc, psdc_source_rows, psdc_rows, psdc_issues TO authenticated;

-- Функции: внутренние недоступны клиенту, операции — только authenticated.
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'psdc_contracts_permission(boolean)', 'psdc_object_in_scope(uuid)', 'psdc_can_view_document(uuid)',
    'psdc_can_edit_document(uuid)', 'psdc_visible(uuid)', 'psdc_document_lock_reason(contracts)',
    'psdc_actor()', 'psdc_audit(uuid,text,text,jsonb)', 'psdc_document_vat(uuid)', 'psdc_find_previous(uuid)',
    'psdc_validate_internal(uuid)', 'psdc_json(uuid,integer)', 'psdc_discard_internal(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM public, anon, authenticated', fn);
  END LOOP;

  FOREACH fn IN ARRAY ARRAY[
    'psdc_get(uuid)', 'psdc_get_rows(uuid)', 'psdc_document_state(uuid)', 'psdc_create(uuid,uuid,jsonb)',
    'psdc_add_rows(uuid,jsonb)', 'psdc_set_source_file(uuid,uuid)', 'psdc_validate(uuid)', 'psdc_apply(uuid)',
    'psdc_cancel(uuid)', 'psdc_delete(uuid)', 'psdc_log_export(uuid)', 'psdc_compare(uuid)',
    'psdc_batch_create(text)', 'psdc_batch_set_documents(jsonb)', 'psdc_batch_set_notes(jsonb)',
    'psdc_batch_apply(uuid[])', 'psdc_batch_items(uuid)', 'psdc_batch_issues(uuid,text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM public, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', fn);
  END LOOP;
END $$;

-- Политики RLS вызывают эти проверки от имени пользователя.
GRANT EXECUTE ON FUNCTION public.psdc_contracts_permission(boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.psdc_can_view_document(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.psdc_visible(uuid) TO authenticated;
