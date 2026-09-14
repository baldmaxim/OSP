-- Отметка «Проверка РД» у тендера основного строительства: рабочая документация
-- в тендерном пакете проверена. Галочка под тендерным пакетом в строке реестра,
-- по образцу публикации в ТГ (20260806) — кто и когда отметил.
ALTER TABLE tenders
  ADD COLUMN IF NOT EXISTS rd_checked BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rd_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rd_checked_by TEXT;

COMMENT ON COLUMN tenders.rd_checked IS 'РД тендерного пакета проверена';
COMMENT ON COLUMN tenders.rd_checked_at IS 'Когда отмечена проверка РД';
COMMENT ON COLUMN tenders.rd_checked_by IS 'Кто отметил проверку РД (ФИО)';
