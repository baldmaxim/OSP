-- Кабинет подрядчика: расценка ВОР на сайте, заявки на участие, анкета (решения пользователя 23.10.2026).
-- Тело supabase/migrations/20261102_contractor_bids.sql: те же таблицы, функции и анкета по умолчанию, иначе —
-- только права под одну учётку:
--  • правила по строкам включены и действуют на владельца, служебные операции (функции ниже) — пропуском;
--  • заявки читает сотрудник и сама организация; цены и анкету — администратор и сама организация; поля анкеты —
--    сотрудник и подрядчик, правит администратор; запись цен, анкеты и заявок — только функциями;
--  • правило подрядчика на s3_documents (portal_contractor_select): плюс файлы открытого тендера после заявки.
-- Анкета по умолчанию — 14 полей «Главного листа» ВОР, ставка НДС — выбор из списка (код 'vat').
-- Данные не трогаются, кроме анкеты по умолчанию в пустую таблицу. Повтор безопасен.

-- ── 1. Таблицы ───────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tender_bid_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
  counterparty_id uuid NOT NULL REFERENCES public.counterparties(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  requested_by uuid,
  requested_by_name text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_by_name text,
  decided_at timestamptz,
  CONSTRAINT tender_bid_requests_key UNIQUE (tender_id, counterparty_id)
);
COMMENT ON TABLE public.tender_bid_requests IS
  'Заявка подрядчика на участие в тендере с сайта (кабинет подрядчика); участником делает инженер — bid_decide';
CREATE INDEX IF NOT EXISTS tender_bid_requests_counterparty_idx ON public.tender_bid_requests (counterparty_id);
CREATE INDEX IF NOT EXISTS tender_bid_requests_pending_idx ON public.tender_bid_requests (tender_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.tender_bid_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
  counterparty_id uuid NOT NULL REFERENCES public.counterparties(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('material', 'work')),
  item_key text NOT NULL CHECK (char_length(item_key) BETWEEN 1 AND 1000),
  unit_key text NOT NULL DEFAULT '' CHECK (char_length(unit_key) <= 100),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 1000),
  unit text CHECK (unit IS NULL OR char_length(unit) <= 100),
  volume numeric(18,4) CHECK (volume IS NULL OR (volume >= 0 AND volume < 1e13)),
  price numeric(15,2) CHECK (price IS NULL OR (price >= 0 AND price < 1e12)),
  total numeric,
  note text CHECK (note IS NULL OR char_length(note) <= 2000),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'history')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT tender_bid_rates_key UNIQUE (tender_id, counterparty_id, kind, item_key, unit_key),
  CONSTRAINT tender_bid_rates_value CHECK (price IS NOT NULL OR note IS NOT NULL)
);
COMMENT ON TABLE public.tender_bid_rates IS
  'Цена подрядчика за единицу с НДС по уникальной позиции ВОР тендера (материал / работа), введённая в кабинете; пишет только bid_rates_save';
COMMENT ON COLUMN public.tender_bid_rates.total IS 'Цена × объём (слепок объёма на момент ввода), считает bid_rates_save';
-- Цены организации из прошлых тендеров (подсказки) и сводка администратора по организации.
CREATE INDEX IF NOT EXISTS tender_bid_rates_counterparty_idx ON public.tender_bid_rates (counterparty_id, item_key);

CREATE TABLE IF NOT EXISTS public.bid_form_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 500),
  hint text CHECK (hint IS NULL OR char_length(hint) <= 500),
  kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'select')),
  options jsonb CHECK (options IS NULL OR (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) <= 50)),
  code text CHECK (code IS NULL OR code IN ('vat')),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bid_form_fields_code_key UNIQUE (code),
  CONSTRAINT bid_form_fields_select_options CHECK (kind <> 'select' OR coalesce(jsonb_array_length(options), 0) > 0)
);
COMMENT ON TABLE public.bid_form_fields IS
  'Поля анкеты подрядчика «Квалификационная и контактная информация» (кабинет подрядчика); список ведёт администратор';

CREATE TABLE IF NOT EXISTS public.tender_bid_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
  counterparty_id uuid NOT NULL REFERENCES public.counterparties(id) ON DELETE CASCADE,
  answers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(answers) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT tender_bid_forms_key UNIQUE (tender_id, counterparty_id)
);
COMMENT ON TABLE public.tender_bid_forms IS
  'Анкета подрядчика по тендеру: { id поля: { label, value } }, подпись поля — слепком; пишет только bid_form_save';

-- Анкета по умолчанию — как блок «Квалификационная и контактная информация» «Главного листа» ВОР (снимок отдела
-- 23.10.2026); ставка НДС — выбор из списка, как выпадающий список в файле (ставки — как у контрагентов, 20261026).
-- Только в пустую таблицу: повтор миграции не возвращает поля, которые администратор убрал или переименовал.
INSERT INTO public.bid_form_fields (label, hint, kind, options, code, sort_order)
SELECT v.label, v.hint, v.kind, v.options, v.code, v.n * 10
FROM (VALUES
  (1, 'Наименование контрагента', NULL, 'text', NULL::jsonb, NULL),
  (2, 'ИНН', NULL, 'text', NULL, NULL),
  (3, 'Адрес (юр., факт.)', NULL, 'text', NULL, NULL),
  (4, 'Ставка НДС', 'выберите из списка; цены вводятся с этим НДС', 'select',
     '["22 %", "7 %", "5 %", "0 %"]'::jsonb, 'vat'),
  (5, 'Наличие авансирования', 'да (сумма, руб.) / нет', 'text', NULL, NULL),
  (6, 'Информация о посещении объекта (были / не были), вопросы по результатам посещения', NULL, 'text', NULL, NULL),
  (7, 'Наличие СРО', 'да (сумма) / нет', 'text', NULL, NULL),
  (8, 'Численность работающих всего / численность, планируемая для выполнения предмета тендера', 'кол-во', 'text', NULL, NULL),
  (9, 'Дата регистрации компании', NULL, 'text', NULL, NULL),
  (10, 'Оборот за последние 3 года (выручка по данным бухгалтерской отчётности за 2023 / 2024 / 2025 год)', NULL, 'text', NULL, NULL),
  (11, 'Ссылка на сайт компании', NULL, 'text', NULL, NULL),
  (12, 'Генеральный директор: Ф.И.О. полностью, тел., e-mail', NULL, 'text', NULL, NULL),
  (13, 'Контактное лицо: Ф.И.О. полностью, тел., e-mail', NULL, 'text', NULL, NULL),
  (14, 'Примечание к ТКП претендента', NULL, 'text', NULL, NULL)
) AS v(n, label, hint, kind, options, code)
WHERE NOT EXISTS (SELECT 1 FROM public.bid_form_fields);

-- ── 2. Доступ подрядчика к тендеру ───────────────────────────────────────────────────────────────────
-- Открытый тендер — тот же отбор, что у публичного списка (public_open_tenders).
CREATE OR REPLACE FUNCTION public.bid_tender_open(p_tender uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tenders t JOIN public.objects o ON o.id = t.object_id
    WHERE t.id = p_tender
      AND t.status::text = 'Идет тендерная процедура'
      AND t.deleted_at IS NULL
      AND (t.tender_type IS NULL OR t.tender_type = 'main')
      AND o.status::text IN ('main_construction', 'warranty_service'))
$$;

-- Доступ организации вошедшего к тендеру: 'invited' — участник (tender_counterparties), иначе статус заявки с
-- сайта ('pending' | 'accepted' | 'rejected'), нет ни того ни другого — NULL. Сотруднику — NULL.
CREATE OR REPLACE FUNCTION public.bid_access(p_tender uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  WITH me AS (SELECT public.osp_counterparty_id() AS cp)
  SELECT CASE
    WHEN me.cp IS NULL THEN NULL
    WHEN EXISTS (SELECT 1 FROM public.tender_counterparties tc WHERE tc.tender_id = p_tender AND tc.counterparty_id = me.cp) THEN 'invited'
    ELSE (SELECT r.status FROM public.tender_bid_requests r WHERE r.tender_id = p_tender AND r.counterparty_id = me.cp)
  END
  FROM me
$$;

-- Менять цены и анкету: тендер открыт, организация — участник или её заявка не отклонена.
CREATE OR REPLACE FUNCTION public.bid_can_edit(p_tender uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT coalesce(public.bid_access(p_tender) IN ('invited', 'pending', 'accepted'), false) AND public.bid_tender_open(p_tender)
$$;

-- ── 3. Тендеры кабинета ──────────────────────────────────────────────────────────────────────────────
-- Открытые тендеры и те, где организация участник или подала заявку: публичные поля, ответственный (ФИО и
-- телефон, как на /public/tenders и в письме), доступ организации и её расценка (сколько позиций, на какую сумму).
CREATE OR REPLACE FUNCTION public.bid_contractor_tenders()
RETURNS TABLE (
  id uuid, public_tender_number integer, work_description text, tender_status text, is_open boolean,
  object_name text, object_address text, responsible_name text, responsible_phone text,
  tender_start_date date, tender_end_date date, start_date date, end_date date, tender_package_link text,
  access text, invite_status text, request_status text, priced_count integer, priced_total numeric, priced_at timestamptz
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid := public.osp_counterparty_id();
BEGIN
  IF v_cp IS NULL THEN
    RAISE EXCEPTION 'Список тендеров кабинета — только для подрядчика' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH mine AS (
    SELECT t.id FROM public.tenders t JOIN public.objects o ON o.id = t.object_id
    WHERE t.status::text = 'Идет тендерная процедура' AND t.deleted_at IS NULL
      AND (t.tender_type IS NULL OR t.tender_type = 'main')
      AND o.status::text IN ('main_construction', 'warranty_service')
    UNION
    SELECT tc.tender_id FROM public.tender_counterparties tc WHERE tc.counterparty_id = v_cp
    UNION
    SELECT r.tender_id FROM public.tender_bid_requests r WHERE r.counterparty_id = v_cp
  )
  SELECT t.id, t.public_tender_number, t.work_description, t.status::text, public.bid_tender_open(t.id),
         coalesce(o.name::text, t.custom_object_name), o.address,
         NULLIF(btrim(c.full_name::text), ''), NULLIF(btrim(c.phone::text), ''),
         t.tender_start_date, t.tender_end_date, t.start_date, t.end_date, t.tender_package_link,
         CASE WHEN tc.status IS NOT NULL THEN 'invited' ELSE r.status END,
         tc.status::text, r.status,
         coalesce(p.cnt, 0)::integer, coalesce(p.total, 0), p.at
  FROM mine
  JOIN public.tenders t ON t.id = mine.id AND t.deleted_at IS NULL
  LEFT JOIN public.objects o ON o.id = t.object_id
  LEFT JOIN public.contacts c ON c.id = t.responsible_contact_id
  LEFT JOIN public.tender_counterparties tc ON tc.tender_id = t.id AND tc.counterparty_id = v_cp
  LEFT JOIN public.tender_bid_requests r ON r.tender_id = t.id AND r.counterparty_id = v_cp
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE br.price IS NOT NULL) AS cnt, sum(br.total) AS total, max(br.updated_at) AS at
    FROM public.tender_bid_rates br WHERE br.tender_id = t.id AND br.counterparty_id = v_cp
  ) p ON true
  ORDER BY t.tender_end_date NULLS LAST, t.public_tender_number;
END
$$;

-- Заявка на участие с сайта. Уже участник или заявка есть — ничего не меняет, отвечает доступом.
CREATE OR REPLACE FUNCTION public.bid_request(p_tender uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid := public.osp_counterparty_id();
  v_access text;
BEGIN
  IF v_cp IS NULL THEN
    RAISE EXCEPTION 'Заявку подаёт подрядчик' USING ERRCODE = '42501';
  END IF;
  v_access := public.bid_access(p_tender);
  IF v_access IS NOT NULL THEN RETURN v_access; END IF;
  IF NOT public.bid_tender_open(p_tender) THEN
    RAISE EXCEPTION 'Приём предложений по этому тендеру закрыт' USING ERRCODE = 'P0001';
  END IF;
  -- Защита от массовых заявок с одной учётки: не больше 30 новых за сутки на организацию.
  IF (SELECT count(*) FROM public.tender_bid_requests r
      WHERE r.counterparty_id = v_cp AND r.requested_at > now() - interval '1 day') >= 30 THEN
    RAISE EXCEPTION 'Слишком много заявок за сутки — попробуйте завтра или напишите в отдел' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.tender_bid_requests (tender_id, counterparty_id, requested_by, requested_by_name)
  VALUES (p_tender, v_cp, auth.uid(),
          (SELECT NULLIF(btrim(ur.full_name), '') FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1))
  ON CONFLICT (tender_id, counterparty_id) DO NOTHING;
  RETURN public.bid_access(p_tender);
END
$$;

-- Решение инженера по заявке: участник (строка tender_counterparties в конце списка; уже расценил — «КП
-- предоставлено») или отказ. Право — правка «Тендеров». Отклонённую можно принять позже; принятую — не отклонить
-- (участника убирают в списке участников, как любого другого).
CREATE OR REPLACE FUNCTION public.bid_decide(p_request uuid, p_accept boolean) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_req public.tender_bid_requests%ROWTYPE;
  v_name text;
BEGIN
  IF NOT public.osp_can('tenders', 'edit') THEN
    RAISE EXCEPTION 'Нет права правки тендеров' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_req FROM public.tender_bid_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Заявка не найдена' USING ERRCODE = 'P0002';
  END IF;
  IF v_req.status = 'accepted' THEN RETURN 'accepted'; END IF;
  IF v_req.status = 'rejected' AND NOT p_accept THEN RETURN 'rejected'; END IF;
  v_name := (SELECT NULLIF(btrim(ur.full_name), '') FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1);
  UPDATE public.tender_bid_requests
     SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'rejected' END,
         decided_by = auth.uid(), decided_by_name = v_name, decided_at = now()
   WHERE id = p_request;
  IF p_accept THEN
    INSERT INTO public.tender_counterparties (tender_id, counterparty_id, status, sort_order)
    VALUES (v_req.tender_id, v_req.counterparty_id,
            CASE WHEN EXISTS (SELECT 1 FROM public.tender_bid_rates br
                              WHERE br.tender_id = v_req.tender_id AND br.counterparty_id = v_req.counterparty_id AND br.price IS NOT NULL)
                 THEN 'proposal_provided' ELSE 'request_sent' END::public.tender_counterparty_status,
            coalesce((SELECT max(tc.sort_order) FROM public.tender_counterparties tc WHERE tc.tender_id = v_req.tender_id), 0) + 10)
    ON CONFLICT (tender_id, counterparty_id) DO NOTHING;
  END IF;
  RETURN CASE WHEN p_accept THEN 'accepted' ELSE 'rejected' END;
END
$$;

-- ── 4. Цены и анкета ─────────────────────────────────────────────────────────────────────────────────
-- Цены подрядчика по уникальным позициям. p_rows — [{ kind, key, unit_key, name, unit, volume, price, note,
-- source }]; цена без примечания пустая — строка удаляется. Не больше 2000 строк за вызов и 20 000 на тендер.
CREATE OR REPLACE FUNCTION public.bid_rates_save(p_tender uuid, p_rows jsonb) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid := public.osp_counterparty_id();
  r record;
  v_price numeric;
  v_note text;
  v_n integer := 0;
BEGIN
  IF v_cp IS NULL THEN
    RAISE EXCEPTION 'Цены вводит подрядчик' USING ERRCODE = '42501';
  END IF;
  IF NOT public.bid_can_edit(p_tender) THEN
    RAISE EXCEPTION 'Расценка этого тендера закрыта' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) > 2000 THEN
    RAISE EXCEPTION 'Неверный список цен (не больше 2000 строк за раз)' USING ERRCODE = '22023';
  END IF;
  FOR r IN SELECT * FROM jsonb_to_recordset(p_rows)
             AS x(kind text, key text, unit_key text, name text, unit text, volume numeric, price numeric, note text, source text)
  LOOP
    IF r.kind IS NULL OR r.kind NOT IN ('material', 'work') OR coalesce(btrim(r.key), '') = '' OR coalesce(btrim(r.name), '') = '' THEN
      RAISE EXCEPTION 'Позиция без вида, ключа или наименования' USING ERRCODE = '22023';
    END IF;
    v_price := round(r.price, 2);
    v_note := NULLIF(btrim(r.note), '');
    IF v_price IS NULL AND v_note IS NULL THEN
      DELETE FROM public.tender_bid_rates
       WHERE tender_id = p_tender AND counterparty_id = v_cp AND kind = r.kind
         AND item_key = r.key AND unit_key = coalesce(r.unit_key, '');
    ELSE
      INSERT INTO public.tender_bid_rates AS b
        (tender_id, counterparty_id, kind, item_key, unit_key, name, unit, volume, price, total, note, source, updated_by)
      VALUES (p_tender, v_cp, r.kind, r.key, coalesce(r.unit_key, ''), btrim(r.name), NULLIF(btrim(r.unit), ''), r.volume,
              v_price, round(v_price * coalesce(r.volume, 0), 2), v_note,
              CASE WHEN r.source IN ('manual', 'import', 'history') THEN r.source ELSE 'manual' END, auth.uid())
      ON CONFLICT (tender_id, counterparty_id, kind, item_key, unit_key) DO UPDATE
        SET name = excluded.name, unit = excluded.unit, volume = excluded.volume, price = excluded.price,
            total = excluded.total, note = excluded.note, source = excluded.source,
            updated_at = now(), updated_by = excluded.updated_by;
    END IF;
    v_n := v_n + 1;
  END LOOP;
  IF (SELECT count(*) FROM public.tender_bid_rates WHERE tender_id = p_tender AND counterparty_id = v_cp) > 20000 THEN
    RAISE EXCEPTION 'Слишком много позиций в расценке (больше 20 000)' USING ERRCODE = '22023';
  END IF;
  RETURN v_n;
END
$$;

-- Анкета: p_answers — { id поля: значение }. Пустое значение убирает ответ; поля, которых нет в p_answers,
-- не трогаются (скрытое администратором поле сохраняет прежний ответ). Подпись поля — слепком. У поля «выбор из
-- списка» — только один из вариантов.
CREATE OR REPLACE FUNCTION public.bid_form_save(p_tender uuid, p_answers jsonb) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid := public.osp_counterparty_id();
  v_doc jsonb;
  a record;
BEGIN
  IF v_cp IS NULL THEN
    RAISE EXCEPTION 'Анкету заполняет подрядчик' USING ERRCODE = '42501';
  END IF;
  IF NOT public.bid_can_edit(p_tender) THEN
    RAISE EXCEPTION 'Расценка этого тендера закрыта' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_answers) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_answers)) > 200 THEN
    RAISE EXCEPTION 'Неверная анкета' USING ERRCODE = '22023';
  END IF;
  v_doc := coalesce((SELECT f.answers FROM public.tender_bid_forms f WHERE f.tender_id = p_tender AND f.counterparty_id = v_cp), '{}'::jsonb);
  FOR a IN
    SELECT f.id::text AS key, f.label, f.kind, f.options, left(btrim(e.value), 2000) AS value
    FROM jsonb_each_text(p_answers) e JOIN public.bid_form_fields f ON f.id::text = e.key
  LOOP
    IF a.kind = 'select' AND coalesce(a.value, '') <> '' AND NOT coalesce(a.options ? a.value, false) THEN
      RAISE EXCEPTION 'Значение «%» не из списка поля «%»', a.value, a.label USING ERRCODE = '22023';
    END IF;
    IF coalesce(a.value, '') = '' THEN
      v_doc := v_doc - a.key;
    ELSE
      v_doc := v_doc || jsonb_build_object(a.key, jsonb_build_object('label', a.label, 'value', a.value));
    END IF;
  END LOOP;
  INSERT INTO public.tender_bid_forms AS b (tender_id, counterparty_id, answers, updated_by)
  VALUES (p_tender, v_cp, v_doc, auth.uid())
  ON CONFLICT (tender_id, counterparty_id) DO UPDATE
    SET answers = excluded.answers, updated_at = now(), updated_by = excluded.updated_by;
  RETURN v_doc;
END
$$;

-- ── 5. Сводка администратора ─────────────────────────────────────────────────────────────────────────
-- Какая организация в каком тендере что расценила: строка — тендер и организация, у которых есть цены, анкета
-- или заявка с сайта; vat — ответ на поле анкеты «Ставка НДС». Только администратору (решение пользователя: «пока что только админу»).
CREATE OR REPLACE FUNCTION public.bid_admin_overview()
RETURNS TABLE (
  tender_id uuid, public_tender_number integer, work_description text, tender_status text, is_open boolean,
  object_name text, tender_end_date date, counterparty_id uuid, counterparty_name text, counterparty_inn text,
  invite_status text, request_id uuid, request_status text, requested_at timestamptz,
  materials_priced integer, works_priced integer, materials_total numeric, works_total numeric, total numeric,
  notes_count integer, form_answers integer, vat text, updated_at timestamptz
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Сводка расценок подрядчиков — только администратору' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH pairs AS (
    SELECT br.tender_id, br.counterparty_id FROM public.tender_bid_rates br
    UNION SELECT f.tender_id, f.counterparty_id FROM public.tender_bid_forms f
    UNION SELECT r.tender_id, r.counterparty_id FROM public.tender_bid_requests r
  ),
  agg AS (
    SELECT br.tender_id, br.counterparty_id,
           count(*) FILTER (WHERE br.kind = 'material' AND br.price IS NOT NULL) AS mp,
           count(*) FILTER (WHERE br.kind = 'work' AND br.price IS NOT NULL) AS wp,
           sum(br.total) FILTER (WHERE br.kind = 'material') AS mt,
           sum(br.total) FILTER (WHERE br.kind = 'work') AS wt,
           count(*) FILTER (WHERE br.note IS NOT NULL) AS nc,
           max(br.updated_at) AS at
    FROM public.tender_bid_rates br GROUP BY br.tender_id, br.counterparty_id
  )
  SELECT p.tender_id, t.public_tender_number, t.work_description, t.status::text, public.bid_tender_open(t.id),
         coalesce(o.name::text, t.custom_object_name), t.tender_end_date, p.counterparty_id, cp.name, cp.inn,
         tc.status::text, r.id, r.status, r.requested_at,
         coalesce(a.mp, 0)::integer, coalesce(a.wp, 0)::integer, coalesce(a.mt, 0), coalesce(a.wt, 0),
         coalesce(a.mt, 0) + coalesce(a.wt, 0), coalesce(a.nc, 0)::integer,
         coalesce((SELECT count(*) FROM jsonb_object_keys(f.answers)), 0)::integer,
         f.answers -> (SELECT ff.id::text FROM public.bid_form_fields ff WHERE ff.code = 'vat') ->> 'value',
         greatest(a.at, f.updated_at, r.requested_at, r.decided_at)
  FROM pairs p
  JOIN public.tenders t ON t.id = p.tender_id
  LEFT JOIN public.objects o ON o.id = t.object_id
  JOIN public.counterparties cp ON cp.id = p.counterparty_id
  LEFT JOIN public.tender_counterparties tc ON tc.tender_id = p.tender_id AND tc.counterparty_id = p.counterparty_id
  LEFT JOIN public.tender_bid_requests r ON r.tender_id = p.tender_id AND r.counterparty_id = p.counterparty_id
  LEFT JOIN public.tender_bid_forms f ON f.tender_id = p.tender_id AND f.counterparty_id = p.counterparty_id
  LEFT JOIN agg a ON a.tender_id = p.tender_id AND a.counterparty_id = p.counterparty_id
  ORDER BY greatest(a.at, f.updated_at, r.requested_at, r.decided_at) DESC NULLS LAST;
END
$$;

-- ── 6. Права под одну учётку ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.tender_bid_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tender_bid_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tender_bid_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tender_bid_rates FORCE ROW LEVEL SECURITY;
ALTER TABLE public.bid_form_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bid_form_fields FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tender_bid_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tender_bid_forms FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS osp_internal ON public.tender_bid_requests;
CREATE POLICY osp_internal ON public.tender_bid_requests FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));
DROP POLICY IF EXISTS osp_internal ON public.tender_bid_rates;
CREATE POLICY osp_internal ON public.tender_bid_rates FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));
DROP POLICY IF EXISTS osp_internal ON public.bid_form_fields;
CREATE POLICY osp_internal ON public.bid_form_fields FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));
DROP POLICY IF EXISTS osp_internal ON public.tender_bid_forms;
CREATE POLICY osp_internal ON public.tender_bid_forms FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

-- Пропуск → да; иначе роль из токена и условие (как TO authenticated USING (…) на проде).
DROP POLICY IF EXISTS tender_bid_requests_read ON public.tender_bid_requests;
CREATE POLICY tender_bid_requests_read ON public.tender_bid_requests FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated'))
                    AND ((SELECT public.osp_is_employee()) OR counterparty_id = (SELECT public.osp_counterparty_id()))) END);
DROP POLICY IF EXISTS tender_bid_rates_read ON public.tender_bid_rates;
CREATE POLICY tender_bid_rates_read ON public.tender_bid_rates FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated'))
                    AND ((SELECT public.is_admin()) OR counterparty_id = (SELECT public.osp_counterparty_id()))) END);
DROP POLICY IF EXISTS tender_bid_forms_read ON public.tender_bid_forms;
CREATE POLICY tender_bid_forms_read ON public.tender_bid_forms FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated'))
                    AND ((SELECT public.is_admin()) OR counterparty_id = (SELECT public.osp_counterparty_id()))) END);
DROP POLICY IF EXISTS bid_form_fields_read ON public.bid_form_fields;
CREATE POLICY bid_form_fields_read ON public.bid_form_fields FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated'))
                    AND ((SELECT public.osp_is_employee()) OR (SELECT public.osp_counterparty_id()) IS NOT NULL)) END);
DROP POLICY IF EXISTS bid_form_fields_write ON public.bid_form_fields;
CREATE POLICY bid_form_fields_write ON public.bid_form_fields FOR ALL TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.is_admin())) END)
  WITH CHECK (CASE WHEN (SELECT osp_private.bypass()) THEN true
                   ELSE ((SELECT osp_private.role_in('authenticated')) AND (SELECT public.is_admin())) END);

-- Файлы тендера подрядчику: свои тендеры, как раньше, и открытый тендер после заявки (не отклонённой).
DROP POLICY IF EXISTS portal_contractor_select ON public.s3_documents;
CREATE POLICY portal_contractor_select ON public.s3_documents FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND (
                (owner_type = 'tender'
                  AND doc_category IN ('tender_package', 'vor', 'rd', 'vor_statement')
                  AND (public.is_my_tender(owner_id)
                       OR ((SELECT public.osp_counterparty_id()) IS NOT NULL AND public.bid_access(owner_id) IN ('pending', 'accepted'))))
                OR (owner_type = 'contract' AND public.is_my_contract(owner_id)))) END);
COMMENT ON POLICY portal_contractor_select ON public.s3_documents IS
  'Подрядчик: тендерный пакет и ВОР своих тендеров и тендеров, куда подана заявка с сайта, + документы своих договоров';

INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'tender_bid_requests', 'tender_bid_requests_read', ARRAY['authenticated']),
  ('public', 'tender_bid_rates', 'tender_bid_rates_read', ARRAY['authenticated']),
  ('public', 'tender_bid_forms', 'tender_bid_forms_read', ARRAY['authenticated']),
  ('public', 'bid_form_fields', 'bid_form_fields_read', ARRAY['authenticated']),
  ('public', 'bid_form_fields', 'bid_form_fields_write', ARRAY['authenticated']),
  ('public', 's3_documents', 'portal_contractor_select', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;
-- osp:allow table tender_bid_requests authenticated=select
-- osp:allow table tender_bid_rates authenticated=select
-- osp:allow table tender_bid_forms authenticated=select
-- osp:allow table bid_form_fields authenticated=select,insert,update,delete
-- Проверки доступа (их вызывают правила на прежнем портале — там нужен EXECUTE): отвечают только про самого вошедшего.
-- osp:allow rpc bid_tender_open authenticated
-- osp:allow rpc bid_access authenticated
-- osp:allow rpc bid_can_edit authenticated
-- osp:allow rpc bid_contractor_tenders authenticated
-- osp:allow rpc bid_request authenticated
-- osp:allow rpc bid_decide authenticated
-- osp:allow rpc bid_rates_save authenticated
-- osp:allow rpc bid_form_save authenticated
-- osp:allow rpc bid_admin_overview authenticated
