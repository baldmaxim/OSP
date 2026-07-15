-- Иерархия и порядок приложений (2 уровня: №1 → подпункт №1.1) для двух таблиц:
--   contract_appendices          — «Приложения к Договору»
--   object_contract_attachments  — «Стандартные приложения объекта»
-- sort_order уже есть в обеих (порядок среди соседей одного уровня).
-- Нумерация считается на фронте автоматически, number_manual=true — ручной override.

-- ── Приложения к Договору ──────────────────────────────────────────────────
ALTER TABLE contract_appendices ADD COLUMN IF NOT EXISTS parent_id UUID
  REFERENCES contract_appendices(id) ON DELETE CASCADE;
ALTER TABLE contract_appendices ADD COLUMN IF NOT EXISTS number_manual BOOLEAN DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_contract_appendices_parent ON contract_appendices(parent_id);
-- существующие строки — авто-нумерация (их appendix_number для верхнего уровня и так = позиции)
UPDATE contract_appendices SET number_manual = false WHERE number_manual IS NULL;

COMMENT ON COLUMN contract_appendices.parent_id IS 'Родительское приложение (для подпунктов №N.1); NULL — верхний уровень';
COMMENT ON COLUMN contract_appendices.number_manual IS 'true — номер (appendix_number) задан вручную, иначе считается автоматически';

-- ── Стандартные приложения объекта ─────────────────────────────────────────
ALTER TABLE object_contract_attachments ADD COLUMN IF NOT EXISTS parent_id UUID
  REFERENCES object_contract_attachments(id) ON DELETE CASCADE;
ALTER TABLE object_contract_attachments ADD COLUMN IF NOT EXISTS number_label TEXT;
ALTER TABLE object_contract_attachments ADD COLUMN IF NOT EXISTS number_manual BOOLEAN DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_object_contract_attachments_parent ON object_contract_attachments(parent_id);

COMMENT ON COLUMN object_contract_attachments.parent_id IS 'Родительское приложение (для подпунктов №N.1); NULL — верхний уровень';
COMMENT ON COLUMN object_contract_attachments.number_label IS 'Ручной override номера приложения; при NULL номер считается автоматически';
COMMENT ON COLUMN object_contract_attachments.number_manual IS 'true — номер (number_label) задан вручную, иначе авто';
