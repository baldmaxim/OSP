-- «Заключение ДП» на доске «Заявки на проверку ДП/ДС»: привязка к тендеру (решение пользователя 19.11.2026: «в Заявке на
-- заключение ДП привязка к тендеру должна быть … не обязательна»). Тело — supabase/migrations/20270221_doc_check_tender_link.sql.
--
-- Колонка doc_check_requests.tender_id — тендер, по итогам которого заключают ДП; необязательна (заявку подают и без тендера, отдел
-- указывает позже). Страница показывает и пишет её только у «Заключения ДП» (тендеры основного строительства без тендеров на
-- материалы, как выбор тендера в форме договора). Удалили тендер безвозвратно — ссылка пустеет (ON DELETE SET NULL).
-- Права: строки — прежние правила doc_check_requests; подающий (право только создавать) указывает тендер при создании —
-- в шлюзе колонка добавлена к его колонкам вставки (db-sections.json), правка — как и прочие поля, только отделом
-- (doc_check_requests_write_guard не меняется). Смена тендера пишется в историю заявки (отдельный триггер: общий список полей
-- doc_check_requests_history из 20270216 не переписывается). Данные не меняются: колонка у всех пустая.
-- Нужна 20270216 (doc_check_history_write). Повтор безопасен. Проверка — 20270221_doc_check_tender_link.check.sql, для прода —
-- migration/backup/checks/20270221.sql; откат — migration/rollback/20270221_doc_check_tender_link_rollback.sql.
-- В нерабочее время: ALTER TABLE ненадолго блокирует таблицу заявок.
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
REVOKE ALL ON FUNCTION public.doc_check_requests_tender_history() FROM PUBLIC;

DROP TRIGGER IF EXISTS doc_check_requests_tender_history ON public.doc_check_requests;
CREATE TRIGGER doc_check_requests_tender_history
  AFTER UPDATE OF tender_id ON public.doc_check_requests
  FOR EACH ROW EXECUTE FUNCTION public.doc_check_requests_tender_history();
