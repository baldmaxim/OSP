-- Начало загрузки (внутри общей транзакции psql -1): отметка «что и когда загружено» и часовой пояс.
-- Отметка нужна reset.sh: чистить можно только то, что загрузили мы, и только пока статус — rehearsal.
-- rights: loaded — права и политики перенесены на роль приложения; skipped — не загружались
-- (load.sh --without-rights или --single-owner до шага rights.sh), роли приложения нет;
-- single — применены права под одну учётку (rights.sh, sql/load-single-owner.sql).
CREATE SCHEMA osp_meta;
COMMENT ON SCHEMA osp_meta IS 'Служебные отметки переноса портала ОСП (migration/target). Не трогать вручную.';

CREATE TABLE osp_meta.load_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL CHECK (status IN ('rehearsal', 'final')),
  source_name   text NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  tool_commit   text NOT NULL,
  rights        text NOT NULL CHECK (rights IN ('loaded', 'skipped', 'single')),
  runtime_role  text,
  CHECK ((rights = 'loaded') = (runtime_role IS NOT NULL))
);

INSERT INTO osp_meta.load_log (status, source_name, source_sha256, tool_commit, rights, runtime_role)
VALUES (:'status', :'source_name', :'source_sha256', :'tool_commit', :'rights', nullif(:'runtime_role', ''));

-- В Supabase база живёт в UTC; у кластера Яндекса пояс общий на все базы, поэтому задаём свой — базе.
SELECT format('ALTER DATABASE %I SET timezone = %L', current_database(), 'UTC') \gexec
SET TIME ZONE 'UTC';
