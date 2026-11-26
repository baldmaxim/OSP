-- Версии файлов списка (решение пользователя 26.11.2026, окно «ВОРы и РД»): новую версию ведомости ВОР прикрепляют к прежнему
-- файлу, а не отдельным документом; файл можно сделать версией другого файла того же списка или снова самостоятельным.
--
-- s3_documents.version_group_id — одна группа на все версии файла; NULL — файл без версий (все прежние строки). Номер версии не
-- хранится: порядок по времени загрузки внутри группы (created_at, затем id), последняя — текущая; удалили версию — следующие
-- сдвигаются, порядок прежний (src/utils/docVersions.js). Группа из одного файла — обычный файл (так помечен файл, который сделали
-- самостоятельным: связь снята явно). Версии — только у списков с ними (osp-api VERSIONED_CATEGORIES: ВОР тендера vor_statement,
-- ВОР заявки без тендера vor_request_vor); база проверяет одно — версии в одной группе принадлежат одному списку.
-- Правила строк s3_documents не меняются (колонка той же таблицы, чтение — «*»). Данные не меняются: колонка у всех пустая.
-- Повтор безопасен. Для базы Яндекса — migration/yandex/20270307_s3_document_versions.sql (то же + кабинет подрядчика);
-- откат — migration/rollback/20270307_s3_document_versions_rollback.sql.
-- ── 1. Группа версий у файла ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.s3_documents ADD COLUMN IF NOT EXISTS version_group_id uuid;
COMMENT ON COLUMN public.s3_documents.version_group_id IS
  'Группа версий файла (одна на все версии, порядок — по времени загрузки, последняя — текущая); NULL — файл без версий';
CREATE INDEX IF NOT EXISTS s3_documents_version_group_idx ON public.s3_documents (version_group_id)
  WHERE version_group_id IS NOT NULL;

-- Версии — только у файлов одного списка: того же владельца и категории. Пишут osp-api (s3-presign: confirm с version_of, version)
-- и прежний портал правкой строки; проверка — здесь, по всем строкам (служебная функция видит и чужие).
CREATE OR REPLACE FUNCTION public.s3_documents_version_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  SET application_name = 'osp:internal'
AS $$
BEGIN
  IF NEW.version_group_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.s3_documents o
    WHERE o.version_group_id = NEW.version_group_id AND o.id <> NEW.id
      AND (o.owner_type IS DISTINCT FROM NEW.owner_type OR o.owner_id IS DISTINCT FROM NEW.owner_id
           OR o.doc_category IS DISTINCT FROM NEW.doc_category)
  ) THEN
    RAISE EXCEPTION 'Версии — только у файлов одного списка (тот же владелец и раздел)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION public.s3_documents_version_guard() IS
  'Триггер s3_documents: версии (version_group_id) — только у файлов одного владельца и категории.';
DROP TRIGGER IF EXISTS s3_documents_version_guard ON public.s3_documents;
CREATE TRIGGER s3_documents_version_guard
  BEFORE INSERT OR UPDATE OF version_group_id, owner_type, owner_id, doc_category ON public.s3_documents
  FOR EACH ROW
  WHEN (NEW.version_group_id IS NOT NULL)
  EXECUTE FUNCTION public.s3_documents_version_guard();
