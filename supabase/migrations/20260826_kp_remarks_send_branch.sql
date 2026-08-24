-- Проверка КП: развилка внутри ветки «есть замечания».
--
-- До сих пор любые замечания вели по одному маршруту: занести в сводную →
-- отправить контрагенту. На практике часть замечаний подрядчику не отправляют
-- (внутренние пометки аналитика, расхождения, которые правит сам инженер) —
-- такие КП зависали в очереди «к отправке контрагенту» навсегда.
--
-- Теперь аналитик вместе с замечаниями выбирает подветку:
--   remarks_send_required = true  → «для отправки подрядчику»
--                                   сводная → отправка контрагенту → готово
--   remarks_send_required = false → «без отправки подрядчику»
--                                   сводная → готово
--
-- DEFAULT true: все существующие КП с замечаниями остаются на прежнем маршруте,
-- поведение до миграции не меняется.
--
-- Миграция идемпотентна.

ALTER TABLE tender_proposal_files
  ADD COLUMN IF NOT EXISTS remarks_send_required BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN tender_proposal_files.remarks_send_required IS
  'Ветка обработки замечаний: true — замечания направляются подрядчику, false — обрабатываются без отправки (маршрут заканчивается на занесении в сводную)';

-- Очереди веток выбираются по (статус, отправлять ли, внесено ли в сводную).
CREATE INDEX IF NOT EXISTS idx_tender_proposal_files_remarks_branch
  ON tender_proposal_files(review_status, remarks_send_required, summary_added)
  WHERE file_kind = 'commercial_proposal';
