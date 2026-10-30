-- «Сравнение КП» в карточке тендера: все КП тендера одним запросом (вариант для базы Яндекса; тело функции — как в
-- supabase/migrations/20261123_tender_compare_proposals.sql, там же — зачем и формат ответа).
--
-- Раньше вкладка читала tender_counterparty_proposals страницами по 1000 строк через шлюз: у крупного тендера —
-- 20 страниц и запрос числа строк, каждая страница заново отбирала и сортировала все КП тендера. Функция отдаёт все
-- строки тендера одним значением json.
--
-- Права вызывающего: правила по строкам таблицы действуют как при выборке из неё (сотрудник — все КП тендера,
-- подрядчик — только свои), служебной отметки нет. STABLE — шлюз пропускает GET-вызов и в режиме «только чтение».
-- Новых таблиц и правил нет; в списке шлюза — только сама функция (authenticated).
CREATE OR REPLACE FUNCTION public.tender_compare_proposals(p_tender uuid)
  RETURNS json
  LANGUAGE plpgsql STABLE
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_coverage boolean;
  v_rows json;
BEGIN
  SELECT count(*) = 2 INTO v_coverage
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.tender_counterparty_proposals'::regclass
    AND attname IN ('covered_elsewhere', 'coverage_note') AND attnum > 0 AND NOT attisdropped;
  EXECUTE format($q$
    SELECT coalesce(json_agg(json_build_array(p.id, p.counterparty_id, p.estimate_item_id,
             p.unit_price_materials, p.unit_price_works, p.total_materials, p.total_works, p.total_cost,
             p.proposal_date, p.created_at%s)), '[]'::json)
    FROM public.tender_counterparty_proposals p
    WHERE p.tender_id = $1$q$,
    CASE WHEN v_coverage THEN ', p.covered_elsewhere, p.coverage_note' ELSE '' END)
  INTO v_rows USING p_tender;
  RETURN json_build_object('coverage', v_coverage, 'rows', v_rows);
END
$$;

-- osp:allow rpc tender_compare_proposals authenticated
