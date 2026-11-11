-- АВАРИЙНЫЙ ОТКАТ 20270113_bid_vor_files (только база Яндекса): маршрут /api/fn/bid-file отвечает ошибкой, кабинет подрядчика без
-- функций снова показывает расценку на сайте (как до миграции), сводка администратора — прежняя (тело 20261102).
-- Данные НЕ удаляются: таблица tender_bid_files и файлы в хранилище остаются (повторное применение миграции продолжит с ними);
-- чтение таблицы закрыто — политика убрана, остаётся только пропуск служебных операций. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.bid_file_target(uuid, uuid);
DROP FUNCTION IF EXISTS public.bid_file_save(uuid, uuid, text, text, text, bigint, jsonb);
DROP FUNCTION IF EXISTS public.bid_file_remove(uuid);
DROP FUNCTION IF EXISTS public.bid_file_get(uuid);
DROP POLICY IF EXISTS tender_bid_files_read ON public.tender_bid_files;
DELETE FROM osp_meta.policy_roles WHERE schema_name = 'public' AND table_name = 'tender_bid_files' AND policy_name = 'tender_bid_files_read';

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

COMMIT;
