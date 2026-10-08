#!/usr/bin/env bash
# Резервная копия схемы public прода (структура + данные). Запускать на удалённой
# машине из корня репозитория:
#
#   bash migration/backup/backup.sh
#
# База прода только читается: pg_dump работает в одной транзакции «только чтение»,
# подсчёт строк — один SELECT. Пароль вводится скрыто: не попадает ни в чат, ни в
# историю команд, ни в аргументы процессов.
#
# Результат в migration/dumps/ (вне git, права 600):
#   prod-<время>.dump               — копия (pg_dump -Fc)
#   prod-<время>.counts-before.tsv  — число строк по таблицам прода до копии
#   prod-<время>.counts-after.tsv   — и сразу после (между ними копия согласована)
#   prod-<время>.dump.sha256        — контрольная сумма
# Проверка восстановлением — verify.sh (её запускаю я). Копии старше 30 дней удаляйте.
set -euo pipefail

cd "$(dirname "$0")/../.."
BACKUP_DIR="migration/backup"
OUT_DIR="${BACKUP_OUT_DIR:-migration/dumps}"

# Подключение к проду: session pooler Supabase (порт 5432; transaction pooler 6543 для pg_dump не годится).
export PGHOST="${PGHOST:-aws-1-eu-north-1.pooler.supabase.com}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres.jxbuimrosrmmjroojdza}"
export PGDATABASE="${PGDATABASE:-postgres}"
export PGSSLMODE="${PGSSLMODE:-require}"
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-15}"

if [ -z "${PGPASSWORD:-}" ]; then
  read -rsp 'Пароль базы Supabase (не отображается): ' PGPASSWORD
  echo
fi
export PGPASSWORD
trap 'unset PGPASSWORD' EXIT

umask 077
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
BASE="$OUT_DIR/prod-$STAMP"

counts() {
  psql -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -c 'SET default_transaction_read_only = on' -f "$BACKUP_DIR/counts.sql" >"$1"
}

echo "Подсчёт строк до копии…"
counts "$BASE.counts-before.tsv"

echo "Копия схемы public…"
pg_dump -Fc -n public -f "$BASE.dump.partial"
mv "$BASE.dump.partial" "$BASE.dump"

echo "Подсчёт строк после копии…"
counts "$BASE.counts-after.tsv"

sha256sum "$BASE.dump" >"$BASE.dump.sha256"
chmod 600 "$BASE".*

TABLES="$(wc -l <"$BASE.counts-before.tsv")"
CHANGED="$(paste "$BASE.counts-before.tsv" "$BASE.counts-after.tsv" | awk -F'\t' '$2 != $4' | wc -l)"
SIZE="$(du -h "$BASE.dump" | cut -f1)"
echo
echo "Готово: $BASE.dump ($SIZE), таблиц: $TABLES, изменились за время копии: $CHANGED."
echo "Дальше — проверка восстановлением: bash migration/backup/verify.sh $BASE.dump"
