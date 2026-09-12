-- Заявки на ДС: результат проверки по договору.
--
-- Этап «Проверка по договору» и следующий за ним «Итог проверки» (миграции
-- 20260823, 20260907) фиксировали только сам факт стадии. Чем закончилась
-- сверка — в системе не оставалось: вывод юриста жил в переписке, а по карточке
-- нельзя было понять, соответствует ДС договору или нет и почему.
--
-- Колонка check_status для исхода существует с миграции 20260824, но была
-- вырезана из интерфейса. Возвращаем её в работу и дополняем:
--   • третьим исходом «соответствует с замечаниями» — на практике самый частый:
--     договор в целом подходит, но есть оговорки;
--   • текстом заключения;
--   • подписью «кто и когда» — по исходу принимаются решения, автор должен быть
--     виден без захода в историю.
--
-- Файлы результата миграции не требуют: это s3_documents с
-- doc_category='check_report' (свободный TEXT, редеплой edge-функции не нужен).
--
-- Миграция идемпотентна и аддитивна: существующие значения check_status
-- ('not_checked', 'matches', 'not_matches') остаются валидными.

-- check_status добавлен миграцией 20260824; дублируем ADD IF NOT EXISTS, чтобы
-- эту миграцию можно было применить и отдельно.
ALTER TABLE dc_requests
  ADD COLUMN IF NOT EXISTS check_status TEXT NOT NULL DEFAULT 'not_checked',
  ADD COLUMN IF NOT EXISTS check_result_notes TEXT,
  ADD COLUMN IF NOT EXISTS checked_by_name TEXT,
  ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ;

ALTER TABLE dc_requests DROP CONSTRAINT IF EXISTS dc_requests_check_status_check;
ALTER TABLE dc_requests
  ADD CONSTRAINT dc_requests_check_status_check
  CHECK (check_status IN ('not_checked', 'matches', 'matches_with_remarks', 'not_matches'));

COMMENT ON COLUMN dc_requests.check_status IS
  'Исход проверки по договору: not_checked | matches (соответствует) | matches_with_remarks (соответствует с замечаниями) | not_matches (не соответствует)';
COMMENT ON COLUMN dc_requests.check_result_notes IS
  'Заключение юриста по итогам сверки с договором: что проверено, какие расхождения найдены';
COMMENT ON COLUMN dc_requests.checked_by_name IS
  'Кто зафиксировал результат проверки (ФИО на момент фиксации)';
COMMENT ON COLUMN dc_requests.checked_at IS
  'Когда зафиксирован результат проверки';

-- Очередь «проверено, но ещё не разобрано» выбирается по исходу вместе со стадией.
CREATE INDEX IF NOT EXISTS idx_dc_requests_check_status
  ON dc_requests(check_status, status)
  WHERE deleted_at IS NULL;
