-- Task 306. Реестр «Заявок на ДС» (дополнительные соглашения).
-- Независимая сущность — не связана с object_documents через FK. № ДС — свободный текст.
-- К каждой заявке привязывается несколько задач (dc_request_tasks) с парой текст-вопрос/ответ.

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

CREATE INDEX IF NOT EXISTS idx_dc_requests_object ON dc_requests(object_id);
CREATE INDEX IF NOT EXISTS idx_dc_requests_counterparty ON dc_requests(counterparty_id);

CREATE TABLE IF NOT EXISTS dc_request_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES dc_requests(id) ON DELETE CASCADE,
  task_text TEXT NOT NULL,
  response_text TEXT,
  order_number INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dc_request_tasks_request ON dc_request_tasks(request_id, order_number);

ALTER TABLE dc_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE dc_request_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable all for dc_requests"
  ON dc_requests FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY "Enable all for dc_request_tasks"
  ON dc_request_tasks FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE  dc_requests IS 'Реестр заявок на дополнительные соглашения (task 306)';
COMMENT ON TABLE  dc_request_tasks IS 'Задачи (с ответами) в рамках одной заявки на ДС';
COMMENT ON COLUMN dc_requests.ds_number IS 'Свободный текстовый номер ДС (не связан с object_documents)';
COMMENT ON COLUMN dc_requests.works_description IS 'Выполняемые работы по заявке';
COMMENT ON COLUMN dc_request_tasks.task_text IS 'Текст задачи в рамках рассмотрения заявки';
COMMENT ON COLUMN dc_request_tasks.response_text IS 'Ответ по задаче';
COMMENT ON COLUMN dc_request_tasks.order_number IS 'Порядок отображения задачи внутри заявки';
