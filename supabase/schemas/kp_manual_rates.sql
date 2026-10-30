-- Расценка подрядчика, добавленная в реестр расценок вручную: «Расценки от подрядчиков (КП)» → «Добавить расценку»
-- или «Проверить по файлу» → «Добавить в реестр». Источник истины — supabase/migrations/20261122_kp_registry_manual_sources.sql
-- (права, триггер, представление реестра kp_rates_registry — материализованное ∪ эти строки, функция kp_rates_lookup).
CREATE TABLE IF NOT EXISTS public.kp_manual_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type text NOT NULL CHECK (item_type IN ('material', 'work')),
  item_name text NOT NULL CHECK (char_length(btrim(item_name)) BETWEEN 1 AND 1000),
  unit character varying(50),
  price numeric(15,2) NOT NULL CHECK (price > 0 AND price < 1e12),   -- за единицу с НДС, как КП в реестре
  counterparty_id uuid NOT NULL REFERENCES public.counterparties(id) ON DELETE CASCADE,
  object_id uuid REFERENCES public.objects(id) ON DELETE SET NULL,    -- не указан — объект тендера
  tender_id uuid REFERENCES public.tenders(id) ON DELETE SET NULL,
  rate_date date NOT NULL DEFAULT ((now() AT TIME ZONE 'Europe/Moscow')::date),
  doc_url text,                                                        -- http(s) или \\сервер\папка
  s3_document_id uuid REFERENCES public.s3_documents(id) ON DELETE SET NULL,  -- owner_type general, doc_category kp_manual_rate
  note text,
  created_by uuid,                                                     -- кто и когда — триггер kp_manual_rates_stamp
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kp_manual_rates_one_doc CHECK (doc_url IS NULL OR s3_document_id IS NULL)
);

-- RLS: читает osp_registry_reader(), INSERT / UPDATE / DELETE — osp_can('rates_registry', 'edit').
