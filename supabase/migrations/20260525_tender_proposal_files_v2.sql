-- Task 290. Замена ссылок-КП на файлы.
-- Существующая tender_proposal_files (file_url/file_name/file_size) фронтом не используется —
-- пересоздаём с новой схемой, привязанной к s3_documents, с поддержкой:
--   * file_kind = 'commercial_proposal' (КП) | 'attachment' (доп. документ)
--   * proposal_group_id — группирует версии одного и того же КП (исходный → со скидкой → ...)
--   * version_label    — свободный текст вроде "исходный", "со скидкой 5%"

DROP TABLE IF EXISTS tender_proposal_files CASCADE;

CREATE TABLE tender_proposal_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tender_id UUID NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
  counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
  s3_document_id UUID NOT NULL REFERENCES s3_documents(id) ON DELETE CASCADE,
  file_kind TEXT NOT NULL CHECK (file_kind IN ('commercial_proposal', 'attachment')),
  -- NULL для attachment; для commercial_proposal обязателен (генерируется на фронте,
  -- одинаковый у всех версий одного КП).
  proposal_group_id UUID,
  version_label TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tpf_tender_counterparty ON tender_proposal_files(tender_id, counterparty_id);
CREATE INDEX idx_tpf_s3_document ON tender_proposal_files(s3_document_id);
CREATE INDEX idx_tpf_proposal_group ON tender_proposal_files(proposal_group_id) WHERE proposal_group_id IS NOT NULL;

ALTER TABLE tender_proposal_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all for tender_proposal_files"
  ON tender_proposal_files FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE  tender_proposal_files IS 'Файлы КП/документов от контрагентов по тендеру. Связь с s3_documents через s3_document_id.';
COMMENT ON COLUMN tender_proposal_files.file_kind IS 'commercial_proposal — это КП; attachment — вспомогательный документ';
COMMENT ON COLUMN tender_proposal_files.proposal_group_id IS 'Идентификатор группы версий одного КП (исходный → со скидкой → финальный). NULL для attachment.';
COMMENT ON COLUMN tender_proposal_files.version_label IS 'Свободная метка версии: исходный, со скидкой 5%, финальный и т.п.';
