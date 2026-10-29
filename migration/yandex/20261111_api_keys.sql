-- Ключи API для смежных систем: «Администрирование» → «Доступ к API» (tender.su10.ru).
--
-- До этой миграции ключи жили только строкой RATES_API_KEYS в настройках сервера: выдать или отключить ключ мог
-- лишь тот, кто правит файл на сервере, а кто и как пользуется ключом, видно не было. Теперь:
--   • api_keys — ключи: название, права (ресурсы /api/rates/*), срок, кто выпустил, отозвал, удалил. Самого ключа
--     в базе нет — только его sha256 и первые знаки для узнавания в списке: ключ показывается администратору один
--     раз при выпуске (server/osp-api/src/routes/apiKeys.js), восстановить его нельзя — только выпустить новый;
--   • ключи из RATES_API_KEYS osp-api заносит сюда сам при запуске (source = 'env'): они видны в списке, их можно
--     переименовать и отозвать; права у них — из строки на сервере, убранный из строки ключ не действует;
--   • api_key_calls — журнал вызовов по ключу (ресурс, код ответа, строк, время ответа, адрес). Хранится 90 дней.
-- Удаление — только отметка (deleted_at): строка с отпечатком остаётся, удалённый ключ получает отказ «отозван», а
-- не «неизвестен», и журнал его вызовов сохраняется.
--
-- Обе таблицы — в закрытой схеме (PostgREST её не видит) и только служебным операциям osp-api (пропуск): права
-- проверяет маршрут (только администратор), чтение отпечатка по ключу — служебное. Прежнему порталу (Supabase)
-- не нужна: ключи по-прежнему проверяет только osp-api.
-- Список ресурсов в проверке scopes — тот же, что RESOURCES в server/osp-api/src/routes/rates.js: новый ресурс
-- API — новая миграция (это публикация данных), совпадение сторожит tests/osp-api/api-keys.test.mjs.
-- Повтор безопасен. Проверка — 20261111_api_keys.check.sql.

CREATE TABLE IF NOT EXISTS osp_private.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  key_prefix text NOT NULL CHECK (char_length(key_prefix) BETWEEN 1 AND 16),
  key_hash text NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL CHECK (cardinality(scopes) >= 1 AND scopes <@ ARRAY['kp', 'supply', 'larix']::text[]),
  source text NOT NULL DEFAULT 'portal' CHECK (source IN ('portal', 'env')),
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  expires_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_by_name text,
  updated_at timestamptz,
  updated_by uuid,
  updated_by_name text,
  revoked_at timestamptz,
  revoked_by uuid,
  revoked_by_name text,
  revoke_reason text CHECK (revoke_reason IS NULL OR char_length(revoke_reason) <= 500),
  deleted_at timestamptz,
  deleted_by uuid,
  deleted_by_name text,
  env_missing_at timestamptz,
  last_used_at timestamptz,
  CHECK (deleted_at IS NULL OR revoked_at IS NOT NULL),
  CHECK (source = 'env' OR env_missing_at IS NULL)
);
COMMENT ON TABLE osp_private.api_keys IS 'Ключи API для смежных систем: sha256 ключа, права, срок, кто выпустил и отозвал; сам ключ не хранится';
COMMENT ON COLUMN osp_private.api_keys.key_prefix IS 'Первые знаки ключа — узнать его в списке; по ним ключ не восстановить';
COMMENT ON COLUMN osp_private.api_keys.source IS 'portal — выпущен в «Администрировании»; env — из строки RATES_API_KEYS настроек сервера';
COMMENT ON COLUMN osp_private.api_keys.expires_on IS 'Последний день действия (по Москве); пусто — бессрочно';
COMMENT ON COLUMN osp_private.api_keys.env_missing_at IS 'Ключа из настроек сервера в строке RATES_API_KEYS больше нет — не действует';

CREATE TABLE IF NOT EXISTS osp_private.api_key_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key_id uuid NOT NULL REFERENCES osp_private.api_keys(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  resource text NOT NULL CHECK (char_length(resource) BETWEEN 1 AND 40),
  status smallint NOT NULL CHECK (status BETWEEN 100 AND 599),
  row_count integer CHECK (row_count >= 0),
  ms integer CHECK (ms >= 0),
  ip text CHECK (ip IS NULL OR char_length(ip) <= 64),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 200)
);
CREATE INDEX IF NOT EXISTS api_key_calls_key_idx ON osp_private.api_key_calls (key_id, at);
CREATE INDEX IF NOT EXISTS api_key_calls_at_idx ON osp_private.api_key_calls (at);
COMMENT ON TABLE osp_private.api_key_calls IS 'Журнал вызовов API по ключу: ресурс, код ответа, строк, время ответа, адрес клиента; хранится 90 дней';

-- Только служебные операции osp-api (пропуск): без него — ни строки, даже у владельца.
DO $api_keys_rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_keys', 'api_key_calls'] LOOP
    EXECUTE format('ALTER TABLE osp_private.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE osp_private.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS osp_internal ON osp_private.%I', t);
    EXECUTE format('CREATE POLICY osp_internal ON osp_private.%I FOR ALL TO PUBLIC
      USING ((SELECT osp_private.bypass())) WITH CHECK ((SELECT osp_private.bypass()))', t);
  END LOOP;
END
$api_keys_rls$;
