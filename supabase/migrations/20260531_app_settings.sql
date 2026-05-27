-- task 324: универсальное key/value хранилище глобальных настроек приложения.
-- Первый кейс: ссылка на «общую таблицу с отделами» в реестре заявок на ДС
-- (ключ 'dc_requests_external_link'). Если позже понадобятся другие
-- одноразовые настройки — просто новый key, без миграций.

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'app_settings'
      AND policyname = 'Allow all for authenticated users'
  ) THEN
    CREATE POLICY "Allow all for authenticated users" ON app_settings
      FOR ALL TO authenticated
      USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMENT ON TABLE app_settings IS 'Глобальные настройки приложения (key/value), task 324';
