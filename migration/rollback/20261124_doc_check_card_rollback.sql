-- АВАРИЙНЫЙ ОТКАТ supabase/migrations/20261124_doc_check_card.sql (Supabase): карточка заявки на проверку ДП/ДС — как до
-- миграции (без обсуждения, шагов, ссылки на письмо и исполнителей без учётной записи).
-- Сообщения и шаги НЕ удаляются: таблицы остаются (без прав у вошедших) — повторное применение миграции продолжит с ними.
-- ВНИМАНИЕ: ссылки на письма и имена исполнителей теряются (колонки убираются, иначе страница считала бы миграцию
-- применённой) — перед откатом снимите их выгрузкой:
--   select id, email_link, manual_assignees from public.doc_check_requests
--   where email_link is not null or cardinality(manual_assignees) > 0;
-- assignee_ids не трогаем: колонка принадлежит 20261113. Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.doc_check_requests DROP CONSTRAINT IF EXISTS doc_check_requests_email_link_check;
ALTER TABLE public.doc_check_requests DROP CONSTRAINT IF EXISTS doc_check_requests_manual_assignees_check;
ALTER TABLE public.doc_check_requests
  DROP COLUMN IF EXISTS email_link,
  DROP COLUMN IF EXISTS manual_assignees;

DO $$
BEGIN
  IF to_regclass('public.doc_check_request_comments') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.doc_check_request_comments FROM authenticated;
  END IF;
  IF to_regclass('public.doc_check_request_steps') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.doc_check_request_steps FROM authenticated;
  END IF;
END
$$;

COMMIT;
