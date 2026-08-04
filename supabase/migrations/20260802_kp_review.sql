-- task 431: проверка КП аналитиком-экономистом.
-- Каждый файл КП (tender_proposal_files, file_kind='commercial_proposal') получает
-- статус проверки: pending → approved (галочка «проверено, ОК») либо has_remarks
-- (есть замечания, текст в review_note). Экономист ОСП/админ проставляет статус;
-- по завершении проверки ответственному по тендеру уходит уведомление.

ALTER TABLE tender_proposal_files
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'approved', 'has_remarks')),
  ADD COLUMN IF NOT EXISTS review_note TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT,  -- ФИО/e-mail проверяющего (для отображения)
  -- Файл с замечаниями (S3), опционально прикреплённый при has_remarks. Ссылка на
  -- s3_documents (owner_type='tender'); ON DELETE SET NULL — удалили файл, ссылка обнулилась.
  ADD COLUMN IF NOT EXISTS review_note_s3_document_id UUID
    REFERENCES s3_documents(id) ON DELETE SET NULL;

-- «Требует проверки»: только КП, загруженные с момента применения миграции, попадают
-- в очередь «Проверка КП». Весь исторический бэклог остаётся в тендерах как обычные
-- файлы (без галочки, вне очереди). Трюк без привязки к дате: колонка добавляется с
-- DEFAULT false (все существующие строки → false = легаси), затем дефолт меняется на
-- true — все будущие загрузки автоматически идут на проверку.
ALTER TABLE tender_proposal_files
  ADD COLUMN IF NOT EXISTS review_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tender_proposal_files
  ALTER COLUMN review_required SET DEFAULT true;

COMMENT ON COLUMN tender_proposal_files.review_status IS
  'Статус проверки КП аналитиком: pending | approved | has_remarks';
COMMENT ON COLUMN tender_proposal_files.review_note IS
  'Замечания аналитика по КП (для has_remarks)';
COMMENT ON COLUMN tender_proposal_files.reviewed_at IS
  'Момент завершения проверки';
COMMENT ON COLUMN tender_proposal_files.reviewed_by IS
  'Кто проверил (ФИО или e-mail из профиля)';
COMMENT ON COLUMN tender_proposal_files.review_note_s3_document_id IS
  'Файл с замечаниями (S3), прикреплённый аналитиком при has_remarks';
COMMENT ON COLUMN tender_proposal_files.review_required IS
  'Попадает ли КП в очередь «Проверка КП». Легаси (до миграции) = false, новые загрузки = true';

-- Быстрый выбор очереди на проверку и недавно проверенных (для уведомлений).
-- В очередь идут только КП с review_required = true.
CREATE INDEX IF NOT EXISTS idx_tpf_review_queue
  ON tender_proposal_files (review_status)
  WHERE file_kind = 'commercial_proposal' AND review_required;
CREATE INDEX IF NOT EXISTS idx_tpf_reviewed_at
  ON tender_proposal_files (reviewed_at)
  WHERE file_kind = 'commercial_proposal';
