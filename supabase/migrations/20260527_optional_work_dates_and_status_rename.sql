-- Task 270: даты начала/окончания работ теперь необязательны.
ALTER TABLE tenders ALTER COLUMN start_date DROP NOT NULL;
ALTER TABLE tenders ALTER COLUMN end_date DROP NOT NULL;
-- CHECK (end_date >= start_date) остаётся: при NULL он не нарушается.

-- Task 268: статус тендера на материалы «Не нужно» → «Не требуется».
UPDATE tenders SET status = 'Не требуется' WHERE status = 'Не нужно';
