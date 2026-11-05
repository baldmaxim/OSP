-- АВАРИЙНЫЙ ОТКАТ 20261228_doc_check_created_guard: снимается запрет в базе. Дата создания и автор заявки, которые
-- администратор уже изменил, остаются как есть (прежние значения — в истории заявки). Форма показывает эти поля только
-- администратору, но прямой запрос сотрудника с правом правки раздела снова сможет их записать.
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS doc_check_requests_created_guard ON public.doc_check_requests;
DROP FUNCTION IF EXISTS public.doc_check_requests_created_guard();
COMMENT ON COLUMN public.doc_check_requests.created_at IS NULL;
COMMENT ON COLUMN public.doc_check_requests.created_by_name IS NULL;

COMMIT;
