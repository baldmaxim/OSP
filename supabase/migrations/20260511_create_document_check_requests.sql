-- Заявки на проверку договоров подряда (ДП) и дополнительных соглашений (ДС).
-- Используются в канбан-доске на странице «Проверка ДП/ДС».

CREATE TABLE IF NOT EXISTS document_check_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id UUID REFERENCES objects(id) ON DELETE SET NULL,
  counterparty_id UUID REFERENCES counterparties(id) ON DELETE SET NULL,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('ДП', 'ДС')),
  doc_number TEXT NOT NULL,
  doc_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'edo_export', '1c_entry', 'completed')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_check_requests_status ON document_check_requests(status);
CREATE INDEX IF NOT EXISTS idx_document_check_requests_object ON document_check_requests(object_id);
CREATE INDEX IF NOT EXISTS idx_document_check_requests_counterparty ON document_check_requests(counterparty_id);

ALTER TABLE document_check_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for authenticated users" ON document_check_requests
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE document_check_requests IS 'Заявки на проверку договоров подряда и дополнительных соглашений (канбан)';
COMMENT ON COLUMN document_check_requests.doc_type IS 'Тип документа: ДП (договор подряда) или ДС (дополнительное соглашение)';
COMMENT ON COLUMN document_check_requests.status IS 'Колонка канбана: new | in_progress | edo_export | 1c_entry | completed';
