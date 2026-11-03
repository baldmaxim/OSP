-- Подрядчик, зарегистрировавшийся на сайте: только активные тендеры, расценка и сведения о своей компании (решения
-- пользователя 03.11.2026). Только база Яндекса. Нужны 20261102, 20261122, 20261201, 20261203.
--
-- Главная преграда — список шлюза для таких учёток (server/osp-api/src/data/allow-self-contractor.json): всего, чего в
-- нём нет, для них не существует. Эта миграция — второй замок на случай ошибки выше, в самой базе:
--  • current_counterparty_id() для учётки с регистрации — пусто. На нём держатся is_my_tender, is_my_contract и прежние
--    правила подрядчика (смета, свои КП, файлы и договоры, согласование): учётка, даже привязанная к компании из реестра,
--    через них ничего не получает. Цены, анкета и список тендеров — на osp_counterparty_id(), их это не задевает;
--  • файлы тендера правило s3_documents ей не показывает; договоры и отметка участия функциями закрыты;
--  • bid_contractor_tenders: учётке с регистрации — только идущие тендеры, даже если её компания участвовала в прошлых;
--  • bid_positions — позиции ВОР, разобранные службой, а не файл: подрядчик получает наименование, ед. изм., объём и
--    особые условия, но не книгу Excel со всем, что в ней могло лежать (скрытые листы, служебные колонки, история правок);
--    учётке с регистрации — только по идущему тендеру;
--  • bid_rates_save: цена — только на позицию этого ВОР; наименование, ед. изм. и объём берутся из разбора, а не из запроса,
--    иначе подрядчик мог бы записать в реестр расценок что угодно и подогнать сумму;
--  • реестр расценок: цены компании, созданной регистрацией, попадают в него, только если инженер сделал её участником
--    этого тендера — ИНН у неё проверен лишь контрольной суммой.
-- Данные портала не меняются. Повтор безопасен.

-- ── 1. Кто это ───────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.osp_self_registered() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT coalesce((SELECT ur.self_registered FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1), false)
$$;
COMMENT ON FUNCTION public.osp_self_registered() IS 'Вошедший — подрядчик, зарегистрировавшийся на сайте (узкий доступ).';

CREATE OR REPLACE FUNCTION public.current_counterparty_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT ur.counterparty_id
  FROM public.user_roles ur
  WHERE ur.user_id = auth.uid() AND ur.is_approved = true AND NOT ur.self_registered
  LIMIT 1
$$;

-- ── 2. Договоры, отметка участия и файлы — не для учётки с регистрации ───────────────────────────────
CREATE OR REPLACE FUNCTION public.contractor_contracts()
RETURNS TABLE (id uuid, display_id bigint, contract_number text, contract_date date, work_name text, status text,
               contract_amount numeric, currency text, object_name text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid := public.osp_counterparty_id();
BEGIN
  IF v_cp IS NULL OR public.osp_self_registered() THEN
    RAISE EXCEPTION 'Договоры кабинета — только для подрядчика' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT c.id, c.display_id, c.contract_number::text, c.contract_date, c.work_name, c.status::text,
         c.contract_amount, c.currency::text, o.name::text
  FROM public.contracts c
  LEFT JOIN public.objects o ON o.id = c.object_id
  WHERE c.deleted_at IS NULL
    AND (c.counterparty_id = v_cp OR EXISTS (
      SELECT 1 FROM public.contract_counterparties cc WHERE cc.contract_id = c.id AND cc.counterparty_id = v_cp))
  ORDER BY c.contract_date DESC NULLS LAST, c.id;
END $$;

CREATE OR REPLACE FUNCTION public.contractor_set_participation(p_tender uuid, p_status text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid := public.osp_counterparty_id();
  v_row uuid;
  v_status text;
BEGIN
  IF v_cp IS NULL OR public.osp_self_registered() THEN
    RAISE EXCEPTION 'Отметку участия ставит подрядчик' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('proposal_provided', 'declined') THEN
    RAISE EXCEPTION 'Недопустимая отметка участия' USING ERRCODE = '22023';
  END IF;
  SELECT tc.id, tc.status::text INTO v_row, v_status
  FROM public.tender_counterparties tc
  WHERE tc.tender_id = p_tender AND tc.counterparty_id = v_cp
  FOR UPDATE;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'Организация не участвует в этом тендере' USING ERRCODE = '42501';
  END IF;
  IF NOT public.bid_tender_open(p_tender) THEN
    RAISE EXCEPTION 'Приём предложений по этому тендеру закрыт' USING ERRCODE = 'P0001';
  END IF;
  IF v_status = 'accepted_for_work' THEN
    RAISE EXCEPTION 'Участие уже подтверждено — обратитесь к ответственному по тендеру' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.tender_counterparties SET status = p_status::public.tender_counterparty_status WHERE id = v_row;
END $$;

DROP POLICY IF EXISTS portal_contractor_select ON public.s3_documents;
CREATE POLICY portal_contractor_select ON public.s3_documents FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND NOT (SELECT public.osp_self_registered()) AND (
                (owner_type = 'tender'
                  AND doc_category IN ('tender_package', 'vor', 'rd', 'vor_statement')
                  AND (public.is_my_tender(owner_id)
                       OR ((SELECT public.osp_counterparty_id()) IS NOT NULL AND public.bid_access(owner_id) IN ('pending', 'accepted'))))
                OR (owner_type = 'contract' AND public.is_my_contract(owner_id)))) END);
COMMENT ON POLICY portal_contractor_select ON public.s3_documents IS
  'Подрядчик от администратора: тендерный пакет и ВОР своих тендеров и тендеров с заявкой + документы своих договоров. Учётке с регистрации файлов нет.';

-- ── 3. Позиции ВОР — разбор службы вместо файла ──────────────────────────────────────────────────────
-- Пишет только служба (server/osp-api/src/lib/bidPositions.js), читает только bid_positions: в закрытой схеме правил
-- по строкам нет, шлюз её не видит.
CREATE TABLE IF NOT EXISTS osp_private.bid_vor_files (
  s3_document_id uuid PRIMARY KEY REFERENCES public.s3_documents(id) ON DELETE CASCADE,
  tender_id uuid NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
  source_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('ok', 'error')),
  error text,
  positions jsonb NOT NULL DEFAULT '[]'::jsonb,
  structure jsonb NOT NULL DEFAULT '[]'::jsonb,
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  parsed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bid_vor_files_tender_idx ON osp_private.bid_vor_files (tender_id);
COMMENT ON TABLE osp_private.bid_vor_files IS 'Позиции и структура файла ВОР, разобранные службой: их, а не файл, получает подрядчик с регистрации';

-- По строке на файл ВОР тендера. Ещё не разобран — status = pending. Только тем, у кого есть доступ к тендеру (участник
-- или заявка), как раньше к файлам; заявка отклонена — ничего.
CREATE OR REPLACE FUNCTION public.bid_positions(p_tender uuid)
RETURNS TABLE (file_id uuid, title text, status text, error text, positions jsonb, structure jsonb, conditions jsonb)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_access text;
BEGIN
  IF public.osp_counterparty_id() IS NULL THEN
    RAISE EXCEPTION 'Позиции ВОР — только для подрядчика' USING ERRCODE = '42501';
  END IF;
  v_access := public.bid_access(p_tender);
  IF v_access IS NULL THEN
    RAISE EXCEPTION 'Сначала подайте заявку на участие в этом тендере' USING ERRCODE = '42501';
  END IF;
  IF v_access = 'rejected' OR (public.osp_self_registered() AND NOT public.bid_tender_open(p_tender)) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT d.id, regexp_replace(d.file_name, '\.(xlsx|xlsm|xls)$', '', 'i'), coalesce(f.status, 'pending'), f.error,
         coalesce(f.positions, '[]'::jsonb), coalesce(f.structure, '[]'::jsonb), coalesce(f.conditions, '[]'::jsonb)
  FROM public.s3_documents d
  LEFT JOIN osp_private.bid_vor_files f ON f.s3_document_id = d.id
  WHERE d.owner_type = 'tender' AND d.owner_id = p_tender AND d.doc_category IN ('vor_statement', 'vor')
    AND d.file_name ~* '\.(xlsx|xlsm|xls)$'
  ORDER BY d.created_at DESC, d.id;
END $$;
COMMENT ON FUNCTION public.bid_positions(uuid) IS 'Кабинет подрядчика: позиции ВОР тендера без файлов.';

-- Тендеры кабинета — тело 20261102; учётке с регистрации только идущие.
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
  v_self boolean := public.osp_self_registered();
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
  WHERE NOT v_self OR public.bid_tender_open(t.id)
  ORDER BY t.tender_end_date NULLS LAST, t.public_tender_number;
END
$$;

-- ── 4. Общие сведения о своей компании ───────────────────────────────────────────────────────────────
-- Только перечисленные поля: статус (в том числе чёрный список), примечания и подразделения отдела сюда не входят.
CREATE OR REPLACE FUNCTION public.contractor_org_card()
RETURNS TABLE (name text, inn text, kpp text, legal_address text, actual_address text, website text, work_type text,
               contact_name text, contact_phone text, contact_email text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT c.name::text, c.inn::text, c.kpp::text, c.legal_address::text, c.actual_address::text, c.website::text, c.work_type::text,
         ur.full_name::text, ur.work_phone::text, ur.email::text
  FROM public.user_roles ur
  JOIN public.counterparties c ON c.id = ur.counterparty_id AND c.deleted_at IS NULL
  WHERE ur.user_id = auth.uid() AND ur.is_approved AND NOT ur.is_blocked
$$;
COMMENT ON FUNCTION public.contractor_org_card() IS 'Кабинет подрядчика: сведения о своей организации и контакт учётки, поля — перечнем.';

-- ── 5. Цены — только на позиции ВОР ──────────────────────────────────────────────────────────────────
-- Тело 20261102; учётке с регистрации — проверка по разбору службы: позиции нет — отказ, наименование, ед. изм. и объём
-- из разбора. Убрать свою цену (пустая цена и примечание) можно всегда: позицию могли убрать из новой версии ВОР.
CREATE OR REPLACE FUNCTION public.bid_rates_save(p_tender uuid, p_rows jsonb) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid := public.osp_counterparty_id();
  v_self boolean := public.osp_self_registered();
  v_known jsonb;
  v_pos jsonb;
  r record;
  v_price numeric;
  v_note text;
  v_name text;
  v_unit text;
  v_volume numeric;
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
  IF v_self THEN
    SELECT coalesce(jsonb_object_agg(x.k, jsonb_build_object('name', x.n, 'unit', x.u, 'volume', x.v)), '{}'::jsonb) INTO v_known
    FROM (
      SELECT p ->> 'key' AS k, min(p ->> 'name') AS n, min(p ->> 'unit') AS u, round(sum((p ->> 'volume')::numeric), 4) AS v
      FROM osp_private.bid_vor_files f
      JOIN public.s3_documents d ON d.id = f.s3_document_id AND d.doc_category IN ('vor_statement', 'vor')
      CROSS JOIN LATERAL jsonb_array_elements(f.positions) p
      WHERE f.tender_id = p_tender AND f.status = 'ok'
      GROUP BY p ->> 'key'
    ) x;
  END IF;
  FOR r IN SELECT * FROM jsonb_to_recordset(p_rows)
             AS x(kind text, key text, unit_key text, name text, unit text, volume numeric, price numeric, note text, source text)
  LOOP
    IF r.kind IS NULL OR r.kind NOT IN ('material', 'work') OR coalesce(btrim(r.key), '') = '' OR coalesce(btrim(r.name), '') = '' THEN
      RAISE EXCEPTION 'Позиция без вида, ключа или наименования' USING ERRCODE = '22023';
    END IF;
    v_price := round(r.price, 2);
    v_note := NULLIF(btrim(r.note), '');
    v_name := btrim(r.name);
    v_unit := NULLIF(btrim(r.unit), '');
    v_volume := r.volume;
    IF v_price IS NULL AND v_note IS NULL THEN
      DELETE FROM public.tender_bid_rates
       WHERE tender_id = p_tender AND counterparty_id = v_cp AND kind = r.kind
         AND item_key = r.key AND unit_key = coalesce(r.unit_key, '');
    ELSE
      IF v_self THEN
        v_pos := v_known -> (r.kind || '|' || r.key || '|' || coalesce(r.unit_key, ''));
        IF v_pos IS NULL THEN
          RAISE EXCEPTION 'Позиции нет в ВОР этого тендера — обновите страницу' USING ERRCODE = '22023';
        END IF;
        v_name := v_pos ->> 'name';
        v_unit := NULLIF(btrim(v_pos ->> 'unit'), '');
        v_volume := (v_pos ->> 'volume')::numeric;
      END IF;
      INSERT INTO public.tender_bid_rates AS b
        (tender_id, counterparty_id, kind, item_key, unit_key, name, unit, volume, price, total, note, source, updated_by)
      VALUES (p_tender, v_cp, r.kind, r.key, coalesce(r.unit_key, ''), v_name, v_unit, v_volume,
              v_price, round(v_price * coalesce(v_volume, 0), 2), v_note,
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

-- ── 6. Реестр расценок: компания с регистрации — только участник тендера ─────────────────────────────
-- Определение и подмена — как в 20261122 (пересоздаётся рядом), меняется одно условие у цен с сайта.
DROP MATERIALIZED VIEW IF EXISTS osp_private.kp_rates_registry_mv_next;
CREATE MATERIALIZED VIEW osp_private.kp_rates_registry_mv_next AS
WITH kp AS (
  -- КП из файлов: позиция ВОР (estimate_name — какой ВОР) и файл КП, сохранённый вместе с ценами (окно загрузки КП
  -- пишет файл сразу после цен): того же подрядчика и тендера, с минуты до по 10 минут после, ближайший.
  SELECT p.id AS proposal_id, p.tender_id, p.counterparty_id, p.proposal_date, p.unit_price_materials, p.unit_price_works,
         ei.cost_name, ei.unit, ei.material_consumption, ei.work_volume, ei.estimate_name,
         t.object_id, t.work_description, o.name AS object_name, c.name AS counterparty_name,
         kf.s3_document_id AS source_doc_id, kf.file_name AS source_doc_name
  FROM public.tender_counterparty_proposals p
  JOIN public.tender_estimate_items ei ON ei.id = p.estimate_item_id
  JOIN public.tenders t ON t.id = p.tender_id
  LEFT JOIN public.objects o ON o.id = t.object_id
  LEFT JOIN public.counterparties c ON c.id = p.counterparty_id
  LEFT JOIN LATERAL (
    SELECT f.s3_document_id, d.file_name
    FROM public.tender_proposal_files f
    JOIN public.s3_documents d ON d.id = f.s3_document_id
    WHERE f.tender_id = p.tender_id AND f.counterparty_id = p.counterparty_id AND f.file_kind = 'commercial_proposal'
      AND f.created_at >= p.created_at - interval '1 minute' AND f.created_at <= p.created_at + interval '10 minutes'
    ORDER BY abs(extract(epoch FROM f.created_at - p.created_at)), f.id
    LIMIT 1
  ) kf ON true
), entries AS (
  SELECT kp.proposal_id, 'material'::text AS item_type, kp.cost_name AS item_name, kp.unit,
         kp.unit_price_materials AS price, kp.tender_id, kp.counterparty_id, kp.proposal_date, kp.object_id,
         kp.work_description AS tender_desc, kp.object_name, kp.counterparty_name,
         'kp'::text AS source_kind, kp.estimate_name, kp.source_doc_id, kp.source_doc_name
  FROM kp
  WHERE COALESCE(kp.material_consumption, 0::numeric) > 0::numeric AND COALESCE(kp.unit_price_materials, 0::numeric) > 0::numeric
    AND public.kp_norm_name(kp.cost_name) <> ''::text
  UNION ALL
  SELECT kp.proposal_id, 'work'::text, kp.cost_name, kp.unit, kp.unit_price_works, kp.tender_id, kp.counterparty_id,
         kp.proposal_date, kp.object_id, kp.work_description, kp.object_name, kp.counterparty_name,
         'kp'::text, kp.estimate_name, kp.source_doc_id, kp.source_doc_name
  FROM kp
  WHERE COALESCE(kp.work_volume, 0::numeric) > 0::numeric AND COALESCE(kp.unit_price_works, 0::numeric) > 0::numeric
    AND public.kp_norm_name(kp.cost_name) <> ''::text
  UNION ALL
  -- Цены подрядчиков, введённые в кабинете (tender_bid_rates, 20261102), — только завершённого тендера (20261103).
  SELECT b.id, b.kind, b.name, left(b.unit, 50)::character varying(50), b.price, b.tender_id, b.counterparty_id,
         (b.updated_at AT TIME ZONE 'Europe/Moscow')::date, t.object_id, t.work_description, o.name, c.name,
         'site'::text, NULL::text, NULL::uuid, NULL::text
  FROM public.tender_bid_rates b
  JOIN public.tenders t ON t.id = b.tender_id
  LEFT JOIN public.objects o ON o.id = t.object_id
  LEFT JOIN public.counterparties c ON c.id = b.counterparty_id
  WHERE t.status::text = 'Завершен' AND t.deleted_at IS NULL
    AND COALESCE(b.price, 0::numeric) > 0::numeric AND public.kp_norm_name(b.name) <> ''::text
    -- Компания, созданная регистрацией на сайте: только если инженер сделал её участником этого тендера (20261204).
    AND (c.registered_via IS DISTINCT FROM 'self' OR EXISTS (
      SELECT 1 FROM public.tender_counterparties tc WHERE tc.tender_id = b.tender_id AND tc.counterparty_id = b.counterparty_id))
)
SELECT DISTINCT ON (tender_id, counterparty_id, item_type, (public.kp_norm_name(item_name)), (public.kp_norm_unit(unit::text)))
  md5((((((((tender_id::text || '|'::text) || counterparty_id::text) || '|'::text) || item_type) || '|'::text)
       || public.kp_norm_name(item_name)) || '|'::text) || public.kp_norm_unit(unit::text)) AS id,
  item_type, item_name, unit, price, tender_id, counterparty_id, object_id, tender_desc, object_name, counterparty_name, proposal_date,
  source_kind, estimate_name, source_doc_id, source_doc_name
FROM entries
ORDER BY tender_id, counterparty_id, item_type, (public.kp_norm_name(item_name)), (public.kp_norm_unit(unit::text)),
         proposal_date DESC NULLS LAST, proposal_id;

CREATE UNIQUE INDEX kp_rates_mv_next_id ON osp_private.kp_rates_registry_mv_next USING btree (id);
CREATE INDEX kp_rates_mv_next_counterparty ON osp_private.kp_rates_registry_mv_next USING btree (counterparty_id);
CREATE INDEX kp_rates_mv_next_date ON osp_private.kp_rates_registry_mv_next USING btree (proposal_date DESC NULLS LAST);
CREATE INDEX kp_rates_mv_next_name_trgm ON osp_private.kp_rates_registry_mv_next USING gin (item_name gin_trgm_ops);
CREATE INDEX kp_rates_mv_next_object ON osp_private.kp_rates_registry_mv_next USING btree (object_id);
CREATE INDEX kp_rates_mv_next_price ON osp_private.kp_rates_registry_mv_next USING btree (price);
CREATE INDEX kp_rates_mv_next_tender ON osp_private.kp_rates_registry_mv_next USING btree (tender_id);
CREATE INDEX kp_rates_mv_next_type_name ON osp_private.kp_rates_registry_mv_next USING btree (item_type, item_name, id);

-- Представления реестра: материализованное + ручные строки, только читателю реестра.
-- Прежние колонки — на своих местах и тех же типов (ручные строки приводятся к ним), новые — в конце. Условие
-- «читатель реестра» — над объединением: так страница читает материализованное по индексу (как в Supabase-варианте).
CREATE OR REPLACE VIEW public.kp_rates_registry AS
 SELECT u.id, u.item_type, u.item_name, u.unit, u.price, u.tender_id, u.counterparty_id, u.object_id, u.tender_desc,
        u.object_name, u.counterparty_name, u.proposal_date, u.source_kind, u.estimate_name, u.source_doc_id,
        u.source_doc_name, u.source_url, u.manual_id, u.note
   FROM (SELECT r.id, r.item_type, r.item_name, r.unit, r.price, r.tender_id, r.counterparty_id, r.object_id, r.tender_desc,
                r.object_name, r.counterparty_name, r.proposal_date, r.source_kind, r.estimate_name, r.source_doc_id,
                r.source_doc_name, NULL::text AS source_url, NULL::uuid AS manual_id, NULL::text AS note
           FROM osp_private.kp_rates_registry_mv_next r
         UNION ALL
         SELECT f.id, f.item_type, f.item_name, f.unit::character varying(50), f.price::numeric(15,2), f.tender_id,
                f.counterparty_id, f.object_id, f.tender_desc, f.object_name::character varying(255), f.counterparty_name,
                f.proposal_date, f.source_kind, f.estimate_name, f.source_doc_id, f.source_doc_name, f.source_url,
                f.manual_id, f.note
           FROM osp_private.view_kp_manual_rates() f) u
  WHERE (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.kp_rates_registry_filter_tenders AS
 SELECT DISTINCT x.tender_id, x.tender_desc, x.object_id
   FROM (SELECT r.tender_id, r.tender_desc, r.object_id FROM osp_private.kp_rates_registry_mv_next r
         UNION SELECT f.tender_id, f.tender_desc, f.object_id FROM osp_private.view_kp_manual_rates() f) x
  WHERE x.tender_id IS NOT NULL AND COALESCE(x.tender_desc, ''::text) <> ''::text AND (SELECT public.osp_registry_reader());
CREATE OR REPLACE VIEW public.kp_rates_registry_units AS
 SELECT DISTINCT x.unit
   FROM (SELECT r.unit FROM osp_private.kp_rates_registry_mv_next r
         UNION SELECT f.unit::character varying(50) FROM osp_private.view_kp_manual_rates() f) x
  WHERE x.unit IS NOT NULL AND x.unit::text <> ''::text AND (SELECT public.osp_registry_reader());

-- Прежнее представление — прочь, новое получает его имя и имена индексов: refresh_rates_registry() обращается к
-- нему по имени (пересчёт без блокировки чтения — по уникальному индексу idx_kp_rates_mv_id).
DROP MATERIALIZED VIEW IF EXISTS osp_private.kp_rates_registry_mv;
ALTER MATERIALIZED VIEW osp_private.kp_rates_registry_mv_next RENAME TO kp_rates_registry_mv;
ALTER INDEX osp_private.kp_rates_mv_next_id RENAME TO idx_kp_rates_mv_id;
ALTER INDEX osp_private.kp_rates_mv_next_counterparty RENAME TO idx_kp_rates_mv_counterparty;
ALTER INDEX osp_private.kp_rates_mv_next_date RENAME TO idx_kp_rates_mv_date;
ALTER INDEX osp_private.kp_rates_mv_next_name_trgm RENAME TO idx_kp_rates_mv_name_trgm;
ALTER INDEX osp_private.kp_rates_mv_next_object RENAME TO idx_kp_rates_mv_object;
ALTER INDEX osp_private.kp_rates_mv_next_price RENAME TO idx_kp_rates_mv_price;
ALTER INDEX osp_private.kp_rates_mv_next_tender RENAME TO idx_kp_rates_mv_tender;
ALTER INDEX osp_private.kp_rates_mv_next_type_name RENAME TO idx_kp_rates_mv_type_name;
COMMENT ON MATERIALIZED VIEW osp_private.kp_rates_registry_mv IS 'Реестр расценок из КП подрядчиков (с ВОР и файлом КП) и цен с сайта завершённых тендеров (дедуп по DISTINCT ON). Обновляется refresh_rates_registry()';
COMMENT ON VIEW public.kp_rates_registry IS 'Реестр «Расценки от подрядчиков (КП)»: материализованное представление и расценки, добавленные вручную (kp_manual_rates), — читателю реестра';

-- Фильтры по подрядчику и объекту — функции закрытой схемы (загрузчик): те же колонки, с ручными строками. Читают
-- представление по имени — после переименования это уже новое.
CREATE OR REPLACE FUNCTION osp_private.view_kp_rates_registry_filter_counterparties()
  RETURNS TABLE (counterparty_id uuid, counterparty_name text)
  LANGUAGE sql STABLE
  SET search_path = public
  SET application_name = 'osp:internal'
AS $$
  SELECT DISTINCT x.counterparty_id, c.name AS counterparty_name
  FROM (SELECT r.counterparty_id FROM osp_private.kp_rates_registry_mv r
        UNION SELECT m.counterparty_id FROM public.kp_manual_rates m) x
  JOIN public.counterparties c ON c.id = x.counterparty_id
  WHERE x.counterparty_id IS NOT NULL AND (SELECT public.osp_registry_reader())
$$;
CREATE OR REPLACE FUNCTION osp_private.view_kp_rates_registry_filter_objects()
  RETURNS TABLE (object_id uuid, object_name character varying(255))
  LANGUAGE sql STABLE
  SET search_path = public
  SET application_name = 'osp:internal'
AS $$
  SELECT DISTINCT x.object_id, o.name AS object_name
  FROM (SELECT r.object_id FROM osp_private.kp_rates_registry_mv r
        UNION SELECT coalesce(m.object_id, t.object_id) FROM public.kp_manual_rates m
              LEFT JOIN public.tenders t ON t.id = m.tender_id) x
  JOIN public.objects o ON o.id = x.object_id
  WHERE x.object_id IS NOT NULL AND (SELECT public.osp_registry_reader())
$$;

-- ── 7. Список шлюза ──────────────────────────────────────────────────────────────────────────────────
-- osp:allow rpc bid_positions authenticated
-- osp:allow rpc contractor_org_card authenticated
