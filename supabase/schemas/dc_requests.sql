-- Reference schema for «Заявки на ДС» (task 306).
-- See migration 20260526_dc_requests.sql for the authoritative DDL.

CREATE TABLE IF NOT EXISTS dc_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  counterparty_id UUID REFERENCES counterparties(id) ON DELETE SET NULL,
  ds_number VARCHAR(100),
  works_description TEXT,
  responsible_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- Этапы: проверка по договору → в работе → завершено (миграция 20260823).
  status TEXT NOT NULL DEFAULT 'contract_check'
    CHECK (status IN ('contract_check', 'in_work', 'completed')),
  -- Результат сверки с договором и тип ДС (миграция 20260824).
  check_status TEXT NOT NULL DEFAULT 'not_checked'
    CHECK (check_status IN ('not_checked', 'matches', 'not_matches')),
  ds_type TEXT
    CHECK (ds_type IS NULL OR ds_type IN ('rd_change', 'extra_in_contract', 'extra_out_contract')),
  -- Путь к папке с документами в файловом хранилище (миграция 20260828).
  folder_path TEXT,
  -- task 370: суммы ДС с НДS 22% (Было/Стало) и тип материала.
  amount_before NUMERIC(14, 2),
  amount_after  NUMERIC(14, 2),
  material_type TEXT CHECK (material_type IN ('tolling', 'realization')),
  created_by_name TEXT,
  deleted_at TIMESTAMPTZ,                    -- soft-delete: заявка во вкладке «Удаленные»
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dc_request_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES dc_requests(id) ON DELETE CASCADE,
  task_text TEXT NOT NULL,
  response_text TEXT,
  is_completed BOOLEAN NOT NULL DEFAULT FALSE,
  order_number INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dc_requests_object ON dc_requests(object_id);
CREATE INDEX IF NOT EXISTS idx_dc_requests_counterparty ON dc_requests(counterparty_id);
CREATE INDEX IF NOT EXISTS idx_dc_requests_status ON dc_requests(status);
CREATE INDEX IF NOT EXISTS idx_dc_request_tasks_request ON dc_request_tasks(request_id, order_number);

ALTER TABLE dc_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE dc_request_tasks ENABLE ROW LEVEL SECURITY;
