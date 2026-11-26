-- Кабинет подрядчика: расценка на сайте — основной путь, цены снабжения с разрешения отдела, что изменилось в ВОР
-- (просьба пользователя 24.11.2026). Только база Яндекса (прежний портал на Supabase только читается).
--  • tender_bid_supply_access — разрешение организации взять цены снабжения тендера: подрядчик просит
--    (bid_supply_request), инженер с правом правки «Тендеров» разрешает или отказывает (bid_supply_decide), список для
--    раскрытой строки реестра — bid_supply_list. Читают сотрудник и своя организация; прямой записи нет;
--  • bid_supply_prices — цены снабжения материалов тендера, только при разрешении и пока идёт приём: ключ позиции и цена,
--    без ВОР, документов и авторов; цена есть, только если она одна во всех ВОР тендера;
--  • bid_supply_take — подрядчик берёт цену снабжения: цену берёт база (не браузер), отметка источника «supply»;
--    bid_rates_save такую отметку не ставит (только сохраняет у неизменённой цены);
--  • bid_rates_save — наименование, ед. изм. и объём позиции берутся из разбора ВОР службой и у подрядчика, заведённого
--    администратором (раньше — только у учётки с регистрации), если разобраны все ведомости тендера; объём — без ведомостей,
--    заменённых новой версией (раньше прежняя версия удваивала объём учётки с регистрации);
--  • bid_vor_changes и архив osp_private.bid_vor_archive — что изменилось в ВОР: прежняя версия ведомости (по отметке снабжения,
--    версии ВОР снабжения или тому же имени) и её позиции. Разбор удалённого файла ВОР раньше пропадал вместе с файлом (каскад),
--    теперь перед удалением он откладывается в архив;
--  • подрядчику — без файлов договоров (вкладки договоров в кабинете нет с 03.11.2026; среди них были внутренние документы),
--    файлы тендера по заявке — пока идёт приём; current_counterparty_id снова не отдаёт организацию заблокированной учётки;
--  • реестр «Расценки от подрядчиков (КП)»: цены с сайта — без взятых у снабжения и без отклонённых заявок.
-- Данные портала не меняются (кроме пересборки реестра). Повтор безопасен. Нужны 20261102, 20261204, 20261029, 20270114.

-- ── 1. Разрешение взять цены снабжения ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tender_bid_supply_access (
  tender_id uuid NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
  counterparty_id uuid NOT NULL REFERENCES public.counterparties(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('requested', 'granted', 'denied')),
  requested_at timestamptz,
  requested_by uuid,
  requested_by_name text,
  decided_at timestamptz,
  decided_by uuid,
  decided_by_name text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tender_id, counterparty_id)
);
CREATE INDEX IF NOT EXISTS tender_bid_supply_access_requested_idx ON public.tender_bid_supply_access (tender_id) WHERE status = 'requested';
COMMENT ON TABLE public.tender_bid_supply_access IS
  'Кабинет подрядчика: может ли организация взять цены снабжения материалов тендера (просьба подрядчика, решение инженера). Пишут только функции bid_supply_*';

ALTER TABLE public.tender_bid_supply_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tender_bid_supply_access FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS osp_internal ON public.tender_bid_supply_access;
CREATE POLICY osp_internal ON public.tender_bid_supply_access FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));
DROP POLICY IF EXISTS tender_bid_supply_access_read ON public.tender_bid_supply_access;
CREATE POLICY tender_bid_supply_access_read ON public.tender_bid_supply_access FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated'))
                    AND ((SELECT public.osp_is_employee()) OR counterparty_id = (SELECT public.osp_counterparty_id()))) END);
INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'tender_bid_supply_access', 'tender_bid_supply_access_read', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;

-- Цены снабжения материалов тендера по ключу позиции подрядчика (вид «материал»): material_key = normName, ед. изм. —
-- kp_norm_unit = normUnit, как ключи tender_bid_rates. Только ВОР, по которым у снабжения есть список позиций (цены без
-- ВОР не участвуют); цена — только если она одна во всех ВОР (разные цены — не выбираем за отдел). Служебная: вызывают
-- только функции ниже (с пропуском).
CREATE OR REPLACE FUNCTION osp_private.bid_supply_price_rows(p_tender uuid)
RETURNS TABLE (item_key text, unit_key text, price numeric)
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  SELECT r.material_key, public.kp_norm_unit(coalesce(r.unit, '')), min(r.supply_price)
  FROM public.tender_vor_supply_rates r
  WHERE r.tender_id = p_tender AND r.supply_price > 0 AND coalesce(r.material_key, '') <> ''
    AND (NOT EXISTS (SELECT 1 FROM public.tender_supply_sources s WHERE s.tender_id = p_tender)
         OR r.estimate_name IN (SELECT s.estimate_name FROM public.tender_supply_sources s WHERE s.tender_id = p_tender))
  GROUP BY r.material_key, public.kp_norm_unit(coalesce(r.unit, ''))
  HAVING min(r.supply_price) = max(r.supply_price)
$$;

-- Подрядчик просит разрешение взять цены снабжения. Уже разрешено или просьба ждёт — ответ как есть; отказ — повторить
-- можно через сутки (инженера не засыпать просьбами).
CREATE OR REPLACE FUNCTION public.bid_supply_request(p_tender uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid := public.osp_counterparty_id();
  v_row public.tender_bid_supply_access%ROWTYPE;
BEGIN
  IF v_cp IS NULL THEN
    RAISE EXCEPTION 'Цены снабжения просит подрядчик' USING ERRCODE = '42501';
  END IF;
  IF NOT public.bid_can_edit(p_tender) THEN
    RAISE EXCEPTION 'Приём предложений по этому тендеру закрыт или заявка не подана' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM public.tender_bid_supply_access WHERE tender_id = p_tender AND counterparty_id = v_cp FOR UPDATE;
  IF FOUND AND v_row.status IN ('granted', 'requested') THEN RETURN v_row.status; END IF;
  IF FOUND AND v_row.decided_at > now() - interval '1 day' THEN
    RAISE EXCEPTION 'Отдел отказал меньше суток назад — повторить просьбу можно завтра или написать ответственному по тендеру'
      USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM public.tender_bid_supply_access a
      WHERE a.counterparty_id = v_cp AND a.requested_at > now() - interval '1 day') >= 30 THEN
    RAISE EXCEPTION 'Слишком много просьб за сутки — попробуйте завтра' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.tender_bid_supply_access AS a (tender_id, counterparty_id, status, requested_at, requested_by, requested_by_name, updated_at)
  VALUES (p_tender, v_cp, 'requested', now(), auth.uid(),
          (SELECT NULLIF(btrim(ur.full_name), '') FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1), now())
  ON CONFLICT (tender_id, counterparty_id) DO UPDATE
    SET status = 'requested', requested_at = now(), requested_by = excluded.requested_by,
        requested_by_name = excluded.requested_by_name, updated_at = now();
  RETURN 'requested';
END
$$;
COMMENT ON FUNCTION public.bid_supply_request(uuid) IS 'Кабинет подрядчика: просьба разрешить взять цены снабжения тендера.';

-- Инженер разрешает (p_allow) или запрещает организации брать цены снабжения тендера — по просьбе или сам. Право —
-- правка «Тендеров» (как «Сделать участником»). Организация должна иметь доступ к тендеру (участник или заявка не отклонена).
CREATE OR REPLACE FUNCTION public.bid_supply_decide(p_tender uuid, p_counterparty uuid, p_allow boolean) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_status text := CASE WHEN p_allow THEN 'granted' ELSE 'denied' END;
BEGIN
  IF NOT public.osp_can('tenders', 'edit') THEN
    RAISE EXCEPTION 'Нет права правки тендеров' USING ERRCODE = '42501';
  END IF;
  IF p_allow IS NULL THEN
    RAISE EXCEPTION 'Не указано решение' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tender_counterparties tc
                 WHERE tc.tender_id = p_tender AND tc.counterparty_id = p_counterparty AND tc.status::text <> 'declined')
     AND NOT EXISTS (SELECT 1 FROM public.tender_bid_requests r
                     WHERE r.tender_id = p_tender AND r.counterparty_id = p_counterparty AND r.status IN ('pending', 'accepted')) THEN
    RAISE EXCEPTION 'Организация не участвует в этом тендере' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.tender_bid_supply_access AS a (tender_id, counterparty_id, status, decided_at, decided_by, decided_by_name, updated_at)
  VALUES (p_tender, p_counterparty, v_status, now(), auth.uid(),
          (SELECT NULLIF(btrim(ur.full_name), '') FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1), now())
  ON CONFLICT (tender_id, counterparty_id) DO UPDATE
    SET status = excluded.status, decided_at = now(), decided_by = excluded.decided_by,
        decided_by_name = excluded.decided_by_name, updated_at = now();
  RETURN v_status;
END
$$;
COMMENT ON FUNCTION public.bid_supply_decide(uuid, uuid, boolean) IS 'Инженер: разрешить или запретить организации брать цены снабжения тендера.';

-- Подрядчики тендеров на сайте — инженеру (раскрытая строка реестра тендеров): у кого есть учётка кабинета и доступ к
-- тендеру (участник или заявка не отклонена), разрешение на цены снабжения, сколько позиций расценено и сколько из них —
-- ценами снабжения. Сами цены не отдаются.
CREATE OR REPLACE FUNCTION public.bid_supply_list(p_tenders uuid[])
RETURNS TABLE (
  tender_id uuid, counterparty_id uuid, counterparty_name text, counterparty_inn text, access text,
  status text, requested_at timestamptz, requested_by_name text, decided_at timestamptz, decided_by_name text,
  priced integer, from_supply integer
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  IF NOT public.osp_can('tenders', 'view') THEN
    RAISE EXCEPTION 'Нет права просмотра тендеров' USING ERRCODE = '42501';
  END IF;
  IF coalesce(cardinality(p_tenders), 0) > 500 THEN
    RAISE EXCEPTION 'Не больше 500 тендеров за раз' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH who AS (
    SELECT tc.tender_id, tc.counterparty_id, 'invited'::text AS access
    FROM public.tender_counterparties tc
    WHERE tc.tender_id = ANY (p_tenders) AND tc.status::text <> 'declined'
      AND EXISTS (SELECT 1 FROM public.user_roles ur
                  WHERE ur.counterparty_id = tc.counterparty_id AND ur.is_approved = true AND ur.is_blocked = false)
    UNION
    SELECT r.tender_id, r.counterparty_id, r.status
    FROM public.tender_bid_requests r
    WHERE r.tender_id = ANY (p_tenders) AND r.status IN ('pending', 'accepted')
      AND NOT EXISTS (SELECT 1 FROM public.tender_counterparties tc WHERE tc.tender_id = r.tender_id AND tc.counterparty_id = r.counterparty_id)
  )
  SELECT w.tender_id, w.counterparty_id, c.name::text, c.inn::text, w.access,
         a.status, a.requested_at, a.requested_by_name, a.decided_at, a.decided_by_name,
         coalesce(n.priced, 0)::integer, coalesce(n.from_supply, 0)::integer
  FROM who w
  JOIN public.counterparties c ON c.id = w.counterparty_id
  LEFT JOIN public.tender_bid_supply_access a ON a.tender_id = w.tender_id AND a.counterparty_id = w.counterparty_id
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE b.price IS NOT NULL) AS priced,
           count(*) FILTER (WHERE b.price IS NOT NULL AND b.source = 'supply') AS from_supply
    FROM public.tender_bid_rates b WHERE b.tender_id = w.tender_id AND b.counterparty_id = w.counterparty_id
  ) n ON true
  ORDER BY w.tender_id, (a.status = 'requested') DESC NULLS LAST, c.name, w.counterparty_id;
END
$$;
COMMENT ON FUNCTION public.bid_supply_list(uuid[]) IS 'Инженер: подрядчики тендеров с учёткой кабинета и их разрешение на цены снабжения (без цен).';

-- Цены снабжения — подрядчику с разрешением, пока идёт приём; сотруднику (просмотр от имени подрядчика) — для указанной
-- организации, тоже только с её разрешением. Без разрешения — пусто.
CREATE OR REPLACE FUNCTION public.bid_supply_prices(p_tender uuid, p_counterparty uuid DEFAULT NULL)
RETURNS TABLE (item_key text, unit_key text, price numeric)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid := public.osp_counterparty_id();
BEGIN
  IF v_cp IS NULL THEN
    IF NOT public.osp_is_employee() THEN
      RAISE EXCEPTION 'Цены снабжения — только подрядчику с разрешением отдела' USING ERRCODE = '42501';
    END IF;
    v_cp := p_counterparty;
  ELSIF coalesce(public.bid_access(p_tender), 'rejected') NOT IN ('invited', 'pending', 'accepted')
        OR NOT public.bid_tender_open(p_tender) THEN
    RETURN;
  END IF;
  IF v_cp IS NULL OR NOT EXISTS (SELECT 1 FROM public.tender_bid_supply_access a
                                 WHERE a.tender_id = p_tender AND a.counterparty_id = v_cp AND a.status = 'granted') THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT x.item_key, x.unit_key, x.price FROM osp_private.bid_supply_price_rows(p_tender) x;
END
$$;
COMMENT ON FUNCTION public.bid_supply_prices(uuid, uuid) IS 'Кабинет подрядчика: цены снабжения материалов тендера (ключ позиции и цена) — только с разрешения отдела.';

-- ── 2. Цены подрядчика: позиции — из разбора ВОР службой ─────────────────────────────────────────────
-- Позиции ВОР тендера по ключу «вид|наименование|ед. изм.» из разбора службы (bid_vor_files), без ведомостей, заменённых
-- новой версией: наименование, ед. изм., объём (сумма по ведомостям). complete — ведомости есть и все разобраны (тогда
-- позиции проверяются у любого подрядчика; иначе — только у учётки с регистрации, как раньше: остальные видят позиции
-- неразобранного файла в браузере). p_keys — только эти ключи (присланные позиции): карта всего тендера на каждое сохранение не нужна.
CREATE OR REPLACE FUNCTION osp_private.bid_known_positions(p_tender uuid, p_keys text[], OUT known jsonb, OUT complete boolean)
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  WITH docs AS (
    SELECT d.id FROM public.s3_documents d
    WHERE d.owner_type = 'tender' AND d.owner_id = p_tender AND d.doc_category IN ('vor_statement', 'vor')
      AND d.file_name ~* '\.(xlsx|xlsm|xls)$'
      AND NOT EXISTS (SELECT 1 FROM public.bid_vor_superseded(p_tender) s WHERE s.file_id = d.id)
  )
  SELECT
    (SELECT coalesce(jsonb_object_agg(x.k, jsonb_build_object('name', x.n, 'unit', x.u, 'volume', x.v)), '{}'::jsonb)
     FROM (
       SELECT p ->> 'key' AS k, min(p ->> 'name') AS n, min(p ->> 'unit') AS u, round(sum((p ->> 'volume')::numeric), 4) AS v
       FROM docs JOIN osp_private.bid_vor_files f ON f.s3_document_id = docs.id AND f.status = 'ok'
       CROSS JOIN LATERAL jsonb_array_elements(f.positions) p
       WHERE coalesce(p ->> 'key', '') <> '' AND p ->> 'key' = ANY (p_keys)
       GROUP BY p ->> 'key'
     ) x),
    EXISTS (SELECT 1 FROM docs)
      AND NOT EXISTS (SELECT 1 FROM docs LEFT JOIN osp_private.bid_vor_files f ON f.s3_document_id = docs.id AND f.status = 'ok'
                      WHERE f.s3_document_id IS NULL)
$$;

-- Цены подрядчика (тело 20261204 + проверка позиций у всех при разобранных ведомостях, объём без заменённых ведомостей,
-- отметка «supply» — только у цены, взятой у снабжения и не изменённой).
CREATE OR REPLACE FUNCTION public.bid_rates_save(p_tender uuid, p_rows jsonb) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid := public.osp_counterparty_id();
  v_check boolean;
  v_known jsonb;
  v_complete boolean;
  v_pos jsonb;
  r record;
  v_price numeric;
  v_note text;
  v_name text;
  v_unit text;
  v_volume numeric;
  v_source text;
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
  SELECT k.known, k.complete INTO v_known, v_complete
  FROM osp_private.bid_known_positions(p_tender, ARRAY(
    SELECT (x ->> 'kind') || '|' || (x ->> 'key') || '|' || coalesce(x ->> 'unit_key', '') FROM jsonb_array_elements(p_rows) x)) k;
  v_check := public.osp_self_registered() OR v_complete;
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
      IF v_check THEN
        v_pos := v_known -> (r.kind || '|' || r.key || '|' || coalesce(r.unit_key, ''));
        IF v_pos IS NULL THEN
          RAISE EXCEPTION 'Позиции нет в ВОР этого тендера — обновите страницу' USING ERRCODE = '22023';
        END IF;
        v_name := v_pos ->> 'name';
        v_unit := NULLIF(btrim(v_pos ->> 'unit'), '');
        v_volume := (v_pos ->> 'volume')::numeric;
      END IF;
      -- «Цена снабжения» ставит только bid_supply_take; здесь отметка остаётся, если цена та же (правили примечание).
      v_source := CASE
        WHEN r.source IN ('manual', 'import', 'history') THEN r.source
        WHEN r.source = 'supply' AND EXISTS (
          SELECT 1 FROM public.tender_bid_rates b
          WHERE b.tender_id = p_tender AND b.counterparty_id = v_cp AND b.kind = r.kind AND b.item_key = r.key
            AND b.unit_key = coalesce(r.unit_key, '') AND b.source = 'supply' AND b.price = v_price) THEN 'supply'
        ELSE 'manual' END;
      INSERT INTO public.tender_bid_rates AS b
        (tender_id, counterparty_id, kind, item_key, unit_key, name, unit, volume, price, total, note, source, updated_by)
      VALUES (p_tender, v_cp, r.kind, r.key, coalesce(r.unit_key, ''), v_name, v_unit, v_volume,
              v_price, round(v_price * coalesce(v_volume, 0), 2), v_note, v_source, auth.uid())
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

-- Отметка источника «цена снабжения».
ALTER TABLE public.tender_bid_rates DROP CONSTRAINT IF EXISTS tender_bid_rates_source_check;
ALTER TABLE public.tender_bid_rates ADD CONSTRAINT tender_bid_rates_source_check
  CHECK (source IN ('manual', 'import', 'history', 'supply'));

-- Подрядчик берёт цены снабжения: p_rows — [{ key, unit_key, name, unit, volume }] материалов (до 2000). Цену берёт база;
-- нет цены снабжения у позиции — пропуск. Своя цена (не снабжения) заменяется только при p_replace. Примечание остаётся.
-- Ответ — сколько цен записано.
CREATE OR REPLACE FUNCTION public.bid_supply_take(p_tender uuid, p_rows jsonb, p_replace boolean DEFAULT false) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid := public.osp_counterparty_id();
  v_prices jsonb;
  v_known jsonb;
  v_complete boolean;
  v_check boolean;
  v_pos jsonb;
  r record;
  v_price numeric;
  v_name text;
  v_unit text;
  v_volume numeric;
  v_n integer := 0;
BEGIN
  IF v_cp IS NULL THEN
    RAISE EXCEPTION 'Цены снабжения берёт подрядчик' USING ERRCODE = '42501';
  END IF;
  IF NOT public.bid_can_edit(p_tender) THEN
    RAISE EXCEPTION 'Расценка этого тендера закрыта' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tender_bid_supply_access a
                 WHERE a.tender_id = p_tender AND a.counterparty_id = v_cp AND a.status = 'granted') THEN
    RAISE EXCEPTION 'Отдел не разрешил брать цены снабжения в этом тендере' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) > 2000 THEN
    RAISE EXCEPTION 'Неверный список позиций (не больше 2000 за раз)' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(jsonb_object_agg(x.item_key || '|' || x.unit_key, x.price), '{}'::jsonb) INTO v_prices
  FROM osp_private.bid_supply_price_rows(p_tender) x;
  SELECT k.known, k.complete INTO v_known, v_complete
  FROM osp_private.bid_known_positions(p_tender, ARRAY(
    SELECT 'material|' || (x ->> 'key') || '|' || coalesce(x ->> 'unit_key', '') FROM jsonb_array_elements(p_rows) x)) k;
  v_check := public.osp_self_registered() OR v_complete;
  FOR r IN SELECT * FROM jsonb_to_recordset(p_rows) AS x(key text, unit_key text, name text, unit text, volume numeric)
  LOOP
    IF coalesce(btrim(r.key), '') = '' OR coalesce(btrim(r.name), '') = '' THEN
      RAISE EXCEPTION 'Позиция без ключа или наименования' USING ERRCODE = '22023';
    END IF;
    v_price := (v_prices ->> (r.key || '|' || coalesce(r.unit_key, '')))::numeric;
    CONTINUE WHEN v_price IS NULL;
    v_name := btrim(r.name);
    v_unit := NULLIF(btrim(r.unit), '');
    v_volume := r.volume;
    IF v_check THEN
      v_pos := v_known -> ('material|' || r.key || '|' || coalesce(r.unit_key, ''));
      CONTINUE WHEN v_pos IS NULL;
      v_name := v_pos ->> 'name';
      v_unit := NULLIF(btrim(v_pos ->> 'unit'), '');
      v_volume := (v_pos ->> 'volume')::numeric;
    END IF;
    CONTINUE WHEN NOT p_replace AND EXISTS (
      SELECT 1 FROM public.tender_bid_rates b
      WHERE b.tender_id = p_tender AND b.counterparty_id = v_cp AND b.kind = 'material' AND b.item_key = r.key
        AND b.unit_key = coalesce(r.unit_key, '') AND b.price IS NOT NULL AND b.source <> 'supply');
    INSERT INTO public.tender_bid_rates AS b
      (tender_id, counterparty_id, kind, item_key, unit_key, name, unit, volume, price, total, note, source, updated_by)
    VALUES (p_tender, v_cp, 'material', r.key, coalesce(r.unit_key, ''), v_name, v_unit, v_volume,
            v_price, round(v_price * coalesce(v_volume, 0), 2), NULL, 'supply', auth.uid())
    ON CONFLICT (tender_id, counterparty_id, kind, item_key, unit_key) DO UPDATE
      SET name = excluded.name, unit = excluded.unit, volume = excluded.volume, price = excluded.price,
          total = excluded.total, source = 'supply', updated_at = now(), updated_by = excluded.updated_by;
    v_n := v_n + 1;
  END LOOP;
  IF (SELECT count(*) FROM public.tender_bid_rates WHERE tender_id = p_tender AND counterparty_id = v_cp) > 20000 THEN
    RAISE EXCEPTION 'Слишком много позиций в расценке (больше 20 000)' USING ERRCODE = '22023';
  END IF;
  RETURN v_n;
END
$$;
COMMENT ON FUNCTION public.bid_supply_take(uuid, jsonb, boolean) IS 'Кабинет подрядчика: взять цены снабжения для своих позиций (цену берёт база).';

-- ── 3. Что изменилось в ВОР ──────────────────────────────────────────────────────────────────────────
-- Разбор удалённого файла ВОР (позиции без структуры) — в архив, перед удалением строки файла: по нему подрядчик видит,
-- что изменилось в новой версии ведомости. Хранится год.
CREATE TABLE IF NOT EXISTS osp_private.bid_vor_archive (
  s3_document_id uuid PRIMARY KEY,
  tender_id uuid NOT NULL REFERENCES public.tenders(id) ON DELETE CASCADE,
  title text NOT NULL,
  doc_created_at timestamptz,
  positions jsonb NOT NULL DEFAULT '[]'::jsonb,
  archived_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bid_vor_archive_tender_idx ON osp_private.bid_vor_archive (tender_id, archived_at DESC);
COMMENT ON TABLE osp_private.bid_vor_archive IS 'Позиции удалённых файлов ВОР (разбор службы) — прежние версии ведомостей для кабинета подрядчика';

-- Позиции разбора — только то, что нужно для сравнения версий.
CREATE OR REPLACE FUNCTION osp_private.bid_slim_positions(p_positions jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE
  SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind', p -> 'kind', 'key', p -> 'key', 'itemKey', p -> 'itemKey',
                                               'unitKey', p -> 'unitKey', 'name', p -> 'name', 'unit', p -> 'unit',
                                               'volume', p -> 'volume') ORDER BY o), '[]'::jsonb)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_positions) = 'array' THEN p_positions ELSE '[]'::jsonb END)
       WITH ORDINALITY AS t(p, o)
$$;

CREATE OR REPLACE FUNCTION osp_private.bid_vor_archive_keep() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO osp_private.bid_vor_archive (s3_document_id, tender_id, title, doc_created_at, positions)
  SELECT OLD.id, f.tender_id, regexp_replace(OLD.file_name, '\.(xlsx|xlsm|xls)$', '', 'i'), OLD.created_at,
         osp_private.bid_slim_positions(f.positions)
  FROM osp_private.bid_vor_files f
  WHERE f.s3_document_id = OLD.id AND f.status = 'ok'
    AND EXISTS (SELECT 1 FROM public.tenders t WHERE t.id = f.tender_id)
  ON CONFLICT (s3_document_id) DO NOTHING;
  DELETE FROM osp_private.bid_vor_archive WHERE archived_at < now() - interval '1 year';
  RETURN OLD;
END
$$;
DROP TRIGGER IF EXISTS s3_documents_bid_vor_archive ON public.s3_documents;
CREATE TRIGGER s3_documents_bid_vor_archive
  BEFORE DELETE ON public.s3_documents
  FOR EACH ROW
  WHEN (OLD.owner_type = 'tender' AND OLD.doc_category IN ('vor_statement', 'vor'))
  EXECUTE FUNCTION osp_private.bid_vor_archive_keep();

-- По строке на актуальную ведомость тендера (как bid_positions): когда загружена, что о ней знает снабжение и её прежняя версия.
--   tracked — у снабжения есть список позиций этого файла; separate — снабжение ответило «отдельный ВОР, не новая версия»;
--   valuable — у этого ВОР есть цены снабжения (о новой версии такого ВОР снабжение спрашивают — кабинет ждёт ответа);
--   prior_* — прежняя версия: файл из отметки снабжения (prior_document_ids), из версий ВОР снабжения или удалённый файл с тем же
--   именем; только заменённая или удалённая и раньше этой; позиции — её разбор (вид, ключи, наименование, ед. изм., объём).
-- Подрядчику — при доступе к тендеру (как bid_positions); сотруднику — для просмотра от имени подрядчика. Цен нет.
CREATE OR REPLACE FUNCTION public.bid_vor_changes(p_tender uuid)
RETURNS TABLE (file_id uuid, created_at timestamptz, tracked boolean, separate boolean, valuable boolean,
               prior_id uuid, prior_title text, prior_at timestamptz, positions jsonb)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_access text;
BEGIN
  IF public.osp_counterparty_id() IS NULL THEN
    IF NOT public.osp_is_employee() THEN
      RAISE EXCEPTION 'Изменения ВОР — только для подрядчика' USING ERRCODE = '42501';
    END IF;
  ELSE
    v_access := public.bid_access(p_tender);
    IF v_access IS NULL OR v_access = 'rejected' OR (public.osp_self_registered() AND NOT public.bid_tender_open(p_tender)) THEN
      RETURN;
    END IF;
  END IF;
  RETURN QUERY
  WITH sup AS MATERIALIZED (SELECT s.file_id FROM public.bid_vor_superseded(p_tender) s),
  cur AS (
    SELECT d.id, d.created_at, lower(btrim(regexp_replace(d.file_name, '\.(xlsx|xlsm|xls)$', '', 'i'))) AS title_key,
           s.estimate_name, s.prior_document_ids, s.separate_at, s.id IS NOT NULL AS tracked
    FROM public.s3_documents d
    LEFT JOIN LATERAL (SELECT x.* FROM public.tender_supply_sources x
                       WHERE x.tender_id = p_tender AND x.s3_document_id = d.id ORDER BY x.updated_at DESC LIMIT 1) s ON true
    WHERE d.owner_type = 'tender' AND d.owner_id = p_tender AND d.doc_category IN ('vor_statement', 'vor')
      AND d.file_name ~* '\.(xlsx|xlsm|xls)$'
      AND NOT EXISTS (SELECT 1 FROM sup WHERE sup.file_id = d.id)
  )
  SELECT c.id, c.created_at, c.tracked, c.separate_at IS NOT NULL,
         c.estimate_name IS NOT NULL AND EXISTS (SELECT 1 FROM public.tender_vor_supply_rates r
                                                 WHERE r.tender_id = p_tender AND r.estimate_name = c.estimate_name),
         pr.id, pr.title, pr.at, pr.positions
  FROM cur c
  LEFT JOIN LATERAL (
    WITH cand AS (
      SELECT x.id FROM unnest(coalesce(c.prior_document_ids, '{}'::uuid[])) AS x(id)
      UNION
      SELECT r.old_document_id FROM public.tender_supply_revisions r
      WHERE r.tender_id = p_tender AND c.estimate_name IS NOT NULL AND r.estimate_name = c.estimate_name AND r.old_document_id IS NOT NULL
      UNION
      SELECT a.s3_document_id FROM osp_private.bid_vor_archive a
      WHERE a.tender_id = p_tender AND lower(btrim(a.title)) = c.title_key
    ),
    found AS (
      SELECT d.id, regexp_replace(d.file_name, '\.(xlsx|xlsm|xls)$', '', 'i') AS title, d.created_at AS at,
             osp_private.bid_slim_positions(f.positions) AS positions
      FROM cand JOIN public.s3_documents d ON d.id = cand.id AND d.owner_type = 'tender' AND d.owner_id = p_tender
      JOIN osp_private.bid_vor_files f ON f.s3_document_id = d.id AND f.status = 'ok'
      WHERE EXISTS (SELECT 1 FROM sup WHERE sup.file_id = d.id)
      UNION ALL
      SELECT a.s3_document_id, a.title, coalesce(a.doc_created_at, a.archived_at), a.positions
      FROM cand JOIN osp_private.bid_vor_archive a ON a.s3_document_id = cand.id AND a.tender_id = p_tender
    )
    SELECT found.* FROM found
    WHERE found.id <> c.id AND found.at < c.created_at
    ORDER BY found.at DESC, found.id
    LIMIT 1
  ) pr ON true
  ORDER BY c.created_at DESC, c.id;
END
$$;
COMMENT ON FUNCTION public.bid_vor_changes(uuid) IS
  'Кабинет подрядчика: актуальные ведомости тендера — что о них знает снабжение и позиции прежней версии (без цен).';

-- ── 4. Граница кабинета ─────────────────────────────────────────────────────────────────────────────
-- Организация заблокированной учётки — как в 20261010 (условие потерялось в 20261204).
CREATE OR REPLACE FUNCTION public.current_counterparty_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT ur.counterparty_id
  FROM public.user_roles ur
  WHERE ur.user_id = auth.uid() AND ur.is_approved = true AND ur.is_blocked = false AND NOT ur.self_registered
  LIMIT 1
$$;

-- Файлы подрядчику (тело 20261204): только тендерный пакет, ВОР и РД своих тендеров, по заявке — пока идёт приём. Файлов
-- договоров нет: раздела договоров в кабинете нет, а среди файлов договора есть внутренние (понятийное соглашение).
DROP POLICY IF EXISTS portal_contractor_select ON public.s3_documents;
CREATE POLICY portal_contractor_select ON public.s3_documents FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated')) AND NOT (SELECT public.osp_self_registered())
                    AND owner_type = 'tender'
                    AND doc_category IN ('tender_package', 'vor', 'rd', 'vor_statement')
                    AND (public.is_my_tender(owner_id)
                         OR ((SELECT public.osp_counterparty_id()) IS NOT NULL AND public.bid_access(owner_id) IN ('pending', 'accepted')
                             AND public.bid_tender_open(owner_id)))) END);
COMMENT ON POLICY portal_contractor_select ON public.s3_documents IS
  'Подрядчик от администратора: тендерный пакет, ВОР и РД своих тендеров и идущих тендеров с заявкой. Файлов договоров и учётке с регистрации — нет.';
INSERT INTO osp_meta.policy_roles VALUES ('public', 's3_documents', 'portal_contractor_select', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;

-- ── 5. Реестр расценок: без цен снабжения и отклонённых заявок ─────────────────────────────────────────
-- Определение и подмена — как в 20261204 (пересоздаётся рядом), у цен с сайта два новых условия.
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
    -- Цена, взятая у снабжения, — не цена подрядчика; заявка отклонена и участником не сделан — его цен в реестре нет (20270301).
    AND b.source <> 'supply'
    AND (NOT EXISTS (SELECT 1 FROM public.tender_bid_requests rq
                     WHERE rq.tender_id = b.tender_id AND rq.counterparty_id = b.counterparty_id AND rq.status = 'rejected')
         OR EXISTS (SELECT 1 FROM public.tender_counterparties tc WHERE tc.tender_id = b.tender_id AND tc.counterparty_id = b.counterparty_id))
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
COMMENT ON MATERIALIZED VIEW osp_private.kp_rates_registry_mv IS 'Реестр расценок из КП подрядчиков (с ВОР и файлом КП) и цен с сайта завершённых тендеров (без цен снабжения и отклонённых заявок; дедуп по DISTINCT ON). Обновляется refresh_rates_registry()';
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

-- ── 6. Список шлюза ──────────────────────────────────────────────────────────────────────────────────
-- Подрядчику (allow-contractor.json / allow-self-contractor.json) — разрешение (чтение своей строки), bid_supply_prices,
-- bid_supply_request, bid_supply_take, bid_vor_changes; инженеру — bid_supply_decide, bid_supply_list.
-- osp:allow table tender_bid_supply_access authenticated=select
-- osp:allow rpc bid_supply_prices authenticated
-- osp:allow rpc bid_supply_request authenticated
-- osp:allow rpc bid_supply_take authenticated
-- osp:allow rpc bid_supply_decide authenticated
-- osp:allow rpc bid_supply_list authenticated
-- osp:allow rpc bid_vor_changes authenticated
