-- АВАРИЙНЫЙ ОТКАТ миграции 20261210_tender_concept_agreement (обе базы): убирается только запрет в базе. Данные НЕ
-- меняются: карточки «Понятийное соглашение» и их файлы остаются. Страница продолжит спрашивать о соглашении в окне
-- завершения. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS tenders_concept_agreement_guard ON public.tenders;
DROP FUNCTION IF EXISTS public.tenders_concept_agreement_guard();

COMMIT;
