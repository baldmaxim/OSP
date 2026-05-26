-- Task 307. Статус заявки + признак выполнения задачи.

ALTER TABLE dc_requests
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'in_work';

-- Допустимые значения: in_work | completed
ALTER TABLE dc_requests
  DROP CONSTRAINT IF EXISTS dc_requests_status_check;
ALTER TABLE dc_requests
  ADD CONSTRAINT dc_requests_status_check
  CHECK (status IN ('in_work', 'completed'));

CREATE INDEX IF NOT EXISTS idx_dc_requests_status ON dc_requests(status);

ALTER TABLE dc_request_tasks
  ADD COLUMN IF NOT EXISTS is_completed BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN dc_requests.status IS 'Статус заявки: in_work (в работе) | completed (завершено)';
COMMENT ON COLUMN dc_request_tasks.is_completed IS 'Задача отмечена выполненной (checkbox в UI)';
