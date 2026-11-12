-- АВАРИЙНЫЙ ОТКАТ 20270216_doc_check_chat_history (обе базы): заявки на проверку ДП/ДС — снова как после 20270123.
--   • история: триггеры базы убираются, историю снова пишет страница (прежняя сборка сайта; новая страница без колонки
--     psdc_responsible_id пишет историю сама); запрет править и удалять её записи и удалять заявку целиком — тоже (в базе
--     Яндекса журнал по-прежнему держит audit_log_guard из 20270121);
--   • файлы: защита возвращается к 20270102 — файл обсуждения меняет и удаляет право правки раздела, как любой файл заявки;
--   • сообщения: снимок файлов (attachments) остаётся в строках, страница прежней сборки его не показывает; ограничение текста
--     сообщения возвращается к «1–4000 знаков», только если нет сообщений из одних файлов (иначе остаётся новое);
--   • «прочитано»: функции убираются, страница возвращается к отметкам в браузере; таблица с отметками остаётся;
--   • остаются колонки psdc_responsible_id (ответственный за ПСДЦ), attachments и s3_documents.content_etag — без триггеров и
--     функций они ничего не меняют. osp-api пишет content_etag и с колонкой, и без неё.
-- Supabase — SQL Editor; база Яндекса — psql под владельцем с отметкой служебной операции (application_name = 'osp:internal').
-- Одной транзакцией, повтор безопасен.
BEGIN;
SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS doc_check_requests_psdc_guard ON public.doc_check_requests;
DROP TRIGGER IF EXISTS doc_check_requests_history ON public.doc_check_requests;
DROP TRIGGER IF EXISTS doc_check_audit_log_server_only ON public.doc_check_request_audit_log;
DROP TRIGGER IF EXISTS s3_documents_doc_check_history_ins ON public.s3_documents;
DROP TRIGGER IF EXISTS s3_documents_doc_check_history_upd ON public.s3_documents;
DROP TRIGGER IF EXISTS s3_documents_doc_check_history_del ON public.s3_documents;
DROP TRIGGER IF EXISTS doc_check_request_comments_history ON public.doc_check_request_comments;
DROP TRIGGER IF EXISTS doc_check_audit_log_keep ON public.doc_check_request_audit_log;
DROP TRIGGER IF EXISTS doc_check_requests_keep_history ON public.doc_check_requests;

DROP FUNCTION IF EXISTS public.doc_check_requests_psdc_guard();
DROP FUNCTION IF EXISTS public.doc_check_requests_history();
DROP FUNCTION IF EXISTS public.doc_check_audit_log_server_only();
DROP FUNCTION IF EXISTS public.s3_documents_doc_check_history();
DROP FUNCTION IF EXISTS public.doc_check_request_comments_history();
DROP FUNCTION IF EXISTS public.doc_check_history_write(uuid, text, text, jsonb, jsonb, text);
DROP FUNCTION IF EXISTS public.doc_check_keep_history();
DROP FUNCTION IF EXISTS public.doc_check_talk_state(bigint, jsonb);
DROP FUNCTION IF EXISTS public.doc_check_talk_mark(uuid, bigint);
DROP FUNCTION IF EXISTS public.doc_check_talk_clean(jsonb, bigint);

-- Сообщение — как в 20261124 (вложения не читаются).
CREATE OR REPLACE FUNCTION public.doc_check_request_comments_stamp() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.author_user_id := auth.uid();
  NEW.author_name := (SELECT coalesce(nullif(btrim(ur.full_name), ''), nullif(btrim(ur.email), ''))
                      FROM public.user_roles ur WHERE ur.user_id = NEW.author_user_id LIMIT 1);
  NEW.body := btrim(NEW.body);
  NEW.created_at := now();
  RETURN NEW;
END
$$;

DO $body_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.doc_check_request_comments WHERE char_length(body) < 1) THEN
    ALTER TABLE public.doc_check_request_comments DROP CONSTRAINT IF EXISTS doc_check_request_comments_body_check;
    ALTER TABLE public.doc_check_request_comments ADD CONSTRAINT doc_check_request_comments_body_check
      CHECK (char_length(body) BETWEEN 1 AND 4000);
  END IF;
END
$body_check$;

-- Файлы заявок — как в 20270102.
CREATE OR REPLACE FUNCTION public.s3_documents_doc_check_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_detach boolean := TG_ARGV[0] = 'detach';
  v_owner uuid;
  v_status text;
  v_author uuid;
  v_deleted timestamptz;
BEGIN
  IF auth.uid() IS NULL OR public.osp_can('doc_check_requests', 'edit')
     OR (TG_OP = 'UPDATE' AND v_detach
         AND (NEW.doc_category, NEW.owner_type, NEW.owner_id) IS NOT DISTINCT FROM (OLD.doc_category, OLD.owner_type, OLD.owner_id)) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  v_owner := CASE WHEN v_detach THEN OLD.owner_id ELSE NEW.owner_id END;
  SELECT r.status, r.created_by, r.deleted_at INTO v_status, v_author, v_deleted
  FROM public.doc_check_requests r WHERE r.id = v_owner;
  IF FOUND AND v_author = auth.uid() AND v_status = 'new' AND v_deleted IS NULL
     AND public.osp_can('doc_check_requests_create', 'edit') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Файлы этой заявки на проверку меняет сотрудник с правом правки раздела'
    USING ERRCODE = '42501', HINT = 'doc_check_file_edit';
END
$$;

COMMIT;
