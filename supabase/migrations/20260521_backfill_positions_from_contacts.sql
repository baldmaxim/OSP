-- Backfill: подтянуть все используемые должности из contacts в справочник positions.
-- Берём DISTINCT непустые значения contacts.position, исключая те, что уже есть в positions.
-- Повторное применение безопасно: ON CONFLICT DO NOTHING.

INSERT INTO positions (name)
SELECT DISTINCT TRIM(c.position) AS name
FROM contacts AS c
WHERE c.position IS NOT NULL
  AND TRIM(c.position) <> ''
ON CONFLICT (name) DO NOTHING;
