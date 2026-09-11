-- ПСДЦ / ВОР (справочная схема). Источник истины — миграция
-- supabase/migrations/20260908_psdc.sql: там же функции расчёта, проверки,
-- применения, массовой загрузки, триггер защиты суммы и RLS.

-- contracts (дополнение первого этапа)
--   psdc_total      NUMERIC(20,2) — итог применённой ПСДЦ; пока задан, это сумма документа
--   psdc_applied_id UUID → psdc(id)
-- Пишутся только функциями psdc_apply / psdc_delete (триггер contracts_psdc_total_guard).

CREATE TABLE IF NOT EXISTS psdc_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT,
  created_by UUID,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS psdc (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES contracts(id) ON DELETE CASCADE,       -- NULL: файл пакета до сопоставления
  batch_id UUID REFERENCES psdc_batches(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'uploaded',                           -- uploaded | validated | invalid | applied | cancelled | deleted
  previous_psdc_id UUID REFERENCES psdc(id) ON DELETE SET NULL,     -- ближайшая применённая ПСДЦ той же ветки
  match_method TEXT,                                                -- auto | manual | table | card
  match_note TEXT,
  source_filename TEXT NOT NULL,
  source_hash TEXT,
  source_size BIGINT,
  source_s3_document_id UUID REFERENCES s3_documents(id) ON DELETE SET NULL,
  sheet_name TEXT,
  has_legacy_u BOOLEAN NOT NULL DEFAULT false,
  source_meta JSONB NOT NULL DEFAULT '{}',                          -- шапка, итоговые строки файла, ошибки чтения
  source_row_count INT NOT NULL DEFAULT 0,
  uploaded_by UUID, uploaded_by_name TEXT, uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  validated_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ, applied_by UUID, applied_by_name TEXT,
  cancelled_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ, deleted_by_name TEXT,
  section_count INT, process_count INT, legacy_deleted_count INT,
  error_count INT NOT NULL DEFAULT 0, warning_count INT NOT NULL DEFAULT 0,
  total_material NUMERIC(20,2), total_work NUMERIC(20,2), total NUMERIC(20,2),
  dm_material_excluded NUMERIC(20,2),
  vat_rate_snapshot NUMERIC(5,2), vat_included_snapshot BOOLEAN, vat_amount NUMERIC(20,2),
  file_vat_rate NUMERIC(7,2), legacy_total NUMERIC(20,2)
);
-- Одна применённая ПСДЦ на документ:
-- CREATE UNIQUE INDEX uq_psdc_one_applied_per_document ON psdc(document_id) WHERE state = 'applied';

CREATE TABLE IF NOT EXISTS psdc_source_rows (
  psdc_id UUID NOT NULL REFERENCES psdc(id) ON DELETE CASCADE,
  excel_row INT NOT NULL,
  cells JSONB NOT NULL,                                             -- {"A": {"t":"s","v":"5.10"}, "I": {"t":"n","v":"10.12345"}, …}
  PRIMARY KEY (psdc_id, excel_row)
);

CREATE TABLE IF NOT EXISTS psdc_rows (
  id UUID PRIMARY KEY,
  psdc_id UUID NOT NULL REFERENCES psdc(id) ON DELETE CASCADE,
  logical_line_id TEXT NOT NULL,                                    -- постоянный ID строки (T)
  source_line_id TEXT,
  row_order INT NOT NULL,
  excel_row INT NOT NULL,
  row_kind TEXT,                                                    -- section | process
  number TEXT, resource_type TEXT, code TEXT,
  customer_material TEXT, is_customer_material BOOLEAN NOT NULL DEFAULT false,
  cost_item TEXT, name TEXT, unit TEXT,
  consumption_norm NUMERIC(20,2), volume NUMERIC(22,5),
  material_price NUMERIC(20,2), material_cost NUMERIC(20,2),
  work_price NUMERIC(20,2), work_cost NUMERIC(20,2),
  unit_price NUMERIC(20,2), total_cost NUMERIC(20,2),
  manufacturer TEXT, materials TEXT, work_location TEXT, comment TEXT,
  parent_section_id UUID REFERENCES psdc_rows(id) ON DELETE SET NULL,
  legacy_deleted BOOLEAN NOT NULL DEFAULT false                     -- скрытый U = deleted
);

CREATE TABLE IF NOT EXISTS psdc_issues (
  id BIGSERIAL PRIMARY KEY,
  psdc_id UUID NOT NULL REFERENCES psdc(id) ON DELETE CASCADE,
  severity TEXT NOT NULL,                                           -- error | warning
  excel_row INT, cell TEXT, field TEXT,
  code TEXT NOT NULL,
  message TEXT NOT NULL
);
