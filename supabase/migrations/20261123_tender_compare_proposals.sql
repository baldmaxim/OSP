-- «Сравнение КП» в карточке тендера: все КП тендера одним запросом.
--
-- Раньше вкладка читала tender_counterparty_proposals страницами по 1000 строк (потолок PostgREST): у крупного
-- тендера — 20 страниц и запрос числа строк, и на каждой странице база заново отбирала и сортировала все КП тендера
-- (индекса (tender_id, id) из 20260909 на проде нет), а правило по строкам проверялось на каждой строке до OFFSET.
-- Каждая страница — ещё и путь через шлюз. Функция отдаёт все строки тендера одним ответом: одно значение json,
-- потолок 1000 строк его не касается.
--
-- Права вызывающего (SECURITY INVOKER): правила по строкам те же, что у выборки из таблицы, — сотрудник видит все
-- КП тендера, подрядчик только свои. STABLE — вызывается и GET-запросом (в режиме «только чтение» шлюз пропускает).
--
-- Ответ: {"coverage": bool, "rows": [[id, counterparty_id, estimate_item_id, unit_price_materials, unit_price_works,
-- total_materials, total_works, total_cost, proposal_date, created_at(, covered_elsewhere, coverage_note)], …]} —
-- массивы вместо объектов: ответ на треть меньше. Пометка «учтено в другой позиции» (колонки 20260606) — только если
-- её колонки есть (на 30.10.2026 их нет ни в одной базе портала). Порядок полей — ROW_FIELDS в
-- src/components/TenderProposalsCompare.jsx. Пока функции нет, вкладка читает страницами, как раньше.
-- База нового портала (Яндекс) — migration/yandex/20261123_tender_compare_proposals.sql (то же тело).
-- Проверка: migration/backup/checks/20261123.sql, откат: migration/rollback/20261123_tender_compare_proposals_rollback.sql.
BEGIN;

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

REVOKE ALL ON FUNCTION public.tender_compare_proposals(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tender_compare_proposals(uuid) TO authenticated, service_role;

COMMIT;
