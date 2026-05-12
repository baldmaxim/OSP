-- Тип тендера (основной/на материалы) и связь с родительским тендером.
-- К запущенному основному тендеру может отдельно запускаться тендер на закупку материалов.

ALTER TABLE tenders
    ADD COLUMN IF NOT EXISTS tender_type text NOT NULL DEFAULT 'main'
        CHECK (tender_type IN ('main', 'materials')),
    ADD COLUMN IF NOT EXISTS parent_tender_id uuid
        REFERENCES tenders(id) ON DELETE SET NULL;

-- parent_tender_id заполняется только у тендеров типа 'materials'
ALTER TABLE tenders
    DROP CONSTRAINT IF EXISTS tenders_parent_only_for_materials;
ALTER TABLE tenders
    ADD CONSTRAINT tenders_parent_only_for_materials
        CHECK (
            (tender_type = 'materials')
            OR (parent_tender_id IS NULL)
        );

CREATE INDEX IF NOT EXISTS idx_tenders_tender_type ON tenders(tender_type);
CREATE INDEX IF NOT EXISTS idx_tenders_parent_tender_id ON tenders(parent_tender_id);
