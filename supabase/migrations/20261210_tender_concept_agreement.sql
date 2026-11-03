-- Тендер основного строительства нельзя завершить без победителя и подписанного понятийного соглашения
-- (решения пользователя 03.11.2026). Страница спрашивает об этом в окне завершения (ConceptAgreementStep), а этот триггер
-- держит правило для открытых старых вкладок и любой другой записи.
--
--  • Подписанное соглашение — файл s3_documents с doc_category = 'concept_agreement_signed' в карточке tender_docs тендера
--    (owner_type = 'tender', owner_id = tender_docs.id), как в src/utils/tenderConceptAgreement.js.
--  • Проверяется только переход в «Завершен»: уже завершённые тендеры, и старые без соглашения, правятся как раньше.
--  • Другие направления и тендеры на материалы не проверяются.
--  • Без вошедшего (служебная операция, SQL Editor) — без проверки.
-- Правила по строкам не меняются, данные не меняются. Повтор безопасен.
-- База нового портала (Яндекс) — migration/yandex/20261210_tender_concept_agreement.sql.
-- Проверка: migration/backup/checks/20261210.sql; откат — migration/rollback/20261210_tender_concept_agreement_rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.tenders_concept_agreement_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'Завершен'
     OR (TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM 'Завершен')
     OR COALESCE(NEW.department, 'construction') <> 'construction'
     OR COALESCE(NEW.tender_type, 'main') = 'materials'
     OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.winner_counterparty_id IS NULL THEN
    RAISE EXCEPTION 'Тендер основного строительства нельзя завершить без победителя'
      USING ERRCODE = 'P0001', HINT = 'tender_winner_required';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.tender_docs c
    JOIN public.s3_documents d ON d.owner_type = 'tender' AND d.owner_id = c.id
    WHERE c.tender_id = NEW.id AND d.doc_category = 'concept_agreement_signed'
  ) THEN
    RAISE EXCEPTION 'Тендер нельзя завершить без подписанного понятийного соглашения: загрузите его в «Документы» тендера'
      USING ERRCODE = 'P0001', HINT = 'concept_agreement_required';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS tenders_concept_agreement_guard ON public.tenders;
CREATE TRIGGER tenders_concept_agreement_guard
  BEFORE INSERT OR UPDATE OF status ON public.tenders
  FOR EACH ROW EXECUTE FUNCTION public.tenders_concept_agreement_guard();

COMMIT;
