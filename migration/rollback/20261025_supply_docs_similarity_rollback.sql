-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261025_supply_docs_similarity.sql (Supabase): похожие цены — снова прежним
-- расчётом (20261023: общие слова и числа одной кучей, меню — от самых новых), без размера и файла документа в меню.
-- Данные НЕ удаляются: файлы документов у позиций, колонки и функции слов остаются (вычисляемые колонки без функций
-- не живут; прежние вкладки покажут у позиции с файлом пустую ссылку), повторное применение миграции продолжит с
-- ними. Триггер «адрес или файл» остаётся: прежние вкладки пишут адрес — файл снимается, ограничение не нарушается.
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.supply_suggestion_counts(p_tender uuid, p_items jsonb)
  RETURNS TABLE (estimate_name text, k text, n integer)
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  -- MATERIALIZED: слова позиции считаются один раз, а не на каждую пару «позиция × цена».
  WITH pos AS MATERIALIZED (
    SELECT i->>'doc' AS doc, i->>'k' AS k, public.supply_name_tokens(i->>'name') AS tokens,
           public.supply_name_words(i->>'name') AS words, public.kp_norm_unit(i->>'unit') AS u
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END)
         WITH ORDINALITY AS x(i, o)
    WHERE x.o <= 200 AND coalesce(i->>'k', '') <> '' AND coalesce(btrim(i->>'unit'), '') <> ''
  )
  SELECT p.doc, p.k, count(*)::integer
  FROM pos p
  JOIN public.tender_vor_supply_rates r
    ON r.name_words && p.words AND r.source_rate_id IS NULL AND r.unit_key = p.u
   AND r.price_date >= ((now() AT TIME ZONE 'Europe/Moscow')::date - interval '3 months')::date
  JOIN public.tenders t ON t.id = r.tender_id AND t.deleted_at IS NULL
  WHERE NOT (r.tender_id = p_tender AND r.estimate_name = p.doc AND r.material_key = p.k)
    AND public.supply_name_similarity(p.tokens, r.name_tokens) >= 0.5
  GROUP BY p.doc, p.k
$$;

DROP FUNCTION IF EXISTS public.supply_rate_suggestions(uuid, text, text, text, integer);
CREATE OR REPLACE FUNCTION public.supply_rate_suggestions(p_tender uuid, p_estimate text, p_name text, p_unit text,
                                                         p_limit integer DEFAULT 15)
  RETURNS TABLE (rate_id uuid, tender_id uuid, tender_number integer, object_name text, estimate_name text,
                 material_name text, unit text, unit_price numeric, price_date date, url text, similarity numeric,
                 same_name boolean)
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  WITH q AS MATERIALIZED (
    SELECT public.supply_name_tokens(p_name) AS tokens, public.supply_name_words(p_name) AS words,
           public.supply_norm_name(p_name) AS k, public.kp_norm_unit(p_unit) AS u,
           ((now() AT TIME ZONE 'Europe/Moscow')::date - interval '3 months')::date AS since
  )
  SELECT r.id, r.tender_id, t.public_tender_number, coalesce(o.name, t.custom_object_name), r.estimate_name,
         r.material_name, r.unit, coalesce(r.supply_price_exact, r.supply_price), r.price_date, l.url,
         public.supply_name_similarity(q.tokens, r.name_tokens), r.material_key = q.k
  FROM q
  JOIN public.tender_vor_supply_rates r
    ON r.name_words && q.words AND r.source_rate_id IS NULL AND r.unit_key = q.u AND r.price_date >= q.since
  JOIN public.tenders t ON t.id = r.tender_id AND t.deleted_at IS NULL
  LEFT JOIN public.objects o ON o.id = t.object_id
  LEFT JOIN public.tender_supply_links l
    ON l.tender_id = r.tender_id AND l.estimate_name = r.estimate_name AND l.material_key = r.material_key
  WHERE NOT (r.tender_id = p_tender AND r.estimate_name = p_estimate AND r.material_key = q.k)
    AND public.supply_name_similarity(q.tokens, r.name_tokens) >= 0.5
  ORDER BY r.price_date DESC, public.supply_name_similarity(q.tokens, r.name_tokens) DESC, r.updated_at DESC NULLS LAST
  LIMIT least(greatest(coalesce(p_limit, 15), 1), 50)
$$;

DROP FUNCTION IF EXISTS public.supply_rate_origins(uuid);
CREATE OR REPLACE FUNCTION public.supply_rate_origins(p_tender uuid)
  RETURNS TABLE (rate_id uuid, source_kind text, source_tender_id uuid, tender_number integer, object_name text,
                 estimate_name text, material_name text, price_date date, url text, source_price_by uuid)
  LANGUAGE sql STABLE
  SET search_path = public, pg_temp
AS $$
  SELECT r.id, r.source_kind, r.source_tender_id, t.public_tender_number, coalesce(o.name, t.custom_object_name),
         s.estimate_name, s.material_name, r.price_date, l.url, s.price_by
  FROM public.tender_vor_supply_rates r
  LEFT JOIN public.tender_vor_supply_rates s ON s.id = r.source_rate_id
  LEFT JOIN public.tenders t ON t.id = r.source_tender_id
  LEFT JOIN public.objects o ON o.id = t.object_id
  LEFT JOIN public.tender_supply_links l
    ON l.tender_id = s.tender_id AND l.estimate_name = s.estimate_name AND l.material_key = s.material_key
  WHERE r.tender_id = p_tender AND r.source_kind IS NOT NULL
$$;

REVOKE ALL ON FUNCTION public.supply_suggestion_counts(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_rate_suggestions(uuid, text, text, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.supply_rate_origins(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supply_suggestion_counts(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_rate_suggestions(uuid, text, text, text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supply_rate_origins(uuid) TO authenticated, service_role;

COMMIT;
