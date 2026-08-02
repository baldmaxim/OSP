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
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT;  -- ФИО/e-mail проверяющего (для отображения)

COMMENT ON COLUMN tender_proposal_files.review_status IS
  'Статус проверки КП аналитиком: pending | approved | has_remarks';
COMMENT ON COLUMN tender_proposal_files.review_note IS
  'Замечания аналитика по КП (для has_remarks)';
COMMENT ON COLUMN tender_proposal_files.reviewed_at IS
  'Момент завершения проверки';
COMMENT ON COLUMN tender_proposal_files.reviewed_by IS
  'Кто проверил (ФИО или e-mail из профиля)';

-- Быстрый выбор очереди на проверку и недавно проверенных (для уведомлений).
CREATE INDEX IF NOT EXISTS idx_tpf_review_status
  ON tender_proposal_files (review_status)
  WHERE file_kind = 'commercial_proposal';
CREATE INDEX IF NOT EXISTS idx_tpf_reviewed_at
  ON tender_proposal_files (reviewed_at)
  WHERE file_kind = 'commercial_proposal';
