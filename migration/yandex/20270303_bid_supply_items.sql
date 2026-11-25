-- Цены снабжения подрядчику — по позициям, решает инженер ОСП (решение пользователя 25.11.2026: «перенести в тендеры на материалы,
-- видимость только у инженеров (ну и админов), по каждой позиции давать доступ вручную (ну или маленькую кнопку — на все сразу),
-- запрос цены подрядчиком оставить»). Только база Яндекса (прежний портал на Supabase только читается).
--  • tender_bid_supply_items — какие позиции (ключ материала и ед. изм.) отдел открыл организации. Цены снабжения подрядчику
--    (bid_supply_prices), «взять» (bid_supply_take) и счета к взятым ценам (bid_supply_docs / bid_supply_doc_file через
--    osp_private.bid_supply_doc_rows) — только по открытым позициям: общий источник osp_private.bid_supply_open_rows.
--    Разрешение без позиций ничего не открывает;
--  • bid_supply_grant — инженер открывает выбранные позиции (набор заменяется целиком) или все нынешние позиции с ценой снабжения
--    (p_all, список берёт база — новые цены снабжения потом сами не открываются); bid_supply_items — позиции тендера с ценой
--    снабжения и отметка «открыта» для окна инженера;
--  • bid_supply_decide: «разрешить» тендер целиком больше нельзя (прежняя кнопка в реестре тендеров основного строительства, пока
--    вкладку не обновили, получит отказ, а не откроет всё); «запретить» закрывает и все позиции;
--  • решает только инженер ОСП (роль engineer) или администратор — osp_supply_engineer(): bid_supply_list, bid_supply_decide, новые
--    функции и чтение tender_bid_supply_access сотрудником (раньше — любой с правом «Тендеров»). Подрядчик по-прежнему читает свою
--    строку и просит (bid_supply_request не меняется).
-- Разрешений с отметкой «granted» на 25.11 нет (одна просьба ждёт), поэтому открытых позиций миграция не заводит: разрешение без
-- позиций после неё ничего не отдаёт, пока инженер не отметит позиции. Повтор безопасен. Нужны 20270301 и 20270302.

-- ── 1. Кто решает ────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.osp_supply_engineer() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
  SELECT public.is_admin() OR EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid() AND ur.role = 'engineer' AND ur.is_approved = true AND ur.is_blocked = false
      AND ur.counterparty_id IS NULL)
$$;
COMMENT ON FUNCTION public.osp_supply_engineer() IS
  'Цены снабжения подрядчикам решает инженер ОСП (роль engineer) или администратор (решение пользователя 25.11.2026).';

-- Строку разрешения сотрудник читает, только если решает (счётчик просьб и блок в «Тендерах на материалы», просмотр от имени
-- подрядчика у администратора); подрядчик — свою.
DROP POLICY IF EXISTS tender_bid_supply_access_read ON public.tender_bid_supply_access;
CREATE POLICY tender_bid_supply_access_read ON public.tender_bid_supply_access FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated'))
                    AND ((SELECT public.osp_supply_engineer()) OR counterparty_id = (SELECT public.osp_counterparty_id()))) END);
INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'tender_bid_supply_access', 'tender_bid_supply_access_read', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;

-- ── 2. Открытые позиции ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tender_bid_supply_items (
  tender_id uuid NOT NULL,
  counterparty_id uuid NOT NULL,
  item_key text NOT NULL,
  unit_key text NOT NULL DEFAULT '',
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid,
  PRIMARY KEY (tender_id, counterparty_id, item_key, unit_key),
  FOREIGN KEY (tender_id, counterparty_id) REFERENCES public.tender_bid_supply_access (tender_id, counterparty_id) ON DELETE CASCADE
);
COMMENT ON TABLE public.tender_bid_supply_items IS
  'Кабинет подрядчика: позиции (ключ материала и ед. изм.), цену снабжения которых отдел открыл организации. Пишет и читает только bid_supply_*';

ALTER TABLE public.tender_bid_supply_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tender_bid_supply_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS osp_internal ON public.tender_bid_supply_items;
CREATE POLICY osp_internal ON public.tender_bid_supply_items FOR ALL TO PUBLIC
  USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()));

-- Цены снабжения, открытые организации p_cp: разрешение отдела и отмеченная позиция. Единственный источник для всего, что видит
-- подрядчик (цены, «взять», счета). Служебная: вызывают только функции с пропуском.
CREATE OR REPLACE FUNCTION osp_private.bid_supply_open_rows(p_tender uuid, p_cp uuid)
RETURNS TABLE (item_key text, unit_key text, price numeric)
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  SELECT x.item_key, x.unit_key, x.price
  FROM osp_private.bid_supply_price_rows(p_tender) x
  WHERE EXISTS (SELECT 1 FROM public.tender_bid_supply_access a
                WHERE a.tender_id = p_tender AND a.counterparty_id = p_cp AND a.status = 'granted')
    AND EXISTS (SELECT 1 FROM public.tender_bid_supply_items i
                WHERE i.tender_id = p_tender AND i.counterparty_id = p_cp AND i.item_key = x.item_key AND i.unit_key = x.unit_key)
$$;

-- ── 3. Подрядчику — только открытые позиции ──────────────────────────────────────────────────────────
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
  RETURN QUERY SELECT x.item_key, x.unit_key, x.price FROM osp_private.bid_supply_open_rows(p_tender, v_cp) x
    ORDER BY x.item_key, x.unit_key;
END
$$;
COMMENT ON FUNCTION public.bid_supply_prices(uuid, uuid) IS
  'Кабинет подрядчика: цены снабжения материалов тендера (ключ позиции и цена) — только позиции, которые открыл отдел.';

-- Взять цены снабжения: как в 20270301, цены — только открытых позиций.
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
  FROM osp_private.bid_supply_open_rows(p_tender, v_cp) x;
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
COMMENT ON FUNCTION public.bid_supply_take(uuid, jsonb, boolean) IS
  'Кабинет подрядчика: взять цены снабжения для своих позиций (цену берёт база) — только позиции, которые открыл отдел.';

-- Счета к взятым ценам (20270302) — тоже только по открытым позициям: позицию закрыли — счёт пропадает вместе с ценой снабжения.
CREATE OR REPLACE FUNCTION osp_private.bid_supply_doc_rows(p_tender uuid, p_cp uuid)
RETURNS TABLE (item_key text, unit_key text, document_id uuid)
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  WITH taken AS (
    SELECT b.item_key, b.unit_key
    FROM public.tender_bid_rates b
    JOIN osp_private.bid_supply_open_rows(p_tender, p_cp) x
      ON x.item_key = b.item_key AND x.unit_key = b.unit_key AND x.price = b.price
    WHERE b.tender_id = p_tender AND b.counterparty_id = p_cp AND b.kind = 'material' AND b.source = 'supply'
  ),
  rates AS (
    SELECT t.item_key, t.unit_key, r.estimate_name, r.material_key, r.source_rate_id
    FROM taken t
    JOIN public.tender_vor_supply_rates r
      ON r.tender_id = p_tender AND r.material_key = t.item_key AND public.kp_norm_unit(coalesce(r.unit, '')) = t.unit_key
    WHERE r.supply_price > 0
      AND (NOT EXISTS (SELECT 1 FROM public.tender_supply_sources s WHERE s.tender_id = p_tender)
           OR r.estimate_name IN (SELECT s.estimate_name FROM public.tender_supply_sources s WHERE s.tender_id = p_tender))
  )
  SELECT DISTINCT r.item_key, r.unit_key, coalesce(own.s3_document_id, src.s3_document_id)
  FROM rates r
  LEFT JOIN public.tender_supply_links own
    ON own.tender_id = p_tender AND own.estimate_name = r.estimate_name AND own.material_key = r.material_key
  LEFT JOIN public.tender_vor_supply_rates s ON s.id = r.source_rate_id AND own.id IS NULL
  LEFT JOIN public.tender_supply_links src
    ON src.tender_id = s.tender_id AND src.estimate_name = s.estimate_name AND src.material_key = s.material_key
  WHERE coalesce(own.s3_document_id, src.s3_document_id) IS NOT NULL
$$;

-- ── 4. Инженеру ──────────────────────────────────────────────────────────────────────────────────────
-- Организация должна иметь доступ к тендеру (участник или заявка не отклонена) — как в 20270301.
CREATE OR REPLACE FUNCTION osp_private.bid_supply_member(p_tender uuid, p_counterparty uuid) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.tender_counterparties tc
                 WHERE tc.tender_id = p_tender AND tc.counterparty_id = p_counterparty AND tc.status::text <> 'declined')
      OR EXISTS (SELECT 1 FROM public.tender_bid_requests r
                 WHERE r.tender_id = p_tender AND r.counterparty_id = p_counterparty AND r.status IN ('pending', 'accepted'))
$$;

-- Запретить (p_allow = false): разрешение «запрещено», открытые позиции закрываются. Разрешить тендер целиком нельзя — только
-- позиции (bid_supply_grant).
CREATE OR REPLACE FUNCTION public.bid_supply_decide(p_tender uuid, p_counterparty uuid, p_allow boolean) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  IF NOT public.osp_supply_engineer() THEN
    RAISE EXCEPTION 'Цены снабжения подрядчикам решает инженер ОСП' USING ERRCODE = '42501';
  END IF;
  IF p_allow IS NULL THEN
    RAISE EXCEPTION 'Не указано решение' USING ERRCODE = '22023';
  END IF;
  IF p_allow THEN
    RAISE EXCEPTION 'Цены снабжения открываются по позициям — в «Тендерах на материалы». Обновите страницу'
      USING ERRCODE = '22023';
  END IF;
  IF NOT osp_private.bid_supply_member(p_tender, p_counterparty) THEN
    RAISE EXCEPTION 'Организация не участвует в этом тендере' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.tender_bid_supply_access AS a (tender_id, counterparty_id, status, decided_at, decided_by, decided_by_name, updated_at)
  VALUES (p_tender, p_counterparty, 'denied', now(), auth.uid(),
          (SELECT NULLIF(btrim(ur.full_name), '') FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1), now())
  ON CONFLICT (tender_id, counterparty_id) DO UPDATE
    SET status = 'denied', decided_at = now(), decided_by = excluded.decided_by,
        decided_by_name = excluded.decided_by_name, updated_at = now();
  DELETE FROM public.tender_bid_supply_items i WHERE i.tender_id = p_tender AND i.counterparty_id = p_counterparty;
  RETURN 'denied';
END
$$;
COMMENT ON FUNCTION public.bid_supply_decide(uuid, uuid, boolean) IS
  'Инженер ОСП: запретить организации брать цены снабжения тендера (открытые позиции закрываются). Разрешение — по позициям, bid_supply_grant.';

-- Открыть организации позиции: p_items — [{ key, unit_key }] (набор заменяется целиком; позиции без единой цены снабжения
-- пропускаются), p_all — все нынешние позиции с ценой снабжения (список берёт база). Есть хоть одна — «разрешено», ни одной —
-- «запрещено». Ответ — сколько позиций открыто.
CREATE OR REPLACE FUNCTION public.bid_supply_grant(p_tender uuid, p_counterparty uuid, p_items jsonb DEFAULT '[]'::jsonb,
                                                   p_all boolean DEFAULT false) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_keys text[];
  v_units text[];
  v_n integer;
BEGIN
  IF NOT public.osp_supply_engineer() THEN
    RAISE EXCEPTION 'Цены снабжения подрядчикам решает инженер ОСП' USING ERRCODE = '42501';
  END IF;
  IF NOT coalesce(p_all, false)
     AND (jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) > 20000) THEN
    RAISE EXCEPTION 'Неверный список позиций (не больше 20 000)' USING ERRCODE = '22023';
  END IF;
  IF NOT osp_private.bid_supply_member(p_tender, p_counterparty) THEN
    RAISE EXCEPTION 'Организация не участвует в этом тендере' USING ERRCODE = 'P0002';
  END IF;

  -- Набор открытых позиций — только из позиций с ценой снабжения (ключи из браузера сами ничего не добавят).
  SELECT coalesce(array_agg(x.item_key), '{}'), coalesce(array_agg(x.unit_key), '{}') INTO v_keys, v_units
  FROM osp_private.bid_supply_price_rows(p_tender) x
  WHERE coalesce(p_all, false)
     OR EXISTS (SELECT 1 FROM jsonb_to_recordset(CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END)
                  AS j(key text, unit_key text)
                WHERE j.key = x.item_key AND coalesce(j.unit_key, '') = x.unit_key);
  v_n := cardinality(v_keys);

  INSERT INTO public.tender_bid_supply_access AS a (tender_id, counterparty_id, status, decided_at, decided_by, decided_by_name, updated_at)
  VALUES (p_tender, p_counterparty, CASE WHEN v_n > 0 THEN 'granted' ELSE 'denied' END, now(), auth.uid(),
          (SELECT NULLIF(btrim(ur.full_name), '') FROM public.user_roles ur WHERE ur.user_id = auth.uid() LIMIT 1), now())
  ON CONFLICT (tender_id, counterparty_id) DO UPDATE
    SET status = excluded.status, decided_at = now(), decided_by = excluded.decided_by,
        decided_by_name = excluded.decided_by_name, updated_at = now();
  DELETE FROM public.tender_bid_supply_items i
  WHERE i.tender_id = p_tender AND i.counterparty_id = p_counterparty
    AND NOT EXISTS (SELECT 1 FROM unnest(v_keys, v_units) AS k(item_key, unit_key)
                    WHERE k.item_key = i.item_key AND k.unit_key = i.unit_key);
  INSERT INTO public.tender_bid_supply_items (tender_id, counterparty_id, item_key, unit_key, granted_at, granted_by)
  SELECT p_tender, p_counterparty, k.item_key, k.unit_key, now(), auth.uid() FROM unnest(v_keys, v_units) AS k(item_key, unit_key)
  ON CONFLICT (tender_id, counterparty_id, item_key, unit_key) DO NOTHING;
  RETURN v_n;
END
$$;
COMMENT ON FUNCTION public.bid_supply_grant(uuid, uuid, jsonb, boolean) IS
  'Инженер ОСП: открыть организации цены снабжения выбранных позиций (или всех нынешних, p_all) — набор заменяется целиком.';

-- Позиции тендера с ценой снабжения для окна инженера: наименование и ед. изм. (как у снабжения), цена, в скольких ВОР, открыта ли
-- организации, взял ли подрядчик эту цену. Только позиции, у которых цена одна во всех ВОР (другие подрядчику не отдаются).
CREATE OR REPLACE FUNCTION public.bid_supply_items(p_tender uuid, p_counterparty uuid)
RETURNS TABLE (item_key text, unit_key text, name text, unit text, price numeric, vors integer, granted boolean, taken boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  IF NOT public.osp_supply_engineer() THEN
    RAISE EXCEPTION 'Цены снабжения подрядчикам решает инженер ОСП' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH p AS (SELECT x.item_key AS k, x.unit_key AS u, x.price AS pr FROM osp_private.bid_supply_price_rows(p_tender) x),
  n AS (
    SELECT r.material_key AS k, public.kp_norm_unit(coalesce(r.unit, '')) AS u, min(r.material_name) AS nm, min(r.unit) AS un,
           count(DISTINCT r.estimate_name) AS cnt
    FROM public.tender_vor_supply_rates r
    WHERE r.tender_id = p_tender AND r.supply_price > 0 AND coalesce(r.material_key, '') <> ''
    GROUP BY 1, 2
  )
  SELECT p.k, p.u, coalesce(n.nm, p.k)::text, n.un::text, p.pr, coalesce(n.cnt, 0)::integer,
         EXISTS (SELECT 1 FROM public.tender_bid_supply_items i
                 WHERE i.tender_id = p_tender AND i.counterparty_id = p_counterparty AND i.item_key = p.k AND i.unit_key = p.u),
         EXISTS (SELECT 1 FROM public.tender_bid_rates b
                 WHERE b.tender_id = p_tender AND b.counterparty_id = p_counterparty AND b.kind = 'material'
                   AND b.item_key = p.k AND b.unit_key = p.u AND b.source = 'supply' AND b.price = p.pr)
  FROM p LEFT JOIN n ON n.k = p.k AND n.u = p.u
  ORDER BY coalesce(n.nm, p.k), p.k, p.u;
END
$$;
COMMENT ON FUNCTION public.bid_supply_items(uuid, uuid) IS
  'Инженер ОСП: позиции тендера с ценой снабжения и открыты ли они организации (окно «Цены снабжения подрядчику»).';

-- Подрядчики тендеров на сайте — инженеру: как в 20270301 и ещё сколько позиций открыто и сколько всего с ценой снабжения.
DROP FUNCTION IF EXISTS public.bid_supply_list(uuid[]);
CREATE FUNCTION public.bid_supply_list(p_tenders uuid[])
RETURNS TABLE (
  tender_id uuid, counterparty_id uuid, counterparty_name text, counterparty_inn text, access text,
  status text, requested_at timestamptz, requested_by_name text, decided_at timestamptz, decided_by_name text,
  priced integer, from_supply integer, granted_items integer, supply_items integer
)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  IF NOT public.osp_supply_engineer() THEN
    RAISE EXCEPTION 'Цены снабжения подрядчикам решает инженер ОСП' USING ERRCODE = '42501';
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
  ),
  offer AS (
    SELECT t.id AS tid, (SELECT count(*) FROM osp_private.bid_supply_price_rows(t.id)) AS cnt
    FROM (SELECT DISTINCT w.tender_id AS id FROM who w) t
  )
  SELECT w.tender_id, w.counterparty_id, c.name::text, c.inn::text, w.access,
         a.status, a.requested_at, a.requested_by_name, a.decided_at, a.decided_by_name,
         coalesce(n.priced, 0)::integer, coalesce(n.from_supply, 0)::integer,
         (SELECT count(*) FROM public.tender_bid_supply_items i
          WHERE i.tender_id = w.tender_id AND i.counterparty_id = w.counterparty_id)::integer,
         coalesce(o.cnt, 0)::integer
  FROM who w
  JOIN public.counterparties c ON c.id = w.counterparty_id
  LEFT JOIN offer o ON o.tid = w.tender_id
  LEFT JOIN public.tender_bid_supply_access a ON a.tender_id = w.tender_id AND a.counterparty_id = w.counterparty_id
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE b.price IS NOT NULL) AS priced,
           count(*) FILTER (WHERE b.price IS NOT NULL AND b.source = 'supply') AS from_supply
    FROM public.tender_bid_rates b WHERE b.tender_id = w.tender_id AND b.counterparty_id = w.counterparty_id
  ) n ON true
  ORDER BY w.tender_id, (a.status = 'requested') DESC NULLS LAST, c.name, w.counterparty_id;
END
$$;
COMMENT ON FUNCTION public.bid_supply_list(uuid[]) IS
  'Инженер ОСП: подрядчики тендеров с учёткой кабинета, их разрешение на цены снабжения и сколько позиций открыто (без цен).';

-- ── 5. Список шлюза ──────────────────────────────────────────────────────────────────────────────────
-- Сотруднику (allow.json, правка «Тендеров»; функции сами пускают только инженера ОСП и администратора) — bid_supply_grant,
-- bid_supply_items. Подрядчику новых функций нет; таблицы tender_bid_supply_items в шлюзе нет.
-- osp:allow rpc bid_supply_grant authenticated
-- osp:allow rpc bid_supply_items authenticated
