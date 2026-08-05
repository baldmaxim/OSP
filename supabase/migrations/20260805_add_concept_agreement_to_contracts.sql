-- «Понятийное соглашение» к договору — документ-основание для заключения договора
-- (несёт визу акционера, необходимую для подписания). Один файл на договор, лежит в
-- S3 (owner_type='contract'); ссылка через s3_documents, ON DELETE SET NULL.
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS concept_agreement_s3_document_id UUID
    REFERENCES s3_documents(id) ON DELETE SET NULL;

COMMENT ON COLUMN contracts.concept_agreement_s3_document_id IS
  'Понятийное соглашение (S3-документ-основание для договора, с визой акционера)';
