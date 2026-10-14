-- Проверка прав под одну учётку (rights.sh, rights.sh --check). Только чтение; строки «OK …» / «FAIL …».
-- Последние проверки — «вживую»: в откатываемой транзакции учётка без отметки пропуска и без токена
-- читает таблицы и не должна увидеть ни строки.
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
\ir rights-check-body.sql
ROLLBACK;
