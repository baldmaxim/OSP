-- Кабинет подрядчика: свой ВОР с расценками рядом с каждой ведомостью тендера (решение пользователя 11.11.2026), только база Яндекса.
-- Нужны 20261102 (расценка в кабинете) и 20261226 (файл ВОР подрядчику).
--
-- Расценка на сайте временно скрыта: подрядчик скачивает пустой ВОР, заполняет цены у себя и загружает файл обратно — к той ведомости,
-- по которой расценивал (корпус). Цены из файла читает страница (тот же разбор, что «Цены из файла» и счета снабжения), суммы по
-- материалам и работам — сводкой строки (summary). Сам файл лежит в хранилище, ключ — bids/<тендер>/<организация>/<ключ операции>-<имя>.
--
--  • tender_bid_files — строка на тендер, организацию и ведомость отдела (vor_file_id — id файла ВОР в s3_documents, без внешнего ключа:
--    отдел может заменить или убрать ВОР, файл подрядчика при этом остаётся; имя ведомости — слепком). Новый файл к той же ведомости
--    заменяет прежний.
--  • Читают организация (только свои строки) и администратор — как цены и анкету. Пишут только функции ниже, их вызывает служба
--    (маршрут /api/fn/bid-file) под входом подрядчика; в списке шлюза функций нет: ключ файла браузер не получает и не задаёт.
--  • bid_admin_overview: прежние поля, в сводку попадают и организации, которые только загрузили файлы.
-- Данные портала не меняются. Повтор безопасен.

-- ── 1. Таблица ───────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tender_bid_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id uuid NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
  counterparty_id uuid NOT NULL REFERENCES public.counterparties(id) ON DELETE CASCADE,
  vor_file_id uuid NOT NULL,
  vor_name text NOT NULL CHECK (char_length(vor_name) BETWEEN 1 AND 500),
  s3_key text NOT NULL UNIQUE CHECK (s3_key LIKE 'bids/%' AND char_length(s3_key) <= 1000),
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  mime_type text CHECK (mime_type IS NULL OR char_length(mime_type) <= 200),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 26214400),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object' AND char_length(summary::text) <= 4000),
  uploaded_by uuid,
  uploaded_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tender_bid_files_key UNIQUE (tender_id, counterparty_id, vor_file_id)
);
COMMENT ON TABLE public.tender_bid_files IS
  'Свой ВОР подрядчика с расценками к ведомости тендера (кабинет подрядчика): файл в хранилище и сводка сумм; пишут только функции bid_file_*';
COMMENT ON COLUMN public.tender_bid_files.vor_file_id IS 'Файл ВОР отдела (s3_documents.id), к которому приложена расценка; без внешнего ключа — ВОР могут заменить';
COMMENT ON COLUMN public.tender_bid_files.summary IS
  'Сводка, посчитанная страницей при загрузке: суммы материалов и работ (цена файла × объём ВОР), сколько позиций с ценой, НДС';
CREATE INDEX IF NOT EXISTS tender_bid_files_counterparty_idx ON public.tender_bid_files (counterparty_id, tender_id);

-- ── 2. Функции службы ────────────────────────────────────────────────────────────────────────────────
-- Куда можно приложить расценку: ведомость — Excel-файл ВОР этого тендера, тендер открыт, организация — участник или её заявка не
-- отклонена (bid_can_edit). → организация вошедшего (часть ключа файла) и имя ведомости. Иначе — отказ.
CREATE OR REPLACE FUNCTION public.bid_file_target(p_tender uuid, p_vor_file uuid)
RETURNS TABLE (counterparty_id uuid, vor_name text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid := public.osp_counterparty_id();
  v_name text;
BEGIN
  IF v_cp IS NULL THEN
    RAISE EXCEPTION 'Файл с расценкой загружает подрядчик' USING ERRCODE = '42501';
  END IF;
  IF NOT public.bid_can_edit(p_tender) THEN
    RAISE EXCEPTION 'Приём предложений по этому тендеру закрыт или заявка не подана' USING ERRCODE = '42501';
  END IF;
  SELECT d.file_name INTO v_name
  FROM public.s3_documents d
  WHERE d.id = p_vor_file AND d.owner_type = 'tender' AND d.owner_id = p_tender
    AND d.doc_category IN ('vor_statement', 'vor') AND d.file_name ~* '\.(xlsx|xlsm|xls)$';
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Такой ведомости в тендере нет' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY SELECT v_cp, left(coalesce(NULLIF(btrim(regexp_replace(v_name, '\.(xlsx|xlsm|xls)$', '', 'i')), ''), v_name), 500);
END
$$;
COMMENT ON FUNCTION public.bid_file_target(uuid, uuid) IS
  'Кабинет подрядчика: можно ли приложить расценку к ведомости тендера; организация и имя ведомости. Только для службы, в списке шлюза нет.';

-- Записать файл к ведомости (файл уже в хранилище — проверила служба). Ключ — только в каталоге своей организации и тендера.
-- → ключ прежнего файла этой ведомости, который служба удалит из хранилища (тот же ключ или первого файла нет — NULL).
CREATE OR REPLACE FUNCTION public.bid_file_save(p_tender uuid, p_vor_file uuid, p_s3_key text, p_file_name text,
                                                p_mime text, p_size bigint, p_summary jsonb)
RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid;
  v_vor text;
  v_prev text;
  v_who text;
BEGIN
  SELECT t.counterparty_id, t.vor_name INTO v_cp, v_vor FROM public.bid_file_target(p_tender, p_vor_file) t;
  IF p_s3_key IS NULL OR p_s3_key NOT LIKE ('bids/' || p_tender::text || '/' || v_cp::text || '/%') OR p_s3_key LIKE '%..%' THEN
    RAISE EXCEPTION 'Неверный ключ файла' USING ERRCODE = '22023';
  END IF;
  IF coalesce(btrim(p_file_name), '') = '' OR p_size IS NULL OR p_size < 0 OR p_size > 26214400 THEN
    RAISE EXCEPTION 'Неверный файл (имя, размер до 25 МБ)' USING ERRCODE = '22023';
  END IF;
  IF p_summary IS NULL OR jsonb_typeof(p_summary) IS DISTINCT FROM 'object' OR char_length(p_summary::text) > 4000 THEN
    RAISE EXCEPTION 'Неверная сводка файла' USING ERRCODE = '22023';
  END IF;
  SELECT f.s3_key INTO v_prev FROM public.tender_bid_files f
  WHERE f.tender_id = p_tender AND f.counterparty_id = v_cp AND f.vor_file_id = p_vor_file;
  SELECT coalesce(NULLIF(btrim(ur.full_name), ''), ur.email) INTO v_who FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1;
  INSERT INTO public.tender_bid_files AS b
    (tender_id, counterparty_id, vor_file_id, vor_name, s3_key, file_name, mime_type, size_bytes, summary, uploaded_by, uploaded_by_name)
  VALUES (p_tender, v_cp, p_vor_file, v_vor, p_s3_key, left(btrim(p_file_name), 255), left(NULLIF(btrim(p_mime), ''), 200), p_size,
          p_summary, auth.uid(), v_who)
  ON CONFLICT (tender_id, counterparty_id, vor_file_id) DO UPDATE
    SET vor_name = excluded.vor_name, s3_key = excluded.s3_key, file_name = excluded.file_name, mime_type = excluded.mime_type,
        size_bytes = excluded.size_bytes, summary = excluded.summary, uploaded_by = excluded.uploaded_by,
        uploaded_by_name = excluded.uploaded_by_name, updated_at = now();
  RETURN CASE WHEN v_prev IS DISTINCT FROM p_s3_key THEN v_prev END;
END
$$;
COMMENT ON FUNCTION public.bid_file_save(uuid, uuid, text, text, text, bigint, jsonb) IS
  'Кабинет подрядчика: свой ВОР с расценками к ведомости тендера (новый заменяет прежний). Только для службы, в списке шлюза нет.';

-- Убрать свой файл, пока идёт приём предложений. → ключ файла для удаления из хранилища; строки нет — NULL.
CREATE OR REPLACE FUNCTION public.bid_file_remove(p_file uuid)
RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid := public.osp_counterparty_id();
  v_tender uuid;
  v_key text;
BEGIN
  IF v_cp IS NULL THEN
    RAISE EXCEPTION 'Файл с расценкой убирает подрядчик' USING ERRCODE = '42501';
  END IF;
  SELECT f.tender_id INTO v_tender FROM public.tender_bid_files f WHERE f.id = p_file AND f.counterparty_id = v_cp;
  IF v_tender IS NULL THEN RETURN NULL; END IF;
  IF NOT public.bid_can_edit(v_tender) THEN
    RAISE EXCEPTION 'Приём предложений по этому тендеру закрыт' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.tender_bid_files f WHERE f.id = p_file AND f.counterparty_id = v_cp RETURNING f.s3_key INTO v_key;
  RETURN v_key;
END
$$;
COMMENT ON FUNCTION public.bid_file_remove(uuid) IS 'Кабинет подрядчика: убрать свой ВОР с расценками, пока идёт приём. Только для службы.';

-- Скачать файл: своя организация (и после закрытия приёма) или администратор. → ключ и имя; чужой или нет — пусто.
CREATE OR REPLACE FUNCTION public.bid_file_get(p_file uuid)
RETURNS TABLE (s3_key text, file_name text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT f.s3_key, f.file_name
  FROM public.tender_bid_files f
  WHERE f.id = p_file
    AND (f.counterparty_id = public.osp_counterparty_id() OR public.is_admin())
$$;
COMMENT ON FUNCTION public.bid_file_get(uuid) IS 'Кабинет подрядчика: ключ и имя своего ВОР с расценками (или любого — администратору). Только для службы.';

-- ── 3. Сводка администратора: и те, кто только загрузил файлы ─────────────────────────────────────────
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
    UNION SELECT bf.tender_id, bf.counterparty_id FROM public.tender_bid_files bf
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
  ),
  files AS (
    SELECT bf.tender_id, bf.counterparty_id, max(bf.updated_at) AS at
    FROM public.tender_bid_files bf GROUP BY bf.tender_id, bf.counterparty_id
  )
  SELECT p.tender_id, t.public_tender_number, t.work_description, t.status::text, public.bid_tender_open(t.id),
         coalesce(o.name::text, t.custom_object_name), t.tender_end_date, p.counterparty_id, cp.name, cp.inn,
         tc.status::text, r.id, r.status, r.requested_at,
         coalesce(a.mp, 0)::integer, coalesce(a.wp, 0)::integer, coalesce(a.mt, 0), coalesce(a.wt, 0),
         coalesce(a.mt, 0) + coalesce(a.wt, 0), coalesce(a.nc, 0)::integer,
         coalesce((SELECT count(*) FROM jsonb_object_keys(f.answers)), 0)::integer,
         f.answers -> (SELECT ff.id::text FROM public.bid_form_fields ff WHERE ff.code = 'vat') ->> 'value',
         greatest(a.at, f.updated_at, r.requested_at, r.decided_at, fl.at)
  FROM pairs p
  JOIN public.tenders t ON t.id = p.tender_id
  LEFT JOIN public.objects o ON o.id = t.object_id
  JOIN public.counterparties cp ON cp.id = p.counterparty_id
  LEFT JOIN public.tender_counterparties tc ON tc.tender_id = p.tender_id AND tc.counterparty_id = p.counterparty_id
  LEFT JOIN public.tender_bid_requests r ON r.tender_id = p.tender_id AND r.counterparty_id = p.counterparty_id
  LEFT JOIN public.tender_bid_forms f ON f.tender_id = p.tender_id AND f.counterparty_id = p.counterparty_id
  LEFT JOIN agg a ON a.tender_id = p.tender_id AND a.counterparty_id = p.counterparty_id
  LEFT JOIN files fl ON fl.tender_id = p.tender_id AND fl.counterparty_id = p.counterparty_id
  ORDER BY greatest(a.at, f.updated_at, r.requested_at, r.decided_at, fl.at) DESC NULLS LAST;
END
$$;

-- ── 4. Права под одну учётку ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.tender_bid_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tender_bid_files FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS osp_internal ON public.tender_bid_files;
CREATE POLICY osp_internal ON public.tender_bid_files FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

-- Пропуск → да; иначе роль из токена и условие: своя организация или администратор (как цены и анкета).
DROP POLICY IF EXISTS tender_bid_files_read ON public.tender_bid_files;
CREATE POLICY tender_bid_files_read ON public.tender_bid_files FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated'))
                    AND ((SELECT public.is_admin()) OR counterparty_id = (SELECT public.osp_counterparty_id()))) END);

INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'tender_bid_files', 'tender_bid_files_read', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;
-- osp:allow table tender_bid_files authenticated=select
