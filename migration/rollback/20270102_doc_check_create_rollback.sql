-- АВАРИЙНЫЙ ОТКАТ 20270102_doc_check_create (Supabase): запись заявок на проверку ДП/ДС и их файлов — снова без проверки права
-- в базе (как после 20270101: любой сотрудник своих объектов, «только просмотр» держит страница). Триггеры и их функции
-- убираются. Остаются: колонка created_by (в ней — кто создал заявки после миграции) и строки права doc_check_requests_create
-- у ролей — без триггера они ничего не открывают, страница по ним показывает кнопку создания; снять — галочкой в «Правах доступа».
-- База Яндекса: применённую миграцию не правят — откат там новой миграцией с этими же командами.
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS doc_check_requests_write_guard ON public.doc_check_requests;
DROP FUNCTION IF EXISTS public.doc_check_requests_write_guard();
DROP TRIGGER IF EXISTS s3_documents_doc_check_attach ON public.s3_documents;
DROP TRIGGER IF EXISTS s3_documents_doc_check_detach ON public.s3_documents;
DROP FUNCTION IF EXISTS public.s3_documents_doc_check_guard();

COMMIT;
