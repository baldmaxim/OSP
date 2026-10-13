-- Конец шага «права под одну учётку» (rights.sh, та же транзакция): перечень созданного и отметка.
-- По перечню reset.sh отличает своё от чужого. Материализованные представления переехали в закрытую
-- схему osp_private — из перечня схемы public они убираются (схема удаляется целиком при очистке).
INSERT INTO osp_meta.manifest (kind, schema, name, detail) VALUES ('relation', 'auth', 'users', 'r');
DELETE FROM osp_meta.manifest m
WHERE m.kind = 'relation' AND m.schema = 'public' AND m.detail = 'm'
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_matviews v WHERE v.schemaname = 'public' AND v.matviewname = m.name);
UPDATE osp_meta.load_log SET rights = 'single'
WHERE id = (SELECT pg_catalog.max(id) FROM osp_meta.load_log);
