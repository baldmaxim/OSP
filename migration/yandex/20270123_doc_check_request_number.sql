-- Постоянный номер заявки на проверку ДП/ДС — «ID 123» на доске /doc-check-requests. Тело
-- supabase/migrations/20270123_doc_check_request_number.sql: колонка той же таблицы doc_check_requests — правила по строкам и
-- список шлюза не меняются.
--
--  • Прежним заявкам — по порядку создания: сначала не удалённые, затем удалённые (совпавшее время — по id).
--  • Новым — следующий номер (GENERATED ALWAYS: задать или поменять номер запросом нельзя); номера не переиспользуются,
--    удалённая и архивная заявка свой номер сохраняет.
--  • updated_at при нумерации не меняется (по нему уведомления считают завершённую заявку свежей).
--  • Повтор безопасен: выданные номера не трогаются, счётчик ставится после наибольшего.
-- Проверка — 20270123_doc_check_request_number.check.sql; откат — migration/rollback/20270123_doc_check_request_number_rollback.sql.
ALTER TABLE public.doc_check_requests ADD COLUMN IF NOT EXISTS request_number integer;

-- Номера и счётчик — только при первом применении: у колонки со счётчиком (GENERATED ALWAYS) даже UPDATE без строк
-- запрещён, а повтор не должен ни перенумеровать, ни отмотать счётчик назад.
-- updated_at при нумерации не трогаем: по нему уведомления считают завершённую заявку свежей (siteNotifications.js), и
-- триггер trg_doc_check_requests_updated_at поставил бы «сейчас» всем заявкам разом. Выключен только он и только на этот UPDATE.
DO $$
DECLARE
  v_touch boolean := EXISTS (SELECT 1 FROM pg_trigger
                             WHERE tgrelid = 'public.doc_check_requests'::regclass
                               AND tgname = 'trg_doc_check_requests_updated_at' AND NOT tgisinternal);
BEGIN
  IF (SELECT attidentity FROM pg_attribute
      WHERE attrelid = 'public.doc_check_requests'::regclass AND attname = 'request_number') = '' THEN
    IF v_touch THEN
      ALTER TABLE public.doc_check_requests DISABLE TRIGGER trg_doc_check_requests_updated_at;
    END IF;
    WITH numbered AS (
      SELECT id,
             (SELECT coalesce(max(request_number), 0) FROM public.doc_check_requests)
               + row_number() OVER (ORDER BY (deleted_at IS NOT NULL), created_at, id) AS rn
      FROM public.doc_check_requests
      WHERE request_number IS NULL
    )
    UPDATE public.doc_check_requests r SET request_number = n.rn
    FROM numbered n
    WHERE r.id = n.id;
    IF v_touch THEN
      ALTER TABLE public.doc_check_requests ENABLE TRIGGER trg_doc_check_requests_updated_at;
    END IF;

    ALTER TABLE public.doc_check_requests ALTER COLUMN request_number SET NOT NULL;
    ALTER TABLE public.doc_check_requests ALTER COLUMN request_number ADD GENERATED ALWAYS AS IDENTITY;
    PERFORM setval(pg_get_serial_sequence('public.doc_check_requests', 'request_number'),
                   coalesce((SELECT max(request_number) FROM public.doc_check_requests), 0) + 1, false);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS doc_check_requests_request_number_key ON public.doc_check_requests (request_number);

COMMENT ON COLUMN public.doc_check_requests.request_number IS
  'Постоянный номер заявки на проверку ДП/ДС («ID» на доске): присваивается при создании, не меняется и не переиспользуется';
