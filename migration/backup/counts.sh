#!/usr/bin/env bash
# Число строк по таблицам прода сейчас и сравнение с подсчётом перед миграцией.
# Только чтение (один SELECT). Запускать на удалённой машине из корня репозитория:
#
#   bash migration/backup/counts.sh migration/dumps/prod-<время>.counts-after.tsv
#
# Выводит таблицы, где число строк изменилось с момента копии. Портал работает, люди
# вносят данные, поэтому рост в рабочих таблицах — норма. Тревога — уменьшение там,
# где миграция не должна была ничего удалять, или пропавшая таблица.
set -euo pipefail

cd "$(dirname "$0")/../.."
REF="${1:?укажите файл подсчёта до миграции (….counts-after.tsv)}"
[ -f "$REF" ] || { echo "Нет файла $REF"; exit 1; }

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

NOW="$(mktemp)"
trap 'rm -f "$NOW"; unset PGPASSWORD' EXIT
psql -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -c 'SET default_transaction_read_only = on' \
  -f migration/backup/counts.sql >"$NOW"

awk -F'\t' '
  FILENAME == ARGV[1] { ref[$1] = $2; next }
  { now[$1] = $2 }
  END {
    alarm = 0; changed = 0
    for (t in ref) {
      if (!(t in now)) { printf "%-45s %12s %12s  ТАБЛИЦА ИСЧЕЗЛА\n", t, ref[t], "-"; alarm++ }
      else if (now[t] + 0 < ref[t] + 0) { printf "%-45s %12s %12s  СТАЛО МЕНЬШЕ — разобрать\n", t, ref[t], now[t]; alarm++ }
      else if (now[t] != ref[t]) { printf "%-45s %12s %12s  выросла (обычная работа)\n", t, ref[t], now[t]; changed++ }
    }
    for (t in now) if (!(t in ref)) printf "%-45s %12s %12s  новая таблица\n", t, "-", now[t]
    printf "\nТревог: %d, выросших таблиц: %d.\n", alarm, changed
    exit (alarm > 0)
  }' "$REF" "$NOW"
