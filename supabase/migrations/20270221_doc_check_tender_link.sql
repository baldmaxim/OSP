-- «Заключение ДП» на доске «Заявки на проверку ДП/ДС»: необязательная привязка к тендеру (решение пользователя 19.11.2026).
-- Подробно — в базе нового портала: migration/yandex/20270221_doc_check_tender_link.sql. Тело то же; здесь — ещё права функции для
-- ролей Supabase и перечитывание связей PostgREST. Данные не меняются. Нужна 20270216 (doc_check_history_write).
-- Проверка: migration/backup/checks/20270221.sql, откат — migration/rollback/20270221_doc_check_tender_link_rollback.sql.
-- Применять в нерабочее время: ALTER TABLE ненадолго блокирует таблицу заявок.

BEGIN;
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF to_regprocedure('public.doc_check_history_write(uuid, text, text, jsonb, jsonb, text)') IS NULL THEN
    RAISE EXCEPTION 'Нет истории заявок от базы: сначала 20270216_doc_check_chat_history';
  END IF;
END
$$;

ALTER TABLE public.doc_check_requests ADD COLUMN IF NOT EXISTS tender_id uuid;

ALTER TABLE public.doc_check_requests DROP CONSTRAINT IF EXISTS doc_check_requests_tender_id_fkey;
ALTER TABLE public.doc_check_requests ADD CONSTRAINT doc_check_requests_tender_id_fkey
  FOREIGN KEY (tender_id) REFERENCES public.tenders(id) ON DELETE SET NULL;

-- ON DELETE SET NULL при удалении тендера — по индексу (заявок с тендером немного).
CREATE INDEX IF NOT EXISTS idx_doc_check_requests_tender_id ON public.doc_check_requests (tender_id)
  WHERE tender_id IS NOT NULL;

COMMENT ON COLUMN public.doc_check_requests.tender_id IS
  'Тендер, по итогам которого заключают ДП («Заключение ДП», с 20270221); NULL — не указан. Необязательно';

-- Смена тендера — в историю заявки, как смена объекта или контрагента (поле tender_id, значение — id тендера).
CREATE OR REPLACE FUNCTION public.doc_check_requests_tender_history() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;
  IF NEW.tender_id IS DISTINCT FROM OLD.tender_id THEN
    PERFORM public.doc_check_history_write(NEW.id, 'field_updated', 'tender_id', to_jsonb(OLD.tender_id), to_jsonb(NEW.tender_id), NULL);
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.doc_check_requests_tender_history() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS doc_check_requests_tender_history ON public.doc_check_requests;
CREATE TRIGGER doc_check_requests_tender_history
  AFTER UPDATE OF tender_id ON public.doc_check_requests
  FOR EACH ROW EXECUTE FUNCTION public.doc_check_requests_tender_history();

-- PostgREST перечитывает связи (новая ссылка doc_check_requests → tenders).
NOTIFY pgrst, 'reload schema';

COMMIT;
