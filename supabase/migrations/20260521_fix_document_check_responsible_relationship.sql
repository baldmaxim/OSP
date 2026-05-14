-- Fixup-миграция: гарантирует наличие FK responsible_contact_id → contacts(id)
-- и перезагружает schema cache PostgREST, чтобы syntax `responsible:contacts!responsible_contact_id(...)`
-- начал работать в Supabase API.

-- Колонку добавляем идемпотентно (уже могла быть из 20260514_extend_document_check_requests.sql).
ALTER TABLE document_check_requests
  ADD COLUMN IF NOT EXISTS responsible_contact_id UUID;

-- Удаляем существующий FK, если он есть, чтобы пересоздать его с предсказуемым именем.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'document_check_requests'::regclass
      AND conname = 'document_check_requests_responsible_contact_id_fkey'
  ) THEN
    ALTER TABLE document_check_requests
      DROP CONSTRAINT document_check_requests_responsible_contact_id_fkey;
  END IF;
END $$;

ALTER TABLE document_check_requests
  ADD CONSTRAINT document_check_requests_responsible_contact_id_fkey
    FOREIGN KEY (responsible_contact_id)
    REFERENCES contacts(id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_dcr_responsible
  ON document_check_requests(responsible_contact_id);

COMMENT ON COLUMN document_check_requests.responsible_contact_id
  IS 'Ответственный сотрудник за проверку (FK на contacts)';

-- Заставляем PostgREST переcчитать schema cache.
-- Без этого Supabase API продолжит возвращать "Could not find a relationship".
NOTIFY pgrst, 'reload schema';
