-- Права по умолчанию, как в Supabase: новые таблицы, последовательности и функции схемы
-- public сразу доступны anon, authenticated и service_role. rehearse.sh применяет это
-- после восстановления копии и до миграции — иначе прогон не заметил бы миграцию, которая
-- забыла отозвать права у anon или PUBLIC.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
