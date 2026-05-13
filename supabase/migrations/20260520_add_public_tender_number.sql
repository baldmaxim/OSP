-- Публичный порядковый номер тендера.
-- Присваивается автоматически при INSERT через sequence, не меняется.

CREATE SEQUENCE IF NOT EXISTS tenders_public_number_seq;

ALTER TABLE tenders
    ADD COLUMN IF NOT EXISTS public_tender_number INTEGER
        DEFAULT nextval('tenders_public_number_seq');

-- Бэкфилл существующих тендеров: присваиваем номера в порядке created_at
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at) AS rn
  FROM tenders
  WHERE public_tender_number IS NULL
)
UPDATE tenders t
SET public_tender_number = numbered.rn
FROM numbered
WHERE t.id = numbered.id;

-- Сдвигаем sequence, чтобы новые номера шли после бэкфилла
SELECT setval(
  'tenders_public_number_seq',
  COALESCE((SELECT MAX(public_tender_number) FROM tenders), 0) + 1,
  false
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenders_public_tender_number
    ON tenders(public_tender_number);

COMMENT ON COLUMN tenders.public_tender_number IS
  'Сквозной публичный номер тендера, присваивается при создании';
