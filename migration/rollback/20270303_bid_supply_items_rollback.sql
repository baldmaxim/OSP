-- АВАРИЙНЫЙ ОТКАТ 20270303_bid_supply_items (только база Яндекса): цены снабжения подрядчику снова «разрешено — весь тендер»,
-- решает любой с правом правки «Тендеров» (тела функций и правило чтения — из 20270301, счета — из 20270302). Чтобы откат не открыл
-- подрядчику больше, чем отметил инженер, все разрешения «granted» становятся просьбами («requested»): решение — заново, прежним
-- блоком реестра тендеров (код до 20270303). Таблица tender_bid_supply_items и её строки остаются (вернуть миграцию — без потерь).
-- Строка миграции в osp_meta.schema_migrations остаётся (как у других откатов). Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL application_name = 'osp:internal';

DROP FUNCTION IF EXISTS public.bid_supply_grant(uuid, uuid, jsonb, boolean);
DROP FUNCTION IF EXISTS public.bid_supply_items(uuid, uuid);
DROP FUNCTION IF EXISTS public.bid_supply_list(uuid[]);

UPDATE public.tender_bid_supply_access SET status = 'requested', requested_at = coalesce(requested_at, decided_at, now()), updated_at = now()
WHERE status = 'granted';

-- Правило чтения — 20270301 (любой сотрудник или своя организация).
DROP POLICY IF EXISTS tender_bid_supply_access_read ON public.tender_bid_supply_access;
CREATE POLICY tender_bid_supply_access_read ON public.tender_bid_supply_access FOR SELECT TO PUBLIC
  USING (CASE WHEN (SELECT osp_private.bypass()) THEN true
              ELSE ((SELECT osp_private.role_in('authenticated'))
                    AND ((SELECT public.osp_is_employee()) OR counterparty_id = (SELECT public.osp_counterparty_id()))) END);
INSERT INTO osp_meta.policy_roles VALUES
  ('public', 'tender_bid_supply_access', 'tender_bid_supply_access_read', ARRAY['authenticated'])
ON CONFLICT (schema_name, table_name, policy_name) DO UPDATE SET roles = EXCLUDED.roles;

-- Тела 20270301.
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

-- Счета — тело 20270302.
CREATE OR REPLACE FUNCTION osp_private.bid_supply_doc_rows(p_tender uuid, p_cp uuid)
RETURNS TABLE (item_key text, unit_key text, document_id uuid)
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  WITH taken AS (
    SELECT b.item_key, b.unit_key
    FROM public.tender_bid_rates b
    JOIN osp_private.bid_supply_price_rows(p_tender) x
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

DROP FUNCTION IF EXISTS osp_private.bid_supply_open_rows(uuid, uuid);
DROP FUNCTION IF EXISTS osp_private.bid_supply_member(uuid, uuid);
DROP FUNCTION IF EXISTS public.osp_supply_engineer();

COMMIT;
