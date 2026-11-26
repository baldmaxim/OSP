-- Кабинет подрядчика: счета снабжения к взятым ценам и прошлые цены одним запросом (просьба пользователя 25.11.2026: «в личном
-- кабинете подрядчика также отображались счета на позиции с ценами от нашего снабжения (после того как мы одобрили), когда он
-- берёт расценку нашего снабжения»; «проверь на скорость и оптимизируй личный кабинет»). Только база Яндекса (прежний портал на
-- Supabase только читается).
--  • bid_supply_docs — документы снабжения (файлы счетов / КП поставщика, колонка «Документ» расценки снабжением) к позициям, цену
--    которых организация взяла у снабжения и не меняла (цена та же, что у снабжения сейчас), — только при разрешении отдела и пока
--    идёт приём (условия bid_supply_prices). Документ позиции — свой (tender_supply_links) или, у цены, скопированной из другого
--    тендера, документ исходной позиции (как «Откуда цена», supply_rate_origins). Адресные ссылки (url, сетевые папки) — нет:
--    подрядчик их не откроет, а пути внутренние. Наружу — ключ позиции, id, имя и дата файла; ключа хранилища и распознанных строк
--    счёта (s3_documents.notes) нет;
--  • bid_supply_doc_file — ключ и имя такого файла для службы (маршрут /api/fn/bid-supply-doc): в списке шлюза функции нет, браузер её
--    не вызовет. Строки s3_documents подрядчику по-прежнему закрыты (правило portal_contractor_select не меняется: в notes счёта —
--    все его строки с ценами);
--  • bid_rate_history — «ваша цена в тендере № …»: последняя своя цена по каждой позиции этого тендера (ключи присылает страница),
--    одним запросом вместо постраничного чтения всех своих цен (до 20 запросов подряд при каждом открытии тендера).
-- Данные портала не меняются. Повтор безопасен. Нужны 20270301 (bid_supply_price_rows, отметка «supply»), 20261025, 20261023.

-- ── 1. Счета снабжения к взятым ценам ────────────────────────────────────────────────────────────────
-- Строки «позиция — документ» организации p_cp: цена позиции взята у снабжения (source = 'supply') и равна нынешней цене снабжения
-- (одна во всех ВОР — bid_supply_price_rows); документы — тех строк расценки снабжения, что дали эту цену (ВОР со списком позиций,
-- цена > 0). Служебная: вызывают только функции ниже (с пропуском).
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

-- Организация, которой можно отдать счета снабжения тендера: подрядчик с доступом к идущему тендеру и разрешением отдела; сотруднику
-- (просмотр от имени подрядчика) — указанная организация с разрешением. Иначе — NULL.
CREATE OR REPLACE FUNCTION osp_private.bid_supply_docs_cp(p_tender uuid, p_counterparty uuid)
RETURNS uuid
  LANGUAGE plpgsql STABLE
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_cp uuid := public.osp_counterparty_id();
BEGIN
  IF v_cp IS NULL THEN
    IF NOT public.osp_is_employee() THEN
      RAISE EXCEPTION 'Счета снабжения — только подрядчику с разрешением отдела' USING ERRCODE = '42501';
    END IF;
    v_cp := p_counterparty;
  ELSIF coalesce(public.bid_access(p_tender), 'rejected') NOT IN ('invited', 'pending', 'accepted')
        OR NOT public.bid_tender_open(p_tender) THEN
    RETURN NULL;
  END IF;
  IF v_cp IS NULL OR NOT EXISTS (SELECT 1 FROM public.tender_bid_supply_access a
                                 WHERE a.tender_id = p_tender AND a.counterparty_id = v_cp AND a.status = 'granted') THEN
    RETURN NULL;
  END IF;
  RETURN v_cp;
END
$$;

-- Счета к позициям, цену которых организация взяла у снабжения. Подрядчику — свои; сотруднику — указанной организации.
CREATE OR REPLACE FUNCTION public.bid_supply_docs(p_tender uuid, p_counterparty uuid DEFAULT NULL)
RETURNS TABLE (item_key text, unit_key text, document_id uuid, file_name text, uploaded_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid := osp_private.bid_supply_docs_cp(p_tender, p_counterparty);
BEGIN
  IF v_cp IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT x.item_key, x.unit_key, d.id, d.file_name::text, d.created_at
  FROM osp_private.bid_supply_doc_rows(p_tender, v_cp) x
  JOIN public.s3_documents d ON d.id = x.document_id AND d.owner_type = 'tender' AND d.doc_category = 'supply_doc'
  ORDER BY x.item_key, x.unit_key, d.created_at DESC, d.id;
END
$$;
COMMENT ON FUNCTION public.bid_supply_docs(uuid, uuid) IS
  'Кабинет подрядчика: файлы счетов / КП снабжения к позициям, цену которых организация взяла у снабжения (только с разрешения отдела).';

-- Ключ и имя файла счёта — для службы (маршрут /api/fn/bid-supply-doc), только подрядчику и только файл из bid_supply_docs.
CREATE OR REPLACE FUNCTION public.bid_supply_doc_file(p_tender uuid, p_doc uuid)
RETURNS TABLE (s3_key text, file_name text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
DECLARE
  v_cp uuid;
BEGIN
  IF public.osp_counterparty_id() IS NULL THEN
    RAISE EXCEPTION 'Счёт снабжения — только для подрядчика' USING ERRCODE = '42501';
  END IF;
  v_cp := osp_private.bid_supply_docs_cp(p_tender, NULL);
  IF v_cp IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT d.s3_key::text, d.file_name::text
  FROM public.s3_documents d
  WHERE d.id = p_doc AND d.owner_type = 'tender' AND d.doc_category = 'supply_doc'
    AND EXISTS (SELECT 1 FROM osp_private.bid_supply_doc_rows(p_tender, v_cp) x WHERE x.document_id = p_doc);
END
$$;
COMMENT ON FUNCTION public.bid_supply_doc_file(uuid, uuid) IS
  'Кабинет подрядчика: ключ и имя файла счёта снабжения к взятой цене. Только для службы, в списке шлюза нет.';

-- ── 2. Прошлые цены одним запросом ───────────────────────────────────────────────────────────────────
-- Последняя своя цена по каждой из позиций p_keys («вид|наименование|ед. изм.», не больше 2000) в других тендерах, без цен,
-- взятых у снабжения. С правами вызывающего: правило tender_bid_rates и так показывает подрядчику только свои цены; сотруднику
-- (у него нет организации) — пусто.
CREATE OR REPLACE FUNCTION public.bid_rate_history(p_tender uuid, p_keys text[])
RETURNS TABLE (kind text, item_key text, unit_key text, price numeric, tender_id uuid, updated_at timestamptz)
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  WITH k AS MATERIALIZED (SELECT DISTINCT x AS key, split_part(x, '|', 2) AS item FROM unnest(p_keys[1:2000]) x WHERE x LIKE '%|%|%')
  SELECT DISTINCT ON (b.kind, b.item_key, b.unit_key)
         b.kind::text, b.item_key::text, b.unit_key::text, b.price::numeric, b.tender_id, b.updated_at
  FROM public.tender_bid_rates b
  WHERE b.counterparty_id = public.osp_counterparty_id()
    AND b.item_key IN (SELECT k.item FROM k)
    AND (b.kind || '|' || b.item_key || '|' || b.unit_key) IN (SELECT k.key FROM k)
    AND b.tender_id <> p_tender AND b.price IS NOT NULL AND b.source <> 'supply'
  ORDER BY b.kind, b.item_key, b.unit_key, b.updated_at DESC, b.id
$$;
COMMENT ON FUNCTION public.bid_rate_history(uuid, text[]) IS
  'Кабинет подрядчика: последняя своя цена по каждой позиции тендера в других тендерах (подсказка «ваша цена в тендере № …»).';

-- ── 3. Список шлюза ──────────────────────────────────────────────────────────────────────────────────
-- Подрядчику (allow-contractor.json / allow-self-contractor.json) — bid_supply_docs и bid_rate_history; bid_supply_doc_file — только
-- служба (в списке нет).
-- osp:allow rpc bid_supply_docs authenticated
-- osp:allow rpc bid_rate_history authenticated
