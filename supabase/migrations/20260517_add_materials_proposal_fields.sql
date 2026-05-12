-- Поля для тендеров на материалы:
-- materials_proposal_deadline — срок предоставления КП на материалы (дедлайн)
-- materials_proposal_link     — ссылка на КП на материалы (Google/Yandex Drive)
-- Применяются только к тендерам с tender_type = 'materials'; у основных тендеров остаются NULL.

ALTER TABLE tenders
    ADD COLUMN IF NOT EXISTS materials_proposal_deadline DATE,
    ADD COLUMN IF NOT EXISTS materials_proposal_link TEXT;

COMMENT ON COLUMN tenders.materials_proposal_deadline IS 'Срок предоставления КП на материалы (для tender_type = materials)';
COMMENT ON COLUMN tenders.materials_proposal_link IS 'Ссылка на КП на материалы (для tender_type = materials)';
