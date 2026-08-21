-- Два независимых уточнения процессов.
--
-- 1) Заявки на ДС: результат сверки с договором и тип ДС.
--    Этап «Проверка по договору» (миграция 20260823) появился, но его исход
--    нигде не фиксировался — по карточке нельзя было понять, сверили её уже
--    или нет и чем закончилось. Плюс отдельным признаком нужен тип ДС.
--
-- 2) Проверка КП: промежуточный этап «занесено в сводную таблицу».
--    Раньше цепочка обрывалась на «нет замечаний» либо шла сразу в «отправлено
--    контрагенту». По факту между ними есть работа — КП вносят в сводную
--    таблицу, и очередь на это надо видеть.
--
-- Миграция идемпотентна.

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Заявки на ДС.
ALTER TABLE dc_requests
  ADD COLUMN IF NOT EXISTS check_status TEXT NOT NULL DEFAULT 'not_checked';
ALTER TABLE dc_requests
  ADD COLUMN IF NOT EXISTS ds_type TEXT;

ALTER TABLE dc_requests DROP CONSTRAINT IF EXISTS dc_requests_check_status_check;
ALTER TABLE dc_requests
  ADD CONSTRAINT dc_requests_check_status_check
  CHECK (check_status IN ('not_checked', 'matches', 'not_matches'));

-- ds_type необязателен (NULL = не указан), поэтому в CHECK допускаем NULL.
ALTER TABLE dc_requests DROP CONSTRAINT IF EXISTS dc_requests_ds_type_check;
ALTER TABLE dc_requests
  ADD CONSTRAINT dc_requests_ds_type_check
  CHECK (ds_type IS NULL OR ds_type IN ('rd_change', 'extra_in_contract', 'extra_out_contract'));

COMMENT ON COLUMN dc_requests.check_status IS
  'Результат сверки с договором: not_checked | matches (соответствует) | not_matches (не соответствует)';
COMMENT ON COLUMN dc_requests.ds_type IS
  'Тип ДС: rd_change (изменение РД) | extra_in_contract (доп. работы по договору) | extra_out_contract (доп. работы вне договора)';

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Проверка КП: занесение в сводную таблицу.
--
-- Флаг + кто/когда — по образцу remarks_sent из очереди замечаний, чтобы в
-- таблице было видно не только «внесено», но и кем.
ALTER TABLE tender_proposal_files
  ADD COLUMN IF NOT EXISTS summary_added BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tender_proposal_files
  ADD COLUMN IF NOT EXISTS summary_added_at TIMESTAMPTZ;
ALTER TABLE tender_proposal_files
  ADD COLUMN IF NOT EXISTS summary_added_by TEXT;

COMMENT ON COLUMN tender_proposal_files.summary_added IS
  'КП занесено в сводную таблицу. Этап между проверкой аналитиком и отправкой замечаний контрагенту';

-- Очередь «к занесению» выбирается по проверенным, но ещё не внесённым.
CREATE INDEX IF NOT EXISTS idx_tender_proposal_files_summary
  ON tender_proposal_files(review_status, summary_added)
  WHERE file_kind = 'commercial_proposal';
