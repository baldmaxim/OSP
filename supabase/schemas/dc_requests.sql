-- Reference schema for «Заявки на ДС» (task 306).
-- See migration 20260526_dc_requests.sql for the authoritative DDL.

CREATE TABLE IF NOT EXISTS dc_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id UUID NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  counterparty_id UUID REFERENCES counterparties(id) ON DELETE SET NULL,
  ds_number VARCHAR(100),
  works_description TEXT,
  responsible_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dc_request_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES dc_requests(id) ON DELETE CASCADE,
  task_text TEXT NOT NULL,
  response_text TEXT,
  order_number INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dc_requests_object ON dc_requests(object_id);
CREATE INDEX IF NOT EXISTS idx_dc_requests_counterparty ON dc_requests(counterparty_id);
CREATE INDEX IF NOT EXISTS idx_dc_request_tasks_request ON dc_request_tasks(request_id, order_number);

ALTER TABLE dc_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE dc_request_tasks ENABLE ROW LEVEL SECURITY;
